# Farrier Git

The Changes panel, opened by the **Changes** button in the tab bar. It follows
the focused pane's folder: staged and unstaged files, branches, stashes, a diff
window, and a commit box above the file list. The ellipsis beside the title
opens push, pull, fetch, branches and stashes.

## Install alone

`farrier-git` is its own catalogue row. Run `--list`, then
`powershell -ExecutionPolicy Bypass -File install.ps1 farrier-git` or
`sh install.sh farrier-git` to install the panel without the layout or the
theme. It uses theme colors only, so it follows the theme you already use. In
a personal layout, add a block where it should show:

```json
{ "id": "farrier-git", "type": "block", "content": { "mod": "farrier-git" } }
```

Clone a Herdr layout first: shipped layouts are restored on start. In the
farrier layout it sits in the Changes stack, opened by the tab bar's
**Changes** button; in another layout, open the block directly or point that
stack's `changes` child at `farrier-git`.

## What it does

- **Files**: staged changes and working changes are separate groups. A row
  stages, unstages, or discards one file; a group header stages or unstages all
  of them. The Changes header also discards all working changes after a
  confirmation; untracked files are deleted then. Clicking a file opens its diff
  in a window.
- **Branches**: the branch chip opens the branch list; the ellipsis menu adds
  merge, rebase, create, create from a source, rename, delete, delete a remote
  branch, publish, and the full list. Remote branches check out as tracking
  branches. A Branches drawer at the bottom of Changes starts collapsed; it
  opens upward and lists local branches with their latest commit subject and
  date. Expand a branch for its latest 20 commits with subject, author and age;
  **Load more** adds another 20. Right-click a commit to copy its full SHA; a
  green check at the left of that row confirms the copy. The drawer is for
  reading history, not for switching branches.
- **Remote**: the menu pushes and pulls separately. Push publishes a branch
  without an upstream by running `git push -u origin <branch>`; Pull stays
  disabled until the branch has an upstream. Fetch updates all remotes.
- **Stashes**: the menu creates tracked, untracked, or staged-only stashes,
  applies or pops the newest one, and opens a stash list to apply, pop, or drop
  a specific entry. Dropping all stashes asks first.
- **Commit**: the message box sits above the files and commits staged changes
  with `Ctrl+Enter`. The Generate button runs `pi` with the person's Pi
  configuration — the default provider and model in
  `~/.pi/agent/settings.json` — on the staged diff, and writes the returned
  message into the box. It is disabled while nothing is staged. Generation is
  for local repositories only.

File icons are chosen from the name and extension and tinted from the theme.
The mod uses theme colors only, so it follows light and dark themes.

## Limits

- A diff window shows the first 5,000 lines and truncates lines over 4,000
  characters.
- File lists show the first 1,000 changed paths.
- The Branches drawer shows at most 200 local branches and keeps at most 200
  commits per branch, 20 at a time. One branch is expanded at a time. It reads
  local refs only; the full branch picker fetches remotes, up to 250.
- Pi generation sends at most 24 kB of diff and is not offered for folders on
  another machine.
