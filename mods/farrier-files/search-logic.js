// Pure search, find and replace helpers for farrier-files. Deterministic and
// free of GPUI/Herdr imports so the matching, globbing and output parsing can
// be tested without the app.

export const FIND_MATCH_CAP = 5000;
export const SEARCH_MATCH_CAP = 2000;
export const SEARCH_FILE_CAP = 200;
export const SEARCH_LINE_CAP = 200;

export function normalizeFindOptions(options = {}) {
  const cap = Number(options.cap);
  return {
    caseSensitive: options.caseSensitive === true,
    wholeWord: options.wholeWord === true,
    regex: options.regex === true,
    cap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : FIND_MATCH_CAP,
  };
}

export function escapeRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turns pasted CRLF and lone CR line endings into the LF the editor uses. */
export function normalizeQueryLineEndings(query) {
  return String(query ?? "").replace(/\r\n?/g, "\n");
}

/** A pasted block usually carries blank first or last lines; they are not part of the code. */
export function prepareSearchQuery(query) {
  return normalizeQueryLineEndings(query).replace(/^\n+/, "").replace(/\n+$/, "");
}

export function hasLineBreak(query) {
  return normalizeQueryLineEndings(query).includes("\n");
}

/** A literal or regex body whose line breaks match LF and CRLF files alike. */
export function multilinePattern(query, regex = false) {
  const body = regex ? normalizeQueryLineEndings(query) : escapeRegExp(normalizeQueryLineEndings(query));
  return body.replace(/\n/g, "\\r?\\n");
}

export function buildFindRegExp(query, options = {}) {
  const opts = normalizeFindOptions(options);
  const raw = normalizeQueryLineEndings(typeof query === "string" ? query : "");
  if (!raw.length) {
    return { empty: true, valid: true, error: null, source: "", flags: "", regex: null, wholeWord: opts.wholeWord };
  }
  const body = (opts.regex ? raw : escapeRegExp(raw)).replace(/\n/g, "\\r?\\n");
  // A capture group around the body lets whole-word mode keep alternations:
  // `foo|foobar` can still match `foobar` when `foo` stops at a word boundary.
  const source = opts.wholeWord ? `(?:^|\\W)(${body})(?=\\W|$)` : body;
  const flags = opts.caseSensitive ? "gm" : "gim";
  try {
    return {
      empty: false,
      valid: true,
      error: null,
      source,
      flags,
      regex: new RegExp(source, flags),
      wholeWord: opts.wholeWord,
    };
  } catch (error) {
    return {
      empty: false,
      valid: false,
      error: error?.message || "Invalid regular expression",
      source,
      flags,
      regex: null,
      wholeWord: opts.wholeWord,
    };
  }
}

export function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function lineIndexAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, high);
}

export function offsetToLineColumn(lineStarts, index) {
  const line = lineIndexAt(lineStarts, index);
  return { line: line + 1, column: index - lineStarts[line], lineIndex: line };
}

export function lineTextAt(lineStarts, text, lineIndex) {
  const start = lineStarts[lineIndex];
  if (start === undefined) return "";
  const end = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] - 1 : text.length;
  return text.slice(start, end).replace(/\r$/, "");
}

/** How many source lines a match paints, ignoring a newline the match ends on. */
export function matchLineSpan(text) {
  const body = String(text ?? "");
  if (!body) return 1;
  const lines = body.split("\n").length;
  return body.endsWith("\n") ? Math.max(1, lines - 1) : lines;
}

