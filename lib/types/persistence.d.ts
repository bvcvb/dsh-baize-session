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
/** One stored session, normalized across both lines. */
export interface SessionRow {
    readonly id: string;
    readonly cwd?: string;
    readonly createdAt?: number;
    /** Coarse classification (`'subagent'`); carried on the header, not the session list. */
    readonly origin?: string;
}
/** A non-committing read of one stored session. */
export interface StoredSession {
    readonly meta: {
        readonly cwd?: string;
    };
    readonly events: readonly unknown[];
}
/** Which read stack a backend offers. */
export type ReadStack = 'inspect' | 'handle' | 'none';
/** The handle returned by the 0.1.7-alpha.1 `open()`. */
interface HandleLike {
    readonly header?: {
        readonly id?: string;
        readonly cwd?: string;
        readonly createdAt?: number;
        readonly origin?: string;
    };
    read(offset?: number, length?: number, options?: {
        readonly signal?: AbortSignal;
    }): Promise<{
        readonly events?: readonly unknown[];
    }>;
    close?(): Promise<void> | void;
}
/**
 * Structural view of the seam. Every member is optional on purpose: which ones
 * exist is exactly what differs between dsh lines.
 */
export interface PersistenceLike {
    /** 0.1.1-rc.2's non-committing read. */
    inspect?(id: string, signal?: AbortSignal): Promise<{
        readonly meta?: {
            readonly cwd?: string;
        };
        readonly events?: readonly unknown[];
    } | undefined>;
    /** Positional signal on rc.2, options object on alpha.1 — see {@link listRaw}. */
    list?(...args: readonly unknown[]): Promise<readonly unknown[]>;
    /** 0.1.7-alpha.1's handle factory. */
    open?(id: string, access: 'read' | 'write', options?: {
        readonly signal?: AbortSignal;
    }): Promise<HandleLike | undefined>;
}
/**
 * Reach the service through `ctx.get`, exactly as official code does.
 *
 * Deliberately not declared in `inject`: cordis holds a plugin in
 * `pending (waiting for service: …)` when the service is unresolvable in its
 * scope, and one pending entry aborts the whole boot. `get` returns `undefined`
 * instead, which costs only the read paths.
 */
export declare const getPersistence: (ctx: unknown) => PersistenceLike | undefined;
/** Which read stack this backend speaks. */
export declare const readStackOf: (store: PersistenceLike | undefined) => ReadStack;
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
export declare const listRaw: (store: PersistenceLike | undefined, signal?: AbortSignal) => Promise<readonly Record<string, unknown>[]>;
/** Every stored session, normalized. Never throws; an unreadable backend lists nothing. */
export declare const listStored: (store: PersistenceLike | undefined, signal?: AbortSignal) => Promise<readonly SessionRow[]>;
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
export declare const readStored: (store: PersistenceLike | undefined, sessionId: string, signal?: AbortSignal) => Promise<StoredSession | undefined>;
export {};
