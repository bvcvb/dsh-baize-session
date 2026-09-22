/**
 * Workspace administration — list, archive, restore, delete and relocate the
 * conversations of one workspace.
 *
 * This is the runtime behind the panel's 工作区 tab. It is deliberately a
 * separate module from `relocate.ts`: relocation only ever *adds* content,
 * while everything here mutates the workspace registry or the session store,
 * and one operation (delete) is irreversible.
 *
 * What each operation touches:
 *
 * | op        | workspace ledger | archive set | session artifact on disk |
 * |-----------|------------------|-------------|--------------------------|
 * | list      | read             | read        | read (names, blank bit)  |
 * | archive   | —                | + id        | —                        |
 * | restore   | —                | − id        | —                        |
 * | delete    | detach           | − id        | **rm -rf**               |
 * | move      | detach + attach  | —           | **rewrite header.cwd**   |
 *
 * The heavier two follow `dsh-session-manager`'s proven sequences (agent
 * teardown before a delete; header rewrite + atomic rename before the ledger
 * swap on a move) rather than inventing shortcuts, because both can corrupt
 * durable state when done out of order.
 *
 * @module dsh-baize-session/workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { listRaw, listStored, type PersistenceLike as PersistenceSeam } from './persistence.ts'
import type { SessionRef } from './relocate.ts'

/** A refusal the user can act on; the API layer answers it with HTTP 400. */
export class WorkspaceError extends Error {}

/** One workspace as the panel's destination picker needs it. */
export interface WorkspaceOption {
  readonly id: string
  readonly path: string
  readonly title: string
}

/** One conversation row in the 工作区 tab. */
export interface ManagedSession extends SessionRef {
  /** An agent is attached right now (a turn may be running). */
  readonly running: boolean
  /** A subagent child — the sidebar hides these and moves refuse them. */
  readonly subagent: boolean
  /** True for the conversation the panel itself is open in. */
  readonly isPanel: boolean
}

/** Everything the 工作区 tab renders in one round trip. */
export interface WorkspacePanel {
  /** The workspace the panel's own conversation belongs to, when known. */
  readonly workspace?: WorkspaceOption
  /** Every workspace, for the "move to…" picker. */
  readonly workspaces: readonly WorkspaceOption[]
  /** That workspace's conversations in ledger order, archived ones included. */
  readonly sessions: readonly ManagedSession[]
}

export interface WorkspaceAdmin {
  panel(sessionId: string): Promise<WorkspacePanel>
  archive(targetId: string): Promise<void>
  restore(targetId: string): Promise<void>
  /** Irreversible. Only an archived conversation may be deleted. */
  remove(targetId: string): Promise<{ readonly dir?: string }>
  move(targetId: string, toWorkspaceId: string): Promise<{ readonly from: string; readonly to: string }>
}

/** The registry surface this module relies on beyond the published methods. */
interface RegistryLike {
  list(): readonly WorkspaceEntityLike[]
  /**
   * In-memory indexes the registry consults when it decides whether a session
   * belongs to a workspace. A cross-workspace move must update them together
   * with the artifact, or `attachSession` keeps reading the old stored cwd.
   */
  headers?: MapLike<Record<string, unknown>>
  sessionPaths?: MapLike<string>
  invalidSessionPaths?: MapLike<unknown>
  archiveSession?(id: string): Promise<void>
  /** Serialized durable write — how the registry itself commits changes. */
  enqueueOperation?<T>(operation: () => Promise<T>): Promise<T>
  requireState?(): { archivedSessionIds: readonly string[] } & Record<string, unknown>
  setState?(state: unknown): Promise<void>
}

interface WorkspaceEntityLike {
  readonly id: string
  readonly path: string
  readonly title: string
  /** Filtered by the registry's session-path index — it hides foreign entries. */
  readonly sessionIds: readonly string[]
  /** The raw ownership account, unaffected by that filter. */
  readonly record?: { readonly sessionIds?: readonly string[] }
  detachSession?(id: string): Promise<void>
  attachSession?(id: string): Promise<void>
}

