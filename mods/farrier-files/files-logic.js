// Pure file-tree helpers for farrier-files. No GPUI or Herdr imports, so the
// tree shape, filtering and language mapping can be checked with Node.

export const MAX_TREE_PATHS = 30000;

export function normalizePath(path) {
  return String(path ?? "").replace(/\\/g, "/");
}

export function splitPathInfo(path) {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  let ext = "";
  if (base !== "." && base !== "..") {
    const dot = base.lastIndexOf(".");
    if (dot > 0 && dot < base.length - 1) ext = base.slice(dot + 1).toLowerCase();
    else if (dot === 0 && base.length > 1) ext = base.slice(1).toLowerCase();
  }
  return { base, dir, ext };
}

export function normalizeTarget(props) {
  const p = props || {};
  let root = normalizePath(p.folder ?? p.cwd ?? "").replace(/\/+$/, "");
  let file = normalizePath(p.file ?? "");
  if (!root && file.startsWith("/")) {
    const slash = file.lastIndexOf("/");
    if (slash > 0) {
      root = file.slice(0, slash);
      file = file.slice(slash + 1);
    }
  }
  if (root && file.startsWith(root + "/")) file = file.slice(root.length + 1);
  file = file.replace(/^\/+/, "");
  return { root, file };
}

export function resolveAbsolutePath(root, relative) {
  const rel = normalizePath(relative).replace(/^\/+/, "");
  const base = normalizePath(root).replace(/\/+$/, "");
  if (!base) return rel;
  return rel ? `${base}/${rel}` : base;
}

const LANGUAGE_MAP = {
  js: ["js", "JavaScript"],
  mjs: ["js", "JavaScript"],
  cjs: ["js", "JavaScript"],
  ts: ["js", "TypeScript"],
  mts: ["js", "TypeScript"],
  cts: ["js", "TypeScript"],
  jsx: ["js", "JSX"],
  tsx: ["js", "TSX"],
  json: ["json", "JSON"],
  jsonc: ["json", "JSON with comments"],
  html: ["html", "HTML"],
  htm: ["html", "HTML"],
  css: ["css", "CSS"],
  scss: ["css", "SCSS"],
  sass: ["css", "SASS"],
  less: ["css", "LESS"],
  md: ["markdown", "Markdown"],
  markdown: ["markdown", "Markdown"],
  mdx: ["markdown", "MDX"],
  rs: ["rust", "Rust"],
  py: ["python", "Python"],
  pyi: ["python", "Python"],
  go: ["go", "Go"],
  c: ["c", "C"],
  h: ["c", "C header"],
  cc: ["cpp", "C++"],
  cpp: ["cpp", "C++"],
  cxx: ["cpp", "C++"],
  hpp: ["cpp", "C++ header"],
  sh: ["bash", "Shell"],
  bash: ["bash", "Bash"],
  zsh: ["bash", "Zsh"],
  fish: ["bash", "Fish"],
  ps1: ["bash", "PowerShell"],
  yaml: ["yaml", "YAML"],
  yml: ["yaml", "YAML"],
  toml: ["yaml", "TOML"],
  xml: ["xml", "XML"],
  svg: ["xml", "SVG"],
  sql: ["sql", "SQL"],
  vue: ["html", "Vue"],
  svelte: ["html", "Svelte"],
  java: ["java", "Java"],
  rb: ["ruby", "Ruby"],
  php: ["php", "PHP"],
  lua: ["lua", "Lua"],
  swift: ["swift", "Swift"],
  kt: ["kotlin", "Kotlin"],
  kts: ["kotlin", "Kotlin"],
};

const SPECIAL_LANGUAGE = {
  dockerfile: ["dockerfile", "Dockerfile"],
  containerfile: ["dockerfile", "Containerfile"],
  makefile: ["makefile", "Makefile"],
  "cmakelists.txt": ["cmake", "CMake"],
  gemfile: ["ruby", "Ruby"],
  rakefile: ["ruby", "Ruby"],
};

