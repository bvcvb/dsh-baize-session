# Contributing

Thanks for improving `dsh-baize-session`!

## Before opening a pull request

Run the gates CI runs (`.github/workflows/ci.yml`):

```bash
pnpm build                  # tsc -p tsconfig.build.json → lib/
pnpm typecheck              # tsc --noEmit — CI fails on a type error, so run it locally
pnpm test                   # vitest run, then the client smoke test
pnpm check:exports          # every path promised by package.json `exports` really exists
node --check lib/client.js  # the client bundle is hand-authored and outside tsc
```

CI additionally asserts `git diff --exit-code -- lib` right after the build: the committed `lib/`
must be exactly what `src/` compiles to, so run `pnpm build` and commit the result.

## Two halves, two feedback loops

| Half | Source | To see a change |
|---|---|---|
| Host | `src/*.ts` → `lib/*.js` via `pnpm build` | build, then restart dsh |
| Browser | `lib/client.js`, hand-authored, no build step | reload the page |

`lib/client.js` writes the `window.__ModuleLoader__.load({ id, factory })` shell itself, so nothing
type-checks it — `test/client.smoke.mjs` is its safety net, and it is expected to grow whenever the UI
does. Narrower loops: `pnpm test:client`, `pnpm test:watch`.

## The destructive paths have their own rule

`deleteSession` and `moveSession` rewrite durable state on disk. Changes to either must be exercised
against **purpose-built test conversations in an isolated dsh instance** (a throwaway profile, or a
separate `DSH_HOME`) — never against a conversation anyone cares about. A move is not considered
verified until, after moving, a message written to the moved conversation is confirmed to land at the
**new** path, and the instance still boots (dsh refuses to start when a session's location disagrees
with its stored `cwd`).

## Scope

This plugin deliberately overlaps `dsh-session-manager` on archive / restore / delete / relocate. Its
own contribution is having those next to the relocation pane, in one place, with the conversation's
kind and state shown explicitly. Changes that duplicate more of that plugin (presets, batch cleanup,
import/export) need a reason that is not "it would be convenient".
