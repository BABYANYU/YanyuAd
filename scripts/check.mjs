import {readFile,readdir,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {sha,MODULE_SECTION} from './pipeline.mjs';
const DEFAULT_ROOT=fileURLToPath(new URL('../dist/',import.meta.url));
async function regularTree(root){
 const info=await lstat(root);
 if(info.isSymbolicLink()||!info.isDirectory())throw Error('Unsafe output directory');
 const files=new Set();
 async function walk(dir,prefix=''){
  for(const name of await readdir(dir)){
   const file=path.join(dir,name),relative=prefix+name,entry=await lstat(file);
   if(entry.isSymbolicLink()||(!entry.isFile()&&!entry.isDirectory()))throw Error('Unsafe output entry: '+relative);
   if(entry.isDirectory())await walk(file,relative+'/');else files.add(relative);
  }
 }
 await walk(root);return files;
}
export async function checkOutput(root=DEFAULT_ROOT){
 const tree=await regularTree(root);
 const expectedModules=new Set(),expectedIcons=new Set(),expectedAssets=new Set();
 const bytes=await readFile(path.join(root,'data/catalog.json'));
 const catalog=JSON.parse(bytes),status=JSON.parse(await readFile(path.join(root,'status.json'),'utf8'));
 if(catalog.brand!=='YanyuAd'||status.brand!=='YanyuAd')throw Error('Brand mismatch');
 if(!Array.isArray(catalog.plugins)||catalog.plugins.length<10)throw Error('Catalog too small');
 if(status.total!==catalog.plugins.length)throw Error('Status total mismatch');
 if(status.catalog_sha256!==sha(bytes))throw Error('Catalog hash mismatch, status stale');
 if(typeof status.scheduler_enabled!=='boolean')throw Error('scheduler_enabled missing');
 if(typeof status.generated_at!=='string'||Number.isNaN(Date.parse(status.generated_at))||status.generated_at!==catalog.generated_at)throw Error('Bad generated_at');
 if(!Number.isSafeInteger(status.upstream_total)||!Number.isSafeInteger(status.skipped)||status.skipped<0||status.skipped!==status.upstream_total-status.total)throw Error('Skipped count mismatch');
 if(!Number.isSafeInteger(status.featured)||status.featured!==catalog.plugins.filter(p=>p.featured===true).length)throw Error('Featured count mismatch');
 const seen=new Set(),ids=new Set();
 for(const p of catalog.plugins){
  if(typeof p.filename!=='string'||!p.filename.trim()||seen.has(p.filename))throw Error('Invalid or duplicate plugin filename');seen.add(p.filename);
  if(typeof p.id!=='string'||!/^[A-Za-z0-9_-]+$/.test(p.id)||ids.has(p.id))throw Error('Invalid or duplicate plugin id');ids.add(p.id);
  if(p.status!=='converted')throw Error('Non-convertible plugin must not be published: '+p.filename);
  if(typeof p.name!=='string'||!p.name.trim())throw Error('Missing name for '+p.filename);
  if(typeof p.featured!=='boolean')throw Error('Invalid featured flag');
  if(!/^[a-f0-9]{64}$/.test(p.source_sha256||''))throw Error('Invalid source hash');
  if(p.module!=='/modules/'+p.id+'.sgmodule')throw Error('Invalid module path');
  expectedModules.add(p.module.slice(1));
  const mod=await readFile(path.join(root,p.module.slice(1)));
  if(!/^#!name=[^\r\n]*\S[^\r\n]*$/m.test(mod.toString())||!MODULE_SECTION.test(mod.toString()))throw Error('Suspicious module '+p.module);
  if(p.module_sha256!==sha(mod))throw Error('Module hash mismatch: '+p.module);
  if(p.icon!==null&&typeof p.icon!=='string')throw Error('Invalid icon path');
  if(p.icon){
   expectedIcons.add(p.icon.slice(1));
   if(!['png','jpg','webp'].some(ext=>p.icon==='/icons/'+p.id+'.'+ext))throw Error('Invalid icon path');
   if(p.icon_sha256!==sha(await readFile(path.join(root,p.icon.slice(1)))))throw Error('Icon hash mismatch');
  }
 }
 const files=[...tree].filter(f=>f.startsWith('modules/'));
 if(files.length!==expectedModules.size||files.some(f=>!expectedModules.has(f)))throw Error('Stray module files');
 const icons=[...tree].filter(f=>f.startsWith('icons/'));
 if(icons.length!==expectedIcons.size||icons.some(f=>!expectedIcons.has(f)))throw Error('Stray icon files');
 for(const page of ['index.html','licenses.html']){
  const html=await readFile(path.join(root,page),'utf8');
  if(!html.includes('YANYU AD'))throw Error('Stale frontend');
  for(const asset of ['/app.js','/style.css'])if(new RegExp('(?:src|href)\\s*=\\s*["\']?'+asset.replace('.','\\.')+'(?:["\'\\s>?#]|$)','i').test(html))throw Error('Unversioned frontend asset');
  const references=[...html.matchAll(/(?:src|href)\s*=\s*(["'])(\/assets\/[^"'\s]+)\1/gi)];
  const kinds=new Set();
  for(const [,,url]of references){
   const match=/^\/assets\/(app\.([a-f0-9]{12})\.js|style\.([a-f0-9]{12})\.css)$/.exec(url);
   if(!match||sha(await readFile(path.join(root,url.slice(1)))).slice(0,12)!==(match[2]||match[3]))throw Error('Frontend asset hash mismatch');
   kinds.add(match[2]?'app':'style');expectedAssets.add(url.slice(1));
  }
  if(!kinds.has('style')||(page==='index.html'&&!kinds.has('app')))throw Error('Missing versioned frontend assets');
 }
 const assets=[...tree].filter(f=>f.startsWith('assets/'));
 if(assets.length!==expectedAssets.size||assets.some(f=>!expectedAssets.has(f)))throw Error('Stray frontend assets');
 for(const name of ['404.html','_headers'])if(!tree.has(name))throw Error('Missing '+name);
 return {ok:true,total:status.total,skipped:status.skipped,modules:files.length,generated_at:status.generated_at};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 checkOutput().then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error('CHECK_FAILED:',e.message);process.exitCode=1;});
}
