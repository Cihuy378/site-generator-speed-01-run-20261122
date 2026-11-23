// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree
// the reference generator builds for one site, byte for byte, but faster.
// Written from scratch against the reference semantics. The speed comes from
// batching plain text instead of escaping one character at a time, dispatching
// Markdown lines by their first character, slicing front-matter bodies instead
// of splitting and re-joining them, and rendering templates from flat op lists
// into an output array. Nothing is kept from one case to the next: every cache
// below lives inside a single run() call.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_SCAN = /[&<>"']/g;
const MARK_STRIP = /\p{M}/gu;

const WS_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_ASCII[c] = 1;

/** Whether a UTF-16 code unit is JavaScript whitespace (\s), for word and tag checks. */
function isSpaceCode(c) {
  if (c < 128) return WS_ASCII[c] === 1;
  return (
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 ||
    c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The HTML escape table, applied in one scan: untouched text is returned as-is. */
function escapeText(s) {
  ESCAPE_SCAN.lastIndex = 0;
  let m = ESCAPE_SCAN.exec(s);
  if (m === null) return s;
  let out = '';
  let last = 0;
  do {
    out += s.slice(last, m.index);
    out += ESCAPE_MAP[m[0]];
    last = m.index + 1;
    m = ESCAPE_SCAN.exec(s);
  } while (m !== null);
  return out + s.slice(last);
}

/** The slug of already-normalised, mark-free text: alphanumerics kept, other runs one "-". */
function slugFromPlain(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  let end = out.length > 64 ? 64 : out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** A slug, cached per case; pure-ASCII text skips normalisation (NFKD is identity there). */
function slugOf(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  const slug = ascii ? slugFromPlain(text) : slugFromPlain(text.normalize('NFKD').replace(MARK_STRIP, ''));
  cache.set(text, slug);
  return slug;
}

/** A slug made unique in its directory: the first of slug, slug-2, slug-3 ... still free. */
function claimSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, cached per case: "2026-11-09" is "9 November 2026". */
function dateWords(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const words = `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, words);
  return words;
}

/** A body's word count: runs of non-whitespace, counted without building a match array. */
function countWords(text) {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space = c < 128 ? WS_ASCII[c] === 1 : isSpaceCode(c);
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}

/** A link target's directory part resolved against a source's directory, or null past the root. */
function joinLinkPath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether a target opens on a scheme ("https:", "mailto:", ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) continue;
    return false;
  }
  return false;
}

// ---------------------------------------------------------------- front matter

const KNOWN_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of a month by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}

/** A quoted or bare string value, or its refusal reason. */
function readString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return 'a quoted string is not closed';
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        if (i + 1 === raw.length - 1) return 'a quoted string holds an escape other than \\" or \\\\';
        const n = raw[i + 1];
        if (n !== '"' && n !== '\\') return 'a quoted string holds an escape other than \\" or \\\\';
        out += n;
        i++;
      } else if (c === '"') return 'a quoted string holds a stray quote';
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return 'a bare string opens on [';
  return { value: raw };
}

/** One key's value, or its refusal reason (a string) / the value ({ value }). */
function readValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = readString(raw);
    return typeof s === 'string' ? `key "${key}": ${s}` : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    let y = 0;
    let mo = 0;
    let d = 0;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) {
          ok = false;
          break;
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
      }
    }
    return ok ? { value: raw } : 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return 'key "tags": not a list [a, b]';
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) {
      tags[i] = tags[i].trim();
      const t = tags[i];
      if (t === '') return 'key "tags": an empty tag, or one holding " [ or ]';
      for (let j = 0; j < t.length; j++) {
        const c = t.charCodeAt(j);
        if (c === 34 || c === 91 || c === 93) return 'key "tags": an empty tag, or one holding " [ or ]';
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return 'key "draft": true or false';
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
    }
    return ok ? { value: raw } : 'key "layout": not a template name';
  }
  // slug: lowercase alphanumerics, single "-" between, at most 64 characters.
  let ok = raw.length >= 1 && raw.length <= 64;
  if (ok) {
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
      if (alnum) continue;
      if (c !== 45 || i === 0 || i === raw.length - 1 || raw.charCodeAt(i - 1) === 45) {
        ok = false;
        break;
      }
    }
  }
  return ok ? { value: raw } : 'key "slug": not a slug';
}

/**
 * A source's front matter and body, or its refusal reason. The closing "---"
 * is found first: an unclosed header is refused as unclosed whatever its
 * lines hold. The body is sliced out of the text, never split and re-joined.
 */
function parseHeader(text) {
  const firstBreak = text.indexOf('\n');
  const first = firstBreak === -1 ? text : text.slice(0, firstBreak);
  if (first !== '---') return { error: 'no front matter' };
  if (firstBreak === -1) return { error: 'the front matter is not closed' };
  let closeStart = -1;
  let at = firstBreak;
  for (;;) {
    const hit = text.indexOf('\n---', at);
    if (hit === -1) break;
    const after = hit + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = hit + 1;
      break;
    }
    at = hit + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let start = firstBreak + 1;
  let lineNo = 2;
  while (start < closeStart) {
    const br = text.indexOf('\n', start);
    const line = text.slice(start, br);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length && isKeyChar(line.charCodeAt(k))) k++;
      let raw = null;
      if (k > 0 && line.charCodeAt(k) === 58) {
        if (k + 1 === line.length) raw = '';
        else if (line.charCodeAt(k + 1) === 32) {
          let e = line.length;
          while (e > k + 2 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
          raw = line.slice(k + 2, e);
        }
      }
      if (raw === null) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      if (!KNOWN_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = readValue(key, raw);
      if (typeof v === 'string') return { error: v };
      data[key] = v.value;
    }
    start = br + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyAt = closeStart + 3;
  return { data, body: bodyAt === text.length ? '' : text.slice(bodyAt + 1) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE_CODES = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE_CODES[c] = 1;

// Inline dispatch by code unit: 0 plain, 1 backslash, 2 backtick, 3 star, 4 "[", 5 HTML escape.
const INLINE_KIND = new Uint8Array(128);
INLINE_KIND[92] = 1;
INLINE_KIND[96] = 2;
INLINE_KIND[42] = 3;
INLINE_KIND[91] = 4;
INLINE_KIND[38] = 5;
INLINE_KIND[60] = 5;
INLINE_KIND[62] = 5;
INLINE_KIND[34] = 5;
INLINE_KIND[39] = 5;

/** Whether a line holds only spaces and tabs (or nothing). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Spaces and tabs dropped at both ends of a line. */
function trimEnds(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A fence opener's language ("" when none), or null when the line opens no fence. */
function fenceLanguage(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let k = i; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether a line closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth (1-6), or 0 when it is no heading: empty text, 7+ "#". */
function headingDepth(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return 0;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return 0;
  let s = h;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return e === s ? 0 : h;
}

/** A heading line's text, its depth already known. */
function headingText(line, depth) {
  let s = depth;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

/** Whether a line is a thematic break: "---" or "***", then spaces or tabs only. */
function isBreakLine(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let k = 3; k < line.length; k++) {
    const d = line.charCodeAt(k);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Whether a line ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return fenceLanguage(line) !== null;
  if (c === 35) return headingDepth(line) !== 0;
  if (c === 45 || c === 42) return isBreakLine(line);
  return false;
}

/** An ordered-list opener's start number and item text, or null. At most 9 digits. */
function orderedParts(line) {
  let d = 0;
  while (d < line.length && d < 9) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0) return null;
  if (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isSpaceCode(line.charCodeAt(k));
}

/**
 * The first unescaped `what` at or after `from`, or -1. A match counts as
 * escaped exactly when an odd run of backslashes stands right before it.
 */
function findCloser(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    let k = j - 1;
    while (k >= from && s.charCodeAt(k) === 92) {
      b++;
      k--;
    }
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first lone unescaped "*" at or after `from` (never one of a "**" pair), or -1. */
function findLoneStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    let k = j - 1;
    while (k >= from && s.charCodeAt(k) === 92) {
      b++;
      k--;
    }
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether a string holds any whitespace. */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isSpaceCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * Inline rendering, left to right: backslash escapes, code spans, strong,
 * emphasis and links, everything else escaped. Plain runs are sliced out
 * whole instead of copied one character at a time.
 */
function renderInline(s, link, slugCache) {
  let out = '';
  let i = 0;
  const n = s.length;
  let plain = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    const kind = c < 128 ? INLINE_KIND[c] : 0;
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const d = i + 1 < n ? s.charCodeAt(i + 1) : -1;
      if (d !== -1 && d < 128 && ESCAPABLE_CODES[d] === 1) {
        if (i > plain) out += s.slice(plain, i);
        out += d === 62 ? '&gt;' : s[i + 1];
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (kind === 2) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out += s.slice(plain, i);
        out += `<code>${escapeText(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (kind === 3) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findCloser(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) out += s.slice(plain, i);
          out += `<strong>${renderInline(s.slice(i + 2, j), link, slugCache)}</strong>`;
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findLoneStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) out += s.slice(plain, i);
        out += `<em>${renderInline(s.slice(i + 1, j), link, slugCache)}</em>`;
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (kind === 4) {
      const k = findCloser(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWhitespace(target)) {
        if (i > plain) out += s.slice(plain, i);
        out += `<a href="${escapeText(link(target))}">${renderInline(s.slice(i + 1, k), link, slugCache)}</a>`;
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (i > plain) out += s.slice(plain, i);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    i++;
    plain = i;
  }
  if (n > plain) out += s.slice(plain, n);
  return out;
}

/**
 * A body rendered: its HTML (every block followed by "\n"), its table of
 * contents (level 2 and 3 headings) and its excerpt (the first paragraph).
 */
function renderBody(src, link, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  let html = '';
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const first = line.length === 0 ? -1 : line.charCodeAt(0);
    if (first === -1) {
      i++;
      continue;
    }
    if (first === 32 || first === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (first === 96) {
      const lang = fenceLanguage(line);
      if (lang !== null) {
        i++;
        let j = i;
        while (j < n && !isFenceClose(lines[j])) j++;
        const body = j === i ? '' : `${escapeText(lines.slice(i, j).join('\n'))}\n`;
        html += lang === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${lang}">${body}</code></pre>\n`;
        i = j + 1;
        continue;
      }
    } else if (first === 35) {
      const depth = headingDepth(line);
      if (depth !== 0) {
        const text = headingText(line, depth);
        const id = claimSlug(slugOf(text, slugCache), ids);
        const inner = renderInline(text, link, slugCache);
        html += `<h${depth} id="${id}">${inner}</h${depth}>\n`;
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: inner });
        i++;
        continue;
      }
    } else if (first === 45 || first === 42) {
      if (isBreakLine(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const items = [];
        while (i < n) {
          const cur = lines[i];
          if ((cur.charCodeAt(0) === 45 || cur.charCodeAt(0) === 42) && cur.charCodeAt(1) === 32) {
            items.push([trimEnds(cur.slice(2))]);
            i++;
          } else if (isContinued(cur)) {
            items[items.length - 1].push(trimEnds(cur));
            i++;
          } else break;
        }
        let list = '<ul>\n';
        for (let k = 0; k < items.length; k++) list += `<li>${renderInline(items[k].join('\n'), link, slugCache)}</li>\n`;
        html += `${list}</ul>\n`;
        continue;
      }
    } else if (first === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let q = lines[i].slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        q = trimEnds(q);
        if (q !== '') kept.push(q);
        i++;
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${renderInline(kept.join('\n'), link, slugCache)}</p>\n</blockquote>\n`;
      continue;
    } else if (first >= 48 && first <= 57) {
      const ordered = orderedParts(line);
      if (ordered !== null) {
        const items = [];
        while (i < n) {
          const cur = lines[i];
          const o = orderedParts(cur);
          if (o !== null) {
            items.push([trimEnds(o.text)]);
            i++;
          } else if (isContinued(cur)) {
            items[items.length - 1].push(trimEnds(cur));
            i++;
          } else break;
        }
        const open = ordered.start !== 1 ? `<ol start="${ordered.start}">` : '<ol>';
        let list = `${open}\n`;
        for (let k = 0; k < items.length; k++) list += `<li>${renderInline(items[k].join('\n'), link, slugCache)}</li>\n`;
        html += `${list}</ol>\n`;
        continue;
      }
    }
    const parts = [trimEnds(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) parts.push(trimEnds(lines[i++]));
    const inner = renderInline(parts.join('\n'), link, slugCache);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

// Op codes of a compiled template. Text and values carry their payload; an if
// carries its branches; a for carries its body; an include carries its name.
const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_IF = 3;
const OP_FOR = 4;
const OP_INCLUDE = 5;
const MAX_INCLUDE = 8;

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** Whether a trimmed string is a dotted path; its segments, or null. */
function splitPath(text) {
  if (text === '') return null;
  const parts = text.split('.');
  for (let p = 0; p < parts.length; p++) {
    const seg = parts[p];
    if (seg === '' || !isNameStart(seg.charCodeAt(0))) return null;
    for (let i = 1; i < seg.length; i++) if (!isNameChar(seg.charCodeAt(i))) return null;
  }
  return parts;
}

/** Whether a string holds any whitespace character. */
function hasAnySpace(s) {
  for (let i = 0; i < s.length; i++) if (isSpaceCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * A template compiled to ops, or { error } naming why it does not parse.
 * A {% %} tag alone on its line takes the whole line with it, newline included.
 */
function compileTemplate(name, src) {
  const fail = (why) => ({ error: `template "${name}": ${why}` });
  const root = [];
  const stack = [{ ops: root, kind: 'root' }];
  let body = root;
  let text = '';
  let i = 0;
  const pushText = () => {
    if (text !== '') {
      body.push([OP_TEXT, text]);
      text = '';
    }
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) return fail(raw ? 'a {{{ is not closed' : 'a {{ is not closed');
      const pathText = src.slice(open + (raw ? 3 : 2), close).trim();
      const path = splitPath(pathText);
      if (path === null) return fail(`${JSON.stringify(pathText)} is not a path`);
      pushText();
      body.push([raw ? OP_RAW : OP_VAR, path]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) return fail('a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        standalone = false;
        break;
      }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          standalone = false;
          break;
        }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    if (tag.startsWith('for ')) {
      let p = 4;
      if (p >= tag.length || !isNameStart(tag.charCodeAt(p))) return fail(`{% ${tag} %} is not a tag`);
      const varStart = p;
      p++;
      while (p < tag.length && isNameChar(tag.charCodeAt(p))) p++;
      const varName = tag.slice(varStart, p);
      if (tag.slice(p, p + 4) !== ' in ') return fail(`{% ${tag} %} is not a tag`);
      const pathText = tag.slice(p + 4);
      if (pathText === '' || hasAnySpace(pathText)) return fail(`{% ${tag} %} is not a tag`);
      const path = splitPath(pathText);
      if (path === null) return fail(`${JSON.stringify(pathText)} is not a path`);
      const node = [OP_FOR, varName, path, []];
      body.push(node);
      stack.push({ ops: node[3], kind: 'for', node });
      body = node[3];
    } else if (tag.startsWith('if ')) {
      let rest = tag.slice(3);
      let not = false;
      if (rest.startsWith('not ')) {
        not = true;
        rest = rest.slice(4);
      }
      if (rest === '' || hasAnySpace(rest)) return fail(`{% ${tag} %} is not a tag`);
      const path = splitPath(rest);
      if (path === null) return fail(`${JSON.stringify(rest)} is not a path`);
      const node = [OP_IF, not, path, [], null];
      body.push(node);
      stack.push({ ops: node[3], kind: 'if', node });
      body = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.node[4] !== null) return fail('an else outside an if');
      top.node[4] = [];
      top.ops = top.node[4];
      body = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) return fail(`an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.ops : parent.kind === 'for' ? parent.node[3] : parent.node[4] ?? parent.node[3];
    } else if (tag.startsWith('include "') && tag.endsWith('"') && tag.length > 10) {
      const inc = tag.slice(9, -1);
      let ok = inc.length > 0;
      for (let q = 0; ok && q < inc.length; q++) {
        const c = inc.charCodeAt(q);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      if (!ok) return fail(`{% ${tag} %} is not a tag`);
      body.push([OP_INCLUDE, inc]);
    } else return fail(`{% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText();
  if (stack.length > 1) return fail(`a ${stack[stack.length - 1].kind} is not closed`);
  return { ops: root, fn: compileFunction(root) };
}

/** A value at a path in the scope chain: first name from the nearest frame holding it. */
function lookupPath(frames, path) {
  const first = path[0];
  let v;
  let found = false;
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, first)) {
      v = vars[first];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: strings, numbers and booleans as themselves, arrays joined by ", ". */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += valueText(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or []. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Compiled ops rendered into `out`, in scope `frames`, includes capped at 8 deep. */
function renderOps(ops, frames, templates, depth, out) {
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    const kind = op[0];
    if (kind === OP_TEXT) {
      out.push(op[1]);
      continue;
    }
    if (kind === OP_VAR || kind === OP_RAW) {
      const text = valueText(lookupPath(frames, op[1]));
      out.push(kind === OP_VAR ? escapeText(text) : text);
      continue;
    }
    if (kind === OP_IF) {
      const branch = isTruthy(lookupPath(frames, op[2])) !== op[1] ? op[3] : op[4];
      if (branch !== null) renderOps(branch, frames, templates, depth, out);
      continue;
    }
    if (kind === OP_FOR) {
      const xs = lookupPath(frames, op[2]);
      if (!Array.isArray(xs)) continue;
      const loop = { index: 0, first: false, last: false, length: xs.length };
      const frame = Object.create(null);
      frame.loop = loop;
      const varName = op[1];
      frames.push(frame);
      for (let xi = 0; xi < xs.length; xi++) {
        if (varName !== 'loop') frame[varName] = xs[xi];
        loop.index = xi + 1;
        loop.first = xi === 0;
        loop.last = xi === xs.length - 1;
        renderOps(op[3], frames, templates, depth, out);
      }
      frames.pop();
      continue;
    }
    const target = templates.get(op[1]);
    if (target !== undefined && depth < MAX_INCLUDE) renderOps(target.ops, frames, templates, depth + 1, out);
  }
}

/** Compiled ops rendered to a string (the interpreter path, used on fallback). */
function renderOpsToString(ops, frames, templates, depth) {
  const out = [];
  renderOps(ops, frames, templates, depth, out);
  return out.join('');
}

/** Helpers shared by compiled templates: escape, text, lookup, truthiness, includes. */
const TPL_HELPERS = {
  esc: escapeText,
  txt: valueText,
  lk: lookupPath,
  tru: isTruthy,
  inc(templates, name, frames, depth) {
    if (depth >= MAX_INCLUDE) return '';
    const t = templates.get(name);
    if (t === undefined) return '';
    return t.fn !== null ? t.fn(frames, templates, depth + 1, TPL_HELPERS) : renderOpsToString(t.ops, frames, templates, depth + 1);
  },
};

/** One op list compiled to a function body: string appends, lookups, loops, includes. */
function codegenOps(ops, parts) {
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    const kind = op[0];
    if (kind === OP_TEXT) {
      parts.push(`o+=${JSON.stringify(op[1])};`);
      continue;
    }
    if (kind === OP_VAR) {
      parts.push(`o+=H.esc(H.txt(H.lk(frames,${JSON.stringify(op[1])})));`);
      continue;
    }
    if (kind === OP_RAW) {
      parts.push(`o+=H.txt(H.lk(frames,${JSON.stringify(op[1])}));`);
      continue;
    }
    if (kind === OP_IF) {
      parts.push(`if(H.tru(H.lk(frames,${JSON.stringify(op[2])}))!==${op[1] ? 'true' : 'false'}){`);
      codegenOps(op[3], parts);
      if (op[4] !== null) {
        parts.push('}else{');
        codegenOps(op[4], parts);
      }
      parts.push('}');
      continue;
    }
    if (kind === OP_FOR) {
      parts.push(`{const xs=H.lk(frames,${JSON.stringify(op[2])});if(Array.isArray(xs)){const lp={index:0,first:false,last:false,length:xs.length};const fr=Object.create(null);fr.loop=lp;frames.push(fr);for(let k=0;k<xs.length;k++){`);
      if (op[1] !== 'loop') parts.push(`fr[${JSON.stringify(op[1])}]=xs[k];`);
      parts.push('lp.index=k+1;lp.first=k===0;lp.last=k===xs.length-1;');
      codegenOps(op[3], parts);
      parts.push('}frames.pop();}}');
      continue;
    }
    parts.push(`o+=H.inc(templates,${JSON.stringify(op[1])},frames,depth);`);
  }
}

/** A compiled template function, or null when code generation is unavailable. */
function compileFunction(ops) {
  try {
    const parts = ['let o="";'];
    codegenOps(ops, parts);
    parts.push('return o;');
    return new Function('frames', 'templates', 'depth', 'H', parts.join(''));
  } catch {
    return null;
  }
}

/** A template entry rendered: its compiled function, or the interpreter on fallback. */
function renderEntry(entry, frames, templates) {
  return entry.fn !== null ? entry.fn(frames, templates, 0, TPL_HELPERS) : renderOpsToString(entry.ops, frames, templates, 0);
}

// ---------------------------------------------------------------- the build

const OWN_DIRS = ['tags', 'page'];
const RESERVED_ROOT = ['posts', 'tags', 'page'];

/** The directory of a path ("" at the root). */
function dirOfPath(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Trailing slashes dropped from a base URL. */
function stripBase(base) {
  let e = base.length;
  while (e > 0 && base.charCodeAt(e - 1) === 47) e--;
  return base.slice(0, e);
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort();
  for (let n = 0; n < names.length; n++) {
    const compiled = compileTemplate(names[n], input.templates[names[n]]);
    if ('error' in compiled) report.push(compiled.error);
    else templates.set(names[n], compiled);
  }
  const base = stripBase(input.site.base_url);

  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    if (file.path.endsWith('.md')) {
      const raw = file.content;
      sources.push({ path: file.path, text: raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n') });
    } else statics.push(file);
  }

  const kept = [];
  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    const fm = parseHeader(src.text);
    if ('error' in fm) {
      report.push(`refused ${src.path}: ${fm.error}`);
      continue;
    }
    const post = src.path.startsWith('posts/');
    let own = null;
    for (let d = 0; d < OWN_DIRS.length; d++) {
      if (src.path.startsWith(`${OWN_DIRS[d]}/`)) {
        own = OWN_DIRS[d];
        break;
      }
    }
    if (own !== null) {
      report.push(`refused ${src.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(fm.data, 'date')) {
      report.push(`refused ${src.path}: a post needs a date`);
      continue;
    }
    const layout = fm.data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${src.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (fm.data.draft === true) {
      report.push(`draft ${src.path}`);
      continue;
    }
    src.data = fm.data;
    src.body = fm.body;
    src.post = post;
    src.layout = layout;
    kept.push(src);
  }

  const takenByDir = new Map();
  const bySource = new Map();
  for (let s = 0; s < kept.length; s++) {
    const src = kept[s];
    const dir = src.post ? 'posts' : dirOfPath(src.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_ROOT : []);
      takenByDir.set(dir, taken);
    }
    const slug = claimSlug(src.data.slug ?? slugOf(src.data.title, slugCache), taken);
    src.slug = slug;
    src.outDir = dir === '' ? slug : `${dir}/${slug}`;
    src.url = `${base}/${src.outDir}/`;
    bySource.set(src.path, src);
  }

  const staticPaths = new Set();
  for (let f = 0; f < statics.length; f++) staticPaths.add(statics[f].path);
  const broken = new Set();
  for (let s = 0; s < kept.length; s++) {
    const src = kept[s];
    const dirParts = dirOfPath(src.path);
    const parts = dirParts === '' ? [] : dirParts.split('/');
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : joinLinkPath(parts, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${src.path} -> ${target}`);
      return target;
    };
    const md = renderBody(src.body, link, slugCache);
    src.html = md.html;
    src.toc = md.toc;
    src.excerpt = md.excerpt;
  }

  const posts = [];
  for (let s = 0; s < kept.length; s++) if (kept[s].post) posts.push(kept[s]);
  posts.sort((x, y) => {
    if (x.data.date !== y.data.date) return x.data.date < y.data.date ? 1 : -1;
    return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
  });
  for (let p = 0; p < posts.length; p++) {
    posts[p].newer = p === 0 ? null : posts[p - 1];
    posts[p].older = p === posts.length - 1 ? null : posts[p + 1];
  }

  const tagsBySlug = new Map();
  for (let p = 0; p < posts.length; p++) {
    const post = posts[p];
    post.tagRefs = [];
    const seen = new Set();
    const namesOf = post.data.tags ?? [];
    for (let t = 0; t < namesOf.length; t++) {
      const slug = slugOf(namesOf[t], slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = tagsBySlug.get(slug);
      if (tag === undefined) {
        tag = { name: namesOf[t], slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagsBySlug.set(slug, tag);
      }
      tag.posts.push(post);
      post.tagRefs.push(tag);
    }
  }
  for (let s = 0; s < kept.length; s++) {
    const src = kept[s];
    if (src.post) continue;
    src.tagRefs = [];
    const seen = new Set();
    const namesOf = src.data.tags ?? [];
    for (let t = 0; t < namesOf.length; t++) {
      const slug = slugOf(namesOf[t], slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      src.tagRefs.push(tagsBySlug.get(slug) ?? { name: namesOf[t], slug, url: '', posts: [] });
    }
  }
  const tags = [...tagsBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  const linkView = (src) =>
    src === null
      ? null
      : {
          title: src.data.title,
          url: src.url,
          date: src.data.date ?? '',
          date_long: src.data.date === undefined ? '' : dateWords(src.data.date, dateCache),
        };
  for (let s = 0; s < kept.length; s++) {
    const src = kept[s];
    const cardTags = [];
    for (let t = 0; t < src.tagRefs.length; t++) {
      const tag = src.tagRefs[t];
      cardTags.push({ name: tag.name, slug: tag.slug, url: tag.url });
    }
    const card = {
      title: src.data.title,
      url: src.url,
      date: src.data.date ?? '',
      date_long: src.data.date === undefined ? '' : dateWords(src.data.date, dateCache),
      summary: src.data.summary ?? '',
      excerpt: src.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(src.body) / 200)),
      tags: cardTags,
    };
    src.card = card;
    src.page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: src.slug,
      content: src.html,
      toc: src.toc,
      newer: src.post ? linkView(src.newer) : null,
      older: src.post ? linkView(src.older) : null,
      is_post: src.post,
    };
  }

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const shared = { site, tags: allTags, recent };
  const frames = [shared, null];
  const pageFrame = { page: null };
  const indexFrame = { posts: null, pager: null };
  const tagFrame = { tag: null };
  const output = {};
  for (let s = 0; s < kept.length; s++) {
    pageFrame.page = kept[s].page;
    frames[1] = pageFrame;
    output[`${kept[s].outDir}/index.html`] = renderEntry(templates.get(kept[s].layout), frames, templates);
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  const indexOps = templates.get('index');
  if (indexOps !== undefined) {
    for (let k = 1; k <= pageCount; k++) {
      const cards = [];
      const from = (k - 1) * per;
      const to = k * per < posts.length ? k * per : posts.length;
      for (let p = from; p < to; p++) cards.push(posts[p].card);
      frames[1] = indexFrame;
      indexFrame.posts = cards;
      indexFrame.pager = {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      };
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = renderEntry(indexOps, frames, templates);
    }
  }
  const tagOps = templates.get('tag');
  if (tagOps !== undefined) {
    for (let t = 0; t < tags.length; t++) {
      const tag = tags[t];
      tagFrame.tag = { name: tag.name, slug: tag.slug, url: tag.url, count: tag.posts.length, posts: tag.posts.map((p) => p.card) };
      frames[1] = tagFrame;
      output[`tags/${tag.slug}/index.html`] = renderEntry(tagOps, frames, templates);
    }
  }
  const tagsOps = templates.get('tags');
  if (tagsOps !== undefined) {
    frames.length = 1;
    output['tags/index.html'] = renderEntry(tagsOps, frames, templates);
  }
  for (let f = 0; f < statics.length; f++) {
    if (Object.hasOwn(output, statics[f].path)) report.push(`shadowed ${statics[f].path}: a built page has its path`);
    else output[statics[f].path] = statics[f].content;
  }

  const lines = [...report, ...broken].sort();
  let pageTotal = 0;
  for (let s = 0; s < kept.length; s++) if (!kept[s].post) pageTotal++;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
