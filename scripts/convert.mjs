import { isIP } from 'node:net';

// Pure, offline, fail-closed Loon plugin (LPX) → Surge module (.sgmodule) converter.
// Security boundary: never download or execute upstream scripts, never silently drop an action.
// References: manual.nssurge.com/{profile/module, http/map-local, http/url-rewrite,
// http/header-rewrite, http/body-rewrite, rules/*, scripting/*}.
class Fatal extends Error {}
const fail = message => { throw new Fatal(message); };
const soft = message => { throw new Error(message); };

const META = new Set(['name', 'desc', 'author', 'openurl', 'tag', 'system',
  'system_version', 'loon_version', 'homepage', 'icon', 'date']);
const LEGACY_ARG_META = new Set(['select', 'input', 'switch']);
// Surge built-in policies that may appear in a module rule.
const BUILTIN_POLICIES = new Set(['DIRECT', 'REJECT', 'REJECT-TINYGIF', 'REJECT-DROP', 'REJECT-NO-DROP']);
// Loon-only reject policies have no Surge equivalent: kept verbatim, explained in a comment.
const LOON_POLICIES = new Set(['REJECT-DICT', 'REJECT-ARRAY', 'REJECT-IMG', 'REJECT-VIDEO', 'REJECT-VIDEO-NO-DROP']);
const WARNING_BASE = '语法转换完成，未在 Surge 中实测功能。HTTPS 解密需自备 MITM 证书与域名覆盖。';

const oneLine = (value, label) => {
  if (typeof value !== 'string' || /[\r\n\u0000-\u001f\u007f]/.test(value)) fail(`Invalid ${label}`);
  return value.trim();
};
function remoteURL(s) {
  if (/[\s,"'\\<>]/.test(s)) fail('Unsafe or non-HTTP(S) external URL');
  let u; try { u = new URL(s); } catch { fail('Invalid external URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) fail('Unsafe external URL');
  return s;
}
function pattern(s) {
  if (!s || /["\u0000-\u001f\u007f]/.test(s)) fail('Empty or unsafe URL pattern');
  // Surge lines are space separated: encode literal spaces so the regex stays one token.
  const normalized = s.replace(/\{\s*(\d+)\s*,\s*(\d*)\s*\}/g, '{$1,$2}')
    .replace(/\{\s*(\d+)\s*\}/g, '{$1}')
    .replace(/ /g, '\\x20');
  // No evaluation of source regexes; reject constructs whose cross-engine semantics differ.
  if (/\(\?[a-z-]+[:)]|\\[pPkKgG]|\(\?<[^=!]/.test(normalized)) fail('Unsupported cross-engine regex construct');
  // ICU supports atomic groups (?>...) which JS does not; probe with a neutralised copy.
  try { new RegExp(normalized.replace(/\(\?>/g, '(?:')); } catch { fail('Invalid or unsupported regex'); }
  return normalized;
}
const unescapeSlashes = s => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '/') { out += '/'; i++; } else out += s[i];
  }
  return out;
};
const skipSpace = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

function scanQuoted(s, i) {
  let j = i + 1, out = '';
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      if (n === undefined) fail('Unterminated string');
      if (n === 'u' || n === 'x') {
        const len = n === 'u' ? 4 : 2, hex = s.slice(j + 2, j + 2 + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail('Invalid string escape');
        out += String.fromCharCode(parseInt(hex, 16));
        j += 2 + len;
        continue;
      }
      out += Object.hasOwn(simple, n) ? simple[n] : n;
      j += 2;
      continue;
    }
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\n' || c === '\r') fail('Newline in string');
    out += c; j++;
  }
  fail('Unterminated string');
}

function skipStringAt(s, i) {
  const q = s[i];
  if (q === '"') return scanQuoted(s, i).end;
  let j = i + 1;
  while (j < s.length) {
    if (q === '"' && s[j] === '\\') { j += 2; continue; }
    if (s[j] === q) return j + 1;
    j++;
  }
  fail('Unterminated string');
}

function skipRegexForward(s, i) {
  let j = i + 1, inClass = false;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
    j++;
  }
  fail('Unterminated regex literal');
}

const regexLeading = (s, i) => {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  return j < 0 || '(:,=~!['.includes(s[j]);
};

// `regex` is opt-in: a bare rule/URL value contains slashes (e.g. IP-CIDR6 `2001:db8::/32`)
// that must not be mistaken for a regex literal delimiter.
function splitTop(s, sep, { regex = false } = {}) {
  const parts = [];
  let start = 0, depth = 0, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipStringAt(s, i); continue; }
    if (regex && c === '/' && regexLeading(s, i)) { i = skipRegexForward(s, i); continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(start, i));
      i += sep.length;
      start = i;
      continue;
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

// Regex literal that ends at the last delimiter whose tail is only flags.
function regexTerm(term) {
  const s = term.trim();
  if (!s.startsWith('/')) fail('Expected URL regex literal');
  const cands = [];
  let inClass = false;
  for (let j = 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) cands.push(j);
  }
  for (let k = cands.length - 1; k >= 0; k--) {
    const tail = s.slice(cands[k] + 1);
    if (!/^[a-z]*$/.test(tail)) continue;
    return buildRegex(s.slice(1, cands[k]), tail);
  }
  fail('Unterminated regex literal');
}
function regexArg(s, i) {
  const cands = [];
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) cands.push(j);
  }
  for (let k = 0; k < cands.length; k++) {
    const rest = s.slice(cands[k] + 1);
    const m = /^([a-z]*)\s*(?:[,)\]]|$)/.exec(rest);
    if (!m) continue;
    return { ...buildRegex(s.slice(i + 1, cands[k]), m[1]), end: cands[k] + 1 + m[1].length };
  }
  fail('Unterminated regex literal');
}
function buildRegex(raw, flags) {
  if (!['', 'i'].includes(flags)) fail(`Unsupported regex flags: ${flags}`);
  const src = unescapeSlashes(raw);
  return { raw: src, flags, p: (flags === 'i' ? '(?i)' : '') + src };
}

function parseValue(s, i) {
  i = skipSpace(s, i);
  const c = s[i];
  if (c === '"') { const r = scanQuoted(s, i); return { value: { t: 'str', v: r.value }, end: r.end }; }
  if (c === '`') {
    const j = s.indexOf('`', i + 1);
    if (j < 0) fail('Unterminated raw string');
    return { value: { t: 'raw', v: s.slice(i + 1, j) }, end: j + 1 };
  }
  if (c === '/') { const r = regexArg(s, i); return { value: { t: 'regex', raw: r.raw, flags: r.flags }, end: r.end }; }
  if (c === '[') {
    const items = [];
    let j = skipSpace(s, i + 1);
    while (j < s.length && s[j] !== ']') {
      const r = parseValue(s, j);
      items.push(r.value);
      j = skipSpace(s, r.end);
      if (s[j] === ',') { j = skipSpace(s, j + 1); continue; }
      if (s[j] !== ']') fail('Malformed array literal');
    }
    if (j >= s.length) fail('Unterminated array literal');
    return { value: { t: 'array', items }, end: j + 1 };
  }
  let j = i;
  while (j < s.length && !',)]'.includes(s[j])) j++;
  const tok = s.slice(i, j).trim();
  if (tok === 'true' || tok === 'false') return { value: { t: 'bool', v: tok === 'true' }, end: j };
  if (tok === 'null') return { value: { t: 'null' }, end: j };
  if (/^-?\d+(?:\.\d+)?$/.test(tok)) return { value: { t: 'num', v: Number(tok) }, end: j };
  if (!tok) fail('Empty argument');
  return { value: { t: 'raw', v: tok }, end: j };
}

