// Pure XLSX package helpers for farrier-files. The shell reads the ZIP
// entries; this module turns the OOXML strings into a small table model.
// No GPUI, Herdr or Node imports, so it can be checked with Node.

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

const MAX_ROWS = 2000;
const MAX_COLUMNS = 100;
const MAX_CELL = 500;

export function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(tag, name) {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`, "i");
  const match = re.exec(tag);
  return match ? decodeXml(match[1] ?? match[2] ?? "") : null;
}

function tags(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b[^>]*>`, "gi");
  let match;
  while ((match = re.exec(String(xml ?? ""))) !== null) out.push(match[0]);
  return out;
}

function inner(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(String(xml ?? ""));
  return match ? match[1] : "";
}

export function parseWorkbookXml(xml) {
  return tags(xml, "sheet").map((tag) => ({
    name: attr(tag, "name") || "Sheet",
    rid: attr(tag, "r:id") || attr(tag, "id") || "",
  }));
}

export function parseRelationshipsXml(xml) {
  const targets = Object.create(null);
  for (const tag of tags(xml, "Relationship")) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    const type = attr(tag, "Type") ?? "";
    if (!id || !target) continue;
    if (type && !type.endsWith("/worksheet")) continue;
    targets[id] = target;
  }
  return targets;
}

export function parseSharedStringsXml(xml) {
  const strings = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let match;
  while ((match = re.exec(String(xml ?? ""))) !== null) {
    const body = match[1];
    const texts = [];
    const parts = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
    let text;
    while ((text = parts.exec(body)) !== null) texts.push(decodeXml(text[1]));
    strings.push(texts.join(""));
  }
  return strings;
}

export function parseStylesXml(xml) {
  const formats = Object.create(null);
  for (const tag of tags(xml, "numFmt")) {
    const id = Number(attr(tag, "numFmtId"));
    const code = attr(tag, "formatCode") ?? "";
    if (Number.isFinite(id)) formats[id] = code;
  }
  const block = inner(xml, "cellXfs");
  const styles = tags(block, "xf").map((tag) => {
    const id = Number(attr(tag, "numFmtId"));
    const code = formats[id] ?? "";
    const date = BUILTIN_DATE_FORMATS.has(id) || /[ymdhs]/i.test(code);
    return { date, code };
  });
  return styles;
}

function columnNumber(letters) {
  let value = 0;
  for (const char of String(letters ?? "").toUpperCase()) {
    const code = char.charCodeAt(0) - 64;
    if (code < 1 || code > 26) continue;
    value = value * 26 + code;
  }
  return value - 1;
}

function cellText(tag, innerXml, sharedStrings) {
  const kind = attr(tag, "t");
  const value = inner(innerXml, "v");
  if (kind === "s") {
    const index = Number(value);
    return sharedStrings[index] ?? "";
  }
  if (kind === "inlineStr") {
    const texts = [];
    const parts = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
    let match;
    const body = inner(innerXml, "is");
    while ((match = parts.exec(body)) !== null) texts.push(decodeXml(match[1]));
    return texts.join("");
  }
  if (kind === "b") return value === "1" ? "TRUE" : "FALSE";
  if (kind === "d") return decodeXml(value);
  return decodeXml(value);
}

function excelDate(serial) {
  const number = Number(serial);
  if (!Number.isFinite(number) || number <= 0) return String(serial);
  const date = new Date(Date.UTC(1899, 11, 30) + number * 86400000);
  const iso = date.toISOString();
  if (Math.abs(number - Math.round(number)) < 0.00001) return iso.slice(0, 10);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function parseSheetXml(xml, sharedStrings, styles) {
  const rows = [];
  const usedColumns = new Set();
  let truncated = false;
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(xml ?? ""))) !== null) {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const openTag = `<row${rowMatch[1]}>`;
    const rowNumber = Number(attr(openTag, "r")) || rows.length + 1;
    if (rowNumber > MAX_ROWS) {
      truncated = true;
      continue;
    }
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[2])) !== null) {
      const tag = `<c${cellMatch[1]}>`;
      const ref = attr(tag, "r") ?? "";
      const letters = /([A-Z]+)(\d+)/i.exec(ref);
      if (!letters) continue;
      const column = columnNumber(letters[1]);
      if (column < 0 || column >= MAX_COLUMNS) {
        truncated = true;
        continue;
      }
      usedColumns.add(column);
      const styleIndex = Number(attr(tag, "s"));
      let value = cellMatch[2] ? cellText(tag, cellMatch[2], sharedStrings) : "";
      const style = styles[styleIndex];
      const numeric = /^-?\d+(?:\.\d+)?$/.test(value);
      if (style?.date && numeric) value = excelDate(value);
      else if (style?.code?.includes("%") && numeric) {
        const percent = Number(value) * 100;
        const decimals = (style.code.match(/0\.(0+)%/) || [])[1]?.length ?? 0;
        value = `${percent.toFixed(decimals)}%`;
      }
      if (value.length > MAX_CELL) {
        value = value.slice(0, MAX_CELL) + "…";
        truncated = true;
      }
      while (cells.length <= column) cells.push("");
      cells[column] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  const columns = usedColumns.size ? Math.max(...usedColumns) + 1 : rows.reduce((n, row) => Math.max(n, row.length), 0);
  return { rows, columns, truncated };
}

export function normalizeZipPath(target) {
  const parts = String(target ?? "").replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  let path = stack.join("/");
  if (!path.startsWith("xl/")) path = `xl/${path}`;
  return path;
}

export function parseWorkbookPackage({ workbookXml, relsXml, sharedStringsXml, stylesXml, sheetXmls, maxSheets = 6 }) {
  const sheetRefs = parseWorkbookXml(workbookXml);
  const targets = parseRelationshipsXml(relsXml);
  const shared = parseSharedStringsXml(sharedStringsXml);
  const styles = parseStylesXml(stylesXml);
  const sheets = [];
  for (let index = 0; index < sheetRefs.length && index < maxSheets; index += 1) {
    const ref = sheetRefs[index];
    const target = normalizeZipPath(targets[ref.rid] || `worksheets/sheet${index + 1}.xml`);
    const xml = sheetXmls[target];
    if (!xml) {
      sheets.push({ name: ref.name, rows: [], columns: 0, truncated: false });
      continue;
    }
    const parsed = parseSheetXml(xml, shared, styles);
    sheets.push({ name: ref.name, ...parsed });
  }
  return { sheets, truncated: sheetRefs.length > maxSheets };
}

export function workbookTable(sheet) {
  if (!sheet) return { rows: [], columns: 0, truncated: false };
  return { rows: sheet.rows ?? [], columns: sheet.columns ?? 0, truncated: sheet.truncated === true };
}
