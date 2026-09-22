# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.1.0] - 2026-09-22

First release. Two panes in one conversation tab: move context between conversations, and manage
the conversations of a workspace.

### Added

- **整理 pane — relocate context.** Pick messages out of the conversation you are in and carry them
  into another conversation: an existing one, or a brand-new one in any workspace. The selection is
  rendered as one `user/message` (`source.kind='plugin'`, `plugin='baize-session'`) rather than
  replayed as events, because the session store requires a seed to be contiguous from seq 0 and an
  arbitrary selection is not a valid prefix. The block ends with `当前工作区是 <path>。请在此基础上继续。`
  so the receiving model knows the quoted history came from other directories.
- **`＋` on every assistant reply** (`conversation.chat.assistant-actions`) to collect material without
  leaving the chat flow. The basket is keyed per conversation.
- **Two destinations**: a new conversation (created with the content as its seed — a seed because dsh
  persists on checkpoints, so an `append` into a fresh session never reaches disk), or an append into
  a conversation that is open.
- **工作区 pane — workspace management.** Lists every conversation of the current workspace, archived
  ones included, with `All / Active / Archived` filters and counts.
  - **Archive** and **restore** any conversation. Restore is implemented against the registry's
    durable state (dsh ships `archiveSession` but no inverse).
  - **Delete for real**: agent teardown, live-store detach (so every client drops the row), removal
    from the workspace ledger and the archive set, then the artifact directory. Gated twice — only an
    **archived** conversation can be deleted, and the request must carry `confirm: true`.
  - **Move to another workspace**: rewrites the artifact's header `cwd` (keeping `version`) through a
    temp file and atomic renames, then swaps the ledger, then updates the in-memory pointers (live
    write state, session header, registry indexes) — with the original bytes restored if any step
    fails. Works for conversations that are **still open**, including ones with an agent attached.
    Refused for archived conversations and subagent children.
  - **Multi-select** with a batch bar for the same four actions, reported per id so one refusal does
    not abort the rest.
- **Conversation kind and state as two independent columns**: kind `空对话 / 已对话 / 子代理` (has a
  conversation started?) and state `进行中 / 已打开 / 未打开 / 已归档` (where does it live now?). They are
  separate because an empty conversation can be in progress — an agent is attached from creation,
  before the first prompt.
- **Author badges on message rows**: `user` / `assistant` / `context` / `tool`, coloured from the
  official Trajectory view's kind tags. `context` is separated from `user` because dsh logs human
  prompts and harness injections under the same `user/message` event type (a sampled session was
  `{user: 4, plugin: 10}`).
- **`/baize-session` command** — `info | take <seq…> | list | drop | to <path> | add <id>`, driving the
  same runtimes as the panel.
- **`/baize-session.api`** on the host web server: `GET` for both panes, `POST` ops `take`, `untake`,
  `drop`, `estimate`, `relocate`, `archive`, `restore`, `deleteSession`, `moveSession`.
- **Token budget** (`maxInjectTokens`, default 8000): a selection above the budget is refused with the
  measured size instead of being silently truncated.

### Notes

- The plugin keeps no state of its own: the basket is in-memory, and everything it touches
  (session artifacts, the workspace registry) belongs to dsh.
- The browser half is hand-authored (`lib/client.js`) because the official `clientBundle` tsdown preset
  is not published; it is covered by `test/client.smoke.mjs`, which renders the real bundle and asserts
  both panes' behaviour.
