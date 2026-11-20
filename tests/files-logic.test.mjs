// Pure logic checks for farrier-files. Developer and CI only.
//
//   node --test tests/files-logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildTree,
  sortTree,
  visibleRows,
  filterRows,
  findNode,
  parseLsFiles,
  parseGitStatus,
  parseGitStatusRecords,
  addTreePath,
  removeTreePath,
  detectLanguage,
  fileKind,
  isRasterImage,
  isSvg,
  pickTabName,
  tabFileKey,
  isEmptyPane,
  findTargetEmptyPane,
  normalizeTarget,
  resolveAbsolutePath,
} from "../mods/farrier-files/files-logic.js";
import {
  buildFindRegExp,
  findMatches,
  replaceMatches,
  expandReplacement,
  applyPreserveCase,
  parseRgJson,
  parseGrepOutput,
  globMatches,
  pathMatchesGlobs,
  groupMatches,
  searchRows,
  planFileReplacements,
  byteOffsetToChar,
  buildRgArgs,
} from "../mods/farrier-files/search-logic.js";
import {
  FILE_NAMES as FILES_NAMES,
  FILE_EXTENSIONS as FILES_EXTENSIONS,
  fileKindParts as fileKindPartsFromFiles,
} from "../mods/farrier-files/file-kinds.js";
import {
  FILE_NAMES as GIT_NAMES,
  FILE_EXTENSIONS as GIT_EXTENSIONS,
  fileKindParts as fileKindPartsFromGit,
} from "../mods/farrier-git/file-kinds.js";
import {
  parseWorkbookPackage,
  parseSheetXml,
  parseStylesXml,
} from "../mods/farrier-files/xlsx-logic.js";
import {
  parseDelimitedText,
  parseSvgInfo,
  prepareSvgPreview,
  imageHeaderSize,
  imageSizeFromBase64,
  utf8ToBase64,
  decodeBase64,
  stepZoom,
} from "../mods/farrier-files/preview-logic.js";

function tree(paths) {
  const built = buildTree(paths);
  sortTree(built.root);
  return built;
}

test("paths, targets and names", () => {
  assert.deepEqual(normalizeTarget({ folder: "/r/", file: "/r/src/a.js" }), { root: "/r", file: "src/a.js" });
  assert.equal(resolveAbsolutePath("/r/", "src/a.js"), "/r/src/a.js");
  assert.deepEqual(parseLsFiles("a\0dir/b\0\0"), ["a", "dir/b"]);
  assert.deepEqual({ ...parseGitStatus("M  src/a.js\0?? new.txt\0D  gone\0") }, {
    "src/a.js": "M",
    "new.txt": "A",
    gone: "D",
  });
  assert.equal(detectLanguage("main.py").language, "python");
  assert.equal(detectLanguage("Makefile").language, "makefile");
  assert.deepEqual(fileKind("a.test.ts"), { icon: "test", tone: "ansi1" });
  assert.deepEqual(fileKind("app.tsx"), { icon: "code", tone: "ansi4" });
  assert.deepEqual(fileKind("style.css"), { icon: "style", tone: "ansi5" });
  assert.deepEqual(fileKind("page.html"), { icon: "html", tone: "ansi3" });
  assert.deepEqual(fileKind(".gitignore"), { icon: "branch", tone: "ansi1" });
  assert.deepEqual(fileKind("bundle.zip"), { icon: "archive", tone: "dim" });
  assert.deepEqual(fileKind("data.csv"), { icon: "table", tone: "ansi2" });
  assert.deepEqual(fileKind("schema.sql"), { icon: "db", tone: "ansi6" });
  assert.equal(isRasterImage("old.PNG"), true);
  assert.equal(isRasterImage("shape.svg"), false);
  assert.equal(isSvg("shape.svg"), true);
  assert.equal(pickTabName("src/index.js", ["index.js"], "/r"), "src/index.js");
  assert.equal(tabFileKey("/r/", "a.js"), '["/r","a.js"]');
});

test("empty pane detection", () => {
  assert.equal(isEmptyPane({ mod: "new-pane", title: "New pane" }), true);
  assert.equal(isEmptyPane({ mod: "space-pin", title: "New tab" }), true);
  assert.equal(isEmptyPane({ mod: "farrier-files", title: "Files" }), false);
  const panes = [
    { pane: "p1", mod: "farrier-files" },
    { pane: "p2", mod: "new-pane", title: "New pane" },
    { pane: "p3", mod: "space-pin", title: "New tab" },
  ];
  assert.equal(findTargetEmptyPane(panes, "p1").pane, "p2");
  assert.equal(findTargetEmptyPane(panes, "p3").pane, "p3");
});

