// Language-aware comment toggling for the file tab. Pure functions only, so
// the line and block cases can be checked with Node.

import { detectLanguage, splitPathInfo } from "./files-logic.js";

const LINE_COMMENT = {
  js: "//",
  rust: "//",
  go: "//",
  c: "//",
  cpp: "//",
  java: "//",
  kotlin: "//",
  swift: "//",
  php: "//",
  python: "#",
  bash: "#",
  yaml: "#",
  ruby: "#",
  sql: "--",
  lua: "--",
  dockerfile: "#",
  makefile: "#",
  cmake: "#",
};

const BLOCK_COMMENT = {
  css: ["/*", "*/"],
  html: ["<!--", "-->"],
  xml: ["<!--", "-->"],
  markdown: ["<!--", "-->"],
};

/**
 * The comment forms a path accepts, or null when toggling comments makes no
 * sense for it. JSON stays strict; JSON with comments and JSONC both take
 * `//`.
 */
export function commentStyleFor(path) {
  const { ext } = splitPathInfo(path);
  if (ext === "json") return null;
  if (ext === "jsonc") return { line: "//", block: ["/*", "*/"] };
  const { language } = detectLanguage(path);
  const line = LINE_COMMENT[language];
  const block = BLOCK_COMMENT[language];
  if (line || block) return { line: line ?? null, block: block ?? null };
  return null;
}

function lineStartAt(text, offset) {
  const at = Math.max(0, Math.min(text.length, Number(offset) || 0));
  if (at === 0) return 0;
  const newline = text.lastIndexOf("\n", at - 1);
  return newline < 0 ? 0 : newline + 1;
}

function lineEndAt(text, offset) {
  const at = Math.max(0, Math.min(text.length, Number(offset) || 0));
  const newline = text.indexOf("\n", at);
  return newline < 0 ? text.length : newline;
}

/** The whole lines a selection touches. An end at a line start does not add
 *  that next line, which is how a selection dragged to the next line's start
 *  is usually meant. */
export function selectedLineRange(text, start, end) {
  const source = String(text ?? "");
  const first = lineStartAt(source, start);
  let last = lineEndAt(source, end);
  if (end > start && end === lineStartAt(source, end) && end > first) last = lineEndAt(source, end - 1);
  if (last < first) last = first;
  return { start: first, end: last };
}

function indentOf(line) {
  return (line.match(/^[ \t]*/) ?? [""])[0];
}

function startsWithComment(line, prefix) {
  return line.slice(indentOf(line).length).startsWith(prefix);
}

function commentLine(line, prefix) {
  if (!line.trim()) return line;
  if (startsWithComment(line, prefix)) return line;
  const indent = indentOf(line);
  return `${indent}${prefix} ${line.slice(indent.length)}`;
}

function uncommentLine(line, prefix) {
  const indent = indentOf(line);
  const body = line.slice(indent.length);
  if (!body.startsWith(prefix)) return line;
  let after = body.slice(prefix.length);
  if (after.startsWith(" ") || after.startsWith("\t")) after = after.slice(1);
  return indent + after;
}

function toggleLines(text, start, end, prefix) {
  const range = selectedLineRange(text, start, end);
  const body = text.slice(range.start, range.end);
  const lines = body.split("\n");
  const meaningful = lines.filter((line) => line.trim());
  const allCommented = meaningful.length > 0 && meaningful.every((line) => startsWithComment(line, prefix));
  const replacement = lines
    .map((line) => (allCommented ? uncommentLine(line, prefix) : commentLine(line, prefix)))
    .join("\n");
  if (replacement === body) return null;
  return { text: replacement, start: range.start, oldEnd: range.end, end: range.start + replacement.length };
}

function toggleBlock(text, start, end, open, close) {
  const range = selectedLineRange(text, start, end);
  const body = text.slice(range.start, range.end);
  const indent = indentOf(body);
  const rest = body.slice(indent.length);
  const trimmedEnd = body.replace(/[ \t]+$/, "");
  const trailing = body.slice(trimmedEnd.length);
  const wrapped = rest.startsWith(open) && trimmedEnd.endsWith(close);
  let replacement;
  if (wrapped) {
    let inner = trimmedEnd.slice(indent.length + open.length, trimmedEnd.length - close.length);
    if (inner.startsWith(" ") || inner.startsWith("\t")) inner = inner.slice(1);
    if (inner.endsWith(" ") || inner.endsWith("\t")) inner = inner.slice(0, -1);
    replacement = indent + inner + trailing;
  } else {
    replacement = `${indent}${open}${rest}${close}`;
  }
  if (replacement === body) return null;
  return { text: replacement, start: range.start, oldEnd: range.end, end: range.start + replacement.length };
}

/**
 * Toggles comments over the lines a selection touches. Returns the replacement
 * for that whole-line range, with the matching selection after the edit, or
 * null when the language has no comment form or nothing changed.
 */
export function toggleCommentText(text, start, end, style) {
  if (!style) return null;
  if (style.line) return toggleLines(text, start, end, style.line);
  if (style.block) return toggleBlock(text, start, end, style.block[0], style.block[1]);
  return null;
}
