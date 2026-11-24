// A fast drop-in replacement for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site's build returns for the same input, byte for byte, built with a fused single-pass
// Markdown renderer, compiled templates and per-build caches. No state survives between calls:
// every cache below is created inside run() and dropped when it returns.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.prototype.hasOwnProperty;

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped (makefun-site's table, nothing else). */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut
 * dropped), and "untitled" when nothing is left. Pure-ASCII text skips normalisation, which is
 * the identity there.
 */
function slugifyRaw(text) {
  let out = '';
  let gap = false;
  if (!NON_ASCII.test(text)) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
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
  } else {
    const plain = text.normalize('NFKD').replace(MARKS, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether code unit `code` is whitespace in the sense of JavaScript's \s. */
function isSpaceCode(code) {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  return (
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff
  );
}

/** The number of words in `text`: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Whether `s` holds any whitespace character (the sense of /\s/). */
function hasSpace(s) {
  for (let i = 0; i < s.length; i++) if (isSpaceCode(s.charCodeAt(i))) return true;
  return false;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;
const TRAILING_WS = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's value, or why it is refused. */
function fmValueOf(key, raw) {
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
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
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

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANK_LINE.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(TRAILING_WS, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn.call(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn.call(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const TRIM_LINE = /^[ \t]+|[ \t]+$/g;

const trimLine = (line) => line.replace(TRIM_LINE, '');

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/**
 * Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. The
 * four tests are disjoint on the line's first character, so dispatch on it instead of running
 * every regular expression on every line.
 */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return MD_BLANK.test(line);
  if (c === 96) return MD_FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return MD_HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped in bulk
 * between the special characters (\ ` * [) instead of character by character.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  let plainStart = 0;
  const flush = (end) => {
    if (end > plainStart) out += escapeHtml(s.slice(plainStart, end));
  };
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\' && c !== '`' && c !== '*' && c !== '[') {
      // Plain run: jump straight to the next special character, whichever comes first.
      let n = s.length;
      let j = s.indexOf('\\', i);
      if (j !== -1 && j < n) n = j;
      j = s.indexOf('`', i);
      if (j !== -1 && j < n) n = j;
      j = s.indexOf('*', i);
      if (j !== -1 && j < n) n = j;
      j = s.indexOf('[', i);
      if (j !== -1 && j < n) n = j;
      i = n;
      continue;
    }
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out += escapeHtml(s[i + 1]);
      i += 2;
      plainStart = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        plainStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          plainStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
        plainStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasSpace(target)) {
        flush(i);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        plainStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out;
}

/**
 * `src` rendered in one pass over its lines: its HTML (a "\n" after every block), its table of
 * contents (every level 2 and 3 heading) and its excerpt (the first paragraph's HTML, or "").
 * `slugify` is the build's cached slug function.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (MD_BLANK.test(line)) {
      i++;
      continue;
    }
    const first = line.charCodeAt(0);
    const fence = first === 96 ? MD_FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      i++;
      let body = '';
      while (i < lines.length && !MD_FENCE_CLOSE.test(lines[i])) {
        body += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      html += `<pre><code${cls}>${body}</code></pre>\n`;
      continue;
    }
    const heading = first === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const inner = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      i++;
      continue;
    }
    if ((first === 45 || first === 42) && MD_HR.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const t = trimLine(lines[i].replace(/^> ?/, ''));
        if (t !== '') kept.push(t);
        i++;
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = MD_BULLET.exec(line);
    const ordered = bullet === null ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const parts of items) block += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += `${block}</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const inner = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const ONLY_WS = /^[ \t]*$/;

/** An error in a template that does not parse; its message is the report line, word for word. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
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
    const standalone = ONLY_WS.test(src.slice(lineStart, open)) && ONLY_WS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookupPath(scopes, path) {
  let k = scopes.length - 1;
  while (k >= 0 && !hasOwn.call(scopes[k], path[0])) k--;
  if (k < 0) return undefined;
  let v = scopes[k][path[0]];
  for (let j = 1; j < path.length; j++) {
    if (v === null || typeof v !== 'object' || !hasOwn.call(v, path[j])) return undefined;
    v = v[path[j]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The helpers every compiled template closes over at call time. */
const TPL_HELPERS = { lk: lookupPath, tx: textOf, es: escapeHtml, tr: truthy, inc: null };

/**
 * `nodes` compiled to a JavaScript function (scopes, helpers, depth) -> string. Paths are pooled
 * in a table the generated code indexes, so a lookup allocates nothing.
 */
function compileTemplate(nodes) {
  const paths = [];
  const pathIdx = (path) => {
    paths.push(path);
    return paths.length - 1;
  };
  const gen = (list) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `o+=${JSON.stringify(n.text)};`;
          break;
        case 'var':
          code += `o+=H.es(H.tx(H.lk(S,P[${pathIdx(n.path)}])));`;
          break;
        case 'raw':
          code += `o+=H.tx(H.lk(S,P[${pathIdx(n.path)}]));`;
          break;
        case 'if': {
          const cond = `H.tr(H.lk(S,P[${pathIdx(n.path)}]))${n.not ? '===false' : '===true'}`;
          code += `if(${cond}){${gen(n.then)}}`;
          if (n.else !== null) code += `else{${gen(n.else)}}`;
          break;
        }
        case 'for': {
          const idx = pathIdx(n.path);
          const key = JSON.stringify(n.name);
          code += `{const xs=H.lk(S,P[${idx}]);if(Array.isArray(xs)){const n=xs.length;for(let k=0;k<n;k++){const v={};v[${key}]=xs[k];v.loop={index:k+1,first:k===0,last:k===n-1,length:n};S.push(v);${gen(n.body)}S.pop();}}}`;
          break;
        }
        case 'include':
          code += `if(D<${INCLUDE_DEPTH}){const f=H.inc.get(${JSON.stringify(n.name)});if(f!==undefined)o+=f(S,H,D+1);}`;
          break;
      }
    }
    return code;
  };
  const body = gen(nodes);
  const factory = new Function('P', `'use strict';return function(S,H,D){let o='';${body}return o;};`);
  return factory(paths);
}

/** `nodes` rendered by walking the tree; the fallback when a template cannot be compiled. */
function renderNodes(nodes, scopes, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookupPath(scopes, n.path)));
        break;
      case 'raw':
        out += textOf(lookupPath(scopes, n.path));
        break;
      case 'if': {
        const v = truthy(lookupPath(scopes, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scopes, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookupPath(scopes, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          scopes.push(vars);
          out += renderNodes(n.body, scopes, templates, depth);
          scopes.pop();
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += t(scopes, TPL_HELPERS, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const LINE_ENDS = /\r\n?/g;

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** makefun-site 1.0.0's answer for one case's input: its output tree, path -> text. */
export function run(input) {
  // Per-build caches: dropped when run returns, so nothing is carried from one case to the next.
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const dateCache = new Map();
  const longDate = (date) => {
    let v = dateCache.get(date);
    if (v === undefined) {
      v = longDateRaw(date);
      dateCache.set(date, v);
    }
    return v;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    let nodes;
    try {
      nodes = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
      continue;
    }
    let fn;
    try {
      fn = compileTemplate(nodes);
    } catch {
      fn = (S, H, D) => renderNodes(nodes, S, templates, D);
    }
    templates.set(name, fn);
  }
  TPL_HELPERS.inc = templates;

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(LINE_ENDS, '\n') });
    else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft; the checks run in
  // the reference's order and the first failure is the one reported.
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
    if (s.post && !hasOwn.call(s.data, 'date')) {
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

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, named as first met walking the posts in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  // Layouts: every page through its layout, then the index, tag and tags pages, then the statics.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn([{ site, tags: allTags, recent, ...vars }], TPL_HELPERS, 0);
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn.call(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
