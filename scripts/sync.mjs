import {readFile,writeFile,mkdir,cp,rm,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {convertPlugin} from './convert.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SOURCE='https://loonlab.103516.xyz/Plugin/';
const UA='Loon/649 CFNetwork/1492.0.1 Darwin/23.3.0';
const staging=path.join(ROOT,'.staging'),dist=path.join(ROOT,'dist');
const sha=b=>createHash('sha256').update(b).digest('hex');
const allowedHosts=new Set(['loon.103516.xyz','loonlab.103516.xyz']);
async function download(url,max=2*1024*1024,ua=UA){
 const u=new URL(url);if(u.protocol!=='https:')throw Error('Only HTTPS sources allowed');
 const res=await fetch(u,{headers:{'User-Agent':ua},signal:AbortSignal.timeout(25000)});
 if(!res.ok)throw Error('Source HTTP '+res.status);
 if(new URL(res.url).hostname!==u.hostname)throw Error('Unexpected redirected source');
 if(Number(res.headers.get('content-length'))>max)throw Error('Source too large');
 const reader=res.body.getReader();let chunks=[],n=0;for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();throw Error('Source too large');}chunks.push(value);}return Buffer.concat(chunks);
}
async function json(url){return JSON.parse((await download(url,3*1024*1024,'Mozilla/5.0 YanyuAdSync/1.0')).toString());}
async function pool(items,n,fn){let index=0;const out=new Array(items.length);await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{for(;;){const i=index++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}));return out;}
function validateIndex(value){if(!value||!Array.isArray(value.plugins)||value.plugins.length<10||value.plugins.length>2000)throw Error('Invalid or unexpectedly small source catalog');const ids=new Set();for(const p of value.plugins){if(!p.name||!p.filename||!p.url)throw Error('Invalid plugin record');const u=new URL(p.url);if(u.protocol!=='https:'||!allowedHosts.has(u.hostname)||!u.pathname.startsWith('/Plugin/')||!u.pathname.endsWith('.lpx'))throw Error('Unexpected plugin source');if(ids.has(p.filename))throw Error('Duplicate plugin filename');ids.add(p.filename);}return value;}
async function main(){
 const [featured,full]=await Promise.all([json(SOURCE+'plugins.json').then(validateIndex),json(SOURCE+'plugins.all.json').then(validateIndex)]);
 const featuredIds=new Set(featured.plugins.map(p=>p.filename));
 const fullIds=new Set(full.plugins.map(p=>p.filename));
 if([...featuredIds].some(id=>!fullIds.has(id)))throw Error('Featured list is not a subset of full catalog');
 if(process.argv.includes('--production')&&process.env.YANYUAD_BASELINE_URL){
  const url=new URL(process.env.YANYUAD_BASELINE_URL);if(!['ad.fakeyou.eu.org','yanyuad.pages.dev'].includes(url.hostname)||url.pathname!=='/status.json'||url.protocol!=='https:')throw Error('Invalid baseline URL');
  try{const b=await json(url.href);if(b.brand!=='YanyuAd'||!b.total)throw Error('Invalid baseline');if(full.plugins.length<b.total*.9)throw Error('Source plugin count dropped by more than 10%');}
  catch(err){if(process.env.YANYUAD_INITIAL_BUILD!=='1')throw Error('Baseline check failed: '+err.message);}
 }
 await rm(staging,{recursive:true,force:true});await cp(path.join(ROOT,'public'),staging,{recursive:true});
 await mkdir(path.join(staging,'modules'),{recursive:true});await mkdir(path.join(staging,'data'),{recursive:true});await mkdir(path.join(staging,'icons'),{recursive:true});
 let unavailable=0;
 const plugins=await pool(full.plugins,4,async(p,index)=>{
  const id=p.filename.replace(/\.lpx$/i,'').replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+sha(p.filename).slice(0,8);
  const entry={id,name:String(p.name),desc:String(p.desc||'').replaceAll('\\n','\n'),tags:Array.isArray(p.tags)?p.tags.map(String):[],date:p.date||'',featured:featuredIds.has(p.filename),sourceURL:p.url,filename:p.filename,icon:null,index};
  try{
   const bytes=await download(p.url),text=bytes.toString('utf8');
   if(!/^#!name\s*=/m.test(text)||/^\s*</.test(text))throw Error('Source is not an LPX plugin');
   const result=convertPlugin(text,{name:p.name,sourceURL:p.url});
   Object.assign(entry,{status:result.status,reason:result.reason||'',warnings:result.warnings||[],source_sha256:sha(bytes),module:null});
   if(result.status==='converted'){
    if(!result.content||!/^#!name\s*=/m.test(result.content))throw Error('Converter produced invalid module');
    entry.module='/modules/'+id+'.sgmodule';await writeFile(path.join(staging,entry.module.slice(1)),result.content);
   }
  }catch(err){unavailable++;Object.assign(entry,{status:'unavailable',reason:'源文件获取或解析失败：'+err.message,module:null,warnings:[]});}
  try{
   if(p.icon){const u=new URL(p.icon);if(['raw.githubusercontent.com','loonlab.103516.xyz','loon.103516.xyz','github.com'].includes(u.hostname)){
    const b=await download(u.href,1024*1024);const png=b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpg=b[0]===255&&b[1]===216,webp=b.subarray(8,12).toString()==='WEBP';
    if(png||jpg||webp){const f=id+(png?'.png':jpg?'.jpg':'.webp');entry.icon='/icons/'+f;await writeFile(path.join(staging,'icons',f),b);}
   }}
  }catch{/* Missing icons use an original text placeholder; never fail plugin conversion. */}
  return entry;
 });
 const skipped=plugins.filter(p=>p.status!=='converted').length;
 const usable=plugins.filter(p=>p.status==='converted');
 if(unavailable>Math.max(3,Math.ceil(plugins.length*.1)))throw Error('Too many source failures; preserve last successful deployment');
 if(!usable.length)throw Error('No convertible plugins; preserve last successful deployment');
 const generated_at=new Date().toISOString();let request_id=null;try{request_id=JSON.parse(await readFile(path.join(ROOT,'.sync-request.json'),'utf8')).id;}catch{}
 const catalog={brand:'YanyuAd',version:1,generated_at,upstream_updated:full.last_updated,source:SOURCE,plugins:usable};
 const status={brand:'YanyuAd',version:1,generated_at,request_id,total:usable.length,skipped,upstream_total:plugins.length,featured:usable.filter(p=>p.featured).length,scheduler_enabled:process.env.YANYUAD_SCHEDULER_ENABLED==='true',source:SOURCE,catalog_sha256:sha(JSON.stringify(catalog))};
 await writeFile(path.join(staging,'data/catalog.json'),JSON.stringify(catalog));await writeFile(path.join(staging,'status.json'),JSON.stringify(status));
 await rm(dist,{recursive:true,force:true});await rename(staging,dist);console.log(JSON.stringify(status));
}
main().catch(e=>{console.error('SYNC_FAILED:',e.message);process.exitCode=1;});
