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
const MAX_FILES = 5000;
const MAX_STATS_FILES = 500;
const FILE_PAGE = 100;
const FILE_PAGE_MAX = 300;
const FILE_FILTER_MIN = 30;
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

function findModPaths(node, mod, path = [], out = []) {
  if (!node) return out;
  const here = [...path, node];
  if (node.content?.mod === mod) out.push(here);
  for (const child of node.children ?? []) findModPaths(child, mod, here, out);
  return out;
}

function shownStackChild(node) {
  const visible = (node.children ?? []).filter((child) => !child.hidden);
  return visible.find((child) => child.id === node.active) ?? visible[0] ?? null;
}

function pathShown(path) {
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    const child = path[i + 1];
    if (node.hidden) return false;
    if (node.type === "stack" && child) {
      const shown = shownStackChild(node);
      if (!shown || shown.id !== child.id) return false;
    }
  }
  return true;
}

// ---- git --------------------------------------------------------------------

async function gitRun(cwd, on, args, timeout) {
  return exec("git", [...READ, ...args], { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
}

function cleanAnsi(text) {
  return String(text)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\[\d{1,2}(?:;\d{1,2})*m/g, "")
    .replace(/\r/g, "");
}

function cleanNote(text) {
  return cleanAnsi(text)
    .replace(/^Error:\s*/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1200);
}

function gitError(result) {
  const text = cleanAnsi(result.stderr || result.stdout || "").trim();
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const indexes = [];
  for (let index = 0; index < lines.length; index++) {
    const body = lines[index].trim();
    if (/^(error|fatal|hint|warning|remote:|! |CONFLICT|Auto-merging)|\b(rejected|failed|conflict|not found|no such)\b/i.test(body)) {
      indexes.push(index);
      if (body.endsWith(":")) {
        for (let next = index + 1; next < lines.length && /^\s/.test(lines[next]) && indexes.length < 6; next++) indexes.push(next);
      }
    }
  }
  let chosen;
  if (indexes.length) {
    const unique = [...new Set(indexes)].sort((a, b) => a - b);
    chosen = unique.slice(0, 6).map((index) => lines[index].trim());
  } else {
    chosen = [...new Set([...lines.slice(0, 3), ...lines.slice(-3)])].slice(0, 6);
  }
  return chosen.join("\n") || `git exited with ${result.code}`;
}

async function mustGit(cwd, on, args, timeout) {
  const result = await gitRun(cwd, on, args, timeout);
  if (result.code !== 0) throw new Error(gitError(result));
  return result;
}

async function conflictOperation(cwd, on) {
  for (const [ref, name] of [["REBASE_HEAD", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]]) {
    const result = await gitRun(cwd, on, ["rev-parse", "--verify", "--quiet", ref]);
    if (result.code === 0) return name;
  }
  return "";
}

async function conflictStages(cwd, on, path) {
  const result = await gitRun(cwd, on, ["ls-files", "-u", "--", path]);
  if (result.code !== 0) return null;
  const stages = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    const meta = (tab < 0 ? line : line.slice(0, tab)).split(" ");
    if (meta[2]) stages.add(meta[2]);
  }
  return stages;
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
      const kind = parts[1] ?? "UU";
      if (path) files.push({ path, xy: kind, kind, untracked: false, conflict: true });
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

const REF_FORMAT = "%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(committerdate:unix)%09%(subject)";
const REMOTE_FORMAT = "%(refname:short)%09%(committerdate:unix)";
const LOG_FORMAT = "%H%x09%an%x09%ct%x09%s";
const BRANCH_COMMIT_PAGE = 20;
const MAX_BRANCH_COMMITS = 200;
const MAX_BRANCH_ROWS = 200;

function parseLocalRefs(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const [head, name, upstream, at] = parts;
      return { name, upstream: upstream || "", at: Number(at) || 0, current: head?.trim() === "*", subject: parts.slice(4).join("\t").trim() };
    })
    .filter((branch) => branch.name);
}

function parseLog(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const [hash, author, at] = parts;
      return { hash, author: author || "", at: Number(at) || 0, subject: parts.slice(3).join("\t").trim() };
    })
    .filter((commit) => commit.hash);
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

const CONFLICT_KINDS = {
  DD: "both deleted",
  AU: "current version added",
  UD: "incoming version deleted",
  UA: "incoming version added",
  DU: "current version deleted",
  AA: "both added",
  UU: "both modified",
};

const CONFLICT_KINDS_REBASE = {
  DD: "both deleted",
  AU: "incoming version added",
  UD: "current version deleted",
  UA: "current version added",
  DU: "incoming version deleted",
  AA: "both added",
  UU: "both modified",
};

function conflictKind(file, operation) {
  return (operation === "rebase" ? CONFLICT_KINDS_REBASE : CONFLICT_KINDS)[file.kind] ?? "unmerged";
}

function conflictSideFlag(side, operation) {
  if (operation === "rebase") return side === "current" ? "--theirs" : "--ours";
  return side === "current" ? "--ours" : "--theirs";
}