function parseArgsList(src) {
  const args = [];
  let i = skipSpace(src, 0);
  if (i >= src.length) return args;
  while (i < src.length) {
    const r = parseValue(src, i);
    args.push(r.value);
    i = skipSpace(src, r.end);
    if (i >= src.length) break;
    if (src[i] !== ',') fail('Malformed argument list');
    i = skipSpace(src, i + 1);
  }
  return args;
}

const strArg = (a, label) => {
  if (!a || a.t !== 'str') fail(`Expected string for ${label}`);
  return a.v;
};

// ---------------------------------------------------------------- arguments

const sanitizeArgName = raw => raw.replace(/[^A-Za-z0-9_]/g, '_');

function makeArg(key, kind, values, tag, desc, used, index) {
  let base = sanitizeArgName(key).replace(/^_+/, '').replace(/_+$/, '');
  if (!base) base = `param_${index}`;
  if (/^\d/.test(base)) base = `p_${base}`;
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) name = `${base}_${n++}`;
  used.add(name.toLowerCase());
  const options = values.map(v => (v.t === 'str' ? v.v : v.t === 'bool' ? String(v.v) : String(v.v ?? '')));
  const def = options[0] ?? '';
  return { key, name, kind, options, def, tag: tag || '', desc: desc || '' };
}

// key = switch, true, false, tag = ..., desc = ...
// key = select, "a", "b", tag = ..., desc = ...
function parseArgumentLine(line, used, index) {
  const parts = splitTop(line, ',');
  const head = /^\s*([^=]+?)\s*=\s*(switch|select|input)\s*$/i.exec(parts[0]);
  if (!head) fail('Malformed [Argument] declaration');
  const key = head[1].trim();
  if (!/^[A-Za-z0-9_.\-\u4e00-\u9fff ]+$/.test(key)) fail('Unsafe argument name');
  const kind = head[2].toLowerCase();
  const values = [];
  let tag = '', desc = '', field = '';
  for (const rawPart of parts.slice(1)) {
    const m = /^\s*(tag|desc)\s*=([\s\S]*)$/i.exec(rawPart);
    if (m) { field = m[1].toLowerCase(); if (field === 'tag') tag = m[2].trim(); else desc = m[2].trim(); continue; }
    if (field === 'tag') tag += (tag ? ', ' : '') + rawPart.trim();
    else if (field === 'desc') desc += (desc ? ', ' : '') + rawPart.trim();
    else values.push(parseValue(rawPart, 0).value);
  }
  if (kind === 'switch' && (values.length < 2 || values.some(v => v.t !== 'bool' && !(v.t === 'str' && /^(true|false)$/i.test(v.v))))) fail('Malformed switch argument');
  if (kind === 'select' && (values.length < 1 || values.some(v => v.t !== 'str'))) fail('Malformed select argument');
  return makeArg(key, kind, values, tag, desc, used, index);
}

// ---------------------------------------------------------------- rules

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/i;
const KEYWORD_RE = /^[a-z0-9_.-]+$/i;
const WILDCARD_RE = /^[a-z0-9_.*?-]+$/i;
const POLICY_RE = /^[A-Za-z0-9_.\-\u4e00-\u9fff]+$/;

function unquoteRule(raw) {
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] !== undefined) {
      const n = body[i + 1];
      if (n === raw[0] || n === '\\' || n === '/') { out += n; i++; continue; }
      out += '\\' + n; i++; continue;
    }
    out += body[i];
  }
  return out;
}

function validateRuleValue(type, raw) {
  const quoted = /^"(?:[^"\\]|\\.)*"$/.test(raw) || /^'(?:[^'\\]|\\.)*'$/.test(raw);
  const value = quoted ? unquoteRule(raw) : raw;
  if (!value || /[\r\n\u0000-\u001f]/.test(value)) fail('Invalid rule value');
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    if (!DOMAIN_RE.test(value)) fail('Invalid domain rule');
  } else if (type === 'DOMAIN-KEYWORD') {
    if (!KEYWORD_RE.test(value)) fail('Invalid domain keyword');
  } else if (type === 'DOMAIN-WILDCARD') {
    if (!WILDCARD_RE.test(value) || !/[*?]/.test(value)) fail('Invalid domain wildcard');
  } else if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
    const m = /^([^/]+)\/(\d+)$/.exec(value), family = type === 'IP-CIDR' ? 4 : 6;
    if (!m || isIP(m[1]) !== family || Number(m[2]) > (family === 4 ? 32 : 128)) fail('Invalid CIDR rule');
  } else if (type === 'GEOIP') {
    if (!/^[A-Z]{2}$/.test(value)) fail('Unsupported GEOIP code');
  } else if (type === 'IP-ASN') {
    if (!/^\d{1,10}$/.test(value)) fail('Invalid ASN');
  } else if (type === 'DEST-PORT' || type === 'SRC-PORT' || type === 'IN-PORT') {
    if (!/^\d{1,5}(?:-\d{1,5})?$/.test(value) || Number(value.split('-')[0]) > 65535) fail('Invalid port rule');
  } else if (type === 'SRC-IP') {
    if (isIP(value) === 0 && !/^[^/]+\/\d+$/.test(value)) fail('Invalid source IP');
  } else if (type === 'URL-REGEX') {
    pattern(value);
  } else if (type === 'USER-AGENT') {
    if (/[\r\n\u0000-\u001f]/.test(value) || value.length > 512) fail('Invalid user agent');
  } else if (type === 'PROCESS-NAME') {
    if (!/^[\w .+-]{1,128}$/.test(value)) fail('Invalid process name');
  } else if (type === 'PROTOCOL') {
    if (!['TCP', 'UDP', 'QUIC', 'HTTP', 'HTTPS', 'HTTP2', 'HTTP3'].includes(value.toUpperCase())) fail('Unsupported protocol');
  } else if (type === 'RULE-SET' || type === 'DOMAIN-SET') {
    if (/^https?:\/\//i.test(value)) remoteURL(value);
    else if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) fail('Invalid rule set reference');
  } else {
    fail(`Unsupported rule type: ${type}`);
  }
  return quoted ? raw : value;
}

