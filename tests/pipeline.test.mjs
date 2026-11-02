import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm,rename,stat,cp} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {checkOutput} from '../scripts/check.mjs';
import {sha,sanitizeModule,guardCount,validateBaseline,download,publishOutput,recoverOutput} from '../scripts/pipeline.mjs';
import {convertPlugin} from '../scripts/convert.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url)),work=path.join(repo,'.test-work');
async function temporary(t){await mkdir(work,{recursive:true});const dir=await mkdtemp(path.join(work,'pipeline-'));t.after(async()=>{assert(dir.startsWith(work+path.sep));await rm(dir,{recursive:true,force:true});});return dir;}
async function output(root,section='Body Rewrite'){
 await mkdir(path.join(root,'data'),{recursive:true});await mkdir(path.join(root,'modules'),{recursive:true});await mkdir(path.join(root,'assets'),{recursive:true});
 const plugins=[];
 for(let i=0;i<10;i++){const id='p'+i,mod='#!name=x\n['+section+']\nhttp-response ^https://x/ foo bar\n';await writeFile(path.join(root,'modules',id+'.sgmodule'),mod);plugins.push({id,filename:id+'.lpx',name:'x',status:'converted',module:'/modules/'+id+'.sgmodule',module_sha256:sha(mod),icon:null});}
 const catalog={brand:'YanyuAd',generated_at:'2026-11-02T00:00:00.000Z',plugins};
 const status={brand:'YanyuAd',generated_at:catalog.generated_at,total:10,upstream_total:10,skipped:0,scheduler_enabled:false,catalog_sha256:sha(JSON.stringify(catalog))};
 await writeFile(path.join(root,'data/catalog.json'),JSON.stringify(catalog));await writeFile(path.join(root,'status.json'),JSON.stringify(status));
 const js='const x=1;',url='/assets/app.'+sha(js).slice(0,12)+'.js';await writeFile(path.join(root,url.slice(1)),js);
 for(const page of ['index.html','licenses.html'])await writeFile(path.join(root,page),'<title>YANYU AD</title><script src="'+url+'"></script>');
 await writeFile(path.join(root,'404.html'),'Not found');await writeFile(path.join(root,'_headers'),'/*\n');
 return catalog;
}
async function updateCatalog(root,fn){const f=path.join(root,'data/catalog.json'),c=JSON.parse(await readFile(f,'utf8'));fn(c);await writeFile(f,JSON.stringify(c));const s=JSON.parse(await readFile(path.join(root,'status.json'),'utf8'));s.catalog_sha256=sha(JSON.stringify(c));await writeFile(path.join(root,'status.json'),JSON.stringify(s));}

