/**
 * Relocation runtime — owns the per-session basket and every write this plugin
 * performs. Both the `/baize-session` command and the panel HTTP API drive this,
 * so the two surfaces can never disagree.
 *
 * The panel's shape is: pick a target workspace → pick the target conversation
 * (an existing session in that workspace, or a brand-new one) → pick which
 * messages to carry over, always from the conversation you are already in.
 * Everything below serves that order.
 *
 * Naming: DSH calls a directory-backed group of sessions a *workspace*
 * (`ctx.workspaceRegistry`). This module's `ProjectRef` / `projects` are that
 * same thing under an older name — user-facing text always says 工作区 /
 * "workspace".
 *
 * @module dsh-baize-session/relocate
 */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence' // augments Context with `sessionPersistence`
import type {} from '@deepseek-ai/dsh-token-meter'
import {
  listMessages,
  messageIdOf,
  readMessageEvent,
  renderInjection,
  sessionDisplayName,
  type CollectedItem,
  type MessageRef,
} from './core.ts'

/** Config subset the runtime needs (structural, so both callers pass their own). */
export interface RelocationOptions {
  readonly maxInjectTokens: number
  readonly listLimit?: number
}

/**
 * One workspace the user can relocate into.
 *
 * A workspace is DSH's own term (`ctx.workspaceRegistry`); the field name here
 * predates the rename and stays for wire compatibility. Only user-facing text
 * uses 工作区 / "workspace".
 */
export interface ProjectRef {
  readonly path: string
  readonly sessions: number
  readonly isCurrent: boolean
  /**
   * No registry record owns this directory — the sidebar's "未分组 / Ungrouped"
   * bucket. Set for a directory whose sessions outlived the workspace that used
   * to group them, and for the current directory when the registry has no
   * record of it yet.
   */
  readonly ungrouped?: boolean
}

/** One conversation, live in memory or read back from storage. */
export interface SessionRef {
  readonly id: string
  readonly cwd: string
  /** Message count; a stored session is read back, so this is its real count. */
  readonly messages: number
  /** Live sessions can be appended to; cold ones must be opened first. */
  readonly live: boolean
  readonly isCurrent: boolean
  /**
   * What to show in a picker: the logged `session/title`, else the opening line.
   * Empty only for a stored conversation with no messages at all.
   */
  readonly name: string
  /** Header creation time (epoch ms), used to tell same-named sessions apart. */
  readonly createdAt: number
  /**
   * No turn has run yet — the official `blank` bit. The sidebar renders such a
   * session as the workspace's provisional "New Session" row, never as a named
   * conversation, so the picker must not offer them as targets either.
   */
  readonly blank: boolean
  /** In the registry-global archive set: hidden from the sidebar. */
  readonly archived: boolean
}

/** What the panel needs for one round trip. */
export interface PanelState {
  readonly sessionId: string
  readonly cwd: string
  /** Messages of the session named by `sessionId` (the content source). */
  readonly messages: readonly MessageRef[]
  readonly basket: readonly CollectedItem[]
  readonly projects: readonly ProjectRef[]
  readonly sessions: readonly SessionRef[]
  readonly maxInjectTokens: number
}

/** Where the relocation should land. */
export type RelocateTarget =
  | { readonly kind: 'new'; readonly cwd: string }
  | { readonly kind: 'existing'; readonly sessionId: string }

export interface RelocateResult {
  /** The session that received the content (newly created, or the chosen one). */
  readonly sessionId: string
  readonly tokens: number
  readonly sources: number
  readonly mode: 'new' | 'existing'
}

/** Minimal shape of a live Session this runtime relies on. */
interface SessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string; readonly createdAt?: number }
  readonly events?: readonly unknown[]
  /** Third arg is the SurfaceIntent marker surface-eligible events require. */
  append(type: string, data: unknown, intent?: unknown): unknown
}

/** Refusals we want surfaced verbatim to the caller. */
export class RelocationError extends Error {}

