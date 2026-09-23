# assets

Screenshots referenced by the two READMEs. Kept in the repository only — `assets` is deliberately
**not** in `package.json` `files`, so screenshots never ship inside the npm tarball. The READMEs link
them with absolute URLs, which is why they also render on npm:

```
https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/<file>
```

## Naming

`NNN-kebab-name.png` — three-digit order, lowercase, hyphenated (same convention as
`dsh-baize-rules`). The order is only for browsing; the READMEs reference names, not numbers.

## What each file is for

| File | Where it appears | What the shot should show |
|---|---|---|
| `001-tidy-panel.png` | Both READMEs, right after the opening bullets (the main image) | The **整理** tab as a whole: target-workspace dropdown, target-conversation dropdown, the action bar with `Selected N items · ~N tokens [Clear] [Relocate]`, and the message table with its `USER` / `ASSISTANT` / `CONTEXT` / `TOOL` badges |
| `002-message-detail.png` | Both READMEs, in *The panel (整理 tab)* | A message row expanded — the full text below the row, the badge + `#seq` + character count header — next to a ticked checkbox, so the "click to read, tick to select" split is visible |
| `003-workspace-panel.png` | Both READMEs, in *Quick Start* → 工作区 | The **工作区** pane: the workspace path with the All / Active / Archived filter, the batch bar, and rows showing both badges (kind + state) next to the per-row buttons |
| `004-command.png` *(optional)* | Both READMEs, in *Commands* | `/baize-session` in the slash-command menu, with its description |

Add a row here and a matching `![…](…/assets/<file>)` line in **both** READMEs when you add a shot —
the English and Chinese files are kept in sync line for line.

## Adding a screenshot

1. Save it here with the name from the table above (if you use a different name, update the `src`
   in both READMEs to match — otherwise the image breaks).
2. PNG, cropped to the relevant panel. Screenshots of a real session are fine; check that no secrets,
   tokens or private paths are visible before committing.
3. Commit the image together with the README change, so no commit ever contains a link to a file that
   is not there yet.
