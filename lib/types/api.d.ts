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
import type { Context } from '@deepseek-ai/cordis';
import { type RelocationRuntime } from './relocate.ts';
/** Register the panel API on the host web server. */
export declare function registerSessionApi(ctx: Context, runtime: RelocationRuntime): () => void;
