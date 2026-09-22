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
 *   GET  /baize-session.api?sessionId=…&view=workspace        -> workspace panel
 *        (the 工作区 tab: its own conversation's workspace, every conversation in
 *         it including archived ones, and every workspace as a move target)
 *   POST /baize-session.api { sessionId, op, … }
 *        op: 'take'     { seqs?, messageIds?, sourceId? }  -> { state }
 *        op: 'untake'   { seq?, messageId?, sourceId? }    -> { state }
 *        op: 'drop'                                        -> { state }
 *        op: 'estimate' { target }                         -> { tokens }
 *        op: 'relocate' { target }                         -> { sessionId, mode, … }
 *        op: 'archive'  { targetId | targetIds }           -> { panel, results }
 *        op: 'restore'  { targetIds }                      -> { panel, results }
 *        op: 'deleteSession' { targetIds, confirm: true }  -> { panel, results }
 *        op: 'moveSession'   { targetIds, toWorkspaceId }  -> { panel, results }
 *
 *        `targetId` (one) and `targetIds` (many) are interchangeable; the
 *        multi-select in the 工作区 tab sends the array. Batch results are
 *        reported per id — `ok: false` on the envelope means every id failed,
 *        while a partial success still answers 200 with the failing ids listed.
 *
 *   target = { kind: 'new', cwd } | { kind: 'existing', sessionId }
 *
 *   Every workspace op answers with the refreshed panel, so the tab needs one
 *   round trip per action instead of two. `deleteSession` additionally requires
 *   `confirm: true` — an irreversible removal must not be one stray request away.
 *
 * @module dsh-baize-session/api
 */
import type { Context } from '@deepseek-ai/cordis';
import { type RelocationRuntime } from './relocate.ts';
import { type WorkspaceAdmin } from './workspace.ts';
/** Register the panel API on the host web server. */
export declare function registerSessionApi(ctx: Context, runtime: RelocationRuntime, admin: WorkspaceAdmin): () => void;