export function detectLanguage(path) {
  const { base, ext } = splitPathInfo(path);
  const special = SPECIAL_LANGUAGE[base.toLowerCase()];
  if (special) return { language: special[0], label: special[1] };
  const mapped = LANGUAGE_MAP[ext];
  if (mapped) return { language: mapped[0], label: mapped[1] };
  return { language: ext || "text", label: ext ? ext.toUpperCase() : "Text" };
}

const CODE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "rs", "go",
  "java", "kt", "kts", "swift", "rb", "php", "cs", "c", "h", "cc", "cpp", "cxx",
  "hpp", "lua", "vue", "svelte", "astro",
]);
const JSON_EXT = new Set(["json", "jsonc", "json5", "lock"]);
const CONFIG_EXT = new Set(["yml", "yaml", "toml", "ini", "conf", "env", "xml", "css", "scss", "sass", "less"]);
const SHELL_EXT = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const TEXT_EXT = new Set(["md", "markdown", "mdx", "txt", "rst", "adoc"]);
const SHEET_EXT = new Set(["csv", "tsv", "xlsx", "xlsm", "xls"]);

export function fileKind(path) {
  const { base, ext } = splitPathInfo(path);
  const lower = base.toLowerCase();
  if (lower === "readme" || lower === "readme.md") return { icon: "text", tone: "ansi6" };
  if (lower === "license" || lower === "license.md") return { icon: "text", tone: "ansi3" };
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") return { icon: "config", tone: "ansi1" };
  if (/\.(test|spec)\.[^./]+$/.test(lower) || /^(test|spec)\./.test(lower)) return { icon: "test", tone: "ansi1" };
  if (JSON_EXT.has(ext)) return { icon: "json", tone: "ansi3" };
  if (CONFIG_EXT.has(ext)) return { icon: "config", tone: "ansi5" };
  if (SHELL_EXT.has(ext)) return { icon: "shell", tone: "ansi2" };
  if (IMAGE_EXT.has(ext)) return { icon: "image", tone: "ansi5" };
  if (TEXT_EXT.has(ext)) return { icon: "text", tone: ext === "txt" ? "muted" : "ansi6" };
  if (SHEET_EXT.has(ext)) return { icon: "table", tone: "ansi2" };
  if (CODE_EXT.has(ext)) return { icon: "code", tone: "ansi4" };
  return { icon: "file", tone: "muted" };
}

