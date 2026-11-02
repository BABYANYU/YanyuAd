const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const state={query:'',tag:'全部',sort:'default'};
let catalog=[];
const safeURL=v=>{try{const u=new URL(v,location.origin);return['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
let toastTimer;
function toast(s){$('#toast').textContent=s;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2200);}
async function copy(s){try{await navigator.clipboard.writeText(s);toast('已复制');}catch{const t=el('textarea');t.value=s;document.body.append(t);t.select();try{document.execCommand('copy');toast('已复制');}catch{toast('复制失败');}t.remove();}}
const moduleURL=p=>p.module?new URL(p.module,location.origin).href:null;
const installURL=p=>{const u=moduleURL(p);return u?'surge:///install-module?url='+encodeURIComponent(u):null;};
function actions(p){const box=el('div','actions');const url=moduleURL(p);const b=el('button','action','复制');b.type='button';b.addEventListener('click',()=>copy(url));b.setAttribute('aria-label','复制 '+p.name+' 链接');const a=el('a','action primary','安装');a.href=installURL(p);a.setAttribute('aria-label','安装 '+p.name);box.append(b,a);return box;}
function showDetail(p){
 const box=$('#detail-body');box.replaceChildren(el('div','detail-name',p.name),el('p','detail-desc',p.desc||''));
 if(p.tags?.length||p.date){const row=el('div','detail-row');row.append(el('span',null,(p.tags||[]).join(' · ')||'模块'),el('span',null,(p.date||'').slice(0,16)));box.append(row);}
 const foot=el('div','detail-actions');foot.append(actions(p));box.append(foot);
 $('#details').showModal();
}
function render(){
 const q=state.query.trim().toLocaleLowerCase();
 let rows=catalog.filter(p=>(state.tag==='全部'||p.tags?.includes(state.tag))&&(!q||[p.name,p.desc,...(p.tags||[])].join(' ').toLocaleLowerCase().includes(q)));
 if(state.sort==='name')rows.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
 if(state.sort==='date')rows.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
 $('#count').textContent=(state.tag==='全部'?'全部':state.tag)+' · '+rows.length;
 $('#empty').hidden=rows.length>0;
 const frag=document.createDocumentFragment();
 for(const p of rows){
  const card=el('article','card'),head=el('div','card-head');
  const fallback=el('span','fallback',(p.name||'Y').trim().slice(0,1).toUpperCase()),img=el('img','plugin-icon');const icon=safeURL(p.icon);
  if(icon){img.src=icon;img.loading='lazy';img.alt='';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>img.replaceWith(fallback),{once:true});head.append(img);}else head.append(fallback);
  const names=el('div');names.append(el('div','name',p.name));const sub=[(p.tags||[])[0],(p.date||'').slice(0,10)].filter(Boolean).join(' · ');if(sub)names.append(el('div','meta',sub));
  head.append(names);head.tabIndex=0;head.setAttribute('role','button');head.setAttribute('aria-label','查看 '+p.name);
  head.addEventListener('click',()=>showDetail(p));head.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showDetail(p);}});
  const foot=el('div','card-foot'),tags=el('div','tags');for(const t of(p.tags||[]).slice(1,3))tags.append(el('span','tag',t));
  foot.append(tags,actions(p));
  card.append(head,el('p','description',p.desc||''),foot);frag.append(card);
 }
 $('#grid').replaceChildren(frag);
}
function home(){state.query='';state.tag='全部';state.sort='default';$('#search').value='';document.querySelectorAll('[data-sort]').forEach(b=>b.classList.toggle('selected',b.dataset.sort==='default'));document.querySelectorAll('[data-tag]').forEach(b=>b.classList.toggle('selected',b.dataset.tag==='全部'));if($('#details').open)$('#details').close();render();window.scrollTo(0,0);}
$('#home').addEventListener('click',e=>{e.preventDefault();home();});
// 目录最多 2000 条：输入时防抖，避免每次按键都重建全部卡片。
let renderTimer;
$('#search').addEventListener('input',e=>{state.query=e.target.value;clearTimeout(renderTimer);renderTimer=setTimeout(render,120);});
document.querySelectorAll('[data-sort]').forEach(b=>b.addEventListener('click',()=>{state.sort=b.dataset.sort;document.querySelectorAll('[data-sort]').forEach(n=>n.classList.toggle('selected',n===b));render();}));
$('#close').addEventListener('click',()=>$('#details').close());
$('#details').addEventListener('click',e=>{if(e.target===$('#details')){const r=$('#details').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#details').close();}});
try{
 const r=await fetch('/data/catalog.json',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
 const snap=await r.json();catalog=snap.plugins;
 if(!Array.isArray(catalog)||!catalog.length)throw Error('empty');
 const tags=['全部',...new Set(catalog.flatMap(p=>p.tags||[]))];
 for(const t of tags){const b=el('button',t==='全部'?'selected':null,t);b.type='button';b.dataset.tag=t;b.addEventListener('click',()=>{state.tag=t;document.querySelectorAll('[data-tag]').forEach(n=>n.classList.toggle('selected',n===b));render();});$('#categories').append(b);}
 const dt=new Date(snap.generated_at);
 $('#sync').textContent='更新于 '+dt.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 render();
}catch{
 $('#count').textContent='—';$('#error').textContent='载入失败，请稍后重试。';$('#error').hidden=false;
}
