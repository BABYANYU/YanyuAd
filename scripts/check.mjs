import {readFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const ROOT=fileURLToPath(new URL('../dist/',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const exists=async p=>{const s=await stat(path.join(ROOT,p.slice(1)));if(!s.isFile())throw Error('Not a file '+p);};
async function main(){
 const catalog=JSON.parse(await readFile(path.join(ROOT,'data/catalog.json'),'utf8'));
 const status=JSON.parse(await readFile(path.join(ROOT,'status.json'),'utf8'));
 if(catalog.brand!=='YanyuAd'||status.brand!=='YanyuAd')throw Error('Brand mismatch');
 if(!Array.isArray(catalog.plugins)||catalog.plugins.length<10)throw Error('Catalog too small');
 if(status.total!==catalog.plugins.length)throw Error('Status total mismatch');
 if(status.catalog_sha256!==sha(JSON.stringify(catalog)))throw Error('Catalog hash mismatch, status stale');
 const seen=new Set();let converted=0;
 for(const p of catalog.plugins){
  if(seen.has(p.filename))throw Error('Duplicate plugin '+p.filename);seen.add(p.filename);
  if(p.status!=='converted')throw Error('Non-convertible plugin must not be published: '+p.filename);
  converted++;
  {
   if(!p.module)throw Error('Missing module for '+p.filename);
   await exists(p.module);
   const mod=await readFile(path.join(ROOT,p.module.slice(1)),'utf8');
   if(!/^#!name=/m.test(mod)||!/^\[(Script|Rule|URL Rewrite|Map Local|MITM)\]/m.test(mod))throw Error('Suspicious module '+p.module);
  }
  if(p.icon)await exists(p.icon);
 }
 if(status.total!==converted)throw Error('Status total mismatch');
 if(status.skipped!==status.upstream_total-status.total)throw Error('Skipped count mismatch');
 const html=await readFile(path.join(ROOT,'index.html'),'utf8');
 if(!html.includes('YanyuAd'))throw Error('Stale frontend');
 const files=await readdir(path.join(ROOT,'modules'));
 if(files.length!==converted)throw Error('Stray module files');
 console.log(JSON.stringify({ok:true,total:status.total,skipped:status.skipped,modules:files.length,generated_at:status.generated_at}));
}
main().catch(e=>{console.error('CHECK_FAILED:',e.message);process.exitCode=1;});
