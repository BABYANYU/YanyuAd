import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const must=(v,m)=>{if(!v)throw Error(m);};
const SHA=/^[a-f0-9]{64}$/;
export function publicBaseURL(value){
 let u;try{u=new URL(value);}catch{throw Error('Missing or invalid YANYUAD_PUBLIC_BASE_URL');}
 must(['https://ad.fakeyou.eu.org','https://yanyuad.pages.dev'].includes(u.origin)&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'Unexpected public base URL');return u.origin;
}
export function timestamp(value){
 must(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value),'Invalid UTC timestamp');
 const n=Date.parse(value);must(Number.isFinite(n)&&new Date(n).toISOString()===value.replace(/(?<=:\d\d)Z$/,'.000Z'),'Invalid UTC timestamp');return n;
}
export function validateRequest(request,id,now=Date.now()){
 must(/^[A-Za-z0-9_-]{1,100}$/.test(id||'')&&request?.id===id,'Invalid sync request ID');must(timestamp(request.requested_at)<=now+300000,'Future request timestamp');return request;
}
export async function boundedFetch(url,{fetchImpl=fetch,maxBytes=8*1024*1024,signal}={}){
 const r=await fetchImpl(url,{redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 must(r.status===200&&!r.redirected&&(!r.url||r.url===String(url)),'Unexpected HTTP response or redirect');
 const len=r.headers.get('content-length');if(len!==null&&(!/^\d+$/.test(len)||Number(len)>maxBytes)){await r.body?.cancel();throw Error('Response exceeds size limit');}
 must(r.body,'Missing response body');const reader=r.body.getReader(),parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;must(size<=maxBytes,'Response exceeds size limit');parts.push(Buffer.from(value));}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return Buffer.concat(parts,size);
}
export async function verifyDeployment({origin,request,fetchImpl=fetch,now=Date.now(),signal}){
 origin=publicBaseURL(origin);validateRequest(request,request?.id,now);
 const read=async(path,maxBytes)=>{const u=new URL(path,origin);u.searchParams.set('verify',request.id+'-'+now);return boundedFetch(u,{fetchImpl,maxBytes,signal});};
 const status=JSON.parse((await read('/status.json',65536)).toString());
 must(status.brand==='YanyuAd'&&status.request_id===request.id&&status.scheduler_enabled===true,'Status identity mismatch');
 must(Number.isSafeInteger(status.total)&&status.total>=10&&Number.isSafeInteger(status.upstream_total)&&status.upstream_total>=status.total&&status.skipped===status.upstream_total-status.total,'Invalid catalog counts');
 const published=timestamp(status.generated_at);must(published>=timestamp(request.requested_at)&&published<=now+300000,'Publication outside request window');
 const bytes=await read('/data/catalog.json');must(SHA.test(status.catalog_sha256||'')&&hash(bytes)===status.catalog_sha256,'Catalog SHA256 mismatch');
 const catalog=JSON.parse(bytes.toString());must(catalog.brand==='YanyuAd'&&catalog.generated_at===status.generated_at&&Array.isArray(catalog.plugins)&&catalog.plugins.length===status.total,'Catalog identity mismatch');
 const seen=new Set();for(const p of catalog.plugins){must(p&&/^[A-Za-z0-9_-]+$/.test(p.id)&&!seen.has(p.id)&&p.module==='/modules/'+p.id+'.sgmodule'&&p.status==='converted'&&SHA.test(p.module_sha256||''),'Invalid catalog module');seen.add(p.id);}
 const samples=[];
 for(const i of [...new Set([0,Math.floor(catalog.plugins.length/2),catalog.plugins.length-1])]){
  const p=catalog.plugins[i],b=await read(p.module,4*1024*1024);must(hash(b)===p.module_sha256&&/^#!name=/m.test(b.toString()),'Module SHA256 or header mismatch');samples.push({id:p.id,path:p.module,sha256:hash(b),bytes:b.length});
 }
 const html=(await read('/',1024*1024)).toString();must(html.includes('YANYU AD'),'Unexpected frontend');const assets=[...html.matchAll(/(?:src|href)=["'](\/assets\/(app|style)\.([a-f0-9]{12})\.(?:js|css))["']/g)];must(assets.some(x=>x[2]==='app')&&assets.some(x=>x[2]==='style'),'Missing versioned frontend');
 for(const [,path,,sha]of assets){const b=await read(path,4*1024*1024);must(hash(b).startsWith(sha),'Frontend SHA256 mismatch');}
 return {origin,ok:true,request_id:status.request_id,generated_at:status.generated_at,total:status.total,skipped:status.skipped,catalog_sha256:status.catalog_sha256,samples,assets:assets.map(x=>x[1])};
}