export function findMatches(text, query, options = {}) {
  const opts = normalizeFindOptions(options);
  const built = buildFindRegExp(query, opts);
  if (built.empty) return { matches: [], valid: true, error: null, empty: true };
  if (!built.valid) return { matches: [], valid: false, error: built.error, empty: false };
  const source = typeof text === "string" ? text : "";
  const starts = buildLineStarts(source);
  const matches = [];
  const re = built.regex;
  let guard = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (guard++ > opts.cap * 4 + 16) break;
    let start = m.index;
    let end = start + m[0].length;
    let groups = m.slice(1);
    if (built.wholeWord) {
      const body = m[1];
      if (!body) {
        if (end === start) re.lastIndex = Math.min(source.length + 1, end + 1);
        continue;
      }
      start = m.index + m[0].lastIndexOf(body);
      end = start + body.length;
      groups = [body, ...m.slice(2)];
    }
    if (end <= start) {
      re.lastIndex = Math.min(source.length + 1, start + 1);
      continue;
    }
    const at = offsetToLineColumn(starts, start);
    const span = matchLineSpan(source.slice(start, end));
    matches.push({
      start,
      end,
      length: end - start,
      text: source.slice(start, end),
      line: at.line,
      column: at.column,
      endColumn: at.column + (end - start),
      lineIndex: at.lineIndex,
      lineSpan: span,
      groups,
    });
    if (matches.length >= opts.cap) break;
  }
  return { matches, valid: true, error: null, empty: false };
}

export function stepMatchIndex(current, delta, count) {
  if (!count) return 0;
  const next = (Number(current) + Number(delta) + count) % count;
  return next < 0 ? next + count : next;
}

export function matchIndexAtLine(matches, line) {
  const target = Math.max(1, Number(line) || 1);
  let best = 0;
  for (let i = 0; i < matches.length; i += 1) {
    if (matches[i].line >= target) return i;
    best = i;
  }
  return best;
}

/** The match under the caret, or the closest one beside it. */
export function nearestMatchIndex(matches, offset) {
  if (!matches.length) return 0;
  const target = Math.max(0, Number(offset) || 0);
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const gap = target < match.start ? match.start - target : target > match.end ? target - match.end : 0;
    if (gap <= distance) {
      best = i;
      distance = gap;
    }
  }
  return best;
}

export function contextSegments(lineText, startColumn, endColumn, maxChars = 180) {
  const text = String(lineText ?? "").replace(/\r$/, "");
  const start = Math.max(0, Math.min(text.length, Number(startColumn) || 0));
  const end = Math.max(start, Math.min(text.length, Number(endColumn) || start));
  if (text.length <= maxChars) {
    return [
      { text: text.slice(0, start), hit: false },
      { text: text.slice(start, end), hit: true },
      { text: text.slice(end), hit: false },
    ];
  }
  let windowStart = Math.max(0, start - 46);
  let windowEnd = Math.min(text.length, end + Math.max(40, maxChars - (end - start) - 46));
  if (windowEnd - windowStart > maxChars) windowEnd = windowStart + maxChars;
  if (windowEnd < end) {
    windowStart = Math.max(0, end - maxChars);
    windowEnd = Math.min(text.length, windowStart + maxChars);
  }
  const leading = windowStart > 0 ? "…" : "";
  const trailing = windowEnd < text.length ? "…" : "";
  return [
    { text: leading + text.slice(windowStart, start), hit: false },
    { text: text.slice(start, end), hit: true },
    { text: text.slice(end, windowEnd) + trailing, hit: false },
  ];
}

function applyCaseMode(text, mode, oneShot) {
  if (!mode && !oneShot) return text;
  if (!text) return text;
  if (oneShot === "upper") return text[0].toUpperCase() + text.slice(1);
  if (oneShot === "lower") return text[0].toLowerCase() + text.slice(1);
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text;
}

/**
 * Expands a replacement template. Literal mode inserts the template as-is;
 * regex mode supports $0/$&, $1..$99, $$, \n, \t, \\, \$ and the case
 * operations \u, \l, \U, \L and \E. Unknown escapes keep their backslash.
 */