export function isMarkdown(path) {
  const ext = splitPathInfo(path).ext;
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

export function isSvg(path) {
  return splitPathInfo(path).ext === "svg";
}

export function isRasterImage(path) {
  return IMAGE_EXT.has(splitPathInfo(path).ext) && !isSvg(path);
}

export function isCsv(path) {
  const ext = splitPathInfo(path).ext;
  return ext === "csv" || ext === "tsv";
}

export function isXlsx(path) {
  const ext = splitPathInfo(path).ext;
  return ext === "xlsx" || ext === "xlsm";
}

export function lineCount(text) {
  if (typeof text !== "string" || !text.length) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

export function parseLsFiles(stdout) {
  const out = [];
  for (const part of String(stdout ?? "").split("\0")) {
    if (!part) continue;
    const path = normalizePath(part).replace(/^\.\//, "");
    if (path) out.push(path);
  }
  return out;
}

export function parseGitStatusRecords(stdout) {
  const records = [];
  for (const record of String(stdout ?? "").split("\0")) {
    if (!record || record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = normalizePath(record.slice(3)).replace(/^\.\//, "");
    if (!path) continue;
    let mark = "M";
    if (xy === "??" || xy.includes("A")) mark = "A";
    else if (xy.includes("U")) mark = "U";
    else if (xy.includes("D")) mark = "D";
    records.push({ path, xy, mark });
  }
  return records;
}

export function parseGitStatus(stdout) {
  const marks = Object.create(null);
  for (const record of parseGitStatusRecords(stdout)) marks[record.path] = record.mark;
  return marks;
}

export function addTreePath(root, raw) {
  const path = normalizePath(raw).replace(/^\/+/, "");
  if (!path || path === "." || path.startsWith("../")) return false;
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return false;
  let node = root;
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    const childPath = node.path ? `${node.path}/${name}` : name;
    const last = i === parts.length - 1;
    const children = node.children;
    if (!children) return false;
    let child = children instanceof Map ? children.get(name) : children.find((entry) => entry.name === name);
    if (!child) {
      child = last
        ? { name, path: childPath, dir: false, children: null }
        : newFolder(name, childPath);
      if (children instanceof Map) children.set(name, child);
      else {
        let at = children.findIndex((entry) => compareNodes(child, entry) < 0);
        if (at < 0) at = children.length;
        children.splice(at, 0, child);
      }
    } else if (!last && !child.dir) {
      const replacement = newFolder(name, childPath);
      if (children instanceof Map) {
        children.set(name, replacement);
      } else {
        const at = children.indexOf(child);
        children.splice(at, 1);
        let insert = children.findIndex((entry) => compareNodes(replacement, entry) < 0);
        if (insert < 0) insert = children.length;
        children.splice(insert, 0, replacement);
      }
      child = replacement;
    }
    node = child;
  }
  return true;
}

export function removeTreePath(root, raw) {
  const path = normalizePath(raw).replace(/^\/+/, "");
  if (!path || path === "." || path.startsWith("../")) return false;
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return false;
  const trail = [];
  let node = root;
  for (const name of parts) {
    const children = node.children;
    if (!children) return false;
    const child = children instanceof Map ? children.get(name) : children.find((entry) => entry.name === name);
    if (!child) return false;
    trail.push({ parent: node, child });
    node = child;
  }
  const last = trail[trail.length - 1];
  const children = last.parent.children;
  if (children instanceof Map) children.delete(last.child.name);
  else children.splice(children.indexOf(last.child), 1);
  for (let i = trail.length - 2; i >= 0; i -= 1) {
    const { parent, child } = trail[i];
    if (!child.dir) continue;
    const kids = child.children instanceof Map ? child.children.size : child.children?.length ?? 0;
    if (kids > 0) break;
    const pc = parent.children;
    if (pc instanceof Map) pc.delete(child.name);
    else pc.splice(pc.indexOf(child), 1);
  }
  return true;
}

function newFolder(name, path) {
  return { name, path, dir: true, children: new Map(), loaded: false };
}

export function insertTreePath(root, raw) {
  const path = normalizePath(raw).replace(/^\/+/, "");
  if (!path || path === "." || path.startsWith("../")) return false;
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return false;
  let node = root;
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    const childPath = node.path ? `${node.path}/${name}` : name;
    const last = i === parts.length - 1;
    let child = node.children.get(name);
    if (!child) {
      child = last
        ? { name, path: childPath, dir: false, children: null }
        : newFolder(name, childPath);
      node.children.set(name, child);
    } else if (!last && !child.dir) {
      // A file path can only collide with a directory if the repository has
      // a path prefix that is also a file; keep the directory interpretation.
      child = newFolder(name, childPath);
      node.children.set(name, child);
    }
    node = child;
  }
  return true;
}

export function buildTree(paths, limit = MAX_TREE_PATHS) {
  const root = newFolder("", "");
  root.loaded = true;
  let used = 0;
  for (const raw of paths) {
    if (used >= limit) break;
    if (insertTreePath(root, raw)) used += 1;
  }
  return { root, used, limited: used < paths.length };
}

function compareNodes(a, b) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function sortTree(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node.dir) continue;
    const children = [...node.children.values()].sort(compareNodes);
    node.children = children;
    for (const child of children) if (child.dir) stack.push(child);
  }
  return root;
}

export function setTreeChildren(root, path, entries) {
  const node = findNode(root, path);
  if (!node || !node.dir) return false;
  node.children = entries;
  node.loaded = true;
  return true;
}

export function findNode(root, path) {
  if (!path) return root;
  let node = root;
  for (const part of path.split("/")) {
    if (!node.dir) return null;
    const children = node.children instanceof Map ? node.children : node.children ?? [];
    const next = children instanceof Map ? children.get(part) : children.find((child) => child.name === part);
    if (!next) return null;
    node = next;
  }
  return node;
}

export function visibleRows(root, expanded, maxRows = 20000) {
  const rows = [];
  if (!root?.dir) return rows;
  const children = root.children instanceof Map ? [...root.children.values()] : root.children ?? [];
  const stack = [];
  for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i], depth: 0 });
  while (stack.length && rows.length < maxRows) {
    const { node, depth } = stack.pop();
    rows.push({
      path: node.path,
      name: node.name,
      dir: node.dir,
      depth,
      parent: node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "",
    });
    if (node.dir && expanded.has(node.path)) {
      const kids = node.children instanceof Map ? node.children : node.children ?? [];
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ node: kids[i], depth: depth + 1 });
    }
  }
  return rows;
}

