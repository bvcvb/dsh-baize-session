/**
 * Host HTTP API for the relocation panel. The browser half has no way to read a
 * session, list conversations, or create one, so every UI action goes through
 * here; this delegates to the same {@link RelocationRuntime} the
 * `/baize-session` command drives, so the panel and the command can never
 * disagree.
 *
 * Routes (json):
 *   GET  /baize-session.api?sessionId=…[&source=<sessionId>]   -> PanelState
 *        (`source` reads another conversation's messages into the same payload,
 *         which is what lets the panel browse any session for content.)
 *   POST /baize-session.api { sessionId, op, … }
 *        op: 'take'     { seqs?, messageIds?, sourceId? }  -> { state }
 *        op: 'untake'   { seq?, messageId?, sourceId? }    -> { state }
 *        op: 'drop'                                        -> { state }
 *        op: 'estimate' { target }                         -> { tokens }
 *        op: 'relocate' { target }                         -> { sessionId, mode, … }
 *
 *   target = { kind: 'new', cwd } | { kind: 'existing', sessionId }
 *
 * @module dsh-baize-session/api
 */
import { RelocationError } from "./relocate.js";
function sendJson(res, status, payload) {
    const r = res;
    r.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    r.end(JSON.stringify(payload));
}
function readBody(req) {
    return new Promise((resolve) => {
        const r = req;
        let body = '';
        r.on('data', (chunk) => { body += chunk; });
        r.on('end', () => resolve(body));
        r.on('error', () => resolve(''));
    });
}
/** Parse the request body; undefined means it was not a JSON object. */
function parseBody(text) {
    try {
        const parsed = JSON.parse(text || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** Read the target out of a request body, rejecting anything malformed. */
function targetOf(body) {
    const raw = body.target;
    if (typeof raw !== 'object' || raw === null)
        throw new RelocationError('缺少 target。');
    const target = raw;
    if (target.kind === 'existing') {
        const sessionId = String(target.sessionId ?? '');
        if (sessionId.length === 0)
            throw new RelocationError('target.sessionId 不能为空。');
        return { kind: 'existing', sessionId };
    }
    return { kind: 'new', cwd: String(target.cwd ?? '') };
}
/** Register the panel API on the host web server. */
export function registerSessionApi(ctx, runtime) {
    if (ctx.webServer === undefined)
        return () => { };
    return ctx.webServer.register({
        kind: 'exact',
        path: '/baize-session.api',
        handler: async (req, res) => {
            const method = req.method ?? '';
            const url = req.url ?? '';
            const query = new URLSearchParams(url.split('?')[1] ?? '');
            if (method === 'GET') {
                const sessionId = query.get('sessionId') ?? '';
                if (sessionId.length === 0) {
                    sendJson(res, 400, { error: 'sessionId required' });
                    return;
                }
                // `source` switches which conversation the message list is read from.
                const sourceId = query.get('source') ?? sessionId;
                try {
                    const state = await runtime.panelState(sessionId);
                    sendJson(res, 200, sourceId === sessionId
                        ? state
                        : { ...state, sourceId, messages: await runtime.panelState(sourceId).then(s => s.messages) });
                }
                catch (e) {
                    sendJson(res, 500, { error: String(e) });
                }
                return;
            }
            if (method === 'POST') {
                const body = parseBody(await readBody(req));
                if (body === undefined) {
                    sendJson(res, 400, { error: 'invalid JSON body' });
                    return;
                }
                const sessionId = String(body.sessionId ?? '');
                if (sessionId.length === 0) {
                    sendJson(res, 400, { error: 'sessionId required' });
                    return;
                }
                const op = String(body.op ?? '');
                try {
                    switch (op) {
                        case 'take': {
                            const seqs = Array.isArray(body.seqs) ? body.seqs.map(Number) : [];
                            const messageIds = Array.isArray(body.messageIds) ? body.messageIds.map(String) : [];
                            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : undefined;
                            const { added, missing } = await runtime.take(sessionId, { seqs, messageIds, sourceId });
                            sendJson(res, 200, { ok: true, added, missing, state: await runtime.panelState(sessionId) });
                            return;
                        }
                        case 'untake': {
                            const removed = runtime.untake(sessionId, {
                                seq: Number.isSafeInteger(Number(body.seq)) ? Number(body.seq) : undefined,
                                messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
                                sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
                            });
                            sendJson(res, 200, { ok: true, removed, state: await runtime.panelState(sessionId) });
                            return;
                        }
                        case 'drop': {
                            runtime.drop(sessionId);
                            sendJson(res, 200, { ok: true, state: await runtime.panelState(sessionId) });
                            return;
                        }
                        case 'estimate': {
                            sendJson(res, 200, { ok: true, tokens: runtime.estimate(sessionId, targetOf(body)) });
                            return;
                        }
                        case 'relocate': {
                            const result = await runtime.relocate(sessionId, targetOf(body));
                            sendJson(res, 200, { ok: true, ...result, state: await runtime.panelState(sessionId) });
                            return;
                        }
                        default:
                            sendJson(res, 400, { ok: false, text: `unknown op: ${op}` });
                            return;
                    }
                }
                catch (e) {
                    // Refusals (relative path, empty basket, cold target, over budget) are
                    // client-side problems and carry a message meant for the user.
                    if (e instanceof RelocationError) {
                        sendJson(res, 400, { ok: false, text: e.message });
                        return;
                    }
                    sendJson(res, 500, { error: String(e) });
                }
                return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
        },
    });
}
