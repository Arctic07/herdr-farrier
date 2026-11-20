# Farrier Files

The **Files** panel: a repository tree that expands instantly, workspace search
and replace, and a file tab with editing, find, and previews. It follows the
focused pane's folder and uses the machine that pane is on.

## Install alone

`farrier-files` is its own catalogue row. Run `--list`, then
`powershell -ExecutionPolicy Bypass -File install.ps1 farrier-files` or
`sh install.sh farrier-files` to install the panel without the layout or the
theme. It uses theme colors only, so it follows the theme you already use. In
a personal layout, add a block where it should show:

```json
{ "id": "files", "type": "block", "content": { "mod": "farrier-files" } }
```

Clone a Herdr layout first: shipped layouts are restored on start. In the farrier
layout it sits in the Files stack, opened by the tab bar's **Files** button.

## The tree

- One `git ls-files` call builds the whole repository index up front. Expanding
  or collapsing a folder only changes the visible row list; there is no second
  process and no reload of every open folder. This is the difference from a
  browser that lists each directory separately on every refresh.
- A watch batch in a repository runs one `git status` and applies only the
  added, deleted and changed paths in memory; it does not rebuild the index.
  The initial index is built in chunks so a large repository never blocks the
  window.
- Folders are first, then names, case-insensitively. Git marks appear on the
  right: **A**, **M**, **D**, **U**. Unsaved editor buffers show an accent dot.
- The list is virtualised: ten thousand visible rows cost about what twenty
  cost. A filter above the tree narrows by name or path and opens the ancestors
  of matches.
- Outside a repository the panel falls back to lazy directory listing. A folder
  is listed the first time it opens, 500 entries per folder. Live file watching
  refreshes only the folders whose entries changed.
- Right-click a row for **Open file**, **Open in folder**, **Place in empty
  pane**, **Open folder**, **Copy path**, **Rename** and **Delete**. A preview
  tab also offers **Keep open**. Rename and delete ask first; a rename keeps
  open folders where it can. Rows carry their absolute path as a drag payload.
- A single click opens a temporary preview tab. Double-clicking the same row
  (or **Keep open**, or making an edit) makes it permanent. Opening another
  preview replaces the previous one; unsaved edits and split tabs promote
  instead of closing. The tree row and file header show previews in italics.
- The header's copy button copies the selected path; right-click **Copy path**
  does the same without changing the selection. The file tab's folder icon
  opens the file's folder in the system file manager (Explorer, Finder or
  `xdg-open`).
- `↑` `↓` `Home` `End` move the selection, `→` opens a folder, `←` closes it or
  goes to the parent, `Enter` opens a file, and typing in the filter narrows the
  tree. `Ctrl+F` focuses the filter and `Ctrl+Shift+F` opens Search.
- Clicking a file opens a Herdr tab with `{ folder, file, on }` and reuses the
  tab it already recorded for that path. An empty pane or placeholder tab in
  the active tab is replaced instead of creating an extra tab.

## Search

- **Search** is a collapsible section below the tree. `Ctrl+Shift+F` opens it and
  focuses the query.
- Results appear as you type after a short debounce, off the UI thread, with a
  token that discards stale runs. `Aa` is match case, `ab` is whole word, `.*` is
  regular expression.
- Include and exclude lists accept comma-separated globs such as `src/**` or
  `node_modules`. Bare names match at any depth.
- `ripgrep` is used when installed and respects `.gitignore`; otherwise the panel
  falls back to `grep` and re-matches each candidate line. Results cap at 2,000
  matches and 200 files and say `(limited)` when they hit the cap.
- Clicking a result opens the file with the query and line in its find widget;
  an already open tab receives the same handoff. A file header folds its
  matches; clicking it also selects that file for **Replace in file**. A match
  can be replaced or dismissed from the action row while replace is open; the
  result row previews the replacement inline.
- **Replace** opens a replace field and an `AB` preserve-case toggle.
  **Replace** always asks first, then re-reads every file, recomputes the matches
  with the same options, applies only targets that still match at the same
  line/column/length, and writes with the fresh text as the expected snapshot.
  Files changed on disk, files at or above 1 MiB, files that read as non-UTF-8,
  and open files with unsaved edits are skipped and named in the toast.

## The file tab

- **Editing**: syntax highlighting from the active theme, line numbers, folding,
  soft wrap, `Ctrl+S` save, dirty dot, and a copy button. `Ctrl+F` opens find,
  `Ctrl+H` opens find with the replace row.
- **Find and replace**: `Aa` / `ab` / `.*`, match list with context, previous/next
  (`↑` / `↓`, `Enter` / `Shift+Enter`, `F3` / `Shift+F3`), replace one, replace all, and a
  small in-memory undo for replacements (`Ctrl+Z` while find is open).
- **Previews**: Markdown renders in a readable column; SVG renders on a light
  canvas with zoom; CSV/TSV renders as a table with quoted fields and delimiter
  detection; XLSX/XLSM reads the OOXML package through `unzip`, `tar`,
  `python3` or PowerShell, shows up to six sheets with tabs, dates, booleans and
  percentages; PNG, JPEG, GIF, WebP and BMP render with 25–400% zoom and
  `Ctrl`+wheel zoom. Tables keep their header and row numbers while scrolling.
  Markdown, SVG and CSV get a **Preview / Code** switch.
- **Live reload**: the file's folder is watched. A change on disk reloads the
  tab, unless the tab has unsaved edits, in which case a warning appears and
  saving still detects the stale snapshot.
- **Split**: the header split buttons open the same file in a right or down
  split. `Ctrl+\` splits right and `Ctrl+Shift+\` splits down. `Alt+Z` toggles
  soft wrap.

## Commands

Personal `keys.json` bindings can send `farrier-files.focus`,
`farrier-files.search` or `farrier-files.find` to the mod. The panel does not
install keys of its own, so it never takes a chord from another window.

## Limits

- A git index is capped at 30,000 paths. Ignored files and ignored folders do
  not appear in git mode; use the filter or a terminal for those.
- Text is read through Herdr's 1 MiB text channel. Larger or binary files open
  read-only; images are separate.
- Workbook previews need `unzip`, `tar`, `python3` or PowerShell on the machine
  that holds the file. They show at most six sheets, 2,000 rows and 100 columns
  per sheet, and are read-only.
- On another machine, the tree, search, text editing, workbook previews and
  raster pictures up to Herdr's 8 MiB output budget work through `exec`; live
  watching and opening a system folder do not.
- Replace in files writes at most the 200 files the search grouped, and skips
  anything that changed since the result was drawn.

## Files

| File | What it does |
|---|---|
| `main.js` | The view: location, tree loading and watching, search, tabs, file lifecycle |
| `tree-view.js` | Tree, Search, context menu and dialogs |
| `file-view.js` | File header, editor, find widget, Markdown/SVG/CSV views |
| `files-logic.js` | Tree building, flattening, filtering, status parsing, names and languages |
| `search-logic.js` | Find/replace engine, globs, ripgrep/grep parsing, result grouping |
| `preview-logic.js` | CSV parsing, SVG dimensions, raster headers, zoom |
| `xlsx-logic.js` | OOXML workbook, shared strings, styles, sheet tables |
| `ui.js` | Shared icons, buttons, badges and section headers |
| `icons/` | The panel's vector glyphs, tinted from the theme |

The pure modules have no GPUI or Herdr imports and can be checked with Node.
