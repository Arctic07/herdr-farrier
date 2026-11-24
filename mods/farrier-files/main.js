// Farrier Files: a repo file tree, workspace search and a file tab.
//
// The tree is built from one `git ls-files` call for a repository, so opening
// and closing a folder is pure memory work. Outside a repository it falls back
// to lazy directory listing. Rows are virtualised in both modes.
//
// File tabs read asynchronously, edit through Herdr's EditorState, save with
// an expected snapshot and reload when the file changes on disk.

import { View, div } from "gpui-kit";
import { v_flex, InputState, TextareaState, EditorState, VirtualListScrollHandle } from "gpui-base";
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
  props,
  layout,
  shared,
  setShared,
  checking,
  appHome,
  run,
  notify,
  nextCommand,
  window,
} from "herdr";
import {
  MAX_TREE_PATHS,
  buildTree,
  insertTreePath,
  sortTree,
  filterRows,
  findNode,
  ancestorPaths,
  nextUnloadedAncestor,
  parseLsFiles,
  parseGitStatus,
  parseGitStatusRecords,
  addTreePath,
  removeTreePath,
  detectLanguage,
  fileKind,
  isMarkdown,
  isSvg,
  isRasterImage,
  isCsv,
  isXlsx,
  lineCount,
  normalizeTarget,
  resolveAbsolutePath,
  splitPathInfo,
  parentPath,
  pickTabName,
  tabFileKey,
  isEmptyPane,
  findTargetEmptyPane,
} from "./files-logic.js";
import {
  buildFindRegExp,
  buildLineStarts,
  cleanError,
  lineTextAt,
  classifySearchResult,
  findMatches,
  groupMatches,
  matchIndexAtLine,
  parseGrepOutput,
  parseRgJson,
  pathMatchesGlobs,
  planFileReplacements,
  replaceMatches,
  searchRows,
  searchSummary,
  stepMatchIndex,
  buildRgArgs,
  buildGrepArgs,
  buildGitGrepArgs,
  blockSearchAnchor,
  hasLineBreak,
  matchKey,
  parseSearchFileList,
  prepareSearchQuery,
} from "./search-logic.js";
import { expandReplacement, applyPreserveCase } from "./search-logic.js";
import {
  imageSizeFromBase64,
  prepareSvgPreview,
  parseDelimitedText,
  stepZoom,
  utf8ToBase64,
} from "./preview-logic.js";
import {
  parseWorkbookXml,
  parseRelationshipsXml,
  normalizeZipPath,
  parseWorkbookPackage,
  workbookTable,
} from "./xlsx-logic.js";
import { renderTreePane } from "./tree-view.js";
import { renderFile } from "./file-view.js";

const MOD = "farrier-files";
const CACHE_DIR = `cache/farrier-files`;
const MAX_TEXT = 1024 * 1024;
const READ_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const BUFFER_PREFIX = "farrier.files.buffer:";
const MAX_BLOCK_CANDIDATES = 80;

