// File-type vocabulary shared by Farrier's Files and Git panels. Each mod
// carries its own copy so it installs alone; the copies and the icon files are
// kept identical by the developer test.

export const FILE_NAMES = {
  "package.json": ["json", "ansi3"],
  "package-lock.json": ["lock", "dim"],
  "yarn.lock": ["lock", "dim"],
  "pnpm-lock.yaml": ["lock", "dim"],
  "bun.lockb": ["lock", "dim"],
  "cargo.lock": ["lock", "dim"],
  "composer.lock": ["lock", "dim"],
  "gemfile.lock": ["lock", "dim"],
  "pipfile.lock": ["lock", "dim"],
  "poetry.lock": ["lock", "dim"],
  "uv.lock": ["lock", "dim"],
  "pdm.lock": ["lock", "dim"],
  "go.sum": ["lock", "dim"],
  "go.mod": ["config", "ansi6"],
  "readme.md": ["text", "ansi6"],
  "readme.txt": ["text", "ansi6"],
  "readme": ["text", "ansi6"],
  "license": ["text", "ansi3"],
  "license.md": ["text", "ansi3"],
  "license.txt": ["text", "ansi3"],
  "changelog.md": ["text", "ansi6"],
  "changelog": ["text", "ansi6"],
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

export const FILE_EXTENSIONS = {
  ts: ["code", "ansi4"], tsx: ["code", "ansi4"], mts: ["code", "ansi4"], cts: ["code", "ansi4"],
  js: ["code", "ansi3"], jsx: ["code", "ansi3"], mjs: ["code", "ansi3"], cjs: ["code", "ansi3"],
  py: ["code", "ansi2"], pyi: ["code", "ansi2"],
  rs: ["code", "ansi1"], go: ["code", "ansi6"], java: ["code", "ansi1"], kt: ["code", "ansi5"],
  kts: ["code", "ansi5"], swift: ["code", "ansi3"], rb: ["code", "ansi1"], php: ["code", "ansi5"],
  cs: ["code", "ansi4"], c: ["code", "ansi4"], h: ["code", "ansi4"], cc: ["code", "ansi4"],
  cpp: ["code", "ansi4"], hpp: ["code", "ansi4"], cxx: ["code", "ansi4"], m: ["code", "ansi4"], mm: ["code", "ansi4"],
  lua: ["code", "ansi4"], sh: ["shell", "ansi2"], bash: ["shell", "ansi2"], zsh: ["shell", "ansi2"],
  fish: ["shell", "ansi2"], ps1: ["shell", "ansi4"], bat: ["shell", "ansi2"], cmd: ["shell", "ansi2"],
  json: ["json", "ansi3"], jsonc: ["json", "ansi3"], json5: ["json", "ansi3"], ipynb: ["json", "ansi3"],
  css: ["style", "ansi5"], scss: ["style", "ansi5"], sass: ["style", "ansi5"], less: ["style", "ansi5"],
  styl: ["style", "ansi5"],
  html: ["html", "ansi3"], htm: ["html", "ansi3"], vue: ["html", "ansi2"], svelte: ["html", "ansi1"],
  astro: ["html", "ansi5"],
  md: ["text", "ansi6"], markdown: ["text", "ansi6"], mdx: ["text", "ansi6"], txt: ["text", "muted"],
  rst: ["text", "ansi6"], adoc: ["text", "ansi6"], log: ["text", "muted"],
  pdf: ["text", "ansi1"], doc: ["text", "ansi4"], docx: ["text", "ansi4"],
  png: ["image", "ansi5"], jpg: ["image", "ansi5"], jpeg: ["image", "ansi5"], gif: ["image", "ansi5"],
  webp: ["image", "ansi5"], svg: ["image", "ansi5"], ico: ["image", "ansi5"], bmp: ["image", "ansi5"],
  avif: ["image", "ansi5"],
  yml: ["config", "ansi5"], yaml: ["config", "ansi5"], toml: ["config", "ansi5"], ini: ["config", "ansi5"],
  conf: ["config", "ansi5"], env: ["config", "ansi3"], xml: ["config", "ansi5"],
  sql: ["db", "ansi6"], sqlite: ["db", "ansi6"], db: ["db", "ansi6"],
  csv: ["table", "ansi2"], tsv: ["table", "ansi2"], xlsx: ["table", "ansi2"], xlsm: ["table", "ansi2"], xls: ["table", "ansi2"],
  zip: ["archive", "dim"], tar: ["archive", "dim"], gz: ["archive", "dim"], bz2: ["archive", "dim"],
  xz: ["archive", "dim"], rar: ["archive", "dim"], "7z": ["archive", "dim"],
};

export function fileKindParts(name) {
  const base = String(name ?? "").split("\\").join("/").split("/").pop().toLowerCase();
  const named = FILE_NAMES[base];
  if (named) return named;
  if (/\.(test|spec)\.[^./]+$/.test(base) || /^(test|spec)\./.test(base)) return ["test", "ansi1"];
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  return FILE_EXTENSIONS[ext] ?? ["file", "muted"];
}