function parseRuleExpr(src, depth) {
  if (depth > 4) fail('Rule nesting too deep');
  const text = src.trim();
  const parts = splitTop(text, ',');
  const type = parts[0].trim().toUpperCase();
  if (!type) fail('Malformed rule');
  if (type === 'AND' || type === 'OR' || type === 'NOT') {
    if (parts.length !== 2) fail('Malformed logical rule');
    let inner = parts[1].trim();
    if (!inner.startsWith('(') || !inner.endsWith(')')) fail('Malformed logical rule group');
    inner = inner.slice(1, -1);
    const items = splitTop(inner, ',').map(x => x.trim()).filter(Boolean);
    const children = [];
    for (const item of items) {
      if (!item.startsWith('(') || !item.endsWith(')')) fail('Malformed logical sub-rule');
      children.push(parseRuleExpr(item.slice(1, -1), depth + 1));
    }
    if (!children.length) fail('Empty logical rule');
    if ((type === 'AND' || type === 'OR') && children.length < 2) fail('AND/OR requires at least two sub-rules');
    if (type === 'NOT' && children.length !== 1) fail('NOT takes exactly one sub-rule');
    return `${type},(${children.map(c => `(${c})`).join(',')})`;
  }
  const leaf = parts.map(x => x.trim());
  if (leaf.length < 2 || leaf.length > 3 || leaf.some(x => !x)) fail('Malformed rule');
  const value = validateRuleValue(type, leaf[1]);
  let out = `${type},${value}`;
  if (leaf[2]) { validateOption(type, leaf[2]); out += ',no-resolve'; }
  return out;
}

function validateOption(type, option) {
  if (option !== 'no-resolve' || !['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN', 'SRC-IP'].includes(type)) fail('Unsupported rule option');
}

function parseRule(line) {
  const parts = splitTop(line, ',');
  const type = parts[0].trim().toUpperCase();
  let expr, policy, option = '';
  if (type === 'AND' || type === 'OR' || type === 'NOT') {
    // AND, ((...), (...)), POLICY  → last top-level part is the policy.
    if (parts.length < 3) fail('Malformed logical rule');
    policy = parts[parts.length - 1].trim();
    expr = parseRuleExpr(parts.slice(0, -1).join(','), 0);
  } else {
    if (parts.length < 3 || parts.length > 4) fail('Malformed rule');
    policy = parts[2].trim();
    if (parts.length === 4) { option = parts[3].trim(); validateOption(type, option); }
    expr = parseRuleExpr(parts.slice(0, 2).join(','), 0);
  }
  if (!POLICY_RE.test(policy)) fail('Unsafe policy name');
  const upper = policy.toUpperCase();
  return { expr, option, policy: BUILTIN_POLICIES.has(upper) || LOON_POLICIES.has(upper) ? upper : policy };
}

// ---------------------------------------------------------------- JSON / jq

function pathSegments(path) {
  if (typeof path !== 'string' || !path.trim()) fail('Invalid JSON path');
  const p = path.trim();
  const segs = [];
  let i = p[0] === '.' ? 1 : 0;
  while (i < p.length) {
    if (p[i] === '.') { i++; continue; }
    if (p[i] === '[') {
      let depth = 0, j = i, inStr = '', esc = false;
      for (; j < p.length; j++) {
        const c = p[j];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (inStr) { if (c === inStr) inStr = ''; continue; }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (!depth) break; }
      }
      if (j >= p.length) fail('Invalid JSON path bracket');
      const inner = p.slice(i + 1, j).trim();
      if (/^\d+$/.test(inner)) segs.push(Number(inner));
      else if (/^"(?:[^"\\]|\\.)*"$/.test(inner)) segs.push(JSON.parse(inner));
      else if (/^'(?:[^'\\]|\\.)*'$/.test(inner)) segs.push(inner.slice(1, -1));
      else fail('Unsupported JSON path index');
      i = j + 1;
      continue;
    }
    const m = /^[^.\[\]]+/.exec(p.slice(i));
    if (!m) fail('Unsupported JSON path segment');
    segs.push(m[0]);
    i += m[0].length;
  }
  if (!segs.length) fail('Empty JSON path');
  for (const s of segs) {
    if (typeof s === 'string' && (!s.trim() || /[\r\n\u0000-\u001f]/.test(s))) fail('Invalid JSON path segment');
  }
  return segs;
}
const jqPath = path => pathSegments(path).map(s => (typeof s === 'number'
  ? `[${s}]`
  : /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('');
const jqPathArray = path => `[${pathSegments(path).map(s => JSON.stringify(s)).join(',')}]`;

function jqValue(v) {
  switch (v.t) {
    case 'str': return JSON.stringify(v.v);
    case 'raw': {
      const raw = v.v.trim();
      try { JSON.parse(raw); } catch { fail('Raw JSON value is not valid JSON'); }
      return raw;
    }
    case 'num': return String(v.v);
    case 'bool': return String(v.v);
    case 'null': return 'null';
    case 'array': return `[${v.items.map(jqValue).join(', ')}]`;
    default: fail('Unsupported JSON value');
  }
}

function bodyPattern(s) {
  if (!s || /[\r\n\u0000-\u001f\u007f]/.test(s)) fail('Unsafe body regex');
  if (/\s/.test(s)) soft('Body Rewrite 正则含空白，无法在单行表达');
  if (/\(\?[a-z-]+[:)]|\\[pPkKgG]|\(\?<[^=!]/.test(s)) fail('Unsupported cross-engine regex construct');
  try { new RegExp(s.replace(/\(\?>/g, '(?:')); } catch { fail('Invalid or unsupported regex'); }
  return s;
}

// ---------------------------------------------------------------- line builders

function mapLocalLine(p, { dataType = 'text', data, status = '200', headers = [] }) {
  if (!/^\d{3}$/.test(status) || +status < 200 || +status > 999) fail('Unsupported mock status code');
  const parts = [p];
  if (dataType === 'tiny-gif') parts.push('data-type=tiny-gif');
  else parts.push(`data-type=${dataType}`, `data=${JSON.stringify(data)}`);
  parts.push(`status-code=${status}`);
  if (headers.length) {
    for (const h of headers) if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+:\s?[^\r\n|]+$/.test(h)) fail('Unsafe mock header');
    parts.push(`header=${JSON.stringify(headers.join('|'))}`);
  }
  return parts.join(' ');
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
function headerLine(phase, p, action, field, value) {
  if (!HEADER_NAME.test(field)) fail('Invalid header field');
  const base = `http-${phase} ${p} ${action} ${field}`;
  if (action === 'header-del') return base;
  if (value === undefined || /[\r\n\u0000]/.test(value)) fail('Invalid header value');
  return `${base} ${value}`;
}
function bodyRewriteLine(phase, p, regex, repl) {
  if (/\s/.test(regex) || /\s/.test(repl)) soft('Body Rewrite 以空格分隔参数，正则或替换内容含空白无法表达');
  return `http-${phase} ${p} ${regex} ${repl}`;
}

// ---------------------------------------------------------------- conditions

function argFor(args, key) {
  return args instanceof Map ? args.get(key) : undefined;
}

// Evaluate `response if ${url} ~= /re/ && ${arg} == "v" then ...`
function parseCondition(text, args) {
  const terms = splitTop(text.trim(), '&&', { regex: true }).map(x => x.trim()).filter(Boolean);
  const result = { pattern: null, src: null, flags: '', dropped: [], skip: null, raw: text.trim(), sawUrl: false };
  for (const term of terms) {
    let m;
    if (/^\$\{url\}\s*!=/.test(term)) fail('Unsupported URL inequality condition');
    if (/^\$\{url\}\s*(~=|==)/.test(term)) result.sawUrl = true;
    if (/^\(.*\)$/.test(term)) { result.dropped.push(term); continue; }
    if ((m = /^\$\{url\}\s*~=\s*(\/[\s\S]*)$/.exec(term))) {
      if (/\s+as\s+[A-Za-z_]\w*\s*$/.test(m[1])) result.aliased = true;
      const lit = regexTerm(m[1].replace(/\s+as\s+[A-Za-z_]\w*\s*$/, ''));
      pattern(lit.raw);
      if (result.pattern && result.pattern !== lit.p) result.dropped.push(term);
      else { result.pattern = lit.p; result.src = lit.raw; result.flags = lit.flags; }
      continue;
    }
    if ((m = /^\$\{url\}\s*==\s*("(?:[^"\\]|\\.)*")$/.exec(term))) {
      const url = scanQuoted(m[1], 0).value;
      if (!/^https?:\/\//i.test(url)) fail('Only absolute HTTP(S) URL equality is supported');
      const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
      if (!result.pattern) { result.pattern = `^${esc}$`; result.src = `^${esc}$`; }
      else result.dropped.push(term);
      continue;
    }
    if ((m = /^\$\{([^}]+)\}\s*==\s*(?:"([^"]*)"|(true|false)|(-?\d+(?:\.\d+)?))$/.exec(term))) {
      const key = m[1], value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      const arg = argFor(args, key);
      if (!arg) { result.dropped.push(term); continue; }
      if (arg.kind === 'select') {
        const hasSurge = arg.options.some(o => /^surge$/i.test(o));
        const keep = hasSurge ? /^surge$/i.test(value) : value === arg.def;
        if (!keep) { result.skip = { arg: key, value }; break; }
        continue;
      }
      result.dropped.push(term);
      continue;
    }
    if ((m = /^\$\{([^}]+)\}\s*!=\s*/.exec(term)) || (m = /^\$\{([^}]+)\}\s*~=\s*/.exec(term))) {
      result.dropped.push(term);
      continue;
    }
    if (/^!/.test(term)) { result.dropped.push(term); continue; }
    fail(`Unsupported conditional expression: ${term.slice(0, 80)}`);
  }
  return result;
}

function captureCount(s) {
  let count = 0, escaped = false, inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '[') inClass = true;
    if (c === ']') inClass = false;
    if (!inClass && c === '(' && s[i + 1] !== '?') count++;
  }
  return count;
}