test('body-only and header-only modules pass the same publication checker',async t=>{const root=await temporary(t);for(const section of ['Body Rewrite','Header Rewrite']){await output(root,section);assert.equal((await checkOutput(root)).total,10);}});
test('checker rejects modified modules, escaped paths and duplicate module identities',async t=>{
 const root=await temporary(t);await output(root);await writeFile(path.join(root,'modules/p0.sgmodule'),'#!name=corrupt\n[Rule]\nDOMAIN,x,REJECT');await assert.rejects(checkOutput(root),/hash mismatch/);
 await output(root);await updateCatalog(root,c=>c.plugins[0].module='/../outside');await assert.rejects(checkOutput(root),/module path/);
 await output(root);await updateCatalog(root,c=>c.plugins[1].id=c.plugins[0].id);await assert.rejects(checkOutput(root),/duplicate plugin id/);
});
test('checker detects missing 404 and changed content-hash assets',async t=>{const root=await temporary(t);await output(root);await rm(path.join(root,'404.html'));await assert.rejects(checkOutput(root),/ENOENT|Missing/);await output(root);const h=await readFile(path.join(root,'index.html'),'utf8'),asset=h.match(/src="([^"]+)"/)[1];await writeFile(path.join(root,asset.slice(1)),'changed');await assert.rejects(checkOutput(root),/asset hash/);});
test('failed staging validation leaves the previous output untouched',async t=>{const root=await temporary(t);await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/last-good'),'old');await output(path.join(root,'.staging'));await writeFile(path.join(root,'.staging/modules/p0.sgmodule'),'broken');await assert.rejects(publishOutput(root,checkOutput));assert.equal(await readFile(path.join(root,'dist/last-good'),'utf8'),'old');});
test('failed final rename restores the previous output',async t=>{const root=await temporary(t);await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/last-good'),'old');await output(path.join(root,'.staging'));await assert.rejects(publishOutput(root,async stage=>{await checkOutput(stage);await rename(stage,path.join(root,'moved'));}),/ENOENT/);assert.equal(await readFile(path.join(root,'dist/last-good'),'utf8'),'old');});
test('interrupted promotion recovers the backup and a valid build replaces it',async t=>{const root=await temporary(t);await mkdir(path.join(root,'.dist-previous'));await writeFile(path.join(root,'.dist-previous/last-good'),'old');await recoverOutput(root);assert.equal(await readFile(path.join(root,'dist/last-good'),'utf8'),'old');await output(path.join(root,'.staging'));await publishOutput(root,checkOutput);assert.equal((await checkOutput(path.join(root,'dist'))).total,10);await assert.rejects(stat(path.join(root,'.dist-previous')),e=>e.code==='ENOENT');});
test('baseline guards source counts and publishable counts independently',()=>{const b=validateBaseline({brand:'YanyuAd',total:134,upstream_total:136});assert.doesNotThrow(()=>guardCount(123,b.upstream_total,'Source'));assert.throws(()=>guardCount(122,b.upstream_total,'Source'),/Source/);assert.throws(()=>guardCount(120,b.total,'Publishable'),/Publishable/);assert.throws(()=>validateBaseline({brand:'YanyuAd',total:134,upstream_total:100}),/Invalid/);});
test('sanitizing keeps metadata-only author attribution and version requirements',()=>{const converted=convertPlugin('#!name=x\n#!author=Original Author\n[Rule]\nDOMAIN,x,REJECT');const content=sanitizeModule(converted.content);assert.match(content,/# 原作者：Original Author/);assert.match(content,/CC BY-NC-SA/);assert.doesNotMatch(content,/# 原始元数据：/);});
test('downloader rejects unsafe URLs and enforces streamed size without a Content-Length',async t=>{
 let cancelled=false;
 const mocked=t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.redirect,'error');return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(5));},cancel(){cancelled=true;}}));});
 for(const url of ['http://example.org/x','https://u:p@example.org/x','https://example.org/x#secret','https://example.org:8443/x'])await assert.rejects(download(url));
 assert.equal(mocked.mock.callCount(),0);await assert.rejects(download('https://example.org/x',4),/too large/);assert.equal(cancelled,true);
});

const run=promisify(execFile);
test('real production sync preserves old output on source loss, conversion loss and missing baseline',async t=>{
 const root=await temporary(t);await cp(path.join(repo,'scripts'),path.join(root,'scripts'),{recursive:true});await cp(path.join(repo,'public'),path.join(root,'public'),{recursive:true});
 const mock=path.join(root,'network.mjs');
 await writeFile(mock,`const mode=process.env.TEST_SYNC_MODE;
const count=mode==='source-loss'?17:20;
const plugins=Array.from({length:count},(_,i)=>({name:'Test '+i,filename:'P'+i+'.lpx',url:'https://loonlab.103516.xyz/Plugin/P'+i+'.lpx'}));
globalThis.fetch=async value=>{const u=new URL(value);if(u.pathname==='/status.json')return Response.json({brand:'YanyuAd',total:20,upstream_total:20});if(u.pathname.endsWith('.json'))return Response.json({plugins});const i=Number(u.pathname.match(/P(\\d+)\\.lpx/)[1]);if(mode==='network-loss'&&i<3)throw Error('simulated source failure');return new Response(mode==='conversion-loss'&&i<3?'#!name=unsupported\\n[General]\\ndns-server=1.1.1.1':'#!name=x\\n[Rule]\\nDOMAIN,ad.example,REJECT');};`);
 await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/last-good'),'old');
 for(const mode of ['source-loss','conversion-loss','network-loss','missing-baseline']){
  const env={...process.env,TEST_SYNC_MODE:mode,YANYUAD_INITIAL_BUILD:'0',YANYUAD_BASELINE_URL:mode==='missing-baseline'?'':'https://ad.fakeyou.eu.org/status.json'};
  await assert.rejects(run(process.execPath,['--import',pathToFileURL(mock).href,path.join(root,'scripts/sync.mjs'),'--production'],{env}),e=>{assert.match(e.stderr,/SYNC_FAILED/);return true;});
  assert.equal(await readFile(path.join(root,'dist/last-good'),'utf8'),'old');
 }
 await run(process.execPath,['--import',pathToFileURL(mock).href,path.join(root,'scripts/sync.mjs'),'--production'],{env:{...process.env,TEST_SYNC_MODE:'healthy',YANYUAD_INITIAL_BUILD:'0',YANYUAD_BASELINE_URL:'https://ad.fakeyou.eu.org/status.json'}});
 assert.equal((await checkOutput(path.join(root,'dist'))).total,20);
});
