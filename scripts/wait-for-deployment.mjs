import {setTimeout as sleep} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {publicBaseURL,validateRequest,verifyDeployment,boundedFetch} from './deployment-acceptance.mjs';
const primary=publicBaseURL(process.env.YANYUAD_PUBLIC_BASE_URL);
const request=validateRequest(JSON.parse(await readFile(new URL('../.sync-request.json',import.meta.url),'utf8')),process.env.SYNC_REQUEST_ID);
const deadline=Date.now()+20*60*1000;
for(;;){
 try{const result=await verifyDeployment({origin:primary,request,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});console.log(JSON.stringify({published:true,...result}));break;}
 catch(error){
  let fallback;
  if(primary!=='https://yanyuad.pages.dev'){
   try{const d=JSON.parse((await boundedFetch(new URL('https://yanyuad.pages.dev/status.json?verify='+request.id),{maxBytes:65536})).toString());fallback={request_id:d.request_id,total:d.total};}
   catch{fallback={available:false};}
  }
  console.log(JSON.stringify({waiting:true,origin:primary,error:error.message,pages_diagnostic:fallback}));
  if(Date.now()>=deadline)throw Error('Requested deployment did not pass public-site acceptance within 20 minutes');
  await sleep(Math.min(30000,deadline-Date.now()));
 }
}