export function filterRows(root, expanded, query, maxRows = 20000) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return visibleRows(root, expanded, maxRows);
  const keep = new Set();
  const stack = [{ node: root, ancestors: [] }];
  while (stack.length) {
    const { node, ancestors } = stack.pop();
    const kids = node.children instanceof Map ? node.children : node.children ?? [];
    for (const child of kids) {
      const hit = child.path.toLowerCase().includes(q) || child.name.toLowerCase().includes(q);
      if (hit) {
        keep.add(child.path);
        for (const parent of ancestors) keep.add(parent);
        if (node !== root) keep.add(node.path);
      }
      if (child.dir) stack.push({ node: child, ancestors: [...ancestors, child.path] });
    }
  }
  const rows = [];
  const stack2 = [{ node: root, depth: 0 }];
  const kidsOf = (node) => (node.children instanceof Map ? node.children : node.children ?? []);
  const rootKids = kidsOf(root);
  for (let i = rootKids.length - 1; i >= 0; i -= 1) stack2.push({ node: rootKids[i], depth: 0 });
  while (stack2.length && rows.length < maxRows) {
    const { node, depth } = stack2.pop();
    if (!keep.has(node.path) && !expanded.has(node.path)) continue;
    const hit = node.path.toLowerCase().includes(q) || node.name.toLowerCase().includes(q);
    rows.push({
      path: node.path,
      name: node.name,
      dir: node.dir,
      depth,
      parent: node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "",
      hit,
    });
    if (node.dir && (expanded.has(node.path) || keep.has(node.path))) {
      const kids = kidsOf(node);
      for (let i = kids.length - 1; i >= 0; i -= 1) stack2.push({ node: kids[i], depth: depth + 1 });
    }
  }
  return rows;
}

export function isEmptyPane(pane) {
  if (!pane || typeof pane !== "object") return false;
  if (pane.mod === "new-pane" || pane.mod === "space-pin") return true;
  if (!pane.terminal && (pane.title === "New pane" || pane.title === "New tab")) return true;
  return false;
}

export function findTargetEmptyPane(tabPanes, focusedPaneId) {
  if (!Array.isArray(tabPanes) || !tabPanes.length) return null;
  const empty = tabPanes.filter(isEmptyPane);
  if (!empty.length) return null;
  if (focusedPaneId) {
    const focused = empty.find((pane) => pane.pane === focusedPaneId);
    if (focused) return focused;
  }
  return empty[0];
}

export function parentPath(path) {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

export function pickTabName(path, existingNames, root) {
  const { base, dir } = splitPathInfo(path);
  const names = new Set(existingNames || []);
  const short = base || path;
  if (!names.has(short)) return short;
  const relativeDir = dir.replace(normalizePath(root).replace(/\/+$/, ""), "").replace(/^\/+/, "");
  const long = relativeDir ? `${relativeDir}/${short}` : short;
  if (!names.has(long)) return long;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${long} (${i})`;
    if (!names.has(candidate)) return candidate;
  }
  return `${long} (${names.size + 1})`;
}

export function tabFileKey(root, path) {
  return JSON.stringify([normalizePath(root).replace(/\/+$/, ""), normalizePath(path)]);
}

export function formatNumber(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}
