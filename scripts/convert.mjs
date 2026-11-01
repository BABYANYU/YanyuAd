import { isIP } from 'node:net';

// Pure, offline, fail-closed LPX subset converter. No downloads or execution.
// Syntax references: manual.nssurge.com/{profile/module,http/url-rewrite,
// http/map-local,scripting/overview,rules/domain,rules/ip}.html
const META = new Set(['name', 'desc', 'author', 'openurl', 'tag', 'system',
  'system_version', 'loon_version', 'homepage', 'icon', 'date']);
const POLICIES = new Set(['DIRECT', 'REJECT', 'REJECT-TINYGIF']);
const warningBase = 'Syntax converted only; not functionally verified in Surge. HTTPS processing requires the user’s MITM certificate and hostname coverage.';
const fail = message => { throw new Error(message); };
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
  if (!s || /[\s"\u0000-\u001f]/.test(s)) fail('Empty or unsafe URL pattern');
  // No evaluation of source regexes; reject constructs whose cross-engine semantics differ.
  if (/\(\?[a-z-]+[:)]|\\[pPkKgG]|\(\?<[^=!]/.test(s)) fail('Unsupported cross-engine regex construct');
  try { new RegExp(s); } catch { fail('Invalid or unsupported regex'); }
  return s;
}
function literal(input) {
  if (!input.startsWith('/')) fail('Expected URL regex literal');
  let escaped = false, inClass = false, end = -1;
  for (let i = 1; i < input.length; i++) {
    const c = input[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '[') inClass = true;
    if (c === ']') inClass = false;
    if (c === '/' && !inClass) { end = i; break; }
  }
  if (end < 0) fail('Unterminated regex literal');
  const flags = input.slice(end + 1).match(/^[a-z]*/)[0];
  if (!['', 'i'].includes(flags)) fail(`Unsupported regex flags: ${flags}`);
  const raw = input.slice(1, end).replace(/\\\//g, '/');
  const p = pattern(raw);
  return { raw: p, p: (flags ? '(?i)' : '') + p, flags, tail: input.slice(end + 1 + flags.length).trim() };
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
function condition(line) {
  const m = /^(request|response) if \$\{url\} ~= (.+)$/.exec(line);
  if (!m) fail('Unsupported conditional expression');
  return { phase: m[1], ...literal(m[2]) };
}
function params(s) {
  // Commas inside double-quoted values are preserved. Never split a regex here.
  const parts = []; let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && quoted) { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (c === ',' && !quoted) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  if (quoted || escaped) fail('Unterminated quoted parameter');
  parts.push(s.slice(start));
  const out = new Map();
  for (const part of parts) {
    const m = /^\s*([a-zA-Z_-]+)\s*=\s*(.*?)\s*$/.exec(part);
    if (!m || !m[2]) fail('Malformed or empty script parameter');
    const key = m[1].toLowerCase().replaceAll('_', '-');
    if (out.has(key)) fail(`Duplicate script parameter: ${key}`);
    let value = m[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { fail('Unsupported quoted parameter escape'); }
      if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) fail('Invalid quoted parameter');
    } else if (/["\s]/.test(value)) fail('Unquoted script parameter contains whitespace');
    out.set(key, value);
  }
  return out;
}
function rule(line) {
  const a = line.split(',').map(x => x.trim());
  if (a.length < 3 || a.length > 4 || a.some(x => !x)) fail('Malformed rule');
  let [type, value, policy, option] = a;
  type = type.toUpperCase(); policy = policy.toUpperCase();
  if (!POLICIES.has(policy)) fail('Modules may only reference supported internal policies');
  if (['DOMAIN', 'DOMAIN-SUFFIX'].includes(type)) {
    if (!/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/i.test(value)) fail('Invalid domain rule');
  } else if (type === 'DOMAIN-KEYWORD') {
    if (!/^[a-z0-9_.-]+$/i.test(value)) fail('Invalid domain keyword');
  } else if (['IP-CIDR', 'IP-CIDR6'].includes(type)) {
    const m = /^([^/]+)\/(\d+)$/.exec(value), family = type === 'IP-CIDR' ? 4 : 6;
    if (!m || isIP(m[1]) !== family || Number(m[2]) > (family === 4 ? 32 : 128)) fail('Invalid CIDR rule');
  } else if (type === 'GEOIP') {
    if (!/^[A-Z]{2}$/.test(value)) fail('Unsupported GEOIP code');
  } else fail(`Unsupported rule type: ${type}`);
  if (option && (option !== 'no-resolve' || !['IP-CIDR', 'IP-CIDR6', 'GEOIP'].includes(type))) fail('Unsupported rule option');
  return [type, value, policy, option].filter(Boolean).join(',');
}
function mock(p, kind, code = '200') {
  if (!/^\d{3}$/.test(code) || +code < 200 || +code > 599) fail('Unsupported mock status code');
  if (kind === 'img') return `${p} data-type=tiny-gif status-code=${code}`;
  const body = { empty: '', dict: '{}', array: '[]' }[kind];
  if (body === undefined) fail('Unsupported mock response');
  const header = kind === 'empty' ? '' : ' header="Content-Type:application/json"';
  return `${p} data-type=text data=${JSON.stringify(body)} status-code=${code}${header}`;
}

/** @returns {{status:'converted'|'unsupported',content:string|null,warnings:string[],reason:string}} */
export function convertPlugin(text, { name, sourceURL } = {}) {
  const warnings = [warningBase];
  let lineNumber = 0;
  try {
    if (typeof text !== 'string' || !text.trim()) fail('Empty or non-text LPX');
    if (text.length > 2_000_000) fail('LPX exceeds size limit');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail('Control character in LPX');
    if (/^\s*(?:<!doctype|<html|\{\s*"|\[\s*\{)/i.test(text)) fail('Input is HTML/JSON, not LPX');
    const title = name === undefined ? '' : oneLine(name, 'name');
    if (sourceURL !== undefined) remoteURL(oneLine(sourceURL, 'sourceURL'));
    const sections = new Map(), notes = [], metadata = new Map();
    let section = '', count = 0, scriptNumber = 0;
    const add = (key, value) => {
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key).push(value); count++;
    };
    const script = (type, p, settings) => {
      if (p.includes(',')) fail('Comma in script pattern requires unsupported quoting');
      const allowed = new Set(['script-path', 'tag', 'requires-body', 'binary-body-mode', 'timeout', 'argument', 'enable']);
      for (const k of settings.keys()) if (!allowed.has(k)) fail(`Unsupported script parameter: ${k}`);
      if (!settings.has('script-path')) fail('Missing script-path');
      const url = remoteURL(settings.get('script-path'));
      if (settings.has('enable') && settings.get('enable') !== 'true') fail('Disabled/dynamic script cannot be silently enabled or omitted');
      const fields = [`type=${type}`, `pattern=${p}`, `script-path=${url}`];
      for (const k of ['requires-body', 'binary-body-mode']) {
        if (settings.has(k)) {
          const v = settings.get(k);
          if (!['true', 'false'].includes(v)) fail(`Invalid ${k}`);
          fields.push(`${k}=${v}`);
        }
      }
      if (settings.get('binary-body-mode') === 'true' && settings.get('requires-body') !== 'true') fail('Binary body mode without requires-body');
      if (settings.has('timeout')) {
        const v = settings.get('timeout');
        if (!/^\d+(?:\.\d+)?$/.test(v) || +v <= 0 || +v > 3600) fail('Invalid timeout');
        fields.push(`timeout=${v}`);
      } else {
        // Loon HTTP scripts default to 10s, Surge defaults to 5s.
        fields.push('timeout=10');
      }
      if (settings.has('argument')) fail('Script arguments require explicit Loon-to-Surge semantic review');
      if (settings.has('tag')) notes.push(`# Source script tag: ${oneLine(settings.get('tag'), 'script tag')}`);
      add('Script', `loon_${++scriptNumber} = ${fields.join(', ')}`);
      warnings.push(`External-script validation required: ${url}; inspect Loon-specific APIs, environment branching and binary $done/body semantics. Script was not fetched or executed.`);
    };
    for (const raw of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
      lineNumber++;
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#!')) {
        const m = /^#!\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
        if (!m) fail('Malformed metadata directive');
        const key = m[1].toLowerCase(), value = m[2];
        if (!META.has(key)) fail(`Unsupported metadata directive: ${key}`);
        if (metadata.has(key)) fail(`Duplicate metadata directive: ${key}`);
        metadata.set(key, value);
        // Source metadata is archived as a plain comment, not executed by Surge.
        notes.push(`# Source metadata: ${line.slice(2)}`);
        continue;
      }
      if (/^(#|;|\/\/)/.test(line)) { notes.push(`# ${raw}`); continue; }
      const h = /^\[([^\]]+)\]$/.exec(line);
      if (h) {
        section = h[1].trim().toLowerCase();
        if (!['rule', 'rewrite', 'url rewrite', 'script', 'mitm'].includes(section)) fail(`Unsupported section: [${h[1]}]`);
        continue;
      }
      if (!section) fail('Directive outside a supported section');
      // Only URL itself and a reviewed capture alias are valid ${...} expressions.
      const placeholders = [...line.matchAll(/\$\{([^}]+)\}/g)].map(m => m[1]);
      if (placeholders.some(x => x !== 'url' && !/^urlMatch\.[1-9]\d*$/.test(x))) fail('Dynamic argument/placeholder is unsupported');
      if (section === 'rule') { add('Rule', rule(line)); continue; }
      if (section === 'mitm') {
        const m = /^hostname\s*=\s*(.+)$/i.exec(line);
        if (!m || sections.has('MITM')) fail('Only one MITM hostname declaration is supported');
        const value = m[1].replace(/^%APPEND%\s*/, '');
        const hosts = value.split(',').map(x => x.trim());
        if (hosts.some(x => !/^-?(?:\*|[a-z0-9_*?][a-z0-9_.*?-]*)(?::\d+)?$/i.test(x))) fail('Invalid or dynamic MITM hostname');
        add('MITM', `hostname = %APPEND% ${hosts.join(', ')}`);
        continue;
      }
      if (section === 'script') {
        if (/^(request|response) if /.test(line)) {
          const c = condition(line);
          const m = /^then script\(("(?:[^"\\]|\\.)*")\)(?: with (.+))?$/.exec(c.tail);
          if (!m) fail('Unsupported script expression or script arguments');
          let url; try { url = JSON.parse(m[1]); } catch { fail('Invalid script URL string'); }
          const s = m[2] ? params(m[2]) : new Map();
          if (s.has('script-path')) fail('Duplicate script path');
          s.set('script-path', url);
          script(`http-${c.phase}`, c.p, s);
        } else {
          const m = /^(http-request|http-response)\s+(\S+)\s+(.+)$/.exec(line);
          if (!m) fail('Only HTTP request/response scripts are supported');
          script(m[1], pattern(m[2]), params(m[3]));
        }
        continue;
      }
      // [Rewrite] (Loon) and [URL Rewrite] are interpreted as Loon source syntax.
      if (/^(request|response) if /.test(line)) {
        const c = condition(line);
        if (c.phase !== 'request') fail('Response body/header rewrite has no verified translation');
        let m = /^then reject(?:_(dict|array|img))?\((\d{3})\)$/.exec(c.tail);
        if (m) { add('Map Local', mock(c.p, m[1] || 'empty', m[2])); continue; }
        // A new Loon redirect returns an entire Location, unlike regex replacement.
        m = /^(?:as urlMatch )?then redirect\((302|307), ("(?:[^"\\]|\\.)*")\)$/.exec(c.tail);
        if (!m) fail('Unsupported request action');
        const hasAlias = c.tail.startsWith('as urlMatch ');
        let target; try { target = JSON.parse(m[2]); } catch { fail('Invalid redirect string'); }
        if (/\$\{/.test(target) && !hasAlias) fail('Redirect capture used without alias');
        if (/\$(?!\{urlMatch\.[1-9]\d*\})/.test(target)) fail('Literal dollar in redirect requires manual review');
        for (const ref of target.matchAll(/\$\{urlMatch\.([1-9]\d*)\}/g)) {
          if (+ref[1] > captureCount(c.raw)) fail('Redirect references a nonexistent capture group');
        }
        target = target.replace(/\$\{urlMatch\.([1-9]\d*)\}/g, '$$$1');
        if (/\$\{|[\s"\\]|\$(?![1-9]\d*)/.test(target) || !/^(?:https?:\/\/|\$[1-9])/.test(target)) fail('Unsupported redirect target');
        // Force a full-URL match so Surge cannot retain unmatched prefixes/suffixes.
        const full = `${c.flags ? '(?i)' : ''}^[\\s\\S]*?(?:${c.raw})[\\s\\S]*$`;
        add('URL Rewrite', `${full} ${target} ${m[1]}`);
        continue;
      }
      let m = /^(\S+)\s+(reject|reject-200|reject-img|reject-dict|reject-array)$/.exec(line);
      if (m) {
        const p = pattern(m[1]);
        if (m[2] === 'reject') add('URL Rewrite', `${p} _ reject`);
        else add('Map Local', mock(p, { 'reject-200': 'empty', 'reject-img': 'img', 'reject-dict': 'dict', 'reject-array': 'array' }[m[2]]));
        continue;
      }
      // Loon order is pattern action replacement, NOT Surge order.
      m = /^(\S+)\s+(302|307|header)\s+(\S+)$/.exec(line);
      if (!m) fail('Unknown or unsupported rewrite directive');
      const p = pattern(m[1]), target = m[3];
      if (!/^https?:\/\//.test(target) || /["\\]|\$\{|\$(?![1-9]\d*)/.test(target)) fail('Unsupported legacy rewrite target');
      for (const ref of target.matchAll(/\$([1-9]\d*)/g)) {
        if (+ref[1] > captureCount(p)) fail('Legacy rewrite references a nonexistent capture group');
      }
      add('URL Rewrite', `${p} ${target} ${m[2]}`);
    }
    if (!count || (count === 1 && sections.has('MITM'))) fail('No actionable supported directives');
    if (metadata.get('system') || metadata.get('system_version')) fail('Source platform/version constraints require manual review');
    if (sections.has('URL Rewrite') && sections.has('Map Local')) fail('Mixed URL Rewrite and Map Local precedence cannot be preserved safely');
    if (sections.has('Map Local')) warnings.push('Map Local text/tiny-gif requires Surge iOS 5.9.1+ or Mac 5.5.1+; response headers may differ from Loon.');
    if (metadata.has('loon_version')) warnings.push('Source Loon version metadata retained as attribution only, not a Surge compatibility claim.');
    const output = [
      `#!name=${title || metadata.get('name') || 'Converted Loon plugin'}`,
      `#!desc=${metadata.get('desc') || 'Conservative offline LPX subset conversion'}`,
      '# Converted from Loon LPX. Original attribution and notices follow.',
      ...(sourceURL ? [`# Source: ${sourceURL}`] : []),
      ...[...new Set(warnings)].map(x => `# WARNING: ${x}`),
      ...notes,
    ];
    for (const [key, lines] of sections) output.push('', `[${key}]`, ...lines);
    return { status: 'converted', content: output.join('\n') + '\n', warnings: [...new Set(warnings)], reason: '' };
  } catch (e) {
    return { status: 'unsupported', content: null, warnings: [...new Set(warnings)], reason: `${lineNumber ? `Line ${lineNumber}: ` : ''}${e.message}` };
  }
}
