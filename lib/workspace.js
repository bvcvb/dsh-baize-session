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
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { listRaw, listStored } from "./persistence.js";
/** A refusal the user can act on; the API layer answers it with HTTP 400. */
export class WorkspaceError extends Error {
}
const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms); });
/** The open writer for one live session, when the backend keeps one. */
function liveWriterOf(store, sessionId) {
    const writers = store.tracker?.writers;
    return typeof writers?.get === 'function' ? writers.get(sessionId) : undefined;
}
/** How long an agent gets to wind down before a delete proceeds anyway. */
const AGENT_DISPOSE_TIMEOUT_MS = 3000;
/** How long the write-behind gets to settle after a session is detached. */
const RETIRE_SETTLE_MS = 200;
function isZstd(path) {
    return path.endsWith('.zstd');
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
export function encodeArtifact(headerLine, rest, zstd) {
    if (!zstd)
        return Buffer.from(`${headerLine}\n${rest}`, 'utf8');
    const header = zstdCompressSync(Buffer.from(`${headerLine}\n`, 'utf8'));
    if (rest === '')
        return header;
    return Buffer.concat([header, zstdCompressSync(Buffer.from(rest, 'utf8'))]);
}
/**
 * Replace the header line of a raw session artifact, keeping everything else.
 * @param raw - the artifact text as the backend decoded it.
 * @param cwd - the workspace path the conversation is moving to.
 * @returns the new header line plus the untouched remainder.
 */
export function rewriteHeaderCwd(raw, cwd) {
    const newlineAt = raw.indexOf('\n');
    if (newlineAt === -1)
        throw new WorkspaceError('会话工件缺少头行，数据可能已损坏，拒绝移动。');
    const headerText = raw.slice(0, newlineAt);
    const rest = raw.slice(newlineAt + 1);
    let header;
    try {
        const parsed = JSON.parse(headerText);
        if (typeof parsed !== 'object' || parsed === null)
            throw new Error('not an object');
        header = parsed;
    }
    catch (e) {
        throw new WorkspaceError(`会话工件头行无法解析，拒绝移动：${String(e)}`);
    }
    // `version` must survive: rewriting a v2 header to a lower generation makes
    // dsh reject the session on the next startup.
    const next = { ...header, cwd };
    return { headerLine: JSON.stringify(next), header: next, rest };
}
/** Create the workspace-administration runtime for one plugin instance. */
export function createWorkspaceAdmin(ctx, deps) {
    const get = (name) => ctx.get?.(name);
    const registry = () => get('workspaceRegistry');
    const persistence = () => get('sessionPersistence');
    const agents = () => get('agents');
    const entities = () => {
        try {
            return registry()?.list() ?? [];
        }
        catch {
            return [];
        }
    };
    const archivedSet = () => {
        try {
            const state = registry()?.requireState?.();
            const ids = state?.archivedSessionIds;
            return new Set(Array.isArray(ids) ? ids : []);
        }
        catch {
            return new Set();
        }
    };
    const optionOf = (entity) => ({
        id: entity.id,
        path: entity.path,
        title: entity.title || entity.path,
    });
    /** Serialize one durable change to the registry state (how the registry itself commits). */
    const mutateState = async (change) => {
        const reg = registry();
        if (reg?.enqueueOperation === undefined || reg.requireState === undefined || reg.setState === undefined) {
            throw new WorkspaceError('当前 dsh 版本未暴露注册表写入接口，无法修改归档状态。');
        }
        await reg.enqueueOperation(async () => {
            const state = reg.requireState();
            const next = change(state);
            if (next === state)
                return;
            await reg.setState(next);
        });
    };
    /**
     * Every id a workspace accounts for, filtered or not.
     *
     * `entity.sessionIds` is a getter that hides entries whose stored cwd no
     * longer matches the workspace path. That is exactly the state a move creates
     * mid-flight (the artifact already says the new path), so relying on it there
     * would silently skip the detach and leave the session owned by two
     * workspaces at once. The raw `record.sessionIds` is the honest answer.
     */
    const accountedIds = (entity) => Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : entity.sessionIds;
    const detachedFromAll = async (sessionId) => {
        const touched = [];
        for (const entity of entities()) {
            if (!accountedIds(entity).includes(sessionId))
                continue;
            if (entity.detachSession === undefined)
                continue;
            await entity.detachSession(sessionId);
            touched.push(entity.path);
        }
        return touched;
    };
    /** The session artifact path for an id, or undefined when it never materialized. */
    const artifactPath = async (sessionId) => {
        const store = persistence();
        if (store === undefined)
            return undefined;
        try {
            const rows = await listRaw(store);
            const meta = rows.find(row => row.id === sessionId);
            if (meta === undefined)
                return undefined;
            return store.locate(meta)?.path;
        }
        catch {
            return undefined;
        }
    };
    const panel = async (sessionId) => {
        const list = await deps.sessions();
        const live = ctx.sessions.get(sessionId);
        const mine = live?.header?.cwd ?? list.find(ref => ref.id === sessionId)?.cwd ?? '';
        // Subagent lineage lives on the header, which the session list does not carry.
        const origins = new Map();
        try {
            for (const header of await listStored(persistence()))
                origins.set(header.id, header.origin);
        }
        catch { /* origins are decoration; a failed read just drops the badge */ }
        const workspaces = entities().map(optionOf);
        const current = entities().find(entity => entity.path === mine);
        const order = current === undefined
            ? list.map(ref => ref.id)
            : [...current.sessionIds];
        const byId = new Map(list.map(ref => [ref.id, ref]));
        const sessions = [];
        for (const id of order) {
            const ref = byId.get(id);
            if (ref === undefined)
                continue;
            sessions.push({
                ...ref,
                isCurrent: false,
                running: agents()?.get?.(id) !== undefined,
                subagent: (live?.id === id ? live.header?.origin : origins.get(id)) === 'subagent',
                isPanel: id === sessionId,
            });
        }
        return {
            workspace: current === undefined ? undefined : optionOf(current),
            workspaces,
            sessions,
        };
    };
    const archive = async (targetId) => {
        const reg = registry();
        if (reg?.archiveSession === undefined) {
            throw new WorkspaceError('当前 dsh 版本未暴露归档接口，无法归档。');
        }
        await reg.archiveSession(targetId);
    };
    const restore = async (targetId) => {
        await mutateState((state) => state.archivedSessionIds.includes(targetId)
            ? { ...state, archivedSessionIds: state.archivedSessionIds.filter(id => id !== targetId) }
            : state);
    };
    /**
     * Delete a conversation for real: tear the agent down, drop the live store
     * entry (which is what makes every connected client drop the row), forget it
     * in the workspace ledger and the archive set, then remove the artifact.
     *
     * Only an archived conversation may be deleted — that extra step is the
     * confirmation this destructive operation gets.
     */
    const remove = async (targetId) => {
        if (!archivedSet().has(targetId)) {
            throw new WorkspaceError('只能删除已归档的对话：请先归档，再删除。');
        }
        const agent = agents()?.get?.(targetId);
        if (agent !== undefined) {
            agent.cancel?.({ kind: 'disposed' });
            if (typeof agent.scope?.dispose === 'function') {
                await Promise.race([agent.scope.dispose(), sleep(AGENT_DISPOSE_TIMEOUT_MS)]).catch(() => undefined);
            }
            try {
                ctx
                    .agents?.store?.delete?.(targetId);
            }
            catch { /* best-effort */ }
        }
        const live = ctx.sessions.get(targetId);
        let detached = false;
        if (live !== undefined) {
            try {
                await ctx.sessions.flush(live);
            }
            catch { /* best-effort */ }
            try {
                const entry = ctx.sessions.store?.get?.(targetId);
                if (entry?.detach !== undefined) {
                    entry.detach();
                    await sleep(RETIRE_SETTLE_MS);
                    detached = true;
                }
            }
            catch { /* best-effort */ }
        }
        // A session with no live row never fires the detach above, so the clients
        // would keep its row until the next refresh. Tell them explicitly.
        if (!detached) {
            try {
                ctx.emit('session/disposed', { id: targetId });
            }
            catch { /* best-effort */ }
        }
        const dir = await artifactPath(targetId);
        await detachedFromAll(targetId);
        await restore(targetId);
        if (dir !== undefined)
            await rm(dirname(dir), { recursive: true, force: true });
        return dir === undefined ? {} : { dir: dirname(dir) };
    };
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
    const move = async (targetId, toWorkspaceId) => {
        const store = persistence();
        if (store?.readRaw === undefined || typeof store.locate !== 'function') {
            throw new WorkspaceError('当前持久化后端不支持定位会话工件，无法跨工作区迁移。');
        }
        // Archived conversations are out of play: moving one would put it back in
        // front of the user inside another workspace. Restore it first — that is
        // the same one-step gate the delete path uses in the other direction.
        if (archivedSet().has(targetId)) {
            throw new WorkspaceError('已归档的对话不能迁移：请先还原它。');
        }
        const target = entities().find(entity => entity.id === toWorkspaceId);
        if (target === undefined)
            throw new WorkspaceError('目标工作区不存在。');
        if (target.attachSession === undefined) {
            throw new WorkspaceError('当前 dsh 版本未暴露工作区记账写入接口，无法迁移。');
        }
        const coordinator = store.coordinator;
        // A conversation held in memory can be moved too, but its live writer has
        // to come along: it owns the open file handle and would otherwise keep
        // appending to the path we just moved away from.
        const live = ctx.sessions.get(targetId);
        const writer = live === undefined ? undefined : liveWriterOf(store, targetId);
        if (live !== undefined) {
            // Push buffered events to the OLD artifact first, so nothing is left
            // behind when the file is re-homed.
            try {
                await ctx.sessions.flush(live);
            }
            catch { /* best-effort: an unwritable buffer is a separate problem */ }
            // What keeps a live conversation's writes landing in the right file
            // differs by dsh version: older builds register an open writer object
            // (`persistence.tracker.writers`) whose header must be retargeted, while
            // this one derives the path from the coordinator's per-session write
            // state (`coordinator.states.get(id).meta.cwd`) on every write. Accept
            // either — refuse only when neither exists, because then nothing known
            // points the next write at the new artifact.
            if (writer === undefined && coordinator?.states?.get?.(targetId) === undefined) {
                throw new WorkspaceError('当前运行时既不暴露 live 写入器、也不暴露持久化写入状态，无法安全迁移打开中的对话；请先关闭它再迁移。');
            }
        }
        const serialize = typeof coordinator?.serialize === 'function'
            ? (operation) => coordinator.serialize(targetId, operation)
            : (operation) => operation();
        // Serialize with the persistence coordinator when it offers a per-id lock:
        // the write-behind must not append to the artifact while it is hidden.
        const moved = await serialize(async () => {
            const raw = await store.readRaw(targetId);
            if (raw === undefined)
                throw new WorkspaceError('读不到该对话的磁盘工件，无法迁移。');
            const headers = await listRaw(store);
            const meta = headers.find(header => header.id === targetId);
            if (meta?.origin === 'subagent')
                throw new WorkspaceError('子代理会话不支持跨工作区迁移。');
            const oldPath = raw.path ?? (meta === undefined ? undefined : store.locate(meta)?.path);
            if (oldPath === undefined)
                throw new WorkspaceError('无法定位该对话当前的工件路径。');
            const { headerLine, header, rest } = rewriteHeaderCwd(raw.content, target.path);
            const newPath = store.locate(header)?.path;
            if (newPath === undefined)
                throw new WorkspaceError('持久化后端无法计算迁移后的工件路径。');
            if (newPath === oldPath)
                throw new WorkspaceError('会话源路径与目标路径相同，拒绝覆盖。');
            await mkdir(dirname(newPath), { recursive: true });
            const bytes = encodeArtifact(headerLine, rest, isZstd(newPath));
            const staged = `${newPath}.${randomBytes(6).toString('hex')}.tmp`;
            const handle = await open(staged, 'wx', 0o600);
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            // `parked` holds the ORIGINAL artifact and is the only way back: it must
            // survive until the ledger swap has succeeded. (Deleting it early once
            // left a rewritten artifact sitting in the old directory — and dsh
            // validates at startup that a session's location matches its header cwd,
            // so that state makes it refuse to boot the whole plugin tree.)
            const parked = `${oldPath}.${randomBytes(6).toString('hex')}.tmp`;
            await rename(oldPath, parked);
            try {
                await rename(staged, newPath);
            }
            catch (e) {
                await rename(parked, oldPath).catch(() => undefined);
                await rm(staged, { force: true }).catch(() => undefined);
                throw new WorkspaceError(`迁移失败，已回滚到原路径：${String(e)}`);
            }
            return { oldPath, newPath, header, parked };
        });
        const { oldPath, newPath, header, parked } = moved;
        // --- in-memory state ----------------------------------------------------
        // Three places remember where this conversation lives: the live writer's
        // header, the in-memory session header, and the registry's indexes (which
        // is what `attachSession` validates against). All of them move together
        // with the artifact, and all of them are restored on failure.
        const reg = registry();
        const writeState = coordinator?.states?.get?.(targetId);
        const oldIndexedHeader = reg.headers?.get?.(targetId);
        const oldIndexedPath = reg.sessionPaths?.get?.(targetId);
        const oldInvalidPath = reg.invalidSessionPaths?.get?.(targetId);
        const oldStateMeta = writeState?.meta;
        const oldWriterHeader = writer?.header;
        const oldLiveHeader = live?.header;
        const applyIndexes = () => {
            if (writer !== undefined)
                writer.header = Object.freeze({ ...header });
            if (live !== undefined)
                live.header = Object.freeze({ ...header });
            if (writeState !== undefined) {
                writeState.meta = { ...(writeState.meta ?? {}), ...header };
                writeState.materialized = true;
            }
            coordinator?.preparations?.invalidate?.(targetId);
            reg.headers?.set?.(targetId, { ...header });
            reg.sessionPaths?.set?.(targetId, target.path);
            reg.invalidSessionPaths?.delete?.(targetId);
        };
        const restoreIndexes = () => {
            if (writer !== undefined)
                writer.header = oldWriterHeader;
            if (live !== undefined)
                live.header = oldLiveHeader;
            if (writeState !== undefined && oldStateMeta !== undefined)
                writeState.meta = oldStateMeta;
            if (oldIndexedHeader === undefined)
                reg.headers?.delete?.(targetId);
            else
                reg.headers?.set?.(targetId, oldIndexedHeader);
            if (oldIndexedPath === undefined)
                reg.sessionPaths?.delete?.(targetId);
            else
                reg.sessionPaths?.set?.(targetId, oldIndexedPath);
            if (oldInvalidPath !== undefined)
                reg.invalidSessionPaths?.set?.(targetId, oldInvalidPath);
        };
        // --- ledger swap --------------------------------------------------------
        applyIndexes();
        try {
            await detachedFromAll(targetId);
            await target.attachSession(targetId);
        }
        catch (e) {
            // Undo in the reverse order, and restore the ORIGINAL bytes rather than
            // moving the rewritten artifact back: the location and the header cwd
            // must agree at all times, or the next start is refused.
            restoreIndexes();
            await rm(newPath, { force: true }).catch(() => undefined);
            await rename(parked, oldPath).catch(() => undefined);
            throw new WorkspaceError(`工作区记账更新失败，已回滚到 ${oldPath}：${String(e)}`);
        }
        await rm(parked, { force: true }).catch(() => undefined);
        // The artifact is a file inside a per-session directory; removing the file
        // leaves that directory behind, so drop it too when it is empty (a no-op
        // when something else still lives there).
        await rmdir(dirname(oldPath)).catch(() => undefined);
        return { from: oldPath, to: newPath };
    };
    return { panel, archive, restore, remove, move };
}
