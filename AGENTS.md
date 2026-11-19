# Farrier — rules for this repository

Farrier is a Herdr add-on: one layout, the mods it uses, one theme, one
installer. Its parts install on their own; a layout only names the parts it
shows. It is not a fork of Herdr and never ships the Herdr binary.

## Names

| Thing | Name | Notes |
|---|---|---|
| Repository | `herdr-farrier` | the `herdr-` prefix is how Herdr add-ons are found on GitHub |
| Product, layout, mods | `farrier` | the repository name never appears inside it |
| More mods, if any | `farrier-<role>` | e.g. `farrier-git`, `farrier-dock` |
| Theme | `farrier-charcoal` | more: `farrier-<look>`; never a layout's name |
| Key sections | `layout:farrier`, `mod:farrier` | never `global` |
| Shared state | `farrier.<what>` | e.g. `farrier.dock`, `farrier.fold` |
| Commands | `farrier.<command>` | reaches this mod's `nextCommand()` |
| Terminal labels | `farrier.<role>=<id>` | never `herdr.*` |

Never use a name Herdr ships: `agents`, `changes`, `confirm`, `file-icons`,
`files`, `git-panel`, `help`, `machine-add`, `menu`, `new-menu`, `pane`, `peek`,
`picker`, `prompt`, `spaces`, `tabs`, `terminals-bar`, `terminals-pane`, `toast`,
`win98`, `workspace-chrome`, `workspace-status`, `worktree`, the layouts `main`,
`terminals`, `win98`, and the themes `atom-one-dark`, `win98`. Herdr treats such a
file as an edit of its own: it moves it aside and puts its version back.

The list lives in `reserved.txt`. Both installers enforce it, and
`scripts/check.mjs` enforces it, so the rule cannot rot into prose only.

## Parts stay independent

- The theme is colors only. It installs, applies and is offered in every layout
  on its own; no mod and no layout may be required to select it.
- A mod is one folder with one catalogue row. It may use theme colors and shared
  state, never another Farrier mod's code or files.
- A layout names the mods it shows. Without one, its block is empty; the theme,
  the other blocks and the rest of the window still work. A default theme or
  font from a missing part falls back to Herdr's own.
- A part's keys are added and removed only with the layout and strip mod that
  own them; removing another part never changes them.
- Never give a theme a layout's name. Herdr then offers it only while that
  layout shows (see The theme), which silently ties the two together.
- Selecting a layout may set that layout's default look; selecting a theme must
  never switch layouts or install mods.

## What this repository must not touch

- `keys.json` beyond its own `layout:farrier` / `mod:farrier` sections, and never
  a code already bound to something else.
- Other layouts, other themes, `settings.json`, `programs.json`, `icons/`, `frame/`.
- `view.json`, `shared.json`, `data/`, `layouts/.state/`: the app writes those.
- Nothing outside the Herdr home except reading files the person asked about.

## Mod code

- `main.js` uses gpui-kit and the `herdr` module only. No DOM, no CSS, no webview,
  no Node APIs, no `setTimeout`, no timers of our own.
- Herdr's script engine is far slower than Node and **stops a script that runs
  about 0.5 s without yielding**. Anything heavy (parsing, large file reads,
  git log) goes through `exec()` / `hc()` or is chunked with `await`.
- Colors come from `theme()` only. No hex in mod code: a hex belongs in
  `themes/*.json`, and a mod that uses theme colors follows light and dark.
- A mod that lists agents calls `setAgentOrder()`; one that shows a copy of a
  layout region reads `props()`, never global state.
- A mod that can sit in any layout finds its own nodes by its mod name in
  `layout()`; never hard-code a layout's block ids or assume the farrier layout.
  It can have several copies, or be a pane/tab copy with no layout node: show
  and refresh when any copy is visible, never because one block happens to be.
- Nothing runs while hidden. Animate with gpui-kit's native motion, not a loop.

## The theme

`themes/farrier-charcoal.json` is the only place with hex values. Its file name
must differ from every layout name: Herdr treats a theme named like a layout as
that layout's own and offers it only there. The `farrier` layout names it as
its default theme, so a full install looks right; the theme picker overrides
that, and the theme can be selected in any layout. Keep the ANSI 16 complete
and every `colors` key one of the names `theme()` returns.

## The installer