test("tree flattening, filtering and expansion", () => {
  const built = tree(["src/a.js", "src/lib/b.ts", "README.md", ".gitignore"]);
  assert.equal(built.used, 4);
  assert.deepEqual(built.root.children.map((entry) => entry.name), ["src", ".gitignore", "README.md"]);
  const rows = visibleRows(built.root, new Set(["src", "src/lib"]));
  assert.deepEqual(rows.map((row) => row.path), ["src", "src/lib", "src/lib/b.ts", "src/a.js", ".gitignore", "README.md"]);
  assert.deepEqual(filterRows(built.root, new Set(), "b.ts").map((row) => row.path), ["src", "src/lib", "src/lib/b.ts"]);
  assert.equal(findNode(built.root, "src/lib/b.ts").dir, false);
  assert.equal(built.limited, false);
  assert.equal(addTreePath(built.root, "src/lib/c.js"), true);
  assert.equal(addTreePath(built.root, "docs/x.md"), true);
  assert.equal(removeTreePath(built.root, "src/lib/c.js"), true);
  assert.equal(findNode(built.root, "src/lib/c.js"), null);
  assert.equal(removeTreePath(built.root, "docs/x.md"), true);
  assert.equal(findNode(built.root, "docs"), null);
});

test("find: literal, whole word and alternation", () => {
  assert.equal(buildFindRegExp("a.b").source, "a\\.b");
  assert.deepEqual(findMatches("foo foobar foo", "foo", { wholeWord: true }).matches.map((m) => m.text), ["foo", "foo"]);
  assert.deepEqual(
    findMatches("foo foobar", "foo|foobar", { regex: true, wholeWord: true }).matches.map((m) => m.text),
    ["foo", "foobar"],
  );
  const unicode = findMatches("中文 foo\n", "foo");
  assert.deepEqual([unicode.matches[0].line, unicode.matches[0].column], [1, 3]);
  assert.equal(byteOffsetToChar("中文 foo", 7), 3);
  assert.equal(findMatches("x", "(", { regex: true }).valid, false);
});

test("replacement expansion, case and back-to-front apply", () => {
  assert.equal(expandReplacement("$1-$&", { text: "Foo", groups: ["Foo"] }, true), "Foo-Foo");
  assert.equal(expandReplacement("\\U$1end", { text: "foo", groups: ["foo"] }, true), "FOOEND");
  assert.equal(applyPreserveCase("Foo", "bar"), "Bar");
  assert.equal(applyPreserveCase("FOO", "bar"), "BAR");
  const text = "one foo two\nthree foo four";
  const found = findMatches(text, "foo");
  const applied = replaceMatches(text, found.matches, "bar");
  assert.equal(applied.count, 2);
  assert.equal(applied.text, "one bar two\nthree bar four");
});

test("search output parsing, globs and grouping", () => {
  const json = [
    JSON.stringify({ type: "match", data: { path: { text: "src/a.js" }, lines: { text: "中文 foo\n" }, line_number: 3, submatches: [{ start: 7, end: 10 }] } }),
    JSON.stringify({ type: "match", data: { path: { text: "docs/b.md" }, lines: { text: "foo\n" }, line_number: 1, submatches: [{ start: 0, end: 3 }] } }),
  ].join("\n");
  const matches = parseRgJson(json);
  assert.equal(matches.length, 2);
  assert.deepEqual([matches[0].line, matches[0].column], [3, 3]);
  assert.deepEqual(parseGrepOutput("./src/a.js:12:foo bar", "foo").map((m) => m.file), ["src/a.js"]);
  assert.equal(globMatches("src/lib/a.ts", "src"), true);
  assert.equal(pathMatchesGlobs("src/lib/a.ts", "src/**", "**/test/**"), true);
  const grouped = groupMatches(matches, { maxFiles: 10, maxMatches: 10 });
  assert.equal(grouped.groups.length, 2);
  assert.equal(searchRows(grouped.groups, new Set()).length, 4);
  assert.ok(buildRgArgs("needle", { include: "src" }).includes("--glob=**/src/**"));
});