export function expandReplacement(template, match, regexMode) {
  const raw = String(template ?? "");
  if (!regexMode) return raw;
  const groups = Array.isArray(match?.groups) ? match.groups : [match?.text ?? ""];
  const whole = match?.text ?? groups[0] ?? "";
  let out = "";
  let mode = "";
  let oneShot = "";
  const emit = (text) => {
    out += applyCaseMode(text, mode, oneShot);
    oneShot = "";
  };
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "\\") {
      const next = raw[i + 1];
      if (next === undefined) {
        emit("\\");
        continue;
      }
      i += 1;
      if (next === "n") emit("\n");
      else if (next === "t") emit("\t");
      else if (next === "r") emit("\r");
      else if (next === "\\" || next === "$") emit(next);
      else if (next === "u" || next === "U" || next === "l" || next === "L" || next === "E") {
        if (next === "E") {
          mode = "";
          oneShot = "";
        } else if (next === "u" || next === "l") {
          oneShot = next === "u" ? "upper" : "lower";
        } else {
          mode = next === "U" ? "upper" : "lower";
          oneShot = "";
        }
      } else {
        emit(`\\${next}`);
      }
      continue;
    }
    if (c === "$") {
      const next = raw[i + 1];
      if (next === "$") {
        emit("$");
        i += 1;
        continue;
      }
      if (next === "&" || next === "0") {
        emit(whole);
        i += 1;
        continue;
      }
      if (next >= "1" && next <= "9") {
        let digits = next;
        const after = raw[i + 2];
        if (after >= "0" && after <= "9") {
          const two = Number(digits + after);
          if (two <= groups.length) {
            digits += after;
            i += 1;
          }
        }
        const index = Number(digits) - 1;
        emit(String(groups[index] ?? ""));
        i += 1;
        continue;
      }
      emit("$");
      continue;
    }
    emit(c);
  }
  return out;
}

export function applyPreserveCase(original, replacement) {
  const source = String(original ?? "");
  const target = String(replacement ?? "");
  if (!source || !target) return target;
  const allUpper = source.toUpperCase() === source && source.toLowerCase() !== source;
  const allLower = source.toLowerCase() === source && source.toUpperCase() !== source;
  if (allUpper) return target.toUpperCase();
  if (allLower) return target.toLowerCase();
  const first = source[0];
  const transformed = first === first.toUpperCase() ? target.toUpperCase() : target.toLowerCase();
  return transformed[0] + target.slice(1);
}

export function replaceMatches(text, matches, template, options = {}) {
  const source = String(text ?? "");
  if (!Array.isArray(matches) || !matches.length) return { text: source, count: 0 };
  const opts = normalizeFindOptions(options);
  let out = "";
  let cursor = 0;
  let count = 0;
  for (const match of matches) {
    if (!match || match.start < cursor || match.end > source.length) continue;
    out += source.slice(cursor, match.start);
    let value = expandReplacement(template, match, opts.regex);
    if (options.preserveCase) value = applyPreserveCase(source.slice(match.start, match.end), value);
    out += value;
    cursor = match.end;
    count += 1;
  }
  out += source.slice(cursor);
  return { text: out, count };
}

export function durationSafeRegex(query, options) {
  return buildFindRegExp(query, options);
}

export function cleanAnsi(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\[\d{1,2}(?:;\d{1,2})*m/g, "")
    .replace(/\r/g, "");
}

export function cleanError(text) {
  const lines = cleanAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return (lines.slice(0, 4).join("\n") || "The command failed").slice(0, 1200);
}

// ---- globs ------------------------------------------------------------------

export function parseGlobList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function escapeRegexChar(c) {
  return /[\\^$+.()|[\]{}]/.test(c) ? `\\${c}` : c;
}