function rewriteTarget(text, src, aliased, mode) {
  let target = text;
  if (/\$\{/.test(target)) {
    if (!aliased) fail('Redirect capture used without alias');
    target = target.replace(/\$\{urlMatch\.([1-9]\d*)\}/g, '$$$1');
    if (/\$\{/.test(target)) fail('Unsupported placeholder in rewrite target');
  }
  if (/\$(?!\d)/.test(target)) fail('Literal dollar in rewrite target requires manual review');
  for (const ref of target.matchAll(/\$([1-9]\d*)/g)) {
    if (+ref[1] > captureCount(src)) {
      // Without a `as urlMatch` alias Loon does no substitution, so `$n` is literal text.
      fail(aliased
        ? 'Rewrite references a nonexistent capture group'
        : 'Literal dollar in rewrite target requires manual review (source has no capture alias)');
    }
  }
  if (mode === 'header') {
    if (!/^(?:https?|wss?):\/\/|\$[1-9]/.test(target)) fail('Header rewrite target must be an absolute HTTP(S)/WS URL');
  } else if (!/^[a-z][a-z0-9+.-]*:\/\/|\$[1-9]/.test(target)) {
    fail('Unsupported redirect target');
  }
  if (/[\s"\\]/.test(target)) fail('Unsafe rewrite target');
  return target;
}

function buildUrlRewrite(p, src, target, kind) {
  // Force a full-URL match so Surge cannot retain unmatched prefixes/suffixes.
  const raw = p.startsWith('(?i)') ? p.slice(4) : p;
  const flag = p.startsWith('(?i)') ? '(?i)' : '';
  const full = `${flag}^[\\s\\S]*?(?:${raw})[\\s\\S]*$`;
  return kind === 'header' ? `${full} ${target} header` : `${full} ${target} ${kind}`;
}

// ---------------------------------------------------------------- actions

function parseCall(raw) {
  const m = /^([A-Za-z_][\w.]*)\s*\(([\s\S]*)\)$/.exec(raw.trim());
  if (!m) soft(`Unsupported action syntax: ${raw.slice(0, 60)}`);
  return { name: m[1], args: parseArgsList(m[2]), raw };
}

function actionOps(ctx, call) {
  const { phase, p, args } = ctx;
  const ops = [], notes = [];
  const name = call.name.toLowerCase();
  const a = call.args;

  const headerAction = (field, action, value) => {
    if (value !== undefined && /\s/.test(value)) notes.push('# 提示：响应头值含空格，Surge 以空格分隔参数，必要时请手工核对。');
    ops.push({ kind: 'header', phase, p, action, field, value });
  };
  const headerFrom = suffix => {
    if (suffix === 'set') {
      headerAction(strArg(a[0], 'header'), 'header-del');
      headerAction(strArg(a[0], 'header'), 'header-add', strArg(a[1], 'header value'));
    } else if (suffix === 'add') headerAction(strArg(a[0], 'header'), 'header-add', strArg(a[1], 'header value'));
    else if (suffix === 'del') headerAction(strArg(a[0], 'header'), 'header-del');
    else if (suffix === 'replace') {
      const re = a[1];
      if (!re || re.t !== 'regex') fail('header.replace expects a regex literal');
      if (!re.raw) fail('Empty header regex');
      bodyPattern(re.raw);
      headerAction(strArg(a[0], 'header'), 'header-replace-regex', `${re.raw} ${strArg(a[2], 'header replacement')}`);
    } else soft(`Unsupported header action: ${suffix}`);
  };

  if (name === 'reject' || name === 'reject_dict' || name === 'reject_array' || name === 'reject_img') {
    const status = a[0] && a[0].t === 'num' ? String(a[0].v) : '404';
    if (name === 'reject_img') ops.push({ kind: 'maplocal', p, dataType: 'tiny-gif', status });
    else if (name === 'reject_dict') ops.push({ kind: 'maplocal', p, data: '{}', status, headers: ['Content-Type:application/json'] });
    else if (name === 'reject_array') ops.push({ kind: 'maplocal', p, data: '[]', status, headers: ['Content-Type:application/json'] });
    else ops.push({ kind: 'maplocal', p, data: '', status });
    return { ops, notes };
  }
  if (name === 'redirect') {
    const code = a[0] && a[0].t === 'num' ? String(a[0].v) : '';
    if (!['302', '307'].includes(code)) soft('Unsupported redirect status');
    const target = rewriteTarget(strArg(a[1], 'redirect target'), ctx.src, ctx.aliased, 'redirect');
    ops.push({ kind: 'urlrewrite', p, src: ctx.src, target, status: code });
    return { ops, notes };
  }
  if (name === 'url.replace') {
    const target = rewriteTarget(strArg(a[0], 'url.replace target'), ctx.src, ctx.aliased, 'header');
    ops.push({ kind: 'urlrewrite', p, src: ctx.src, target, status: 'header' });
    return { ops, notes };
  }
  if (name === 'response.json.jq') {
    const expr = a[0] && (a[0].t === 'str' || a[0].t === 'raw') ? a[0].v : fail('jq expects an expression string');
    if (/[\r\n]/.test(expr)) soft('jq 表达式不能跨行');
    if (expr.includes("'")) soft('jq 表达式包含单引号，无法安全引用');
    ops.push({ kind: 'jq', p, expr });
    return { ops, notes };
  }
  if (name === 'response.json.delete') {
    const paths = a[0] && a[0].t === 'array' ? a[0].items.map(x => strArg(x, 'json path')) : [strArg(a[0], 'json path')];
    ops.push({ kind: 'jq', p, expr: `delpaths([${paths.map(jqPathArray).join(', ')}])` });
    return { ops, notes };
  }
  if (name === 'response.json.replace') {
    const paths = a[0] && a[0].t === 'array' ? a[0].items.map(x => strArg(x, 'json path')) : [strArg(a[0], 'json path')];
    const vals = a[1] && a[1].t === 'array' ? a[1].items : null;
    if (vals && vals.length !== paths.length) soft('json.replace 路径与值数量不一致');
    const expr = paths.map((path, i) => `${jqPath(path)} = ${jqValue(vals ? vals[i] : a[1])}`).join(' | ');
    ops.push({ kind: 'jq', p, expr });
    return { ops, notes };
  }
  if (name === 'response.body.mock') {
    const kind = strArg(a[0], 'mock type').toLowerCase();
    const body = a[1];
    if (!['json', 'text', 'base64'].includes(kind)) soft(`Unsupported mock type: ${kind}`);
    const status = a[2] && a[2].t === 'num' ? String(a[2].v) : '200';
    const base64 = kind === 'base64' || (a[3] && a[3].t === 'bool' && a[3].v);
    const raw = body && body.t === 'raw' ? body.v : strArg(body, 'mock body');
    if (base64) {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) soft('Invalid base64 mock body');
      ops.push({ kind: 'maplocal', p, dataType: 'base64', data: raw.replace(/\s+/g, ''), status, headers: kind === 'json' ? ['Content-Type:application/json'] : [] });
    } else {
      ops.push({ kind: 'maplocal', p, data: raw, status, headers: kind === 'json' ? ['Content-Type:application/json'] : [] });
    }
    return { ops, notes };
  }
  if (name === 'response.body.replace' || name === 'request.body.replace') {
    const first = a[0], second = a[1];
    const regexes = first && first.t === 'array' ? first.items.map(x => (x.t === 'regex' ? x : fail('body.replace expects regex literals'))) : [first];
    const repls = second && second.t === 'array' ? second.items.map(x => strArg(x, 'body replacement')) : [strArg(second, 'body replacement')];
    if (regexes.length !== repls.length) soft('body.replace 正则与替换数量不一致');
    for (let i = 0; i < regexes.length; i++) {
      if (!regexes[i] || regexes[i].t !== 'regex') fail('body.replace expects regex literals');
      try {
        ops.push({ kind: 'body', phase, p, regex: bodyPattern(regexes[i].raw), repl: repls[i] });
      } catch (e) {
        if (e instanceof Fatal) throw e;
        (ctx.skips || (ctx.skips = [])).push({ source: call.raw, reason: `第 ${i + 1} 组替换：${e.message}` });
      }
    }
    return { ops, notes };
  }
  if (name === 'request.header.set' || name === 'request.header.add' || name === 'request.header.del'
    || name === 'request.header.replace' || name === 'response.header.set' || name === 'response.header.add'
    || name === 'response.header.del' || name === 'response.header.replace') {
    const [dir, , action] = name.split('.');
    if (dir !== phase) soft('动作阶段与条件阶段不一致');
    headerFrom(action);
    return { ops, notes };
  }
  if (name === 'response.json.jq_file' || name === 'response.body.mock_file' || name === 'response.body.replace_file') {
    soft(`${name} 依赖远端资源，需人工下载后内联`);
  }
  if (name === 'reject_video') {
    soft('reject_video 返回视频占位，Surge 无等价动作');
  }
  soft(`Unknown action: ${name}`);
  return { ops, notes };
}

function renderOps(ops, emit, registry) {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (registry && op.kind === 'maplocal') registry.ml.add(op.p);
    if (registry && op.kind === 'urlrewrite') registry.ur.add(op.p);
    if (op.kind === 'maplocal') {
      // Fold header actions on the same pattern into Map Local's header list.
      // `header.set` is emitted as del+add, so a del immediately followed by an add of the
      // same field is a set and folds into a single header entry.
      const headers = [...(op.headers || [])];
      const setHeader = (field, value) => {
        const at = headers.findIndex(h => h.slice(0, h.indexOf(':')).toLowerCase() === field.toLowerCase());
        const entry = `${field}: ${value}`;
        if (at >= 0) headers[at] = entry; else headers.push(entry);
      };
      let j = i + 1;
      while (j < ops.length && ops[j].kind === 'header' && ops[j].p === op.p) {
        const h = ops[j];
        if (h.action === 'header-add') { setHeader(h.field, h.value); j++; continue; }
        if (h.action === 'header-del' && ops[j + 1] && ops[j + 1].kind === 'header'
          && ops[j + 1].p === op.p && ops[j + 1].action === 'header-add' && ops[j + 1].field === h.field) {
          setHeader(h.field, ops[j + 1].value); j += 2; continue;
        }
        break;
      }
      i = j - 1;
      emit('Map Local', mapLocalLine(op.p, { ...op, headers }));
    } else if (op.kind === 'header') {
      emit('Header Rewrite', headerLine(op.phase, op.p, op.action, op.field, op.value));
    } else if (op.kind === 'urlrewrite') {
      emit('URL Rewrite', buildUrlRewrite(op.p, op.src, op.target, op.status));
    } else if (op.kind === 'body') {
      emit('Body Rewrite', bodyRewriteLine(op.phase, op.p, op.regex, op.repl));
    } else if (op.kind === 'jq') {
      emit('Body Rewrite', `http-response-jq ${op.p} '${op.expr}'`);
    } else if (op.kind === 'script') {
      emit('Script', op.line);
    }
  }
}

// ---------------------------------------------------------------- scripts

function parseSettings(text) {
  const out = new Map();
  if (!text || !text.trim()) return out;
  for (const part of splitTop(text, ',')) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*=\s*([\s\S]*?)\s*$/.exec(part);
    if (!m) fail('Malformed script setting');
    const key = m[1].toLowerCase().replaceAll('_', '-');
    if (out.has(key)) fail(`Duplicate script parameter: ${key}`);
    let value = m[2];
    if (value.startsWith('"')) value = scanQuoted(value, 0).value;
    out.set(key, value);
  }
  return out;
}

function parseScriptCall(rest) {
  const m = /^script\s*\(([\s\S]*)\)\s*(?:with\s+([\s\S]*))?$/.exec(rest.trim());
  if (!m) fail('Unsupported script expression');
  const parts = splitTop(m[1], ',');
  const url = strArg(parseValue(parts[0], 0).value, 'script URL');
  return { url, argSpec: parts.slice(1).join(',').trim(), settings: parseSettings(m[2] || '') };
}

function scriptArgument(argSpec, args) {
  if (!argSpec) return '';
  if (argSpec.startsWith('{') && argSpec.endsWith('}')) {
    const refs = [...argSpec.matchAll(/\$\{([^}]+)\}/g)].map(m => m[1]);
    const leftover = argSpec.replace(/\$\{[^}]+\}/g, '').replace(/[{},\s]/g, '');
    if (leftover) soft('脚本参数对象含无法转换的成员');
    return refs.map(key => {
      const arg = args.get(key);
      if (!arg) fail(`Undeclared script argument: ${key}`);
      return `${arg.name}={{{${arg.name}}}}`;
    }).join('&');
  }
  if (argSpec.startsWith('"')) return scanQuoted(argSpec, 0).value;
  soft('Unsupported script argument form');
}

