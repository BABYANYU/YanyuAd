const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const ALL='全部模块',PAGE_SIZE=8;
const state={query:'',tag:ALL,sort:'default',page:1};
let catalog=[],catalogReady=false,categoryButtons=[],categoryCounts=new Map(),toastTimer,renderTimer;
const normalTag=t=>['解锁会员','会员解锁'].includes(String(t).trim())?'会员相关':String(t).trim();
const tagsOf=p=>[...new Set((Array.isArray(p.tags)?p.tags:[]).map(normalTag).filter(Boolean))];
const safeURL=v=>{if(typeof v!=='string'||!v.trim())return null;try{const u=new URL(v,location.origin);return['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
function toast(s){const n=$('#toast'),host=$('#details').open?$('#details'):document.body;if(n.parentNode!==host)host.append(n);n.textContent=s;n.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>n.classList.remove('show'),2200);}
async function copy(s){try{await navigator.clipboard.writeText(s);toast('已复制');}catch{const t=el('textarea');t.value=s;const host=$('#details').open?$('#detail-body'):document.body;host.append(t);t.select();try{if(!document.execCommand('copy'))throw Error('Copy rejected');toast('已复制');}catch{toast('复制失败');}t.remove();}}
const moduleURL=p=>typeof p?.module==='string'&&/^\/modules\/[A-Za-z0-9_-]+\.sgmodule$/.test(p.module)?new URL(p.module,location.origin).href:null;
function validPlugin(p){return p&&typeof p==='object'&&typeof p.name==='string'&&p.name.trim()&&moduleURL(p)&&(p.desc==null||typeof p.desc==='string')&&(p.tags==null||(Array.isArray(p.tags)&&p.tags.every(t=>typeof t==='string')))&&(p.date==null||typeof p.date==='string');}
const installURL=p=>{const u=moduleURL(p);return u?'surge:///install-module?url='+encodeURIComponent(u):null;};
function actions(p){
 const box=el('div','row-actions'),b=el('button','action','复制链接');b.type='button';b.addEventListener('click',()=>copy(moduleURL(p)));b.setAttribute('aria-label','复制 '+p.name+' 链接');
 const a=el('a','action','安装');a.href=installURL(p);a.setAttribute('aria-label','安装 '+p.name);const arrow=el('span','action-arrow','↗');arrow.setAttribute('aria-hidden','true');a.append(arrow);box.append(b,a);return box;
}
function showDetail(p){
 const heading=el('h2','detail-name',p.name);heading.id='detail-name';const box=$('#detail-body');box.replaceChildren(heading,el('p','detail-desc',p.desc||''));
 if(tagsOf(p).length||p.date){const row=el('div','detail-row');row.append(el('span',null,tagsOf(p).join(' · ')||'模块'),el('span',null,String(p.date||'').slice(0,16)));box.append(row);}
 const foot=el('div','detail-actions');foot.append(actions(p));box.append(foot);$('#details').showModal();
}
function selectCategory(tag){clearTimeout(renderTimer);state.tag=categoryCounts.has(tag)?tag:ALL;state.page=1;render();}
function buildCategories(){
 categoryCounts=new Map([[ALL,catalog.length]]);
 for(const p of catalog)for(const tag of tagsOf(p))if(tag!==ALL)categoryCounts.set(tag,(categoryCounts.get(tag)||0)+1);
 const preferred=['去广告','功能增强','会员相关','定时任务'];
 const labels=[ALL,...preferred.filter(t=>categoryCounts.has(t)),...[...categoryCounts.keys()].filter(t=>t!==ALL&&!preferred.includes(t)).sort((a,b)=>a.localeCompare(b,'zh-CN'))];
 const sidebar=$('#categories'),picker=$('#category-select');sidebar.replaceChildren();picker.replaceChildren();categoryButtons=[];
 for(const tag of labels){
  const b=el('button','category-button');b.type='button';b.dataset.tag=tag;b.setAttribute('aria-label',tag+'，'+categoryCounts.get(tag)+' 个模块');const count=el('span','category-count',String(categoryCounts.get(tag)));count.setAttribute('aria-hidden','true');b.append(el('span',null,tag),count);b.addEventListener('click',()=>selectCategory(tag));
  b.addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const index=categoryButtons.indexOf(b),next=e.key==='Home'?0:e.key==='End'?categoryButtons.length-1:(index+(e.key==='ArrowDown'?1:-1)+categoryButtons.length)%categoryButtons.length;categoryButtons[next].focus();selectCategory(categoryButtons[next].dataset.tag);});
  categoryButtons.push(b);sidebar.append(b);const option=el('option',null,tag);option.value=tag;picker.append(option);
 }
}
function render(){
 if(!catalogReady)return;
 const q=state.query.trim().toLocaleLowerCase();
 const rows=catalog.filter(p=>(state.tag===ALL||tagsOf(p).includes(state.tag))&&(!q||[p.name,p.desc,...(p.tags||[]),...tagsOf(p)].join(' ').toLocaleLowerCase().includes(q)));
 if(state.sort==='name')rows.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
 if(state.sort==='date')rows.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
 const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));state.page=Math.min(Math.max(1,state.page),pages);
 $('#count').textContent=rows.length+' 个模块';$('#empty').hidden=rows.length>0;
 $('#category-select').value=state.tag;$('#sort').value=state.sort;
 for(const b of categoryButtons){const active=b.dataset.tag===state.tag;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));b.tabIndex=active?0:-1;}
 const frag=document.createDocumentFragment();
 for(const p of rows.slice((state.page-1)*PAGE_SIZE,state.page*PAGE_SIZE)){
  const card=el('article','module-row'),main=el('button','module-main');main.type='button';main.setAttribute('aria-label','查看 '+p.name+' 详情');main.setAttribute('aria-haspopup','dialog');main.setAttribute('aria-controls','details');main.addEventListener('click',()=>showDetail(p));
  const fallback=el('span','fallback',Array.from((p.name||'Y').trim())[0]?.toUpperCase()||'Y');fallback.setAttribute('aria-hidden','true');const icon=safeURL(p.icon);
  if(icon){const img=el('img','plugin-icon');img.src=icon;img.width=44;img.height=44;img.loading='lazy';img.decoding='async';img.alt='';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>img.replaceWith(fallback),{once:true});main.append(img);}else main.append(fallback);
  const text=el('span','module-text');text.append(el('span','module-name',p.name),el('span','module-description',String(p.desc||'').replace(/\s+/g,' ')));
  const meta=[...tagsOf(p),String(p.date||'').slice(0,10)].filter(Boolean).join(' · ');if(meta)text.append(el('span','module-meta',meta));main.append(text);card.append(main,actions(p));frag.append(card);
 }
 $('#grid').replaceChildren(frag);
 $('#pagination').hidden=!rows.length;$('#prev').disabled=state.page===1;$('#next').disabled=state.page===pages;$('#page-number').textContent=state.page+' / '+pages;
 $('#page-info').textContent=rows.length?'显示 '+((state.page-1)*PAGE_SIZE+1)+'–'+Math.min(state.page*PAGE_SIZE,rows.length)+'，共 '+rows.length+' 个模块':'0 个模块';
}
function home(){clearTimeout(renderTimer);state.query='';state.tag=ALL;state.sort='default';state.page=1;$('#search').value='';if($('#details').open)$('#details').close();if($('#about-dialog').open)$('#about-dialog').close();render();window.scrollTo(0,0);}
$('#home').addEventListener('click',e=>{e.preventDefault();home();});
$('#category-select').addEventListener('change',e=>selectCategory(e.target.value));
$('#search').addEventListener('input',e=>{state.query=e.target.value;state.page=1;clearTimeout(renderTimer);renderTimer=setTimeout(render,120);});
$('#sort').addEventListener('change',e=>{clearTimeout(renderTimer);state.sort=['default','name','date'].includes(e.target.value)?e.target.value:'default';state.page=1;render();});
for(const [id,delta]of [['prev',-1],['next',1]])$('#'+id).addEventListener('click',()=>{if($('#'+id).disabled)return;state.page+=delta;render();$('#library').scrollIntoView({block:'start',behavior:'auto'});});
$('#close').addEventListener('click',()=>$('#details').close());
$('#about').addEventListener('click',()=>{$('#about-dialog').showModal();$('#about').setAttribute('aria-expanded','true');});
$('#about-close').addEventListener('click',()=>$('#about-dialog').close());
$('#about-dialog').addEventListener('close',()=>$('#about').setAttribute('aria-expanded','false'));
for(const id of ['details','about-dialog'])$('#'+id).addEventListener('click',e=>{if(e.target===$('#'+id)){const r=$('#'+id).getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#'+id).close();}});
$('#copyright-year').textContent=String(new Date().getFullYear());$('#about-year').textContent=String(new Date().getFullYear());
try{
 const r=await fetch('/data/catalog.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);
 const snap=await r.json();if(snap.brand!=='YanyuAd'||!Array.isArray(snap.plugins)||!snap.plugins.length||snap.plugins.some(p=>!validPlugin(p)))throw Error('Invalid catalog');catalog=snap.plugins;catalogReady=true;
 buildCategories();render();const dt=new Date(snap.generated_at);
 const updated=Number.isFinite(+dt)?'更新于 '+dt.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).replaceAll('/','.'):'同步时间暂不可用';
 $('#sync').textContent=updated;$('#sync').title=Number.isFinite(+dt)?dt.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':'';
 fetch('/status.json',{cache:'no-cache',signal:AbortSignal.timeout(10000)}).then(r=>r.ok?r.json():null).then(s=>{if(s?.brand==='YanyuAd'&&s.scheduler_enabled===true)$('#sync').textContent='每日同步 · '+updated;}).catch(()=>{});
}catch{$('#count').textContent='—';$('#error').textContent='目录暂时无法载入，请刷新页面重试。';$('#error').hidden=false;$('#sync').textContent='暂未获取同步时间';}
