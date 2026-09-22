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
import z from '@deepseek-ai/schemastery';
import { formatBasket } from "./core.js";
import { createRelocation, RelocationError } from "./relocate.js";
import { registerSessionApi } from "./api.js";
/** Cordis plugin name used by loader diagnostics and the injected message source. */
export const name = 'baize-session';
/**
 * Services required before `apply` runs.
 *
 * `workspaceRegistry` is intentionally absent: cordis parks a plugin in
 * `pending (waiting for service: …)` when a declared service is not resolvable
 * in its scope, and one pending entry aborts the whole boot — every plugin
 * after it stays unloaded. The registry is reached with `ctx.get` instead
 * (see `relocate.ts`), so a host without it merely loses the sidebar refresh.
 */
export const inject = ['commands', 'sessions', 'tokenMeter', 'webServer', 'sessionPersistence'];
/** Schemastery validation for {@link Config}. */
export const Config = z.object({
    maxInjectTokens: z.number().required(),
    listLimit: z.number(),
});
const USAGE = '用法：/baize-session [info|take <seq…>|list|drop|to <绝对路径>|add <会话id>]';
/** The session id the command was invoked in. */
function invocationSessionId(invocation) {
    const session = invocation.agent?.session;
    const id = session?.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
}
/** Dispatch one `/baize-session` line. */
async function handle(runtime, invocation, config) {
    const sessionId = invocationSessionId(invocation);
    if (sessionId === undefined)
        return { kind: 'error', text: '当前没有会话，无法执行。' };
    const tokens = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
    const verb = tokens[0] ?? 'info';
    const args = tokens.slice(1);
    try {
        switch (verb) {
            case 'info':
            case 'status': {
                const state = await runtime.panelState(sessionId);
                const recent = state.messages.slice(-(config.listLimit ?? 15));
                const lines = [
                    `会话 ${state.sessionId}`,
                    `工作区 ${state.cwd || '(未知)'}`,
                    `消息 ${state.messages.length} 条 · 篮子已选 ${state.basket.length} 段 · 已知会话 ${state.sessions.length} 个`,
                    '',
                    `最近 ${recent.length} 条消息（用 /baize-session take <seq> 收集）：`,
                ];
                for (const message of recent)
                    lines.push(`  [${message.seq}] ${message.role}: ${message.preview}`);
                if (recent.length === 0)
                    lines.push('  （本会话还没有可收集的消息）');
                return { kind: 'success', text: lines.join('\n') };
            }
            case 'take': {
                const seqs = args.map(Number).filter(n => Number.isSafeInteger(n));
                const { added, missing } = await runtime.take(sessionId, { seqs });
                const lines = [`已收集 ${added} 段。`];
                if (missing.length > 0)
                    lines.push(`未找到或不可收集：${missing.join('、')}`);
                lines.push('', formatBasket(runtime.basketOf(sessionId)));
                return { kind: 'success', text: lines.join('\n') };
            }
            case 'list': {
                const known = await runtime.sessions();
                // Same visibility rule as the picker and the sidebar: blank sessions
                // (no turn yet) and archived ones are not real conversation targets.
                const all = known.filter(ref => !ref.blank && !ref.archived);
                const hidden = known.length - all.length;
                if (all.length === 0) {
                    return {
                        kind: 'success',
                        text: hidden === 0
                            ? '当前没有已知会话。'
                            : `没有可作为目标的真实会话（另有 ${hidden} 个空会话/已归档会话已隐藏）。`,
                    };
                }
                const byProject = new Map();
                for (const ref of all) {
                    const bucket = byProject.get(ref.cwd || '(未知)');
                    if (bucket === undefined)
                        byProject.set(ref.cwd || '(未知)', [ref]);
                    else
                        bucket.push(ref);
                }
                const lines = [`已知会话 ${all.length} 个，分布在 ${byProject.size} 个工作区：`];
                for (const [cwd, items] of byProject) {
                    lines.push(`\n${cwd}`);
                    for (const item of items) {
                        // Name first: sessions are identified by their logged title, which
                        // is also what the picker shows; the id stays for `/baize-session add`.
                        lines.push(`  ${item.name || '(无标题)'}  ${item.id}`
                            + `  消息 ${item.messages}${item.live ? '' : '  (未打开)'}${item.isCurrent ? '  ← 当前' : ''}`);
                    }
                }
                if (hidden > 0)
                    lines.push('', `（另有 ${hidden} 个空会话/已归档会话未列出）`);
                return { kind: 'success', text: lines.join('\n') };
            }
            case 'drop':
            case 'clear':
                runtime.drop(sessionId);
                return { kind: 'success', text: '篮子已清空。' };
            case 'to':
            case 'move': {
                const cwd = args[0];
                if (cwd === undefined)
                    return { kind: 'error', text: `请给出目标工作区的绝对路径。\n${USAGE}` };
                const result = await runtime.relocate(sessionId, { kind: 'new', cwd });
                return {
                    kind: 'success',
                    text: [
                        `已新建会话 ${result.sessionId}（工作区 ${cwd}）`,
                        `注入 ${runtime.basketOf(sessionId).length} 段（来自 ${result.sources} 个会话）· 约 ${result.tokens} tokens`,
                        '',
                        '去侧边栏打开这个新会话即可继续。',
                    ].join('\n'),
                };
            }
            case 'add':
            case 'append': {
                const id = args[0];
                if (id === undefined)
                    return { kind: 'error', text: `请给出目标会话 id（用 list 查看）。\n${USAGE}` };
                const result = await runtime.relocate(sessionId, { kind: 'existing', sessionId: id });
                return {
                    kind: 'success',
                    text: [
                        `已追加到会话 ${result.sessionId}`,
                        `注入 ${runtime.basketOf(sessionId).length} 段（来自 ${result.sources} 个会话）· 约 ${result.tokens} tokens`,
                    ].join('\n'),
                };
            }
            default:
                return { kind: 'error', text: `未知子命令 ${verb}。\n${USAGE}` };
        }
    }
    catch (e) {
        if (e instanceof RelocationError)
            return { kind: 'error', text: e.message };
        throw e;
    }
}
/**
 * Register the relocation runtime, the panel API and the `/baize-session` command.
 * @param ctx - plugin context; everything disposes with it.
 * @param config - injection budget and listing policy.
 */
export function apply(ctx, config) {
    const runtime = createRelocation(ctx, {
        maxInjectTokens: config.maxInjectTokens,
        listLimit: config.listLimit,
    });
    ctx.effect(function* () {
        yield ctx.commands.register({
            name: 'baize-session',
            description: '跨会话收集消息，汇聚到目标会话（白泽 · 会话整理）',
            input: { hint: 'info | take <seq…> | list | drop | to <绝对路径> | add <会话id>' },
            handler: invocation => handle(runtime, invocation, config),
        });
    }, 'baize-session lifecycle');
    // Panel API — the browser half reads and writes everything through this.
    ctx.effect(() => registerSessionApi(ctx, runtime), 'baize-session api');
}
