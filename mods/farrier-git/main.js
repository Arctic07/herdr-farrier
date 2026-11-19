// Farrier's Git sidebar: staged and unstaged files, branches, and a commit box.
// It follows the focused pane's folder and uses the machine that pane is on.
// Clicking a changed file opens its diff in a window; clicking a branch row
// switches to it. The commit message can be written by hand or generated with
// Pi, which runs with the person's own Pi configuration.

import { View, div, svg } from "gpui-kit";
import {
  v_flex,
  h_flex,
  InputState,
  Input,
  TextareaState,
  Textarea,
  Scrollbar,
  Popover,
  v_virtual_list,
} from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  writeTextFile,
  watchFolder,
  theme,
  settings,
  window,
  props,
  layout,
  closeOverlay,
  openOverlay,
  nextCommand,
  checking,
} from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_FILES = 1000;
const MAX_DIFF = 24000;
const ICON = (name) => `mods/farrier-git/icons/${name}.svg`;

// ---- where ------------------------------------------------------------------

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane has no folder of its own. Keep following the space's work
  // rather than blanking the sidebar whenever a viewer or diff has focus.
  const tabs = new Set((space?.tabs ?? []).map((tab) => tab.id));
  const shown = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
  return { cwd: pane?.cwd || f?.cwd || shown || space?.folder, on, space: space?.id };
}

const contextKey = () => JSON.stringify(location());

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// ---- git --------------------------------------------------------------------

async function gitRun(cwd, on, args, timeout) {
  return exec("git", [...READ, ...args], { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
}

function gitError(result) {
  const text = (result.stderr || result.stdout || "").trim();
  return text.split(/\r?\n/).slice(0, 5).join("\n") || `git exited with ${result.code}`;
}

async function mustGit(cwd, on, args, timeout) {
  const result = await gitRun(cwd, on, args, timeout);
  if (result.code !== 0) throw new Error(gitError(result));
  return result;
}

// Porcelain v2 with --no-renames: one record per path, plus branch headers.
function parseStatus(text) {
  const files = [];
  const branch = { name: "", upstream: "", ahead: 0, behind: 0, hasHead: false };
  for (const record of text.split("\0")) {
    if (!record) continue;
    if (record.startsWith("# ")) {
      const body = record.slice(2);
      const at = body.indexOf(" ");
      const key = at < 0 ? body : body.slice(0, at);
      const value = at < 0 ? "" : body.slice(at + 1);
      if (key === "branch.head") branch.name = value;
      else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.oid") branch.hasHead = value !== "(initial)";
      else if (key === "branch.ab") {
        const [ahead, behind] = value.split(" ");
        branch.ahead = Number(ahead?.replace("+", "")) || 0;
        branch.behind = Math.abs(Number(behind?.replace("-", "")) || 0);
      }
      continue;
    }
    const type = record[0];
    if (type === "?") {
      files.push({ path: record.slice(2), xy: "??", untracked: true });
      continue;
    }
    if (type === "1") {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      if (path) files.push({ path, xy, untracked: false });
      continue;
    }
    if (type === "u") {
      const parts = record.split(" ");
      const path = parts.slice(10).join(" ");
      if (path) files.push({ path, xy: parts[1] ?? "UU", untracked: false, conflict: true });
    }
  }
  return { files, branch };
}

function parseNumstat(text) {
  const out = {};
  for (const record of text.split("\0")) {
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const add = record.slice(0, first);
    const del = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    out[path] = {
      add: Number(add) || 0,
      del: Number(del) || 0,
      binary: add === "-" || del === "-",
    };
  }
  return out;
}

async function loadStats(cwd, on) {
  const [stagedResult, workResult] = await Promise.all([
    gitRun(cwd, on, ["diff", "--cached", "--numstat", "-z", "--no-renames"]),
    gitRun(cwd, on, ["diff", "--numstat", "-z", "--no-renames"]),
  ]);
  return {
    staged: stagedResult.code === 0 ? parseNumstat(stagedResult.stdout) : {},
    work: workResult.code === 0 ? parseNumstat(workResult.stdout) : {},
  };
}

function baseName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function dirName(path) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function ago(at) {
  if (!at) return "";
  const seconds = Date.now() / 1000 - at;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 86400 * 60) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / 86400 / 30)}mo`;
}

const REF_FORMAT = "%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(committerdate:unix)";
const REMOTE_FORMAT = "%(refname:short)%09%(committerdate:unix)";

function parseLocalRefs(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [head, name, upstream, at] = line.split("\t");
      return { name, upstream: upstream || "", at: Number(at) || 0, current: head?.trim() === "*" };
    })
    .filter((branch) => branch.name);
}

function parseRemoteRefs(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, at] = line.split("\t");
      return { name, at: Number(at) || 0, remote: true };
    })
    .filter((branch) => branch.name && branch.name.includes("/") && !branch.name.endsWith("/HEAD"));
}

// ---- files ------------------------------------------------------------------

const NAMES = {
  "package.json": ["json", "ansi3"],
  "package-lock.json": ["lock", "dim"],
  "yarn.lock": ["lock", "dim"],
  "pnpm-lock.yaml": ["lock", "dim"],
  "cargo.lock": ["lock", "dim"],
  "composer.lock": ["lock", "dim"],
  "gemfile.lock": ["lock", "dim"],
  "pipfile.lock": ["lock", "dim"],
  "readme.md": ["text", "ansi6"],
  "readme": ["text", "ansi6"],
  "license": ["text", "ansi3"],
  "license.md": ["text", "ansi3"],
  "changelog.md": ["text", "ansi6"],
  "dockerfile": ["config", "ansi4"],
  "makefile": ["config", "ansi3"],
  "cmakelists.txt": ["config", "ansi4"],
  ".editorconfig": ["config", "ansi3"],
  ".gitignore": ["branch", "ansi1"],
  ".gitattributes": ["branch", "ansi1"],
  ".gitmodules": ["branch", "ansi1"],
  "tsconfig.json": ["json", "ansi3"],
  "jsconfig.json": ["json", "ansi3"],
};

const EXTENSIONS = {
  ts: ["code", "ansi4"], tsx: ["code", "ansi4"], mts: ["code", "ansi4"], cts: ["code", "ansi4"],
  js: ["code", "ansi3"], jsx: ["code", "ansi3"], mjs: ["code", "ansi3"], cjs: ["code", "ansi3"],
  py: ["code", "ansi2"], pyi: ["code", "ansi2"],
  rs: ["code", "ansi1"], go: ["code", "ansi6"], java: ["code", "ansi1"], kt: ["code", "ansi5"],
  kts: ["code", "ansi5"], swift: ["code", "ansi3"], rb: ["code", "ansi1"], php: ["code", "ansi5"],
  cs: ["code", "ansi4"], c: ["code", "ansi4"], h: ["code", "ansi4"], cc: ["code", "ansi4"],
  cpp: ["code", "ansi4"], hpp: ["code", "ansi4"], cxx: ["code", "ansi4"], m: ["code", "ansi4"],
  lua: ["code", "ansi4"], sh: ["shell", "ansi2"], bash: ["shell", "ansi2"], zsh: ["shell", "ansi2"],
  fish: ["shell", "ansi2"], ps1: ["shell", "ansi4"], bat: ["shell", "ansi2"], cmd: ["shell", "ansi2"],
  json: ["json", "ansi3"], jsonc: ["json", "ansi3"], json5: ["json", "ansi3"],
  css: ["style", "ansi5"], scss: ["style", "ansi5"], sass: ["style", "ansi5"], less: ["style", "ansi5"],
  styl: ["style", "ansi5"],
  html: ["html", "ansi3"], htm: ["html", "ansi3"], vue: ["html", "ansi2"], svelte: ["html", "ansi1"],
  astro: ["html", "ansi5"],
  md: ["text", "ansi6"], mdx: ["text", "ansi6"], txt: ["text", "muted"], rst: ["text", "ansi6"],
  adoc: ["text", "ansi6"], pdf: ["text", "ansi1"], doc: ["text", "ansi4"], docx: ["text", "ansi4"],
  png: ["image", "ansi5"], jpg: ["image", "ansi5"], jpeg: ["image", "ansi5"], gif: ["image", "ansi5"],
  webp: ["image", "ansi5"], svg: ["image", "ansi5"], ico: ["image", "ansi5"], bmp: ["image", "ansi5"],
  yml: ["config", "ansi5"], yaml: ["config", "ansi5"], toml: ["config", "ansi5"], ini: ["config", "ansi5"],
  conf: ["config", "ansi5"], env: ["config", "ansi3"], xml: ["config", "ansi5"],
  sql: ["db", "ansi6"], sqlite: ["db", "ansi6"], db: ["db", "ansi6"],
  zip: ["file", "dim"], tar: ["file", "dim"], gz: ["file", "dim"], bz2: ["file", "dim"],
  xz: ["file", "dim"], rar: ["file", "dim"], "7z": ["file", "dim"],
};

function fileKind(path) {
  const name = baseName(path).toLowerCase();
  if (NAMES[name]) return NAMES[name];
  if (/\.(test|spec)\.[^./]+$/.test(name) || /^(test|spec)\./.test(name)) return ["test", "ansi1"];
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1) : "";
  return EXTENSIONS[extension] ?? ["file", "muted"];
}

function fileIcon(t, path) {
  const [glyph, color] = fileKind(path);
  return svg(ICON(glyph)).size(14).flex_none().text_color(t[color] ?? t.muted);
}

function statusColor(t, file) {
  if (file.conflict) return t.blocked;
  if (file.status === "D") return t.blocked;
  if (file.status === "A" || file.status === "?") return t.done;
  if (file.status === "R" || file.status === "C") return t.ansi4;
  return t.working;
}

function statusLetter(file) {
  if (file.conflict) return "!";
  if (file.status === "?") return "U";
  return file.status || "M";
}

// ---- diff -------------------------------------------------------------------

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

function diffRows(lines) {
  let old = 0;
  let next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line };
    }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") {
      old++;
      return { kind, number: next++, text: untab(line.slice(1)) || " " };
    }
    return { kind: "", text: line };
  });
}

const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

// ---- pi ---------------------------------------------------------------------

const PI_SYSTEM =
  "You write git commit messages from the diff provided. Reply with only the commit message: " +
  "a Conventional Commit subject line under 72 characters, and optionally a short body separated by a blank line. " +
  "No quotes, no code fences, no explanation.";

async function runPi(args, cwd) {
  const commands = window()?.platform === "windows" ? ["pi", "pi.cmd"] : ["pi"];
  let last;
  for (const command of commands) {
    try {
      return await exec(command, args, { cwd, timeout: 180000 });
    } catch (error) {
      last = error;
      if (!/not found|cannot start|no such file|ENOENT|program not found/i.test(String(error))) throw error;
    }
  }
  throw last;
}

async function tempDir() {
  if (window()?.platform === "windows") {
    const result = await exec("powershell", ["-NoProfile", "-Command", "[IO.Path]::GetTempPath()"]);
    if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the temporary folder");
    return result.stdout.trim().replace(/\\/g, "/").replace(/\/$/, "");
  }
  return "/tmp";
}

function cleanMessage(text) {
  let message = (text ?? "").replace(/\r/g, "").trim();
  message = message.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  message = message.replace(/^(commit message|message|subject)\s*[:\-]\s*/i, "").trim();
  message = message.replace(/^["'`]|["'`]$/g, "").trim();
  return message.slice(0, 4000);
}