export function globToRegExp(glob, caseSensitive = true) {
  let pattern = String(glob ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^!/, "");
  if (!pattern) return null;
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        if (slash) {
          source += "(?:[^/]+/)*";
          i += 2;
        } else if (i + 2 >= pattern.length) {
          source += ".*";
          i += 1;
        } else {
          source += "[^/]*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const choices = pattern.slice(i + 1, close).split(",");
        source += `(?:${choices.map((choice) => choice.split("").map(escapeRegexChar).join("")).join("|")})`;
        i = close;
      } else {
        source += "\\{";
      }
    } else {
      source += escapeRegexChar(c);
    }
  }
  source += "$";
  try {
    return new RegExp(source, caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}

export function globMatches(path, glob) {
  const normalized = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const raw = String(glob ?? "").trim().replace(/^!/, "");
  if (!raw) return false;
  const variants = [raw];
  if (!raw.includes("/")) {
    variants.push(`**/${raw}`, `**/${raw}/**`);
  }
  for (const variant of variants) {
    const re = globToRegExp(variant);
    if (re && re.test(normalized)) return true;
  }
  return false;
}

export function pathMatchesGlobs(path, include, exclude) {
  const inc = parseGlobList(include);
  const exc = parseGlobList(exclude).map((glob) => glob.replace(/^!/, ""));
  if (inc.length && !inc.some((glob) => globMatches(path, glob))) return false;
  if (exc.length && exc.some((glob) => globMatches(path, glob))) return false;
  return true;
}

function expandRgGlob(glob) {
  if (glob.includes("/")) return [glob];
  return [`**/${glob}/**`, `**/${glob}`];
}

export function blockSearchAnchor(query, regex = false) {
  if (regex) return regexLiteralAnchor(query);
  let anchor = "";
  for (const line of prepareSearchQuery(query).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > anchor.length) anchor = trimmed;
  }
  return anchor;
}

/** The longest literal run in a regex, for a cheap candidate prefilter. */
function regexLiteralAnchor(query) {
  let best = "";
  for (const line of prepareSearchQuery(query).split("\n")) {
    let run = "";
    let inClass = false;
    const consider = () => {
      const text = run.trim();
      if (text.length > best.length) best = text;
      run = "";
    };
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (inClass) {
        if (char === "\\") index += 1;
        else if (char === "]") {
          inClass = false;
          consider();
        }
        continue;
      }
      if (char === "\\") {
        const next = line[index + 1];
        if (!next) {
          consider();
          break;
        }
        if (next === "u" || next === "x") {
          consider();
          index += next === "u" ? 5 : 3;
        } else if (/[sSdDwWbBnrtfvpP0-9]/.test(next)) {
          consider();
          index += 1;
        } else {
          run += next;
          index += 1;
        }
        continue;
      }
      if (char === "[") {
        inClass = true;
        consider();
        continue;
      }
      if ("^$.*+?(){}|".includes(char)) {
        consider();
        continue;
      }
      run += char;
    }
    consider();
  }
  return best;
}

/** Paths printed one per line by `git grep -l` or `grep -rl`. */
export function parseSearchFileList(stdout) {
  const out = [];
  for (const raw of String(stdout ?? "").split("\n")) {
    const path = raw.replace(/\r$/, "").replace(/\\/g, "/").replace(/^[.][/]/, "");
    if (path.trim()) out.push(path);
  }
  return out;
}

export function buildRgArgs(query, options = {}) {
  const opts = normalizeFindOptions(options);
  const multiline = hasLineBreak(query);
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--no-heading",
    "--color=never",
    "--hidden",
    "--glob=!.git/**",
    "--max-columns=400",
    "--max-columns-preview",
    "--max-count=100",
    "--max-filesize=1M",
    "--glob=!.git",
  ];
  for (const glob of parseGlobList(options.include)) {
    for (const variant of expandRgGlob(glob)) args.push(`--glob=${variant}`);
  }
  for (const glob of parseGlobList(options.exclude)) {
    for (const variant of expandRgGlob(glob)) args.push(`--glob=!${variant}`);
  }
  if (opts.wholeWord) args.push("--word-regexp");
  args.push(opts.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (multiline) {
    args.push("--multiline", "--crlf", "--regexp", multilinePattern(query, opts.regex), "--", ".");
  } else {
    if (!opts.regex) args.push("--fixed-strings");
    args.push("--", String(query ?? ""));
  }
  return args;
}

