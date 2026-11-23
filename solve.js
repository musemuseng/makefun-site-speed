// Faster drop-in for makefun-site 1.0.0: run(input) returns byte-identical output trees.
// Single dependency-free ES module. All caches live inside one build() call (nothing is
// shared between cases). Semantics follow the reference implementation exactly; only the
// mechanics (allocation, per-character calls, repeated scans) are optimised.

/* ------------------------------------------------ text rules */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

// One regex scan, copying the plain spans between escapes in bulk (the same
// trick as the inline renderer); measurably faster than replace-with-callback.
// Runs to completion synchronously, so the shared regex is safe.
export function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(text);
  if (m === null) return text;
  let out = '';
  let i = 0;
  while (m !== null) {
    const j = m.index;
    if (j > i) out += text.slice(i, j);
    out += ESCAPES[m[0]];
    i = j + 1;
    ESC_RE.lastIndex = i;
    m = ESC_RE.exec(text);
  }
  if (i < text.length) out += text.slice(i);
  return out;
}

const SLUG_MAX = 64;

// Reference slugify, kept verbatim for the non-ASCII path (NFKD + mark dropping is the
// sandbox Node's, exactly as the reference does it).
function slugifyRef(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// ASCII fast path: NFKD is the identity on ASCII and no ASCII char is a combining mark,
// so the reference result is the runs of [a-z0-9] in the lowercased text joined by '-'.
// toLowerCase and the run scan both run in native code.
const SLUG_RUN = /[a-z0-9]+/g;
function slugifyAscii(text) {
  const runs = text.toLowerCase().match(SLUG_RUN);
  if (runs === null) return 'untitled';
  let out = runs.join('-').slice(0, SLUG_MAX);
  if (out.endsWith('-')) out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function isAscii(text) {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) return false;
  return true;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/* ------------------------------------------------ front matter */

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Splits a front-matter line into [key, rawValue] by hand (FM_LINE's equivalent:
// ^([a-z_]+):(?: (.*))?$), or returns null.
function fmSplit(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0 || line[i] !== ':') return null;
  if (i + 1 === n) return [line.slice(0, i), ''];
  if (line[i + 1] !== ' ') return null;
  return [line.slice(0, i), line.slice(i + 2)];
}

// { data, body } or { error }; walks lines by offset instead of split+join.
// Pass 1 finds the closing '---' line without slicing (three char codes and a
// length); pass 2 parses the lines in between, slicing each once.
function parseFrontMatter(text) {
  const len = text.length;
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? len : firstNl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  let bodyStart = -1;
  let closePos = -1;
  let pos = firstNl === -1 ? len : firstNl + 1;
  while (pos <= len) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      bodyStart = nl === -1 ? len : nl + 1;
      closePos = pos;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = firstNl === -1 ? len : firstNl + 1;
  let idx = 1; // line index of the line starting at pos (0-based; first line is 0)
  while (pos < closePos) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const line = text.slice(pos, end);
    idx++;
    pos = nl === -1 ? len : nl + 1;
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const kv = fmSplit(line);
    if (kv === null) return { error: `line ${idx} is not "key: value"` };
    const key = kv[0];
    let raw = kv[1];
    let e = raw.length;
    while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

/* ------------------------------------------------ markdown */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_SPECIAL = /[\\`*\[&<>"']/;
const WS_TEST = /\s/;

// The left-to-right scanner of the reference skips the character after a
// backslash when that character is escapable. A position j is therefore
// visited by the scanner unless it is covered by such a skip, which happens
// exactly when the run of backslashes immediately before j (not reaching
// back before `from`) has odd length: the scanner enters the run at its
// first backslash (nothing before it can skip it) and steps two at a time
// through the run, since every character inside the run, and the one the
// search is looking for ('*' or ']', both escapable), can follow a backslash.
// So occurrences can be found with indexOf and filtered by that parity.
function isSkipped(s, j, from) {
  let run = 0;
  for (let p = j - 1; p >= from && s[p] === '\\'; p--) run++;
  return (run & 1) === 1;
}

// Bounded variants: the occurrence must fit inside [from, hi), exactly as if
// the search ran on the substring s.slice(lo, hi) (see inlineInto below).
function findUnescaped(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= hi) {
    if (!isSkipped(s, j, from)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    if (!isSkipped(s, j, from)) {
      if (j + 1 < hi && s[j + 1] === '*') {
        j = s.indexOf('*', j + 2);
        continue;
      }
      return j;
    }
    j = s.indexOf('*', j + 1);
  }
  return -1;
}

// escapeHtml over the range [lo, hi) of s, appending pieces to out.
function escapeInto(s, lo, hi, out) {
  ESC_RE.lastIndex = lo;
  let m = ESC_RE.exec(s);
  if (m === null || m.index >= hi) {
    if (hi > lo) out.push(s.slice(lo, hi));
    return;
  }
  let i = lo;
  while (m !== null && m.index < hi) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    out.push(ESCAPES[m[0]]);
    i = j + 1;
    ESC_RE.lastIndex = i;
    m = ESC_RE.exec(s);
  }
  if (i < hi) out.push(s.slice(i, hi));
}

// Inline rendering: same left-to-right rules as the reference, but the scan jumps
// from special character to special character (one regex pass, in native code) and
// copies the plain spans between them in bulk: they hold no character that
// escaping would change. Nested constructs render into the same output array
// over index ranges of the original string, so no substring is ever built for
// them; the shared regex's lastIndex is reset before every exec, which is all
// the discipline the recursion needs.
const NEXT_SPECIAL = /[\\`*\[&<>"']/g;

function inlineInto(s, lo, hi, env, out) {
  NEXT_SPECIAL.lastIndex = lo;
  let m = NEXT_SPECIAL.exec(s);
  if (m === null || m.index >= hi) {
    if (hi > lo) out.push(lo === 0 && hi === s.length ? s : s.slice(lo, hi));
    return;
  }
  let i = lo;
  while (m !== null && m.index < hi) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        const e = ESCAPES[s[i + 1]];
        out.push(e === undefined ? s[i + 1] : e);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        out.push('<code>');
        escapeInto(s, i + 1, k, out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
    } else if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, hi);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s, i + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1, hi);
        if (k > i + 1) {
          out.push('<em>');
          inlineInto(s, i + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      if (q >= hi) q = -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !WS_TEST.test(target)) {
        out.push('<a href="' + escapeHtml(env.link(target)) + '">');
        inlineInto(s, i + 1, k, env, out);
        out.push('</a>');
        i = q + 1;
      } else {
        out.push('[');
        i++;
      }
    } else {
      // One of & < > " ' (the only remaining specials).
      out.push(ESCAPES[c]);
      i++;
    }
    NEXT_SPECIAL.lastIndex = i;
    m = NEXT_SPECIAL.exec(s);
  }
  if (i < hi) out.push(s.slice(i, hi));
}

function inline(s, env) {
  if (!INLINE_SPECIAL.test(s)) return s;
  const out = [];
  inlineInto(s, 0, s.length, env, out);
  return out.join('');
}

/* Line classifiers: hand-written equivalents of the reference's regexes. */

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 43 || code === 45;
}

// The fence language if `line` opens a fence, else null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const langEnd = i;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? line.slice(3, langEnd) : null;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// { depth, text } or null.
function headingOf(line) {
  if (line[0] !== '#') return null;
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n > 6) return null;
  if (n === line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let s = n;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  let e = line.length;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === s) return null;
  return { depth: n, text: line.slice(s, e) };
}