// ---- UI ---------------------------------------------------------------------

function icon(name, color, size = 14) {
  return svg(ICON(name)).size(size).flex_none().text_color(color);
}

function pill(t, text, color) {
  return div()
    .h(16)
    .px(5)
    .flex_none()
    .flex()
    .items_center()
    .rounded(8)
    .bg(color + "18")
    .text_size(10)
    .text_color(color)
    .child(text);
}

function iconButton(t, id, name, hint, onClick, options = {}) {
  const color = options.color ?? t.muted;
  let el = h_flex()
    .id(id)
    .size(options.size ?? 26)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(7)
    .text_color(color)
    .role("button")
    .accessibility_label(hint)
    .tooltip(hint)
    .when(!options.disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.opacity(0.72)));
  if (options.stopDrag) el = el.on_mouse_down("left", (_event, cx) => cx.stop_propagation());
  if (options.disabled) el = el.disabled(true).opacity(0.45);
  else el = el.on_click((_event, cx) => onClick(cx));
  return el.child(icon(name, color, options.glyphSize ?? 14));
}

function menuTrigger(t) {
  return h_flex()
    .id("farrier-git-menu-trigger")
    .size(26)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(7)
    .text_color(t.muted)
    .role("button")
    .accessibility_label("More actions")
    .tooltip("More actions")
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .child(icon("ellipsis", t.muted, 14));
}

function button(t, id, label, variant, onClick, options = {}) {
  const height = options.h ?? 30;
  const px = options.px ?? 11;
  const disabled = Boolean(options.disabled);
  let el = h_flex()
    .id(id)
    .h(height)
    .flex_none()
    .px(px)
    .gap(6)
    .items_center()
    .rounded(8)
    .text_size(11.5)
    .font_medium()
    .role("button")
    .accessibility_label(label)
    .tooltip(options.hint ?? label);
  if (variant === "primary") {
    el = el.bg(t.solid).text_color(t.solid_foreground).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.9)).active((s) => s.opacity(0.8)));
  } else if (variant === "danger") {
    el = el.border_1().border_color(t.blocked).text_color(t.blocked).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.blocked + "18")).active((s) => s.opacity(0.8)));
  } else if (variant === "outline") {
    el = el.border_1().border_color(t.input).text_color(t.foreground).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.opacity(0.8)));
  } else if (variant === "ghost") {
    el = el.text_color(t.muted).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.opacity(0.8)));
  } else {
    el = el.bg(t.raised).border_1().border_color(t.input).text_color(t.foreground).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.opacity(0.8)));
  }
  if (options.iconName) el = el.child(icon(options.iconName, variant === "primary" ? t.solid_foreground : variant === "danger" ? t.blocked : t.muted, 13));
  if (disabled) el = el.disabled(true).opacity(0.45);
  else el = el.on_click((_event, cx) => onClick(cx));
  return el.child(label);
}

// ---- view -------------------------------------------------------------------