export function buildGitGrepArgs(query, options = {}) {
  const opts = normalizeFindOptions(options);
  const args = ["--no-pager", "grep", "-n", "-I", "--untracked"];
  if (!opts.regex) args.push("-F");
  else args.push("-E");
  if (!opts.caseSensitive) args.push("-i");
  if (opts.wholeWord) args.push("-w");
  args.push("-e", String(query ?? ""));
  return args;
}

export function buildGrepArgs(query, options = {}) {
  const opts = normalizeFindOptions(options);
  const args = ["-r", "-I", "-n", "-m", "100", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=build"];
  if (!opts.regex) args.push("-F");
  else args.push("-E");
  if (!opts.caseSensitive) args.push("-i");
  if (opts.wholeWord) args.push("-w");
  args.push("--", String(query ?? ""), ".");
  return args;
}

// ---- ripgrep / grep ----------------------------------------------------------

export function byteOffsetToChar(text, byteOffset) {
  const source = String(text ?? "");
  let bytes = 0;
  let index = 0;
  while (index < source.length && bytes < byteOffset) {
    const code = source.codePointAt(index);
    const width = code > 0xffff ? 2 : 1;
    const length = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    bytes += length;
    index += width;
  }
  return bytes > byteOffset ? index - 1 : index;
}

export function parseRgJson(stdout, options = {}) {
  const cap = Number(options.cap) || SEARCH_MATCH_CAP;
  const matches = [];
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line || matches.length >= cap) break;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "match" || !event.data) continue;
    const path = String(event.data.path?.text ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path) continue;
    const block = String(event.data.lines?.text ?? "");
    const blockStarts = buildLineStarts(block);
    const lineNo = Number(event.data.line_number) || 1;
    const submatches = Array.isArray(event.data.submatches) ? event.data.submatches : [];
    for (const sub of submatches) {
      if (matches.length >= cap) break;
      const start = byteOffsetToChar(block, Number(sub.start) || 0);
      const end = byteOffsetToChar(block, Number(sub.end) || 0);
      if (end <= start) continue;
      const at = offsetToLineColumn(blockStarts, start);
      const last = offsetToLineColumn(blockStarts, Math.max(start, end));
      const startLine = lineNo + at.lineIndex;
      const lineEnd = at.lineIndex + 1 < blockStarts.length ? blockStarts[at.lineIndex + 1] - 1 : block.length;
      const lineText = lineTextAt(blockStarts, block, at.lineIndex);
      const span = matchLineSpan(block.slice(start, end));
      const endLine = startLine + span - 1;
      matches.push({
        file: path,
        line: startLine,
        column: at.column,
        endColumn: span > 1 || end > lineEnd ? lineText.length : last.column,
        length: end - start,
        text: block.slice(start, end),
        lineText,
        lineSpan: span,
        endLine,
      });
    }
  }
  return matches;
}

export function parseGrepOutput(stdout, query, options = {}) {
  const cap = Number(options.cap) || SEARCH_MATCH_CAP;
  const matches = [];
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (const raw of lines) {
    if (!raw || matches.length >= cap) break;
    const match = /^(.+?):(\d+):(.*)$/.exec(raw);
    if (!match) continue;
    const file = match[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const lineNo = Number(match[2]) || 1;
    const lineText = match[3];
    const found = findMatches(lineText, query, options);
    if (!found.valid || !found.matches.length) continue;
    for (const hit of found.matches) {
      if (matches.length >= cap) break;
      matches.push({
        file,
        line: lineNo,
        column: hit.column,
        endColumn: hit.endColumn,
        length: hit.length,
        text: hit.text,
        lineText,
        lineSpan: 1,
      });
    }
  }
  return matches;
}

export function classifySearchResult(result, matchCount) {
  const code = Number(result?.code ?? 1);
  if (code === 0 || code === 1) return { ok: true, warning: null, error: null };
  const text = cleanError(result?.stderr || result?.stdout || "");
  if (code === 2 && matchCount > 0) return { ok: true, warning: text || "Search ended early", error: null };
  return { ok: false, warning: null, error: text };
}

// ---- result grouping and rows -------------------------------------------------

export function groupMatches(matches, options = {}) {
  const maxFiles = Number(options.maxFiles) || SEARCH_FILE_CAP;
  const maxMatches = Number(options.maxMatches) || SEARCH_MATCH_CAP;
  const groups = [];
  let byFile = null;
  let used = 0;
  for (const match of [...matches].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)) {
    if (!byFile || byFile.file !== match.file) {
      if (groups.length >= maxFiles) break;
      byFile = { file: match.file, matches: [] };
      groups.push(byFile);
    }
    if (used >= maxMatches) break;
    byFile.matches.push(match);
    used += 1;
  }
  return { groups, total: matches.length, limited: matches.length > used || matches.length > maxMatches };
}