function isHr(line) {
  const c = line[0];
  if ((c !== '-' && c !== '*') || line[1] !== c || line[2] !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

// Bullet item text or null.
function bulletText(line) {
  const c = line[0];
  return (c === '-' || c === '*') && line[1] === ' ' ? line.slice(2) : null;
}

// { start, text } or null.
function orderedText(line) {
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i < line.length && !WS_TEST.test(line[i]);
}

function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line[s] === ' ' || line[s] === '\t')) s++;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

// headingOf without the object allocation and the slice, for endsParagraph.
function isHeading(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n > 6) return false;
  if (n === line.length || (line[n] !== ' ' && line[n] !== '\t')) return false;
  let s = n;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  let e = line.length;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return e > s;
}

function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line[0];
  if (c0 === '`') return fenceLang(line) !== null;
  if (c0 === '#') return isHeading(line);
  if (c0 === '-' || c0 === '*') return isHr(line);
  if (c0 === ' ' || c0 === '\t') return isBlank(line);
  return false;
}

// Renders Markdown in one pass (the reference lexes into tokens, then renders them;
// fusing the two changes no output). slug is the case's memoised slugify.
function renderMarkdown(src, env, slug) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let out = '';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    // Block kinds are told apart by their first character (a fence needs a
    // backtick, a heading #, a break - or *, a quote >, a list item - * or a
    // digit); the checks below keep the reference's order within each letter.
    const c0 = line[0];
    if (c0 === '`') {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const parts = [];
        while (i < n && !isFenceClose(lines[i])) {
          parts.push(escapeHtml(lines[i]));
          i++;
        }
        i++;
        const body = parts.length === 0 ? '' : parts.join('\n') + '\n';
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        out += `<pre><code${cls}>${body}</code></pre>\n`;
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slug(heading.text), ids);
        const html = inline(heading.text, env);
        out += `<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(line)) {
        out += '<hr>\n';
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let s = lines[i].slice(1);
        if (s[0] === ' ') s = s.slice(1);
        const t = trimLine(s);
        if (t !== '') body.push(t);
        i++;
      }
      out += body.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    } else if (c0 === ' ' || c0 === '\t') {
      if (isBlank(line)) {
        i++;
        continue;
      }
    }
    const bt = c0 === '-' || c0 === '*' ? bulletText(line) : null;
    const ot = bt === null && c0 >= '0' && c0 <= '9' ? orderedText(line) : null;
    if (bt !== null || ot !== null) {
      const ordered = ot !== null;
      const start = ordered ? ot.start : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const t = ordered ? orderedText(l) : bulletText(l);
        if (t !== null) {
          items.push(trimLine(ordered ? t.text : t));
          i++;
        } else if (items.length > 0 && isContinued(l)) {
          items[items.length - 1] += '\n' + trimLine(l);
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let block = open + '\n';
      for (const item of items) block += `<li>${inline(item, env)}</li>\n`;
      out += block + `</${tag}>\n`;
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      text += '\n' + trimLine(lines[i]);
      i++;
    }
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`;
  }
  return { html: out, toc, excerpt: excerpt ?? '' };
}