- Zero dependencies. `install.ps1` runs on Windows PowerShell 5.1; `install.sh`
  runs on POSIX `sh`. No Node, no Python, no package manager in the install path.
  `python3` is used on POSIX only when it happens to exist, and only to merge or
  remove keys and to read JSON; without it those steps degrade to a printed
  snippet and nothing breaks.
- Copies real files, never symlinks: Herdr's watcher ignores paths outside its
  home, and it does not open images through a link.
- Validates before writing: `install.tsv` shape, ids, destinations, `reserved.txt`
  (without a `.json` suffix for a layout or theme), JSON, the theme's 16 ANSI
  colors, a theme named like a layout, and every mod a layout references.
- Files are replaced in place and copied to `<home>/backup/<time>/` first. A file
  that is briefly missing is what makes an on-screen layout re-apply without its
  theme, so files are never moved away.
- A mod folder is staged beside its destination and moved into place in one
  rename, so an open Herdr never sees a half-copied mod.
- Skips what is already identical (`=`), so `--update` touches only what changed
  and never re-applies a layout for nothing.
- Each catalogue row installs alone (`--list`, then ids). A layout may name mods
  it shows; a missing one leaves its block empty and the other parts still run.
- The one destination rename is `themes/farrier.json` →
  `themes/farrier-charcoal.json`: when the layout is selected, both installers
  install the new theme, then back up and remove the old file. A theme-only
  update keeps the old file while the installed layout still names it.
- Runs `herdr-app check` on every mod it installs and exits non-zero if one fails.
- Flags: `--list`, `--dry-run`, `--update`, `--remove`, `--keys`, `-y`, ids.
  `--remove` deletes only catalogue rows and only key bindings that still equal
  ours. `--keys` adds only missing bindings and never replaces one that differs;
  it runs only when the layout and strip mod are selected.

## Sources, credits, privacy

Do not record where an idea, a layout or a script came from. This repository
carries no "inspired by", "based on", "compared with" or "thanks to" notes — not
in docs, comments, commit messages, PR text or issue templates.

The only exceptions are legally required notices for code or art that was
actually copied and is not ours: a license file beside the asset, and the entry
in `NOTICE`. Farrier's own code needs no attribution, and the Herdr mod API is
documented, not copied.

Keep personal data out: no local paths, no machine names, no tokens, no agent
transcripts, no screenshots of someone's work.

## Adding a mod, theme or layout

1. Put the files where `install.tsv` expects them: `mods/farrier-<role>/`,
   `themes/farrier-<what>.json`, `layouts/farrier-<what>.json`.
2. Add one row to `install.tsv` (id, kind, src, dest, description), keeping
   `themes/` rows above `layouts/` rows; never put a theme row after a layout.
3. Add a `preview.png`/`.svg` next to a new layout and point the root's
   `preview` at it, or Settings shows a plain frame.
4. A second mod gets its own prefix and its own `mod:<name>` key section; never
   make it depend on another mod's code. A theme is named `farrier-<look>` and
   must not share a layout's name.
5. Run the checks below. `scripts/check.mjs` is the gate: unknown names, bad
   JSON, a mod missing from a layout, a theme sharing a layout's name, a layout
   naming a theme that is not installed or a Herdr preset, a theme row after a
   layout row, a file left out of the catalogue.

## Development

Node is allowed here and only here: `scripts/check.mjs` and CI use it. The two
installers must keep working without it.

```sh
node scripts/check.mjs        # catalogue, names, JSON, references, keys
sh tests/install.test.sh      # installer behaviour in throwaway Herdr homes
sh -n install.sh              # POSIX syntax
```

`tests/install.test.sh` needs the Herdr app for real mod checks; without it the
test uses a stub and says so. CI runs the static checks, `sh -n`, the
PowerShell catalogue, and the installer test on every push and pull request.
`tests/install.test.ps1` runs the same install/update/remove paths through
`install.ps1` in a throwaway home.

`VERSION` is the one version: the installers print it, and `check.mjs` fails if
it is not `x.y.z`.

## Before a commit

```sh
node scripts/check.mjs
sh tests/install.test.sh
powershell -ExecutionPolicy Bypass -File tests/install.test.ps1
herdr-app check mods/farrier
herdr-app check mods/farrier-git
powershell -ExecutionPolicy Bypass -File install.ps1 --dry-run
```

Small diffs, one change at a time, and update `install.tsv` when a new file is
part of the install.