export function searchRows(groups, collapsed, maxRows = 20000) {
  const rows = [];
  for (const group of groups) {
    if (rows.length >= maxRows) break;
    rows.push({
      kind: "file",
      file: group.file,
      count: group.matches.length,
      key: `f:${group.file}`,
      size: 28,
      collapsed: collapsed?.has?.(group.file) === true,
    });
    if (collapsed?.has?.(group.file)) continue;
    for (const match of group.matches) {
      if (rows.length >= maxRows) break;
      rows.push({
        kind: "match",
        file: group.file,
        match,
        key: `m:${group.file}:${match.line}:${match.column}:${match.length}`,
        size: 24,
      });
    }
  }
  return rows;
}

export function searchSummary(groups, totalMatches, options = {}) {
  const files = groups.length;
  const shown = groups.reduce((n, group) => n + group.matches.length, 0);
  const limited = options.limited === true || totalMatches > shown;
  return `${shown} result${shown === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}${limited ? " (limited)" : ""}`;
}

export function searchGlobLabel(include, exclude) {
  const parts = [];
  if (String(include ?? "").trim()) parts.push(`include ${String(include).trim()}`);
  if (String(exclude ?? "").trim()) parts.push(`exclude ${String(exclude).trim()}`);
  return parts.join(" · ");
}

export function matchKey(match) {
  return `${match.line}:${match.column}:${match.length}`;
}

export function targetsStillMatch(freshMatches, targets) {
  if (!Array.isArray(targets) || !targets.length) return false;
  const fresh = new Set(freshMatches.map(matchKey));
  for (const target of targets) if (!fresh.has(matchKey(target))) return false;
  return true;
}

export function selectMatchesByTargets(freshMatches, targets) {
  if (!Array.isArray(targets) || !targets.length) return [];
  const wanted = new Set(targets.map(matchKey));
  return freshMatches.filter((match) => wanted.has(matchKey(match)));
}

export function planFileReplacements(freshText, targets, query, options, replacement, preserveCase) {
  const bom = String(freshText ?? "").charCodeAt(0) === 0xfeff;
  const body = bom ? String(freshText).slice(1) : String(freshText ?? "");
  const found = findMatches(body, query, { ...options, cap: 100000 });
  if (!found.valid) return { ok: false, reason: found.error || "Invalid search", text: freshText, count: 0 };
  if (!targetsStillMatch(found.matches, targets)) {
    return { ok: false, reason: "File changed since the search", text: freshText, count: 0 };
  }
  const selected = selectMatchesByTargets(found.matches, targets);
  const applied = replaceMatches(body, selected, replacement, { ...options, preserveCase });
  return { ok: true, reason: null, text: (bom ? "\uFEFF" : "") + applied.text, count: applied.count };
}

export function replacementPreview(template, match, options = {}) {
  const opts = normalizeFindOptions(options);
  const value = expandReplacement(template, match, opts.regex);
  return options.preserveCase ? applyPreserveCase(match?.text ?? "", value) : value;
}
