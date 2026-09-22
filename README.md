# dsh-baize-session

**[English](README.md) | [简体中文](README.zh.md)**　—　中文说明见 [README.zh.md](README.zh.md)。

![npm version](https://img.shields.io/npm/v/dsh-baize-session)
![license](https://img.shields.io/npm/l/dsh-baize-session)

`dsh-baize-session` (Baize) is a [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that moves **context between conversations**: pick messages out of the conversation you are in, then carry them into another one — an existing conversation, or a brand-new one in a different workspace.

The name comes from **Baize (白泽)** — a mythical beast said to understand all things. Where [`dsh-baize-rules`](https://www.npmjs.com/package/dsh-baize-rules) injects *requirements*, this plugin relocates *context*.

- The picked messages are **rewritten as text** into a single `user/message` carrying `source.kind='plugin'`, `plugin='baize-session'` — not replayed as events. An arbitrary selection cannot be replayed: the session store validates that a seed is contiguous from seq 0, so a partial history is not a valid prefix.
- The injected block ends with `当前工作区是 <path>。请在此基础上继续。` — the model is told that the quoted history came from other directories, with no path rewriting anywhere.
- **No selection → nothing is written.** The plugin refuses an empty basket instead of injecting an empty frame.

![The 整理 (Tidy) tab in the dsh web UI — the target workspace and target conversation dropdowns, the action bar showing the selected count and token estimate, and the message table with its USER / ASSISTANT / CONTEXT / TOOL badges](https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/001-tidy-panel.png)

---

## Features

| Feature | Description |
|---|---|
| **Pick from the conversation you are in** | The 整理 tab lists this conversation's messages as a checkbox table. Click a row to read the full text, tick the checkbox to select it |
| **Collect from anywhere** | A `＋` button sits next to every assistant reply, so material can be grabbed without leaving the chat flow. The basket is keyed per conversation |
| **Two destinations** | **New conversation** in a chosen workspace (created with the content as its seed), or **append** to a conversation that is currently open |
| **Cross-workspace by construction** | A new conversation is created with the target workspace as its `cwd`, so it lands in that workspace's session directory — moving context between workspaces needs no path rewriting |
| **Named conversations, not ids** | The destination dropdown shows each conversation's own logged title (`session/title`), falling back to its opening line. The raw id lives in the tooltip |
| **Only real conversations are offered** | Conversations that never ran a turn (the sidebar's provisional "new conversation" rows) and archived ones are filtered out — the same rule the official sidebar uses (`sessionVisible`) |
| **Rows are labelled by author** | `user` / `assistant` / `context` / `tool`, with the colours of the official Trajectory view's kind tags. `context` matters: dsh logs human prompts and harness injections under the *same* `user/message` event type |
| **Token budget** | The rendered block is estimated before writing; a selection above `maxInjectTokens` is refused with the measured number instead of silently truncating |
| **One runtime, two surfaces** | The panel and the `/baize-session` command drive the same `RelocationRuntime`, so they can never disagree |
| **No files of its own** | The basket is in-memory only; every piece of durable state involved (sessions, workspaces, the archive set) belongs to dsh |

---

## Installation

> dsh plugins are distributed from npm and installed into a profile via `dsh plugin`.

```bash
# Install from npm into the web profile (use the actual published version)
dsh plugin --profile web add dsh-baize-session@0.1.0
pm2 restart dsh          # Reload when dsh is managed by pm2
dsh --profile web
```

Peer dependencies (`@deepseek-ai/*`) are provided by the dsh profile; if any are missing, pnpm resolves them against `peerDependencies` in the profile directory. The plugin declares `dsh.bundle` (mounts itself through `cordis.patch.yml`) and `dsh.client` (its browser half), which is what makes both halves load.

### Uninstall

```bash
dsh plugin --profile web remove dsh-baize-session
pm2 restart dsh          # Reload when dsh is managed by pm2
```

If the entry lingers in the profile's `dsh.profile.bundles`, delete that line from
`$DSH_HOME/profiles/web/package.json` and restart dsh again. Nothing else is left behind: this plugin
writes no data of its own (see [Data location](#data-location)).

### Try it without touching your running setup

Install into a **separate profile** so your currently running dsh stays unchanged:

```bash
dsh plugin --profile smoke add dsh-baize-session@0.1.0
dsh --profile smoke --dump-config   # compose the config only — does not boot dsh
```

### Local development (link)

If you haven't published yet, or want to pick up source changes live:

```jsonc
// $DSH_HOME/profiles/web/package.json
"dependencies": {
  "dsh-baize-session": "link:/home/abc/work/plugin/dsh-baize-session"
}
```

Then run `pnpm install` in the profile directory and add `dsh-baize-session` to `dsh.profile.bundles`.

---

## Quick Start

Open any conversation and click the **整理** tab next to the chat view.

```
① target workspace   [ /home/abc/work/plugin        ▾ ]
② target conversation[ New conversation             ▾ ]
─────────────────────────────────────────────────────────────
   Selected 0 items                        [ Clear ] [ Relocate ]
─────────────────────────────────────────────────────────────
   12  USER         the first line of the message…            ← click to read
   13  CONTEXT      Current runtime context. This snapshot…
   14  ASSISTANT    the first line of the reply…
```

1. Pick the workspace (the current one is preselected and listed first; the last entry lets you type an absolute path).
2. Pick the conversation — `New conversation`, or any real conversation in that workspace.
3. Tick the messages to carry over. Clicking a row shows its full text and does **not** select it.
4. Press **Relocate**.

The same operations are reachable from the keyboard:

```bash
/baize-session                     # Same as info: this conversation's id, workspace, message counts
/baize-session take 12 14          # Collect messages by seq (from this conversation)
/baize-session list                # Every real conversation, grouped by workspace
/baize-session to /home/abc/work/led   # Create a new conversation there, carrying the basket
/baize-session add session-1a2b…   # Or append into an open conversation
/baize-session drop                # Empty the basket
```

---

## Commands

| Subcommand | Syntax | Purpose |
|---|---|---|
| **info** | `/baize-session [info\|status]` | Show this conversation's id, workspace, message/basket counts, and the most recent `listLimit` messages with their seqs |
| **take** | `/baize-session take <seq…>` | Collect messages by seq out of the current conversation |
| **list** | `/baize-session list` | List the real conversations (blank and archived ones are counted in a trailing note, not listed), grouped by workspace, with names and ids |
| **drop** | `/baize-session [drop\|clear]` | Empty the basket |
| **to** | `/baize-session [to\|move] <absolute path>` | Create a new conversation in that workspace and write the basket into it as its opening context |
| **add** | `/baize-session [add\|append] <session id>` | Append the basket into an existing conversation — it must be open (in memory) |

---

## The panel (整理 tab)

The tab is registered on the `conversation.view` seat (id `baize-session-tidy`, order 40) — purely additive: no official component is replaced. The `＋` button is registered on `conversation.chat.assistant-actions` (id `baize-session-collect`, order 20).

| Interaction | Result |
|---|---|
| Click a message row | Expand/collapse that message's **full text** (the table itself only shows the first line) |
| Click a checkbox | Select/deselect that message; the detail stays as it is |
| Click the destination dropdown | A self-drawn popover (native `<select>` does not match the dsh theme); click outside or press Escape to close |
| Workspace dropdown last entry | `手填绝对路径…` reveals a text field for a workspace that is not registered yet |

Message rows are labelled by author:

| Badge | Meaning | Colour source (official Trajectory view) |
|---|---|---|
| `USER` | A human prompt (`source.kind === 'user'`) | `.user` — `state-business-primary` / `state-business-tertiary` |
| `ASSISTANT` | A model reply | `.assistantVioletBright` |
| `CONTEXT` | Injected by a plugin or the harness — runtime snapshots, `<system-reminder>`, memory injections, and this plugin's own relocation blocks | `.contextGreen` |
| `TOOL` | A tool result (`tool/result` events) | `.toolAmber` |

`user/message` is **not** a synonym for "the user said this": dsh stores human prompts and injected context under that one event type, separated only by `data.source.kind`. In a sampled real session the split was `{user: 4, plugin: 10}` — most of that conversation was never typed by anyone, which is exactly why the two are badged differently.

![A message row expanded: the full text sits below the row under a badge + #seq + character count, while the checkbox on the row is what selects it](https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/002-message-detail.png)

---

## What gets injected

One `user/message` per relocation, built with `createUserMessage()` and published with the surface marker `{ surfaceOp: 'append' }` that surface-eligible events require:

```text
以下是本会话开始前，我（用户）从其它会话整理过来的上下文，供你参考：

【来自会话 06094031 / 工作区 /home/abc/work/plugin】
user: where is the token budget enforced?
assistant: in relocate.ts, before the write — it throws instead of truncating.

---
当前工作区是 /home/abc/work/led。请在此基础上继续。
```

- Messages keep their **author label** (`user:` / `assistant:` / `context:` / `tool:`) so the receiving model can tell a question from an injection.
- Material is grouped by source conversation, preserving collection order.
- When the destination is an existing conversation, the block is appended as a normal message; when it is a new conversation, the very same message becomes the **seed** of that session. A seed is used because dsh persists on checkpoints: a brand-new session nobody has talked to never reaches disk through `append`.
- The new session is then attached to its workspace (`workspace.attachSession`), which is what makes it appear in the sidebar.

---

## What is and isn't listed

Targets are filtered with the same rule the official sidebar uses (`sessionVisible` in `dsh-client-ui-workspace`):

| Case | Behaviour | Why |
|---|---|---|
| A conversation that never ran a turn (`blank`) | **Not listed** | The sidebar renders those as the workspace's provisional "New conversation" row with a fixed label; its real title never shows. `New conversation` is that row's equivalent here |
| An archived conversation (registry-global archive set) | **Not listed** | Archiving is a global set dsh keeps in `$DSH_HOME/storages/workspace.json`; the sidebar hides members. Reading it is best-effort: if the set cannot be read, nothing is hidden |
| A conversation whose log cannot be read | Listed (conservatively treated as non-blank) | Matches the official rule: "unavailable or oversized artifacts conservatively report false" |
| A closed (not open) conversation as an **append** target | Refused: `目标会话不在内存中，无法追加（先在侧边栏打开它）。` | Appending needs the live session; open it from the sidebar first |
| A closed conversation as a **content source** | Allowed | Its log is read back with `persistence.inspect()` — a read that neither commits recovery nor publishes, so browsing cannot disturb it |
| A workspace with no real conversation | Still listed (with no count) | That is precisely the "create a new conversation here" case. The workspace list itself comes from `ctx.workspaceRegistry.list()`, never derived from session `cwd`s |
| A directory with real conversations but no workspace record | Listed and marked `未分组` | The sidebar puts such sessions in its "Ungrouped" bucket; without this the conversations would become unreachable from the picker |
| The conversation you are in | Not offered as a destination | Relocating into itself is not a meaningful target |

**One consequence worth knowing:** right after relocating into `New conversation`, that new conversation is itself `blank`, so it does not appear in the destination list yet. Open it from the sidebar and say something — dsh then generates its title and it becomes a normal target. That is the sidebar's behaviour too, not a limitation of this plugin.

---

## Configuration (`Config`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxInjectTokens` | `number`, **required** | `8000`, set by this package's `cordis.patch.yml` | Refuse to write a block estimated above this many tokens. The refusal names the measured size, so a too-large selection is visible rather than silently trimmed |
| `listLimit` | `number`, optional | `15`, in-code (the patch does not set it) | How many recent messages `/baize-session info` lists |

The shipped patch is exactly this — add `listLimit` to the same `config` block to override it:

```yaml
# cordis.patch.yml
- insert:
    - id: baize-session
      name: 'dsh-baize-session'
      config:
        maxInjectTokens: 8000
```

---

## HTTP API

The browser half has no way to read a session or create one, so the panel talks to
`/baize-session.api` on the host web server. It delegates to the same runtime the command uses.

| Request | Body / query | Returns |
|---|---|---|
| `GET /baize-session.api` | `?sessionId=<id>` (required), `&source=<id>` to list another conversation's messages | `PanelState`: `{ sessionId, cwd, messages, basket, projects, sessions, maxInjectTokens }` |
| `POST /baize-session.api` | `{ sessionId, op: 'take', seqs?, messageIds?, sourceId? }` | `{ ok, added, missing, state }` |
| | `{ sessionId, op: 'untake', seq?, messageId?, sourceId? }` | `{ ok, removed, state }` |
| | `{ sessionId, op: 'drop' }` | `{ ok, state }` |
| | `{ sessionId, op: 'estimate', target }` | `{ ok, tokens }` |
| | `{ sessionId, op: 'relocate', target }` | `{ ok, sessionId, mode, tokens, sources, state }` |

`target` is `{ kind: 'new', cwd }` or `{ kind: 'existing', sessionId }`. Refusals a user can act on
(relative path, empty basket, cold append target, over budget) come back as `400` with a message meant
to be shown verbatim; everything else is a `500`.

---

## Data location

**This plugin stores nothing of its own.** The basket lives in memory for the lifetime of the process, so it is empty after a restart — that is the intended scope of "selected for this move".

Everything it touches belongs to dsh:

| Path | What |
|---|---|
| `$DSH_HOME/sessions/<escaped-cwd>/<session-id>/session.jsonl.zstd` | The conversations themselves (multi-frame zstd), read back only for closed conversations |
| `$DSH_HOME/storages/workspace.json` | Workspace records and the registry-global archived-session set |

---

## Module structure

```
src/core.ts       Pure logic: event reading/role classification/user/assistant/context/tool, message listing, renderInjection, session naming
src/relocate.ts   The runtime: baskets, panel state, take/untake/drop/estimate/relocate, workspace + persistence access
src/api.ts        Host HTTP API: GET state + POST op dispatch on /baize-session.api
src/index.ts      apply: createRelocation + /baize-session command + API mount (inject: commands/sessions/tokenMeter/webServer/sessionPersistence)
lib/client.js     Browser half, HAND-AUTHORED: the 整理 tab + the ＋ seat, window.__ModuleLoader__.load({ id, factory })
test/core.spec.ts        Unit tests for the pure helpers (real logged event shapes as fixtures)
test/client.smoke.mjs    Renders the real client bundle with react-test-renderer and asserts its behaviour
cordis.patch.yml  Mount metadata (inserts the baize-session plugin line + default config)
```

**Public entry points** (see `package.json` `exports`): `.` (index), `./client`, `./src/*`, `./package.json`.

---

## Development & instant feedback

```bash
pnpm test            # vitest unit tests, then the client smoke test
pnpm test:client     # Just the client smoke test (node test/client.smoke.mjs)
pnpm test:watch      # Re-run unit tests on save
pnpm build           # tsc -p tsconfig.build.json → lib/
pnpm typecheck       # tsc --noEmit
```

| Half | Where | To see a change |
|---|---|---|
| Host (`src/*.ts`) | `lib/*.js` via `pnpm build` | Build, then **restart** dsh (the host loads `lib/`) |
| Browser (`lib/client.js`) | Hand-written, no build step | Just **reload the page** — the bundle is served from disk with a content-hash revision |

`lib/client.js` is hand-authored: the official `clientBundle` tsdown preset is not published, so a plugin
outside the dsh repository writes the `window.__ModuleLoader__.load({ id, factory })` shell itself and
keeps only the seed modules external (`react`, the ui-primitives). Nothing type-checks or bundles it, so
`test/client.smoke.mjs` loads the real bundle against `react-test-renderer` with a stubbed host API and
asserts the panel's layout, its interaction order, the role badges and its CSS rules.

---

## Publishing

```bash
# 1. Bump the version in package.json and the install example in both READMEs
# 2. Verify locally
pnpm build && pnpm typecheck && pnpm test
# 3. Commit, tag, push
git add -A && git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main && git push origin vX.Y.Z
# 4. Publish — the step that actually ships
npm publish --access public
```

> **Credentials.** `npm publish` authenticates with your own npm credentials (`~/.npmrc` or environment
> variables). Never commit a token, and never paste one into a README or a CI log.

---

## License

[MIT](./LICENSE)