/**
 * The write-side view of the persistence seam (all of these are published APIs
 * on dsh 0.1.1-rc.2).
 *
 * None of it survives on dsh 0.1.7-alpha.1: `locate`, `readRaw`, `coordinator`
 * and `tracker` were removed when the service moved to the SessionHandle model
 * (see `./persistence.ts`). `move` therefore probes them before use and refuses
 * with a clear message, rather than half-performing a migration. The read side
 * lives in `PersistenceSeam`; the two are joined only where both are wanted.
 */
interface PersistenceWrites {
  locate(meta: unknown): { path: string } | undefined
  readRaw?(id: string, signal?: AbortSignal): Promise<{ meta: unknown; content: string; path?: string } | undefined>
  /** The coordinator behind a backend keeps per-session write state. */
  coordinator?: {
    states?: MapLike<{ meta?: unknown; materialized?: boolean }>
    preparations?: { invalidate?(id: string): void }
    /** Per-id lock: runs the operation with the write-behind held off. */
    serialize?<T>(id: string, operation: () => Promise<T>): Promise<T>
  }
  /** Open live writers, one per session currently being written. */
  tracker?: { writers?: MapLike<{ header?: unknown }> }
}

/** The `Map`-shaped surface these internal indexes expose. */
interface MapLike<T> {
  get?(key: string): T | undefined
  set?(key: string, value: T): unknown
  delete?(key: string): unknown
}

interface SessionLike {
  readonly id: string
  /** Assignable: a cross-workspace move rewrites the in-memory header too. */
  header?: { readonly cwd?: string; readonly origin?: string }
  readonly events?: readonly unknown[]
  append(type: string, data: unknown, intent?: unknown): unknown
}

interface AgentLike {
  cancel?(options?: unknown): unknown
  scope?: { dispose?(): Promise<void> }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** The open writer for one live session, when the backend keeps one. */
function liveWriterOf(store: PersistenceWrites, sessionId: string): { header?: unknown } | undefined {
  const writers = store.tracker?.writers
  return typeof writers?.get === 'function' ? writers.get(sessionId) : undefined
}

/** How long an agent gets to wind down before a delete proceeds anyway. */
const AGENT_DISPOSE_TIMEOUT_MS = 3000
/** How long the write-behind gets to settle after a session is detached. */
const RETIRE_SETTLE_MS = 200

function isZstd(path: string): boolean {
  return path.endsWith('.zstd')
}

/**
 * Encode a session artifact back into the backend's physical layout.
 *
 * dsh reads concatenated zstd frames and requires the FIRST frame to be exactly
 * the header line, so a rewritten artifact is emitted as two frames: the new
 * header, then the untouched remainder. Plain JSONL backends get the two lines
 * concatenated. Only the header line ever changes — the rest of the bytes are
 * carried over verbatim.
 */
export function encodeArtifact(headerLine: string, rest: string, zstd: boolean): Buffer {
  if (!zstd) return Buffer.from(`${headerLine}\n${rest}`, 'utf8')
  const header = zstdCompressSync(Buffer.from(`${headerLine}\n`, 'utf8'))
  if (rest === '') return header
  return Buffer.concat([header, zstdCompressSync(Buffer.from(rest, 'utf8'))])
}

/**
 * Replace the header line of a raw session artifact, keeping everything else.
 * @param raw - the artifact text as the backend decoded it.
 * @param cwd - the workspace path the conversation is moving to.
 * @returns the new header line plus the untouched remainder.
 */
export function rewriteHeaderCwd(raw: string, cwd: string): {
  headerLine: string
  header: Record<string, unknown>
  rest: string
} {
  const newlineAt = raw.indexOf('\n')
  if (newlineAt === -1) throw new WorkspaceError('会话工件缺少头行，数据可能已损坏，拒绝移动。')
  const headerText = raw.slice(0, newlineAt)
  const rest = raw.slice(newlineAt + 1)
  let header: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(headerText)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    header = parsed as Record<string, unknown>
  } catch (e) {
    throw new WorkspaceError(`会话工件头行无法解析，拒绝移动：${String(e)}`)
  }
  // `version` must survive: rewriting a v2 header to a lower generation makes
  // dsh reject the session on the next startup.
  const next = { ...header, cwd }
  return { headerLine: JSON.stringify(next), header: next, rest }
}

