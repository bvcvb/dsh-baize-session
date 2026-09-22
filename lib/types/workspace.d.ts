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
import type { Context } from '@deepseek-ai/cordis';
import type { SessionRef } from './relocate.ts';
/** A refusal the user can act on; the API layer answers it with HTTP 400. */
export declare class WorkspaceError extends Error {
}
/** One workspace as the panel's destination picker needs it. */
export interface WorkspaceOption {
    readonly id: string;
    readonly path: string;
    readonly title: string;
}
/** One conversation row in the 工作区 tab. */
export interface ManagedSession extends SessionRef {
    /** An agent is attached right now (a turn may be running). */
    readonly running: boolean;
    /** A subagent child — the sidebar hides these and moves refuse them. */
    readonly subagent: boolean;
    /** True for the conversation the panel itself is open in. */
    readonly isPanel: boolean;
}
/** Everything the 工作区 tab renders in one round trip. */
export interface WorkspacePanel {
    /** The workspace the panel's own conversation belongs to, when known. */
    readonly workspace?: WorkspaceOption;
    /** Every workspace, for the "move to…" picker. */
    readonly workspaces: readonly WorkspaceOption[];
    /** That workspace's conversations in ledger order, archived ones included. */
    readonly sessions: readonly ManagedSession[];
}
export interface WorkspaceAdmin {
    panel(sessionId: string): Promise<WorkspacePanel>;
    archive(targetId: string): Promise<void>;
    restore(targetId: string): Promise<void>;
    /** Irreversible. Only an archived conversation may be deleted. */
    remove(targetId: string): Promise<{
        readonly dir?: string;
    }>;
    move(targetId: string, toWorkspaceId: string): Promise<{
        readonly from: string;
        readonly to: string;
    }>;
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
export declare function encodeArtifact(headerLine: string, rest: string, zstd: boolean): Buffer;
/**
 * Replace the header line of a raw session artifact, keeping everything else.
 * @param raw - the artifact text as the backend decoded it.
 * @param cwd - the workspace path the conversation is moving to.
 * @returns the new header line plus the untouched remainder.
 */
export declare function rewriteHeaderCwd(raw: string, cwd: string): {
    headerLine: string;
    header: Record<string, unknown>;
    rest: string;
};
/** Create the workspace-administration runtime for one plugin instance. */
export declare function createWorkspaceAdmin(ctx: Context, deps: {
    sessions(): Promise<readonly SessionRef[]>;
}): WorkspaceAdmin;
