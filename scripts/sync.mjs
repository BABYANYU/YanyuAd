import {readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {convertPlugin} from './convert.mjs';
import {download,sha,sanitizeModule,validateBaseline,guardCount,recoverOutput,publishOutput} from './pipeline.mjs';
import {checkOutput} from './check.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SOURCE='https://loonlab.103516.xyz/Plugin/';
const staging=path.join(ROOT,'.staging');

// 资源文件名带内容哈希，避免 CDN 缓存旧脚本导致白屏。
async function versionAssets(root){
 await mkdir(path.join(root,'assets'),{recursive:true});
 const map={};
 for(const name of ['app.js','style.css']){
  const file=path.join(root,name);let body;
  try{body=await readFile(file);}catch{continue;}
  const hash=sha(body).slice(0,12);
  const ext=path.extname(name),out='/assets/'+path.basename(name,ext)+'.'+hash+ext;
  await writeFile(path.join(root,out.slice(1)),body);
  await rm(file,{force:true}); // 原文件已带哈希入 assets/，避免 dist 里留重复副本
  map[name]=out;
 }
 for(const page of ['index.html','licenses.html']){
  const f=path.join(root,page);let html;
  try{html=await readFile(f,'utf8');}catch{continue;}
  for(const [name,out] of Object.entries(map)) html=html.split('/'+name).join(out);
  await writeFile(f,html);
 }
}

function sanitizeText(value){return String(value||'').replace(/可莉\uD83C\uDDD5?/g,'').replace(/\s{2,}/g,' ').trim();}

const allowedHosts=new Set(['loon.103516.xyz','loonlab.103516.xyz']);
async function json(url){return JSON.parse((await download(url,3*1024*1024,'Mozilla/5.0 YanyuAdSync/1.0')).toString());}
async function pool(items,n,fn){let index=0;const out=new Array(items.length);await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{for(;;){const i=index++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}));return out;}
function validateIndex(value){if(!value||!Array.isArray(value.plugins)||value.plugins.length<10||value.plugins.length>2000)throw Error('Invalid or unexpectedly small source catalog');const ids=new Set();for(const p of value.plugins){if(typeof p.name!=='string'||!p.name.trim()||typeof p.filename!=='string'||!p.filename||typeof p.url!=='string')throw Error('Invalid plugin record');const u=new URL(p.url);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!allowedHosts.has(u.hostname)||!u.pathname.startsWith('/Plugin/')||!u.pathname.endsWith('.lpx'))throw Error('Unexpected plugin source');if(ids.has(p.filename))throw Error('Duplicate plugin filename');ids.add(p.filename);}return value;}
async function main(){
 await recoverOutput(ROOT);
 const [featured,full]=await Promise.all([json(SOURCE+'plugins.json').then(validateIndex),json(SOURCE+'plugins.all.json').then(validateIndex)]);
 const featuredIds=new Set(featured.plugins.map(p=>p.filename));
 const fullIds=new Set(full.plugins.map(p=>p.filename));
 if([...featuredIds].some(id=>!fullIds.has(id)))throw Error('Featured list is not a subset of full catalog');
 let baseline=null;
 if(process.argv.includes('--production')){
  const raw=process.env.YANYUAD_BASELINE_URL,initial=process.env.YANYUAD_INITIAL_BUILD==='1';
  if(!raw&&!initial)throw Error('Missing production baseline URL');
  if(raw){
   const url=new URL(raw);if(!['ad.fakeyou.eu.org','yanyuad.pages.dev'].includes(url.hostname)||url.pathname!=='/status.json'||url.protocol!=='https:')throw Error('Invalid baseline URL');
   try{baseline=validateBaseline(await json(url.href));}
   catch(err){if(!initial)throw Error('Baseline check failed: '+err.message);}
  }
  if(baseline)guardCount(full.plugins.length,baseline.upstream_total,'Source plugin');
 }
 await rm(staging,{recursive:true,force:true});await cp(path.join(ROOT,'public'),staging,{recursive:true});await versionAssets(staging);
 await mkdir(path.join(staging,'modules'),{recursive:true});await mkdir(path.join(staging,'data'),{recursive:true});await mkdir(path.join(staging,'icons'),{recursive:true});
 let unavailable=0;
 const plugins=await pool(full.plugins,6,async(p,index)=>{
  const id=p.filename.replace(/\.lpx$/i,'').replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+sha(p.filename).slice(0,8);
  const entry={id,name:String(p.name),desc:sanitizeText(String(p.desc||'').replaceAll('\\n','\n')),tags:Array.isArray(p.tags)?p.tags.map(String):[],date:p.date||'',featured:featuredIds.has(p.filename),sourceURL:p.url,filename:p.filename,icon:null,index};
  try{
   const bytes=await download(p.url),text=bytes.toString('utf8');
   if(!/^#!name\s*=/m.test(text)||/^\s*</.test(text))throw Error('Source is not an LPX plugin');
   const result=convertPlugin(text,{name:p.name,sourceURL:p.url});
   Object.assign(entry,{status:result.status,source_sha256:sha(bytes),module:null});
   if(result.status==='converted'){
    if(!result.content||!/^#!name\s*=/m.test(result.content))throw Error('Converter produced invalid module');
    const content=sanitizeModule(result.content);entry.module='/modules/'+id+'.sgmodule';entry.module_sha256=sha(content);await writeFile(path.join(staging,entry.module.slice(1)),content);
   }else{console.warn('PLUGIN_UNSUPPORTED:',p.filename,result.reason);}
  }catch(err){console.warn('PLUGIN_UNAVAILABLE:',p.filename,err.message);unavailable++;Object.assign(entry,{status:'unavailable',module:null});}
  try{
   if(entry.status==='converted'&&p.icon){const u=new URL(p.icon);if(['raw.githubusercontent.com','loonlab.103516.xyz','loon.103516.xyz','github.com'].includes(u.hostname)){
    const b=await download(u.href,1024*1024);const png=b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpg=b[0]===255&&b[1]===216,webp=b.subarray(8,12).toString()==='WEBP';
    if(png||jpg||webp){const f=id+(png?'.png':jpg?'.jpg':'.webp');await writeFile(path.join(staging,'icons',f),b);entry.icon='/icons/'+f;entry.icon_sha256=sha(b);}
   }}
  }catch{/* Missing icons use an original text placeholder; never fail plugin conversion. */}
  return entry;
 });
 const skipped=plugins.filter(p=>p.status!=='converted').length;
 const usable=plugins.filter(p=>p.status==='converted');
 if(unavailable>plugins.length*.1)throw Error('Too many source failures; preserve last successful deployment');
 if(!usable.length)throw Error('No convertible plugins; preserve last successful deployment');
 if(baseline)guardCount(usable.length,baseline.total,'Publishable module');
 const generated_at=new Date().toISOString();let request_id=null;try{request_id=JSON.parse(await readFile(path.join(ROOT,'.sync-request.json'),'utf8')).id;}catch{}
 const catalog={brand:'YanyuAd',version:1,generated_at,upstream_updated:full.last_updated,source:SOURCE,plugins:usable};
 const status={brand:'YanyuAd',version:1,generated_at,request_id,total:usable.length,skipped,upstream_total:plugins.length,featured:usable.filter(p=>p.featured).length,scheduler_enabled:process.env.YANYUAD_SCHEDULER_ENABLED==='true',source:SOURCE,catalog_sha256:sha(JSON.stringify(catalog))};
 await writeFile(path.join(staging,'data/catalog.json'),JSON.stringify(catalog));await writeFile(path.join(staging,'status.json'),JSON.stringify(status));
 await publishOutput(ROOT,checkOutput);console.log(JSON.stringify(status));
}
main().catch(e=>{console.error('SYNC_FAILED:',e.message);process.exitCode=1;});