function scriptLine(spec, args, ctx) {
  const fields = [`type=${spec.type}`];
  if (spec.pattern) {
    fields.push(spec.pattern.includes(',') ? `pattern="${spec.pattern}"` : `pattern=${spec.pattern}`);
  }
  if (spec.cronexp !== undefined) fields.push(`cronexp="${spec.cronexp}"`);
  if (spec.event) fields.push(`event-name=${spec.event}`);
  fields.push(`script-path=${remoteURL(spec.url)}`);
  const s = spec.settings;
  const allowed = new Set(['requires-body', 'binary-body-mode', 'timeout', 'tag', 'enable', 'img-url', 'script-path', 'argument']);
  for (const k of s.keys()) if (!allowed.has(k)) soft(`Unsupported script parameter: ${k}`);
  if (s.has('requires-body')) {
    const v = s.get('requires-body');
    if (!['true', 'false'].includes(v)) fail('Invalid requires-body');
    fields.push(`requires-body=${v}`);
  }
  if (s.has('binary-body-mode')) {
    const v = s.get('binary-body-mode');
    if (!['true', 'false'].includes(v)) fail('Invalid binary-body-mode');
    if (v === 'true' && s.get('requires-body') !== 'true') fail('Binary body mode without requires-body');
    fields.push(`binary-body-mode=${v}`);
  }
  if (s.has('timeout')) {
    const v = s.get('timeout');
    if (!/^\d+(?:\.\d+)?$/.test(v) || +v <= 0 || +v > 3600) fail('Invalid timeout');
    fields.push(`timeout=${v}`);
  } else if (spec.type === 'http-request' || spec.type === 'http-response') {
    fields.push('timeout=10'); // Loon HTTP scripts default to 10s, Surge defaults to 5s.
  }
  if (s.has('tag')) ctx.notes.push(`# 原始脚本标签：${oneLine(s.get('tag'), 'script tag')}`);
  if (s.has('img-url')) ctx.warn('脚本图标 img_url 为 Loon 专有参数，已忽略。');
  const arg = scriptArgument(spec.argSpec, args);
  if (arg) fields.push(`argument=${JSON.stringify(arg)}`);
  return fields.join(', ');
}

