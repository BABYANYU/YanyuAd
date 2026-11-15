import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm,rename,stat,cp,symlink} from 'node:fs/promises';
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
 for(let i=0;i<10;i++){const id='p'+i,mod='#!name=x\n['+section+']\nhttp-response ^https://x/ foo bar\n';await writeFile(path.join(root,'modules',id+'.sgmodule'),mod);plugins.push({id,filename:id+'.lpx',name:'x',status:'converted',featured:false,source_sha256:sha('source-'+id),module:'/modules/'+id+'.sgmodule',module_sha256:sha(mod),icon:null});}
 const catalog={brand:'YanyuAd',generated_at:'2026-11-02T00:00:00.000Z',plugins};
 const status={brand:'YanyuAd',generated_at:catalog.generated_at,total:10,upstream_total:10,skipped:0,featured:0,scheduler_enabled:false,catalog_sha256:sha(JSON.stringify(catalog))};
 await writeFile(path.join(root,'data/catalog.json'),JSON.stringify(catalog));await writeFile(path.join(root,'status.json'),JSON.stringify(status));
 const js='const x=1;',url='/assets/app.'+sha(js).slice(0,12)+'.js',css='/assets/style.'+sha('body{}').slice(0,12)+'.css';await writeFile(path.join(root,url.slice(1)),js);await writeFile(path.join(root,css.slice(1)),'body{}');
 for(const page of ['index.html','licenses.html'])await writeFile(path.join(root,page),'<title>YANYU AD</title><link rel="stylesheet" href="'+css+'"><script src="'+url+'"></script>');
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

test('download retries Retry-After and sends cache bypass directives',async t=>{
 let calls=0;const waits=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.cache,'no-store');assert.equal(options.headers['Cache-Control'],'no-cache');assert.equal(options.headers.Pragma,'no-cache');calls++;return calls===1?new Response('busy',{status:429,headers:{'Retry-After':'2'}}):new Response('ok');});
 assert.equal((await download('https://example.org/x',10,undefined,{pause:async ms=>waits.push(ms)})).toString(),'ok');assert.equal(calls,2);assert.deepEqual(waits,[2000]);
});
test('download rejects 206 and honors decoded body over encoded Content-Length',async t=>{
 let calls=0;const payload=new Uint8Array(12);const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(calls===1?payload:new ReadableStream({start(c){c.enqueue(payload);c.close();}}),{status:calls===1?206:200,headers:{'content-length':calls===1?'12':'999','content-encoding':calls===2?'gzip':undefined}});});
 await assert.rejects(download('https://example.org/x',20,undefined,{pause:async()=>{}}),/206/);assert.equal(calls,1);
 assert.equal((await download('https://example.org/x',20,undefined,{pause:async()=>{}})).length,12);
 mock.mock.mockImplementation(async()=>new Response('tiny',{status:200,headers:{'content-length':'99','content-encoding':'gzip'}}));assert.equal((await download('https://example.org/x',8,undefined,{pause:async()=>{}})).toString(),'tiny');
});
test('download rejects truncated identity responses but not compressed lengths',async t=>{
 const mock=t.mock.method(globalThis,'fetch',async()=>new Response('x',{headers:{'content-length':'2'}}));
 await assert.rejects(download('https://example.org/x',8,undefined,{pause:async()=>{}}),/Truncated/);
 mock.mock.mockImplementation(async()=>new Response('x',{headers:{'content-length':'2','content-encoding':'identity'}}));await assert.rejects(download('https://example.org/x',8,undefined,{pause:async()=>{}}),/Truncated/);
 mock.mock.mockImplementation(async()=>new Response('x',{headers:{'content-length':'2','content-encoding':'gzip'}}));assert.equal((await download('https://example.org/x',8,undefined,{pause:async()=>{}})).toString(),'x');
});
test('checker rejects symlinked output entries',async t=>{
 const {tmpdir}=await import('node:os');const root=await mkdtemp(path.join(tmpdir(),'yanyuad-link-'));t.after(()=>rm(root,{recursive:true,force:true}));await output(root);const module=path.join(root,'modules/p0.sgmodule');await rename(module,path.join(root,'outside'));
 try{await symlink('../outside',module);}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('File system forbids symlink creation: '+error.code);return;}throw error;}
 await assert.rejects(checkOutput(root),/Unsafe output entry/);
});
test('checker rejects orphan assets',async t=>{
 const root=await temporary(t);await output(root);await writeFile(path.join(root,'assets/orphan.js'),'orphan');await assert.rejects(checkOutput(root),/Stray frontend assets/);
});
test('output lock rejects overlap and releases after failures',async t=>{
 const {withOutputLock}=await import('../scripts/pipeline.mjs');const root=await temporary(t);let release;const gate=new Promise(resolve=>{release=resolve;});
 const first=withOutputLock(root,async()=>{await assert.rejects(withOutputLock(root,async()=>{}),/Another sync/);await gate;});release();await first;
 await assert.rejects(withOutputLock(root,async()=>{throw Error('failed');}),/failed/);await withOutputLock(root,async()=>{});
});

