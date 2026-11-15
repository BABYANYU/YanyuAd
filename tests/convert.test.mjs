import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPlugin } from '../scripts/convert.mjs';

const ok = text => {
  const r = convertPlugin(text);
  assert.equal(r.status, 'converted', r.reason);
  assert.equal(r.reason, '');
  assert.equal(typeof r.content, 'string');
  assert.ok(Array.isArray(r.warnings));
  assert.ok(!/undefined|NaN/.test(r.content), 'module must not contain undefined/NaN');
  return r;
};
const bad = (text, reason) => {
  const r = convertPlugin(text);
  assert.equal(r.status, 'unsupported', r.content);
  assert.equal(r.content, null);
  assert.match(r.reason, reason || /./);
  return r;
};
const rr = '[Rewrite]\n';
const cond = String.raw`request if ${'${url}'} ~= /^https:\/\/ads\.example\/v\d/i then `;

test('contract: empty, HTML, JSON, invalid type and unsectioned input fail closed', () => {
  for (const s of ['', '   ', null, {}, '<!doctype html>\n<html/>', '<html>oops', '{"error":"blocked"}', 'hostname = example.com']) bad(s);
});
test('no-op module, comments-only and hostname-only are not success', () => {
  for (const s of ['# comment', '#!name=x', '[Rewrite]', '[MitM]\nhostname=x.com']) bad(s, /No actionable/);
});
test('control characters and oversized input fail closed', () => {
  bad('[Rule]\nDOMAIN,x,\u0001REJECT');
  bad('x'.repeat(2_000_001));
});
test('basic rules use only internal policies and keep option order', () => {
  const r = ok('[Rule]\nDOMAIN,ad.example,REJECT\nDOMAIN-SUFFIX,example.org,DIRECT\nDOMAIN-KEYWORD,tracker,REJECT-TINYGIF\nIP-CIDR,203.107.1.1/24,REJECT,no-resolve\nIP-CIDR6,2001:db8::/32,DIRECT,no-resolve\nGEOIP,CN,DIRECT,no-resolve');
  assert.match(r.content, /DOMAIN,ad\.example,REJECT\nDOMAIN-SUFFIX,example\.org,DIRECT/);
  assert.match(r.content, /IP-CIDR,203\.107\.1\.1\/24,REJECT,no-resolve/);
  assert.match(r.content, /IP-CIDR6,2001:db8::\/32,DIRECT,no-resolve/);
});
test('invalid CIDR, unknown rule type and unknown option fail', () => {
  for (const s of ['RULE-SET,file:///etc/passwd,REJECT', 'IP-CIDR,999.1.2.3/24,REJECT', 'IP-CIDR,1.2.3.4/33,REJECT', 'IP-CIDR6,1.2.3.4/24,REJECT', 'DOMAIN,x,REJECT,no-resolve', 'GEOIP,CN,DIRECT,foo', 'DOMAIN,x,REJECT,', 'DOMAIN,x,REJECT,foo,bar', 'UNKNOWN,x,REJECT']) bad('[Rule]\n' + s);
});
test('nested AND/OR/NOT logical rules are preserved with validated leaves', () => {
  const r = ok('[Rule]\nAND, ((URL-REGEX, "^http:\\/\\/.+\\/amdc\\/mobileDispatch"), (USER-AGENT, "AMapiPhone*")), REJECT\n'
    + 'OR, ((DOMAIN-KEYWORD, stun), (AND, ((DOMAIN-SUFFIX, chat.example), (DEST-PORT, 4480)))), REJECT\n'
    + 'NOT, ((DOMAIN, ad.example)), DIRECT');
  assert.match(r.content, /AND,\(\(URL-REGEX,"\^http:\\\/\\\/\.\+\\\/amdc\\\/mobileDispatch"\),\(USER-AGENT,"AMapiPhone\*"\)\),REJECT/);
  assert.match(r.content, /OR,\(\(DOMAIN-KEYWORD,stun\),\(AND,\(\(DOMAIN-SUFFIX,chat\.example\),\(DEST-PORT,4480\)\)\)\),REJECT/);
  assert.match(r.content, /NOT,\(\(DOMAIN,ad\.example\)\),DIRECT/);
  bad('[Rule]\nAND, ((DOMAIN, x)), REJECT');
  bad('[Rule]\nAND, ((DOMAIN, x), (BADTYPE, y)), REJECT');
  bad('[Rule]\nNOT, ((DOMAIN, a), (DOMAIN, b)), REJECT');
});
test('extended Surge rule types are accepted and strictly validated', () => {
  const r = ok('[Rule]\nURL-REGEX, "^https:\\/\\/ads\\.example\\/x", REJECT\nUSER-AGENT, "AdsBot*", REJECT\nDEST-PORT, 8080, REJECT\nSRC-PORT, 1024-65535, DIRECT\nSRC-IP, 192.168.1.0/24, DIRECT\nPROTOCOL, QUIC, REJECT\nPROCESS-NAME, Google Chrome, DIRECT\nIP-ASN, 45090, REJECT, no-resolve\nDOMAIN-SET, https://example.org/domains.txt, REJECT\nRULE-SET, my-ruleset, DIRECT\nDOMAIN-WILDCARD, mquic-*.example.com, REJECT');
  assert.match(r.content, /URL-REGEX,"\^https:\\\/\\\/ads\\\.example\\\/x",REJECT/);
  assert.match(r.content, /IP-ASN,45090,REJECT,no-resolve/);
  for (const s of ['URL-REGEX, "^(", REJECT', 'PROTOCOL, FTP, REJECT', 'DEST-PORT, 70000, REJECT', 'RULE-SET, file:///x, REJECT', 'DOMAIN-WILDCARD, plain.example, REJECT']) bad('[Rule]\n' + s);
});
test('named policies are preserved verbatim with a local policy-group hint', () => {
  const r = ok('[Rule]\nDOMAIN,ad.example,PROXY\nDOMAIN-SUFFIX,old.example,REJECT-DICT');
  assert.match(r.content, /DOMAIN,ad\.example,PROXY/);
  assert.match(r.content, /DOMAIN-SUFFIX,old\.example,REJECT-DICT/);
  assert.match(r.content, /需在本地 Surge 主配置中存在/);
  assert.match(r.content, /REJECT-DICT 为 Loon 专有策略/);
  assert.ok(r.warnings.some(w => w.includes('REJECT-DICT') || w.includes('策略')));
});
test('policy names cannot inject new rules or module directives', () => {
  // A bare second rule line is a legitimate multi-rule plugin, so only single-line
  // policy-field injections belong here.
  for (const s of ['DOMAIN,x,REJECT;DOMAIN,y,DIRECT', 'DOMAIN,x,"A,B"', 'DOMAIN,x,REJECT #x', 'DOMAIN,x,REJECT\tDIRECT']) bad('[Rule]\n' + s);
});
test('metadata provenance and author retained, comments never execute', () => {
  const r = convertPlugin('#!name = 原标题\n#!author = Alice[https://example.org]\n#!homepage = https://source.example\n# License: CC BY-NC-SA 4.0\n; attribution\n[Rule]\nDOMAIN,ads.example,REJECT', { name: '新标题', sourceURL: 'https://source.example/a.lpx' });
  assert.equal(r.status, 'converted');
  assert.match(r.content, /^#!name=新标题/m);
  assert.match(r.content, /原始元数据：author = Alice\[https:\/\/example\.org\]/);
  assert.match(r.content, /License: CC BY-NC-SA 4.0/);
  assert.match(r.content, /# 来源：https:\/\/source\.example\/a\.lpx/);
  assert.match(r.content, /未在 Surge 中实测功能/);
  assert.match(r.content, /由上游插件配置自动转换/);
});
test('unknown metadata and duplicate directives are not ignored', () => {
  for (const m of ['#!arguments=x:true', '#!if=true', '#!requirement=CORE_VERSION>20', '#!name=a\n#!name=b']) bad(m + '\n[Rule]\nDOMAIN,x,REJECT');
});
test('platform metadata becomes #!system and version is only a warning', () => {
  const r = ok('#!system = ios\n#!system_version = 15\n[Rule]\nDOMAIN,x,REJECT');
  assert.match(r.content, /^#!system=ios$/m);
  assert.ok(r.warnings.some(w => w.includes('系统版本要求')));
  bad('#!system = windows\n[Rule]\nDOMAIN,x,REJECT', /system constraint/);
});
test('options cannot inject module directives or URL credentials', () => {
  const s = '[Rule]\nDOMAIN,x,REJECT';
  for (const options of [{ name: 'x\n[General]' }, { sourceURL: 'https://u:p@example.org/a' }, { sourceURL: 'file:///tmp/a' }, { sourceURL: 'https://example.org/a#fragment' }]) assert.equal(convertPlugin(s, options).status, 'unsupported');
});
test('BOM CRLF and case-insensitive supported section names', () => {
  assert.match(ok('\uFEFF#!name=x\r\n[rUlE]\r\nDOMAIN,x,REJECT\r\n[mItM]\r\nhostname=x').content, /hostname = %APPEND% x/);
});
test('MITM always appends, never replaces certificate or user hostnames', () => {
  const r = ok('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nhostname = %APPEND% *.example.com, -safe.example.com, foo.example.com:443');
  assert.match(r.content, /hostname = %APPEND% \*\.example\.com, -safe\.example\.com, foo\.example\.com:443/);
  bad('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nca-passphrase=oops');
  bad('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nhostname=x\nhostname=y');
  bad('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nhostname=x,');
});
test('unknown sections still fail closed', () => {
  for (const section of ['Proxy', 'Unknown', 'Rule Set']) bad('[Rule]\nDOMAIN,x,REJECT\n[' + section + ']', /Unsupported section/);
});

// ---------------------------------------------------------------- [Argument]

test('switch and select arguments become #!arguments with their Loon defaults', () => {
  const r = ok('[Argument]\n'
    + 'displayUpList = select, "auto", "show", "hide", tag = 显示方式, desc = auto: 自动\n'
    + 'Task-WeChatPay = switch, true, false, tag = 任务\n'
    + 'off = switch, false, true, tag = 默认关闭\n'
    + '[Rule]\nDOMAIN,x,REJECT');
  assert.match(r.content, /^#!arguments=displayUpList:auto,Task_WeChatPay:true,off:false$/m);
  assert.match(r.content, /参数 displayUpList（Loon: displayUpList）= auto/);
  assert.match(r.content, /#!arguments-desc=/);
});
test('argument placeholders stay configurable and are rewritten to Surge triple braces', () => {
  const r = ok('[Argument]\nTask-WeChatPay = switch, true, false, tag = 任务\n'
    + '[Rule]\nDOMAIN,x,REJECT\n'
    + '[Script]\nrequest if ${url} ~= /^https:\\/\\/x\\//i then script("https://e.example/a.js", {${Task-WeChatPay}}) with enable=${Task-WeChatPay}');
  assert.match(r.content, /argument="Task_WeChatPay=\{\{\{Task_WeChatPay\}\}\}"/);
  assert.ok(!r.content.includes('enable='), 'enable must not be emitted as an unsupported Surge parameter');
  assert.ok(r.content.includes('{{{Task_WeChatPay}}}'));
});
test('Loon defaults are never frozen into the body or dropped', () => {
  const r = ok('[Argument]\ncron = input, "0 8 * * *", tag = 定时\n[Rule]\nDOMAIN,x,REJECT\n[Script]\ncron ${cron} then script("https://e.example/a.js")');
  assert.match(r.content, /^#!arguments=cron$/m);          // spaces cannot be a default value
  assert.match(r.content, /# 参数 cron（Loon: cron）= 0 8 \* \* \*/); // default still documented
  assert.match(r.content, /cronexp="\{\{\{cron\}\}\}"/);
});
test('legacy #!select / #!input metadata become ASCII-named Surge arguments', () => {
  const r = ok('#!select = 弹窗通知, true, false\n#!input = APP_ID\n[Rule]\nDOMAIN,x,REJECT');
  assert.match(r.content, /^#!arguments=param_1:true,APP_ID$/m);
  assert.match(r.content, /参数 param_1（Loon: 弹窗通知）/);
});
test('duplicate argument keys and unsafe names are rejected', () => {
  bad('[Argument]\na = switch, true, false\na = switch, true, false\n[Rule]\nDOMAIN,x,REJECT', /Duplicate argument/);
  bad('[Argument]\na = switch, true, false, tag = x\n[Rule]\nDOMAIN,${a},REJECT', /Invalid domain rule/);
});
test('undeclared placeholders remain a hard failure', () => {
  bad('[Rule]\nDOMAIN,${host},REJECT', /Invalid domain rule/);
  bad('[Script]\nrequest if ${url} ~= /^https:\\/\\/x\\//i then script("https://e.example/a.js", {${nope}})', /Undeclared script argument|No actionable/);
});

// ---------------------------------------------------------------- rewrites: request

test('legacy Loon rewrite ordering is translated, not mistaken for Surge ordering', () => {
  const c = ok(rr + '^https://x/ 302 https://y/\n^https://z/ header https://q/\n^https://a/ reject').content;
  // Loon writes `pattern action target`; Surge wants `pattern target action`, and the
  // pattern is wrapped so a prefix match cannot retain the original URL suffix.
  assert.ok(c.includes('(?:^https://x/)[\\s\\S]*$ https://y/ 302'), c);
  assert.ok(c.includes('(?:^https://z/)[\\s\\S]*$ https://q/ header'), c);
  assert.match(c, /^\^https:\/\/a\/ _ reject$/m);
  bad(rr + '^https://x/ https://y/ 302');
  bad(rr + '^https://x/ header-add Foo bar');
});
test('legacy JSON array, dict, GIF and empty reject map to documented Map Local', () => {
  const r = ok(rr + '^https://a/ reject-dict\n^https://b/ reject-array\n^https://c/ reject-img\n^https://d/ reject-200');
  assert.match(r.content, /data-type=text data="\{\}" status-code=200 header="Content-Type:application\/json"/);
  assert.match(r.content, /data-type=text data="\[\]"/);
  assert.match(r.content, /data-type=tiny-gif status-code=200/);
  assert.match(r.content, /data-type=text data="" status-code=200/);
  assert.ok(r.warnings.some(x => x.includes('5.9.1')));
});
test('new request reject variants preserve explicit status and regex i flag', () => {
  const r = ok(rr + cond + 'reject_dict(200)\n' + cond + 'reject_array(403)\n' + cond + 'reject_img(200)\n' + cond + 'reject(404)');
  assert.match(r.content, /\(\?i\)\^https:\/\/ads\\\.example\/v\\d/);
  assert.match(r.content, /data="\[\]" status-code=403/);
  assert.match(r.content, /data="" status-code=404/);
});
test('new fixed redirect is a whole Location and full-URL match', () => {
  const r = ok(rr + cond + 'redirect(302, "https://safe.example/")');
  assert.match(r.content, /\(\?i\)\^\[\\s\\S\]\*\?\(\?:/);
  assert.match(r.content, /\[\\s\\S\]\*\$ https:\/\/safe\.example\/ 302/);
});
// Real QQ LPX excerpt from loon.103516.xyz/Plugin/QQ.lpx (Loon UA).
test('real QQ capture alias redirect translates ${urlMatch.2} to $2', () => {
  const line = String.raw`request if ${'${url}'} ~= /(^https:\/\/c\.pc\.qq\.com\/middlem\.html\?pfurl=)(http.*)(&pfuin=.*)/i as urlMatch then redirect(307, "${'${urlMatch.2}'}")`;
  assert.match(ok(rr + line).content, / \$2 307\n/);
  bad(rr + line.replace('as urlMatch ', ''), /alias/);
});
test('url.replace uses Surge header-mode rewrite and keeps captures', () => {
  const r = ok(rr + 'request if ${url} ~= /^https:\\/\\/a\\.example\\/v1\\/(x)/i as urlMatch then url.replace("https://b.example/v2/${urlMatch.1}")');
  assert.match(r.content, /\[\\s\\S\]\*\$ https:\/\/b\.example\/v2\/\$1 header/);
});
test('literal dollars and nonexistent capture groups cannot change redirect semantics', () => {
  bad(rr + cond + 'redirect(302, "https://safe.example/$2")', /Literal dollar/);
  bad(rr + cond.replace(' then ', ' as urlMatch then ') + 'redirect(307, "${urlMatch.99}")', /nonexistent capture/);
});
test('regex parser handles escaped delimiters and rejects flags it cannot preserve', () => {
  for (const line of [cond.replace('/i then', '/g then'), cond.replace('/i then', '/im then'), cond.replace('/i then', ' then')]) bad(rr + line + 'reject(200)');
  bad(rr + '^https://[ reject');
  bad(rr + 'request if ${url} != /^https:\\/\\/x\\//i then reject(200)', /inequality/);
});

// ---------------------------------------------------------------- rewrites: response

test('response.json.jq becomes a jq Body Rewrite rule', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.jq(".data=[]")`);
  assert.match(r.content, /\[Body Rewrite\]\nhttp-response-jq \(\?i\)\^https:\/\/a\\\.example\/ '\.data=\[\]'/);
  assert.ok(r.warnings.some(w => w.includes('5.14')));
});
test('response.json.delete becomes delpaths for one path and for arrays', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.delete(["data.tipsOperationLocation", "obj.data.resourcePlacement"])`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/b\.example\//i then response.json.delete("data.common_equip")`);
  assert.match(r.content, /'delpaths\(\[\["data","tipsOperationLocation"\], \["obj","data","resourcePlacement"\]\]\)'/);
  assert.match(r.content, /'delpaths\(\[\["data","common_equip"\]\]\)'/);
});
test('response.json.replace becomes equivalent jq assignments', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.replace("user.shake_ad_switch.is_show", 0)`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/b\.example\//i then response.json.replace(["wl_config.home_ad_num", "wl_config.index_bear_first_floor_max"], [0, 999999999])`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/c\.example\//i then response.json.replace("data", ` + '`{}`)');
  assert.match(r.content, /'\.user\.shake_ad_switch\.is_show = 0'/);
  assert.match(r.content, /'\.wl_config\.home_ad_num = 0 \| \.wl_config\.index_bear_first_floor_max = 999999999'/);
  assert.match(r.content, /'\.data = \{\}'/);
});
test('embedded bracket paths keep their exact key names in jq', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.replace("data[\"/service/settings/v3/\"].body.enabled", false)`);
  assert.match(r.content, /'\.data\["\/service\/settings\/v3\/"\]\.body\.enabled = false'/);
  bad(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.replace("data[oops]", 0)`, /JSON path/);
});
test('response.body.mock maps json, text and base64 bodies to Map Local', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.body.mock("json", "{\"no\":0}", 200)`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/b\.example\//i then response.body.mock("text", "plain", 404)`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/c\.example\//i then response.body.mock("text", "AAAAAAA=", 200, true)`);
  assert.match(r.content, /data-type=text data="\{\\"no\\":0\}" status-code=200 header="Content-Type:application\/json"/);
  assert.match(r.content, /data-type=text data="plain" status-code=404/);
  assert.match(r.content, /data-type=base64 data="AAAAAAA=" status-code=200/);
});
test('response.body.replace maps to Body Rewrite, including regex arrays', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.body.replace(/"TAG_AD_INFO"/, "\"fmz200\"")`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/b\.example\//i then response.body.replace([/foo/, /bar/], ["x", "y"])`);
  assert.match(r.content, /http-response \(\?i\)\^https:\/\/a\\\.example\/ "TAG_AD_INFO" "fmz200"/);
  assert.match(r.content, /http-response \(\?i\)\^https:\/\/b\\\.example\/ foo x\n/);
  assert.match(r.content, /http-response \(\?i\)\^https:\/\/b\\\.example\/ bar y/);
});
test('response header set/add/del/replace use Header Rewrite with set semantics', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.header.add("Content-Disposition", "inline")`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/b\.example\//i then response.header.set("grpc-status", "0")`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/c\.example\//i then response.header.del("Set-Cookie")`
    + '\n' + String.raw`request if ${'${url}'} ~= /^https:\/\/d\.example\//i then request.header.replace("methodname", /Get.*List/, "null")`);
  assert.match(r.content, /http-response \(\?i\)\^https:\/\/a\\\.example\/ header-add Content-Disposition inline/);
  assert.match(r.content, /header-del grpc-status\nhttp-response \(\?i\)\^https:\/\/b\\\.example\/ header-add grpc-status 0/);
  assert.match(r.content, /http-response \(\?i\)\^https:\/\/c\\\.example\/ header-del Set-Cookie/);
  assert.match(r.content, /http-request \(\?i\)\^https:\/\/d\\\.example\/ header-replace-regex methodname Get\.\*List null/);
});
test('mock plus header.set is folded into the Map Local header list', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.body.mock("text", "AAAAAAA=", 200, true) | response.header.set("grpc-status", "0")`);
  assert.match(r.content, /data-type=base64 data="AAAAAAA=" status-code=200 header="grpc-status: 0"/);
});
test('unknown response actions are annotated, never silently dropped', () => {
  const r = ok('[Rule]\nDOMAIN,x,REJECT\n' + rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.body.mock_file("json", "https://e.example/a.json", 200)`);
  assert.match(r.content, /未完全等价的动作/);
  assert.match(r.content, /mock_file 依赖远端资源/);
  assert.ok(r.warnings.some(w => w.includes('无法完全等价')));
});
test('runtime-only conditions are dropped with an explicit note', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i && ${'${response.status}'} == 200 then response.json.jq(".a=[]")`);
  assert.match(r.content, /# 已省略运行时判断：\$\{response\.status\} == 200/);
  assert.ok(r.warnings.some(w => w.includes('运行时判断')));
});
test('parameter-gated branches keep Surge/default and drop other clients explicitly', () => {
  const t = '[Argument]\ntarget = select, "Loon", "Surge", "Egern"\n[Rule]\nDOMAIN,x,REJECT\n[Rewrite]\n'
    + String.raw`response if ${'${target}'} == "Surge" && ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.jq(".a=[]")`
    + '\n' + String.raw`response if ${'${target}'} == "Egern" && ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.jq(".b=[]")`;
  const r = ok(t);
  assert.match(r.content, /'\.a=\[\]'/);
  assert.ok(!r.content.includes("'.b=[]'"));
  assert.ok(r.warnings.some(w => w.includes('面向其他客户端')));
});
test('malformed action arguments still fail closed instead of emitting', () => {
  bad(rr + cond + 'reject_dict(200) # trailing', /No actionable|Unsupported action/);
  bad(rr + cond + 'reject_dict(200) with enable=${switch}', /No actionable|Unsupported action/);
});
test('mixed mock and URL Rewrite on the same pattern is rejected conservatively', () => {
  bad(rr + '^https://x/ reject-dict\n^https://x/ 302 https://y/', /precedence/);
  ok(rr + '^https://x/ reject-dict\n^https://y/ 302 https://z/');
});

// ---------------------------------------------------------------- scripts

// Real AppRaven LPX excerpt; author Yu9191. No script download in unit tests.
const appRaven = String.raw`#!name = AppRaven
#!author = Yu9191[https://github.com/Yu9191]
[Script]
response if ${'${url}'} ~= /^https:\/\/appraven\.net\/appraven\/graphql/i then script("https://loon.103516.xyz/Script/AppRaven/AppRaven.js") with tag="[AppRaven]会员Crack", requires_body=true
[MitM]
hostname = appraven.net`;
test('real AppRaven script reference converts with mandatory validation warning', () => {
  const r = ok(appRaven);
  assert.match(r.content, /plugin_1 = type=http-response, pattern=\(\?i\)\^https:\/\/appraven/);
  assert.match(r.content, /requires-body=true, timeout=10/);
  assert.match(r.content, /hostname = %APPEND% appraven.net/);
  assert.ok(r.warnings.some(x => x.includes('https://loon.103516.xyz/Script/AppRaven/AppRaven.js')));
  assert.match(r.content, /Yu9191/);
});
test('legacy HTTP scripts have validated booleans and generated unique names', () => {
  const r = ok('[Script]\nhttp-request ^https://x/ script-path=https://example.org/a.js,tag="a,b",requires-body=true,binary-body-mode=true,timeout=20\nhttp-response ^https://y/ script-path=https://example.org/b.js,enable=true');
  assert.match(r.content, /plugin_1 = type=http-request/);
  assert.match(r.content, /plugin_2 = type=http-response/);
  assert.match(r.content, /原始脚本标签：a,b/);
  assert.match(r.content, /binary-body-mode=true/);
});
test('Loon script argument objects become a Surge argument string', () => {
  const r = ok('[Argument]\nlogLevel = select, "error", "info"\n[Script]\n'
    + String.raw`response if ${'${url}'} ~= /^https:\/\/x\//i then script("https://e.example/a.js", {${'${logLevel}'}}) with tag="t"`);
  assert.match(r.content, /argument="logLevel=\{\{\{logLevel\}\}\}"/);
});
test('cron, generic and network-changed scripts map to Surge script types', () => {
  const r = ok('[Script]\ncron "0 8 * * *" then script("https://e.example/a.js") with tag="task"\n'
    + 'generic then script("https://e.example/b.js") with img_url="lock"\n'
    + 'network-changed then script("https://e.example/c.js")');
  assert.match(r.content, /type=cron, cronexp="0 8 \* \* \*"/);
  assert.match(r.content, /type=generic, script-path=https:\/\/e\.example\/b\.js/);
  assert.match(r.content, /type=event, event-name=network-changed/);
  assert.ok(r.warnings.some(w => w.includes('img_url')));
});
test('unknown script parameters and local URLs never produce a silent success', () => {
  for (const suffix of [',foo=1', ',timeout=0', ',timeout=abc', ',requires-body=1', ',binary-body-mode=true']) {
    bad('[Script]\nhttp-request ^https://x/ script-path=https://x/a.js' + suffix, /No actionable|Invalid|Binary body mode/);
  }
  for (const path of ['foo.js', 'file:///a.js', 'https://u:p@x/a.js', 'https://x/a.js#frag']) bad('[Script]\nhttp-request ^https://x/ script-path=' + path, /No actionable|Unsafe|Invalid/);
});
test('scripts disabled in the source are preserved as commented placeholders', () => {
  const r = ok('[Argument]\nTask = switch, false, true\n[Script]\ncron "0 8 * * *" then script("https://e.example/a.js", {${Task}}) with enable=${Task}');
  assert.doesNotMatch(r.content, /\nplugin_1 = /);
  assert.match(r.content, /# plugin_1 = type=cron/);
  assert.ok(r.warnings.some(w => w.includes('默认关闭')));
});
test('unsupported script families are annotated, not fatal', () => {
  const r = ok('[Rule]\nDOMAIN,x,REJECT\n[Script]\ntimer "0 8 * * *" then script("https://e.example/a.js")');
  assert.match(r.content, /未完全等价的动作/);
  assert.match(r.content, /Only HTTP request\/response/);
});

// ---------------------------------------------------------------- [General] / [Host]

test('[General] settings are preserved as comments and never become a module section', () => {
  const r = ok('[General]\nforce-http-engine-hosts = script.hub, *.script.hub\n[Rule]\nDOMAIN,x,REJECT');
  assert.ok(!/^\[General\]$/m.test(r.content));
  assert.match(r.content, /#   force-http-engine-hosts = script\.hub, \*\.script\.hub/);
  assert.ok(r.warnings.some(w => w.includes('[General]')));
});
test('[Host]/[IP Rewrite] are documented but a plugin made only of them is not published', () => {
  const r = ok('[Host]\ndns.example = server:1.1.1.1\n[Rule]\nDOMAIN,x,REJECT');
  assert.match(r.content, /#   \[host\] dns\.example = server:1\.1\.1\.1/);
  bad('[General]\ndns-server = 1.1.1.1\n[Host]\ndns.example = server:1.1.1.1', /No actionable/);
  bad('[General]\nipv6-vif = off\ninclude-tun = 10.7.0.1/32\n[IP Rewrite]\n10.7.0.1 = reflect', /No actionable/);
});

// ---------------------------------------------------------------- module shape

test('every converted module starts with #!name and contains a Surge section', () => {
  const samples = [appRaven,
    '[Rule]\nDOMAIN,x,REJECT\n[Rewrite]\nrequest if ${url} ~= /^https:\\/\\/a\\.example\\//i then reject(200)',
    '[Rule]\nDOMAIN,x,REJECT\n[MitM]\nhostname=a.example'];
  for (const s of samples) {
    const r = ok(s);
    assert.match(r.content, /^#!name=/);
    assert.match(r.content, /^\[(Rule|Body Rewrite|Header Rewrite|Map Local|URL Rewrite|Script|MITM)\]$/m);
    assert.ok(!/undefined|NaN/.test(r.content));
  }
});
test('conversion is deterministic and has no fetching or source mutation', () => {
  assert.deepEqual(convertPlugin(appRaven), convertPlugin(appRaven));
  assert.equal(appRaven.includes('%APPEND%'), false);
});
test('lone CR becomes a real input line rather than injected module output', () => {
  // A lone CR is a line separator, never a way to smuggle a directive into the same line.
  const r = ok('#!desc=first\r[General]\ralways-real-ip=*\ralways-real-ip2=*\r[Rule]\rDOMAIN,x,REJECT');
  assert.match(r.content, /^#!desc=first$/m);
  assert.match(r.content, /^#   always-real-ip=\*$/m);
  assert.match(r.content, /^#   always-real-ip2=\*$/m);
  assert.match(r.content, /^DOMAIN,x,REJECT$/m);
  assert.ok(!r.content.includes('\r'));
  ok('[Rule]\rDOMAIN,x,REJECT');
});

test('port bounds and source CIDRs reject malformed rules while keeping valid comparisons',()=>{
 for(const v of ['1-99999','443-80','>65536','>10-20'])bad('[Rule]\nDEST-PORT,'+v+',REJECT',/port/);
 for(const v of ['not-an-ip/999','192.0.2.1/33','2001:db8::/129','1.2.3.4/','192.0.2.1/24/1'])bad('[Rule]\nSRC-IP,'+v+',DIRECT',/source IP/);
 for(const v of ['>=50000','<=443','80-81'])ok('[Rule]\nSRC-PORT,'+v+',DIRECT');
 ok('[Rule]\nSRC-IP,2001:db8::/32,DIRECT');
});
test('out-of-range numeric action arguments never emit Infinity into a module',()=>{
 bad(rr+'response if ${url} == \"https://example.org/\" then response.json.replace(\"value\",'+ '9'.repeat(400)+')',/Numeric argument/);
});

test('body and header regex i flags survive conversion', () => {
  const r = ok(rr + String.raw`response if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.body.replace(/foo/i, "bar")`
    + '\n' + String.raw`response if ${'${url}'} ~= /^https:\/\/b\.example\//i then response.header.replace("X-Test", /foo/i, "bar")`);
  assert.ok(r.content.includes('(?i)foo bar'));
  assert.ok(r.content.includes('header-replace-regex X-Test (?i)foo bar'));
});

test('request JSON actions cannot be emitted as response rewrites', () => {
  bad(rr + String.raw`request if ${'${url}'} ~= /^https:\/\/a\.example\//i then response.json.jq(".x=0")`, /只能用于 response/);
});

test('quoted script values reject trailing source', () => {
  bad('[Script]\nhttp-request ^https://x/ script-path="https://e.example/a.js"junk', /Trailing characters/);
  bad(String.raw`[Script]
cron "* * * * *" then script("https://e.example/a.js" junk)`, /Trailing characters|Malformed script argument/);
});

test('legacy script arguments survive quoted commas, equals and escaped quotes', () => {
  for (const argument of ['foo=bar&enabled=false', 'list=a,b&name="demo"', 'path=one\\two', '']) {
    const r = ok('[Script]\nhttp-request ^https://x/ script-path=https://e.example/a.js,argument=' + JSON.stringify(argument));
    if (argument) assert.ok(r.content.includes('argument=' + JSON.stringify(argument)), r.content);
    else assert.doesNotMatch(r.content, /, argument=/);
  }
  const r = ok('[Script]\nhttp-response ^https://x/ script-path=https://e.example/a.js,argument=foo=bar');
  assert.ok(r.content.includes('argument="foo=bar"'));
});

test('script call arguments reject trailing tokens and ambiguous duplicate sources', () => {
  for (const suffix of [' junk', ', "extra"', ',']) {
    bad('[Rule]\nDOMAIN,x,REJECT\n[Script]\ncron "0 8 * * *" then script("https://e.example/a.js", "foo=bar"' + suffix + ')', /Trailing characters|Malformed script argument/);
  }
  bad('[Script]\ncron "0 8 * * *" then script("https://e.example/a.js", "foo=bar") with argument="other=value"', /Duplicate script argument/);
  const r = ok('[Script]\ncron "0 8 * * *" then script("https://e.example/a.js", "foo=bar"   )');
  assert.ok(r.content.includes('argument="foo=bar"'));
});

test('URL regex normalization preserves whitespace semantics and quantifiers across sections', () => {
  const condition = String.raw`response if ${'${url}'} ~= /^https:\/\/x\/a b\d{1, 3}/i then `;
  const expected = String.raw`(?i)^https://x/a\x20b\d{1,3}`;
  for (const [section, action] of [
    ['Rewrite', 'response.json.jq(".a=[]")'],
    ['Rewrite', 'response.header.del("X-Test")'],
    ['Rewrite', 'response.body.mock("text", "x", 200)'],
    ['Script', 'script("https://e.example/a.js")'],
  ]) {
    const r = ok('[' + section + ']\n' + condition + action);
    assert.ok(r.content.includes(expected), r.content);
    assert.ok(!r.content.includes('/a b'), r.content);
  }
  const r = ok('[Rewrite]\n' + condition.replace('response if', 'request if') + 'redirect(302, "https://safe.example/")');
  assert.ok(r.content.includes(String.raw`a\x20b\d{1,3}`));
});

test('escaped argument defaults cannot inject module sections', () => {
  bad(String.raw`[Argument]
a = input, "x\n[Rule]\nDOMAIN,injected.example,DIRECT"
[Rule]
DOMAIN,x,REJECT`, /Control character/);
});
