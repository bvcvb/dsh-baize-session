/**
 * Relocation runtime — owns the per-session basket and every write this plugin
 * performs. Both the `/baize-session` command and the panel HTTP API drive this,
 * so the two surfaces can never disagree.
 *
 * The panel's shape is: pick a target workspace → pick the target conversation
 * (an existing session in that workspace, or a brand-new one) → pick which
 * messages to carry over, always from the conversation you are already in.
 * Everything below serves that order.
 *
 * Naming: DSH calls a directory-backed group of sessions a *workspace*
 * (`ctx.workspaceRegistry`). This module's `ProjectRef` / `projects` are that
 * same thing under an older name — user-facing text always says 工作区 /
 * "workspace".
 *
 * @module dsh-baize-session/relocate
 */
import type { Context } from '@deepseek-ai/cordis';
import { type CollectedItem, type MessageRef } from './core.ts';
/** Config subset the runtime needs (structural, so both callers pass their own). */
export interface RelocationOptions {
    readonly maxInjectTokens: number;
    readonly listLimit?: number;
}
/**
 * One workspace the user can relocate into.
 *
 * A workspace is DSH's own term (`ctx.workspaceRegistry`); the field name here
 * predates the rename and stays for wire compatibility. Only user-facing text
 * uses 工作区 / "workspace".
 */
export interface ProjectRef {
    readonly path: string;
    readonly sessions: number;
    readonly isCurrent: boolean;
    /**
     * No registry record owns this directory — the sidebar's "未分组 / Ungrouped"
     * bucket. Set for a directory whose sessions outlived the workspace that used
     * to group them, and for the current directory when the registry has no
     * record of it yet.
     */
    readonly ungrouped?: boolean;
}
/** One conversation, live in memory or read back from storage. */
export interface SessionRef {
    readonly id: string;
    readonly cwd: string;
    /** Message count; a stored session is read back, so this is its real count. */
    readonly messages: number;
    /** Live sessions can be appended to; cold ones must be opened first. */
    readonly live: boolean;
    readonly isCurrent: boolean;
    /**
     * What to show in a picker: the logged `session/title`, else the opening line.
     * Empty only for a stored conversation with no messages at all.
     */
    readonly name: string;
    /** Header creation time (epoch ms), used to tell same-named sessions apart. */
    readonly createdAt: number;
    /**
     * No turn has run yet — the official `blank` bit. The sidebar renders such a
     * session as the workspace's provisional "New Session" row, never as a named
     * conversation, so the picker must not offer them as targets either.
     */
    readonly blank: boolean;
    /** In the registry-global archive set: hidden from the sidebar. */
    readonly archived: boolean;
}
/** What the panel needs for one round trip. */
export interface PanelState {
    readonly sessionId: string;
    readonly cwd: string;
    /** Messages of the session named by `sessionId` (the content source). */
    readonly messages: readonly MessageRef[];
    readonly basket: readonly CollectedItem[];
    readonly projects: readonly ProjectRef[];
    readonly sessions: readonly SessionRef[];
    readonly maxInjectTokens: number;
}
/** Where the relocation should land. */
export type RelocateTarget = {
    readonly kind: 'new';
    readonly cwd: string;
} | {
    readonly kind: 'existing';
    readonly sessionId: string;
};
export interface RelocateResult {
    /** The session that received the content (newly created, or the chosen one). */
    readonly sessionId: string;
    readonly tokens: number;
    readonly sources: number;
    readonly mode: 'new' | 'existing';
}
/** Minimal shape of a live Session this runtime relies on. */
interface SessionLike {
    readonly id: string;
    readonly header?: {
        readonly cwd?: string;
        readonly createdAt?: number;
    };
    readonly events?: readonly unknown[];
    /** Third arg is the SurfaceIntent marker surface-eligible events require. */
    append(type: string, data: unknown, intent?: unknown): unknown;
}
/** Refusals we want surfaced verbatim to the caller. */
export declare class RelocationError extends Error {
}
export interface RelocationRuntime {
    basketOf(sessionId: string): readonly CollectedItem[];
    session(sessionId: string): SessionLike | undefined;
    /** Every conversation this harness knows about: live ones plus stored ones. */
    sessions(signal?: AbortSignal): Promise<readonly SessionRef[]>;
    panelState(sessionId: string, signal?: AbortSignal): Promise<PanelState>;
    /** Collect by seq and/or message id, optionally out of another session. */
    take(sessionId: string, refs: {
        seqs?: readonly number[];
        messageIds?: readonly string[];
        sourceId?: string;
    }): Promise<{
        added: number;
        missing: string[];
    }>;
    untake(sessionId: string, ref: {
        seq?: number;
        messageId?: string;
        sourceId?: string;
    }): number;
    drop(sessionId: string): void;
    estimate(sessionId: string, target: RelocateTarget): number;
    relocate(sessionId: string, target: RelocateTarget): Promise<RelocateResult>;
}
/** Refuse a relative target before touching the store (`prepare` would throw). */
export declare function assertAbsolutePath(path: string): void;
/** Create the shared relocation runtime for one plugin instance. */
export declare function createRelocation(ctx: Context, options: RelocationOptions): RelocationRuntime;
export {};