export default class FarrierGit extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.mode === "diff" ? "diff" : p.mode === "branches" ? "branches" : p.mode === "stashes" ? "stashes" : "changes";
    this.handle = cx.focus_handle();
    this.note = null;
    this.noteKind = "";
    this.typing = false;
    this.focused = { filter: false, create: false, rename: false, message: false };
    this.loading = false;
    this.busy = false;
    this.generating = false;
    this.context = null;
    this.root = null;
    this.repoName = "";
    this.branch = "";
    this.branchRaw = "";
    this.upstream = "";
    this.ahead = 0;
    this.behind = 0;
    this.hasHead = false;
    this.staged = [];
    this.changes = [];
    this.notRepo = false;
    this.error = null;
    this.limited = false;
    this.stale = false;
    this.discardTarget = null;
    this.discardAll = false;
    this.folded = { staged: false, changes: false };
    this.menu = null;
    this.stashes = null;
    this.stashLoading = false;
    this.stashError = null;
    this.stashConfirm = null;
    this.watched = null;
    this.watchPromise = null;
    this.branches = null;
    this.branchLoading = false;
    this.branchError = null;
    this.branchFilterText = "";
    this.newBranchText = "";
    this.renaming = null;
    this.deleting = null;
    this.deletingRemote = null;
    this.branchAction = null;
    this.branchSource = null;
    this.renameText = "";

    this.message = "";
    this.messageState = TextareaState.new({ placeholder: "Commit message", rows: 3 });
    this.messageState.set_auto_grow(2, 5);
    this.messageState.on("change", (_event, cx) => {
      this.message = this.messageState.value();
      cx.notify();
    });
    this.messageState.on("submit", (_event, cx) => this.commit(cx));
    this.messageState.on("focus", (_event, cx) => {
      this.focused.message = true;
      this.typing = true;
      cx.notify();
    });
    this.messageState.on("blur", (_event, cx) => {
      this.focused.message = false;
      this.typing = false;
      cx.notify();
    });

    this.branchFilter = InputState.new({ placeholder: "Filter branches" });
    this.branchFilter.on("change", (_event, cx) => {
      this.branchFilterText = this.branchFilter.value();
      cx.notify();
    });
    this.branchFilter.on("submit", (_event, cx) => {
      const first = this.branchChoices().find((row) => row.kind === "local" || row.kind === "remote");
      if (first) this.pickBranch(first, cx);
    });
    this.branchFilter.on("focus", (_event, cx) => {
      this.focused.filter = true;
      cx.notify();
    });
    this.branchFilter.on("blur", (_event, cx) => {
      this.focused.filter = false;
      cx.notify();
    });

    this.newBranch = InputState.new({ placeholder: "New branch name" });
    this.newBranch.on("change", (_event, cx) => {
      this.newBranchText = this.newBranch.value();
      cx.notify();
    });
    this.newBranch.on("submit", (_event, cx) => this.createBranch(cx));
    this.newBranch.on("focus", (_event, cx) => {
      this.focused.create = true;
      cx.notify();
    });
    this.newBranch.on("blur", (_event, cx) => {
      this.focused.create = false;
      cx.notify();
    });

    this.renameInput = InputState.new({ placeholder: "Branch name" });
    this.renameInput.on("change", (_event, cx) => {
      this.renameText = this.renameInput.value();
      cx.notify();
    });
    this.renameInput.on("submit", (_event, cx) => this.renameBranch(cx));
    this.renameInput.on("focus", (_event, cx) => {
      this.focused.rename = true;
      cx.notify();
    });
    this.renameInput.on("blur", (_event, cx) => {
      this.focused.rename = false;
      cx.notify();
    });

    if (this.mode === "diff") {
      this.diff = {
        root: p.root,
        on: p.on ?? null,
        path: p.path ?? "",
        staged: Boolean(p.staged),
        fresh: Boolean(p.fresh),
        status: p.status ?? "M",
        rows: [],
        width: 600,
        error: null,
      };
      this.handle.focus();
      cx.timer.after(80, () => this.handle.focus());
      this.loadDiff(cx);
      return;
    }

    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(15000, (cx) => {
      if (this.mode === "diff" || !this.panelShown()) {
        this.stale = true;
        this.menu = null;
        this.watchPromise?.cancel();
        this.watchPromise = null;
        this.watched = null;
        return;
      }
      this.refresh(cx);
    });
  }

  panelShown() {
    const p = props() ?? {};
    if (p.mode) return true;
    try {
      const root = layout();
      const panel = findNode(root, "panel");
      const body = findNode(root, "panel-body");
      if (!panel || !body) return true;
      return !panel.hidden && body.active === "changes";
    } catch {
      return true;
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  async close(_cx) {
    try {
      this.watchPromise?.cancel();
    } catch {}
    for (const state of [this.messageState, this.branchFilter, this.newBranch, this.renameInput]) {
      try {
        state?.release();
      } catch {}
    }
  }

  watchCommands(cx) {
    if (this.mode === "diff" || checking() || this.watching) return;
    this.watching = true;
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "farrier-git.branches") this.openBranches(cx);
        else if (command === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  // ---- repository ------------------------------------------------------------

  refresh(cx) {
    if (this.mode === "diff" || checking()) return;
    if (!this.panelShown()) {
      this.stale = true;
      this.menu = null;
      this.watchPromise?.cancel();
      this.watchPromise = null;
      this.watched = null;
      return;
    }
    const place = location();
    if ((place.cwd && !this.context) || this.context?.key !== JSON.stringify(place)) {
      this.watchPromise?.cancel();
      this.watchPromise = null;
      this.watched = null;
      this.context = { key: JSON.stringify(place), ...place };
      this.loading = false;
      this.busy = false;
      this.generating = false;
      this.branchLoading = false;
      this.stale = false;
      this.root = null;
      this.repoName = "";
      this.branch = "";
      this.branchRaw = "";
      this.upstream = "";
      this.ahead = 0;
      this.behind = 0;
      this.hasHead = false;
      this.staged = [];
      this.changes = [];
      this.notRepo = false;
      this.error = null;
      this.limited = false;
      this.discardTarget = null;
      this.discardAll = false;
      this.folded = { staged: false, changes: false };
      this.branches = null;
      this.branchError = null;
      this.renaming = null;
      this.deleting = null;
      this.deletingRemote = null;
      this.branchAction = null;
      this.branchSource = null;
      this.menu = null;
      this.stashes = null;
      this.stashLoading = false;
      this.stashError = null;
      this.stashConfirm = null;
      this.branchFilterText = "";
      this.branchFilter.set_value("");
      this.newBranchText = "";
      this.newBranch.set_value("");
      this.renameText = "";
      this.message = "";
      this.messageState.set_value("");
      this.note = null;
    }
    if (!this.context?.cwd || this.loading || this.busy || this.generating) return;

    const ctx = this.context;
    this.loading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const top = await gitRun(ctx.cwd, ctx.on, ["rev-parse", "--show-toplevel"]);
        if (this.context !== ctx) return;
        if (top.code !== 0) {
          this.root = null;
          this.repoName = "";
          this.branch = "";
          this.branchRaw = "";
          this.upstream = "";
          this.ahead = 0;
          this.behind = 0;
          this.notRepo = true;
          this.limited = false;
          this.staged = [];
          this.changes = [];
          return;
        }
        const root = top.stdout.trim();
        const status = await gitRun(root, ctx.on, ["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(gitError(status));
        if (this.context !== ctx) return;
        const parsed = parseStatus(status.stdout);
        const stats = parsed.files.length ? await loadStats(root, ctx.on) : { staged: {}, work: {} };
        if (this.context !== ctx) return;

        const staged = [];
        const changes = [];
        for (const entry of parsed.files.slice(0, MAX_FILES)) {
          const xy = entry.xy ?? "..";
          if (entry.conflict) {
            changes.push({ path: entry.path, status: "U", conflict: true, add: 0, del: 0 });
            continue;
          }
          if (entry.untracked) {
            changes.push({ path: entry.path, status: "?", fresh: true, add: 0, del: 0 });
            continue;
          }
          const index = xy[0] === "." ? " " : xy[0];
          const work = xy[1] === "." ? " " : xy[1];
          if (index !== " ") {
            const map = stats.staged[entry.path] ?? {};
            staged.push({ path: entry.path, status: index, add: map.add ?? 0, del: map.del ?? 0, binary: map.binary });
          }
          if (work !== " ") {
            const map = stats.work[entry.path] ?? {};
            changes.push({ path: entry.path, status: work, add: map.add ?? 0, del: map.del ?? 0, binary: map.binary });
          }
        }
        staged.sort((a, b) => a.path.localeCompare(b.path));
        changes.sort((a, b) => a.path.localeCompare(b.path));

        this.root = root;
        this.repoName = baseName(root.replace(/\\/g, "/"));
        const branchName = parsed.branch.name && parsed.branch.name !== "(detached)" ? parsed.branch.name : "";
        this.branch = branchName || "(detached HEAD)";
        this.branchRaw = branchName;
        this.upstream = parsed.branch.upstream;
        this.ahead = parsed.branch.ahead;
        this.behind = parsed.branch.behind;
        this.hasHead = parsed.branch.hasHead;
        this.staged = staged;
        this.changes = changes;
        this.notRepo = false;
        this.limited = parsed.files.length > MAX_FILES;
        this.error = null;
        this.watchRepo(root, cx);
        if (this.discardTarget && !changes.some((file) => file.path === this.discardTarget.path)) this.discardTarget = null;
        if (this.discardAll && !changes.length) this.discardAll = false;
        if (this.mode === "branches" && this.branches === null) this.loadBranches(cx);
        if (this.mode === "stashes" && this.stashes === null) this.loadStashes(cx);
      } catch (error) {
        if (this.context === ctx) {
          this.error = String(error);
          this.root = null;
          this.repoName = "";
          this.branch = "";
          this.branchRaw = "";
          this.upstream = "";
          this.ahead = 0;
          this.behind = 0;
          this.limited = false;
          this.staged = [];
          this.changes = [];
          this.notRepo = false;
        }
      } finally {
        if (this.context === ctx) this.loading = false;
        cx.notify();
      }
    });
  }

  watchRepo(root, cx) {
    if (this.context?.on || this.watched === root) return;
    this.watched = root;
    const ctx = this.context;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          if (this.context !== ctx || this.watched !== root) return;
          const pending = watchFolder(root);
          this.watchPromise = pending;
          await pending;
          if (this.context !== ctx || this.watched !== root) return;
          this.refresh(cx);
        }
      } catch {
        if (this.context === ctx && this.watched === root) this.watched = null;
      }
    });
  }

  // ---- actions ---------------------------------------------------------------

  setNote(text, kind) {
    this.note = text ? String(text).slice(0, 800) : null;
    this.noteKind = kind ?? "error";
  }

  stage(files, cx) {
    if (!this.root || !files.length || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["add", "-A", "--", ...files.map((file) => file.path)]);
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  stageAll(cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["add", "-A"]);
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  unstage(files, cx) {
    if (!this.root || !files.length || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const paths = files.map((file) => file.path);
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        let result = await gitRun(root, on, ["restore", "--staged", "--", ...paths]);
        if (result.code !== 0) result = await gitRun(root, on, ["reset", "--quiet", "HEAD", "--", ...paths]);
        if (result.code !== 0) throw new Error(gitError(result));
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  unstageAll(cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        let result = await gitRun(root, on, ["restore", "--staged", "."]);
        if (result.code !== 0) result = await gitRun(root, on, ["reset", "--quiet", "HEAD", "."]);
        if (result.code !== 0) throw new Error(gitError(result));
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  askDiscard(file, cx) {
    this.discardTarget = file;
    this.discardAll = false;
    this.note = null;
    cx.notify();
  }

  askDiscardAll(cx) {
    if (!this.changes.length) return;
    this.discardTarget = null;
    this.discardAll = true;
    this.note = null;
    cx.notify();
  }

  discard(cx) {
    const file = this.discardTarget;
    if (!this.root || !file || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const args = file.fresh ? ["clean", "-f", "--", file.path] : ["restore", "--worktree", "--", file.path];
        await mustGit(root, on, args);
        if (this.context === ctx) {
          this.discardTarget = null;
          this.setNote(`Discarded ${baseName(file.path)}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  discardAllChanges(cx) {
    if (!this.root || !this.changes.length || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const untracked = this.changes.some((file) => file.fresh);
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["restore", "--worktree", "--", "."]);
        if (untracked) await mustGit(root, on, ["clean", "-f", "-d"]);
        if (this.context === ctx) {
          this.discardAll = false;
          this.setNote("Discarded all changes", "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.root || this.busy || this.generating) return;
    if (!this.staged.length) {
      this.setNote("Stage changes before committing.", "error");
      cx.notify();
      return;
    }
    if (!this.message.trim()) {
      this.setNote("Write a commit message.", "error");
      cx.notify();
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const message = this.message.trim();
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const result = await gitRun(root, on, ["commit", "-m", message], 120000);
        if (result.code !== 0) throw new Error(gitError(result));
        const head = await gitRun(root, on, ["rev-parse", "--short", "HEAD"]);
        if (this.context === ctx) {
          this.message = "";
          this.messageState.set_value("");
          this.setNote(`Committed ${head.stdout.trim()}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  async collectDiff(root, on) {
    const options = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const text = (await gitRun(root, on, ["diff", "--cached", ...options])).stdout;
    return text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) + String.fromCharCode(10) + "[diff truncated]" : text;
  }

  generate(cx) {
    if (!this.root || this.busy || this.generating) return;
    if (!this.staged.length) {
      this.setNote("Stage changes before generating a message.", "error");
      cx.notify();
      return;
    }
    if (this.context?.on) {
      this.setNote("Generate commit messages from a local repository.", "error");
      cx.notify();
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.generating = true;
    this.note = null;
    cx.spawn(async (cx) => {
      let file = null;
      try {
        const diff = await this.collectDiff(root, on);
        if (!diff.trim()) throw new Error("No changes to describe");
        const dir = await tempDir();
        file = `${dir}/farrier-git-${Date.now()}-${Math.random().toString(16).slice(2)}.diff`;
        await writeTextFile(file, diff, null);
        const result = await runPi([
          "--print",
          "--no-session",
          "--no-tools",
          "--no-context-files",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--system-prompt",
          PI_SYSTEM,
          "--append-system-prompt",
          file,
          "Write the commit message for the changes in the system prompt.",
        ], root);
        if (result.code !== 0) throw new Error(gitError(result));
        const message = cleanMessage(result.stdout);
        if (!message) throw new Error("Pi returned no commit message");
        if (this.context === ctx) {
          this.message = message;
          this.messageState.set_value(message);
          this.setNote("Generated with Pi", "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (file) {
          try {
            if (window()?.platform === "windows") await exec("powershell", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${file.replace(/'/g, "''")}' -Force`]);
            else await exec("rm", ["-f", file]);
          } catch {}
        }
        if (this.context === ctx) this.generating = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  push(cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const branch = this.branchRaw;
    const upstream = this.upstream;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        if (!branch) throw new Error("Detached HEAD");
        if (upstream) await mustGit(root, on, ["push"], 180000);
        else await mustGit(root, on, ["push", "-u", "origin", branch], 180000);
        if (this.context === ctx) this.setNote(upstream ? "Pushed" : `Published ${branch}`, "success");
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  pull(cx) {
    if (!this.root || this.busy) return;
    if (!this.upstream) {
      this.setNote("No upstream branch. Push first.", "error");
      cx.notify();
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const behind = this.behind;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["pull", "--ff-only"], 180000);
        if (this.context === ctx) this.setNote(behind > 0 ? "Pulled" : "Up to date", "success");
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  fetchRemote(cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["fetch", "--all", "--prune"], 180000);
        if (this.context === ctx) {
          this.branches = null;
          this.setNote("Fetched", "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  loadStashes(cx) {
    if (this.mode === "diff" || this.stashLoading) return;
    if (!this.root) {
      this.stashError = "No repository";
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.stashLoading = true;
    this.stashError = null;
    cx.spawn(async (cx) => {
      try {
        const result = await gitRun(root, on, ["stash", "list", "--format=%gd%x09%gs%x09%ct"]);
        if (result.code !== 0) throw new Error(gitError(result));
        if (this.context !== ctx) return;
        this.stashes = result.stdout
          .split(String.fromCharCode(10))
          .map((line) => line.replace(String.fromCharCode(13), ""))
          .filter(Boolean)
          .map((line) => {
            const [ref, subject, at] = line.split(String.fromCharCode(9));
            return { ref, subject: subject ?? "", at: Number(at) || 0 };
          })
          .slice(0, 200);
        this.stashError = null;
      } catch (error) {
        if (this.context === ctx) this.stashError = String(error);
      } finally {
        if (this.context === ctx) this.stashLoading = false;
        cx.notify();
      }
    });
  }

  openStashes(cx, confirmAll = false) {
    if (this.mode === "diff" || this.busy || !this.root) return;
    this.mode = "stashes";
    this.menu = null;
    this.branchAction = null;
    this.branchSource = null;
    this.renaming = null;
    this.deleting = null;
    this.deletingRemote = null;
    this.stashConfirm = confirmAll ? "all" : null;
    this.stashError = null;
    this.stashes = null;
    this.loadStashes(cx);
    this.handle.focus();
    cx.notify();
  }

  closeStashes(cx) {
    this.mode = "changes";
    this.menu = null;
    this.branchAction = null;
    this.branchSource = null;
    this.renaming = null;
    this.deleting = null;
    this.deletingRemote = null;
    this.stashConfirm = null;
    this.handle.focus();
    cx.notify();
  }

  stashCreate(kind, cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const args = ["stash", "push"];
    if (kind === "untracked") args.push("-u");
    if (kind === "staged") args.push("--staged");
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, args, 120000);
        if (this.context === ctx) {
          this.stashes = null;
          this.setNote(kind === "untracked" ? "Stashed with untracked files" : kind === "staged" ? "Stashed staged changes" : "Stashed changes", "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.refresh(cx);
          if (this.mode === "stashes") this.loadStashes(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  stashApply(ref, pop, cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["stash", pop ? "pop" : "apply", ref], 120000);
        if (this.context === ctx) {
          this.stashes = null;
          this.setNote(`${pop ? "Popped" : "Applied"} ${ref}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.refresh(cx);
          if (this.mode === "stashes") this.loadStashes(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  stashDrop(ref, cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["stash", "drop", ref]);
        if (this.context === ctx) {
          this.stashConfirm = null;
          this.stashes = null;
          this.setNote(`Dropped ${ref}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.loadStashes(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  stashClear(cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["stash", "clear"]);
        if (this.context === ctx) {
          this.stashConfirm = null;
          this.stashes = null;
          this.setNote("Dropped all stashes", "success");
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error");
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.loadStashes(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  fetchBranches(cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["fetch", "--all", "--prune"], 180000);
        if (this.context === ctx) this.branches = null;
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.loadBranches(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  initRepo(cx) {
    if (!this.root && this.context?.cwd && !this.busy) {
      const ctx = this.context;
      const cwd = ctx.cwd;
      const on = ctx.on;
      this.busy = true;
      this.note = null;
      cx.spawn(async (cx) => {
        try {
          await mustGit(cwd, on, ["init"]);
          if (this.context === ctx) this.setNote("Initialized repository", "success");
        } catch (error) {
          if (this.context === ctx) this.setNote(String(error), "error");
        } finally {
          if (this.context === ctx) this.busy = false;
          this.refresh(cx);
          cx.notify();
        }
      });
      cx.notify();
    }
  }

  openDiff(file, staged, cx) {
    if (!this.root) return;
    openOverlay({
      mod: "farrier-git",
      kind: "window",
      key: "farrier-git-diff",
      width: 780,
      height: 680,
      frame: "none",
      props: {
        mode: "diff",
        root: this.root,
        on: this.context?.on ?? null,
        path: file.path,
        staged,
        fresh: Boolean(file.fresh),
        status: file.status,
      },
    });
    cx.notify();
  }

  // ---- branches --------------------------------------------------------------

  openStashMenu(cx) {
    if (!this.root || this.busy) return;
    this.menu = "stash";
    this.stashes = null;
    this.loadStashes(cx);
    cx.notify();
  }

  openBranches(cx, action = null) {
    if (this.mode === "diff" || this.busy) return;
    this.menu = null;
    if (this.mode === "branches" && !action) {
      if (this.branchAction) {
        this.branchAction = null;
        this.branchSource = null;
        this.renaming = null;
        this.deleting = null;
        this.deletingRemote = null;
        this.branchFilterText = "";
        this.branchFilter.set_value("");
        this.newBranchText = "";
        this.newBranch.set_value("");
        this.branches = null;
        this.loadBranches(cx);
        this.branchFilter.focus();
        cx.notify();
        return;
      }
      this.closeBranches(cx);
      return;
    }
    this.mode = "branches";
    this.branchAction = action;
    this.branchSource = null;
    this.stashConfirm = null;
    this.branchError = null;
    this.deletingRemote = null;
    this.renaming = null;
    this.deleting = null;
    this.branchFilterText = "";
    this.branchFilter.set_value("");
    this.newBranchText = "";
    this.newBranch.set_value("");
    this.branches = null;
    this.loadBranches(cx);
    if (action === "create") {
      this.newBranch.focus();
      cx.timer.after(80, () => this.newBranch.focus());
    } else {
      this.branchFilter.focus();
      cx.timer.after(80, () => this.branchFilter.focus());
    }
    cx.notify();
  }

  closeBranches(cx) {
    this.mode = "changes";
    this.menu = null;
    this.renaming = null;
    this.deleting = null;
    this.deletingRemote = null;
    this.branchAction = null;
    this.branchSource = null;
    this.handle.focus();
    cx.notify();
  }

  loadBranches(cx) {
    if (this.mode === "diff" || this.branchLoading) return;
    if (!this.root) {
      this.branchError = "No repository";
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.branchLoading = true;
    cx.spawn(async (cx) => {
      try {
        const [localResult, remoteResult] = await Promise.all([
          gitRun(root, on, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads"]),
          gitRun(root, on, ["for-each-ref", `--format=${REMOTE_FORMAT}`, "refs/remotes"]),
        ]);
        if (localResult.code !== 0) throw new Error(gitError(localResult));
        if (this.context !== ctx) return;
        const local = parseLocalRefs(localResult.stdout);
        local.sort((a, b) => Number(b.current) - Number(a.current) || b.at - a.at);
        this.branches = {
          local,
          remote: remoteResult.code === 0 ? parseRemoteRefs(remoteResult.stdout).slice(0, 250) : [],
        };
        this.branchError = null;
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) this.branchLoading = false;
        cx.notify();
      }
    });
  }

  branchChoices() {
    if (!this.branches) return [];
    const action = this.branchAction;
    const filter = this.branchFilterText.trim().toLowerCase();
    const match = (branch) => !filter || branch.name.toLowerCase().includes(filter);
    const wantLocal = action !== "deleteRemote";
    const wantRemote = !action || action === "createFrom" || action === "deleteRemote";
    let local = wantLocal ? this.branches.local.filter(match) : [];
    if (action === "merge" || action === "rebase" || action === "delete") local = local.filter((branch) => !branch.current);
    const remote = wantRemote ? this.branches.remote.filter(match) : [];
    const rows = [];
    if (local.length) {
      rows.push({ kind: "head", label: "Local" });
      for (const branch of local) rows.push({ kind: "local", ...branch });
    }
    if (remote.length) {
      rows.push({ kind: "head", label: "Remotes" });
      for (const branch of remote) rows.push({ kind: "remote", ...branch });
    }
    return rows;
  }

  pickBranch(branch, cx) {
    if (!branch || branch.kind === "head" || this.busy) return;
    switch (this.branchAction) {
      case "merge":
        if (!branch.current) this.mergeBranch(branch, cx);
        return;
      case "rebase":
        if (!branch.current) this.rebaseBranch(branch, cx);
        return;
      case "delete":
        if (!branch.current) this.askDelete(branch, cx);
        return;
      case "deleteRemote":
        this.askDeleteRemote(branch, cx);
        return;
      case "rename":
        if (branch.kind === "local") this.startRename(branch, cx);
        return;
      case "create":
      case "createFrom":
        this.branchSource = branch;
        this.newBranchText = "";
        this.newBranch.set_value("");
        this.newBranch.focus();
        cx.notify();
        return;
      default:
        this.checkout(branch, cx);
    }
  }

  mergeBranch(branch, cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["merge", "--no-edit", branch.name], 180000);
        if (this.context === ctx) {
          this.mode = "changes";
          this.branchAction = null;
          this.setNote(`Merged ${branch.name}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.refresh(cx);
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  rebaseBranch(branch, cx) {
    if (!this.root || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["rebase", branch.name], 180000);
        if (this.context === ctx) {
          this.mode = "changes";
          this.branchAction = null;
          this.setNote(`Rebased onto ${branch.name}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.refresh(cx);
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  checkout(branch, cx) {
    if (!this.root || this.busy || branch.kind === "head") return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    let target = branch.name;
    let args = ["switch", branch.name];
    if (branch.kind === "remote") {
      const localName = branch.name.split("/").slice(1).join("/");
      const localExists = this.branches?.local.some((item) => item.name === localName);
      if (localExists) {
        target = localName;
        args = ["switch", localName];
      } else {
        args = ["switch", "--track", branch.name];
      }
    }
    if (!branch.remote && branch.current) {
      this.closeBranches(cx);
      return;
    }
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, args);
        if (this.context === ctx) {
          this.mode = "changes";
          this.branches = null;
          this.setNote(`Checked out ${target}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  createBranch(cx) {
    if (!this.root || this.busy) return;
    const name = this.newBranchText.trim();
    if (!name) {
      this.branchError = "Type a branch name";
      cx.notify();
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const source = this.branchSource?.name;
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, source ? ["switch", "-c", name, source] : ["switch", "-c", name]);
        if (this.context === ctx) {
          this.mode = "changes";
          this.branchAction = null;
          this.branchSource = null;
          this.branches = null;
          this.newBranchText = "";
          this.newBranch.set_value("");
          this.setNote(source ? `Created ${name} from ${source}` : `Created ${name}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  startRename(branch, cx) {
    this.renaming = branch.name;
    this.deleting = null;
    this.deletingRemote = null;
    this.renameText = branch.name;
    this.renameInput.set_value(branch.name);
    this.renameInput.set_selected_range({ start: 0, end: branch.name.length });
    this.renameInput.focus();
    cx.timer.after(80, () => this.renameInput.focus());
    cx.notify();
  }

  renameBranch(cx) {
    if (!this.root || !this.renaming || this.busy) return;
    const oldName = this.renaming;
    const newName = this.renameText.trim() || this.renameInput.value().trim();
    if (!newName || newName === oldName) {
      this.renaming = null;
      cx.notify();
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["branch", "-m", oldName, newName]);
        if (this.context === ctx) {
          this.renaming = null;
          this.branches = null;
          this.setNote(`Renamed to ${newName}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.refresh(cx);
          this.loadBranches(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  askDelete(branch, cx) {
    this.deleting = branch.name;
    this.deletingRemote = null;
    this.renaming = null;
    cx.notify();
  }

  askDeleteRemote(branch, cx) {
    if (branch.kind !== "remote") return;
    this.deletingRemote = branch.name;
    this.deleting = null;
    this.renaming = null;
    cx.notify();
  }

  deleteRemoteBranch(cx) {
    if (!this.root || !this.deletingRemote || this.busy) return;
    const name = this.deletingRemote;
    const slash = name.indexOf("/");
    if (slash < 1 || slash === name.length - 1) {
      this.branchError = `Cannot parse remote branch ${name}`;
      cx.notify();
      return;
    }
    const remote = name.slice(0, slash);
    const branchName = name.slice(slash + 1);
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["push", remote, "--delete", branchName], 180000);
        if (this.context === ctx) {
          this.deletingRemote = null;
          this.branches = null;
          this.setNote(`Deleted remote branch ${name}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.refresh(cx);
          this.loadBranches(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  deleteBranch(cx) {
    if (!this.root || !this.deleting || this.busy) return;
    const name = this.deleting;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["branch", "-d", name]);
        if (this.context === ctx) {
          this.deleting = null;
          this.branches = null;
          this.setNote(`Deleted ${name}`, "success");
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = String(error);
      } finally {
        if (this.context === ctx) {
          this.busy = false;
          this.refresh(cx);
          this.loadBranches(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  // ---- diff window -----------------------------------------------------------

  loadDiff(cx) {
    const diff = this.diff;
    cx.spawn(async (cx) => {
      try {
        let lines;
        if (diff.fresh) {
          const content = await readTextFile(`${diff.root}/${diff.path}`, { on: diff.on });
          if (content === null) lines = ["Cannot preview this file (missing or unreadable)"];
          else if (content.includes("\0")) lines = ["Binary file · no text diff"];
          else {
            lines = [`@@ -0,0 +1,${countLines(content)} @@`, ...content.replace(/\r?\n/g, "\n").replace(/\n$/, "").split("\n").slice(0, 4000).map((line) => `+${line}`)];
          }
        } else {
          const args = ["diff", ...(diff.staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--", diff.path];
          const result = await gitRun(diff.root, diff.on, args);
          if (result.code !== 0) throw new Error(gitError(result));
          const all = result.stdout.replace(/\r?\n/g, "\n").replace(/\n$/, "").split("\n");
          const first = all.findIndex((line) => line.startsWith("@@"));
          lines = first < 0 ? ["No text diff available"] : all.slice(first);
        }
        diff.rows = diffRows(lines.slice(0, 5000).map((line) => (line.length > 4000 ? `${line.slice(0, 4000)}… (line truncated)` : line)));
        diff.width = Math.max(620, ...diff.rows.map((row) => (row.text.length + 1) * 7 + 56));
        diff.error = null;
      } catch (error) {
        diff.error = String(error);
        diff.rows = [];
      } finally {
        cx.notify();
      }
    });
  }

  renderDiff(t, cx) {
    const diff = this.diff;
    const name = baseName(diff?.path ?? "");
    const directory = dirName(diff?.path ?? "");
    const file = { path: diff?.path ?? "", status: diff?.status ?? "M", fresh: diff?.fresh, conflict: false };
    return v_flex()
      .id("farrier-git-diff")
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12)
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          closeOverlay(props().overlay);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(44)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(fileIcon(t, file.path))
          .child(div().flex_none().font_semibold().child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(directory ? `${directory}/` : ""))
          .child(pill(t, diff?.staged ? "Staged" : "Changes", diff?.staged ? t.accent : t.working))
          .when(Boolean(diff?.error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(diff.error)))
          .child(iconButton(t, "farrier-git-diff-close", "x", "Close", () => closeOverlay(props().overlay), { stopDrag: true })),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .font_family(settings().font_family ?? "JetBrains Mono")
          .text_size(11)
          .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
          .child(
            div()
              .id("farrier-git-diff-x")
              .size_full()
              .overflow_x_scrollbar()
              .child(
                div()
                  .w_full()
                  .min_w(diff?.width ?? 620)
                  .h_full()
                  .child(
                    v_virtual_list(
                      "farrier-git-diff-rows",
                      diff?.rows.length ?? 0,
                      20,
                      (index) => String(index),
                      (range) => diff.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t)),
                    ).size_full(),
                  ),
              ),
          )
          .when(!diff?.rows.length, (el) => el.child(div().absolute().top(10).left(12).text_color(t.dim).child(diff?.error || "No text diff available"))),
      );
  }

  diffRow(row, t) {
    if (row.kind === "@") {
      return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
    }
    return h_flex()
      .w_full()
      .h(20)
      .flex_none()
      .gap(10)
      .when(row.kind === "+", (el) => el.bg(t.ansi2 + "18"))
      .when(row.kind === "-", (el) => el.bg(t.ansi1 + "18"))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(row.number === undefined ? "" : String(row.number)))
      .child(div().flex_1().min_w(0).truncate().child(row.text));
  }

  // ---- rendering -------------------------------------------------------------

  render(cx) {
    const t = theme();
    if (this.mode === "diff") return this.renderDiff(t, cx);
    this.watchCommands(cx);
    if (!checking() && this.panelShown() && (this.stale || this.context?.key !== contextKey())) {
      this.stale = false;
      this.refresh(cx);
    }
    if (this.mode === "branches") return this.renderBranches(t, cx);
    if (this.mode === "stashes") return this.renderStashes(t, cx);
    return this.renderChanges(t, cx);
  }

  renderMenu(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    const hasStashes = Boolean(this.stashes?.length);
    const item = (id, iconName, label, onClick, options = {}) => {
      const disabled = Boolean(options.disabled);
      let el = h_flex()
        .id(`farrier-git-menu-${id}`)
        .h(31)
        .flex_none()
        .px(9)
        .gap(8)
        .items_center()
        .rounded(7)
        .text_size(11.5)
        .text_color(disabled ? t.dim : t.foreground)
        .tooltip(options.hint ?? label)
        .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)));
      if (disabled) el = el.disabled(true).opacity(0.5);
      else {
        el = el.on_click((_event, cx) => {
          if (!options.keepOpen) {
            this.menu = null;
            cx.notify();
          }
          onClick(cx);
        });
      }
      el = el
        .child(icon(iconName, disabled ? t.dim : t.muted, 14))
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(Boolean(options.trailing), (e) => e.child(div().text_size(10).text_color(t.dim).child(options.trailing)))
        .when(Boolean(options.chevron), (e) => e.child(icon("chevron-right", t.dim, 12)));
      return el;
    };
    const separator = () => div().h(1).mx(6).my(4).bg(t.border);
    const root = this.menu === "root";
    return div()
      .id("farrier-git-menu")
      .w(240)
      .max_h(470)
      .overflow_y_scrollbar()
      .p(5)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .shadow_lg()
      .when(root, (el) =>
        el.children([
          item("commit", "commit", "Commit", (cx) => this.commit(cx), {
            disabled: busy || !this.staged.length || !this.message.trim(),
            trailing: this.staged.length ? String(this.staged.length) : "",
            hint: "Commit staged changes",
          }),
          separator(),
          item("push", "arrow-up", this.upstream ? "Push" : "Publish branch", (cx) => this.push(cx), {
            disabled: busy || !this.branchRaw,
            trailing: this.ahead > 0 ? String(this.ahead) : "",
            hint: this.upstream ? "Push to upstream" : "Push and set upstream",
          }),
          item("pull", "arrow-down", "Pull", (cx) => this.pull(cx), {
            disabled: busy || !this.upstream,
            trailing: this.behind > 0 ? String(this.behind) : "",
            hint: this.upstream ? "Pull with --ff-only" : "Publish the branch first",
          }),
          item("fetch", "refresh", "Fetch", (cx) => this.fetchRemote(cx), { disabled: busy, hint: "Fetch all remotes and prune" }),
          separator(),
          item("branches", "branch", "Branches…", (cx) => {
            this.menu = "branch";
            cx.notify();
          }, { disabled: busy, keepOpen: true, chevron: true }),
          item("stash", "archive", "Stash…", (cx) => this.openStashMenu(cx), { disabled: busy, keepOpen: true, chevron: true }),
        ]),
      )
      .when(this.menu === "branch", (el) =>
        el.children([
          item("branch-back", "chevron-left", "Back", (cx) => {
            this.menu = "root";
            cx.notify();
          }, { keepOpen: true }),
          h_flex()
            .h(28)
            .flex_none()
            .px(9)
            .gap(7)
            .items_center()
            .text_size(10.5)
            .font_semibold()
            .text_color(t.dim)
            .child(icon("branch", t.dim, 13))
            .child("Branch"),
          separator(),
          item("merge", "merge", "Merge…", (cx) => this.openBranches(cx, "merge"), { disabled: busy, hint: `Merge a local branch into ${this.branchRaw || "HEAD"}` }),
          item("rebase", "rebase", "Rebase branch…", (cx) => this.openBranches(cx, "rebase"), { disabled: busy, hint: `Rebase ${this.branchRaw || "HEAD"} onto a local branch` }),
          separator(),
          item("create-branch", "plus", "Create branch…", (cx) => this.openBranches(cx, "create"), { disabled: busy, hint: "Type a new branch name" }),
          item("create-from", "branch", "Create branch from…", (cx) => this.openBranches(cx, "createFrom"), { disabled: busy, hint: "Pick a source branch" }),
          separator(),
          item("rename-branch", "pencil", "Rename branch…", (cx) => this.openBranches(cx, "rename"), { disabled: busy }),
          item("delete-branch", "trash", "Delete branch…", (cx) => this.openBranches(cx, "delete"), { disabled: busy }),
          item("delete-remote", "trash", "Delete remote branch…", (cx) => this.openBranches(cx, "deleteRemote"), { disabled: busy }),
          separator(),
          item("publish", "arrow-up", "Publish branch…", (cx) => this.push(cx), { disabled: busy || !this.branchRaw, hint: this.upstream ? "Push to upstream" : "Push and set upstream" }),
          item("view-branches", "branch", "View branches…", (cx) => this.openBranches(cx), { disabled: busy }),
        ]),
      )
      .when(this.menu === "stash", (el) =>
        el.children([
          item("stash-back", "chevron-left", "Back", (cx) => {
            this.menu = "root";
            cx.notify();
          }, { keepOpen: true }),
          h_flex()
            .h(28)
            .flex_none()
            .px(9)
            .gap(7)
            .items_center()
            .text_size(10.5)
            .font_semibold()
            .text_color(t.dim)
            .child(icon("archive", t.dim, 13))
            .child("Stash"),
          separator(),
          item("stash-tracked", "archive", "Stash", (cx) => this.stashCreate("tracked", cx), { disabled: busy, hint: "Stash tracked changes" }),
          item("stash-untracked", "archive", "Stash including untracked", (cx) => this.stashCreate("untracked", cx), { disabled: busy, hint: "Stash tracked and untracked changes" }),
          item("stash-staged", "archive", "Stash staged", (cx) => this.stashCreate("staged", cx), { disabled: busy, hint: "Stash staged changes only" }),
          separator(),
          item("apply-latest", "arrow-down", "Apply latest", (cx) => this.stashApply("stash@{0}", false, cx), {
            disabled: busy || !hasStashes,
            hint: hasStashes ? "Apply the newest stash" : "No stashes",
          }),
          item("apply-list", "arrow-down", "Apply stash…", (cx) => this.openStashes(cx), { disabled: busy }),
          separator(),
          item("pop-latest", "arrow-up", "Pop latest", (cx) => this.stashApply("stash@{0}", true, cx), {
            disabled: busy || !hasStashes,
            hint: hasStashes ? "Apply and drop the newest stash" : "No stashes",
          }),
          item("pop-list", "arrow-up", "Pop stash…", (cx) => this.openStashes(cx), { disabled: busy }),
          separator(),
          item("drop-list", "trash", "Drop stash…", (cx) => this.openStashes(cx), { disabled: busy }),
          item("drop-all", "trash", "Drop all stashes…", (cx) => this.openStashes(cx, true), { disabled: busy || !hasStashes }),
          item("view-stashes", "archive", "View stashes…", (cx) => this.openStashes(cx), { disabled: busy }),
        ]),
      );
  }

  renderHeader(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    return h_flex()
      .h(42)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(icon("branch", t.accent, 15))
      .child(div().flex_none().font_semibold().text_size(13).child("Source Control"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(10.5).text_color(t.dim).child(this.repoName))
      .when(busy, (el) => el.child(svg(ICON("spinner")).size(14).flex_none().text_color(t.muted).spin(800)))
      .child(iconButton(t, "farrier-git-refresh", "refresh", "Refresh", (cx) => this.refresh(cx), { disabled: busy }))
      .when(Boolean(this.root), (el) =>
        el.child(
          Popover.new("farrier-git-more")
            .anchor("top_right")
            .open(Boolean(this.menu))
            .on_open_change((open, cx) => {
              if (!open) this.menu = null;
              else if (!this.menu) this.menu = "root";
              cx.notify();
            })
            .trigger(menuTrigger(t))
            .when(Boolean(this.menu), (e) => e.content(this.renderMenu(t, cx))),
        ),
      );
  }

  renderBranchBar(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    return h_flex()
      .h(38)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("farrier-git-branch")
          .h(28)
          .flex_1()
          .min_w(0)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(8)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_event, cx) => this.openBranches(cx))
          .tooltip("Branches")
          .child(icon("branch", t.accent, 13))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(this.branch || "No branch"))
          .when(this.ahead > 0, (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(10).text_color(t.ansi2).child(icon("arrow-up", t.ansi2, 11)).child(String(this.ahead))))
          .when(this.behind > 0, (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(10).text_color(t.ansi1).child(icon("arrow-down", t.ansi1, 11)).child(String(this.behind))))
          .child(icon("chevron-down", t.dim, 12)),
      );
  }

  renderChanges(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    return v_flex()
      .id("farrier-git")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12.5)
      .relative()
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(this.renderHeader(t, cx))
      .when(Boolean(this.root), (el) => el.child(this.renderBranchBar(t, cx)))
      .when(!this.root, (el) => el.child(this.renderEmpty(t, cx)))
      .when(Boolean(this.root), (el) =>
        el.child(
          v_flex()
            .flex_1()
            .min_h(0)
            .child(this.renderCommit(t, cx))
            .child(this.renderFiles(t, cx)),
        ),
      );
  }

  renderEmpty(t, cx) {
    const busy = this.loading || this.busy;
    if (busy) {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(10)
        .child(svg(ICON("spinner")).size(20).text_color(t.muted).spin(800))
        .child(div().text_size(11.5).text_color(t.dim).child("Loading repository"));
    }
    if (!this.context?.cwd) {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .p(22)
        .gap(10)
        .child(icon("branch", t.dim, 24))
        .child(div().text_size(12).text_color(t.muted).child("No folder"))
        .child(div().text_size(11).text_color(t.dim).child("Focus a pane in a folder"));
    }
    if (this.notRepo) {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .p(22)
        .gap(10)
        .child(icon("branch", t.dim, 24))
        .child(div().text_size(12).text_color(t.muted).child("Not a git repository"))
        .child(button(t, "farrier-git-init", "Initialize repository", "outline", (cx) => this.initRepo(cx), { disabled: busy, px: 10 }))
        .when(Boolean(this.note), (el) => el.child(div().text_size(11).text_color(this.noteKind === "success" ? t.done : t.blocked).child(this.note)));
    }
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .p(22)
      .gap(10)
      .child(icon("branch", t.dim, 24))
      .child(div().text_size(12).text_color(t.muted).child(this.error ? "Cannot read this repository" : "No repository"))
      .when(Boolean(this.error), (el) => el.child(div().text_size(10.5).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.note), (el) => el.child(div().text_size(10.5).text_color(this.noteKind === "success" ? t.done : t.blocked).child(this.note)));
  }

  renderFiles(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    const rows = [];
    if (this.staged.length) rows.push(this.group(t, "staged", "Staged Changes", this.staged, busy, cx));
    if (this.changes.length) rows.push(this.group(t, "changes", "Changes", this.changes, busy, cx));
    return v_flex()
      .id("farrier-git-files")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(6)
      .gap(2)
      .when(Boolean(this.discardTarget), (el) => el.child(this.renderDiscard(t, cx)))
      .when(Boolean(this.discardAll), (el) => el.child(this.renderDiscardAll(t, cx)))
      .children(rows)
      .when(Boolean(this.error), (el) => el.child(div().p(8).text_size(11).text_color(t.blocked).child(this.error)))
      .when(!this.staged.length && !this.changes.length && !this.loading && !this.error, (el) => el.child(this.renderClean(t)))
      .when(this.limited, (el) => el.child(div().px(8).py(6).text_size(10.5).text_color(t.dim).child(`Showing the first ${MAX_FILES} changed files`)));
  }

  renderClean(t) {
    return v_flex()
      .items_center()
      .justify_center()
      .py(26)
      .gap(8)
      .child(icon("check", t.done, 22))
      .child(div().text_size(11.5).text_color(t.muted).child("No changes"))
      .child(div().text_size(10.5).text_color(t.dim).child("Working tree clean"));
  }

  renderDiscard(t, cx) {
    const file = this.discardTarget;
    return h_flex()
      .id("farrier-git-discard")
      .flex_none()
      .px(8)
      .py(7)
      .gap(7)
      .items_center()
      .rounded(8)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .child(icon("undo", t.blocked, 13))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(`Discard changes in ${baseName(file.path)}?`))
      .child(button(t, "farrier-git-discard-no", "Cancel", "ghost", (cx) => { this.discardTarget = null; cx.notify(); }, { h: 26, px: 8 }))
      .child(button(t, "farrier-git-discard-yes", "Discard", "danger", (cx) => this.discard(cx), { h: 26, px: 8 }));
  }

  renderDiscardAll(t, cx) {
    const untracked = this.changes.some((file) => file.fresh);
    return h_flex()
      .id("farrier-git-discard-all-confirm")
      .flex_none()
      .px(8)
      .py(7)
      .gap(7)
      .items_center()
      .rounded(8)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .child(icon("undo", t.blocked, 13))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(untracked ? "Discard all changes and delete untracked files?" : "Discard all changes?"))
      .child(button(t, "farrier-git-discard-all-no", "Cancel", "ghost", (cx) => { this.discardAll = false; cx.notify(); }, { h: 26, px: 8 }))
      .child(button(t, "farrier-git-discard-all-yes", "Discard", "danger", (cx) => this.discardAllChanges(cx), { h: 26, px: 8 }));
  }

  group(t, kind, label, files, busy, cx) {
    const add = files.reduce((sum, file) => sum + (file.add || 0), 0);
    const del = files.reduce((sum, file) => sum + (file.del || 0), 0);
    return v_flex()
      .id(`farrier-git-${kind}`)
      .flex_none()
      .gap(1)
      .child(
        h_flex()
          .h(30)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .text_size(10.5)
          .font_semibold()
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_event, cx) => {
            this.folded[kind] = !this.folded[kind];
            cx.notify();
          })
          .child(icon(this.folded[kind] ? "chevron-right" : "chevron-down", t.dim, 12))
          .child(label)
          .child(pill(t, String(files.length), t.muted))
          .child(div().flex_1())
          .when(add > 0, (el) => el.child(div().text_size(10).text_color(t.ansi2).child(`+${add}`)))
          .when(del > 0, (el) => el.child(div().text_size(10).text_color(t.ansi1).child(`−${del}`)))
          .child(iconButton(t, `farrier-git-all-${kind}`, kind === "staged" ? "minus" : "plus", kind === "staged" ? "Unstage all" : "Stage all", (cx) => (kind === "staged" ? this.unstageAll(cx) : this.stageAll(cx)), { disabled: busy, size: 24, glyphSize: 13, stopDrag: true }))
          .when(kind === "changes", (el) => el.child(iconButton(t, "farrier-git-discard-all", "undo", "Discard all changes", (cx) => this.askDiscardAll(cx), { disabled: busy, size: 24, glyphSize: 13, stopDrag: true }))),
      )
      .when(!this.folded[kind], (el) => el.children(files.map((file) => this.fileRow(t, kind, file, busy, cx))));
  }

  fileRow(t, kind, file, busy, cx) {
    const name = baseName(file.path);
    const directory = dirName(file.path);
    const color = statusColor(t, file);
    const staged = kind === "staged";
    return h_flex()
      .id(`farrier-git-${kind}-${file.path}`)
      .h(36)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => this.openDiff(file, staged, cx))
      .child(fileIcon(t, file.path))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name))
          .when(Boolean(directory), (el) => el.child(div().flex_none().max_w(86).truncate().text_size(10).text_color(t.dim).child(directory))),
      )
      .child(div().w(12).flex_none().text_size(10.5).font_semibold().text_color(color).child(statusLetter(file)))
      .when(file.add > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.ansi1).child(`−${file.del}`)))
      .child(iconButton(t, `farrier-git-toggle-${kind}-${file.path}`, staged ? "minus" : "plus", staged ? "Unstage file" : "Stage file", (cx) => (staged ? this.unstage([file], cx) : this.stage([file], cx)), { disabled: busy, size: 22, glyphSize: 12, stopDrag: true }))
      .when(!staged, (el) => el.child(iconButton(t, `farrier-git-discard-${file.path}`, "undo", "Discard changes in file", (cx) => this.askDiscard(file, cx), { disabled: busy, size: 22, glyphSize: 12, stopDrag: true })));
  }

  renderCommit(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    const hasStaged = Boolean(this.staged.length);
    const canCommit = Boolean(this.message.trim() && hasStaged && !busy);
    return v_flex()
      .flex_none()
      .p(10)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        div()
          .id("farrier-git-message")
          .rounded(9)
          .border_1()
          .border_color(this.focused.message ? t.accent : t.input)
          .bg(t.background)
          .px(9)
          .py(5)
          .cursor_text()
          .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
          .child(Textarea.new(this.messageState).w_full().h(66).text_size(12).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(button(t, "farrier-git-generate", this.generating ? "Generating…" : "Generate", "secondary", (cx) => this.generate(cx), { iconName: "sparkles", disabled: busy || !hasStaged, h: 30, px: 9, hint: hasStaged ? "Generate a commit message with Pi from staged changes" : "Stage changes before generating a message" }))
          .child(div().flex_1())
          .child(div().text_size(10).text_color(t.dim).child(this.staged.length ? `${this.staged.length} staged` : ""))
          .child(button(t, "farrier-git-commit", "Commit", "primary", (cx) => this.commit(cx), { disabled: !canCommit, h: 30, px: 12, hint: "Commit staged changes (Ctrl+Enter)" })),
      )
      .when(Boolean(this.note), (el) => el.child(div().text_size(10.5).text_color(this.noteKind === "success" ? t.done : t.blocked).child(this.note)));
  }

  renderStashes(t, cx) {
    const busy = this.loading || this.busy;
    const stashes = this.stashes ?? [];
    const confirm = this.stashConfirm;
    const row = (stash, index) => {
      return h_flex()
        .id(`farrier-git-stash-${index}`)
        .flex_none()
        .px(8)
        .py(6)
        .gap(8)
        .items_center()
        .rounded(8)
        .hover((s) => s.bg(t.hover))
        .child(icon("archive", t.muted, 14))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(1)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().flex_none().text_size(11).font_semibold().child(stash.ref))
                .when(stash.at > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(ago(stash.at)))),
            )
            .child(div().text_size(10.5).text_color(t.dim).truncate().child(stash.subject)),
        )
        .child(iconButton(t, `farrier-git-stash-apply-${index}`, "arrow-down", "Apply stash", (cx) => this.stashApply(stash.ref, false, cx), { disabled: busy, size: 22, glyphSize: 12, color: t.ansi2, stopDrag: true }))
        .child(iconButton(t, `farrier-git-stash-pop-${index}`, "arrow-up", "Pop stash", (cx) => this.stashApply(stash.ref, true, cx), { disabled: busy, size: 22, glyphSize: 12, color: t.accent, stopDrag: true }))
        .child(iconButton(t, `farrier-git-stash-drop-${index}`, "trash", "Drop stash", (cx) => { this.stashConfirm = stash.ref; cx.notify(); }, { disabled: busy, size: 22, glyphSize: 12, color: t.blocked, stopDrag: true }));
    };
    return v_flex()
      .id("farrier-git-stashes")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(iconButton(t, "farrier-git-stash-back", "chevron-left", "Back", (cx) => this.closeStashes(cx)))
          .child(div().flex_none().font_semibold().text_size(13).child("Stashes"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(10.5).text_color(t.dim).child(this.repoName))
          .when(busy || this.stashLoading, (el) => el.child(svg(ICON("spinner")).size(14).flex_none().text_color(t.muted).spin(800)))
          .child(iconButton(t, "farrier-git-stash-refresh", "refresh", "Refresh stashes", (cx) => this.loadStashes(cx), { disabled: busy || this.stashLoading })),
      )
      .when(Boolean(this.stashError), (el) => el.child(div().px(12).pb(6).text_size(10.5).text_color(t.blocked).child(this.stashError)))
      .when(Boolean(this.note), (el) => el.child(div().px(12).pb(6).text_size(10.5).text_color(this.noteKind === "success" ? t.done : t.blocked).child(this.note)))
      .when(Boolean(confirm), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .mx(10)
            .mb(6)
            .px(8)
            .py(7)
            .gap(7)
            .items_center()
            .rounded(8)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .child(icon("trash", t.blocked, 13))
            .child(div().flex_1().min_w(0).truncate().text_size(11).child(confirm === "all" ? "Drop all stashes?" : `Drop ${confirm}?`))
            .child(button(t, "farrier-git-stash-confirm-no", "Cancel", "ghost", (cx) => { this.stashConfirm = null; cx.notify(); }, { h: 26, px: 8 }))
            .child(button(t, "farrier-git-stash-confirm-yes", confirm === "all" ? "Drop all" : "Drop", "danger", (cx) => (confirm === "all" ? this.stashClear(cx) : this.stashDrop(confirm, cx)), { h: 26, px: 8 })),
        ),
      )
      .child(
        v_flex()
          .id("farrier-git-stash-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
          .gap(1)
          .when(this.stashes === null && this.stashLoading, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("Loading stashes")))
          .when(this.stashes !== null && stashes.length === 0, (el) =>
            el.child(
              v_flex()
                .items_center()
                .justify_center()
                .py(26)
                .gap(8)
                .child(icon("archive", t.dim, 22))
                .child(div().text_size(11.5).text_color(t.muted).child("No stashes")),
            ),
          )
          .children(stashes.map((stash, index) => row(stash, index))),
      )
      .child(
        h_flex()
          .flex_none()
          .p(10)
          .gap(6)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .child(button(t, "farrier-git-stash-new", "Stash", "secondary", (cx) => this.stashCreate("tracked", cx), { iconName: "archive", h: 30, px: 8, disabled: busy, hint: "Stash tracked changes" }))
          .child(button(t, "farrier-git-stash-new-u", "With untracked", "ghost", (cx) => this.stashCreate("untracked", cx), { h: 30, px: 6, disabled: busy, hint: "Stash including untracked files" }))
          .child(button(t, "farrier-git-stash-new-staged", "Staged only", "ghost", (cx) => this.stashCreate("staged", cx), { h: 30, px: 6, disabled: busy, hint: "Stash staged changes only" })),
      );
  }

  branchTitle() {
    switch (this.branchAction) {
      case "merge": return `Merge into ${this.branchRaw || "HEAD"}`;
      case "rebase": return `Rebase ${this.branchRaw || "HEAD"}`;
      case "create": return "Create branch";
      case "createFrom": return "Create branch from";
      case "rename": return "Rename branch";
      case "delete": return "Delete branch";
      case "deleteRemote": return "Delete remote branch";
      default: return "Branches";
    }
  }

  branchHint() {
    switch (this.branchAction) {
      case "merge": return `Pick a local branch to merge into ${this.branchRaw || "HEAD"}`;
      case "rebase": return `Pick a local branch to rebase ${this.branchRaw || "HEAD"} onto`;
      case "rename": return "Pick a branch to rename";
      case "delete": return "Pick a local branch to delete";
      case "deleteRemote": return "Pick a remote branch to delete";
      case "create": return "Type a new branch name";
      case "createFrom": return this.branchSource ? `From ${this.branchSource.name}` : "Pick a source branch";
      default: return "";
    }
  }

  // ---- branches rendering ----------------------------------------------------

  renderBranches(t, cx) {
    const busy = this.loading || this.busy;
    const choices = this.branchChoices();
    return v_flex()
      .id("farrier-git-branches")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(iconButton(t, "farrier-git-back", "chevron-left", "Back", (cx) => this.closeBranches(cx)))
          .child(div().flex_none().font_semibold().text_size(13).child(this.branchTitle()))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(10.5).text_color(t.dim).child(this.repoName))
          .when(busy || this.branchLoading, (el) => el.child(svg(ICON("spinner")).size(14).text_color(t.muted).spin(800)))
          .child(iconButton(t, "farrier-git-fetch", "refresh", "Fetch branches", (cx) => this.fetchBranches(cx), { disabled: busy })),
      )
      .child(
        h_flex()
          .flex_none()
          .px(10)
          .pt(8)
          .pb(4)
          .child(
            div()
              .flex_1()
              .h(32)
              .rounded(9)
              .border_1()
              .border_color(this.focused.filter ? t.accent : t.input)
              .bg(t.background)
              .px(8)
              .child(Input.new(this.branchFilter).size_full().text_size(11.5).text_color(t.foreground)),
          ),
      )
      .when(Boolean(this.branchAction), (el) => el.child(div().px(12).pb(6).text_size(10.5).text_color(t.dim).child(this.branchHint())))
      .when(Boolean(this.branchError), (el) => el.child(div().px(12).pb(6).text_size(10.5).text_color(t.blocked).child(this.branchError)))
      .when(Boolean(this.note), (el) => el.child(div().px(12).pb(6).text_size(10.5).text_color(this.noteKind === "success" ? t.done : t.blocked).child(this.note)))
      .when(Boolean(this.deleting), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .mx(10)
            .mb(6)
            .px(8)
            .py(7)
            .gap(7)
            .items_center()
            .rounded(8)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .child(icon("trash", t.blocked, 13))
            .child(div().flex_1().min_w(0).truncate().text_size(11).child(`Delete branch ${this.deleting}?`))
            .child(button(t, "farrier-git-delete-no", "Cancel", "ghost", (cx) => { this.deleting = null; cx.notify(); }, { h: 26, px: 8 }))
            .child(button(t, "farrier-git-delete-yes", "Delete", "danger", (cx) => this.deleteBranch(cx), { h: 26, px: 8 })),
        ),
      )
      .when(Boolean(this.deletingRemote), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .mx(10)
            .mb(6)
            .px(8)
            .py(7)
            .gap(7)
            .items_center()
            .rounded(8)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .child(icon("trash", t.blocked, 13))
            .child(div().flex_1().min_w(0).truncate().text_size(11).child(`Delete remote branch ${this.deletingRemote}?`))
            .child(button(t, "farrier-git-delete-remote-no", "Cancel", "ghost", (cx) => { this.deletingRemote = null; cx.notify(); }, { h: 26, px: 8 }))
            .child(button(t, "farrier-git-delete-remote-yes", "Delete", "danger", (cx) => this.deleteRemoteBranch(cx), { h: 26, px: 8 })),
        ),
      )
      .child(
        v_flex()
          .id("farrier-git-branch-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
          .gap(1)
          .when(this.branches === null && this.branchLoading, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("Loading branches")))
          .when(this.branches === null && !this.branchLoading, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child(this.branchError || "No branches")))
          .when(this.branches !== null && choices.length === 0, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("No matching branches")))
          .children(choices.map((row) => this.branchRow(t, row, busy, cx))),
      )
      .when(Boolean(this.branchSource), (el) => el.child(div().px(10).pb(6).text_size(10.5).text_color(t.dim).child(`From ${this.branchSource.name}`)))
      .when(!this.branchAction || this.branchAction === "create" || this.branchAction === "createFrom", (el) =>
        el.child(
          h_flex()
            .flex_none()
            .p(10)
            .gap(6)
            .items_center()
            .border_t(1)
            .border_color(t.border)
            .child(
              div()
                .flex_1()
                .h(32)
                .rounded(9)
                .border_1()
                .border_color(this.focused.create ? t.accent : t.input)
                .bg(t.background)
                .px(8)
                .child(Input.new(this.newBranch).size_full().text_size(11.5).text_color(t.foreground)),
            )
            .child(iconButton(t, "farrier-git-create", "plus", "Create branch and switch to it", (cx) => this.createBranch(cx), { disabled: busy || !this.newBranchText.trim(), color: t.accent, size: 30, glyphSize: 15 })),
        ),
      );
  }

  branchRow(t, row, busy, cx) {
    if (row.kind === "head") {
      return h_flex()
        .flex_none()
        .px(8)
        .pt(8)
        .pb(3)
        .gap(6)
        .items_center()
        .text_size(10)
        .font_semibold()
        .text_color(t.dim)
        .child(row.label)
        .child(div().flex_1());
    }
    if (this.renaming === row.name) {
      return h_flex()
        .id(`farrier-git-rename-${row.name}`)
        .h(38)
        .flex_none()
        .px(8)
        .gap(6)
        .items_center()
        .rounded(8)
        .bg(t.hover)
        .child(icon("branch", t.accent, 13))
        .child(
          div()
            .flex_1()
            .h(28)
            .rounded(7)
            .border_1()
            .border_color(t.accent)
            .bg(t.background)
            .px(7)
            .child(Input.new(this.renameInput).size_full().text_size(11).text_color(t.foreground)),
        )
        .child(iconButton(t, `farrier-git-rename-ok-${row.name}`, "check", "Rename branch", (cx) => this.renameBranch(cx), { color: t.done, size: 24, glyphSize: 13 }))
        .child(iconButton(t, `farrier-git-rename-cancel-${row.name}`, "x", "Cancel rename", (cx) => { this.renaming = null; cx.notify(); }, { size: 24, glyphSize: 13 }));
    }
    const current = row.kind === "local" && row.current;
    return h_flex()
      .id(`farrier-git-branch-${row.kind}-${row.name}`)
      .h(36)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(8)
      .when(current, (el) => el.bg(t.selected))
      .when(!current, (el) => el.hover((s) => s.bg(t.hover)))
      .cursor_pointer()
      .on_click((_event, cx) => this.pickBranch(row, cx))
      .child(icon("branch", current ? t.accent : t.muted, 13))
      .child(div().flex_1().min_w(0).truncate().text_color(current ? t.foreground : t.foreground).child(row.name))
      .when(current, (el) => el.child(icon("check", t.accent, 13)))
      .when(!current && row.at > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(ago(row.at))))
      .when(row.kind === "remote", (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("remote")))
      .when(row.kind === "local" && !this.branchAction, (el) =>
        el
          .child(iconButton(t, `farrier-git-rename-open-${row.name}`, "pencil", "Rename branch", (cx) => this.startRename(row, cx), { size: 22, glyphSize: 12, disabled: busy, stopDrag: true }))
          .when(!current, (el) => el.child(iconButton(t, `farrier-git-delete-open-${row.name}`, "trash", "Delete branch", (cx) => this.askDelete(row, cx), { size: 22, glyphSize: 12, disabled: busy, stopDrag: true }))),
      );
  }

  // ---- keys ------------------------------------------------------------------

  onKey(event, cx) {
    if (event.key === "escape") {
      if (this.menu) {
        this.menu = null;
        cx.notify();
        cx.stop_propagation();
        return;
      }
      if (this.renaming) {
        this.renaming = null;
        cx.notify();
        cx.stop_propagation();
        return;
      }
      if (this.deleting) {
        this.deleting = null;
        cx.notify();
        cx.stop_propagation();
        return;
      }
      if (this.deletingRemote) {
        this.deletingRemote = null;
        cx.notify();
        cx.stop_propagation();
        return;
      }
      if (this.stashConfirm) {
        this.stashConfirm = null;
        cx.notify();
        cx.stop_propagation();
        return;
      }
      if (this.mode === "branches") {
        this.closeBranches(cx);
        cx.stop_propagation();
        return;
      }
      if (this.mode === "stashes") {
        this.closeStashes(cx);
        cx.stop_propagation();
        return;
      }
      if (this.discardTarget) {
        this.discardTarget = null;
        cx.notify();
        cx.stop_propagation();
        return;
      }
      if (this.discardAll) {
        this.discardAll = false;
        cx.notify();
        cx.stop_propagation();
        return;
      }
      if (this.typing) {
        this.handle.focus();
        cx.stop_propagation();
      }
      return;
    }
    if (!this.menu && event.key === "enter" && (event.modifiers.control || event.modifiers.platform) && this.mode === "changes") {
      this.commit(cx);
      cx.stop_propagation();
    }
  }
}