test('native fetch gzip decompression uses decoded byte limits',async t=>{
 const {createServer}=await import('node:http');const {gzipSync}=await import('node:zlib');
 let body=Buffer.from('tiny');const originalFetch=globalThis.fetch;
 const server=createServer((req,res)=>{const wire=gzipSync(body);res.writeHead(200,{'Content-Encoding':'gzip','Content-Length':wire.length});res.end(wire);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(new URL(url).protocol,'https:');return originalFetch('http://127.0.0.1:'+server.address().port,options);});
 assert.ok(gzipSync(body).length>8);assert.equal((await download('https://example.org/x',8)).toString(),'tiny');
 body=Buffer.from('a'.repeat(10000));assert.ok(gzipSync(body).length<100);await assert.rejects(download('https://example.org/x',100),/too large/);
});
test('HTTP-date Retry-After, bounded retries and long cooldowns',async t=>{
 const now=Date.parse('2026-01-01T00:00:00Z');t.mock.method(Date,'now',()=>now);const waits=[];let calls=0;
 const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('busy',{status:503,headers:{'Retry-After':new Date(now+5000).toUTCString()}});});
 await assert.rejects(download('https://example.org/x',100,undefined,{pause:async ms=>waits.push(ms)}),/503/);assert.equal(calls,3);assert.deepEqual(waits,[5000,5000]);
 calls=0;waits.length=0;mock.mock.mockImplementation(async()=>{calls++;return new Response('busy',{status:429,headers:{'Retry-After':'120'}});});
 await assert.rejects(download('https://example.org/x',100,undefined,{pause:async ms=>waits.push(ms)}),/429/);assert.equal(calls,1);assert.deepEqual(waits,[]);
});
test('network failure retries, permanent errors and oversize do not',async t=>{
 let calls=0;const waits=[];const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1)throw new TypeError('fetch failed');return new Response('ok');});
 assert.equal((await download('https://example.org/x',10,undefined,{pause:async ms=>waits.push(ms)})).toString(),'ok');assert.equal(calls,2);assert.deepEqual(waits,[1000]);
 calls=0;mock.mock.mockImplementation(async()=>{calls++;return new Response('missing',{status:404});});await assert.rejects(download('https://example.org/x'),/404/);assert.equal(calls,1);
 let cancelled=false;mock.mock.mockImplementation(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}}),{headers:{'content-encoding':'gzip','content-length':'3'}}));await assert.rejects(download('https://example.org/x',10),/too large/);assert.equal(cancelled,true);
});
test('checker rejects stray icons, invalid featured counts and missing required app',async t=>{
 const root=await temporary(t);await output(root);await mkdir(path.join(root,'icons'));await writeFile(path.join(root,'icons/old.png'),'old');await assert.rejects(checkOutput(root),/Stray icon/);await rm(path.join(root,'icons/old.png'));
 await updateCatalog(root,c=>c.plugins[0].featured=true);await assert.rejects(checkOutput(root),/Featured count/);await output(root);
 const f=path.join(root,'index.html');await writeFile(f,(await readFile(f,'utf8')).replace(/<script[^>]*><\/script>/,''));await assert.rejects(checkOutput(root),/Missing versioned/);
});

