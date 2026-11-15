import {rename,rm,lstat,mkdir} from 'node:fs/promises';
import {setTimeout as wait} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const sha=b=>createHash('sha256').update(b).digest('hex');
export const MODULE_SECTION=/^\[(Rule|URL Rewrite|Header Rewrite|Body Rewrite|Map Local|Script)\]$/m;
export const UA='Loon/649 CFNetwork/1492.0.1 Darwin/23.3.0';
const TRANSIENT=new Set([408,425,429,500,502,503,504]);
export async function download(url,max=2*1024*1024,ua=UA,{attempts=3,pause=wait}={}){
 const u=new URL(url);
 if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port)throw Error('Only credential-free HTTPS sources allowed');
 if(!Number.isSafeInteger(max)||max<1||!Number.isSafeInteger(attempts)||attempts<1||attempts>5)throw Error('Invalid download limits');
 for(let attempt=0;attempt<attempts;attempt++){
  let retryAfter=0;
  try{
   const res=await fetch(u,{headers:{'User-Agent':ua,'Cache-Control':'no-cache','Pragma':'no-cache'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)});
   if(!res.ok||res.status===206){
    await res.body?.cancel();
    const error=Object.assign(Error('Source HTTP '+res.status),{status:res.status,retryable:TRANSIENT.has(res.status)});
    const header=res.headers.get('retry-after');
    if(header){retryAfter=/^\d+$/.test(header)?Number(header)*1000:Math.max(0,Date.parse(header)-Date.now());if(!Number.isFinite(retryAfter))retryAfter=0;}
    // Do not ignore long server cooldowns or block a build indefinitely.
    if(retryAfter>30000)error.retryable=false;
    throw error;
   }
   if(!res.body)throw Error('Empty source response');
   const length=res.headers.get('content-length');
   if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length)))){await res.body.cancel();throw Error('Invalid Content-Length');}
   // Node fetch decompresses the body but preserves the wire Content-Length.
   // The configured limit applies to bytes consumed by the converter.
   const encoded=(res.headers.get('content-encoding')||'identity').trim().toLowerCase()!=='identity';
   if(!encoded&&Number(length)>max){await res.body.cancel();throw Error('Source too large');}
   const reader=res.body.getReader(),chunks=[];let n=0;
   try{
    for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max)throw Error('Source too large');chunks.push(value);}
   }catch(error){await reader.cancel().catch(()=>{});throw error;}
   finally{reader.releaseLock();}
   if(length!==null&&!encoded&&n!==Number(length))throw Object.assign(Error('Truncated source response'),{retryable:true});
   if(!n)throw Error('Empty source response');
   return Buffer.concat(chunks,n);
  }catch(error){
   const retryable=error.retryable??(error instanceof TypeError||['TimeoutError','AbortError'].includes(error.name));
   if(!retryable||attempt===attempts-1)throw error;
   await pause(Math.max(retryAfter,1000*2**attempt));
  }
 }
}
export function validateBaseline(b){
 if(b?.brand!=='YanyuAd'||!Number.isSafeInteger(b.total)||b.total<10||!Number.isSafeInteger(b.upstream_total)||b.upstream_total<b.total)throw Error('Invalid baseline');
 return b;
}
export function guardCount(current,previous,label){
 if(!Number.isSafeInteger(previous)||previous<0||!Number.isSafeInteger(current)||current<0||current<previous*.9)throw Error(label+' count dropped by more than 10%');
}
const KEEP_NOTICE=/需要|最低|版本|iOS 5\.|macOS 5\.|jq/;
const DROP_NOTICE=/原始版本元数据|未在 Surge 中实测/;
const LICENSE_LINE='# 许可：上游内容 CC BY-NC-SA 4.0 · 来源 LoonLab';
export function sanitizeModule(text){
 const kept=[];
 for(const line of text.replace(/\r\n?/g,'\n').split('\n')){
  if(/^# 原始元数据：author\s*=/i.test(line)){kept.push(line.replace(/^# 原始元数据：author\s*=\s*/i,'# 原作者：'));continue;}
  if(/^# 原始元数据：/.test(line)||/^# 由上游插件配置自动转换/.test(line))continue;
  if(/^# 提示：/.test(line)&&(DROP_NOTICE.test(line)||!KEEP_NOTICE.test(line)))continue;
  kept.push(line);
 }
 let out=kept.join('\n').replace(/\n{3,}/g,'\n\n').trimEnd()+'\n';
 if(!/^#!name=/m.test(out)||!MODULE_SECTION.test(out))throw Error('Module lost its name or sections after sanitizing');
 if(!out.includes(LICENSE_LINE)){
  const lines=out.split('\n');let last=-1;
  for(let i=0;i<lines.length;i++)if(lines[i].startsWith('#!'))last=i;
  lines.splice(last+1,0,LICENSE_LINE);out=lines.join('\n');
 }
 return out;
}
async function exists(dir){try{const info=await lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe output directory: '+dir);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function withOutputLock(root,fn){
 const lock=path.join(path.resolve(root),'.sync-lock');
 try{await mkdir(lock);}catch(error){if(error.code==='EEXIST')throw Error('Another sync is running or an interrupted sync lock requires cleanup: '+lock);throw error;}
 try{return await fn();}finally{await rm(lock,{recursive:true,force:true});}
}
function outputPaths(root){
 const resolved=path.resolve(root);
 return {staging:path.join(resolved,'.staging'),dist:path.join(resolved,'dist'),backup:path.join(resolved,'.dist-previous')};
}
export async function recoverOutput(root){
 const {dist,backup}=outputPaths(root);
 if(await exists(backup)&&!await exists(dist))await rename(backup,dist);
}
export async function publishOutput(root,validate){
 const {staging,dist,backup}=outputPaths(root);
 await exists(staging);
 await validate(staging);
 await recoverOutput(root);
 await exists(backup);
 await rm(backup,{recursive:true,force:true});
 const hadOutput=await exists(dist);
 if(hadOutput)await rename(dist,backup);
 try{await rename(staging,dist);}
 catch(e){if(hadOutput)await rename(backup,dist);throw e;}
 try{await rm(backup,{recursive:true,force:true});}catch(e){console.warn('Old output cleanup deferred:',e.code);}
}
