# Farrier

A Herdr layout, three mods and its theme. Each part installs on its own; the
layout only names the parts it shows.

Farrier is a keyboard-first window for running coding agents: spaces and agents
on the left, framed panes with a header in the middle, and a bottom strip that
says how many agents wait on you, work, or finished while you looked elsewhere.
The **Changes** button in the tab bar opens a Changes panel: staged files,
branches, stashes, a push/pull/fetch menu and a commit box that can use Pi to
write the message. The **Files** button opens a repository tree with workspace
search and replace, plus a file tab with editing, find and Markdown/image/CSV
previews. Both panels share one file-type icon vocabulary, and a file row can
be dragged into a terminal as its path.

![Farrier](layouts/farrier.svg)

Not affiliated with Herdr.

## Install

Farrier installs from a clone; the app stays open while it runs.

```powershell
git clone https://github.com/Arctic07/herdr-farrier
cd herdr-farrier
powershell -ExecutionPolicy Bypass -File install.ps1
```

```sh
git clone https://github.com/Arctic07/herdr-farrier
cd herdr-farrier
sh install.sh
```

Both scripts copy the layout, its picture, the theme and the mods into
`~/.config/herdr-app` (or `$HERDR_APP_HOME`), back up anything they replace, and
check every mod with `herdr-app check`. Each catalogue row also installs alone:
run `--list`, then pass one id.

Then open Herdr, pick **farrier** in Settings › Layout, or cycle layouts with
`Ctrl+Shift+L`.

Options:

| Flag | What it does |
|---|---|
| `--list` | what this repository installs |
| `--dry-run` | print every write, touch nothing |
| `--update` | update what is already installed, plus the theme rename migration |
| `--remove` | take back what Farrier installed, and the keys its removed parts own |
| `--keys` | add the layout's key when the layout and strip mod are installed |
| `-y` | no questions |
| `farrier-mod` | install only these ids (see `--list`) |

Running it twice is safe: anything already identical is left alone (`=`).

The interface uses HarmonyOS Sans SC, bundled in `mods/farrier/fonts/`
under the HarmonyOS Sans Fonts License Agreement. The terminals keep a
monospace font. Herdr loads these fonts at start; restart it once after the
first install if the window was already open.

## What's inside

| File | What it is |
|---|---|
| `layouts/farrier.json` | the window: sidebar, tabs, framed panes, hidden Files and Changes panels, bottom strip |
| `layouts/farrier.svg` | the picture Settings shows for the layout |
| `themes/farrier-charcoal.json` | charcoal, paper-white and cyan; selectable in every layout |
| `mods/farrier/` | the bottom strip: machine, space, branch, agents waiting |
| `mods/farrier/fonts/` | HarmonyOS Sans SC, and the license that covers it |
| `mods/farrier-git/` | the Changes panel: staged files, branches, diff window, commit box |
| `mods/farrier-files/` | the Files panel: repo tree, workspace search, file editor, preview tabs and previews |
| `keys.pack.json` | the layout's key section, merged only with `--keys` |
| `install.tsv` | what gets installed, and where |
| `reserved.txt` | the names Herdr ships, which Farrier refuses to take |
| `VERSION` | the one version the installers print |

## Parts

| Part | id | Stands alone |
|---|---|---|
| Theme | `farrier-theme` | Select it in Settings › Look in any layout. The layout uses it by default. |
| Window layout | `farrier-layout` | Names the mods it shows; a missing one leaves that block empty. |
| Bottom strip | `farrier-mod` | One mod; the layout places it. |
| Changes panel | `farrier-git` | Uses theme colors only. Add this block to a personal layout, or let the farrier layout place it. |
| Files panel | `farrier-files` | Uses theme colors only. Add this block to a personal layout, or let the farrier layout place it. |

```json
{ "id": "changes", "type": "block", "content": { "mod": "farrier-git" } }
{ "id": "files", "type": "block", "content": { "mod": "farrier-files" } }
```

Clone a Herdr layout first: shipped layouts are restored on start. The tab
bar's **Files** and **Changes** buttons drive the `panel-body` stack's
`files` and `changes` children; to use those buttons for these panels, make
those children use `farrier-files` and `farrier-git`, or open the block
directly. The layout's default theme and UI font come from other parts;
without them Herdr falls back to its own.

For example, `powershell -ExecutionPolicy Bypass -File install.ps1 farrier-git`
or `sh install.sh farrier-git` installs only the Changes panel, with no layout
and no theme. The same works with `farrier-files` for the Files panel.

## Keys

The strip's key lives in the `layout:farrier` section, so it works only while
this layout shows and never takes a key from someone else's window.

| Key | Does |
|---|---|
| `Ctrl+Shift+A` | go to the next agent that needs you |

Clicking a count in the strip goes to an agent in that state.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 --remove
```

```sh
sh install.sh --remove
```

`--remove` deletes only the files `install.tsv` lists and the key bindings that
are still Farrier's own, and leaves the rest of the Herdr home alone. Switch to
another layout first if Farrier is the shown one. To do it by hand, delete
`layouts/farrier.json`, `layouts/farrier.svg`, `themes/farrier-charcoal.json`,
`mods/farrier/`, `mods/farrier-git/` and `mods/farrier-files/` from the Herdr home, and the
`layout:farrier` section from `keys.json`. An older install may also have
`themes/farrier.json`; the installer removes it once the layout is updated,
and keeps it while the installed layout still names it.

## Requirements

- Herdr app 0.1.16 or newer
- Windows PowerShell 5.1 or POSIX `sh`, nothing else; `python3` is used only if
  it is already there, to merge keys
- For commit messages written by Pi: `pi` on `PATH`, using the model in
  `~/.pi/agent/settings.json`

## Development

```sh
node scripts/check.mjs        # catalogue, names, JSON, references, keys
node --experimental-vm-modules tests/mod-syntax.mjs  # every mod parses
node --test tests/files-logic.test.mjs  # tree, search and preview logic
sh tests/install.test.sh      # installer behaviour in throwaway homes
```

Node is a developer and CI tool. Neither installer needs it, `python3`, or a
package manager.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
