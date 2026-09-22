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
/** Flatten one message content array (or a plain string) into text. */
function contentToText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') {
            parts.push(block);
            continue;
        }
        if (typeof block !== 'object' || block === null)
            continue;
        const record = block;
        if (record.type === 'text' && typeof record.text === 'string') {
            parts.push(record.text);
            continue;
        }
        // A tool result carries its text one level deeper, inside the block:
        // `{type: 'tool-result', toolCallId, content: [{type: 'text', text}]}`.
        if (record.type === 'tool-result') {
            const inner = contentToText(record.content);
            if (inner.length > 0)
                parts.push(inner);
        }
        // Reasoning blocks are deliberately skipped: they are not conversation.
    }
    return parts.join('\n').trim();
}
/**
 * Normalize the surface message event shapes.
 *
 * They are NOT the same, and getting this wrong silently loses every assistant
 * reply (the log then looks like a user-only conversation):
 *
 * - `user/message`      `{ content, source, role, id }`
 * - `assistant/message` `{ turn, step, message: { content, source, role, id }, usage }`
 * - `tool/result`       `{ turn, step, message: { source, content }, error? }`
 *
 * Mirrors the official client projection, which reads
 * `event.data.message.id` for assistant and `event.data.id` for user
 * (`dsh-client-ui-conversation/lib/client.js:7711,8626`).
 */
function messagePayload(event) {
    if (typeof event !== 'object' || event === null)
        return null;
    const data = event.data;
    if (typeof data !== 'object' || data === null)
        return null;
    const record = data;
    const nested = record.message;
    const inner = (typeof nested === 'object' && nested !== null ? nested : record);
    const rawId = inner.id ?? record.id ?? inner.messageId ?? record.messageId;
    const content = inner.content ?? record.content;
    const rawSource = inner.source ?? record.source;
    const source = typeof rawSource === 'object' && rawSource !== null
        ? rawSource
        : undefined;
    return { content, id: typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined, source };
}
/**
 * Read one event as a collectable message, or null when it is not one.
 *
 * Collectable = the three surface message types. Tool *calls* (`tool/call`),
 * reasoning chunks and compaction internals stay out of scope by design (see
 * the spec's §2) — a `tool/result` is the tool's answer and does count.
 */
export function readMessageEvent(event) {
    if (typeof event !== 'object' || event === null)
        return null;
    const record = event;
    const type = record.type;
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result')
        return null;
    const payload = messagePayload(event);
    if (payload === null)
        return null;
    const text = contentToText(payload.content);
    if (text.length === 0)
        return null;
    return { role: roleOfEvent(type, payload.source), text };
}
/**
 * Classify one surface event by author.
 *
 * Classification reads `data.source.kind`, never the event type alone: DSH logs
 * human prompts, harness reminders and plugin injections all as
 * `user/message` (see {@link MessageRole}).
 */
function roleOfEvent(type, source) {
    if (type === 'assistant/message')
        return 'assistant';
    if (type === 'tool/result')
        return 'tool';
    const kind = source?.kind;
    if (kind === 'user')
        return 'user';
    if (kind === 'tool')
        return 'tool';
    return 'context';
}
/**
 * The message identity an event carries, when it has one.
 *
 * The `conversation.chat.assistant-actions` seat hands a component a
 * `messageId` and nothing else, so the panel collects by id and the host maps
 * it back to a seq through this accessor — so this must return exactly the id
 * the client's projection calls `messageId` (see {@link messagePayload}).
 */
export function messageIdOf(event) {
    return messagePayload(event)?.id;
}
/** Every collectable message in a session log, in log order. */
export function listMessages(events) {
    const out = [];
    for (const event of events) {
        const read = readMessageEvent(event);
        if (read === null)
            continue;
        const seq = event.seq;
        if (typeof seq !== 'number')
            continue;
        const firstLine = read.text.split('\n')[0] ?? '';
        out.push({
            seq,
            role: read.role,
            text: read.text,
            preview: firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine,
        });
    }
    return out;
}
/** Group collected items by source session, preserving collection order. */
function groupBySource(items) {
    const groups = new Map();
    for (const item of items) {
        const group = groups.get(item.sessionId);
        if (group === undefined)
            groups.set(item.sessionId, { sessionId: item.sessionId, cwd: item.cwd, items: [item] });
        else
            group.items.push(item);
    }
    return [...groups.values()];
}
/**
 * First line of the block this plugin injects into a target session.
 *
 * Exported because it is also a marker: a conversation whose opening message is
 * this block is a relocation *landing site*, not a conversation with its own
 * subject, so the picker must not present that boilerplate as its name.
 */
export const INJECTION_HEADER = '以下是本会话开始前，我（用户）从其它会话整理过来的上下文，供你参考：';
/**
 * Render the collected messages as the text injected into the target session.
 *
 * The trailing "current workspace is …" line is the whole reason this plugin
 * rewrites content instead of replaying events: it tells the model that the
 * quoted history comes from other directories, without any path rewriting.
 * The wording follows DSH's own term for a directory-backed group of sessions
 * (a *workspace*), which is also what the panel calls it.
 */
export function renderInjection(items, targetCwd) {
    const blocks = [INJECTION_HEADER, ''];
    for (const group of groupBySource(items)) {
        blocks.push(`【来自会话 ${group.sessionId.slice(0, 8)} / 工作区 ${group.cwd || '(未知)'}】`);
        for (const item of group.items)
            blocks.push(`${item.role}: ${item.text}`);
        blocks.push('');
    }
    blocks.push('---');
    blocks.push(`当前工作区是 ${targetCwd}。请在此基础上继续。`);
    return blocks.join('\n');
}
/** Rough character budget guard used before the token estimate is available. */
export function totalChars(items) {
    return items.reduce((n, item) => n + item.text.length, 0);
}
/** Compact listing of the basket, one line per item. */
export function formatBasket(items) {
    if (items.length === 0)
        return '篮子为空。';
    const lines = items.map((item, i) => `${i + 1}. [${item.seq}] ${item.role}: ${item.text.split('\n')[0]?.slice(0, 50) ?? ''}`);
    const sources = new Set(items.map(item => item.sessionId)).size;
    return [`篮子：${items.length} 段（来自 ${sources} 个会话）`, ...lines].join('\n');
}
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
export function loggedSessionTitle(events) {
    let title;
    for (const event of events) {
        if (typeof event !== 'object' || event === null)
            continue;
        const record = event;
        if (record.type !== 'session/title')
            continue;
        const data = record.data;
        const value = data?.title;
        if (typeof value === 'string' && value.trim().length > 0)
            title = value.trim();
    }
    return title;
}
/** How much of a conversation's opening line is used when it has no name yet. */
const NAME_FROM_MESSAGE_CHARS = 24;
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
export function sessionDisplayName(events) {
    const titled = loggedSessionTitle(events);
    if (titled !== undefined)
        return titled;
    const first = listMessages(events).find(message => !message.text.startsWith(INJECTION_HEADER));
    if (first === undefined)
        return '';
    const line = first.preview;
    return line.length > NAME_FROM_MESSAGE_CHARS ? `${line.slice(0, NAME_FROM_MESSAGE_CHARS)}…` : line;
}