// ---------------------------------------------------------------- converter

/** @returns {{status:'converted'|'unsupported',content:string|null,warnings:string[],reason:string}} */
export function convertPlugin(text, { name, sourceURL } = {}) {
  const warnings = [WARNING_BASE];
  const notes = [];
  const unconverted = [];
  const general = [];
  const hostSettings = [];
  let lineNumber = 0;
  try {
    if (typeof text !== 'string' || !text.trim()) fail('Empty or non-text LPX');
    if (text.length > 2_000_000) fail('LPX exceeds size limit');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail('Control character in LPX');
    if (/^\s*(?:<!doctype|<html|\{\s*"|\[\s*\{)/i.test(text)) fail('Input is HTML/JSON, not LPX');
    const title = name === undefined ? '' : oneLine(name, 'name');
    if (sourceURL !== undefined) remoteURL(oneLine(sourceURL, 'sourceURL'));

    const rawLines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const metadata = new Map();
    const args = new Map();
    const usedNames = new Set();
    let section = '', argIndex = 0;

    // Pass 1: metadata and [Argument] declarations (placeholders may be used before they appear).
    for (const raw of rawLines) {
      const line = raw.trim();
      if (!line) continue;
      const h = /^\[([^\]]+)\]$/.exec(line);
      if (h) { section = h[1].trim().toLowerCase(); continue; }
      if (line.startsWith('#!')) {
        const m = /^#!\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
        if (!m) fail('Malformed metadata directive');
        const key = m[1].toLowerCase(), value = m[2];
        if (LEGACY_ARG_META.has(key)) {
          const parts = splitTop(value, ',');
          const label = (parts.shift() || '').trim();
          const values = parts.map(x => parseValue(x, 0).value);
          if (key === 'input' && !values.length) values.push({ t: 'str', v: '' });
          if (key === 'switch' && values.length < 2) values.push({ t: 'bool', v: true }, { t: 'bool', v: false });
          const arg = makeArg(label, key === 'switch' ? 'switch' : key, values, label, '', usedNames, ++argIndex);
          if (args.has(arg.key)) fail(`Duplicate argument: ${arg.key}`);
          args.set(arg.key, arg);
          continue;
        }
        if (!META.has(key)) fail(`Unsupported metadata directive: ${key}`);
        if (metadata.has(key)) fail(`Duplicate metadata directive: ${key}`);
        metadata.set(key, value);
        if (key !== 'loon_version' && key !== 'homepage') notes.push(`# 原始元数据：${line.slice(2)}`);
        continue;
      }
      if (section === 'argument' && !/^(#|;|\/\/)/.test(line)) {
        const arg = parseArgumentLine(line, usedNames, ++argIndex);
        if (args.has(arg.key)) fail(`Duplicate argument: ${arg.key}`);
        args.set(arg.key, arg);
      }
    }

    const sections = new Map();
    const registry = { ml: new Set(), ur: new Set() };
    const policyNotes = new Set();
    let actionCount = 0, scriptNumber = 0;
    let inertCount = 0;
    const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
    const push = (key, line) => { if (!sections.has(key)) sections.set(key, []); sections.get(key).push(line); };
    const emit = (key, line) => { push(key, line); actionCount++; };
    const ctxBase = { args, notes, warn };

    section = '';
    lineNumber = 0;
    for (const raw of rawLines) {
      lineNumber++;
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#!')) continue;
      if (/^(#|;|\/\/)/.test(line)) {
        notes.push(line.startsWith('#') ? line : `# ${line}`);
        continue;
      }
      const h = /^\[([^\]]+)\]$/.exec(line);
      if (h) {
        section = h[1].trim().toLowerCase();
        if (!['rule', 'rewrite', 'url rewrite', 'script', 'mitm', 'argument', 'general', 'host', 'ip rewrite'].includes(section)) {
          fail(`Unsupported section: [${h[1]}]`);
        }
        continue;
      }
      if (!section) fail('Directive outside a supported section');
      if (section === 'argument') continue;

      if (section === 'rule') {
        const rule = parseRule(line);
        if (!BUILTIN_POLICIES.has(rule.policy)) policyNotes.add(rule.policy);
        emit('Rule', [rule.expr, rule.policy, rule.option].filter(Boolean).join(','));
        continue;
      }
      if (section === 'mitm') {
        const m = /^hostname\s*=\s*(.+)$/i.exec(line);
        if (!m || sections.has('MITM')) fail('Only one MITM hostname declaration is supported');
        const value = m[1].replace(/^%APPEND%\s*/, '');
        const hosts = value.split(',').map(x => x.trim());
        if (hosts.some(x => !/^-?(?:\*|[a-z0-9_*?][a-z0-9_.*?-]*)(?::\d+)?$/i.test(x))) fail('Invalid or dynamic MITM hostname');
        sections.set('MITM', [`hostname = %APPEND% ${hosts.join(', ')}`]);
        continue;
      }
      if (section === 'general') { general.push(line); continue; }
      if (section === 'host' || section === 'ip rewrite') { hostSettings.push(`[${section}] ${line}`); continue; }
      if (section === 'script') {
        try {
          const spec = { type: '', pattern: '', settings: new Map(), argSpec: '', url: '' };
          if (/^(request|response)\s+if\s+/.test(line)) {
            const phase = /^request/.test(line) ? 'request' : 'response';
            const rest = line.replace(/^(request|response)\s+if\s+/, '');
            const ti = rest.indexOf(' then ');
            if (ti < 0) fail('Missing then in script expression');
            const cond = parseCondition(rest.slice(0, ti), args);
            if (cond.skip) { notes.push(`# 已省略脚本分支：${cond.skip.arg}="${cond.skip.value}"`); continue; }
            if (!cond.pattern) soft('脚本条件中没有可用的 URL 匹配');
            if (cond.dropped.length) warn(`脚本条件的运行时判断已省略：${cond.dropped.join(' && ')}`);
            const call = parseScriptCall(rest.slice(ti + 6));
            spec.type = `http-${phase}`;
            spec.pattern = cond.pattern;
            spec.url = call.url; spec.argSpec = call.argSpec; spec.settings = call.settings;
          } else if (/^(cron|generic|network-changed)\b/.test(line)) {
            const ti = line.indexOf(' then ');
            if (ti < 0) fail('Missing then in event script');
            const head = line.slice(0, ti).trim(), kind = head.split(/\s+/)[0].toLowerCase();
            const call = parseScriptCall(line.slice(ti + 6));
            spec.url = call.url; spec.argSpec = call.argSpec; spec.settings = call.settings;
            if (kind === 'cron') {
              spec.type = 'cron';
              let expr = head.slice(4).trim();
              if (expr.startsWith('"')) expr = scanQuoted(expr, 0).value;
              else if (expr.startsWith('${')) {
                const key = expr.slice(2, -1);
                const arg = args.get(key);
                if (!arg) fail(`Undeclared cron argument: ${key}`);
                expr = `{{{${arg.name}}}}`;
              }
              if (/["\r\n]/.test(expr)) fail('Invalid cron expression');
              spec.cronexp = expr;
            } else if (kind === 'network-changed') {
              spec.type = 'event';
              spec.event = 'network-changed';
            } else {
              spec.type = 'generic';
            }
          } else {
            const m = /^(http-request|http-response)\s+(\S+)\s+(.+)$/.exec(line);
            if (!m) soft('Only HTTP request/response, cron, event and generic scripts are supported');
            spec.type = m[1];
            spec.pattern = pattern(m[2]);
            spec.settings = parseSettings(m[3]);
            spec.url = spec.settings.get('script-path');
            if (!spec.url) fail('Missing script-path');
            spec.settings.delete('script-path');
          }
          const enable = spec.settings.get('enable');
          if (enable !== undefined) {
            spec.settings.delete('enable');
            let skip = false;
            if (enable === 'false') skip = true;
            else if (enable.startsWith('${')) {
              const arg = args.get(enable.slice(2, -1));
              if (arg && arg.kind === 'switch' && arg.def === 'false') skip = true;
              else if (arg) notes.push(`# 脚本开关 {{{${arg.name}}}}：Surge 模块无法按参数禁用整行脚本，默认保持启用。`);
              else fail(`Undeclared enable argument: ${enable}`);
            } else if (enable !== 'true') fail('Invalid enable value');
            if (skip) {
              const built = scriptLine(spec, args, ctxBase);
              push('Script', `# 以下脚本在 Loon 中默认关闭（enable=false），Surge 模块无法按参数禁用整行脚本：`);
              push('Script', `# plugin_${++scriptNumber} = ${built}`);
              inertCount++;
              warn('部分脚本默认关闭（enable=false），已以注释形式保留，需手动取消注释后生效。');
              continue;
            }
          }
          const built = scriptLine(spec, args, ctxBase);
          emit('Script', `plugin_${++scriptNumber} = ${built}`);
          warn(`外部脚本需自行核对：${spec.url}。脚本未下载、未执行，可能包含不兼容的宿主 API 或二进制处理。`);
        } catch (e) {
          if (e instanceof Fatal) throw e;
          unconverted.push({ source: line, reason: e.message });
        }
        continue;
      }
      // [Rewrite] / [URL Rewrite]
      try {
        if (/^(request|response)\s+if\s+/.test(line)) {
          const phase = /^request/.test(line) ? 'request' : 'response';
          const rest = line.replace(/^(request|response)\s+if\s+/, '');
          const ti = rest.indexOf(' then ');
          if (ti < 0) fail('Missing then in conditional rewrite');
          const condText = rest.slice(0, ti);
          const cond = parseCondition(condText, args);
          if (cond.skip) {
            notes.push(`# 已省略分支：${cond.skip.arg} = "${cond.skip.value}"（其他客户端专用）`);
            warn(`参数分支 ${cond.skip.arg}="${cond.skip.value}" 面向其他客户端，Surge 模块中已省略。`);
            continue;
          }
          if (!cond.pattern) {
            if (cond.sawUrl) fail('Unsupported URL condition');
            soft('条件中没有可用的 URL 匹配');
          }
          if (cond.dropped.length) {
            notes.push(`# 已省略运行时判断：${cond.dropped.join(' && ')}`);
            warn(`条件中的运行时判断无法在 Surge 模块中表达，已省略：${cond.dropped.join(' && ')}`);
          }
          const aliased = cond.aliased === true;
          const ops = [];
          for (const rawCall of splitTop(rest.slice(ti + 6), '|', { regex: true }).map(x => x.trim()).filter(Boolean)) {
            try {
              const call = parseCall(rawCall);
              const actx = { phase, p: cond.pattern, src: cond.src, args, aliased, registry };
              ops.push(...actionOps(actx, call).ops);
              if (actx.skips) unconverted.push(...actx.skips);
            } catch (e) {
              if (e instanceof Fatal) throw e;
              unconverted.push({ source: rawCall, reason: e.message });
            }
          }
          renderOps(ops, emit, registry);
          continue;
        }
        let m = /^(\S+)\s+(reject|reject-200|reject-img|reject-dict|reject-array)$/.exec(line);
        if (m) {
          const p = pattern(m[1]);
          if (m[2] === 'reject') { registry.ur.add(p); emit('URL Rewrite', `${p} _ reject`); }
          else {
            registry.ml.add(p);
            if (m[2] === 'reject-img') emit('Map Local', mapLocalLine(p, { dataType: 'tiny-gif', status: '200' }));
            else if (m[2] === 'reject-200') emit('Map Local', mapLocalLine(p, { data: '', status: '200' }));
            else emit('Map Local', mapLocalLine(p, { data: m[2] === 'reject-dict' ? '{}' : '[]', status: '200', headers: ['Content-Type:application/json'] }));
          }
          continue;
        }
        // Loon order is pattern action replacement, NOT Surge order.
        m = /^(\S+)\s+(302|307|header)\s+(\S+)$/.exec(line);
        if (!m) fail('Unknown or unsupported rewrite directive');
        const p = pattern(m[1]);
        const target = rewriteTarget(m[3], p, false, m[2] === 'header' ? 'header' : 'redirect');
        registry.ur.add(p);
        emit('URL Rewrite', buildUrlRewrite(p, p, target, m[2]));
      } catch (e) {
        if (e instanceof Fatal) throw e;
        unconverted.push({ source: line, reason: e.message });
      }
    }

    if (!actionCount && !inertCount) {
      lineNumber = 0; // a whole-file property, not a single line
      const deviceOnly = (general.length || hostSettings.length)
        && [...sections.keys()].every(k => k === 'MITM');
      if (deviceOnly) {
        fail('No actionable supported directives：该插件仅包含 Surge 模块无法表达的 DNS/Host/IP 配置（[General]/[Host]/[IP Rewrite]），Surge 模块无法声明这些设备级设置');
      }
      fail('No actionable supported directives');
    }
    const systemRaw = (metadata.get('system') || '').trim().toLowerCase();
    let systemTag = '';
    if (systemRaw) {
      if (!['ios', 'mac', 'macos', 'tvos'].includes(systemRaw)) fail('Unsupported system constraint');
      systemTag = systemRaw === 'macos' ? 'mac' : systemRaw;
    }
    if ((metadata.get('system_version') || '').trim()) {
      warn(`原插件声明系统版本要求 ${metadata.get('system_version').trim()}，模块未强制限制，请自行确认。`);
    }

    // Identical URL patterns in Map Local and URL Rewrite cannot keep Loon's list order.
    const collision = [...registry.ml].find(p => registry.ur.has(p));
    if (collision) fail('Mixed URL Rewrite and Map Local precedence cannot be preserved safely');

    if (policyNotes.size) {
      const named = [...policyNotes].filter(p => !LOON_POLICIES.has(p));
      if (named.length) warn(`命名策略 ${named.join(', ')} 按原样保留，需在本地 Surge 主配置中存在同名策略（模块不创建策略组）。`);
      const loonOnly = [...policyNotes].filter(p => LOON_POLICIES.has(p));
      if (loonOnly.length) warn(`策略 ${loonOnly.join(', ')} 为 Loon 专有策略，Surge 无同名项；已原样保留，必要时请手工改为 REJECT/REJECT-TINYGIF 或 Map Local。`);
    }
    if (sections.has('Body Rewrite')) warn('Body Rewrite 需要 Surge iOS 5.10+ / macOS 5.6+；jq 正文改写需要 iOS 5.14+ / macOS 5.9+。');
    if (sections.has('Header Rewrite')) warn('Header Rewrite 在 Surge 官方文档中未标注最低版本；旧客户端可能无法识别该段，安装报错请升级。');
    if (sections.has('Map Local')) warn('Map Local 需要 Surge iOS 5.9.1+ / macOS 5.5.1+；响应头可能与原插件不同。');
    if (metadata.has('loon_version')) warn('原始版本元数据仅作来源记录，不代表 Surge 兼容性。');
    if (general.length) warn('[General] 段为设备级设置，Surge 模块无法声明，已在注释中保留原文。');
    if (hostSettings.length) warn('[Host]/[IP Rewrite] 段未转换，见模块内注释。');
    if (unconverted.length) warn(`有 ${unconverted.length} 个动作无法完全等价，已在模块内以注释标注。`);

    const argList = [...args.values()].map(a => {
      const def = /^[A-Za-z0-9_.+*/-]+$/.test(a.def) ? a.def : '';
      return def ? `${a.name}:${def}` : a.name;
    }).join(',');
    const argNotes = [...args.values()].map(a => {
      const label = a.tag || a.desc || '';
      const detail = [a.tag, a.desc].filter(Boolean).join(' — ');
      return `# 参数 ${a.name}（Loon: ${a.key}）= ${a.def || '空'}${detail ? `  ${detail}` : ''}`;
    });

    const output = [
      `#!name=${title || metadata.get('name') || '转换模块'}`,
      `#!desc=${oneLine(metadata.get('desc') || '由上游插件配置转换的模块', 'module desc')}`,
      ...(systemTag ? [`#!system=${systemTag}`] : []),
      ...(args.size ? [`#!arguments=${argList}`, '#!arguments-desc=由 Loon 插件转换，参数含义与默认值见文件内「# 参数」注释。'] : []),
      '# 由上游插件配置自动转换，原作者署名与许可声明见下。',
      ...(sourceURL ? [`# 来源：${sourceURL}`] : []),
      ...[...new Set(warnings)].map(x => `# 提示：${x}`),
      ...notes,
      ...argNotes,
    ];

    if (unconverted.length) {
      output.push('', '# ---- 未完全等价的动作（需人工确认）----');
      for (const item of unconverted) {
        output.push(`# 原文：${item.source.replace(/[\r\n]+/g, ' ').slice(0, 400)}`);
        output.push(`# 原因：${item.reason}`);
      }
    }
    if (general.length) {
      output.push('', '# 原插件 [General] 设置（Surge 模块无法声明，需手动加入主配置）：');
      for (const g of general) output.push(`#   ${g}`);
    }
    if (hostSettings.length) {
      output.push('', '# 原插件 [Host]/[IP Rewrite] 设置（未转换）：');
      for (const g of hostSettings) output.push(`#   ${g}`);
    }

    for (const [key, lines] of sections) {
      output.push('', `[${key}]`);
      if (key === 'Rule' && policyNotes.size) {
        output.push(`# 策略提示：以下命名策略按原样保留，需在本地 Surge 主配置中存在（模块不创建策略组）：${[...policyNotes].join(', ')}`);
        const loonOnly = [...policyNotes].filter(p => LOON_POLICIES.has(p));
        if (loonOnly.length) output.push(`# 策略提示：${loonOnly.join(', ')} 为 Loon 专有策略，Surge 无同名项；已按要求原样保留，必要时请手工改为 REJECT/REJECT-TINYGIF 或 Map Local。`);
        output.push('# 注意：Surge 模块文档声明规则仅可使用内置策略 DIRECT/REJECT/REJECT-TINYGIF；若安装报错请按上一条提示调整。');
      }
      output.push(...lines);
    }
    return { status: 'converted', content: output.join('\n') + '\n', warnings: [...new Set(warnings)], reason: '' };
  } catch (e) {
    return {
      status: 'unsupported',
      content: null,
      warnings: [...new Set(warnings)],
      reason: `${lineNumber ? `Line ${lineNumber}: ` : ''}${e.message}`,
    };
  }
}