export interface RelocationRuntime {
  basketOf(sessionId: string): readonly CollectedItem[]
  session(sessionId: string): SessionLike | undefined
  /** Every conversation this harness knows about: live ones plus stored ones. */
  sessions(signal?: AbortSignal): Promise<readonly SessionRef[]>
  panelState(sessionId: string, signal?: AbortSignal): Promise<PanelState>
  /** Collect by seq and/or message id, optionally out of another session. */
  take(
    sessionId: string,
    refs: { seqs?: readonly number[]; messageIds?: readonly string[]; sourceId?: string },
  ): Promise<{ added: number; missing: string[] }>
  untake(sessionId: string, ref: { seq?: number; messageId?: string; sourceId?: string }): number
  drop(sessionId: string): void
  estimate(sessionId: string, target: RelocateTarget): number
  relocate(sessionId: string, target: RelocateTarget): Promise<RelocateResult>
}

/** Refuse a relative target before touching the store (`prepare` would throw). */
export function assertAbsolutePath(path: string): void {
  if (path.length === 0) throw new RelocationError('目标路径不能为空。')
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
  if (!absolute) throw new RelocationError(`目标路径必须是绝对路径：${path}`)
}

/** Create the shared relocation runtime for one plugin instance. */
export function createRelocation(ctx: Context, options: RelocationOptions): RelocationRuntime {
  const baskets = new Map<string, CollectedItem[]>()

  /** The persistence seam, reached through `ctx.get` exactly as official code does. */
  const persistence = (): {
    inspect(id: string, signal?: AbortSignal): Promise<{ meta?: { cwd?: string }; events: readonly unknown[] }>
    load(id: string): Promise<{ meta?: { cwd?: string }; events: readonly unknown[] } | undefined>
    list(signal?: AbortSignal): Promise<readonly { id: string; cwd?: string; createdAt?: number }[]>
  } | undefined =>
    (ctx as unknown as { get?(name: string): unknown }).get?.('sessionPersistence') as never

  /**
   * The workspace registry, also through `ctx.get`.
   *
   * Deliberately NOT declared in `inject`: cordis holds a plugin in
   * `pending (waiting for service: …)` when that service is not resolvable in
   * this plugin's scope, and a pending entry aborts the whole boot
   * (`plugin tree failed to load: 1 entry did not activate`) — taking every
   * plugin after it down as well. `ctx.get` returns `undefined` instead, and a
   * missing registry only costs the sidebar refresh on the new-session path.
   */
  const workspaceRegistry = (): {
    resolveByPath(path: string): Promise<unknown>
    create(path: string, title?: string): Promise<unknown>
    /** Durable registry order — the same order the sidebar groups by. */
    list(): readonly { path?: unknown }[]
    /** The registry-global archive set; the sidebar hides these sessions. */
    readonly archivedSessionIds?: readonly string[]
  } | undefined =>
    (ctx as unknown as { get?(name: string): unknown }).get?.('workspaceRegistry') as never

  const session = (sessionId: string): SessionLike | undefined =>
    ctx.sessions.get(sessionId as never) as unknown as SessionLike | undefined

  const basketOf = (sessionId: string): CollectedItem[] => {
    const existing = baskets.get(sessionId)
    if (existing !== undefined) return existing
    const created: CollectedItem[] = []
    baskets.set(sessionId, created)
    return created
  }

  /**
   * Header + events of any conversation.
   *
   * Live sessions answer from memory. A stored one is read back with `inspect`,
   * which is the non-committing read (it never publishes or repairs), so
   * merely browsing a conversation cannot disturb it.
   *
   * `readable` says whether the log was actually obtained. It matters for the
   * blank test below: "no events because the session is empty" and "no events
   * because the artifact could not be read" must not be confused.
   */
  const inspectionOf = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ events: readonly unknown[]; cwd: string; readable: boolean }> => {
    const live = session(sessionId)
    if (live !== undefined) return { events: live.events ?? [], cwd: live.header?.cwd ?? '', readable: true }
    const store = persistence()
    if (store === undefined) return { events: [], cwd: '', readable: false }
    const stored = await store.inspect(sessionId, signal).catch(() => undefined)
    return stored === undefined
      ? { events: [], cwd: '', readable: false }
      : { events: stored.events ?? [], cwd: stored.meta?.cwd ?? '', readable: true }
  }

  /**
   * The official `blank` test: a conversation is blank while no turn has run.
   *
   * `dsh-host-apiproxy/lib/types/api/sessions.d.ts`: "true while no turn has
   * run. Standalone plugin events — command lifecycle records, plan/mode,
   * titles, goals — do not open a turn and therefore do not clear it." This is
   * why the message this plugin injects does not make a landing site
   * non-blank, and why the sidebar shows such a session as a provisional
   * "New Session" row rather than as a named conversation.
   *
   * A closed session whose log could not be read is conservatively NOT blank,
   * matching the official rule ("unavailable or oversized artifacts
   * conservatively report false").
   */
  const isBlank = (events: readonly unknown[], readable: boolean): boolean => {
    if (!readable) return false
    return !events.some(event =>
      typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'turn/start')
  }

  /** Ids in the registry-global archive set — the sidebar hides these. */
  const archivedIds = (): ReadonlySet<string> => {
    const registry = workspaceRegistry() as { archivedSessionIds?: readonly string[] } | undefined
    try {
      const ids = registry?.archivedSessionIds
      return new Set(Array.isArray(ids) ? ids : [])
    } catch {
      return new Set()
    }
  }

  /** Messages of any session — live when possible, otherwise read from storage. */
  const messagesOf = async (sessionId: string, signal?: AbortSignal): Promise<MessageRef[]> =>
    listMessages((await inspectionOf(sessionId, signal)).events)

  /**
   * Per-conversation facts read out of a closed session's log, cached briefly.
   *
   * Naming a cold session means reading its log back (the title is a log-only
   * event), and the same read answers the blank test — so the panel would
   * otherwise redo both on every refresh and every dropdown open. These change
   * rarely; twenty seconds is long enough to make the panel feel free and short
   * enough that a rename shows up on its own.
   */
  const titleCache = new Map<string, { at: number; name: string; messages: number; blank: boolean }>()
  const TITLE_CACHE_MS = 20_000

  const sessions = async (signal?: AbortSignal): Promise<SessionRef[]> => {
    const out: SessionRef[] = []
    const seen = new Set<string>()
    const archived = archivedIds()
    // Live sessions answer from memory: events are already in hand.
    for (const live of ctx.sessions.list() as unknown as SessionLike[]) {
      seen.add(live.id)
      const events = live.events ?? []
      out.push({
        id: live.id,
        cwd: live.header?.cwd ?? '',
        messages: listMessages(events).length,
        live: true,
        isCurrent: false,
        name: sessionDisplayName(events),
        createdAt: live.header?.createdAt ?? 0,
        blank: isBlank(events, true),
        archived: archived.has(live.id),
      })
    }
    const store = persistence()
    if (store !== undefined) {
      const cold = await store.list(signal).catch(() => [])
      const pending = cold.filter(meta => !seen.has(meta.id))
      // Read every closed conversation at once; the whole set is small (every
      // test log here is a few hundred KB at most) and this is one round trip
      // for the panel instead of one per row.
      const read = await Promise.all(pending.map(async (meta) => {
        const cached = titleCache.get(meta.id)
        if (cached !== undefined && Date.now() - cached.at < TITLE_CACHE_MS) {
          return { meta, name: cached.name, messages: cached.messages, blank: cached.blank }
        }
        const { events, readable } = await inspectionOf(meta.id, signal)
        const entry = {
          name: sessionDisplayName(events),
          messages: listMessages(events).length,
          blank: isBlank(events, readable),
        }
        titleCache.set(meta.id, { at: Date.now(), ...entry })
        return { meta, ...entry }
      }))
      for (const { meta, name, messages, blank } of read) {
        out.push({
          id: meta.id,
          cwd: meta.cwd ?? '',
          messages,
          live: false,
          isCurrent: false,
          name,
          createdAt: meta.createdAt ?? 0,
          blank,
          archived: archived.has(meta.id),
        })
      }
    }
    return out
  }

  const take = async (
    sessionId: string,
    refs: { seqs?: readonly number[]; messageIds?: readonly string[]; sourceId?: string },
  ): Promise<{ added: number; missing: string[] }> => {
    // `sourceId` lets the panel collect out of a session other than the one the
    // basket belongs to — that is what makes cross-session gathering work.
    const sourceId = refs.sourceId ?? sessionId
    const wantedSeqs = new Set((refs.seqs ?? []).filter(n => Number.isSafeInteger(n)))
    const wantedIds = new Set(refs.messageIds ?? [])
    if (wantedSeqs.size === 0 && wantedIds.size === 0) throw new RelocationError('请给出要收集的消息。')

    // A stored-but-closed conversation is readable: the panel already lists its
    // messages (that is how browsing works), so refusing to collect them here
    // would show a checkbox list that cannot be ticked.
    const { events, cwd } = await inspectionOf(sourceId)

    const bySeq = new Map<number, unknown>()
    const seqById = new Map<string, number>()
    for (const event of events) {
      const seq = (event as { seq?: unknown }).seq
      if (typeof seq !== 'number') continue
      bySeq.set(seq, event)
      const id = messageIdOf(event)
      if (id !== undefined) seqById.set(id, seq)
    }
    const basket = basketOf(sessionId)
    const missing: string[] = []
    let added = 0
    const wanted: number[] = [...wantedSeqs]
    for (const id of wantedIds) {
      const seq = seqById.get(id)
      if (seq === undefined) missing.push(id.slice(0, 8))
      else wanted.push(seq)
    }
    for (const seq of wanted) {
      const event = bySeq.get(seq)
      const read = event === undefined ? null : readMessageEvent(event)
      if (read === null) { missing.push(String(seq)); continue }
      if (basket.some(item => item.sessionId === sourceId && item.seq === seq)) continue
      basket.push({
        sessionId: sourceId,
        cwd,
        seq,
        messageId: event === undefined ? undefined : messageIdOf(event),
        role: read.role,
        text: read.text,
      })
      added += 1
    }
    return { added, missing }
  }

  const untake = (
    sessionId: string,
    ref: { seq?: number; messageId?: string; sourceId?: string },
  ): number => {
    const basket = basketOf(sessionId)
    const before = basket.length
    const kept = basket.filter((item) => {
      if (ref.sourceId !== undefined && item.sessionId !== ref.sourceId) return true
      if (ref.messageId !== undefined && item.messageId === ref.messageId) return false
      if (ref.seq !== undefined && item.seq === ref.seq) return false
      return true
    })
    basket.length = 0
    basket.push(...kept)
    return before - kept.length
  }

  const drop = (sessionId: string): void => { basketOf(sessionId).length = 0 }

  /** Build the message carrying the collected history. */
  const buildMessage = (sessionId: string, targetCwd: string) => {
    const basket = basketOf(sessionId)
    if (basket.length === 0) throw new RelocationError('还没有选任何消息。')
    const text = renderInjection(basket, targetCwd)
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'baize-session', form: 'snapshot', sections: [{ name: 'baize-session', text }] },
    })
  }

  /** The working directory a target implies (the render names it). */
  const targetCwdOf = (target: RelocateTarget): string =>
    target.kind === 'new' ? target.cwd : (session(target.sessionId)?.header?.cwd ?? '')

  /**
   * The workspaces offered as targets, read from the registry that owns them.
   *
   * This used to be derived from the sessions' `cwd` values, which is wrong in
   * both directions: a workspace deleted in the UI kept showing up as long as
   * one of its sessions survived, and a workspace created before its first
   * session never appeared at all. `list()` is the same durable registry the
   * sidebar groups by, returned in registry order.
   *
   * `sessions` counts only real conversations (not blank, not archived) so the
   * number matches what the conversation dropdown will actually offer. A
   * workspace with none is still listed — that is exactly the "new conversation
   * here" case.
   */
  const projectRefs = (all: readonly SessionRef[], currentCwd: string): ProjectRef[] => {
    const real = (path: string): number =>
      all.filter(ref => ref.cwd === path && !ref.blank && !ref.archived).length
    const rows: ProjectRef[] = []
    const seen = new Set<string>()
    try {
      const registry = workspaceRegistry() as {
        list?(): readonly { path?: unknown }[]
      } | undefined
      for (const entity of registry?.list?.() ?? []) {
        const path = entity?.path
        if (typeof path !== 'string' || path.length === 0 || seen.has(path)) continue
        seen.add(path)
        rows.push({ path, sessions: real(path), isCurrent: path === currentCwd })
      }
    } catch (e) {
      console.warn('[baize-session] workspace list unavailable: ' + String(e))
    }
    // The sidebar drops sessions the registry does not group into an "未分组"
    // bucket; the picker needs the same bucket, otherwise a real conversation
    // that outlived its workspace (deleted in the UI) becomes unreachable.
    const orphans = new Map<string, number>()
    for (const ref of all) {
      if (ref.cwd.length === 0 || seen.has(ref.cwd) || ref.blank || ref.archived) continue
      orphans.set(ref.cwd, (orphans.get(ref.cwd) ?? 0) + 1)
    }
    for (const [path, count] of orphans) {
      seen.add(path)
      rows.push({ path, sessions: count, isCurrent: path === currentCwd, ungrouped: true })
    }
    // The conversation's own workspace must always be selectable, even when it
    // has no real conversation yet (a directory nobody has opened before, or one
    // whose sessions are all still blank).
    if (currentCwd.length > 0 && !seen.has(currentCwd)) {
      rows.unshift({ path: currentCwd, sessions: real(currentCwd), isCurrent: true, ungrouped: true })
    }
    if (rows.length === 0) {
      // No registry at all: degrade to the session-derived list rather than
      // offering nothing.
      const paths = new Map<string, number>()
      for (const ref of all) {
        if (ref.cwd.length === 0) continue
        paths.set(ref.cwd, (paths.get(ref.cwd) ?? 0) + 1)
      }
      for (const [path, count] of paths) rows.push({ path, sessions: count, isCurrent: path === currentCwd })
    }
    return rows.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
  }

  const panelState = async (sessionId: string, signal?: AbortSignal): Promise<PanelState> => {
    const live = session(sessionId)
    const all = await sessions(signal)
    // The panel normally runs inside a live conversation, but do not depend on
    // it: read the log back when it is not, so the current workspace is known
    // either way. Sharing that one read also avoids reading the log twice.
    const inspection = live === undefined ? await inspectionOf(sessionId, signal) : undefined
    const currentCwd = live?.header?.cwd ?? inspection?.cwd ?? ''
    return {
      sessionId,
      cwd: currentCwd,
      messages: inspection === undefined
        ? await messagesOf(sessionId, signal)
        : listMessages(inspection.events),
      basket: [...basketOf(sessionId)],
      projects: projectRefs(all, currentCwd),
      sessions: all.map(ref => ({ ...ref, isCurrent: ref.id === sessionId })),
      maxInjectTokens: options.maxInjectTokens,
    }
  }

  const estimate = (sessionId: string, target: RelocateTarget): number => {
    if (basketOf(sessionId).length === 0) return 0
    return ctx.tokenMeter.estimateMessage(buildMessage(sessionId, targetCwdOf(target)) as never)
  }

  const relocate = async (sessionId: string, target: RelocateTarget): Promise<RelocateResult> => {
    const sources = new Set(basketOf(sessionId).map(item => item.sessionId)).size

    // --- Append into an existing conversation -------------------------------
    if (target.kind === 'existing') {
      const live = session(target.sessionId)
      if (live === undefined) {
        throw new RelocationError('目标会话不在内存中，无法追加（先在侧边栏打开它）。')
      }
      const message = buildMessage(sessionId, live.header?.cwd ?? '')
      const tokens = ctx.tokenMeter.estimateMessage(message as never)
      if (tokens > options.maxInjectTokens) {
        throw new RelocationError(
          `选中内容约 ${tokens} tokens，超过上限 ${options.maxInjectTokens}。请少选几条，或调大 maxInjectTokens。`,
        )
      }
      // `user/message` is surface-eligible: the log rejects it without a marker
      // (SurfaceIntent, dsh-session/lib/types/types.d.ts:402); official callers
      // pass the same ({ surfaceOp: 'append' }, dsh-agent-loop/lib/index.js:554).
      live.append('user/message', message, { surfaceOp: 'append' })
      return { sessionId: live.id, tokens, sources, mode: 'existing' }
    }

    // --- Create a new conversation ------------------------------------------
    const targetCwd = target.cwd
    assertAbsolutePath(targetCwd)
    const message = buildMessage(sessionId, targetCwd)
    const tokens = ctx.tokenMeter.estimateMessage(message as never)
    if (tokens > options.maxInjectTokens) {
      throw new RelocationError(
        `选中内容约 ${tokens} tokens，超过上限 ${options.maxInjectTokens}。请少选几条，或调大 maxInjectTokens。`,
      )
    }

    // Mirror the host's own `ensureWorkspace` (dsh-host-apiproxy/lib/index.js:2141).
    // The registry resolves paths with `realpath`, so a missing directory fails
    // with ENOENT and no workspace is created.
    const registry = workspaceRegistry()
    let workspace: { attachSession?(id: string): Promise<void> } | undefined
    if (registry === undefined) {
      console.warn('[baize-session] workspaceRegistry unavailable; the sidebar may not list the new session')
    } else {
      await mkdir(targetCwd, { recursive: true }).catch(() => undefined)
      try {
        workspace = (await registry.resolveByPath(targetCwd)
          ?? await registry.create(targetCwd)) as { attachSession?(id: string): Promise<void> }
        if (workspace === undefined) console.warn('[baize-session] no workspace entity for ' + targetCwd)
      } catch (e) {
        console.warn('[baize-session] workspace ensure failed: ' + String(e))
      }
    }

    // Create the session WITH its content as `seed`. DSH persists on checkpoints
    // (session-checkpoint-policy), so an append into a brand-new session nobody
    // has talked to never reaches disk; a seed is part of session construction —
    // the same route the official subagent/fork paths use.
    //
    // Never let the store mint `session-<counter>`: that check only looks at the
    // in-memory store and collides with a same-named session already on disk.
    const seedEvent = {
      type: 'user/message',
      seq: 0,
      time: Date.now(),
      data: message,
      surfaceOp: 'append',
    }
    const created = ctx.sessions.create(`session-${crypto.randomUUID()}` as never, {
      seed: [seedEvent] as never,
      meta: { cwd: targetCwd, seedLength: 1 },
    }) as unknown as SessionLike

    // `attachSession` records the session under its workspace AND mutates the
    // registry, which is what makes the web client refresh its session list
    // (dsh-workspace/lib/index.js:87).
    if (workspace?.attachSession !== undefined) {
      await workspace.attachSession(created.id).catch((e: unknown) => {
        console.warn('[baize-session] attachSession failed: ' + String(e))
      })
    }

    return { sessionId: created.id, tokens, sources, mode: 'new' }
  }

  return { basketOf, session, sessions, panelState, take, untake, drop, estimate, relocate }
}
