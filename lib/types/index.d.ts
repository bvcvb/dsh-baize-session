/**
 * Baize · session — carry chosen messages out of any conversation and into the
 * conversation you are headed to (an existing one, or a brand-new one).
 *
 * Named for 白泽 (Baize), the beast that knows all things. Where
 * `dsh-baize-rules` injects *requirements*, this plugin relocates *context*: the
 * user picks a target project, picks the target conversation, then picks which
 * messages to bring — and the plugin renders them into one `user/message`.
 *
 * Why not replay events: the session store validates that a seed is "contiguous
 * from 0" (`dsh-session/lib/index.js:1381`), so an arbitrary selection cannot be
 * replayed as events. Rewriting the selection as text is the only faithful
 * route — and it is what the user asked for ("其实就是对整个提示词的修改").
 *
 * The panel (browser half) is the primary surface; `/baize-session` exists so
 * the same operations stay reachable from the keyboard, and both drive the one
 * {@link createRelocation} runtime.
 *
 * @module dsh-baize-session
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics and the injected message source. */
export declare const name = "baize-session";
/**
 * Services required before `apply` runs.
 *
 * `workspaceRegistry` is intentionally absent: cordis parks a plugin in
 * `pending (waiting for service: …)` when a declared service is not resolvable
 * in its scope, and one pending entry aborts the whole boot — every plugin
 * after it stays unloaded. The registry is reached with `ctx.get` instead
 * (see `relocate.ts`), so a host without it merely loses the sidebar refresh.
 */
export declare const inject: string[];
/** Policy for the session plugin. Invalid values fail plugin load. */
export interface Config {
    /** Refuse to inject a render estimated above this many tokens. */
    maxInjectTokens: number;
    /** How many recent messages `/baize-session info` lists. */
    listLimit?: number;
}
/** Schemastery validation for {@link Config}. */
export declare const Config: z<Config>;
/**
 * Register the relocation runtime, the panel API and the `/baize-session` command.
 * @param ctx - plugin context; everything disposes with it.
 * @param config - injection budget and listing policy.
 */
export declare function apply(ctx: Context, config: Config): void;
