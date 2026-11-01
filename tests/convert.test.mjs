import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPlugin } from '../scripts/convert.mjs';

const ok = text => {
  const r = convertPlugin(text);
  assert.equal(r.status, 'converted', r.reason);
  assert.equal(r.reason, '');
  assert.equal(typeof r.content, 'string');
  assert.ok(Array.isArray(r.warnings));
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
test('basic rules use only internal policies and preserve order', () => {
  const r = ok('[Rule]\nDOMAIN,ad.example,REJECT\nDOMAIN-SUFFIX,example.org,DIRECT\nDOMAIN-KEYWORD,tracker,REJECT-TINYGIF\nIP-CIDR,203.107.1.1/24,REJECT,no-resolve\nIP-CIDR6,2001:db8::/32,DIRECT,no-resolve\nGEOIP,CN,DIRECT,no-resolve');
  assert.match(r.content, /DOMAIN,ad.example,REJECT\nDOMAIN-SUFFIX/);
  assert.match(r.content, /IP-CIDR6,2001:db8::\/32,DIRECT,no-resolve/);
});
test('invalid CIDR, unknown type, foreign policy and unknown option fail', () => {
  for (const s of ['DOMAIN,x,Proxy', 'RULE-SET,https://x/a,REJECT', 'IP-CIDR,999.1.2.3/24,REJECT', 'IP-CIDR,1.2.3.4/33,REJECT', 'IP-CIDR6,1.2.3.4/24,REJECT', 'DOMAIN,x,REJECT,no-resolve', 'GEOIP,CN,DIRECT,foo', 'DOMAIN,x,REJECT,', 'DOMAIN,x,REJECT,foo,bar']) bad('[Rule]\n'+s);
});
test('all unsupported sections, even empty argument sections, fail closed', () => {
  for (const section of ['Argument', 'General', 'Host', 'IP Rewrite', 'Proxy', 'Unknown']) bad('[Rule]\nDOMAIN,x,REJECT\n['+section+']', /Unsupported section/);
});
test('metadata provenance and author retained, comments never execute', () => {
  const r = convertPlugin('#!name = 原标题\n#!author = Alice[https://example.org]\n#!homepage = https://source.example\n# License: CC BY-NC-SA 4.0\n; attribution\n[Rule]\nDOMAIN,ads.example,REJECT', { name: '新标题', sourceURL: 'https://source.example/a.lpx' });
  assert.equal(r.status, 'converted');
  assert.match(r.content, /^#!name=新标题/m);
  assert.match(r.content, /原始元数据：author = Alice\[https:\/\/example.org\]/);
  assert.match(r.content, /License: CC BY-NC-SA 4.0/);
  assert.match(r.content, /# 来源：https:\/\/source.example\/a.lpx/);
  assert.match(r.content, /未在 Surge 中实测功能/);
});
test('unknown metadata, duplicate directives and dynamic arguments are not ignored', () => {
  for (const m of ['#!arguments=x:true', '#!input=x', '#!if=true', '#!name=a\n#!name=b', '#!system=ios', '#!system_version=17']) bad(m+'\n[Rule]\nDOMAIN,x,REJECT');
  bad('[Rule]\nDOMAIN,${host},REJECT', /placeholder/);
  bad(rr+cond+'reject_dict(200) with enable=${switch}', /placeholder/);
});
test('options cannot inject module directives or URL credentials', () => {
  const s = '[Rule]\nDOMAIN,x,REJECT';
  for (const options of [{name:'x\n[General]'}, {sourceURL:'https://u:p@example.org/a'}, {sourceURL:'file:///tmp/a'}, {sourceURL:'https://example.org/a#fragment'}]) assert.equal(convertPlugin(s, options).status, 'unsupported');
});
test('BOM CRLF and case-insensitive supported section names', () => {
  assert.match(ok('\uFEFF#!name=x\r\n[rUlE]\r\nDOMAIN,x,REJECT\r\n[mItM]\r\nhostname=x').content, /hostname = %APPEND% x/);
});
test('MITM always appends, never replaces certificate or user hostnames', () => {
  const r = ok('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nhostname = %APPEND% *.example.com, -safe.example.com, foo.example.com:443');
  assert.match(r.content, /hostname = %APPEND% \*\.example.com, -safe.example.com, foo.example.com:443/);
  bad('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nca-passphrase=oops');
  bad('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nhostname=x\nhostname=y');
  bad('[Rule]\nDOMAIN,x,REJECT\n[MitM]\nhostname=x,');
});
test('legacy Loon rewrite ordering is translated, not mistaken for Surge ordering', () => {
  assert.match(ok(rr+'^https://x/ 302 https://y/\n^https://z/ header https://q/\n^https://a/ reject').content, /\^https:\/\/x\/ https:\/\/y\/ 302/);
  bad(rr+'^https://x/ https://y/ 302');
  bad(rr+'^https://x/ header-add Foo bar');
});
test('legacy JSON array, dict, GIF and empty reject map to documented Map Local', () => {
  const r = ok(rr+'^https://a/ reject-dict\n^https://b/ reject-array\n^https://c/ reject-img\n^https://d/ reject-200');
  assert.match(r.content, /data-type=text data="\{\}" status-code=200 header="Content-Type:application\/json"/);
  assert.match(r.content, /data-type=text data="\[\]"/);
  assert.match(r.content, /data-type=tiny-gif status-code=200/);
  assert.match(r.content, /data-type=text data=""/);
  assert.ok(r.warnings.some(x => x.includes('5.9.1')));
});
test('new request reject variants preserve explicit status and regex i flag', () => {
  const r = ok(rr+cond+'reject_dict(200)\n'+cond+'reject_array(403)\n'+cond+'reject_img(200)\n'+cond+'reject(404)');
  assert.match(r.content, /\(\?i\)\^https:\/\/ads\\.example\/v\\d/);
  assert.match(r.content, /data="\[\]" status-code=403/);
  assert.match(r.content, /data="" status-code=404/);
});
test('new unsupported responses and actions fail atomically, not partial success', () => {
  for (const tail of ['response.json.jq(".a=[]")', 'reject()', 'reject_dict(100)', 'reject(600)', 'reject_dict(200) with enable=false', 'reject_dict(200) # trailing']) bad('[Rule]\nDOMAIN,x,REJECT\n'+rr+cond+tail);
  bad(rr+cond.replace('request if','response if')+'reject_dict(200)', /Response/);
});
test('mixed mock and URL Rewrite precedence is rejected conservatively', () => {
  bad(rr+'^https://x/ reject-dict\n^https://x/ 302 https://y/', /precedence/);
});
test('new fixed redirect is a whole Location and full-URL match', () => {
  const r = ok(rr+cond+'redirect(302, "https://safe.example/")');
  assert.match(r.content, /\(\?i\)\^\[\\s\\S\]\*\?\(\?:/);
  assert.match(r.content, /\[\\s\\S\]\*\$ https:\/\/safe.example\/ 302/);
});
// Real QQ LPX excerpt from loon.103516.xyz/Plugin/QQ.lpx (Loon UA).
test('real QQ capture alias redirect translates ${urlMatch.2} to $2', () => {
  const line = String.raw`request if ${'${url}'} ~= /(^https:\/\/c\.pc\.qq\.com\/middlem\.html\?pfurl=)(http.*)(&pfuin=.*)/i as urlMatch then redirect(307, "${'${urlMatch.2}'}")`;
  assert.match(ok(rr+line).content, / \$2 307\n/);
  bad(rr+line.replace('as urlMatch ', ''), /alias/);
});
test('regex parser handles escaped delimiters and rejects flags/conditions it cannot preserve', () => {
  for (const line of [cond.replace('/i then','/g then'), cond.replace('~=','!='), cond.replace('/i then','/im then'), cond.replace('/i then',' then')]) bad(rr+line+'reject(200)');
  bad(rr+'^https://[ reject');
});

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
test('unknown script parameter or local URL never produces success', () => {
  for (const suffix of [',foo=1', ',enable=false', ',timeout=0', ',timeout=abc', ',requires-body=1', ',binary-body-mode=true', ',argument="x=1"', ',requires-body=true,requires_body=false', ',tag="unclosed', ',tag="a" garbage']) bad('[Script]\nhttp-request ^https://x/ script-path=https://x/a.js'+suffix);
  for (const path of ['foo.js', 'file:///a.js', 'https://u:p@x/a.js', 'https://x/a.js#frag']) bad('[Script]\nhttp-request ^https://x/ script-path='+path);
});
test('script arguments and task-only semantics are unsupported, not frozen', () => {
  bad(appRaven.replace('AppRaven.js")', 'AppRaven.js", {"x":true})'), /arguments/);
  bad('[Script]\ncron "0 8 * * *" then script("https://x/a.js")');
  bad('[Script]\ngeneric then script("https://x/a.js")');
  bad(appRaven.replace('requires_body=true', 'requires_body=${switch}'), /placeholder/);
});
test('script regex comma quoting and unknown conditional settings fail closed', () => {
  bad(appRaven.replace('graphql/i', 'graphql.{1,3}/i'), /Comma/);
  bad(appRaven.replace('requires_body=true', 'requires_body=true, img_url="foo"'), /Unsupported script parameter/);
});
test('actual newer JSON jq source is unsupported even after valid rule', () => {
  const r = bad(String.raw`#!name=阿里云盘
[Rule]
IP-CIDR,203.107.1.1/24,REJECT,no-resolve
[Rewrite]
response if ${'${url}'} ~= /^https:\/\/(biz)?api\.alipan\.com\/apps\/v\d\/users?\/home\/news/i then response.json.jq(".result=[]")`, /Response/);
  assert.equal(r.content, null);
});
test('malicious/unknown non-comment directives cannot hide after supported lines', () => {
  for (const tail of ['unknown=1', 'include=https://evil/', '[Rewrite]\nunsupported expression', '#!requirement=anything']) bad('[Rule]\nDOMAIN,x,REJECT\n'+tail);
});
test('conversion is deterministic and has no fetching or source mutation', () => {
  assert.deepEqual(convertPlugin(appRaven), convertPlugin(appRaven));
  assert.equal(appRaven.includes('%APPEND%'), false);
});

test('literal dollars and nonexistent capture groups cannot change redirect semantics', () => {
  bad(rr+cond+'redirect(302, "https://safe.example/$2")', /Literal dollar/);
  bad(rr+cond.replace(' then ', ' as urlMatch then ')+'redirect(307, "${urlMatch.99}")', /nonexistent capture/);
});
test('lone CR becomes a real input line rather than injected module output', () => {
  bad('#!desc=first\r[General]\ralways-real-ip=*\r[Rule]\rDOMAIN,x,REJECT', /Unsupported section/);
  assert.match(ok('[Rule]\rDOMAIN,x,REJECT').content, /DOMAIN,x,REJECT/);
});
