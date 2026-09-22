/**
 * The session-persistence seam, tolerant of both published shapes.
 *
 * Two dsh lines are in the wild and they disagree about this service:
 *
 * - **0.1.1-rc.2** exposes a concrete `SessionPersistence` class whose read side
 *   is `inspect(id, signal)` → `{ meta: { cwd }, events }`, plus
 *   `list(signal)` → `{ id, cwd, createdAt }[]`.
 * - **0.1.7-alpha.1** reduced that class to a service-definition shell and moved
 *   the API to the SessionHandle model: `open(id, 'read' | 'write')` → a handle
 *   carrying `header` and `read()`, and `list()` → `{ header, revision }[]`.
 *   `inspect`, `load`, `locate`, `readRaw`, `coordinator` and `tracker` are gone.
 *
 * Reaching for the absent `inspect` threw a **synchronous** TypeError
 * ("TypeError: store.inspect is not a function"), which is precisely why the
 * old `await store.inspect(...).catch(() => undefined)` guard could not absorb
 * it: `.catch` never ran, and the panel surfaced an opaque HTTP 500. Hence, in
 * this module every capability is probed at runtime and every call is wrapped,
 * so an unrecognized future shape degrades to "unreadable" rather than throwing.
 *
 * Read the two shapes apart from {@link readStackOf}; never branch on a version
 * number — what the object actually exposes is the only durable fact.
 *
 * @module dsh-baize-session/persistence
 */
const isObject = (value) => typeof value === 'object' && value !== null;
/**
 * Reach the service through `ctx.get`, exactly as official code does.
 *
 * Deliberately not declared in `inject`: cordis holds a plugin in
 * `pending (waiting for service: …)` when the service is unresolvable in its
 * scope, and one pending entry aborts the whole boot. `get` returns `undefined`
 * instead, which costs only the read paths.
 */
export const getPersistence = (ctx) => {
    const get = ctx?.get;
    return typeof get === 'function' ? get('sessionPersistence') : undefined;
};
/** Which read stack this backend speaks. */
export const readStackOf = (store) => {
    if (store === undefined)
        return 'none';
    if (typeof store.inspect === 'function')
        return 'inspect';
    if (typeof store.open === 'function')
        return 'handle';
    return 'none';
};
/**
 * Call `list` in the shape this backend expects, answering the rows **as the
 * backend wrote them**.
 *
 * Two callers need the untouched rows rather than {@link SessionRow}: the
 * cross-workspace move feeds a row straight back into `locate(meta)`, which on
 * rc.2 wants the backend's own metadata object. Normalizing there would strip
 * whatever private fields that lookup relies on.
 *
 * rc.2 takes the abort signal positionally; alpha.1 takes
 * `{ signal }`. Passing the wrong one is not fatal (an AbortSignal is a plain
 * object to the newer signature), but it would silently drop cancellation, so
 * the shape is chosen from the stack rather than guessed.
 */
export const listRaw = async (store, signal) => {
    if (store === undefined || typeof store.list !== 'function')
        return [];
    try {
        // `none` lands here too: an unknown shape is more likely a descendant of
        // the handle model than of the removed class, so the newest call form wins.
        const rows = readStackOf(store) === 'inspect'
            ? await store.list(signal)
            : await store.list(signal === undefined ? undefined : { signal });
        return (rows ?? []).filter(isObject);
    }
    catch {
        return [];
    }
};
/**
 * Accept both row shapes.
 *
 * rc.2 answers the metadata itself (`{ id, cwd, … }`); alpha.1 nests it under
 * `header` (`{ header: { id, cwd, … }, revision, … }`). Normalizing here keeps
 * every downstream caller written against one shape.
 */
const rowOf = (raw) => {
    if (!isObject(raw))
        return undefined;
    const source = isObject(raw.header) ? raw.header : raw;
    const id = source.id;
    if (typeof id !== 'string' || id.length === 0)
        return undefined;
    return {
        id,
        ...(typeof source.cwd === 'string' ? { cwd: source.cwd } : {}),
        ...(typeof source.createdAt === 'number' ? { createdAt: source.createdAt } : {}),
        ...(typeof source.origin === 'string' ? { origin: source.origin } : {}),
    };
};
/** Every stored session, normalized. Never throws; an unreadable backend lists nothing. */
export const listStored = async (store, signal) => (await listRaw(store, signal))
    .map(rowOf)
    .filter((row) => row !== undefined);
/**
 * Read one stored session without committing anything.
 *
 * "Non-committing" is the whole point (see the panel's browse path): the read
 * must not publish, repair, or take ownership. Both stacks honor that — rc.2's
 * `inspect` never publishes or repairs, and alpha.1's `open(id, 'read')` is
 * documented as *"read only observes — it never takes ownership and works while
 * another handle or process holds write"*.
 *
 * Returns `undefined` for "no such session" and for "this backend cannot read
 * it", because callers cannot act differently on the two: both mean the row
 * stays cold.
 */
export const readStored = async (store, sessionId, signal) => {
    if (store === undefined)
        return undefined;
    try {
        if (typeof store.inspect === 'function') {
            const stored = await store.inspect(sessionId, signal);
            if (stored === undefined)
                return undefined;
            const cwd = stored.meta?.cwd;
            return { meta: cwd === undefined ? {} : { cwd }, events: stored.events ?? [] };
        }
        if (typeof store.open === 'function') {
            const handle = await store.open(sessionId, 'read', signal === undefined ? undefined : { signal });
            if (handle === undefined)
                return undefined;
            try {
                const result = await handle.read();
                const cwd = handle.header?.cwd;
                return { meta: cwd === undefined ? {} : { cwd }, events: result?.events ?? [] };
            }
            finally {
                // A handle is single-owner state, not a shared service: leaving it open
                // would hold a read channel open for every conversation merely browsed.
                await handle.close?.();
            }
        }
        return undefined;
    }
    catch {
        // Covers "not found" and "artifact unreadable" alike — and, unlike a
        // `.catch()` on the call itself, it also covers a missing method.
        return undefined;
    }
};