function readBuffered(key) {
  try {
    const raw = sessionStorage.getItem(BUFFER_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeBuffered(key, value) {
  try {
    sessionStorage.setItem(BUFFER_PREFIX + key, JSON.stringify(value));
  } catch {}
}

function clearBuffered(key) {
  try {
    sessionStorage.removeItem(BUFFER_PREFIX + key);
  } catch {}
}

function moveDirtyMarker(oldKey, newKey, removeOnly = false) {
  const map = shared("farrier.files.dirty") ?? {};
  if (!map[oldKey]) return;
  const next = { ...map };
  delete next[oldKey];
  if (!removeOnly) next[newKey] = true;
  setShared("farrier.files.dirty", next);
}

// ---- common helpers ---------------------------------------------------------

function location() {
  const space = spaces().find((item) => item.active);
  const f = focused();
  const pane = f?.pane ? panes().find((item) => item.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const tabs = new Set((space?.tabs ?? []).map((tab) => tab.id));
  const shown = panes().find((item) => tabs.has(item.tab) && item.cwd)?.cwd;
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
  for (let i = 0; i < path.length; i += 1) {
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

function syntaxTheme(t) {
  return {
    keyword: t.ansi5,
    string: t.ansi2,
    comment: t.dim,
    function: t.ansi6,
    type: t.ansi4,
    number: t.ansi3,
    constant: t.ansi5,
    variable: t.foreground,
    operator: t.muted,
    punctuation: t.muted,
    boolean: t.ansi3,
    "string.escape": t.ansi3,
  };
}

function isWindow() {
  try {
    return window()?.platform === "windows";
  } catch {
    return false;
  }
}

async function runShell(script, args, on, timeout = 30000) {
  try {
    return await exec("sh", ["-c", script, MOD, ...args], { on, timeout });
  } catch (error) {
    if (/cannot start sh|program not found|The system cannot find/i.test(String(error))) return null;
    throw error;
  }
}

async function runPowerShell(script, args, on, timeout = 30000) {
  return exec("powershell", ["-NoProfile", "-Command", script, ...args], { on, timeout });
}

async function directory(path, on) {
  if (!on && isWindow()) {
    const escaped = path.replace(/'/g, "''");
    const script =
      "& { param($p) [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object { $_.Name -ne '.git' } | Select-Object -First 501 | ForEach-Object { [PSCustomObject]@{ name=$_.Name; dir=[bool]$_.PSIsContainer } }) | ConvertTo-Json -Compress } '" +
      escaped +
      "'";
    const result = await runPowerShell(script, [], on);
    if (result.code !== 0) throw new Error(cleanError(result.stderr || "Cannot list this folder"));
    let parsed = [];
    try {
      parsed = JSON.parse(result.stdout || "[]");
    } catch {
      throw new Error("Cannot read this folder listing");
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter((row) => row && typeof row.name === "string").map((row) => ({ name: row.name, dir: Boolean(row.dir) }));
  }

  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = ".git" ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const result = await runShell(script, [path], on);
  if (result) {
    if (result.code !== 0) throw new Error(cleanError(result.stderr || "Cannot list this folder"));
    const fields = result.stdout.split("\0");
    const rows = [];
    for (let i = 0; i + 1 < fields.length; i += 2) rows.push({ name: fields[i + 1], dir: fields[i] === "d" });
    return rows;
  }
  return directoryWithPowerShell(path, on);
}

async function directoryWithPowerShell(path, on) {
  const escaped = path.replace(/'/g, "''");
  const script =
    "& { param($p) [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object { $_.Name -ne '.git' } | Select-Object -First 501 | ForEach-Object { [PSCustomObject]@{ name=$_.Name; dir=[bool]$_.PSIsContainer } }) | ConvertTo-Json -Compress } '" +
    escaped +
    "'";
  const result = await runPowerShell(script, [], on);
  if (result.code !== 0) throw new Error(cleanError(result.stderr || "Cannot list this folder"));
  const parsed = JSON.parse(result.stdout || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter((row) => row && typeof row.name === "string").map((row) => ({ name: row.name, dir: Boolean(row.dir) }));
}

function sortEntries(entries) {
  return entries
    .filter((entry) => entry.name && entry.name !== ".git")
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
}

async function pathExists(path, on) {
  const result = await runShell('test -e "$1"', [path], on);
  if (result) return result.code === 0;
  const quote = "'" + String(path).replace(/'/g, "''") + "'";
  const ps = await runPowerShell(`Test-Path -LiteralPath ${quote}`, [], on);
  return String(ps.stdout ?? "").trim().toLowerCase() === "true";
}

async function movePath(from, to, on) {
  const result = await runShell('mv -- "$1" "$2"', [from, to], on);
  if (result?.code === 0) return;
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const script = `Move-Item -LiteralPath ${quote(from)} -Destination ${quote(to)} -Force`;
  const ps = await runPowerShell(script, [], on);
  if (ps.code !== 0) throw new Error(cleanError(ps.stderr || result?.stderr || "Could not rename"));
}

async function deletePath(target, dir, on) {
  const result = await runShell(dir ? 'rm -rf -- "$1"' : 'rm -f -- "$1"', [target], on);
  if (result?.code === 0) return;
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const script = `Remove-Item -LiteralPath ${quote(target)} -Force -Recurse`;
  const ps = await runPowerShell(script, [], on);
  if (ps.code !== 0) throw new Error(cleanError(ps.stderr || result?.stderr || "Could not delete"));
}

function cacheBase(path) {
  return String(path).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
}

async function ensureCacheDir() {
  const dir = `${appHome()}/${CACHE_DIR}`;
  const result = await runShell('mkdir -p "$1"', [dir], null);
  if (result?.code === 0) return dir;
  const quote = "'" + dir.replace(/'/g, "''") + "'";
  await runPowerShell(`New-Item -ItemType Directory -Force -Path ${quote} | Out-Null`, [], null);
  return dir;
}

async function cleanCache(prefix, keepRel) {
  const dir = `${appHome()}/${CACHE_DIR}`;
  const full = `${appHome()}/${keepRel}`;
  await runShell('for old in "$1/$2"-*; do [ "$old" = "$3" ] || rm -f "$old"; done', [dir, prefix, full], null).catch(() => null);
}

async function readRemoteBase64(path, on) {
  const checkSize = (value) => {
    if (value.length >= 8 * 1024 * 1024 - 100) throw new Error("This picture is too large to preview");
    return value.replace(/\s+/g, "");
  };
  const result = await runShell('base64 "$1"', [path], on, 30000);
  if (result?.code === 0) return checkSize(result.stdout);
  try {
    const py = await exec("python3", ["-c", "import base64,sys; sys.stdout.write(base64.b64encode(open(sys.argv[1],'rb').read()).decode())", path], { on, timeout: 30000 });
    if (py.code === 0) return checkSize(py.stdout);
  } catch {}
  const quote = "'" + String(path).replace(/'/g, "''") + "'";
  const ps = await runPowerShell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote}))`, [], on, 30000);
  if (ps.code === 0) return checkSize(ps.stdout);
  throw new Error("Could not read the picture from that machine");
}

async function writeLocalBase64(rel, base64) {
  const full = `${appHome()}/${rel}`;
  const dir = `${appHome()}/${CACHE_DIR}`;
  await ensureCacheDir();
  const temp = `${full}.b64`;
  await writeTextFile(temp, base64, null);
  const written = await runShell('tmp="$1"; out="$2"; base64 -d "$tmp" > "$out" && rm -f "$tmp"', [temp, full], null, 60000);
  if (written?.code === 0) return;
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const psScript =
    `$b64 = [IO.File]::ReadAllText(${quote(temp)}); $bytes = [Convert]::FromBase64String($b64); [IO.File]::WriteAllBytes(${quote(full)}, $bytes); Remove-Item -LiteralPath ${quote(temp)} -Force`;
  const ps = await runPowerShell(psScript, [], null, 60000);
  if (ps.code !== 0) throw new Error(cleanError(ps.stderr || "Could not cache the picture"));
}

async function copyRasterToCache(abs, prefixBase, on) {

  const dir = `${appHome()}/${CACHE_DIR}`;
  const prefix = prefixBase ?? cacheBase(abs);
  const ext = splitPathInfo(abs).ext || "img";
  const rel = `${CACHE_DIR}/${prefix}-${Date.now()}.${ext}`;
  const full = `${appHome()}/${rel}`;
  const script = 'mkdir -p "$1" && cp -f "$2" "$3" && head -c 8192 "$2" | base64';
  const result = await runShell(script, [dir, abs, full], null);
  if (result?.code === 0) {
    const size = imageSizeFromBase64(result.stdout);
    await cleanCache(prefix, rel);
    return { rel, size };
  }
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const ps = await runPowerShell(
    `New-Item -ItemType Directory -Force -Path ${quote(dir)} | Out-Null; Copy-Item -LiteralPath ${quote(abs)} -Destination ${quote(full)} -Force`,
    [],
    null,
  );
  if (ps.code === 0) {
    await cleanCache(prefix, rel);
    return { rel, size: null };
  }
  throw new Error("Could not prepare the picture");
}

async function removeCache(rel) {
  if (!rel) return;
  await runShell('rm -f -- "$1"', [`${appHome()}/${rel}`], null).catch(() => null);
}

async function readZipEntry(path, entry, on) {
  const script = 'unzip -p "$1" "$2" 2>/dev/null || tar -xOf "$1" "$2" 2>/dev/null';
  const result = await runShell(script, [path, entry], on, 30000);
  if (result?.code === 0) {
    if (result.stdout.length >= 8 * 1024 * 1024 - 100) throw new Error("This workbook is too large to preview");
    return result.stdout;
  }
  try {
    const py = await exec(
      "python3",
      ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.write(z.read(sys.argv[2]).decode('utf-8'))", path, entry],
      { on, timeout: 30000 },
    );
    if (py.code === 0) return py.stdout;
  } catch {}
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const psScript =
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${quote(path)}); $e=$z.GetEntry(${quote(entry)}); if ($e) { $r=New-Object IO.StreamReader($e.Open()); [Console]::Out.Write($r.ReadToEnd()); $r.Dispose() } $z.Dispose()`;
  const ps = await runPowerShell(psScript, [], on, 30000);
  if (ps.code === 0) return ps.stdout;
  return null;
}

async function writeRemoteTextFile(path, text, expected, on) {
  const current = await readTextFile(path, { on });
  if (expected !== null && current !== null && current !== expected) throw new Error("File changed on disk; reload first");
  if (expected === null && current !== null) throw new Error("File already exists");
  const chunks = [];
  const encoded = utf8ToBase64(text);
  for (let i = 0; i < encoded.length; i += 5000) chunks.push(encoded.slice(i, i + 5000));
  const script =
    'target="$1"; shift; tmp="$target.tmp.$$"; (for c in "$@"; do printf "%s" "$c"; done | (base64 -d 2>/dev/null || base64 -D) > "$tmp") && mv -f "$tmp" "$target"';
  const result = await runShell(script, [path, ...chunks], on, 60000);
  if (result?.code === 0) return;
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const chunkList = chunks.map((chunk) => quote(chunk)).join(",");
  const psScript =
    `$target = ${quote(path)}; $chunks = @(${chunkList}); $bytes = [Convert]::FromBase64String([string]::Join('', $chunks)); $tmp = "$target.tmp.$PID"; [IO.File]::WriteAllBytes($tmp, $bytes); Move-Item -LiteralPath $tmp -Destination $target -Force`;
  const ps = await runPowerShell(psScript, [], on, 60000);
  if (ps.code !== 0) throw new Error(cleanError(ps.stderr || result?.stderr || "Could not write this file"));
}

function commandProps() {
  return props() ?? {};
}

function requestRender(cx) {
  try {
    const phase = cx.phase();
    if (phase !== "render" && phase !== "layout") cx.notify();
  } catch {}
}

function activeTabs() {
  return spaces().find((space) => space.active)?.tabs ?? [];
}

// ---- view -------------------------------------------------------------------

export default class FarrierFiles extends View {
  init(_props, cx) {
    this.mode = commandProps().file ? "file" : "tree";
    this.closed = false;
    this.handle = cx.focus_handle();
    this.dialog = null;
    this.sections = { explorer: true, search: false, ...(shared("farrier.files.sections") ?? {}) };
    this.dirtyMap = shared("farrier.files.dirty") ?? {};
    this.watchingCommands = false;
    this.inputFocused = false;
    this.renameText = "";
    this.pendingOpens = Object.create(null);
    this.previewKeys = new Set();
    this.lastTreeClick = { path: "", at: 0 };
    this.lastSearchClick = { key: "", at: 0 };
    this.lastActiveFile = "";
    this.syncFileToken = null;
    this.revealToken = null;
    this.pendingCloseTab = null;
    if (this.mode === "file") this.initFile(cx);
    else this.initTree(cx);
    this.watchCommands(cx);
  }

  initTree(cx) {
    this.rows = [];
    this.rowByPath = new Map();
    this.rowIndexByPath = new Map();
    this.kindCache = new Map();
    this.keyCache = new Map();
    this.nodes = null;
    this.root = "";
    this.on = null;
    this.context = null;
    this.lazy = false;
    this.prefix = "";
    this.marks = {};
    this.expanded = new Set();
    this.selectedPath = null;
    this.filterText = "";
    this.loading = false;
    this.error = null;
    this.limited = false;
    this.stale = false;
    this.watched = null;
    this.watchPromise = null;
    this.loadToken = null;
    this.indexing = false;
    this.indexPending = false;
    this.changeToken = null;
    this.filterToken = null;
    this.menu = null;
    this.menuTarget = null;
    this.menuItems = [];
    this.menuIndex = 0;
    this.menuHandle = cx.focus_handle();
    this.dialog = null;
    this.treeScroll = VirtualListScrollHandle.new();
    this.searchScroll = VirtualListScrollHandle.new();
    this.searchGroups = [];
    this.searchRows = [];
    this.searchSizes = [];
    this.searchMeta = null;
    this.searchLoading = false;
    this.searchSeq = 0;
    this.searchByContext = new Map();
    this.searchSyncToken = null;
    this.collapsedFiles = new Set();
    this.searchSelectedFile = null;
    this.searchSelectedMatch = null;
    this.rgAvailable = null;
    this.search = {
      query: "",
      replaceOpen: false,
      filtersOpen: false,
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      preserveCase: false,
      include: "",
      exclude: "",
      replace: "",
      ...(shared("farrier.files.searchOptions") ?? {}),
    };

    this.filterInput = InputState.new({ placeholder: "Filter files" });
    this.filterInput.on("change", (_event, cx) => {
      this.filterText = this.filterInput.value();
      this.scheduleFilter(cx);
    });
    this.filterInput.on("focus", (_event, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.filterInput.on("blur", (_event, cx) => {
      this.inputFocused = false;
    });

    this.searchInput = TextareaState.new({ placeholder: "Search files or paste a block", value: this.search.query, rows: 1 });
    this.searchInput.set_auto_grow(1, 3);
    this.searchInput.set_soft_wrap(true);
    this.searchInput.on("change", (_event, cx) => {
      this.search.query = this.searchInput.value();
      this.scheduleSearch(cx);
    });
    this.searchInput.on("submit", (_event, cx) => {
      const first = this.searchRows.find((row) => row.kind === "match");
      if (first) this.activateSearchRow(first.key, cx);
    });
    this.searchInput.on("focus", (_event, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.searchInput.on("blur", (_event, cx) => {
      this.inputFocused = false;
    });

    this.replaceInput = InputState.new({ placeholder: "Replace with", value: this.search.replace });
    this.replaceInput.on("change", (_event, cx) => {
      this.search.replace = this.replaceInput.value();
      cx.notify();
    });
    this.replaceInput.on("focus", (_event, cx) => {
      this.inputFocused = true;
    });
    this.replaceInput.on("blur", (_event) => {
      this.inputFocused = false;
    });

    this.includeInput = InputState.new({ placeholder: "Files to include", value: this.search.include });
    this.includeInput.on("change", (_event, cx) => {
      this.search.include = this.includeInput.value();
      this.scheduleSearch(cx);
    });
    this.includeInput.on("focus", (_event) => {
      this.inputFocused = true;
    });
    this.includeInput.on("blur", () => {
      this.inputFocused = false;
    });

    this.excludeInput = InputState.new({ placeholder: "Files to exclude", value: this.search.exclude });
    this.excludeInput.on("change", (_event, cx) => {
      this.search.exclude = this.excludeInput.value();
      this.scheduleSearch(cx);
    });
    this.excludeInput.on("focus", (_event) => {
      this.inputFocused = true;
    });
    this.excludeInput.on("blur", () => {
      this.inputFocused = false;
    });

    this.propSearchPending = false;
    this.requestedSearch = false;
    this.searchWantReplaceDialog = false;
    const requestedSearch = commandProps().search;
    if (requestedSearch && typeof requestedSearch === "object") {
      this.sections = { ...this.sections, search: true };
      this.search.query = String(requestedSearch.query ?? "");
      this.search.caseSensitive = requestedSearch.caseSensitive === true;
      this.search.wholeWord = requestedSearch.wholeWord === true;
      this.search.regex = requestedSearch.regex === true;
      this.search.include = String(requestedSearch.include ?? "");
      this.search.exclude = String(requestedSearch.exclude ?? "");
      this.search.replace = String(requestedSearch.replace ?? "");
      this.search.replaceOpen = requestedSearch.replaceOpen === true || requestedSearch.replaceDialog === true;
      this.search.preserveCase = requestedSearch.preserveCase === true;
      this.searchInput.set_value(this.search.query);
      this.replaceInput.set_value(this.search.replace);
      this.includeInput.set_value(this.search.include);
      this.excludeInput.set_value(this.search.exclude);
      this.propSearchPending = Boolean(this.search.query.trim());
      this.requestedSearch = this.propSearchPending;
      this.searchWantReplaceDialog = requestedSearch.replaceDialog === true;
    }

    this.renameInput = InputState.new({ placeholder: "New name", value: "" });
    this.renameInput.on("change", (_event, cx) => {
      this.renameText = this.renameInput.value();
      cx.notify();
    });
    this.renameInput.on("submit", (_event, cx) => this.confirmRename(cx));
    this.renameInput.on("focus", (_event) => {
      this.inputFocused = true;
    });
    this.renameInput.on("blur", () => {
      this.inputFocused = false;
    });

    if (checking()) return;
    this.refresh(cx);
  }

  initFile(cx) {
    const p = commandProps();
    const target = normalizeTarget(p);
    this.root = target.root;
    this.file = target.file;
    this.on = p.on ?? null;
    this.abs = resolveAbsolutePath(this.root, this.file);
    this.cachePrefix = `${cacheBase(this.abs)}-${Math.random().toString(36).slice(2, 8)}`;
    this.isMarkdown = isMarkdown(this.file);
    this.isSvg = isSvg(this.file);
    this.isCsv = isCsv(this.file);
    this.isXlsx = isXlsx(this.file);
    this.isRaster = isRasterImage(this.file);
    this.isImage = this.isRaster || this.isSvg;
    this.kind = fileKind(this.file);
    this.markdownId = `farrier-files-md-${this.file.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    this.viewMode = p.viewMode === "code" || p.find ? "code" : this.defaultViewMode();
    this.wrap = p.wrap === true || shared("farrier.files.wrap") === true;
    this.zoom = 100;
    this.viewport = null;
    this.code = null;
    this.editorSelection = null;
    this.text = "";
    this.savedText = "";
    this.lineCount = 0;
    this.dirty = false;
    this.saving = false;
    this.saveConflict = null;
    this.loading = false;
    this.loaded = false;
    this.binary = false;
    this.truncated = false;
    this.readonly = false;
    this.readonlyReason = "";
    this.fileError = null;
    this.spreadsheet = null;
    this.workbook = null;
    this.activeSheet = 0;
    this.imageSrc = null;
    this.imageRel = null;
    this.imageSize = null;
    this.imageLoading = false;
    this.findScroll = VirtualListScrollHandle.new();
    this.findUndo = [];
    this.findToken = null;
    this.findText = "";
    this.findLineStarts = [];
    this.findFocus = "query";
    this.findApplied = false;
    this.lastPendingFind = 0;
    this.pendingFindToken = null;
    this.syncFileToken = null;
    this.filesWatchPromise = null;
    this.watchedFile = null;
    this.watchedAbs = null;
    this.fileWatchToken = null;
    this.loadToken = null;
    this.reloadToken = null;
    const findPrefs = shared("farrier.files.find") ?? {};
    this.find = {
      open: false,
      replaceOpen: findPrefs.replaceOpen === true,
      query: String(findPrefs.query ?? ""),
      caseSensitive: findPrefs.caseSensitive === true,
      wholeWord: findPrefs.wholeWord === true,
      regex: findPrefs.regex === true,
      replace: String(findPrefs.replace ?? ""),
      preserveCase: findPrefs.preserveCase === true,
      matches: [],
      current: 0,
      valid: true,
      error: null,
    };

    this.findInput = TextareaState.new({ placeholder: "Find", value: this.find.query, rows: 1 });
    this.findInput.set_auto_grow(1, 3);
    this.findInput.set_soft_wrap(true);
    this.findInput.on("change", (_event, cx) => {
      this.find.query = this.findInput.value();
      this.find.current = 0;
      this.refreshFindSoon(cx);
    });
    this.findInput.on("submit", (event, cx) => this.stepFind(event?.shift ? -1 : 1, cx));
    this.findInput.on("focus", (_event) => {
      this.findFocus = "query";
      this.inputFocused = true;
    });
    this.findInput.on("blur", () => {
      this.inputFocused = false;
      this.persistFindPrefs();
    });

    this.findReplaceInput = InputState.new({ placeholder: "Replace with", value: this.find.replace });
    this.findReplaceInput.on("change", (_event, cx) => {
      this.find.replace = this.findReplaceInput.value();
      cx.notify();
    });
    this.findReplaceInput.on("submit", (_event, cx) => this.replaceCurrent(cx));
    this.findReplaceInput.on("focus", (_event) => {
      this.findFocus = "replace";
      this.inputFocused = true;
    });
    this.findReplaceInput.on("blur", () => {
      this.inputFocused = false;
      this.persistFindPrefs();
    });

    if (checking()) return;
    this.loadFile(cx);
  }

  watchCommands(cx) {
    if (this.watchingCommands) return;
    this.watchingCommands = true;
    cx.spawn(async (inner) => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed || !command) return;
        if (command === "focus") this.focusMain(inner);
        else if (command === "search" && this.mode === "tree") this.openSearch(inner);
        else if (command === "find" && this.mode === "file") this.openFind(inner);
        inner.notify();
      }
    });
  }

  focusMain(cx) {
    if (this.mode === "file" && this.code && this.viewMode === "code") this.code.focus();
    else this.handle.focus();
    cx.notify();
  }

  async close(_cx) {
    this.closed = true;
    try {
      this.stopWatch();
    } catch {}
    try {
      this.filesWatchPromise?.cancel();
    } catch {}
    if (this.mode === "file" && this.file) {
      const key = tabFileKey(this.root, this.file);
      if (this.code && this.dirty) {
        let selection = null;
        try {
          selection = this.code.selected_range();
        } catch {}
        writeBuffered(key, {
          text: this.code.value(),
          disk: this.savedText,
          selection,
          viewMode: this.viewMode,
          wrap: this.wrap,
          zoom: this.zoom,
          at: Date.now(),
        });
      }
      else clearBuffered(key);
    }
    if (this.code) {
      try {
        this.code.release();
      } catch {}
    }
    for (const state of [this.filterInput, this.searchInput, this.replaceInput, this.includeInput, this.excludeInput, this.renameInput, this.findInput, this.findReplaceInput]) {
      try {
        state?.release();
      } catch {}
    }
    for (const handle of [this.treeScroll, this.searchScroll, this.findScroll]) {
      try {
        handle?.release();
      } catch {}
    }
    if (this.mode === "file" && this.file) {
      const key = tabFileKey(this.root, this.file);
      const map = shared("farrier.files.dirty");
      if (map && map[key]) {
        const next = { ...map };
        delete next[key];
        setShared("farrier.files.dirty", next);
      }
    }
    await removeCache(this.imageRel);
  }

  panelShown() {
    const p = commandProps();
    if (p.overlay) return true;
    if (p.file) {
      const activeTab = spaces().find((space) => space.active)?.tabs.find((tab) => tab.active);
      return Boolean(activeTab) && panes().some((pane) => pane.mod === MOD && pane.tab === activeTab.id);
    }
    try {
      const paths = findModPaths(layout(), MOD);
      if (!paths.length) {
        const activeTab = spaces().find((space) => space.active)?.tabs.find((tab) => tab.active);
        return Boolean(activeTab) && panes().some((pane) => pane.mod === MOD && pane.tab === activeTab.id);
      }
      if (paths.some(pathShown)) return true;
      const activeTab = spaces().find((space) => space.active)?.tabs.find((tab) => tab.active);
      return Boolean(activeTab) && panes().some((pane) => pane.mod === MOD && pane.tab === activeTab.id);
    } catch {
      return true;
    }
  }

  // ---- tree: data -----------------------------------------------------------

  refresh(cx, force = false) {
    if (this.mode !== "tree" || checking()) return;
    if (!this.panelShown()) {
      this.stale = true;
      this.stopWatch();
      return;
    }
    const place = location();
    const key = JSON.stringify(place);
    const keepSearch = this.requestedSearch;
    if (!place.cwd) {
      if (!keepSearch) this.saveSearchState();
      this.clearSearchResults();
      this.stopWatch();
      this.context = { key, ...place };
      this.root = "";
      this.on = null;
      this.nodes = null;
      this.clearRows();
      this.error = "No folder";
      this.loading = false;
      if (!keepSearch) this.applySearchState({}, key, cx);
      requestRender(cx);
      return;
    }
    if (!this.context || this.context.key !== key) {
      if (!keepSearch) this.saveSearchState();
      this.clearSearchResults();
      this.stopWatch();
      this.context = { key, ...place };
      this.root = place.cwd;
      this.on = place.on ?? null;
      this.prefix = "";
      this.nodes = null;
      this.clearRows();
      this.kindCache.clear();
      this.keyCache.clear();
      this.marks = {};
      this.lazy = false;
      this.error = null;
      this.limited = false;
      this.selectedPath = null;
      this.menu = null;
      this.menuTarget = null;
      this.dialog = null;
      if (!keepSearch) this.applySearchState(this.searchByContext.get(key) ?? {}, key, cx);
      this.restoreExpanded();
      this.loadRoot(cx);
      return;
    }
    if (force || this.stale) {
      this.stale = false;
      this.loadRoot(cx);
    }
  }

  clearSearchResults() {
    this.searchSeq += 1;
    this.searchGroups = [];
    this.setSearchRows([]);
    this.searchMeta = null;
    this.searchSelectedFile = null;
    this.searchSelectedMatch = null;
    this.searchLoading = false;
  }

  saveSearchState() {
    if (!this.context?.key || !this.root) return;
    const state = {
      query: this.search.query,
      include: this.search.include,
      exclude: this.search.exclude,
      replace: this.search.replace,
      collapsedFiles: [...this.collapsedFiles],
    };
    if (!state.query && !state.include && !state.exclude && !state.replace && !state.collapsedFiles.length) return;
    this.searchByContext.set(this.context.key, state);
    while (this.searchByContext.size > 32) {
      this.searchByContext.delete(this.searchByContext.keys().next().value);
    }
  }

  applySearchState(state, key, cx) {
    this.search.query = String(state?.query ?? "");
    this.search.include = String(state?.include ?? "");
    this.search.exclude = String(state?.exclude ?? "");
    this.search.replace = String(state?.replace ?? "");
    this.collapsedFiles = new Set(state?.collapsedFiles ?? []);
    this.lastSearchClick = { key: "", at: 0 };
    this.searchWantReplaceDialog = false;
    this.propSearchPending = Boolean(this.search.query.trim());
    const token = {};
    this.searchSyncToken = token;
    cx?.spawn(async (inner) => {
      await inner.sleep(0);
      if (this.searchSyncToken !== token || this.closed || this.context?.key !== key) return;
      this.searchSyncToken = null;
      this.searchInput?.set_value(this.search.query);
      this.includeInput?.set_value(this.search.include);
      this.excludeInput?.set_value(this.search.exclude);
      this.replaceInput?.set_value(this.search.replace);
      inner.notify();
    });
  }

  restoreExpanded() {
    const saved = shared("farrier.files.open");
    if (saved && saved.root === this.root) {
      this.expanded = Array.isArray(saved.paths) ? new Set(saved.paths.filter((path) => Boolean(path))) : new Set();
      this.selectedPath = typeof saved.selected === "string" && saved.selected ? saved.selected : null;
      return;
    }
    this.expanded = new Set();
    this.selectedPath = null;
  }

  persistExpanded() {
    setShared("farrier.files.open", {
      root: this.root,
      paths: [...this.expanded].slice(0, 3000),
      selected: typeof this.selectedPath === "string" && this.selectedPath ? this.selectedPath : null,
    });
  }

  loadRoot(cx, options = {}) {
    const ctx = this.context;
    if (!ctx) return;
    if (this.indexing) {
      this.indexPending = true;
      return;
    }
    this.indexing = true;
    const token = {};
    this.loadToken = token;
    if (!options.silent) this.loading = true;
    this.error = null;
    const root = this.root;
    const on = this.on;
    let asyncCx = null;
    const done = () => {
      if (this.loadToken === token) this.indexing = false;
      if (this.indexPending && !this.closed && asyncCx) {
        this.indexPending = false;
        this.loadRoot(asyncCx, { silent: true });
      } else {
        this.indexPending = false;
      }
    };
    cx.spawn(async (inner) => {
      asyncCx = inner;
      let usedGit = false;
      try {
        const [listing, status, prefix] = await Promise.all([
          exec("git", [...READ_FLAGS, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, on, timeout: 25000 }),
          exec("git", [...READ_FLAGS, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on, timeout: 25000 }).catch(() => null),
          exec("git", [...READ_FLAGS, "rev-parse", "--show-prefix"], { cwd: root, on, timeout: 8000 }).catch(() => null),
        ]);
        if (this.loadToken !== token || this.context !== ctx) {
          done();
          return;
        }
        if (listing.code === 0) {
          usedGit = true;
          const paths = parseLsFiles(listing.stdout);
          const tree = buildTree([], MAX_TREE_PATHS);
          let used = 0;
          for (let index = 0; index < paths.length && used < MAX_TREE_PATHS; index += 1) {
            if (insertTreePath(tree.root, paths[index])) used += 1;
            if (index % 3000 === 0) {
              await inner.sleep(0);
              if (this.loadToken !== token || this.context !== ctx) {
                done();
                return;
              }
            }
          }
          tree.used = used;
          tree.limited = used < paths.length;
          sortTree(tree.root);
          this.nodes = tree.root;
          this.lazy = false;
          this.limited = tree.limited;
          this.marks = status?.code === 0 ? parseGitStatus(status.stdout) : {};
          this.prefix = prefix?.code === 0 ? String(prefix.stdout ?? "").trim().split("\\").join("/") : null;
          if (this.prefix) {
            const strip = this.prefix;
            const relative = Object.create(null);
            for (const [file, mark] of Object.entries(this.marks)) {
              if (file.startsWith(strip)) relative[file.slice(strip.length)] = mark;
            }
            this.marks = relative;
          } else if (prefix?.code !== 0) {
            this.marks = {};
          }
          this.pruneExpanded();
        } else {
          usedGit = false;
        }
      } catch {
        usedGit = false;
      }
      if (this.loadToken !== token || this.context !== ctx) {
        done();
        return;
      }
      if (usedGit) {
        const wanted = this.selectedPath;
        this.rebuildRows();
        if (wanted) this.revealPath(wanted, inner, { clearFilter: false });
        if (this.propSearchPending) {
          this.propSearchPending = false;
          this.requestedSearch = false;
          this.scheduleSearch(inner);
        }
        this.loading = false;
        this.error = null;
        this.startWatch(root, inner);
        inner.notify();
        done();
        return;
      }
      try {
        this.lazy = true;
        const tree = buildTree([], MAX_TREE_PATHS);
        this.nodes = tree.root;
        this.prefix = "";
        this.marks = {};
        this.limited = false;
        await this.ensureFolder("", ctx, token, inner, true);
        for (const path of [...this.expanded].sort((a, b) => a.split("/").length - b.split("/").length).slice(0, 100)) {
          const node = findNode(this.nodes, path);
          if (node?.dir && !node.loaded) await this.ensureFolder(path, ctx, token, inner);
          if (this.loadToken !== token || this.context !== ctx) break;
        }
        if (this.loadToken !== token || this.context !== ctx) {
          done();
          return;
        }
        const wanted = this.selectedPath;
        this.rebuildRows();
        if (wanted) this.revealPath(wanted, inner, { clearFilter: false });
        if (this.propSearchPending) {
          this.propSearchPending = false;
          this.requestedSearch = false;
          this.scheduleSearch(inner);
        }
        this.loading = false;
        this.error = null;
        this.startWatch(root, inner);
      } catch (error) {
        if (this.loadToken === token && this.context === ctx) {
          this.error = cleanError(String(error));
          this.loading = false;
        }
      } finally {
        inner.notify();
        done();
      }
    });
  }

  pruneExpanded() {
    if (!this.nodes) {
      this.expanded = new Set();
      return;
    }
    for (const path of [...this.expanded]) {
      const node = findNode(this.nodes, path);
      if (!node || !node.dir) this.expanded.delete(path);
    }
  }

  refreshIndex(cx, token) {
    const ctx = this.context;
    if (!ctx || !this.nodes || this.indexing || this.closed) {
      if (this.indexing) this.indexPending = true;
      return;
    }
    if (!this.panelShown()) {
      this.stale = true;
      return;
    }
    const root = this.root;
    const on = this.on;
    cx.spawn(async (inner) => {
      try {
        const status = await exec("git", [...READ_FLAGS, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on, timeout: 25000 });
        if (this.changeToken !== token || this.context !== ctx || this.closed) return;
        if (status.code !== 0) {
          this.loadRoot(inner, { silent: true });
          return;
        }
        let records = parseGitStatusRecords(status.stdout);
        if (this.prefix === null) {
          records = [];
        } else if (this.prefix) {
          const strip = this.prefix;
          records = records.filter((record) => record.path.startsWith(strip)).map((record) => ({ ...record, path: record.path.slice(strip.length) }));
        }
        const marks = Object.create(null);
        let structureChanged = false;
        for (const record of records) {
          marks[record.path] = record.mark;
          if (record.xy.includes("D")) {
            if (removeTreePath(this.nodes, record.path)) structureChanged = true;
          } else if (record.mark === "A" && !findNode(this.nodes, record.path)) {
            if (addTreePath(this.nodes, record.path)) structureChanged = true;
          }
        }
        this.marks = marks;
        this.error = null;
        if (structureChanged) {
          this.pruneExpanded();
          this.rebuildRows();
          if (this.selectedPath && !this.rowByPath.has(this.selectedPath)) this.selectedPath = null;
        }
        inner.notify();
      } catch {
        if (this.context === ctx) this.loadRoot(inner, { silent: true });
      }
    });
  }

  async ensureFolder(path, ctx, token, cx, force = false) {
    const node = findNode(this.nodes, path);
    if (!node || !node.dir) return;
    if (node.loaded && !force) return;
    if (force) node.loaded = false;
    const entries = await directory(resolveAbsolutePath(this.root, path), this.on);
    if (this.loadToken !== token || this.context !== ctx) return;
    if (entries.length > 500) this.limited = true;
    const sorted = sortEntries(entries).slice(0, 500);
    node.children = sorted.map((entry) => {
      const childPath = path ? `${path}/${entry.name}` : entry.name;
      return {
        name: entry.name,
        path: childPath,
        dir: entry.dir,
        children: entry.dir ? [] : null,
        loaded: false,
      };
    });
    node.loaded = true;
  }

  clearRows() {
    this.rows = [];
    this.rowByPath = new Map();
    this.rowIndexByPath = new Map();
  }

  rebuildRows() {
    if (!this.nodes) {
      this.clearRows();
      return;
    }
    this.rows = filterRows(this.nodes, this.expanded, this.filterText, 30000);
    this.rowByPath = new Map();
    this.rowIndexByPath = new Map();
    for (let index = 0; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      this.rowByPath.set(row.path, row);
      this.rowIndexByPath.set(row.path, index);
    }
    if (this.selectedPath && !this.rowByPath.has(this.selectedPath)) {
      this.selectedPath = null;
    }
  }

  /** Selects `path` in the tree, opening the folders above it and clearing a filter that hides it. */
  revealPath(path, cx, options = {}) {
    if (!path || this.mode !== "tree") return;
    const reveal = {};
    this.revealToken = reveal;
    let changed = false;
    for (const dir of ancestorPaths(path)) {
      const node = this.nodes ? findNode(this.nodes, dir) : null;
      if (!node?.dir) continue;
      if (!this.expanded.has(dir)) {
        this.expanded.add(dir);
        changed = true;
      }
    }
    this.selectedPath = path;
    if (changed || !this.rowByPath.has(path)) this.rebuildRows();
    this.selectedPath = path;
    const needsLoad = this.lazy && this.nodes && nextUnloadedAncestor(this.nodes, path);
    if (needsLoad) {
      this.revealLazy(path, cx, options, reveal);
      return;
    }
    this.finishReveal(path, cx, options, reveal);
  }

  revealLazy(path, cx, options, reveal) {
    const ctx = this.context;
    const token = this.loadToken;
    cx.spawn(async (inner) => {
      try {
        let guard = 0;
        while (!this.closed && this.context === ctx && this.revealToken === reveal && guard++ < 64) {
          for (const dir of ancestorPaths(path)) {
            const node = findNode(this.nodes, dir);
            if (node?.dir && !this.expanded.has(dir)) this.expanded.add(dir);
          }
          const next = nextUnloadedAncestor(this.nodes, path);
          if (!next) break;
          await this.ensureFolder(next, ctx, token, inner);
          if (this.loadToken !== token || this.closed || this.context !== ctx || this.revealToken !== reveal) return;
        }
      } catch {}
      if (this.closed || this.context !== ctx || this.revealToken !== reveal) return;
      this.finishReveal(path, inner, options, reveal);
    });
  }

  finishReveal(path, cx, options, reveal) {
    if (reveal !== this.revealToken) return;
    this.rebuildRows();
    this.selectedPath = path;
    let index = this.rowIndexByPath.get(path);
    if (
      index === undefined &&
      options?.clearFilter !== false &&
      String(this.filterText ?? "").trim() &&
      this.nodes &&
      findNode(this.nodes, path)
    ) {
      this.filterText = "";
      this.filterInput?.set_value("");
      this.rebuildRows();
      this.selectedPath = path;
      index = this.rowIndexByPath.get(path);
    }
    if (options?.scroll !== false && index !== undefined) this.treeScroll?.scroll_to_item(index, "center");
    if (options?.persist !== false) this.persistExpanded();
    cx?.notify();
  }

  scheduleFilter(cx) {
    const token = {};
    this.filterToken = token;
    cx.spawn(async (inner) => {
      await inner.sleep(100);
      if (this.filterToken !== token || this.closed) return;
      this.rebuildRows();
      inner.notify();
    });
  }

  startWatch(root, cx) {
    if (this.on || this.watched === root || checking()) return;
    if (!this.panelShown()) {
      this.stale = true;
      return;
    }
    this.stopWatch();
    this.watched = root;
    const ctx = this.context;
    cx.spawn(async (inner) => {
      try {
        for (;;) {
          if (this.context !== ctx || this.watched !== root || this.closed) return;
          const pending = watchFolder(root);
          this.watchPromise = pending;
          const paths = await pending;
          if (this.context !== ctx || this.watched !== root || this.closed) return;
          this.onFolderChanges(paths, cx);
        }
      } catch {
        if (this.context === ctx && this.watched === root) this.watched = null;
      }
    });
  }

  stopWatch() {
    try {
      this.watchPromise?.cancel();
    } catch {}
    this.watchPromise = null;
    this.watched = null;
  }

  stopFileWatch() {
    try {
      this.filesWatchPromise?.cancel();
    } catch {}
    this.filesWatchPromise = null;
    this.fileWatchToken = null;
    this.watchedFile = null;
    this.watchedAbs = null;
  }

  onFolderChanges(paths, cx) {
    if (!this.panelShown()) return;
    const token = {};
    this.changeToken = token;
    cx.spawn(async (inner) => {
      await inner.sleep(260);
      if (this.changeToken !== token || this.closed || !this.panelShown()) return;
      if (this.lazy) this.refreshChangedFolders(paths, cx);
      else this.refreshIndex(cx, token);
      inner.notify();
    });
  }

  refreshChangedFolders(paths, cx) {
    const ctx = this.context;
    const token = this.loadToken;
    const dirs = new Set();
    for (const path of paths ?? []) {
      const normalized = String(path).replace(/\\/g, "/").replace(/^\.\//, "");
      const rel = this.root && normalized.startsWith(this.root + "/") ? normalized.slice(this.root.length + 1) : normalized;
      const parent = parentPath(rel);
      dirs.add(parent);
    }
    for (const path of dirs) {
      const node = findNode(this.nodes, path);
      if (!node?.dir || !node.loaded) continue;
      this.ensureFolder(path, ctx, token, cx, true)
        .then(() => {
          if (this.context === ctx && this.loadToken === token) {
            this.rebuildRows();
            cx.notify();
          }
        })
        .catch(() => null);
    }
  }

  toggleFolder(path, cx) {
    const node = findNode(this.nodes, path);
    if (!node?.dir) return;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.rebuildRows();
      this.persistExpanded();
      cx.notify();
      return;
    }
    this.expanded.add(path);
    this.rebuildRows();
    this.persistExpanded();
    cx.notify();
    if (this.lazy && !node.loaded) {
      const ctx = this.context;
      const token = this.loadToken;
      this.ensureFolder(path, ctx, token, cx)
        .then(() => {
          if (this.context === ctx && this.loadToken === token) {
            this.rebuildRows();
            cx.notify();
          }
        })
        .catch((error) => {
          if (this.context === ctx) {
            this.error = cleanError(String(error));
            cx.notify();
          }
        });
    }
  }

  activateTreeRow(key, cx) {
    const row = this.rowByPath.get(key);
    if (!row) return;
    this.selectRow(row, cx);
    if (row.dir) {
      this.lastTreeClick = { path: "", at: 0 };
      this.toggleFolder(key, cx);
      return;
    }
    const now = Date.now();
    const doubleClick = this.lastTreeClick.path === key && now - this.lastTreeClick.at < 500;
    this.lastTreeClick = { path: key, at: now };
    this.openFile(key, cx, { permanent: doubleClick });
  }

  selectRow(row, cx) {
    this.selectedPath = row.path;
    const index = this.rowIndexByPath.get(row.path);
    if (index !== undefined) this.treeScroll?.scroll_to_item(index, "center");
    cx.notify();
  }

  rememberTreeRow(key, event, cx) {
    const row = this.rowByPath.get(key);
    if (!row) return;
    this.menuTarget = { path: row.path, dir: row.dir };
    this.selectedPath = row.path;
    cx.notify();
  }

  openContextMenuAt(event, cx) {
    if (!this.menuTarget) {
      if (this.menu) this.closeMenu(cx);
      return;
    }
    const target = this.menuTarget;
    this.menu = {
      ...target,
      x: event.local_position?.x ?? 20,
      y: event.local_position?.y ?? 20,
      bounds: event.bounds ?? null,
    };
    this.menuItems = this.contextMenuItems(target.path, target.dir);
    this.menuIndex = 0;
    this.menuTarget = null;
    cx.notify();
    cx.spawn(async (inner) => {
      await inner.sleep(20);
      if (this.menu) this.menuHandle.focus();
    });
  }

  contextMenuItems(path, dir) {
    const items = [];
    if (!dir) {
      items.push({ key: "open", label: "Open file", icon: "file", action: (cx) => this.openFile(path, cx, { permanent: true }) });
      items.push({ key: "pane", label: "Place in empty pane", icon: "split-right", action: (cx) => this.placeInEmptyPane(path, cx) });
    }
    items.push({
      key: "folder",
      label: dir ? "Open folder" : "Open in folder",
      icon: "folder-open",
      action: (cx) => this.openInFileManager(path, cx),
    });
    if (!dir && this.isPathPreview(path)) {
      items.push({ key: "keep", label: "Keep open", icon: "check", action: (cx) => this.keepOpen(path, cx) });
    }
    items.push({ key: "copy", label: "Copy path", icon: "copy", action: (cx) => this.copyPath(path, cx) });
    items.push({ key: "rename", label: "Rename", icon: "pencil", action: (cx) => this.startRename(path, cx) });
    items.push({ key: "delete", label: "Delete", icon: "trash", danger: true, action: (cx) => this.startDelete(path, cx) });
    return items;
  }

  runMenuItem(index, cx) {
    const item = this.menuItems[index];
    if (!item) return;
    this.menuIndex = index;
    this.closeMenu(cx, false, false);
    item.action(cx);
  }

  onMenuKey(event, cx) {
    const key = event.key;
    if (key === "escape") {
      this.closeMenu(cx);
      cx.stop_propagation();
      return;
    }
    if (key === "arrow_down") {
      if (this.menuItems.length) {
        this.menuIndex = (this.menuIndex + 1) % this.menuItems.length;
        cx.notify();
      }
      cx.stop_propagation();
      return;
    }
    if (key === "arrow_up") {
      if (this.menuItems.length) {
        this.menuIndex = (this.menuIndex - 1 + this.menuItems.length) % this.menuItems.length;
        cx.notify();
      }
      cx.stop_propagation();
      return;
    }
    if (key === "home") {
      this.menuIndex = 0;
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (key === "end") {
      this.menuIndex = Math.max(0, this.menuItems.length - 1);
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (key === "enter") {
      this.runMenuItem(this.menuIndex, cx);
      cx.stop_propagation();
    }
  }

  closeMenu(cx, notify = true, restoreFocus = true) {
    this.menu = null;
    this.menuItems = [];
    this.menuIndex = 0;
    if (restoreFocus) this.handle.focus();
    if (notify) cx.notify();
  }

  closeDialog(cx) {
    this.dialog = null;
    this.saveConflict = null;
    cx.notify();
  }

  clearError(cx) {
    this.error = null;
    cx.notify();
  }

  copySelectedPath(cx) {
    if (this.selectedPath) this.copyPath(this.selectedPath, cx);
  }

  openInFileManager(path, cx) {
    const abs = path ? this.absoluteFor(path) : this.root;
    if (!abs) return;
    if (this.on) {
      notify({
        title: "Open in folder is local only",
        body: "This file lives on another machine. Copy its path and open it there.",
        level: "warning",
        timeout: 3500,
      });
      return;
    }
    const directory =
      !path || (this.mode === "tree" && this.isDir(path))
        ? abs
        : abs.slice(0, Math.max(0, abs.lastIndexOf("/"))) || abs;
    const platform = window()?.platform;
    cx.spawn(async (inner) => {
      try {
        let result;
        if (platform === "windows") {
          result = await exec("cmd.exe", ["/c", "start", "", directory], { timeout: 10000 });
        } else if (platform === "macos") {
          result = await exec("open", [directory], { timeout: 10000 });
        } else {
          result = await exec("xdg-open", [directory], { timeout: 10000 });
        }
        if (result.code !== 0) throw new Error(cleanError(result.stderr || result.stdout) || "Could not open the folder");
      } catch (error) {
        if (!this.closed) notify({ title: "Could not open the folder", body: cleanError(String(error)), level: "error", timeout: 4500 });
      }
    });
  }

  copyPath(path, cx) {
    const abs = this.absoluteFor(path);
    cx.write_to_clipboard(abs);
    notify({ title: splitPathInfo(path).dir ? "Folder path copied" : "File path copied", body: abs, level: "success", timeout: 1500 });
    this.handle.focus();
    cx.notify();
  }

  startRename(path, cx) {
    const info = splitPathInfo(path);
    this.dialog = { kind: "rename", path, dir: this.isDir(path) };
    this.renameText = info.base;
    this.renameInput.set_value(info.base);
    cx.notify();
    cx.spawn(async (inner) => {
      await inner.sleep(50);
      this.renameInput.focus();
    });
  }

  confirmRename(cx) {
    const dialog = this.dialog;
    if (!dialog || dialog.kind !== "rename") return;
    const name = String(this.renameText ?? "").trim();
    if (!name || name === "." || name === ".." || /[\\/:]/.test(name)) {
      notify({ title: "Invalid name", body: "Use a file name without slashes or colons.", level: "warning", timeout: 3000 });
      return;
    }
    const oldPath = dialog.path;
    const parent = parentPath(oldPath);
    const newPath = parent ? `${parent}/${name}` : name;
    if (newPath === oldPath) {
      this.closeDialog(cx);
      return;
    }
    const oldAbs = this.absoluteFor(oldPath);
    const newAbs = this.absoluteFor(newPath);
    const on = this.on;
    this.dialog = null;
    cx.notify();
    cx.spawn(async (inner) => {
      try {
        if (await pathExists(newAbs, on)) {
          notify({ title: "Name already exists", body: newPath, level: "warning", timeout: 3500 });
          return;
        }
        await movePath(oldAbs, newAbs, on);
        if (this.closed) return;
        if (this.selectedPath === oldPath) this.selectedPath = newPath;
        const renamed = new Set();
        for (const path of [...this.expanded]) {
          if (path === oldPath || path.startsWith(oldPath + "/")) renamed.add(newPath + path.slice(oldPath.length));
          else renamed.add(path);
        }
        this.expanded = renamed;
        this.persistExpanded();
        const oldKey = tabFileKey(this.root, oldPath);
        const newKey = tabFileKey(this.root, newPath);
        const buffered = readBuffered(oldKey);
        if (buffered) {
          writeBuffered(newKey, buffered);
          clearBuffered(oldKey);
        }
        moveDirtyMarker(oldKey, newKey);
        setShared("farrier.files.renamed", { root: this.root, oldPath, newPath, timestamp: Date.now() });
        this.refresh(inner, true);
        notify({ title: "Renamed", body: newPath, level: "success", timeout: 1800 });
        inner.notify();
      } catch (error) {
        if (!this.closed) notify({ title: "Could not rename", body: cleanError(String(error)), level: "error", timeout: 5000 });
      }
    });
  }

  startDelete(path, cx) {
    const dir = this.isDir(path);
    const map = shared("farrier.files.dirty") ?? {};
    let dirty = false;
    for (const key of Object.keys(map)) {
      if (!map[key]) continue;
      try {
        const [, file] = JSON.parse(key);
        if (file === path || (dir && String(file).startsWith(path + "/"))) {
          dirty = true;
          break;
        }
      } catch {}
    }
    this.dialog = { kind: "delete", path, dir, dirty };
    this.handle.focus();
    cx.notify();
  }

  confirmDelete(cx) {
    const dialog = this.dialog;
    if (!dialog || dialog.kind !== "delete") return;
    const path = dialog.path;
    const dir = dialog.dir;
    const abs = this.absoluteFor(path);
    const on = this.on;
    this.dialog = null;
    cx.notify();
    cx.spawn(async (inner) => {
      try {
        await deletePath(abs, dir, on);
        if (this.closed) return;
        for (const expandedPath of [...this.expanded]) {
          if (expandedPath === path || expandedPath.startsWith(path + "/")) this.expanded.delete(expandedPath);
        }
        this.persistExpanded();
        try {
          for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
            const storageKey = sessionStorage.key(index);
            if (!storageKey?.startsWith(BUFFER_PREFIX)) continue;
            const key = storageKey.slice(BUFFER_PREFIX.length);
            try {
              const [bufferRoot, bufferFile] = JSON.parse(key);
              if (bufferRoot !== this.root) continue;
              if (bufferFile === path || (dir && String(bufferFile).startsWith(path + "/"))) {
                sessionStorage.removeItem(storageKey);
                moveDirtyMarker(tabFileKey(bufferRoot, bufferFile), "", true);
              }
            } catch {}
          }
        } catch {}
        const map = shared("farrier.files.tabs") ?? {};
        const next = { ...map };
        for (const [key, entry] of Object.entries(map)) {
          let file = "";
          try {
            const parsed = JSON.parse(key);
            if (Array.isArray(parsed)) file = String(parsed[1] ?? "");
          } catch {}
          if (file !== path && !(dir && String(file).startsWith(path + "/"))) continue;
          if (entry?.tabId) {
            const tabPanes = (panes() ?? []).filter((pane) => pane.tab === entry.tabId);
            if (tabPanes.length <= 1) run("tab.close", { id: entry.tabId });
          }
          delete next[key];
        }
        setShared("farrier.files.tabs", next);
        this.refresh(inner, true);
        notify({ title: "Deleted", body: path, level: "success", timeout: 1800 });
        inner.notify();
      } catch (error) {
        if (!this.closed) notify({ title: "Could not delete", body: cleanError(String(error)), level: "error", timeout: 5000 });
      }
    });
  }

  isDir(path) {
    const row = this.rowByPath.get(path);
    if (row) return row.dir;
    return Boolean(findNode(this.nodes, path)?.dir);
  }

  absoluteFor(path) {
    return resolveAbsolutePath(this.root, path);
  }

  fileKeyFor(path) {
    let key = this.keyCache.get(path);
    if (!key) {
      key = tabFileKey(this.root, path);
      this.keyCache.set(path, key);
    }
    return key;
  }

  kindFor(path) {
    let kind = this.kindCache.get(path);
    if (!kind) {
      kind = fileKind(path);
      this.kindCache.set(path, kind);
    }
    return kind;
  }

  onTreeKey(event, cx) {
    const key = event.key;
    const mods = event.modifiers;
    if (this.dialog) {
      if (key === "escape") {
        this.closeDialog(cx);
        cx.stop_propagation();
      }
      return;
    }
    if (this.menu) {
      this.onMenuKey(event, cx);
      return;
    }
    if (key === "escape") {
      if (this.inputFocused) {
        this.handle.focus();
        cx.stop_propagation();
      }
      return;
    }
    if (mods.control || mods.platform) {
      if (key === "f" && mods.shift) {
        this.openSearch(cx);
        cx.stop_propagation();
        return;
      }
      if (key === "f") {
        this.filterInput.focus();
        cx.stop_propagation();
        return;
      }
      if (key === "r") {
        this.refresh(cx, true);
        cx.stop_propagation();
        return;
      }
    }
    if (this.inputFocused) return;
    const found = this.selectedPath ? this.rowIndexByPath.get(this.selectedPath) : undefined;
    const index = Math.max(0, found ?? -1);
    if (!this.rows.length) return;
    if (key === "arrow_down") {
      this.selectedPath = this.rows[Math.min(this.rows.length - 1, index + 1)].path;
      this.treeScroll?.scroll_to_item(Math.min(this.rows.length - 1, index + 1), "center");
      cx.notify();
      cx.stop_propagation();
    } else if (key === "arrow_up") {
      this.selectedPath = this.rows[Math.max(0, index - 1)].path;
      this.treeScroll?.scroll_to_item(Math.max(0, index - 1), "center");
      cx.notify();
      cx.stop_propagation();
    } else if (key === "home") {
      this.selectedPath = this.rows[0].path;
      this.treeScroll?.scroll_to_item(0);
      cx.notify();
      cx.stop_propagation();
    } else if (key === "end") {
      const last = this.rows.length - 1;
      this.selectedPath = this.rows[last].path;
      this.treeScroll?.scroll_to_item(last, "center");
      cx.notify();
      cx.stop_propagation();
    } else if (key === "arrow_right") {
      const row = this.rows[index];
      if (row?.dir) {
        if (!this.expanded.has(row.path)) this.toggleFolder(row.path, cx);
        else if (index + 1 < this.rows.length && this.rows[index + 1].depth > row.depth) {
          this.selectedPath = this.rows[index + 1].path;
          this.treeScroll?.scroll_to_item(index + 1, "center");
          cx.notify();
        }
      }
      cx.stop_propagation();
    } else if (key === "arrow_left") {
      const row = this.rows[index];
      if (row?.dir && this.expanded.has(row.path)) this.toggleFolder(row.path, cx);
      else if (row?.parent) {
        const parentIndex = this.rowIndexByPath.get(row.parent);
        if (parentIndex >= 0) {
          this.selectedPath = row.parent;
          this.treeScroll?.scroll_to_item(parentIndex, "center");
          cx.notify();
        }
      }
      cx.stop_propagation();
    } else if (key === "enter") {
      const row = this.rows[index];
      if (row) {
        if (row.dir) this.toggleFolder(row.path, cx);
        else this.openFile(row.path, cx, { permanent: true });
      }
      cx.stop_propagation();
    } else if (key === " ") {
      const row = this.rows[index];
      if (row?.dir) this.toggleFolder(row.path, cx);
      cx.stop_propagation();
    }
  }

  // ---- tree: search ---------------------------------------------------------

  toggleSection(name, cx) {
    const value = !this.sections[name];
    this.sections = { ...this.sections, [name]: value };
    setShared("farrier.files.sections", this.sections);
    if (name === "search" && value) this.focusSearchInput(cx);
    cx.notify();
  }

  focusSearchInput(cx) {
    cx.spawn(async (inner) => {
      await inner.sleep(40);
      this.searchInput?.focus();
    });
  }

  openSearch(cx) {
    if (!this.sections.search) {
      this.sections = { ...this.sections, search: true };
      setShared("farrier.files.sections", this.sections);
    }
    cx.notify();
    this.focusSearchInput(cx);
  }

  searchHeight() {
    return this.sections.explorer ? 250 : 340;
  }

  toggleSearchReplace(cx) {
    this.search.replaceOpen = !this.search.replaceOpen;
    this.persistSearchOptions();
    cx.notify();
    if (this.search.replaceOpen) {
      this.findFocus = "replace";
      cx.spawn(async (inner) => {
        await inner.sleep(40);
        this.replaceInput.focus();
      });
    }
  }

  toggleSearchFilters(cx) {
    this.search.filtersOpen = !this.search.filtersOpen;
    cx.notify();
  }

  toggleSearchPreserve(cx) {
    this.search.preserveCase = !this.search.preserveCase;
    this.persistSearchOptions();
    cx.notify();
  }

  toggleSearchOption(name, cx) {
    this.search[name] = !this.search[name];
    if (this.search[name] && name === "regex") this.search.wholeWord = false;
    this.persistSearchOptions();
    this.scheduleSearch(cx);
    cx.notify();
  }

  persistSearchOptions() {
    setShared("farrier.files.searchOptions", {
      caseSensitive: this.search.caseSensitive,
      wholeWord: this.search.wholeWord,
      regex: this.search.regex,
      preserveCase: this.search.preserveCase,
      replaceOpen: this.search.replaceOpen,
      filtersOpen: this.search.filtersOpen,
    });
  }

  setSearchRows(rows) {
    const next = rows ?? [];
    this.searchRows = next;
    const sizes = new Array(next.length);
    for (let index = 0; index < next.length; index += 1) sizes[index] = next[index].size ?? 24;
    this.searchSizes = sizes;
  }

  scheduleSearch(cx) {
    const token = ++this.searchSeq;
    const query = prepareSearchQuery(this.search.query);
    if (!query.trim()) {
      this.searchGroups = [];
      this.setSearchRows([]);
      this.searchMeta = null;
      this.searchLoading = false;
      cx.notify();
      return;
    }
    const built = buildFindRegExp(query, this.searchOptions());
    if (!built.valid) {
      this.searchGroups = [];
      this.setSearchRows([]);
      this.searchMeta = { error: built.error, total: 0, limited: false };
      this.searchLoading = false;
      cx.notify();
      return;
    }
    this.searchLoading = true;
    cx.spawn(async (inner) => {
      await inner.sleep(220);
      if (token !== this.searchSeq || this.closed) return;
      await this.runSearch(inner, token);
    });
  }

  searchOptions() {
    return {
      caseSensitive: this.search.caseSensitive,
      wholeWord: this.search.wholeWord,
      regex: this.search.regex,
      cap: 2000,
    };
  }

  searchQuery() {
    return prepareSearchQuery(this.search.query);
  }

  async runSearch(cx, token) {
    const ctx = this.context;
    if (!ctx || !this.root) {
      this.searchLoading = false;
      this.searchMeta = { error: "No folder to search", total: 0, limited: false };
      cx.notify();
      return;
    }
    const query = this.searchQuery();
    const options = this.searchOptions();
    const include = this.search.include;
    const exclude = this.search.exclude;
    const root = this.root;
    const on = this.on;
    let raw = [];
    let result = null;
    let extraLimited = false;
    let extraWarning = null;
    let mode = this.rgAvailable;
    if (mode === null) {
      try {
        const probe = await exec("rg", ["--version"], { cwd: root, on, timeout: 8000 });
        mode = probe.code === 0;
      } catch {
        mode = false;
      }
      this.rgAvailable = mode;
    }
    if (mode === true) {
      try {
        result = await exec("rg", buildRgArgs(query, { ...options, include, exclude }), { cwd: root, on, timeout: 20000 });
        raw = parseRgJson(result.stdout, { cap: 2000 });
      } catch {
        this.rgAvailable = false;
        mode = false;
      }
    }
    if (mode === false && hasLineBreak(query)) {
      const block = await this.runBlockSearch(cx, token, query, options, include, exclude);
      if (!block) return;
      if (block.error) {
        this.searchLoading = false;
        this.searchMeta = { error: block.error, total: 0, limited: false };
        this.searchGroups = [];
        this.setSearchRows([]);
        cx.notify();
        return;
      }
      raw = block.matches;
      result = { code: 0, stdout: "", stderr: "" };
      extraLimited = block.limited;
      extraWarning = block.warning;
    } else if (mode === false) {
      let failure = null;
      try {
        result = await exec("grep", buildGrepArgs(query, options), { cwd: root, on, timeout: 20000 });
        if (result.code === 0 || result.code === 1) {
          const parsed = parseGrepOutput(result.stdout, query, options);
          raw = parsed.filter((match) => pathMatchesGlobs(match.file, include, exclude));
        } else {
          failure = result;
        }
      } catch (error) {
        failure = error;
      }
      if (!result || result.code === undefined || result.code === 2 || failure) {
        try {
          result = await exec("git", buildGitGrepArgs(query, options), { cwd: root, on, timeout: 25000 });
          const parsed = parseGrepOutput(result.stdout, query, options);
          raw = parsed.filter((match) => pathMatchesGlobs(match.file, include, exclude));
          failure = null;
        } catch (error) {
          if (failure === null) failure = error;
        }
      }
      if (failure) {
        if (token !== this.searchSeq || this.closed || this.context !== ctx) return;
        this.searchLoading = false;
        this.searchMeta = { error: cleanError(String(failure)), total: 0, limited: false };
        this.searchGroups = [];
        this.setSearchRows([]);
        cx.notify();
        return;
      }
    }
    if (token !== this.searchSeq || this.closed || this.context !== ctx) return;
    const classified = classifySearchResult(result, raw.length);
    if (!classified.ok) {
      this.searchLoading = false;
      this.searchMeta = { error: classified.error, total: 0, limited: false };
      this.searchGroups = [];
      this.setSearchRows([]);
      cx.notify();
      return;
    }
    const grouped = groupMatches(raw, { maxFiles: 200, maxMatches: 2000 });
    this.searchGroups = grouped.groups;
    this.setSearchRows(searchRows(grouped.groups, this.collapsedFiles));
    this.searchSelectedFile = null;
    this.searchSelectedMatch = null;
    this.searchMeta = {
      total: grouped.total,
      limited: grouped.limited || raw.length >= 2000 || extraLimited,
      warning: extraWarning || classified.warning,
      error: null,
    };
    this.searchLoading = false;
    this.searchScroll?.scroll_to_item(0);
    if (this.searchWantReplaceDialog) {
      this.searchWantReplaceDialog = false;
      if (this.searchGroups.length) {
        this.dialog = { kind: "replace", count: grouped.total, files: grouped.groups.length, groups: grouped.groups };
      }
    }
    cx.notify();
  }

  async runBlockSearch(cx, token, query, options, include, exclude) {
    const ctx = this.context;
    const root = this.root;
    const on = this.on;
    const anchor = blockSearchAnchor(query, options.regex);
    if (!anchor) {
      return {
        matches: [],
        limited: false,
        warning: null,
        error: options.regex ? "Regex block search needs ripgrep" : null,
      };
    }
    let files = null;
    try {
      const result = await exec("git", ["--no-pager", "grep", "-l", "-I", "-F", "--untracked", ...(options.caseSensitive ? [] : ["-i"]), "-e", anchor], { cwd: root, on, timeout: 20000 });
      if (result.code === 0) files = parseSearchFileList(result.stdout);
      else if (result.code === 1) files = [];
    } catch {}
    if (files === null) {
      try {
        const result = await exec("grep", ["-r", "-l", "-I", "-m", "1", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=build", "-F", ...(options.caseSensitive ? [] : ["-i"]), "--", anchor, "."], { cwd: root, on, timeout: 20000 });
        if (result.code === 0) files = parseSearchFileList(result.stdout);
        else if (result.code === 1) files = [];
      } catch {}
    }
    if (files === null) {
      return { matches: [], limited: false, warning: null, error: "Code-block search needs ripgrep, git or grep" };
    }
    files = files.filter((file) => pathMatchesGlobs(file, include, exclude));
    let limited = false;
    if (files.length > MAX_BLOCK_CANDIDATES) {
      files = files.slice(0, MAX_BLOCK_CANDIDATES);
      limited = true;
    }
    const matches = [];
    for (let at = 0; at < files.length; at += 8) {
      if (token !== this.searchSeq || this.closed || this.context !== ctx) return null;
      const batch = files.slice(at, at + 8);
      const texts = await Promise.all(
        batch.map((file) => readTextFile(resolveAbsolutePath(root, file), { on }).catch(() => null)),
      );
      if (token !== this.searchSeq || this.closed || this.context !== ctx) return null;
      for (let index = 0; index < batch.length; index += 1) {
        if (token !== this.searchSeq || this.closed || this.context !== ctx) return null;
        const text = texts[index];
        if (text && text.length < MAX_TEXT) {
          const found = findMatches(text, query, { ...options, cap: Math.max(1, 2000 - matches.length) });
          if (!found.valid) {
            return { matches: [], limited, warning: null, error: found.error || "Invalid search" };
          }
          const starts = found.matches.length ? buildLineStarts(text) : null;
          for (const match of found.matches) {
            if (matches.length >= 2000) break;
            matches.push({ file: batch[index], ...match, lineText: lineTextAt(starts, text, match.lineIndex) });
          }
        }
        if (matches.length >= 2000) break;
        await cx.sleep(0);
      }
      if (matches.length >= 2000) break;
    }
    return {
      matches,
      limited,
      warning: limited
        ? `Block search checked the first ${MAX_BLOCK_CANDIDATES} files`
        : options.regex
          ? "Regex block search used literal candidates"
          : null,
      error: null,
    };
  }

  searchSummaryText() {
    if (!this.searchMeta) return String(this.search.query ?? "").trim() ? "" : "Search the workspace";
    if (this.searchMeta.error) return this.searchMeta.error;
    const summary = searchSummary(this.searchGroups, this.searchMeta.total ?? 0, { limited: this.searchMeta.limited });
    return this.searchMeta.warning ? `${summary} · ${this.searchMeta.warning}` : summary;
  }

  activateSearchRow(key, cx) {
    const row = this.searchRows.find((item) => item.key === key);
    if (!row) return;
    if (row.kind === "file") {
      this.searchSelectedFile = row.file;
      this.searchSelectedMatch = null;
      if (this.collapsedFiles.has(row.file)) this.collapsedFiles.delete(row.file);
      else this.collapsedFiles.add(row.file);
      this.setSearchRows(searchRows(this.searchGroups, this.collapsedFiles));
      this.revealPath(row.file, cx);
      return;
    }
    this.searchSelectedFile = row.file;
    this.searchSelectedMatch = { key: row.key, file: row.file, match: row.match };
    const now = Date.now();
    const permanent = this.lastSearchClick.key === row.key && now - this.lastSearchClick.at < 500;
    this.lastSearchClick = { key: row.key, at: now };
    this.openFile(row.file, cx, {
      permanent,
      find: {
        query: this.searchQuery(),
        caseSensitive: this.search.caseSensitive,
        wholeWord: this.search.wholeWord,
        regex: this.search.regex,
        line: row.match.line,
      },
    });
  }

  askReplaceAll(cx) {
    const groups = this.searchGroups;
    const count = groups.reduce((n, group) => n + group.matches.length, 0);
    if (!count) return;
    this.dialog = { kind: "replace", count, files: groups.length, groups };
    cx.notify();
  }

  askReplaceFile(cx) {
    const file = this.searchSelectedFile;
    if (!file) return;
    const group = this.searchGroups.find((item) => item.file === file);
    if (!group || !group.matches.length) return;
    this.dialog = { kind: "replace", count: group.matches.length, files: 1, groups: [group] };
    cx.notify();
  }

  dismissSearchMatch(cx) {
    const selected = this.searchSelectedMatch;
    if (!selected) return;
    const key = matchKey(selected.match);
    this.searchGroups = this.searchGroups
      .map((group) =>
        group.file === selected.file ? { ...group, matches: group.matches.filter((match) => matchKey(match) !== key) } : group,
      )
      .filter((group) => group.matches.length);
    this.searchSelectedMatch = null;
    this.setSearchRows(searchRows(this.searchGroups, this.collapsedFiles));
    this.searchMeta = {
      ...(this.searchMeta ?? {}),
      total: this.searchGroups.reduce((n, group) => n + group.matches.length, 0),
    };
    cx.notify();
  }

  replaceSearchMatch(cx) {
    const selected = this.searchSelectedMatch;
    const ctx = this.context;
    if (!selected || !ctx || !this.root) return;
    const root = this.root;
    const on = this.on;
    const options = this.searchOptions();
    const query = this.searchQuery();
    const replacement = this.search.replace;
    const preserveCase = this.search.preserveCase;
    const key = tabFileKey(root, selected.file);
    if ((shared("farrier.files.dirty") ?? {})[key] || readBuffered(key)) {
      notify({ title: "Unsaved edits", body: `${splitPathInfo(selected.file).base} is open with edits.`, level: "warning", timeout: 3500 });
      return;
    }
    cx.spawn(async (inner) => {
      try {
        const fresh = await readTextFile(resolveAbsolutePath(root, selected.file), { on });
        if (this.closed || this.context !== ctx) return;
        if (fresh === null) throw new Error("File is missing");
        if (fresh.length >= MAX_TEXT || fresh.includes("\uFFFD")) throw new Error("File is too large or not UTF-8");
        const planned = planFileReplacements(fresh, [selected.match], query, options, replacement, preserveCase);
        if (!planned.ok) throw new Error(planned.reason);
        if (!planned.count) return;
        if (on) await writeRemoteTextFile(resolveAbsolutePath(root, selected.file), planned.text, fresh, on);
        else await writeTextFile(resolveAbsolutePath(root, selected.file), planned.text, fresh);
        if (this.closed || this.context !== ctx) return;
        notify({ title: "Replaced 1 occurrence", body: splitPathInfo(selected.file).base, level: "success", timeout: 2500 });
        this.scheduleSearch(inner);
        inner.notify();
      } catch (error) {
        if (!this.closed) notify({ title: "Could not replace", body: cleanError(String(error)), level: "error", timeout: 4500 });
      }
    });
  }

  confirmReplaceAll(cx) {
    const dialog = this.dialog;
    if (!dialog || dialog.kind !== "replace") return;
    const groups = dialog.groups;
    this.dialog = null;
    cx.notify();
    this.replaceInFiles(groups, cx);
  }

  replaceInFiles(groups, cx) {
    const ctx = this.context;
    if (!ctx || !this.root) return;
    const root = this.root;
    const on = this.on;
    const options = this.searchOptions();
    const query = this.searchQuery();
    const replacement = this.search.replace;
    const preserveCase = this.search.preserveCase;
    cx.spawn(async (inner) => {
      let replaced = 0;
      let files = 0;
      const skipped = [];
      for (const group of groups) {
        if (this.closed || this.context !== ctx) return;
        const key = tabFileKey(root, group.file);
        if ((shared("farrier.files.dirty") ?? {})[key] || readBuffered(key)) {
          skipped.push(`${splitPathInfo(group.file).base}: unsaved edits`);
          continue;
        }
        const abs = resolveAbsolutePath(root, group.file);
        try {
          const fresh = await readTextFile(abs, { on });
          if (this.closed || this.context !== ctx) return;
          if (fresh === null) {
            skipped.push(`${splitPathInfo(group.file).base}: missing`);
            continue;
          }
          if (fresh.length >= MAX_TEXT) {
            skipped.push(`${splitPathInfo(group.file).base}: too large`);
            continue;
          }
          if (fresh.includes("\uFFFD")) {
            skipped.push(`${splitPathInfo(group.file).base}: not UTF-8`);
            continue;
          }
          const planned = planFileReplacements(fresh, group.matches, query, options, replacement, preserveCase);
          if (!planned.ok) {
            skipped.push(`${splitPathInfo(group.file).base}: ${planned.reason}`);
            continue;
          }
          if (!planned.count) continue;
          if (on) await writeRemoteTextFile(abs, planned.text, fresh, on);
          else await writeTextFile(abs, planned.text, fresh);
          if (this.closed || this.context !== ctx) return;
          replaced += planned.count;
          files += 1;
        } catch (error) {
          skipped.push(`${splitPathInfo(group.file).base}: ${cleanError(String(error))}`);
        }
      }
      if (this.closed || this.context !== ctx) return;
      notify({
        title: `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}`,
        body: `${files} file${files === 1 ? "" : "s"} updated${skipped.length ? ` · ${skipped.slice(0, 3).join(", ")}` : ""}`,
        level: skipped.length ? "warning" : "success",
        timeout: 4500,
      });
      this.scheduleSearch(inner);
      inner.notify();
    });
  }

  // ---- tree: file tabs ------------------------------------------------------

  tabsMap() {
    return shared("farrier.files.tabs") ?? {};
  }

  isTabLive(tabId) {
    return Boolean(tabId) && activeTabs().some((tab) => tab.id === tabId && !tab.settled);
  }

  markTab(fileKey, entry) {
    setShared("farrier.files.tabs", { ...this.tabsMap(), [fileKey]: entry });
  }

  isPreviewTab() {
    if (this.mode !== "file" || !this.file) return false;
    const entry = this.tabsMap()[tabFileKey(this.root, this.file)];
    return entry?.preview === true && this.isTabLive(entry.tabId);
  }

  isPathPreview(path) {
    const entry = this.tabsMap()[tabFileKey(this.root, path)];
    return entry?.preview === true && this.isTabLive(entry.tabId);
  }

  keepOpen(path, cx) {
    const key = tabFileKey(this.root, path);
    const map = this.tabsMap();
    const entry = map[key];
    if (!entry?.preview) return;
    this.markTab(key, { ...entry, preview: false });
    this.handle.focus();
    cx.notify();
  }

  placeInEmptyPane(path, cx) {
    this.openFile(path, cx, { permanent: true, forceEmpty: true });
  }

  promotePreview(cx) {
    if (this.mode !== "file" || !this.file) return;
    const key = tabFileKey(this.root, this.file);
    const map = this.tabsMap();
    const entry = map[key];
    if (!entry?.preview) return;
    setShared("farrier.files.tabs", { ...map, [key]: { ...entry, preview: false } });
    cx?.notify();
  }

  previousPreview(fileKey, spaceId, live) {
    const map = this.tabsMap();
    let found = null;
    for (const [key, entry] of Object.entries(map)) {
      if (key === fileKey || !entry || entry.preview !== true) continue;
      if (spaceId && entry.space && entry.space !== spaceId) continue;
      if (!entry.tabId || !live.has(entry.tabId)) continue;
      found = { key, ...entry };
    }
    return found;
  }

  closePreview(entry, cx, keepTabId = null) {
    if (!entry) return;
    const dirty = (shared("farrier.files.dirty") ?? {})[entry.key] === true;
    const tabPanes = entry.tabId ? (panes() ?? []).filter((pane) => pane.tab === entry.tabId) : [];
    if (dirty || tabPanes.length > 1 || !entry.tabId || entry.tabId === keepTabId) {
      const map = this.tabsMap();
      if (map[entry.key]?.preview) setShared("farrier.files.tabs", { ...map, [entry.key]: { ...map[entry.key], preview: false } });
      return;
    }
    run("tab.close", { id: entry.tabId });
    const map = this.tabsMap();
    if (map[entry.key]) {
      const next = { ...map };
      delete next[entry.key];
      setShared("farrier.files.tabs", next);
    }
  }

  openFile(path, cx, options = {}) {
    if (!this.root) return;
    const fileKey = tabFileKey(this.root, path);
    const preview = options.permanent === true ? false : options.preview !== false;
    const tabs = activeTabs();
    const live = new Set(tabs.map((tab) => tab.id));
    const map = this.tabsMap();
    const known = map[fileKey];
    const space = spaces().find((item) => item.active);
    const activeTab = space?.tabs.find((tab) => tab.active);
    const tabPanes = activeTab ? (panes() ?? []).filter((pane) => pane.tab === activeTab.id) : [];
    const empty = activeTab ? findTargetEmptyPane(tabPanes, focused()?.pane) : null;
    if (options.forceEmpty && !empty) {
      notify({ title: "No empty pane", body: "Split a pane first, then open the file there.", level: "warning", timeout: 3000 });
      return;
    }

    for (const entry of Object.values(this.pendingOpens)) {
      if (entry.fileKey !== fileKey) continue;
      if (!preview) entry.preview = false;
      this.revealPath(path, cx);
      return;
    }

    if (known?.tabId && live.has(known.tabId)) {
      if (options.find) {
        setShared("farrier.files.pendingFind", { fileKey, find: options.find, timestamp: Date.now() });
      }
      const next = { ...known, preview: preview ? known.preview === true : false, space: space?.id ?? known.space };
      if (next.preview !== known.preview || next.space !== known.space) this.markTab(fileKey, next);
      run("tab.select", { id: known.tabId });
      this.revealPath(path, cx);
      return;
    }

    const tabProps = { folder: this.root, file: path };
    if (this.on) tabProps.on = this.on;
    if (options.find) tabProps.find = options.find;
    const previous = this.previousPreview(fileKey, space?.id, live);

    if (empty && activeTab) {
      // Replacing the chooser pane is the one placement that cannot be a
      // temporary tab: it belongs to a tab with other panes.
      if (tabPanes.length > 1) {
        if (options.find) setShared("farrier.files.pendingFind", { fileKey, find: options.find, timestamp: Date.now() });
        run("pane.split", { direction: "right", pane: empty.pane, mod: MOD, props: tabProps });
        run("pane.close", { pane: empty.pane });
        this.markTab(fileKey, {
          tabId: activeTab.id,
          name: activeTab.name,
          preview: false,
          space: space?.id ?? null,
        });
        this.revealPath(path, cx);
        this.closePreview(previous, cx, activeTab.id);
        return;
      }
      this.pendingCloseTab = activeTab.id;
    }

    const name = pickTabName(path, [...tabs.map((tab) => tab.name), ...Object.keys(this.pendingOpens)], this.root);
    const closeTab = this.pendingCloseTab;
    this.pendingCloseTab = null;
    this.revealPath(path, cx);
    if (options.find) setShared("farrier.files.pendingFind", { fileKey, find: options.find, timestamp: Date.now() });
    this.pendingOpens[name] = { fileKey, preview, space: space?.id ?? null, previous };
    run("tab.new", { name, mod: MOD, props: tabProps });
    cx.spawn(async (inner) => {
      await inner.sleep(80);
      if (this.closed) return;
      const active = spaces().find((item) => item.active);
      const tab = (active?.tabs ?? []).find((item) => item.name === name && !item.settled);
      const pending = this.pendingOpens[name];
      const finalPreview = pending ? pending.preview : preview;
      if (tab?.id) {
        this.markTab(fileKey, { tabId: tab.id, name, preview: finalPreview, space: space?.id ?? null });
        if (previous) this.closePreview(previous, inner, tab.id);
        if (closeTab && active?.tabs?.length > 1) {
          run("tab.close", { id: closeTab });
        }
      }
      delete this.pendingOpens[name];
      inner.notify();
    });
    cx.notify();
  }

  // ---- file: load and save --------------------------------------------------

  defaultViewMode() {
    return this.isRaster || this.isMarkdown || this.isSvg || this.isCsv || this.isXlsx ? "preview" : "code";
  }

  languageInfo() {
    if (this.isRaster) return { language: "text", label: "Image" };
    if (this.isXlsx) return { language: "text", label: "Excel" };
    return detectLanguage(this.file);
  }

  tableData() {
    if (this.isXlsx) return workbookTable(this.workbook?.sheets?.[this.activeSheet]);
    return this.spreadsheet;
  }

  switchSheet(index, cx) {
    if (!this.workbook?.sheets?.length) return;
    this.activeSheet = Math.max(0, Math.min(index, this.workbook.sheets.length - 1));
    cx.notify();
  }

  canEdit() {
    return Boolean(this.code) && !this.readonly && !this.binary && !this.truncated && !this.isXlsx && !this.loading;
  }

  canFind() {
    if (this.binary || this.truncated || this.isXlsx || this.isRaster) return false;
    return Boolean(this.code) || this.hasPreview();
  }

  hasPreview() {
    return this.isMarkdown || this.isSvg || this.isCsv;
  }

  loadFile(cx, options = {}) {
    if (checking()) return;
    const token = {};
    this.loadToken = token;
    this.loaded = false;
    const ctxOn = this.on;
    const abs = this.abs;
    const file = this.file;
    this.loading = true;
    this.fileError = null;
    this.binary = false;
    this.truncated = false;
    this.readonly = false;
    this.readonlyReason = "";
    cx.notify();
    cx.spawn(async (inner) => {
      try {
        if (this.isXlsx) {
          this.releaseEditor();
          this.text = "";
          await this.loadWorkbook(inner, token);
          return;
        }
        if (this.isRaster) {
          this.imageLoading = true;
          this.loading = false;
          inner.notify();
          const image = await copyRasterToCache(abs, this.cachePrefix, ctxOn);
          if (this.loadToken !== token || this.closed) return;
          const previous = this.imageRel;
          this.imageRel = image.rel;
          this.imageSrc = image.rel;
          this.imageSize = image.size;
          this.imageLoading = false;
          this.loaded = true;
          inner.notify();
          removeCache(previous);
          return;
        }

        const text = await readTextFile(abs, { on: ctxOn });
        if (this.loadToken !== token || this.closed) return;
        if (text === null) {
          clearBuffered(tabFileKey(this.root, file));
          this.loading = false;
          this.fileError = "This file is no longer available.";
          this.text = "";
          this.savedText = "";
          this.lineCount = 0;
          inner.notify();
          return;
        }
        const binary = text.includes("\uFFFD") || text.includes("\0");
        const truncated = text.length >= MAX_TEXT;
        const key = tabFileKey(this.root, file);
        const cached = binary || truncated ? null : readBuffered(key);
        const restored = cached && cached.disk === text && typeof cached.text === "string" && cached.text.length < MAX_TEXT ? cached.text : null;
        if (cached && restored === null) clearBuffered(key);
        const editorText = restored ?? text;
        this.editorSelection = cached?.selection ?? null;
        this.text = editorText;
        this.savedText = text;
        this.lineCount = lineCount(editorText);
        this.binary = binary;
        if (binary) {
          this.readonly = true;
          this.readonlyReason = "Binary file; view only.";
        }
        if (truncated) {
          this.truncated = true;
          this.readonly = true;
          this.readonlyReason = "File is larger than 1 MiB; view only.";
        }
        this.isMarkdown = isMarkdown(file);
        this.isSvg = isSvg(file);
        this.isCsv = isCsv(file);
        this.isXlsx = isXlsx(file);
        this.isRaster = false;
        this.isImage = this.isSvg;
        this.kind = fileKind(file);
        this.spreadsheet = this.isCsv ? parseDelimitedText(editorText) : null;
        if (cached?.viewMode === "code") this.viewMode = "code";
        else if (cached?.viewMode === "preview" && this.hasPreview()) this.viewMode = "preview";
        if (typeof cached?.wrap === "boolean") this.wrap = cached.wrap;
        if (Number.isFinite(Number(cached?.zoom))) this.zoom = Math.max(25, Math.min(400, Number(cached.zoom)));
        if (this.isXlsx) {
          this.fileError = "Workbook preview is not available in this panel.";
          this.readonly = true;
          this.readonlyReason = "Workbook is a binary package; view only.";
        }
        if (this.viewMode === "preview" && !this.hasPreview()) this.viewMode = "code";
        if (this.viewMode === "code") this.rebuildEditor(editorText);
        else if (this.code) this.releaseEditor();
        this.applyFindProp();
        if (this.isSvg && this.viewMode === "preview") await this.loadSvgImage(inner, token);
        const dirty = restored !== null && restored !== text;
        this.setDirty(dirty, inner, false);
        if (dirty) this.promotePreview(inner);
        this.loading = false;
        this.loaded = true;
        this.fileError = this.isXlsx ? this.fileError : null;
        inner.notify();
        this.startFileWatch(inner);
        inner.spawn(async (again) => {
          await again.sleep(40);
          if (!this.panelShown()) return;
          if (this.find.open) this.findInput.focus();
          else if (this.viewMode === "code" && this.code && !this.readonly) this.code.focus();
          else this.handle.focus();
        });
      } catch (error) {
        if (this.loadToken !== token || this.closed) return;
        this.loading = false;
        this.imageLoading = false;
        this.fileError = cleanError(String(error));
        inner.notify();
      }
    });
  }

  async loadWorkbook(cx, token) {
    const abs = this.abs;
    const on = this.on;
    try {
      const workbookXml = await readZipEntry(abs, "xl/workbook.xml", on);
      if (workbookXml === null) throw new Error("Workbook preview needs unzip, tar or PowerShell.");
      const [relsXml, sharedStringsXml, stylesXml] = await Promise.all([
        readZipEntry(abs, "xl/_rels/workbook.xml.rels", on).catch(() => null),
        readZipEntry(abs, "xl/sharedStrings.xml", on).catch(() => null),
        readZipEntry(abs, "xl/styles.xml", on).catch(() => null),
      ]);
      if (this.loadToken !== token || this.closed) return;
      const refs = parseWorkbookXml(workbookXml);
      const targets = parseRelationshipsXml(relsXml ?? "");
      const sheets = await Promise.all(
        refs.slice(0, 6).map(async (ref, index) => {
          const target = normalizeZipPath(targets[ref.rid] || `worksheets/sheet${index + 1}.xml`);
          const xml = await readZipEntry(abs, target, on).catch(() => null);
          return { target, xml };
        }),
      );
      if (this.loadToken !== token || this.closed) return;
      const sheetXmls = Object.create(null);
      for (const sheet of sheets) if (sheet.xml !== null) sheetXmls[sheet.target] = sheet.xml;
      const parsed = parseWorkbookPackage({
        workbookXml,
        relsXml: relsXml ?? "",
        sharedStringsXml: sharedStringsXml ?? "",
        stylesXml: stylesXml ?? "",
        sheetXmls,
        maxSheets: 6,
      });
      if (!parsed.sheets.length) throw new Error("The workbook has no visible sheets.");
      this.workbook = parsed;
      this.activeSheet = 0;
      this.text = "";
      this.savedText = "";
      this.lineCount = 0;
      this.binary = true;
      this.truncated = false;
      this.readonly = true;
      this.readonlyReason = "Workbook preview; view only.";
      this.spreadsheet = null;
      this.viewMode = "preview";
      this.loading = false;
      this.loaded = true;
      this.fileError = null;
      this.setDirty(false, cx, false);
      cx.notify();
      this.startFileWatch(cx);
      if (this.panelShown()) this.handle.focus();
    } catch (error) {
      if (this.loadToken !== token || this.closed) return;
      this.loading = false;
      this.loaded = false;
      this.workbook = null;
      this.fileError = cleanError(String(error));
      cx.notify();
    }
  }

  releaseEditor() {
    if (!this.code) return;
    try {
      this.editorSelection = this.code.selected_range();
    } catch {}
    try {
      this.code.release();
    } catch {}
    this.code = null;
  }

  rebuildEditor(value) {
    this.releaseEditor();
    const { language } = detectLanguage(this.file);
    const appSettings = settings() || {};
    const t = theme();
    this.text = value;
    this.lineCount = lineCount(value);
    this.code = EditorState.new({
      language,
      value,
      readonly: this.readonly,
      line_numbers: true,
      folding: true,
      soft_wrap: this.wrap,
      font_family: typeof appSettings.font_family === "string" ? appSettings.font_family : undefined,
      font_size: 13,
      syntax: syntaxTheme(t),
    });
    if (this.editorSelection && this.editorSelection.end <= value.length) {
      this.code.set_selected_range({
        start: Math.max(0, Math.min(value.length, this.editorSelection.start)),
        end: Math.max(0, Math.min(value.length, this.editorSelection.end)),
      });
    }
    this.code.on("change", (_event, cx) => {
      if (this.closed) return;
      const current = this.code?.value() ?? "";
      const dirty = current !== this.savedText;
      const lines = lineCount(current);
      const changed = dirty !== this.dirty || lines !== this.lineCount;
      this.text = current;
      this.lineCount = lines;
      if (dirty && !this.dirty) this.promotePreview(cx);
      this.setDirty(dirty, cx, false);
      if (this.find.open) this.refreshFindSoon(cx);
      if (changed) cx.notify();
    });
  }

  setDirty(dirty, cx, notifyView = true) {
    const key = tabFileKey(this.root, this.file);
    const map = shared("farrier.files.dirty") ?? {};
    if (dirty) {
      if (this.dirty !== true) setShared("farrier.files.dirty", { ...map, [key]: true });
      this.dirty = true;
    } else {
      if (map[key]) {
        const next = { ...map };
        delete next[key];
        setShared("farrier.files.dirty", next);
      }
      this.dirty = false;
    }
    if (notifyView) cx?.notify();
  }

  save(cx) {
    if (!this.canEdit() || this.saving || !this.dirty || this.saveConflict) return;
    const token = {};
    this.reloadToken = token;
    const abs = this.abs;
    const on = this.on;
    const expected = this.savedText;
    const text = this.code.value();
    this.saving = true;
    cx.notify();
    cx.spawn(async (inner) => {
      try {
        if (on) await writeRemoteTextFile(abs, text, expected, on);
        else await writeTextFile(abs, text, expected);
        if (this.reloadToken !== token || this.closed) return;
        this.savedText = text;
        clearBuffered(tabFileKey(this.root, this.file));
        this.saveConflict = null;
        const current = this.code?.value() ?? text;
        this.setDirty(current !== this.savedText, inner, false);
        notify({ title: "Saved", body: splitPathInfo(this.file).base, level: "success", timeout: 1400 });
      } catch (error) {
        if (this.reloadToken === token && !this.closed) {
          let fresh = null;
          let changed = false;
          try {
            fresh = await readTextFile(abs, { on });
            changed = fresh !== null && fresh !== expected;
          } catch {}
          if (this.reloadToken !== token || this.closed) return;
          if (changed) {
            this.saveConflict = { text, fresh };
            this.dialog = { kind: "save-conflict" };
          } else {
            notify({ title: "Could not save", body: cleanError(String(error)), level: "error", timeout: 5000 });
          }
        }
      } finally {
        if (this.reloadToken === token) this.saving = false;
        inner.notify();
      }
    });
  }

  confirmSaveConflict(cx) {
    const conflict = this.saveConflict;
    if (!conflict) return;
    this.dialog = null;
    this.saveConflict = null;
    const abs = this.abs;
    const on = this.on;
    const text = this.code?.value() ?? conflict.text;
    const token = {};
    this.reloadToken = token;
    this.saving = true;
    cx.notify();
    cx.spawn(async (inner) => {
      try {
        const fresh = await readTextFile(abs, { on });
        if (on) await writeRemoteTextFile(abs, text, fresh, on);
        else await writeTextFile(abs, text, fresh);
        if (this.reloadToken !== token || this.closed) return;
        this.savedText = text;
        clearBuffered(tabFileKey(this.root, this.file));
        const current = this.code?.value() ?? text;
        this.setDirty(current !== this.savedText, inner, false);
        notify({ title: "Saved", body: splitPathInfo(this.file).base, level: "success", timeout: 1400 });
      } catch (error) {
        if (this.reloadToken === token && !this.closed) {
          notify({ title: "Could not save", body: cleanError(String(error)), level: "error", timeout: 5000 });
        }
      } finally {
        if (this.reloadToken === token) this.saving = false;
        inner.notify();
      }
    });
  }

  reload(cx) {
    if (this.dirty) {
      this.dialog = { kind: "reload" };
      cx.notify();
      return;
    }
    clearBuffered(tabFileKey(this.root, this.file));
    this.loadFile(cx, { force: true });
  }

  confirmReload(cx) {
    this.dialog = null;
    this.saveConflict = null;
    clearBuffered(tabFileKey(this.root, this.file));
    this.loadFile(cx, { force: true });
  }

  copyText(cx) {
    const value = this.isRaster || this.isXlsx ? this.absoluteFor(this.file) : this.code?.value() ?? this.text;
    cx.write_to_clipboard(value);
    notify({ title: this.isRaster || this.isXlsx ? "Path copied" : "File text copied", body: this.file, level: "success", timeout: 1400 });
    cx.notify();
  }

  setViewMode(mode, cx) {
    if (mode === this.viewMode || !this.hasPreview()) return;
    if (mode === "preview" && this.find.open) this.closeFind(cx, { focus: false });
    this.viewMode = mode;
    if (mode === "preview" && this.isCsv) {
      const value = this.code?.value() ?? this.text;
      this.text = value;
      this.spreadsheet = parseDelimitedText(value);
    }
    if (mode === "preview" && this.isSvg) this.loadSvgImageFromText(cx);
    if (mode === "code" && !this.code) this.rebuildEditor(this.text);
    cx.notify();
    cx.spawn(async (inner) => {
      await inner.sleep(40);
      if (mode === "code" && this.code) this.code.focus();
      else this.handle.focus();
    });
  }

  toggleWrap(cx) {
    if (!this.canEdit()) return;
    this.wrap = !this.wrap;
    setShared("farrier.files.wrap", this.wrap);
    const value = this.code?.value() ?? this.text;
    this.rebuildEditor(value);
    this.refreshFind();
    cx.notify();
    cx.spawn(async (inner) => {
      await inner.sleep(30);
      this.code?.focus();
    });
  }

  split(direction, cx) {
    this.promotePreview(cx);
    const tabProps = { folder: this.root, file: this.file, wrap: this.wrap };
    if (this.on) tabProps.on = this.on;
    run("pane.split", { direction, mod: MOD, props: tabProps });
    cx.notify();
  }

  setViewport(next, cx) {
    const width = Math.round(next?.width ?? 0);
    const height = Math.round(next?.height ?? 0);
    if (width < 20 || height < 20) return;
    if (this.viewport && Math.abs(this.viewport.width - width) < 2 && Math.abs(this.viewport.height - height) < 2) return;
    this.viewport = { width, height };
    cx.notify();
  }

  zoomBy(direction, cx) {
    if (!this.isImage || this.viewMode !== "preview") return;
    this.zoom = stepZoom(this.zoom, direction);
    cx.notify();
  }

  resetZoom(cx) {
    this.zoom = 100;
    cx.notify();
  }

  async loadSvgImage(cx, token) {
    const prepared = prepareSvgPreview(this.text);
    if (!prepared) {
      this.imageSrc = null;
      this.imageSize = null;
      this.fileError = "This SVG has no readable size.";
      return;
    }
    const prefix = this.cachePrefix || cacheBase(this.abs);
    const rel = `${CACHE_DIR}/${prefix}-${Date.now()}.svg`;
    const full = `${appHome()}/${rel}`;
    await ensureCacheDir();
    await writeTextFile(full, prepared.text, null);
    if (this.loadToken !== token || this.closed) return;
    const previous = this.imageRel;
    this.imageRel = rel;
    this.imageSrc = rel;
    this.imageSize = { width: prepared.width, height: prepared.height };
    removeCache(previous);
    cx.notify();
  }

  loadSvgImageFromText(cx) {
    if (!this.isSvg) return;
    const token = this.loadToken ?? {};
    cx.spawn(async (inner) => {
      try {
        await this.loadSvgImage(inner, token);
      } catch (error) {
        if (!this.closed) {
          this.fileError = cleanError(String(error));
          inner.notify();
        }
      }
    });
  }

  // ---- file: watch ----------------------------------------------------------

  startFileWatch(cx) {
    if (this.on || checking() || this.closed || !this.panelShown()) return;
    const parent = this.abs.slice(0, this.abs.lastIndexOf("/"));
    if (!parent) return;
    if (this.watchedFile === parent && this.watchedAbs === this.abs) return;
    this.filesWatchPromise?.cancel?.();
    const token = {};
    this.fileWatchToken = token;
    this.watchedFile = parent;
    this.watchedAbs = this.abs;
    const abs = this.abs;
    cx.spawn(async (inner) => {
      try {
        for (;;) {
          if (this.closed || this.fileWatchToken !== token) return;
          const pending = watchFolder(parent);
          this.filesWatchPromise = pending;
          const paths = await pending;
          if (this.closed || this.fileWatchToken !== token) return;
          this.syncRenamed(inner);
          if (this.fileWatchToken !== token) return;
          const touched = (paths ?? []).some((path) => String(path).replace(/\\/g, "/") === abs.replace(/\\/g, "/"));
          if (!touched) continue;
          await inner.sleep(220);
          if (this.closed || this.fileWatchToken !== token) return;
          if (this.dirty) {
            notify({ title: "Changed on disk", body: `${splitPathInfo(this.file).base} has unsaved edits here.`, level: "warning", timeout: 3500 });
            continue;
          }
          this.loadFile(inner, { force: true });
        }
      } catch {
        if (this.fileWatchToken === token) this.watchedFile = null;
      }
    });
  }

  syncRenamed(cx) {
    const renamed = shared("farrier.files.renamed");
    if (!renamed || renamed.root !== this.root || renamed.oldPath !== this.file) return;
    if (Math.abs(Date.now() - Number(renamed.timestamp ?? 0)) > 15000) return;
    this.file = renamed.newPath;
    this.abs = resolveAbsolutePath(this.root, this.file);
    this.cachePrefix = `${cacheBase(this.abs)}-${Math.random().toString(36).slice(2, 8)}`;
    this.kind = fileKind(this.file);
    this.markdownId = `farrier-files-md-${this.file.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    this.isMarkdown = isMarkdown(this.file);
    this.isSvg = isSvg(this.file);
    this.isCsv = isCsv(this.file);
    this.isXlsx = isXlsx(this.file);
    this.isRaster = isRasterImage(this.file);
    this.isImage = this.isRaster || this.isSvg;
    const oldKey = tabFileKey(this.root, renamed.oldPath);
    const newKey = tabFileKey(this.root, this.file);
    const buffered = readBuffered(oldKey);
    if (buffered) {
      writeBuffered(newKey, buffered);
      clearBuffered(oldKey);
    }
    moveDirtyMarker(oldKey, newKey);
    const tabsMap = shared("farrier.files.tabs") ?? {};
    const open = tabsMap[oldKey];
    if (open?.tabId) run("tab.rename", { id: open.tabId, name: splitPathInfo(this.file).base });
    if (open) {
      const next = { ...tabsMap };
      delete next[oldKey];
      next[newKey] = { ...open, name: splitPathInfo(this.file).base };
      setShared("farrier.files.tabs", next);
    }
    setShared("farrier.files.renamed", null);
    this.loadFile(cx, { force: true });
  }

  // ---- file: find and replace ----------------------------------------------

  refreshFind() {
    if (!this.find.open) return;
    const value = this.code?.value() ?? this.text;
    this.findText = value;
    this.findLineStarts = buildLineStarts(value);
    const result = findMatches(value, this.find.query, this.findOptions());
    this.find.matches = result.matches;
    this.find.valid = result.valid;
    this.find.error = result.error;
    if (!this.find.matches.length) this.find.current = 0;
    else this.find.current = Math.max(0, Math.min(this.find.current, this.find.matches.length - 1));
  }

  findOptions() {
    return { caseSensitive: this.find.caseSensitive, wholeWord: this.find.wholeWord, regex: this.find.regex, cap: 5000 };
  }

  persistFindPrefs() {
    setShared("farrier.files.find", {
      query: this.find.query,
      caseSensitive: this.find.caseSensitive,
      wholeWord: this.find.wholeWord,
      regex: this.find.regex,
      replace: this.find.replace,
      replaceOpen: this.find.replaceOpen,
      preserveCase: this.find.preserveCase,
    });
  }

  refreshFindSoon(cx) {
    if (!this.find.open) return;
    const token = {};
    this.findToken = token;
    cx.spawn(async (inner) => {
      await inner.sleep(80);
      if (this.findToken !== token || this.closed || !this.find.open) return;
      this.refreshFind();
      inner.notify();
    });
  }

  openFind(cx, options = {}) {
    if (!this.canFind()) return;
    if (this.viewMode !== "code") {
      this.viewMode = "code";
      if (!this.code) this.rebuildEditor(this.text);
    }
    this.find.open = true;
    this.find.replaceOpen = options.replace === true || this.find.replaceOpen;
    if (options.seedSelection !== false) {
      const selection = this.code?.selected_range();
      if (selection && selection.end > selection.start && selection.end - selection.start < 300) {
        const selected = prepareSearchQuery((this.code?.value() ?? this.text).slice(selection.start, selection.end));
        if (selected) {
          this.find.query = selected;
          this.find.current = 0;
          this.findInput.set_value(selected);
        }
      }
    }
    this.persistFindPrefs();
    this.refreshFind();
    if (this.find.matches.length && this.find.current >= 0) this.setFindMatchSelection(this.find.current, false);
    cx.notify();
    cx.spawn(async (inner) => {
      await inner.sleep(40);
      if (this.find.open && this.panelShown()) this.findInput.focus();
    });
  }

  closeFind(cx, options = {}) {
    if (!this.find.open) return;
    this.find.open = false;
    this.find.replaceOpen = false;
    this.persistFindPrefs();
    this.find.current = 0;
    cx.notify();
    if (options.focus !== false) {
      cx.spawn(async (inner) => {
        await inner.sleep(30);
        if (this.viewMode === "code") this.code?.focus();
        else this.handle.focus();
      });
    }
  }

  toggleFindReplace(cx) {
    this.find.replaceOpen = !this.find.replaceOpen;
    this.persistFindPrefs();
    cx.notify();
    if (this.find.replaceOpen) {
      cx.spawn(async (inner) => {
        await inner.sleep(30);
        this.findReplaceInput.focus();
      });
    }
  }

  toggleFindOption(name, cx) {
    this.find[name] = !this.find[name];
    if (this.find[name] && name === "regex") this.find.wholeWord = false;
    this.find.current = 0;
    this.refreshFind();
    this.persistFindPrefs();
    cx.notify();
  }

  toggleFindPreserve(cx) {
    this.find.preserveCase = !this.find.preserveCase;
    this.persistFindPrefs();
    cx.notify();
  }

  findLineText(match) {
    const starts = this.findLineStarts;
    if (!Array.isArray(starts) || !starts.length) return match.lineText ?? match.text ?? "";
    const start = starts[match.line - 1];
    if (start === undefined) return match.lineText ?? "";
    const end = match.line < starts.length ? starts[match.line] - 1 : (this.code?.value() ?? this.text).length;
    return (this.code?.value() ?? this.text).slice(start, Math.max(start, end)).replace(/\r$/, "");
  }

  setFindMatchSelection(index, notifyView = true) {
    const match = this.find.matches[index];
    if (!match || !this.code) return;
    this.code.set_selected_range({ start: match.start, end: match.end });
    if (notifyView) this.code.focus();
  }

  selectFindIndex(index, cx) {
    if (!Number.isFinite(index) || !this.find.matches[index]) return;
    this.find.current = index;
    this.setFindMatchSelection(index, true);
    cx.notify();
  }

  stepFind(delta, cx) {
    if (!this.find.matches.length) return;
    this.find.current = stepMatchIndex(this.find.current, delta, this.find.matches.length);
    this.setFindMatchSelection(this.find.current, true);
    this.findScroll?.scroll_to_item(this.find.current, "center");
    cx.notify();
    cx.spawn(async (inner) => {
      await inner.sleep(30);
      if (this.find.open && this.panelShown()) this.findInput.focus();
    });
  }

  replaceCurrent(cx) {
    if (!this.canEdit() || !this.find.matches.length) return;
    const match = this.find.matches[Math.min(this.find.current, this.find.matches.length - 1)];
    if (!match) return;
    this.findUndo.push({ text: this.code.value(), current: this.find.current });
    if (this.findUndo.length > 50) this.findUndo.shift();
    this.code.set_selected_range({ start: match.start, end: match.end });
    let value = expandReplacement(this.find.replace, match, this.find.regex);
    if (this.find.preserveCase) value = applyPreserveCase(match.text, value);
    this.code.replace(value);
    this.text = this.code.value();
    this.promotePreview(cx);
    this.setDirty(true, cx, false);
    this.refreshFind();
    this.find.current = Math.min(this.find.current, Math.max(0, this.find.matches.length - 1));
    this.setFindMatchSelection(this.find.current, false);
    cx.notify();
  }

  replaceAllInFile(cx) {
    if (!this.canEdit() || !this.find.matches.length) return;
    const value = this.code.value();
    const full = findMatches(value, this.find.query, { ...this.findOptions(), cap: 100000 });
    if (!full.valid || !full.matches.length) return;
    const applied = replaceMatches(value, full.matches, this.find.replace, {
      ...this.findOptions(),
      preserveCase: this.find.preserveCase,
    });
    if (!applied.count) return;
    this.findUndo.push({ text: value, current: this.find.current });
    if (this.findUndo.length > 50) this.findUndo.shift();
    this.code.set_value(applied.text);
    this.text = applied.text;
    this.promotePreview(cx);
    this.setDirty(true, cx, false);
    this.refreshFind();
    cx.notify();
  }

  undoFindReplace(cx) {
    if (!this.findUndo.length || !this.code) return false;
    const entry = this.findUndo.pop();
    this.code.set_value(entry.text);
    this.text = entry.text;
    this.setDirty(entry.text !== this.savedText, cx, false);
    this.refreshFind();
    this.find.current = Math.min(entry.current, Math.max(0, this.find.matches.length - 1));
    cx.notify();
    return true;
  }

  applyFindProp() {
    if (this.findApplied) return;
    const p = commandProps();
    const value = p.find;
    if (!value || typeof value !== "object") return;
    this.findApplied = true;
    this.find.open = true;
    this.find.query = String(value.query ?? "");
    this.find.caseSensitive = value.caseSensitive === true;
    this.find.wholeWord = value.wholeWord === true;
    this.find.regex = value.regex === true;
    this.findInput.set_value(this.find.query);
    this.refreshFind();
    if (value.line) this.find.current = matchIndexAtLine(this.find.matches, Number(value.line));
    this.setFindMatchSelection(this.find.current, false);
  }

  onFileKey(event, cx) {
    const key = event.key;
    const mods = event.modifiers;
    if (this.dialog) {
      if (key === "escape") {
        this.closeDialog(cx);
        cx.stop_propagation();
      }
      return;
    }
    if (key === "escape" && this.find.open) {
      this.closeFind(cx);
      cx.stop_propagation();
      return;
    }
    if ((mods.control || mods.platform) && key === "s") {
      this.save(cx);
      cx.stop_propagation();
      return;
    }
    if ((mods.control || mods.platform) && key === "f") {
      if (mods.alt) this.openFind(cx, { replace: true });
      else this.openFind(cx);
      cx.stop_propagation();
      return;
    }
    if ((mods.control || mods.platform) && key === "h") {
      this.openFind(cx, { replace: true });
      cx.stop_propagation();
      return;
    }
    if (key === "f3") {
      if (this.find.open) this.stepFind(mods.shift ? -1 : 1, cx);
      else this.openFind(cx, { seedSelection: false });
      cx.stop_propagation();
      return;
    }
    if (mods.alt && key === "z") {
      this.toggleWrap(cx);
      cx.stop_propagation();
      return;
    }
    if (this.find.open && (mods.control || mods.platform) && key === "z") {
      if (this.undoFindReplace(cx)) {
        cx.stop_propagation();
        return;
      }
    }
    if ((mods.control || mods.platform) && (key === "\\" || key === "backslash" || key === "|")) {
      this.split(mods.shift ? "down" : "right", cx);
      cx.stop_propagation();
    }
  }

  onFileKeyUp(event, cx) {
    const key = event.key;
    const mods = event.modifiers;
    if ((mods.control || mods.platform) && key === "f" && !event.is_held) {
      this.openFind(cx);
      cx.stop_propagation();
    }
  }

  schedulePendingFind(cx) {
    if (this.pendingFindToken) return;
    const pending = shared("farrier.files.pendingFind");
    if (!pending || pending.fileKey !== tabFileKey(this.root, this.file)) return;
    const timestamp = Number(pending.timestamp) || 0;
    if (timestamp === this.lastPendingFind || Date.now() - timestamp > 15000) return;
    if (!this.code) return;
    const token = {};
    this.pendingFindToken = token;
    cx.spawn(async (inner) => {
      await inner.sleep(0);
      if (this.pendingFindToken !== token || this.closed) return;
      this.pendingFindToken = null;
      if (!this.panelShown()) return;
      this.consumePendingFind();
      inner.notify();
    });
  }

  consumePendingFind() {
    const pending = shared("farrier.files.pendingFind");
    if (!pending || pending.fileKey !== tabFileKey(this.root, this.file)) return;
    const timestamp = Number(pending.timestamp) || 0;
    if (timestamp === this.lastPendingFind) return;
    if (Date.now() - timestamp > 15000) return;
    if (!this.code) return;
    this.lastPendingFind = timestamp;
    const find = pending.find ?? {};
    this.find.open = true;
    this.find.query = String(find.query ?? "");
    this.find.caseSensitive = find.caseSensitive === true;
    this.find.wholeWord = find.wholeWord === true;
    this.find.regex = find.regex === true;
    this.viewMode = "code";
    this.findInput.set_value(this.find.query);
    this.refreshFind();
    if (find.line) this.find.current = matchIndexAtLine(this.find.matches, Number(find.line));
    this.setFindMatchSelection(this.find.current, false);
    const current = shared("farrier.files.pendingFind");
    if (current && current.fileKey === pending.fileKey && Number(current.timestamp) === timestamp) {
      setShared("farrier.files.pendingFind", null);
    }
  }

  activeFileForTab(tabId) {
    if (!tabId) return "";
    const map = this.tabsMap();
    for (const [key, entry] of Object.entries(map)) {
      if (entry?.tabId !== tabId) continue;
      try {
        const [root, file] = JSON.parse(key);
        if (root === this.root && file) return String(file);
      } catch {}
    }
    return "";
  }

  syncActiveFile(cx) {
    const activeTab = spaces().find((space) => space.active)?.tabs.find((tab) => tab.active);
    const activeFile = this.activeFileForTab(activeTab?.id);
    if (activeFile === this.lastActiveFile) return;
    this.lastActiveFile = activeFile;
    if (!activeFile) return;
    this.selectedPath = activeFile;
    const token = {};
    this.syncFileToken = token;
    cx.spawn(async (inner) => {
      await inner.sleep(0);
      if (this.syncFileToken !== token || this.closed) return;
      this.syncFileToken = null;
      this.revealPath(activeFile, inner, { clearFilter: false });
    });
  }

  // ---- render ---------------------------------------------------------------

  render(cx) {
    const t = theme();
    if (checking()) {
      return v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .child(div().text_size(11.5).text_color(t.dim).child("Farrier Files"));
    }
    if (this.mode === "file") {
      this.schedulePendingFind(cx);
      if (!this.panelShown()) this.stopFileWatch();
      else if (this.loaded && !this.loading && !this.watchedFile) this.startFileWatch(cx);
      return renderFile(this, t, cx);
    }
    this.dirtyMap = shared("farrier.files.dirty") ?? {};
    this.syncActiveFile(cx);
    const tabMap = shared("farrier.files.tabs") ?? {};
    const liveTabs = new Set(activeTabs().map((tab) => tab.id));
    this.previewKeys = new Set(
      Object.entries(tabMap)
        .filter(([, entry]) => entry?.preview === true && liveTabs.has(entry.tabId))
        .map(([key]) => key),
    );
    const shown = this.panelShown();
    if (!shown) {
      if (this.watched || this.watchPromise) {
        this.stopWatch();
        this.stale = true;
      }
    } else if (this.context?.key !== contextKey() || (this.stale && !this.loading)) {
      this.refresh(cx);
    }
    return renderTreePane(this, t, cx);
  }
}

