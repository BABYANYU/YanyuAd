import {readFile} from 'node:fs/promises';
const base=process.env.YANYUAD_PUBLIC_BASE_URL,id=process.env.SYNC_REQUEST_ID;
if(!base||!id)throw Error('Missing YANYUAD_PUBLIC_BASE_URL or SYNC_REQUEST_ID');
if(!/^https:\/\/(ad\.fakeyou\.eu\.org|yanyuad\.pages\.dev)$/.test(base.replace(/\/$/,'')))throw Error('Unexpected public base URL');
const deadline=Date.now()+20*60*1000,interval=45000;
let last='';
for(;;){
 try{
  const res=await fetch(base.replace(/\/$/,'')+'/status.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw Error('HTTP '+res.status);
  const s=await res.json();
  if(s.brand!=='YanyuAd'||!Number.isSafeInteger(s.total))throw Error('Invalid status payload');
  last=`request_id=${s.request_id} total=${s.total} skipped=${s.skipped} scheduler=${s.scheduler_enabled}`;
  if(s.request_id===id&&s.total>0&&s.scheduler_enabled===true)break;
  if(s.request_id!==id){throw Error('Deployment has not switched to this run yet ('+last+')');}
 }catch(e){last=e.message;}
 if(Date.now()>deadline)throw Error('Timed out waiting for deployment: '+last);
 await new Promise(r=>setTimeout(r,interval));
}
console.log('Deployment verified: '+last);
