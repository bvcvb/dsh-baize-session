/**
 * Dependency-free helpers for the session-relocation flow: reading message-shaped
 * events out of a session log, and rendering collected messages into the block
 * that gets injected into the target session.
 *
 * Nothing here touches a dsh runtime, so `pnpm test` covers the rendering rules
 * (grouping by source, path notice, budget trimming) without booting dsh.
 *
 * @module dsh-baize-session/core
 */
/** One collected Q/A pair (or single message) carried over from a source session. */
export interface CollectedItem {
    /** Source session the message came from (provenance line in the render). */
    readonly sessionId: string;
    /** Source session's working directory, shown so the model can tell projects apart. */
    readonly cwd: string;
    /** Event seq inside the source session — stable identity, shown to the user. */
    readonly seq: number;
    /** The `assistant/message` identity, when the event carried one. The panel
     *  needs it to mark a reply as already collected (the seat only hands over a
     *  message id, never a seq). */
    readonly messageId?: string;
    readonly role: MessageRole;
    readonly text: string;
}
/**
 * Who a message came from — the badge the picker shows.
 *
 * `user/message` is NOT the same as "the user said this": DSH logs real human
 * input and plugin-injected context under that one event type, separated only
 * by `data.source.kind`. A real session on this machine carries `{user: 4,
 * plugin: 10}` — the majority of that conversation is injected context, which
 * is exactly why the two have to be told apart.
 *
 * - `user`      — a human prompt (`source.kind === 'user'`)
 * - `assistant` — a model reply
 * - `context`   — injected by a plugin/harness (`source.kind` is anything else:
 *                 runtime snapshots, `<system-reminder>`, memory injections…)
 * - `tool`      — a tool result, logged as its own `tool/result` event
 */
export type MessageRole = 'user' | 'assistant' | 'context' | 'tool';
/**
 * Read one event as a collectable message, or null when it is not one.
 *
 * Collectable = the three surface message types. Tool *calls* (`tool/call`),
 * reasoning chunks and compaction internals stay out of scope by design (see
 * the spec's §2) — a `tool/result` is the tool's answer and does count.
 */
export declare function readMessageEvent(event: unknown): {
    role: MessageRole;
    text: string;
} | null;
/**
 * The message identity an event carries, when it has one.
 *
 * The `conversation.chat.assistant-actions` seat hands a component a
 * `messageId` and nothing else, so the panel collects by id and the host maps
 * it back to a seq through this accessor — so this must return exactly the id
 * the client's projection calls `messageId` (see {@link messagePayload}).
 */
export declare function messageIdOf(event: unknown): string | undefined;
/** One message offered to the user by `/baize-session info`. */
export interface MessageRef {
    readonly seq: number;
    readonly role: MessageRole;
    readonly text: string;
    /** First line, trimmed — what the info listing shows. */
    readonly preview: string;
}
/** Every collectable message in a session log, in log order. */
export declare function listMessages(events: readonly unknown[]): MessageRef[];
/**
 * First line of the block this plugin injects into a target session.
 *
 * Exported because it is also a marker: a conversation whose opening message is
 * this block is a relocation *landing site*, not a conversation with its own
 * subject, so the picker must not present that boilerplate as its name.
 */
export declare const INJECTION_HEADER = "\u4EE5\u4E0B\u662F\u672C\u4F1A\u8BDD\u5F00\u59CB\u524D\uFF0C\u6211\uFF08\u7528\u6237\uFF09\u4ECE\u5176\u5B83\u4F1A\u8BDD\u6574\u7406\u8FC7\u6765\u7684\u4E0A\u4E0B\u6587\uFF0C\u4F9B\u4F60\u53C2\u8003\uFF1A";
/**
 * Render the collected messages as the text injected into the target session.
 *
 * The trailing "current workspace is …" line is the whole reason this plugin
 * rewrites content instead of replaying events: it tells the model that the
 * quoted history comes from other directories, without any path rewriting.
 * The wording follows DSH's own term for a directory-backed group of sessions
 * (a *workspace*), which is also what the panel calls it.
 */
export declare function renderInjection(items: readonly CollectedItem[], targetCwd: string): string;
/** Rough character budget guard used before the token estimate is available. */
export declare function totalChars(items: readonly CollectedItem[]): number;
/** Compact listing of the basket, one line per item. */
export declare function formatBasket(items: readonly CollectedItem[]): string;
/**
 * The conversation's logged name.
 *
 * A session's title lives in the log as a latest-wins `session/title` event
 * (`@deepseek-ai/dsh-session-title`: "Latest-wins session title snapshot.
 * Log-only"), never in the header — so this folds the log the same way the
 * official `foldSessionTitle` does, without depending on that package.
 *
 * @param events - live events or a persisted replay.
 * @returns the latest non-empty title, or undefined when none was ever logged.
 */
export declare function loggedSessionTitle(events: readonly unknown[]): string | undefined;
/**
 * What to call a conversation in a picker.
 *
 * Falls back to the first user line, because a session that has not run a turn
 * has no title yet — and every conversation this plugin creates lands in exactly
 * that state (a title is generated on the first prompt, which a freshly seeded
 * session never sees).
 *
 * A relocated landing site is skipped on the way: its opening message is this
 * plugin's own boilerplate, which names nothing and would otherwise label every
 * such conversation identically. The fallback is read out of the log, never
 * invented — an unnamed conversation shows its own words or nothing at all.
 */
export declare function sessionDisplayName(events: readonly unknown[]): string;
