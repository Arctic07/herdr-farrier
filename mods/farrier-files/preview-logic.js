// Pure preview helpers for farrier-files: delimited tables, SVG dimensions and
// raster image headers. No GPUI or Herdr imports.

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function utf8ToBase64(text) {
  const source = String(text ?? "");
  const bytes = [];
  for (let i = 0; i < source.length; i += 1) {
    let code = source.codePointAt(i);
    if (code > 0xffff) i += 1;
    if (code <= 0x7f) bytes.push(code);
    else if (code <= 0x7ff) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : BASE64[c & 63];
  }
  return out;
}

export function decodeBase64(text) {
  const raw = String(text ?? "").replace(/\s+/g, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "=") break;
    const value = BASE64.indexOf(c);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function u16be(bytes, offset) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes, offset) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32be(bytes, offset) {
  return ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
}

function i32le(bytes, offset) {
  const value = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

export function imageHeaderSize(bytes) {
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) return null;
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = u32be(bytes, 16);
    const height = u32be(bytes, 20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = u16le(bytes, 6);
    const height = u16le(bytes, 8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const width = Math.abs(i32le(bytes, 18));
    const height = Math.abs(i32le(bytes, 22));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      i += 2;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = u16be(bytes, i);
      if (length < 2) break;
      const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (sof) {
        const height = u16be(bytes, i + 3);
        const width = u16be(bytes, i + 5);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += length;
    }
    return null;
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const kind = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
    if (kind === "VP8X") {
      const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
      const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (kind === "VP8 ") {
      const width = (u16le(bytes, 26) & 0x3fff) || 0;
      const height = (u16le(bytes, 28) & 0x3fff) || 0;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (kind === "VP8L") {
      const b0 = bytes[21] ?? 0;
      const b1 = bytes[22] ?? 0;
      const b2 = bytes[23] ?? 0;
      const b3 = bytes[24] ?? 0;
      const b4 = bytes[25] ?? 0;
      const width = 1 + (((b0 & 0x3f) << 8) | b1);
      const height = 1 + (((b2 & 0x0f) << 10) | (b3 << 2) | (b4 >> 6));
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
  return null;
}

export function imageSizeFromBase64(text) {
  const bytes = decodeBase64(text);
  return bytes.length ? imageHeaderSize(bytes) : null;
}

export function parseSvgInfo(text) {
  const head = String(text ?? "").slice(0, 8192);
  const view = /viewBox\s*=\s*["']([^"']+)["']/i.exec(head);
  let viewBox = null;
  if (view) {
    const parts = view[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }
  const readNumber = (name) => {
    const match = new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(head);
    if (!match) return null;
    const number = parseFloat(match[1]);
    return Number.isFinite(number) && number > 0 && !match[1].includes("%") ? number : null;
  };
  const width = readNumber("width");
  const height = readNumber("height");
  const w = width ?? viewBox?.width ?? null;
  const h = height ?? viewBox?.height ?? null;
  if (!w || !h) return null;
  return { width: w, height: h, ratio: w / h, viewBox };
}

export function prepareSvgPreview(text, scale = 2) {
  const source = String(text ?? "");
  const info = parseSvgInfo(source);
  if (!info) return null;
  const open = /<svg\b[^>]*>/i.exec(source);
  if (!open) return null;
  const tag = open[0];
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const replaceAttr = (tagText, name, value) => {
    const re = new RegExp(`\\s${name}\\s*=\\s*["'][^"']*["']`, "i");
    if (re.test(tagText)) return tagText.replace(re, ` ${name}="${value}"`);
    return tagText.replace(/>$/, ` ${name}="${value}">`);
  };
  const next = replaceAttr(replaceAttr(tag, "width", width), "height", height);
  return { text: source.slice(0, open.index) + next + source.slice(open.index + tag.length), width, height, ratio: info.ratio };
}

export const ZOOM_LEVELS = [25, 50, 75, 100, 150, 200, 300, 400];

export function normalizeZoom(value) {
  if (ZOOM_LEVELS.includes(value)) return value;
  const number = Number(value);
  if (Number.isFinite(number)) return Math.max(25, Math.min(400, Math.round(number)));
  return 100;
}

export function stepZoom(current, direction) {
  const levels = ZOOM_LEVELS;
  let index = levels.findIndex((level) => level >= normalizeZoom(current));
  if (index < 0) index = levels.length - 1;
  if (direction > 0) index = Math.min(levels.length - 1, index + 1);
  else if (direction < 0) index = Math.max(0, index - 1);
  return levels[index];
}

function detectDelimiter(text) {
  const sample = String(text ?? "").slice(0, 4096);
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && counts[c] !== undefined) counts[c] += 1;
    else if (!quoted && c === "\n") break;
  }
  let best = ",";
  for (const key of Object.keys(counts)) if (counts[key] > counts[best]) best = key;
  return best;
}

export function parseDelimitedText(text, options = {}) {
  const source = String(text ?? "");
  const delimiter = options.delimiter ?? detectDelimiter(source);
  const maxRows = Number(options.maxRows) || 2000;
  const maxColumns = Number(options.maxColumns) || 100;
  const maxCell = Number(options.maxCell) || 500;
  let input = source;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  let ended = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > maxCell) {
      cell = cell.slice(0, maxCell) + "…";
      truncated = true;
    }
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    if (rows.length >= maxRows) {
      truncated = true;
      ended = true;
      return;
    }
    pushCell();
    if (row.length > maxColumns) {
      row = row.slice(0, maxColumns);
      truncated = true;
    }
    rows.push(row);
    row = [];
  };
  while (i < input.length && !ended) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i += 1;
    } else if (c === delimiter) {
      pushCell();
      i += 1;
    } else if (c === "\n") {
      pushRow();
      i += 1;
    } else if (c === "\r") {
      if (input[i + 1] === "\n") i += 2;
      else i += 1;
      pushRow();
    } else {
      cell += c;
      i += 1;
    }
  }
  if (!ended && (cell.length || row.length)) pushRow();
  const columns = rows.reduce((n, cells) => Math.max(n, cells.length), 0);
  return { rows, columns, delimiter, truncated };
}

export function formatCellCount(rows, columns) {
  return `${rows} row${rows === 1 ? "" : "s"} · ${columns} column${columns === 1 ? "" : "s"}`;
}
