import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {publicBaseURL,validateRequest,verifyDeployment,boundedFetch} from '../scripts/deployment-acceptance.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const origin='https://ad.fakeyou.eu.org',request={id:'test-request',requested_at:'2026-11-15T00:00:00.000Z'},now=Date.parse('2026-11-15T01:00:00.000Z');
function fixture(){
 const files=new Map(),plugins=Array.from({length:10},(_,i)=>{const id='p'+i,body='#!name=Test '+i+'\n[Rule]\nDOMAIN,ad.example,REJECT\n';files.set('/modules/'+id+'.sgmodule',body);return {id,module:'/modules/'+id+'.sgmodule',module_sha256:sha(body),status:'converted'};});
 const catalog={brand:'YanyuAd',generated_at:'2026-11-15T00:10:00.000Z',plugins};
 const status={brand:'YanyuAd',generated_at:catalog.generated_at,request_id:request.id,total:10,upstream_total:12,skipped:2,scheduler_enabled:true,catalog_sha256:sha(JSON.stringify(catalog))};
 let html='YANYU AD';for(const [kind,ext]of [['app','js'],['style','css']]){const body=kind+' source',path='/assets/'+kind+'.'+sha(body).slice(0,12)+'.'+ext;files.set(path,body);html+=' <script src="'+path+'"></script>';}
 files.set('/',html);files.set('/status.json',JSON.stringify(status));files.set('/data/catalog.json',JSON.stringify(catalog));
 const fetchImpl=async url=>{const body=files.get(new URL(url).pathname);return body===undefined?new Response('missing',{status:404}):new Response(body);};
 return {files,status,catalog,fetchImpl};
}
test('public origin and request time must be explicit and valid',()=>{
 assert.equal(publicBaseURL(origin),origin);for(const bad of [undefined,'http://ad.fakeyou.eu.org','https://x.example','https://u:p@ad.fakeyou.eu.org','https://ad.fakeyou.eu.org/x'])assert.throws(()=>publicBaseURL(bad));
 assert.throws(()=>validateRequest({...request,requested_at:'2026-02-30T00:00:00Z'},request.id,now));assert.throws(()=>validateRequest(request,'other',now));
});
test('valid production snapshot verifies catalog, three modules and frontend assets',async()=>{const f=fixture();const r=await verifyDeployment({origin,request,now,fetchImpl:f.fetchImpl});assert.equal(r.samples.length,3);assert.equal(r.total,10);assert.equal(r.assets.length,2);});
test('tampered catalog, modules and frontend must fail',async()=>{
 for(const path of ['/data/catalog.json','/modules/p0.sgmodule','/']){const f=fixture();f.files.set(path,'tampered');await assert.rejects(verifyDeployment({origin,request,now,fetchImpl:f.fetchImpl}));}
 const f=fixture();const asset=[...f.files.keys()].find(x=>x.startsWith('/assets/'));f.files.set(asset,'changed');await assert.rejects(verifyDeployment({origin,request,now,fetchImpl:f.fetchImpl}),/Frontend SHA256/);
});
test('wrong request, stale date and disabled schedule cannot pass',async()=>{
 for(const patch of [{request_id:'old'},{generated_at:'2000-01-01T00:00:00.000Z'},{scheduler_enabled:false},{total:0},{skipped:0}]){const f=fixture();f.files.set('/status.json',JSON.stringify({...f.status,...patch}));await assert.rejects(verifyDeployment({origin,request,now,fetchImpl:f.fetchImpl}));}
});
test('catalog cannot redirect installation to external or traversal paths',async()=>{
 for(const path of ['https://evil.test/module','//evil.test/a','/modules/../a.sgmodule']){const f=fixture();f.catalog.plugins[0].module=path;const c=JSON.stringify(f.catalog);f.files.set('/data/catalog.json',c);f.files.set('/status.json',JSON.stringify({...f.status,catalog_sha256:sha(c)}));await assert.rejects(verifyDeployment({origin,request,now,fetchImpl:f.fetchImpl}),/Invalid catalog module/);}
});
test('fetch is bounded and rejects redirects and partial responses',async()=>{
 for(const status of [206,302,404])await assert.rejects(boundedFetch('https://ad.fakeyou.eu.org/',{fetchImpl:async()=>new Response('x',{status})}));
 await assert.rejects(boundedFetch('https://ad.fakeyou.eu.org/',{maxBytes:3,fetchImpl:async()=>new Response('1234')}),/size limit/);
});