/** Create the workspace-administration runtime for one plugin instance. */
export function createWorkspaceAdmin(
  ctx: Context,
  deps: { sessions(): Promise<readonly SessionRef[]> },
): WorkspaceAdmin {
  const get = <T>(name: string): T | undefined =>
    (ctx as unknown as { get?(n: string): unknown }).get?.(name) as T | undefined

  const registry = (): RegistryLike | undefined => get<RegistryLike>('workspaceRegistry')
  const persistence = (): (PersistenceSeam & PersistenceWrites) | undefined =>
    get<PersistenceSeam & PersistenceWrites>('sessionPersistence')
  const agents = (): { get?(id: string): AgentLike | undefined } | undefined =>
    get<{ get?(id: string): AgentLike | undefined }>('agents')

  const entities = (): readonly WorkspaceEntityLike[] => {
    try { return registry()?.list() ?? [] } catch { return [] }
  }

  const archivedSet = (): ReadonlySet<string> => {
    try {
      const state = registry()?.requireState?.()
      const ids = state?.archivedSessionIds
      return new Set(Array.isArray(ids) ? ids : [])
    } catch { return new Set() }
  }

  const optionOf = (entity: WorkspaceEntityLike): WorkspaceOption => ({
    id: entity.id,
    path: entity.path,
    title: entity.title || entity.path,
  })

  /** Serialize one durable change to the registry state (how the registry itself commits). */
  const mutateState = async (change: (state: { archivedSessionIds: string[] } & Record<string, unknown>) =>
  { archivedSessionIds: string[] } & Record<string, unknown>): Promise<void> => {
    const reg = registry()
    if (reg?.enqueueOperation === undefined || reg.requireState === undefined || reg.setState === undefined) {
      throw new WorkspaceError('当前 dsh 版本未暴露注册表写入接口，无法修改归档状态。')
    }
    await reg.enqueueOperation(async () => {
      const state = reg.requireState!() as { archivedSessionIds: string[] } & Record<string, unknown>
      const next = change(state)
      if (next === state) return
      await reg.setState!(next)
    })
  }

  /**
   * Every id a workspace accounts for, filtered or not.
   *
   * `entity.sessionIds` is a getter that hides entries whose stored cwd no
   * longer matches the workspace path. That is exactly the state a move creates
   * mid-flight (the artifact already says the new path), so relying on it there
   * would silently skip the detach and leave the session owned by two
   * workspaces at once. The raw `record.sessionIds` is the honest answer.
   */
  const accountedIds = (entity: WorkspaceEntityLike): readonly string[] =>
    Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : entity.sessionIds

  const detachedFromAll = async (sessionId: string): Promise<string[]> => {
    const touched: string[] = []
    for (const entity of entities()) {
      if (!accountedIds(entity).includes(sessionId)) continue
      if (entity.detachSession === undefined) continue
      await entity.detachSession(sessionId)
      touched.push(entity.path)
    }
    return touched
  }

  /** The session artifact path for an id, or undefined when it never materialized. */
  const artifactPath = async (sessionId: string): Promise<string | undefined> => {
    const store = persistence()
    if (store === undefined) return undefined
    try {
      const rows = await listRaw(store)
      const meta = rows.find(row => row.id === sessionId)
      if (meta === undefined) return undefined
      return store.locate(meta)?.path
    } catch { return undefined }
  }

  const panel = async (sessionId: string): Promise<WorkspacePanel> => {
    const list = await deps.sessions()
    const live = ctx.sessions.get(sessionId as never) as unknown as SessionLike | undefined
    const mine = live?.header?.cwd ?? list.find(ref => ref.id === sessionId)?.cwd ?? ''

    // Subagent lineage lives on the header, which the session list does not carry.
    const origins = new Map<string, string | undefined>()
    try {
      for (const header of await listStored(persistence())) origins.set(header.id, header.origin)
    } catch { /* origins are decoration; a failed read just drops the badge */ }

    const workspaces = entities().map(optionOf)
    const current = entities().find(entity => entity.path === mine)
    const order = current === undefined
      ? list.map(ref => ref.id)
      : [...current.sessionIds]

    const byId = new Map(list.map(ref => [ref.id, ref]))
    const sessions: ManagedSession[] = []
    for (const id of order) {
      const ref = byId.get(id)
      if (ref === undefined) continue
      sessions.push({
        ...ref,
        isCurrent: false,
        running: agents()?.get?.(id) !== undefined,
        subagent: (live?.id === id ? live.header?.origin : origins.get(id)) === 'subagent',
        isPanel: id === sessionId,
      })
    }

    return {
      workspace: current === undefined ? undefined : optionOf(current),
      workspaces,
      sessions,
    }
  }

  const archive = async (targetId: string): Promise<void> => {
    const reg = registry()
    if (reg?.archiveSession === undefined) {
      throw new WorkspaceError('当前 dsh 版本未暴露归档接口，无法归档。')
    }
    await reg.archiveSession(targetId)
  }

  const restore = async (targetId: string): Promise<void> => {
    await mutateState((state) => state.archivedSessionIds.includes(targetId)
      ? { ...state, archivedSessionIds: state.archivedSessionIds.filter(id => id !== targetId) }
      : state)
  }

  /**
   * Delete a conversation for real: tear the agent down, drop the live store
   * entry (which is what makes every connected client drop the row), forget it
   * in the workspace ledger and the archive set, then remove the artifact.
   *
   * Only an archived conversation may be deleted — that extra step is the
   * confirmation this destructive operation gets.
   */
  const remove = async (targetId: string): Promise<{ dir?: string }> => {
    if (!archivedSet().has(targetId)) {
      throw new WorkspaceError('只能删除已归档的对话：请先归档，再删除。')
    }

    const agent = agents()?.get?.(targetId)
    if (agent !== undefined) {
      agent.cancel?.({ kind: 'disposed' })
      if (typeof agent.scope?.dispose === 'function') {
        await Promise.race([agent.scope.dispose(), sleep(AGENT_DISPOSE_TIMEOUT_MS)]).catch(() => undefined)
      }
      try {
        (ctx as unknown as { agents?: { store?: { delete?(id: string): void } } })
          .agents?.store?.delete?.(targetId)
      } catch { /* best-effort */ }
    }

    const live = ctx.sessions.get(targetId as never) as unknown as SessionLike | undefined
    let detached = false
    if (live !== undefined) {
      try { await (ctx.sessions as unknown as { flush(s: unknown): Promise<void> }).flush(live) } catch { /* best-effort */ }
      try {
        const entry = (ctx.sessions as unknown as {
          store?: { get?(id: string): { detach?(): void } | undefined }
        }).store?.get?.(targetId)
        if (entry?.detach !== undefined) {
          entry.detach()
          await sleep(RETIRE_SETTLE_MS)
          detached = true
        }
      } catch { /* best-effort */ }
    }
    // A session with no live row never fires the detach above, so the clients
    // would keep its row until the next refresh. Tell them explicitly.
    if (!detached) {
      try { (ctx as unknown as { emit(e: string, p: unknown): void }).emit('session/disposed', { id: targetId }) } catch { /* best-effort */ }
    }

    const dir = await artifactPath(targetId)
    await detachedFromAll(targetId)
    await restore(targetId)
    if (dir !== undefined) await rm(dirname(dir), { recursive: true, force: true })
    return dir === undefined ? {} : { dir: dirname(dir) }
  }

  /**
   * Move a conversation into another workspace.
   *
   * A session belongs to a workspace through its `cwd`, and the workspace
   * registry refuses to attach a session whose stored cwd disagrees with the
   * workspace path. So the artifact is rewritten first (header `cwd` → target
   * path, atomically renamed to the path that cwd implies) and the ledger is
   * swapped afterwards.
   *
   * Only closed conversations are supported: a live one would also need its
   * in-memory header updated and its write-behind held off with a per-session
   * lock, which is more machinery than this tab needs.
   */
  const move = async (targetId: string, toWorkspaceId: string): Promise<{ from: string; to: string }> => {
    const store = persistence()
    if (store?.readRaw === undefined || typeof store.locate !== 'function') {
      throw new WorkspaceError('当前持久化后端不支持定位会话工件，无法跨工作区迁移。')
    }
    // Archived conversations are out of play: moving one would put it back in
    // front of the user inside another workspace. Restore it first — that is
    // the same one-step gate the delete path uses in the other direction.
    if (archivedSet().has(targetId)) {
      throw new WorkspaceError('已归档的对话不能迁移：请先还原它。')
    }
    const target = entities().find(entity => entity.id === toWorkspaceId)
    if (target === undefined) throw new WorkspaceError('目标工作区不存在。')
    if (target.attachSession === undefined) {
      throw new WorkspaceError('当前 dsh 版本未暴露工作区记账写入接口，无法迁移。')
    }

    const coordinator = store.coordinator

    // A conversation held in memory can be moved too, but its live writer has
    // to come along: it owns the open file handle and would otherwise keep
    // appending to the path we just moved away from.
    const live = ctx.sessions.get(targetId as never) as unknown as SessionLike | undefined
    const writer = live === undefined ? undefined : liveWriterOf(store, targetId)
    if (live !== undefined) {
      // Push buffered events to the OLD artifact first, so nothing is left
      // behind when the file is re-homed.
      try {
        await (ctx.sessions as unknown as { flush(session: unknown): Promise<void> }).flush(live)
      } catch { /* best-effort: an unwritable buffer is a separate problem */ }
      // What keeps a live conversation's writes landing in the right file
      // differs by dsh version: older builds register an open writer object
      // (`persistence.tracker.writers`) whose header must be retargeted, while
      // this one derives the path from the coordinator's per-session write
      // state (`coordinator.states.get(id).meta.cwd`) on every write. Accept
      // either — refuse only when neither exists, because then nothing known
      // points the next write at the new artifact.
      if (writer === undefined && coordinator?.states?.get?.(targetId) === undefined) {
        throw new WorkspaceError(
          '当前运行时既不暴露 live 写入器、也不暴露持久化写入状态，无法安全迁移打开中的对话；请先关闭它再迁移。',
        )
      }
    }

    const serialize = typeof coordinator?.serialize === 'function'
      ? <T>(operation: () => Promise<T>): Promise<T> => coordinator.serialize!(targetId, operation)
      : <T>(operation: () => Promise<T>): Promise<T> => operation()

    // Serialize with the persistence coordinator when it offers a per-id lock:
    // the write-behind must not append to the artifact while it is hidden.
    const moved = await serialize(async () => {
      const raw = await store.readRaw!(targetId)
      if (raw === undefined) throw new WorkspaceError('读不到该对话的磁盘工件，无法迁移。')

      const headers = await listRaw(store)
      const meta = headers.find(header => header.id === targetId)
      if (meta?.origin === 'subagent') throw new WorkspaceError('子代理会话不支持跨工作区迁移。')

      const oldPath = raw.path ?? (meta === undefined ? undefined : store.locate(meta)?.path)
      if (oldPath === undefined) throw new WorkspaceError('无法定位该对话当前的工件路径。')

      const { headerLine, header, rest } = rewriteHeaderCwd(raw.content, target.path)
      const newPath = store.locate(header)?.path
      if (newPath === undefined) throw new WorkspaceError('持久化后端无法计算迁移后的工件路径。')
      if (newPath === oldPath) throw new WorkspaceError('会话源路径与目标路径相同，拒绝覆盖。')

      await mkdir(dirname(newPath), { recursive: true })
      const bytes = encodeArtifact(headerLine, rest, isZstd(newPath))
      const staged = `${newPath}.${randomBytes(6).toString('hex')}.tmp`
      const handle = await open(staged, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }

      // `parked` holds the ORIGINAL artifact and is the only way back: it must
      // survive until the ledger swap has succeeded. (Deleting it early once
      // left a rewritten artifact sitting in the old directory — and dsh
      // validates at startup that a session's location matches its header cwd,
      // so that state makes it refuse to boot the whole plugin tree.)
      const parked = `${oldPath}.${randomBytes(6).toString('hex')}.tmp`
      await rename(oldPath, parked)
      try {
        await rename(staged, newPath)
      } catch (e) {
        await rename(parked, oldPath).catch(() => undefined)
        await rm(staged, { force: true }).catch(() => undefined)
        throw new WorkspaceError(`迁移失败，已回滚到原路径：${String(e)}`)
      }
      return { oldPath, newPath, header, parked }
    })

    const { oldPath, newPath, header, parked } = moved

    // --- in-memory state ----------------------------------------------------
    // Three places remember where this conversation lives: the live writer's
    // header, the in-memory session header, and the registry's indexes (which
    // is what `attachSession` validates against). All of them move together
    // with the artifact, and all of them are restored on failure.
    const reg = registry() as RegistryLike
    const writeState = coordinator?.states?.get?.(targetId)
    const oldIndexedHeader = reg.headers?.get?.(targetId)
    const oldIndexedPath = reg.sessionPaths?.get?.(targetId)
    const oldInvalidPath = reg.invalidSessionPaths?.get?.(targetId)
    const oldStateMeta = writeState?.meta
    const oldWriterHeader = writer?.header
    const oldLiveHeader = live?.header

    const applyIndexes = (): void => {
      if (writer !== undefined) writer.header = Object.freeze({ ...header })
      if (live !== undefined) live.header = Object.freeze({ ...header })
      if (writeState !== undefined) {
        writeState.meta = { ...(writeState.meta as Record<string, unknown> ?? {}), ...header }
        writeState.materialized = true
      }
      coordinator?.preparations?.invalidate?.(targetId)
      reg.headers?.set?.(targetId, { ...header })
      reg.sessionPaths?.set?.(targetId, target.path)
      reg.invalidSessionPaths?.delete?.(targetId)
    }
    const restoreIndexes = (): void => {
      if (writer !== undefined) writer.header = oldWriterHeader
      if (live !== undefined) live.header = oldLiveHeader
      if (writeState !== undefined && oldStateMeta !== undefined) writeState.meta = oldStateMeta
      if (oldIndexedHeader === undefined) reg.headers?.delete?.(targetId)
      else reg.headers?.set?.(targetId, oldIndexedHeader)
      if (oldIndexedPath === undefined) reg.sessionPaths?.delete?.(targetId)
      else reg.sessionPaths?.set?.(targetId, oldIndexedPath)
      if (oldInvalidPath !== undefined) reg.invalidSessionPaths?.set?.(targetId, oldInvalidPath)
    }

    // --- ledger swap --------------------------------------------------------
    applyIndexes()
    try {
      await detachedFromAll(targetId)
      await target.attachSession(targetId)
    } catch (e) {
      // Undo in the reverse order, and restore the ORIGINAL bytes rather than
      // moving the rewritten artifact back: the location and the header cwd
      // must agree at all times, or the next start is refused.
      restoreIndexes()
      await rm(newPath, { force: true }).catch(() => undefined)
      await rename(parked, oldPath).catch(() => undefined)
      throw new WorkspaceError(`工作区记账更新失败，已回滚到 ${oldPath}：${String(e)}`)
    }

    await rm(parked, { force: true }).catch(() => undefined)
    // The artifact is a file inside a per-session directory; removing the file
    // leaves that directory behind, so drop it too when it is empty (a no-op
    // when something else still lives there).
    await rmdir(dirname(oldPath)).catch(() => undefined)
    return { from: oldPath, to: newPath }
  }


  return { panel, archive, restore, remove, move }
}