/* ------------------------------------------------ templates */

const INCLUDE_DEPTH = 8;
const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const before = src.slice(lineStart, open);
    const after = src.slice(end, lineEnd);
    const standalone = isBlankLine(before) && isBlankLine(after);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: K_TEXT, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t === 'var' ? K_VAR : K_RAW, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: K_FOR, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: K_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== K_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? K_FOR : K_IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === K_FOR ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: K_INCLUDE, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === K_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  const k0 = path[0];
  while (s !== null && !Object.hasOwn(s.vars, k0)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[k0];
  if (path.length === 1) return v;
  if (path.length === 2) {
    const k1 = path[1];
    return v !== null && typeof v === 'object' && Object.hasOwn(v, k1) ? v[k1] : undefined;
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Node kinds as small ints, assigned in parseTemplate.
const K_TEXT = 0, K_VAR = 1, K_RAW = 2, K_IF = 3, K_FOR = 4, K_INCLUDE = 5;

// Renders into `out` (an array of strings) instead of concatenating at every node.
// ctx.templates maps a name to its parsed node tree. A for loop allocates one
// scope (and one loop object) per loop execution, not per item: the item
// variable and the loop fields are mutated between items, which no observer
// can tell apart from fresh objects because rendering is synchronous.
function renderInto(nodes, scope, ctx, depth, out) {
  const len = nodes.length;
  for (let idx = 0; idx < len; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case K_TEXT:
        out.s += n.text;
        break;
      case K_VAR: {
        const v = lookup(scope, n.path);
        out.s += (escapeHtml(typeof v === 'string' ? v : textOf(v)));
        break;
      }
      case K_RAW: {
        const v = lookup(scope, n.path);
        out.s += (typeof v === 'string' ? v : textOf(v));
        break;
      }
      case K_IF: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case K_FOR: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const count = xs.length;
        if (count === 0) break;
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: count };
        const child = { vars, parent: scope };
        const name = n.name;
        const body = n.body;
        for (let k = 0; k < count; k++) {
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === count - 1;
          vars[name] = xs[k];
          vars.loop = loop;
          renderInto(body, child, ctx, depth, out);
        }
        break;
      }
      case K_INCLUDE: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}



/* ------------------------------------------------ the build */

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Word count (runs of non-whitespace) without allocating the match array.
// The common case (an ASCII non-space) takes the shortest branch.
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 || (code >= 9 && code <= 13)) {
      inWord = false;
    } else if (code > 127 && WS_TEST.test(text[i])) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function run(input) {
  return build(input);
}