test("safe file replacement keeps exact targets", () => {
  const found = findMatches("foo foo", "foo");
  const planned = planFileReplacements("foo foo", found.matches, "foo", {}, "bar", false);
  assert.equal(planned.ok, true);
  assert.equal(planned.text, "bar bar");
  const moved = findMatches("x foo", "foo");
  const stale = planFileReplacements("x foo y", [{ line: 1, column: 2, length: 3 }], "foo", {}, "bar", false);
  assert.equal(stale.ok, true);
  assert.equal(moved.matches[0].column, 2);
  const bomFound = findMatches("foo", "foo");
  const bom = planFileReplacements("﻿foo", bomFound.matches, "foo", {}, "bar", false);
  assert.equal(bom.text, "﻿bar");
});

test("delimited tables", () => {
  const csv = parseDelimitedText('name,note\r\n"a, b","line 1\nline 2"\r\n');
  assert.deepEqual(csv.rows, [["name", "note"], ["a, b", "line 1\nline 2"]]);
  assert.equal(csv.columns, 2);
  const tsv = parseDelimitedText("a\tb\nc\td");
  assert.equal(tsv.delimiter, "\t");
  assert.deepEqual(tsv.rows, [["a", "b"], ["c", "d"]]);
});

test("XLSX workbook parsing", () => {
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" s="1"><v>45292</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Hello &amp; bye</t></is></c><c r="B2" t="b"><v>1</v></c></row>
  </sheetData></worksheet>`;
  const styles = parseStylesXml('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>');
  const parsed = parseSheetXml(sheet, ["Name"], styles);
  assert.deepEqual(parsed.rows[0], ["Name", "42", "2024-01-01"]);
  assert.deepEqual(parsed.rows[1], ["Hello & bye", "TRUE"]);
  const workbook = parseWorkbookPackage({
    workbookXml: '<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>',
    relsXml: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://x/worksheet"/></Relationships>',
    sharedStringsXml: '<sst><si><t>Name</t></si></sst>',
    stylesXml: '<styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>',
    sheetXmls: { "xl/worksheets/sheet1.xml": sheet },
  });
  assert.equal(workbook.sheets.length, 1);
  assert.equal(workbook.sheets[0].name, "Data");
  assert.equal(workbook.sheets[0].rows[0][0], "Name");
});

test("SVG and raster dimensions", () => {
  const svg = '<svg width="24" height="24" viewBox="0 0 24 24"></svg>';
  assert.deepEqual(parseSvgInfo(svg), { width: 24, height: 24, ratio: 1, viewBox: { x: 0, y: 0, width: 24, height: 24 } });
  const prepared = prepareSvgPreview(svg, 2);
  assert.equal(prepared.width, 48);
  assert.match(prepared.text, /width="48"/);
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0, 0, 0, 13], 8);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  png.set([0, 0, 0, 20], 16);
  png.set([0, 0, 0, 10], 20);
  assert.deepEqual(imageHeaderSize(png), { width: 20, height: 10 });
  assert.deepEqual(decodeBase64("AAAA"), [0, 0, 0]);
  assert.equal(stepZoom(100, 1), 150);
  assert.equal(stepZoom(100, -1), 75);
});

test("base64 round trip and UTF-8", () => {
  const text = "a中\n😀";
  const encoded = utf8ToBase64(text);
  assert.equal(encoded, Buffer.from(text, "utf8").toString("base64"));
  assert.deepEqual(decodeBase64(encoded), [...Buffer.from(text, "utf8")]);
});

test("file icons are shared by both panels", () => {
  const icons = ["archive", "branch", "code", "config", "db", "file", "html", "image", "json", "lock", "shell", "style", "table", "test", "text"];
  for (const mod of ["farrier-files", "farrier-git"]) {
    for (const name of icons) {
      const path = fileURLToPath(new URL(`../mods/${mod}/icons/${name}.svg`, import.meta.url));
      assert.equal(existsSync(path), true, `${mod} is missing ${name}.svg`);
    }
  }
});

test("Files and Git share one file-kind table", () => {
  assert.deepEqual(FILES_NAMES, GIT_NAMES);
  assert.deepEqual(FILES_EXTENSIONS, GIT_EXTENSIONS);
  for (const name of ["app.ts", "style.css", "page.html", ".gitignore", "data.csv", "bundle.zip", "schema.sql", "README.md"]) {
    assert.deepEqual(fileKindPartsFromFiles(name), fileKindPartsFromGit(name), name);
  }
});
