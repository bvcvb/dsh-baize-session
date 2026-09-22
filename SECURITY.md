# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ current supported line |

Security fixes are made on the 0.1.x line and published to npm.

## What this plugin can do to your machine

It is worth being explicit, because the 工作区 pane reaches further than the rest of the plugin:

- **It deletes conversation logs.** `deleteSession` removes a session's directory under
  `$DSH_HOME/sessions/` for good — no trash, no undo. It is gated (only archived conversations, and
  the request must carry `confirm: true`), but the gate is a guard-rail, not a backup.
- **It rewrites conversation artifacts.** `moveSession` rewrites the header line of a session's
  `session.jsonl.zstd` (its `cwd`) and relocates the file. It works through a temp file plus atomic
  renames and restores the original bytes if a later step fails, but it is still a write to durable
  data that no other process is coordinating with.
- **It changes the workspace registry** (`$DSH_HOME/storages/workspace.json`): archiving, restoring and
  moving all commit there.
- **It reads** session logs, including closed ones (`persistence.inspect`, which neither commits
  recovery nor publishes). It never sends session content anywhere — the only network calls this plugin
  makes are the ones the panel already makes to its own host (`/baize-session.api`).
- **It holds no credentials** and writes no files of its own.

## Reporting a vulnerability

Do **not** open a public issue for a security problem. Please open a
[private security advisory](https://github.com/bvcvb/dsh-baize-session/security/advisories/new)
or contact the maintainer directly.

Please include what you need to make the report actionable: affected version, the configuration in play
(`Config.maxInjectTokens` / `listLimit`), steps to reproduce, and the impact you see. Never include live
credentials or tokens in a report, and redact session content down to what demonstrates the issue.

We aim to acknowledge a report within **3 business days**, and to follow up with an initial assessment
(affected versions, whether a fix is planned) after that. Fixes ship as a patch release on the supported
line.