test('output lock excludes a separate process and preserves lock ownership',async t=>{
 const {withOutputLock}=await import('../scripts/pipeline.mjs');const root=await temporary(t);const script=path.join(root,'lock.mjs');
 await writeFile(script,`import {withOutputLock} from ${JSON.stringify(pathToFileURL(path.join(repo,'scripts/pipeline.mjs')).href)};await withOutputLock(${JSON.stringify(root)},async()=>console.log('entered'));`);
 await withOutputLock(root,async()=>{await assert.rejects(run(process.execPath,[script]),error=>{assert.match(error.stderr,/Another sync/);return true;});assert.ok((await stat(path.join(root,'.sync-lock'))).isDirectory());});
 assert.match((await run(process.execPath,[script])).stdout,/entered/);
});
test('initial production build rejects corrupt baselines and accepts only missing baseline',async t=>{
 const root=await temporary(t);await cp(path.join(repo,'scripts'),path.join(root,'scripts'),{recursive:true});await cp(path.join(repo,'public'),path.join(root,'public'),{recursive:true});await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/last-good'),'old');
 const mock=path.join(root,'baseline.mjs');
 await writeFile(mock,`const mode=process.env.TEST_BASELINE_MODE;const plugins=Array.from({length:10},(_,i)=>({name:'P'+i,filename:'P'+i+'.lpx',url:'https://loonlab.103516.xyz/Plugin/P'+i+'.lpx'}));globalThis.fetch=async value=>{const u=new URL(value);if(u.pathname==='/status.json'){if(mode==='missing')return new Response('missing',{status:404});if(mode==='invalid')return Response.json({brand:'other',total:10,upstream_total:10});if(mode==='json')return new Response('{broken');return new Response('denied',{status:403});}if(u.pathname.endsWith('.json'))return Response.json({plugins});return new Response('#!name=x\\n[Rule]\\nDOMAIN,ad.example,REJECT');};`);
 for(const mode of ['invalid','json','forbidden']){
  await assert.rejects(run(process.execPath,['--import',mock,path.join(root,'scripts/sync.mjs'),'--production'],{env:{...process.env,TEST_BASELINE_MODE:mode,YANYUAD_INITIAL_BUILD:'1',YANYUAD_BASELINE_URL:'https://ad.fakeyou.eu.org/status.json'}}),error=>{assert.match(error.stderr,/Baseline check failed/);return true;});
  assert.equal(await readFile(path.join(root,'dist/last-good'),'utf8'),'old');await assert.rejects(stat(path.join(root,'.sync-lock')),error=>error.code==='ENOENT');
 }
 await run(process.execPath,['--import',mock,path.join(root,'scripts/sync.mjs'),'--production'],{env:{...process.env,TEST_BASELINE_MODE:'missing',YANYUAD_INITIAL_BUILD:'1',YANYUAD_BASELINE_URL:'https://ad.fakeyou.eu.org/status.json'}});assert.equal((await checkOutput(path.join(root,'dist'))).total,10);
});

test('a single local write failure aborts sync even below upstream failure threshold',async t=>{
 const root=await temporary(t);await cp(path.join(repo,'scripts'),path.join(root,'scripts'),{recursive:true});await cp(path.join(repo,'public'),path.join(root,'public'),{recursive:true});await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/last-good'),'old');
 const mock=path.join(root,'disk-failure.mjs');
 await writeFile(mock,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.writeFile;fs.writeFile=async(file,...args)=>{if(String(file).includes('/modules/P0-'))throw Object.assign(Error('injected disk error'),{code:'EIO'});return original(file,...args);};syncBuiltinESMExports();const plugins=Array.from({length:20},(_,i)=>({name:'P'+i,filename:'P'+i+'.lpx',url:'https://loonlab.103516.xyz/Plugin/P'+i+'.lpx'}));globalThis.fetch=async value=>new URL(value).pathname.endsWith('.json')?Response.json({plugins}):new Response('#!name=x\\n[Rule]\\nDOMAIN,ad.example,REJECT');`);
 await assert.rejects(run(process.execPath,['--import',mock,path.join(root,'scripts/sync.mjs')]),error=>{assert.match(error.stderr,/Build failed for P0.lpx: injected disk error/);return true;});
 assert.equal(await readFile(path.join(root,'dist/last-good'),'utf8'),'old');await assert.rejects(stat(path.join(root,'.sync-lock')),error=>error.code==='ENOENT');
});
