// Static checks for this repository: the part of validation that needs no Herdr.
// Developer and CI tool, never called by install.ps1 or install.sh (those stay
// dependency-free).
//
//   node scripts/check.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const root = process.cwd();
const problems = [];
const bad = (message) => problems.push(message);

const rows = readFileSync(join(root, "install.tsv"), "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => {
    const [id, kind, src, dest, desc] = line.split("\t");
    return { id, kind, src, dest, desc, line };
  });

const reserved = new Map();
for (const line of readFileSync(join(root, "reserved.txt"), "utf8").split(/\r?\n/)) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [kind, name] = line.split("\t");
  reserved.set(`${kind}:${name}`, true);
}

const version = readFileSync(join(root, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) bad(`VERSION is not x.y.z: ${version}`);

const kinds = new Set(["layout", "theme", "mod", "file"]);
const places = { layout: ["layouts/"], theme: ["themes/"], mod: ["mods/"], file: ["layouts/", "themes/"] };
const seen = new Set();
const ownMods = [];

for (const row of rows) {
  if (!row.id || !row.kind || !row.src || !row.dest) {
    bad(`install.tsv: a row needs id, kind, src and dest: ${row.line}`);
    continue;
  }
  if (!kinds.has(row.kind)) bad(`install.tsv: ${row.id} has an unknown kind: ${row.kind}`);
  if (seen.has(row.id)) bad(`install.tsv: ${row.id} appears twice`);
  seen.add(row.id);

  if (!places[row.kind]?.includes(dirname(row.dest) + "/")) {
    bad(`install.tsv: ${row.id} goes to ${row.dest}, wrong for a ${row.kind}`);
  }
  if (row.kind !== "file" && reserved.has(`${row.kind}:${basename(row.dest)}`)) {
    bad(`install.tsv: '${basename(row.dest)}' is a name Herdr ships (reserved.txt)`);
  }

  const source = join(root, row.src);
  if (!existsSync(source)) {
    bad(`install.tsv: ${row.id} points at a missing source: ${row.src}`);
    continue;
  }

  if (row.kind === "mod") {
    ownMods.push(basename(row.dest));
    for (const file of ["main.js", "mod.json"]) {
      if (!existsSync(join(source, file))) bad(`${row.src} has no ${file}`);
    }
  }

  if (row.kind === "theme") {
    const theme = parseJson(source, bad);
    if (!theme) continue;
    for (const key of ["background", "foreground", "selection", "ansi"]) {
      if (!theme[key]) bad(`${row.src} has no '${key}'`);
    }
    if (!Array.isArray(theme.ansi) || theme.ansi.length !== 16) bad(`${row.src}: ansi needs 16 colors`);
    const hex = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
    for (const [i, color] of Object.entries(theme.ansi ?? [])) if (!hex(color)) bad(`${row.src}: ansi${i} is not #rrggbb`);
    for (const [name, color] of Object.entries(theme.colors ?? {})) if (!hex(color)) bad(`${row.src}: colors.${name} is not #rrggbb`);
    for (const [name, color] of Object.entries(theme)) {
      if (["colors", "ansi", "cursor"].includes(name)) continue;
      if (!hex(color)) bad(`${row.src}: ${name} is not #rrggbb`);
    }
  }

  if (row.kind === "layout") {
    const layout = parseJson(source, bad);
    if (!layout) continue;
    if (!layout.id || !layout.type) bad(`${row.src} needs a root id and type`);
    if (layout.preview && !existsSync(join(root, layout.preview))) bad(`${row.src}: preview '${layout.preview}' is missing`);
  }
}

// A layout may reference its own mods or the ones Herdr ships, nothing else.
for (const row of rows.filter((r) => r.kind === "layout")) {
  const layout = parseJson(join(root, row.src), bad);
  if (!layout) continue;
  for (const ref of modRefs(layout)) {
    if (ownMods.includes(ref) || reserved.has(`mod:${ref}`)) continue;
    bad(`${row.src} uses mod '${ref}', which is neither Farrier's nor a mod Herdr ships`);
  }
}

// Keys stay in this layout's own sections, and name a command one of our mods owns.
const pack = parseJson(join(root, "keys.pack.json"), bad);
if (pack) {
  const sections = ["layout:farrier", ...ownMods.map((name) => `mod:${name}`)];
  const commands = ownMods.map((name) => `${name}.`);
  for (const [section, binds] of Object.entries(pack)) {
    if (!sections.includes(section)) bad(`keys.pack.json: ${section} is not this layout's section`);
    if (!binds || typeof binds !== "object") bad(`keys.pack.json: ${section} is not an object`);
    for (const [key, action] of Object.entries(binds ?? {})) {
      if (typeof action !== "string" || !commands.some((prefix) => action.startsWith(prefix))) {
        bad(`keys.pack.json: ${key} -> ${action} is not a command one of our mods owns`);
      }
    }
  }
}

// Every layout and theme of ours is in the catalogue, and vice versa.
for (const dir of ["layouts", "themes", "mods"]) {
  if (!existsSync(join(root, dir))) continue;
  for (const entry of readdirSync(join(root, dir))) {
    if (entry.endsWith(".error")) bad(`${dir}/${entry}: an error file was committed`);
    const listed = rows.some((row) => row.src.startsWith(`${dir}/${entry}`));
    if (!listed && dir !== "mods") bad(`${dir}/${entry} is not in install.tsv`);
    if (!listed && dir === "mods" && statSync(join(root, dir, entry)).isDirectory()) {
      bad(`mods/${entry} is not in install.tsv`);
    }
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`farrier ${version}: ${rows.length} rows, ${ownMods.length} mods, checks passed`);

function parseJson(path, report) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    report(`${relative(root, path)} is not valid JSON: ${error.message}`);
    return null;
  }
}

function modRefs(node, out = []) {
  if (!node) return out;
  if (node.content?.mod) out.push(node.content.mod);
  if (node.terminal_menu) out.push(node.terminal_menu);
  for (const child of node.children ?? []) modRefs(child, out);
  return out;
}