export function build(input) {
  // Per-case slug memo (tags and titles repeat a lot inside one case; never shared
  // across cases, so each case is still answered alone).
  const slugCache = new Map();
  const slug = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = isAscii(text) ? slugifyAscii(text) : slugifyRef(text);
      slugCache.set(text, v);
    }
    return v;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources in code-unit order; .md files are sources, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal checks, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown with link resolution. Resolutions repeat a lot inside one
  // case (the same target from many pages), so they are memoised per case;
  // the broken-link side effect is replayed from the memo on every call.
  const staticPaths = new Set(statics.map((f) => f.path));
  const linkMemo = new Map(); // dir -> Map<target, {url, broken}>
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirMemo = linkMemo.get(dir);
    if (dirMemo === undefined) {
      dirMemo = new Map();
      linkMemo.set(dir, dirMemo);
    }
    const env = {
      link: (target) => {
        if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35 || SCHEME.test(target)) return target;
        let r = dirMemo.get(target);
        if (r === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) r = { url: `${bySource.get(path).url}${frag}`, broken: false };
          else if (path !== null && staticPaths.has(path)) r = { url: `${base}/${path}${frag}`, broken: false };
          else r = { url: target, broken: true };
          dirMemo.set(target, r);
        }
        if (r.broken) broken.add(`broken-link ${s.path} -> ${target}`);
        return r.url;
      },
    };
    const md = renderMarkdown(s.body, env, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const sl = slug(name);
        return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, computed once per source and shared by every view of the page.
  const longDateCache = new Map();
  const longDateOf = (date) => {
    let v = longDateCache.get(date);
    if (v === undefined) {
      v = longDate(date);
      longDateCache.set(date, v);
    }
    return v;
  };
  // Link views and tag views are shared by every card that mentions them.
  const linkViews = new Map();
  const linkOf = (s) => {
    if (s === null) return null;
    let v = linkViews.get(s);
    if (v === undefined) {
      v = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDateOf(s.data.date) };
      linkViews.set(s, v);
    }
    return v;
  };
  const tagViews = new Map();
  const tagViewOf = (t) => {
    let v = tagViews.get(t);
    if (v === undefined) {
      v = { name: t.name, slug: t.slug, url: t.url };
      tagViews.set(t, v);
    }
    return v;
  };
  // reading_minutes is the only expensive card field (a full-body scan), and
  // some layouts never read it: compute it lazily, at most once per source.
  // The getter is invisible to templates beyond the value itself (own
  // property, same name and value as the reference's eager field).
  const rmCache = new Map();
  const rmOf = (s) => {
    let v = rmCache.get(s);
    if (v === undefined) {
      v = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
      rmCache.set(s, v);
    }
    return v;
  };
  const withRm = (obj, s) => {
    Object.defineProperty(obj, 'reading_minutes', { enumerable: true, get: () => rmOf(s) });
    return obj;
  };
  const cardOf = (s) => withRm({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    tags: s.tagRefs.map(tagViewOf),
  }, s);
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const pageOf = (s) => {
    const c = cards.get(s);
    return withRm({
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    }, s);
  };

  // 7. Layouts, index pages, tag pages, statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  // One scope object reused by every top-level render: rendering is
  // synchronous and render() is never re-entered (includes go through
  // renderInto with the scope they were given), so swapping .vars is safe.
  const renderScope = { vars: null, parent: rootScope };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = { s: '' };
    renderScope.vars = vars;
    renderInto(nodes, renderScope, ctx, 0, out);
    return out.s;
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