function operationLabel(operation) {
  switch (operation) {
    case "merge": return "Merge in progress";
    case "rebase": return "Rebase in progress";
    case "cherry-pick": return "Cherry-pick in progress";
    case "revert": return "Revert in progress";
    default: return "";
  }
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
    this.noteTask = null;
    this.noteSeq = 0;
    this.typing = false;
    this.focused = { filter: false, create: false, rename: false, message: false, files: false };
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
    this.conflicts = [];
    this.operation = "";
    this.conflictTarget = null;
    this.fileTotal = 0;
    this.hasUntracked = false;
    this.statsSkipped = false;
    this.fileLimit = { staged: FILE_PAGE, changes: FILE_PAGE };
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
    this.branchesOpen = false;
    this.branchLoading = false;
    this.branchError = null;
    this.branchExpanded = new Set();
    this.copiedSha = null;
    this.branchCommits = new Map();
    this.branchCommitLimit = new Map();
    this.branchCommitMore = new Map();
    this.branchCommitsLoading = new Map();
    this.branchCommitsError = new Map();
    this.branchFilterText = "";
    this.newBranchText = "";
    this.renaming = null;
    this.deleting = null;
    this.deletingRemote = null;
    this.branchAction = null;
    this.branchSource = null;
    this.renameText = "";

    this.message = "";
    this.fileFilterText = "";
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

    this.fileFilter = InputState.new({ placeholder: "Filter changed files" });
    this.fileFilter.on("change", (_event, cx) => {
      this.fileFilterText = this.fileFilter.value();
      this.resetFilePages();
      cx.notify();
    });
    this.fileFilter.on("focus", (_event, cx) => {
      this.focused.files = true;
      this.typing = true;
      cx.notify();
    });
    this.fileFilter.on("blur", (_event, cx) => {
      this.focused.files = false;
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
      const paths = findModPaths(layout(), "farrier-git");
      if (!paths.length) return true;
      if (paths.some(pathShown)) return true;
      return panes().some((pane) => pane.mod === "farrier-git");
    } catch {
      return true;
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  async close(_cx) {
    try {
      this.noteTask?.cancel();
    } catch {}
    try {
      this.watchPromise?.cancel();
    } catch {}
    for (const state of [this.messageState, this.fileFilter, this.branchFilter, this.newBranch, this.renameInput]) {
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
      this.conflicts = [];
      this.operation = "";
      this.conflictTarget = null;
      this.notRepo = false;
      this.error = null;
      this.limited = false;
      this.fileTotal = 0;
      this.hasUntracked = false;
      this.statsSkipped = false;
      this.fileLimit = { staged: FILE_PAGE, changes: FILE_PAGE };
      this.discardTarget = null;
      this.discardAll = false;
      this.folded = { staged: false, changes: false };
      this.branches = null;
      this.branchesOpen = false;
      this.branchError = null;
      this.branchExpanded = new Set();
      this.copiedSha = null;
      this.branchCommits = new Map();
      this.branchCommitLimit = new Map();
      this.branchCommitMore = new Map();
      this.branchCommitsLoading = new Map();
      this.branchCommitsError = new Map();
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
      this.fileFilterText = "";
      this.fileFilter.set_value("");
      this.branchFilterText = "";
      this.branchFilter.set_value("");
      this.newBranchText = "";
      this.newBranch.set_value("");
      this.renameText = "";
      this.message = "";
      this.messageState.set_value("");
      this.noteTask?.cancel();
      this.noteTask = null;
      this.noteSeq = (this.noteSeq ?? 0) + 1;
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
          this.conflicts = [];
          this.operation = "";
          this.conflictTarget = null;
          this.fileTotal = 0;
          this.hasUntracked = false;
          this.statsSkipped = false;
          this.fileLimit = { staged: FILE_PAGE, changes: FILE_PAGE };
          this.staged = [];
          this.changes = [];
          return;
        }
        const root = top.stdout.trim();
        const status = await gitRun(root, ctx.on, ["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(gitError(status));
        if (this.context !== ctx) return;
        const parsed = parseStatus(status.stdout);
        let untracked = false;
        let tracked = 0;
        for (const entry of parsed.files) {
          if (entry.untracked) untracked = true;
          else tracked++;
        }
        const stats = tracked && tracked <= MAX_STATS_FILES ? await loadStats(root, ctx.on) : { staged: {}, work: {} };
        if (this.context !== ctx) return;

        const staged = [];
        const changes = [];
        for (const entry of parsed.files.slice(0, MAX_FILES)) {
          const xy = entry.xy ?? "..";
          if (entry.conflict) {
            changes.push({ path: entry.path, status: "U", kind: entry.kind ?? "UU", conflict: true, add: 0, del: 0 });
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
        changes.sort((a, b) => Number(Boolean(b.conflict)) - Number(Boolean(a.conflict)) || a.path.localeCompare(b.path));
        const conflicts = changes.filter((file) => file.conflict);
        let operation = this.operation;
        if (conflicts.length || operation) {
          operation = await conflictOperation(root, ctx.on);
          if (this.context !== ctx) return;
        }

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
        this.conflicts = conflicts;
        this.operation = operation;
        this.fileTotal = parsed.files.length;
        this.hasUntracked = untracked;
        this.statsSkipped = tracked > MAX_STATS_FILES;
        this.notRepo = false;
        this.limited = parsed.files.length > MAX_FILES;
        this.error = null;
        this.watchRepo(root, cx);
        if (this.discardTarget && !changes.some((file) => file.path === this.discardTarget.path)) this.discardTarget = null;
        if (this.conflictTarget && !conflicts.some((file) => file.path === this.conflictTarget.path)) this.conflictTarget = null;
        if (this.discardAll && !changes.length) this.discardAll = false;
        if (this.mode === "branches" && this.branches === null) this.loadBranches(cx);
        if (this.mode === "changes" && this.branchesOpen && this.branches === null && !this.branchLoading) this.loadBranches(cx);
        if (this.mode === "stashes" && this.stashes === null) this.loadStashes(cx);
      } catch (error) {
        if (this.context === ctx) {
          this.error = cleanNote(String(error));
          this.root = null;
          this.repoName = "";
          this.branch = "";
          this.branchRaw = "";
          this.upstream = "";
          this.ahead = 0;
          this.behind = 0;
          this.limited = false;
          this.fileTotal = 0;
          this.hasUntracked = false;
          this.statsSkipped = false;
          this.fileLimit = { staged: FILE_PAGE, changes: FILE_PAGE };
          this.staged = [];
          this.changes = [];
          this.conflicts = [];
          this.operation = "";
          this.conflictTarget = null;
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

  setNote(text, kind, cx) {
    this.noteTask?.cancel();
    this.noteTask = null;
    this.noteSeq = (this.noteSeq ?? 0) + 1;
    const token = this.noteSeq;
    const error = (kind ?? "error") === "error";
    this.noteKind = "error";
    this.note = error && text ? cleanNote(text) : null;
    if (!this.note) {
      cx?.notify();
      return;
    }
    if (cx?.timer) {
      this.noteTask = cx.timer.after(9000, (cx) => {
        if (this.noteSeq !== token) return;
        this.note = null;
        this.noteTask = null;
        cx.notify();
      });
    }
    cx?.notify();
  }

  dismissNote(cx) {
    this.noteTask?.cancel();
    this.noteTask = null;
    this.noteSeq = (this.noteSeq ?? 0) + 1;
    this.note = null;
    cx.notify();
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
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
    if (this.conflicts.length) {
      this.setNote("Resolve conflicts before staging all.", "error", cx);
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["add", "-A"]);
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
    if (this.conflicts.length) {
      this.setNote("Resolve conflicts before unstaging.", "error", cx);
      return;
    }
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
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
    if (this.conflicts.length) {
      this.setNote("Resolve conflicts before unstaging all.", "error", cx);
      return;
    }
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
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
    if (this.conflicts.length) {
      this.setNote("Resolve conflicts before discarding all changes.", "error", cx);
      return;
    }
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
          this.setNote(`Discarded ${baseName(file.path)}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  discardAllChanges(cx) {
    if (!this.root || !this.changes.length || this.busy || this.conflicts.length) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const untracked = this.hasUntracked;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["restore", "--worktree", "--", "."]);
        if (untracked) await mustGit(root, on, ["clean", "-f", "-d"]);
        if (this.context === ctx) {
          this.discardAll = false;
          this.setNote("Discarded all changes", "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
      } finally {
        if (this.context === ctx) this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  askConflict(file, cx) {
    if (!file?.conflict || this.busy) return;
    this.conflictTarget = file;
    this.discardTarget = null;
    this.discardAll = false;
    cx.notify();
  }

  resolveConflicts(files, side, cx) {
    const list = files?.filter((file) => file.conflict) ?? [];
    if (!this.root || !list.length || this.busy) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const flag = conflictSideFlag(side, this.operation);
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      let failed = 0;
      let detail = "";
      for (const file of list) {
        if (this.context !== ctx) return;
        const checkout = await gitRun(root, on, ["checkout", flag, "--", file.path]);
        let done = false;
        let errorText = "";
        if (checkout.code === 0) {
          const add = await gitRun(root, on, ["add", "--", file.path]);
          done = add.code === 0;
          if (!done) errorText = gitError(add);
        } else {
          const stages = await conflictStages(root, on, file.path);
          const stage = flag === "--ours" ? "2" : "3";
          if (!stages || (stages.size && stages.has(stage)) || (!stages.size && file.kind !== "DD")) {
            errorText = gitError(checkout);
          } else {
            const rm = await gitRun(root, on, ["rm", "-f", "--", file.path]);
            done = rm.code === 0;
            if (!done) errorText = gitError(rm);
          }
        }
        if (!done) {
          failed++;
          detail = (detail ? detail + "\n" : "") + `${file.path}: ${errorText || gitError(checkout)}`;
        }
      }
      if (this.context === ctx) {
        this.conflictTarget = null;
        if (failed) this.setNote(`Resolved ${list.length - failed} of ${list.length} conflicts. ${detail}`, "error", cx);
        else this.setNote(`Resolved ${list.length} conflict${list.length === 1 ? "" : "s"} with the ${side} version`, "success", cx);
      }
      if (this.context === ctx) this.busy = false;
      this.refresh(cx);
      cx.notify();
    });
    cx.notify();
  }

  resolveConflict(side, cx) {
    if (this.conflictTarget) this.resolveConflicts([this.conflictTarget], side, cx);
  }

  continueOperation(cx) {
    const operation = this.operation;
    if (!this.root || this.busy || !operation || operation === "merge") return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const command = operation === "revert" ? "revert" : operation === "cherry-pick" ? "cherry-pick" : "rebase";
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await mustGit(root, on, ["-c", "core.editor=true", command, "--continue"], 180000);
        if (this.context === ctx) this.setNote(`Continued ${operation}`, "success", cx);
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
    if (this.conflicts.length) {
      this.setNote("Resolve conflicts before committing.", "error", cx);
      return;
    }
    if (this.operation && this.operation !== "merge") {
      this.setNote(`Continue the ${this.operation} instead of committing.`, "error", cx);
      return;
    }
    if (!this.staged.length) {
      this.setNote("Stage changes before committing.", "error", cx);
      cx.notify();
      return;
    }
    if (!this.message.trim()) {
      this.setNote("Write a commit message.", "error", cx);
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
          this.branches = null;
          this.setNote(`Committed ${head.stdout.trim()}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
      this.setNote("Stage changes before generating a message.", "error", cx);
      cx.notify();
      return;
    }
    if (this.context?.on) {
      this.setNote("Generate commit messages from a local repository.", "error", cx);
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
          this.setNote("Generated with Pi", "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
        if (this.context === ctx) this.setNote(upstream ? "Pushed" : `Published ${branch}`, "success", cx);
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
      this.setNote("No upstream branch. Push first.", "error", cx);
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
        if (this.context === ctx) {
          this.branches = null;
          this.setNote(behind > 0 ? "Pulled" : "Up to date", "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
          this.setNote("Fetched", "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
        if (this.context === ctx) this.stashError = cleanNote(String(error));
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
          this.setNote(kind === "untracked" ? "Stashed with untracked files" : kind === "staged" ? "Stashed staged changes" : "Stashed changes", "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
          this.setNote(`${pop ? "Popped" : "Applied"} ${ref}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
          this.setNote(`Dropped ${ref}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
          this.setNote("Dropped all stashes", "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
          if (this.context === ctx) this.setNote("Initialized repository", "success", cx);
        } catch (error) {
          if (this.context === ctx) this.setNote(String(error), "error", cx);
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

  toggleBranches(cx) {
    this.branchesOpen = !this.branchesOpen;
    if (this.branchesOpen && this.branches === null && !this.branchLoading) this.loadBranches(cx);
    cx.notify();
  }

  refreshBranches(cx) {
    if (!this.root || this.busy || this.branchLoading) return;
    this.branches = null;
    this.branchError = null;
    this.loadBranches(cx);
    cx.notify();
  }

  toggleBranchRow(branch, cx) {
    if (this.branchExpanded.has(branch.name)) {
      this.branchExpanded.delete(branch.name);
      cx.notify();
      return;
    }
    this.branchExpanded.clear();
    this.branchExpanded.add(branch.name);
    if (!this.branchCommits.has(branch.name)) this.loadBranchCommits(branch, cx);
    cx.notify();
  }

  loadBranchCommits(branch, cx) {
    if (!this.root || this.branchCommitsLoading.get(branch.name)) return;
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    const limit = Math.min(this.branchCommitLimit.get(branch.name) ?? BRANCH_COMMIT_PAGE, MAX_BRANCH_COMMITS);
    this.branchCommitLimit.set(branch.name, limit);
    this.branchCommitsLoading.set(branch.name, true);
    this.branchCommitsError.delete(branch.name);
    cx.spawn(async (cx) => {
      try {
        const result = await gitRun(root, on, [
          "log",
          `--max-count=${limit + 1}`,
          `--format=${LOG_FORMAT}`,
          "--no-color",
          "--no-decorate",
          `refs/heads/${branch.name}`,
        ]);
        if (result.code !== 0) throw new Error(gitError(result));
        if (this.context !== ctx) return;
        const all = parseLog(result.stdout);
        this.branchCommits.set(branch.name, all.slice(0, limit));
        this.branchCommitMore.set(branch.name, all.length > limit && limit < MAX_BRANCH_COMMITS);
        this.branchCommitsError.delete(branch.name);
      } catch (error) {
        if (this.context === ctx) this.branchCommitsError.set(branch.name, String(error));
      } finally {
        if (this.context === ctx) this.branchCommitsLoading.set(branch.name, false);
        cx.notify();
      }
    });
  }

  loadMoreBranchCommits(branch, cx) {
    if (this.branchCommitsLoading.get(branch.name)) return;
    const current = this.branchCommitLimit.get(branch.name) ?? BRANCH_COMMIT_PAGE;
    if (current >= MAX_BRANCH_COMMITS) return;
    const limit = Math.min(current + BRANCH_COMMIT_PAGE, MAX_BRANCH_COMMITS);
    this.branchCommitLimit.set(branch.name, limit);
    this.loadBranchCommits(branch, cx);
    cx.notify();
  }

  loadBranches(cx, withRemote = this.mode === "branches") {
    if (this.mode === "diff" || this.branchLoading) return;
    if (!this.root) {
      this.branchError = "No repository";
      return;
    }
    const ctx = this.context;
    const root = this.root;
    const on = ctx.on;
    this.branchLoading = true;
    this.branchError = null;
    cx.spawn(async (cx) => {
      try {
        const requests = [gitRun(root, on, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads"])];
        if (withRemote) {
          requests.push(gitRun(root, on, ["for-each-ref", "--sort=-committerdate", "--count=250", `--format=${REMOTE_FORMAT}`, "refs/remotes"]));
        }
        const [localResult, remoteResult] = await Promise.all(requests);
        if (localResult.code !== 0) throw new Error(gitError(localResult));
        if (this.context !== ctx) return;
        const local = parseLocalRefs(localResult.stdout);
        local.sort((a, b) => Number(b.current) - Number(a.current) || b.at - a.at);
        this.branches = {
          local,
          remote: remoteResult?.code === 0 ? parseRemoteRefs(remoteResult.stdout) : [],
        };
        this.branchError = null;
        this.branchCommits.clear();
        this.branchCommitMore.clear();
        this.branchCommitsLoading.clear();
        this.branchCommitsError.clear();
        for (const name of this.branchExpanded) {
          const item = local.find((branch) => branch.name === name);
          if (item) this.loadBranchCommits(item, cx);
          else this.branchExpanded.delete(name);
        }
      } catch (error) {
        if (this.context === ctx) this.branchError = cleanNote(String(error));
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
          this.branches = null;
          this.setNote(`Merged ${branch.name}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) {
          this.mode = "changes";
          this.branchAction = null;
          this.branchError = null;
          this.setNote(String(error), "error", cx);
        }
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
          this.branches = null;
          this.setNote(`Rebased onto ${branch.name}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) {
          this.mode = "changes";
          this.branchAction = null;
          this.branchError = null;
          this.setNote(String(error), "error", cx);
        }
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
          this.setNote(`Checked out ${target}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
      this.setNote("Type a branch name", "error", cx);
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
          this.setNote(source ? `Created ${name} from ${source}` : `Created ${name}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
          this.setNote(`Renamed to ${newName}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
      this.setNote(`Cannot parse remote branch ${name}`, "error", cx);
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
          this.setNote(`Deleted remote branch ${name}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
          this.setNote(`Deleted ${name}`, "success", cx);
        }
      } catch (error) {
        if (this.context === ctx) this.setNote(String(error), "error", cx);
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
        diff.error = cleanNote(String(error));
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
            disabled: busy || !this.staged.length || !this.message.trim() || this.conflicts.length > 0 || (this.operation && this.operation !== "merge"),
            trailing: this.staged.length ? String(this.staged.length) : "",
            hint: this.conflicts.length ? "Resolve conflicts before committing" : this.operation && this.operation !== "merge" ? `Continue the ${this.operation} instead of committing` : "Commit staged changes",
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
            .child(this.renderFiles(t, cx))
            .child(this.renderBranchesSection(t, cx)),
        ),
      );
  }

  renderBranchesSection(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    const local = this.branches?.local ?? [];
    const count = this.branches ? local.length : null;
    const visible = local.slice(0, MAX_BRANCH_ROWS);
    const expanded = visible.some((branch) => this.branchExpanded.has(branch.name));
    const truncated = local.length > visible.length;
    const listHeight = expanded ? 320 : Math.min(280, Math.max(52, visible.length * 48 + 10 + (truncated ? 26 : 0)));
    return v_flex()
      .id("farrier-git-branches-section")
      .flex_none()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("farrier-git-branches-toggle")
          .h(30)
          .flex_none()
          .px(9)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_event, cx) => this.toggleBranches(cx))
          .child(icon(this.branchesOpen ? "chevron-down" : "chevron-right", t.dim, 12))
          .child(icon("branch", t.accent, 13))
          .child(div().flex_none().text_size(11.5).font_semibold().child("Branches"))
          .when(this.branchesOpen && count !== null, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`(${count})`)))
          .child(div().flex_1())
          .when(this.branchesOpen && this.branchLoading, (el) => el.child(svg(ICON("spinner")).size(12).flex_none().text_color(t.muted).spin(800)))
          .when(this.branchesOpen && !this.branchLoading, (el) =>
            el.child(iconButton(t, "farrier-git-branches-refresh", "refresh", "Reload branches", (cx) => this.refreshBranches(cx), { disabled: busy, size: 24, glyphSize: 12, stopDrag: true })),
          ),
      )
      .when(this.branchesOpen, (el) =>
        el.child(
          v_flex()
            .id("farrier-git-branches-drawer")
            .flex_none()
            .h(listHeight)
            .min_h(0)
            .overflow_y_scrollbar()
            .p(5)
            .gap(1)
            .when(this.branches === null && this.branchLoading, (e) => e.child(div().p(8).text_size(11).text_color(t.dim).child("Loading branches")))
            .when(this.branches === null && !this.branchLoading, (e) => e.child(div().p(8).text_size(11).text_color(this.branchError ? t.blocked : t.dim).child(this.branchError || "No branches")))
            .when(this.branches !== null && !local.length, (e) => e.child(div().p(8).text_size(11).text_color(t.dim).child("No local branches")))
            .when(this.branches !== null && Boolean(this.branchError), (e) => e.child(div().p(8).text_size(11).text_color(t.blocked).child(this.branchError)))
            .children(visible.map((branch) => this.branchSectionRow(t, branch, cx)))
            .when(truncated, (e) => e.child(div().h(26).pl(42).pr(7).flex().items_center().text_size(10).text_color(t.dim).child(`Showing the first ${visible.length} of ${local.length} branches`))),
        ),
      );
  }

  branchSectionRow(t, branch, cx) {
    const current = Boolean(branch.current);
    const expanded = this.branchExpanded.has(branch.name);
    return v_flex()
      .id(`farrier-git-branch-row-${branch.name}`)
      .flex_none()
      .rounded(7)
      .when(current && !expanded, (el) => el.bg(t.selected))
      .child(
        h_flex()
          .id(`farrier-git-branch-toggle-${branch.name}`)
          .h(32)
          .flex_none()
          .px(7)
          .gap(6)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_event, cx) => this.toggleBranchRow(branch, cx))
          .when(current && expanded, (el) => el.bg(t.selected))
          .when(!current && expanded, (el) => el.bg(t.raised))
          .child(icon(expanded ? "chevron-down" : "chevron-right", t.dim, 11))
          .child(icon("branch", current ? t.accent : t.muted, 12))
          .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.foreground).child(branch.name))
          .when(branch.at > 0, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(ago(branch.at))))
          .when(current, (el) => el.child(icon("check", t.accent, 12))),
      )
      .when(!expanded, (el) =>
        el.child(
          h_flex()
            .h(16)
            .pl(42)
            .pr(7)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(branch.subject || "No commit")),
        ),
      )
      .when(expanded, (el) => el.child(this.renderBranchCommits(t, branch, cx)));
  }

  renderBranchCommits(t, branch, cx) {
    const commits = this.branchCommits.get(branch.name);
    const loading = Boolean(this.branchCommitsLoading.get(branch.name));
    const more = Boolean(this.branchCommitMore.get(branch.name));
    const error = this.branchCommitsError.get(branch.name);
    return v_flex()
      .id(`farrier-git-branch-commits-${branch.name}`)
      .flex_none()
      .gap(1)
      .when(loading && !commits, (el) => el.child(this.branchCommitStatus(t, "Loading commits", false)))
      .when(Boolean(error) && !commits, (el) => el.child(this.branchCommitStatus(t, error, true)))
      .when(Boolean(commits) && !commits.length, (el) => el.child(this.branchCommitStatus(t, "No commits", false)))
      .when(Boolean(commits), (el) => el.children(commits.map((commit) => this.branchCommitRow(t, branch, commit))))
      .when(loading && Boolean(commits), (el) => el.child(this.branchCommitStatus(t, "Loading commits", false)))
      .when(more && !loading, (el) =>
        el.child(
          h_flex()
            .id(`farrier-git-branch-more-${branch.name}`)
            .h(26)
            .flex_none()
            .pl(42)
            .pr(7)
            .gap(5)
            .items_center()
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_event, cx) => this.loadMoreBranchCommits(branch, cx))
            .child(icon("chevron-down", t.dim, 10))
            .child(div().text_size(10).text_color(t.accent).child("Load more")),
        ),
      );
  }

  branchCommitStatus(t, text, error) {
    return h_flex()
      .h(26)
      .flex_none()
      .pl(42)
      .pr(7)
      .items_center()
      .child(div().text_size(10).text_color(error ? t.blocked : t.dim).child(text));
  }

  branchCommitRow(t, branch, commit) {
    const merged = /^Merge\b/i.test(commit.subject);
    const copied = this.copiedSha === commit.hash;
    return h_flex()
      .id(`farrier-git-commit-${branch.name}-${commit.hash}`)
      .h(26)
      .flex_none()
      .pl(42)
      .pr(7)
      .gap(5)
      .items_center()
      .hover((s) => s.bg(t.hover))
      .tooltip(copied ? "SHA copied" : "Right-click to copy SHA")
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(commit.hash);
        this.copiedSha = commit.hash;
        cx.notify();
      })
      .child(icon(copied ? "check" : merged ? "merge" : "commit", copied ? t.done : merged ? t.ansi3 : t.dim, 10))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(commit.subject || "(no message)"))
      .when(Boolean(commit.author), (el) => el.child(div().flex_none().max_w(52).truncate().text_size(9).text_color(t.dim).child(commit.author)))
      .when(commit.at > 0, (el) => el.child(div().flex_none().text_size(9).text_color(t.dim).child(ago(commit.at))));
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
        .when(Boolean(this.note), (el) => el.child(this.renderNote(t, cx)));
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
      .when(Boolean(this.note), (el) => el.child(this.renderNote(t, cx)));
  }

  resetFilePages() {
    this.fileLimit = { staged: FILE_PAGE, changes: FILE_PAGE };
  }

  fileRows(kind) {
    const files = kind === "staged" ? this.staged : this.changes;
    const query = this.fileFilterText.trim().toLowerCase();
    return query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files;
  }

  showMoreFiles(kind, cx) {
    const limit = this.fileLimit[kind] ?? FILE_PAGE;
    if (limit >= FILE_PAGE_MAX) return;
    this.fileLimit[kind] = Math.min(limit + FILE_PAGE, FILE_PAGE_MAX);
    cx.notify();
  }

  clearFileFilter(cx) {
    this.fileFilterText = "";
    this.fileFilter.set_value("");
    this.resetFilePages();
    cx.notify();
  }

  renderFileFilter(t, cx, query) {
    return h_flex()
      .flex_none()
      .px(9)
      .pt(6)
      .pb(4)
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .h(30)
          .gap(6)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(this.focused.files ? t.accent : t.input)
          .bg(t.background)
          .px(8)
          .child(icon("search", t.dim, 12))
          .child(div().flex_1().min_w(0).child(Input.new(this.fileFilter).size_full().text_size(11.5).text_color(t.foreground)))
          .when(Boolean(query), (el) => el.child(iconButton(t, "farrier-git-file-filter-clear", "x", "Clear file filter", (cx) => this.clearFileFilter(cx), { size: 20, glyphSize: 11, stopDrag: true }))),
      );
  }

  renderMore(t, kind, all, shown, cx) {
    const remaining = all.length - shown;
    const capped = shown >= FILE_PAGE_MAX;
    return h_flex()
      .id(`farrier-git-more-${kind}`)
      .flex_none()
      .h(30)
      .mx(6)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(10)
          .text_color(t.dim)
          .child(capped ? `Showing ${shown} of ${all.length}. Filter to narrow.` : `${shown} of ${all.length}`),
      )
      .when(!capped, (el) => el.child(button(t, `farrier-git-more-${kind}-button`, `Show ${Math.min(FILE_PAGE, remaining)} more`, "ghost", (cx) => this.showMoreFiles(kind, cx), { h: 26, px: 8 })));
  }

  renderConflictTarget(t, cx, busy) {
    const file = this.conflictTarget;
    if (!file) return null;
    return v_flex()
      .px(8)
      .py(6)
      .gap(6)
      .rounded(8)
      .bg(t.raised)
      .border_1()
      .border_color(t.blocked + "3d")
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(icon("merge", t.blocked, 12))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(div().text_size(10.5).text_color(t.foreground).truncate().child(`Resolve ${baseName(file.path)}`))
              .child(div().text_size(9.5).text_color(t.dim).truncate().child(conflictKind(file, this.operation))),
          )
          .child(iconButton(t, "farrier-git-conflict-cancel", "x", "Cancel resolution", (cx) => { this.conflictTarget = null; cx.notify(); }, { size: 18, glyphSize: 10 })),
      )
      .child(
        h_flex()
          .gap(5)
          .child(button(t, "farrier-git-conflict-current", "Use current", "outline", (cx) => this.resolveConflict("current", cx), { h: 26, px: 8, disabled: busy, hint: "Take the current version of this file" }))
          .child(button(t, "farrier-git-conflict-incoming", "Use incoming", "outline", (cx) => this.resolveConflict("incoming", cx), { h: 26, px: 8, disabled: busy, hint: "Take the incoming version of this file" })),
      );
  }

  renderOperationCard(t, cx, busy) {
    const operation = this.operation;
    if (!operation) return null;
    const canContinue = operation !== "merge";
    return h_flex()
      .id("farrier-git-operation")
      .px(8)
      .py(7)
      .gap(7)
      .items_center()
      .rounded(8)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .child(icon(operation === "merge" ? "merge" : operation === "rebase" ? "rebase" : "commit", t.muted, 13))
      .child(div().flex_1().min_w(0).text_size(10.5).font_medium().text_color(t.foreground).child(operationLabel(operation)))
      .when(canContinue, (el) => el.child(button(t, "farrier-git-operation-continue", `Continue ${operation}`, "outline", (cx) => this.continueOperation(cx), { h: 26, px: 8, disabled: busy })));
  }

  renderConflicts(t, cx) {
    const count = this.conflicts.length;
    const operation = operationLabel(this.operation);
    const busy = this.loading || this.busy || this.generating;
    if (!count && !operation) return null;
    return v_flex()
      .id("farrier-git-conflicts")
      .flex_none()
      .mx(9)
      .mt(4)
      .gap(5)
      .when(count > 0, (el) =>
        el.child(
          v_flex()
            .px(8)
            .py(7)
            .gap(6)
            .rounded(8)
            .bg(t.blocked + "10")
            .border_1()
            .border_color(t.blocked + "3a")
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(icon("merge", t.blocked, 13))
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(1)
                    .child(div().text_size(11).font_medium().text_color(t.blocked).child(`${count} conflict${count === 1 ? "" : "s"}`))
                    .when(Boolean(operation), (el) => el.child(div().text_size(9.5).text_color(t.dim).child(operation))),
                ),
            )
            .child(
              h_flex()
                .gap(5)
                .child(button(t, "farrier-git-conflict-current-all", "Use current for all", "outline", (cx) => this.resolveConflicts(this.conflicts, "current", cx), { h: 26, px: 7, disabled: busy, hint: "Take the current version for every conflict" }))
                .child(button(t, "farrier-git-conflict-incoming-all", "Use incoming for all", "outline", (cx) => this.resolveConflicts(this.conflicts, "incoming", cx), { h: 26, px: 7, disabled: busy, hint: "Take the incoming version for every conflict" })),
            ),
        ),
      )
      .when(count === 0 && Boolean(operation), (el) => el.child(this.renderOperationCard(t, cx, busy)))
      .when(count > 0 && Boolean(this.conflictTarget), (el) => el.child(this.renderConflictTarget(t, cx, busy)));
  }

  renderFiles(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    const query = this.fileFilterText.trim();
    const staged = this.fileRows("staged");
    const changes = this.fileRows("changes");
    const stagedView = staged.slice(0, this.fileLimit.staged);
    const changesView = changes.slice(0, this.fileLimit.changes);
    const original = this.staged.length + this.changes.length;
    const showFilter = Boolean(query) || original >= FILE_FILTER_MIN || this.limited;
    const notes = [];
    if (this.limited) notes.push(`Only the first ${MAX_FILES} of ${this.fileTotal} changed files are listed.`);
    if (this.statsSkipped) notes.push("Line stats are hidden for large change sets.");
    const rows = [];
    if (staged.length) rows.push(this.group(t, "staged", "Staged Changes", staged, stagedView, busy, cx));
    if (changes.length) rows.push(this.group(t, "changes", "Changes", changes, changesView, busy, cx));
    return v_flex()
      .id("farrier-git-files-panel")
      .flex_1()
      .min_h(0)
      .when(showFilter, (el) => el.child(this.renderFileFilter(t, cx, query)))
      .when(this.conflicts.length || this.operation, (el) => el.child(this.renderConflicts(t, cx)))
      .children(notes.map((note) => div().px(9).pb(3).text_size(10).text_color(t.dim).child(note)))
      .child(
        v_flex()
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
          .when(!original && !this.loading && !this.error, (el) => el.child(this.renderClean(t)))
          .when(Boolean(query) && Boolean(original) && !staged.length && !changes.length, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("No files match"))),
      );
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
    const untracked = this.hasUntracked;
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

  group(t, kind, label, all, visible, busy, cx) {
    const conflictBlocked = Boolean(this.conflicts.length);
    const add = all.reduce((sum, file) => sum + (file.add || 0), 0);
    const del = all.reduce((sum, file) => sum + (file.del || 0), 0);
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
          .child(pill(t, String(all.length), t.muted))
          .child(div().flex_1())
          .when(add > 0, (el) => el.child(div().text_size(10).text_color(t.ansi2).child(`+${add}`)))
          .when(del > 0, (el) => el.child(div().text_size(10).text_color(t.ansi1).child(`−${del}`)))
          .child(iconButton(t, `farrier-git-all-${kind}`, kind === "staged" ? "minus" : "plus", conflictBlocked ? "Resolve conflicts first" : kind === "staged" ? "Unstage all" : "Stage all", (cx) => (kind === "staged" ? this.unstageAll(cx) : this.stageAll(cx)), { disabled: busy || conflictBlocked, size: 24, glyphSize: 13, stopDrag: true }))
          .when(kind === "changes", (el) => el.child(iconButton(t, "farrier-git-discard-all", "undo", conflictBlocked ? "Resolve conflicts first" : "Discard all changes", (cx) => this.askDiscardAll(cx), { disabled: busy || conflictBlocked, size: 24, glyphSize: 13, stopDrag: true }))),
      )
      .when(!this.folded[kind], (el) =>
        el.children(visible.map((file) => this.fileRow(t, kind, file, busy, cx)))
          .when(all.length > visible.length, (el) => el.child(this.renderMore(t, kind, all, visible.length, cx))),
      );
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
      .when(file.conflict, (el) => el.tooltip(`Conflict: ${conflictKind(file, this.operation)}`))
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
      .when(file.conflict, (el) => el.child(iconButton(t, `farrier-git-resolve-${file.path}`, "merge", "Resolve conflict", (cx) => this.askConflict(file, cx), { disabled: busy, size: 22, glyphSize: 12, color: t.blocked, stopDrag: true })))
      .child(iconButton(t, `farrier-git-toggle-${kind}-${file.path}`, file.conflict ? "check" : staged ? "minus" : "plus", file.conflict ? "Mark resolved (stage file)" : staged ? "Unstage file" : "Stage file", (cx) => (staged ? this.unstage([file], cx) : this.stage([file], cx)), { disabled: busy, size: 22, glyphSize: 12, stopDrag: true }))
      .when(!staged && !file.conflict, (el) => el.child(iconButton(t, `farrier-git-discard-${file.path}`, "undo", "Discard changes in file", (cx) => this.askDiscard(file, cx), { disabled: busy, size: 22, glyphSize: 12, stopDrag: true })));
  }

  renderNote(t, cx) {
    if (!this.note) return null;
    const error = this.noteKind === "error";
    const color = error ? t.blocked : t.done;
    const all = this.note.split("\n").filter(Boolean);
    const maxLines = error ? 5 : 2;
    const shown = all.slice(0, maxLines).join("\n");
    const more = all.length > maxLines;
    return h_flex()
      .id("farrier-git-note")
      .flex_none()
      .mx(10)
      .mb(6)
      .px(8)
      .py(6)
      .gap(7)
      .items_start()
      .rounded(8)
      .bg(error ? t.blocked + "12" : t.done + "12")
      .border_1()
      .border_color(error ? t.blocked + "3d" : t.done + "3d")
      .child(icon(error ? "x" : "check", color, 12))
      .child(div().flex_1().min_w(0).max_h(76).overflow_hidden().text_size(10.5).text_color(error ? t.foreground : t.muted).tooltip(this.note).child(shown + (more ? "\n…" : "")))
      .child(iconButton(t, "farrier-git-note-dismiss", "x", "Dismiss message", (cx) => this.dismissNote(cx), { size: 20, glyphSize: 11 }));
  }

  renderCommit(t, cx) {
    const busy = this.loading || this.busy || this.generating;
    const hasStaged = Boolean(this.staged.length);
    const canCommit = Boolean(this.message.trim() && hasStaged && !busy && !this.conflicts.length && (!this.operation || this.operation === "merge"));
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
          .child(button(t, "farrier-git-commit", "Commit", "primary", (cx) => this.commit(cx), { disabled: !canCommit, h: 30, px: 12, hint: this.conflicts.length ? "Resolve conflicts before committing" : this.operation && this.operation !== "merge" ? `Continue the ${this.operation} instead of committing` : "Commit staged changes (Ctrl+Enter)" })),
      )
      .when(Boolean(this.note), (el) => el.child(this.renderNote(t, cx)));
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
      .when(Boolean(this.note), (el) => el.child(this.renderNote(t, cx)))
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
      .when(Boolean(this.note), (el) => el.child(this.renderNote(t, cx)))
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
      if (this.conflictTarget) {
        this.conflictTarget = null;
        cx.notify();
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
