const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const state={query:'',tag:'全部',sort:'default',all:false,compat:'all'};
let catalog=[],snapshot={};
const safeURL=v=>{try{const u=new URL(v,location.origin);return['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
let toastTimer;
function toast(s){$('#toast').textContent=s;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2400);}
async function copy(s){try{await navigator.clipboard.writeText(s);toast('已复制链接');}catch{const t=el('textarea');t.value=s;document.body.append(t);t.select();try{document.execCommand('copy');toast('已复制链接');}catch{toast('复制失败，请手动复制');}t.remove();}}
const moduleURL=p=>p.module?new URL(p.module,location.origin).href:null;
const installURL=p=>{const u=moduleURL(p);return u?'surge:///install-module?url='+encodeURIComponent(u):null;};
function actions(p){const box=el('div','actions'),url=moduleURL(p);const b=el('button','action','复制链接');b.type='button';if(url)b.addEventListener('click',()=>copy(url));else b.disabled=true;const a=el('a','action'+(url?' primary':' disabled'),url?'导入 Surge':'暂不支持');if(url)a.href=installURL(p);else a.setAttribute('aria-disabled','true');box.append(b,a);return box;}
const statusText=p=>p.status==='converted'?(p.warnings?.length?'可安装 · 脚本待实测':'可安装 · 功能待实测'):p.status==='unavailable'?'来源异常 · 暂停安装':'暂不支持 · 查看原因';
function showDetail(p){
 const box=$('#detail-body');box.replaceChildren(el('div','detail-name',p.name),el('p','detail-desc',p.desc||''));
 const authors=el('section','detail-section');authors.append(el('strong',null,'原作者'));
 for(const [i,a]of(p.authors||[]).entries()){if(i)authors.append(document.createTextNode(' · '));const u=safeURL(a.url),n=el(u?'a':'span',null,a.name||'未注明');if(u){n.href=u;n.target='_blank';n.rel='noopener noreferrer';}authors.append(n);}
 box.append(authors);
 const info=el('section','detail-section');info.append(el('strong',null,'转换状态'),el('p',null,statusText(p)));
 if(p.reason)info.append(el('p','detail-desc',p.reason));
 if(p.warnings?.length){const ul=el('ul');for(const w of p.warnings)ul.append(el('li',null,w));info.append(ul);}
 info.append(el('p','detail-desc','配置转换完成不等于功能已验证。涉及 HTTPS 解密的模块需先安装并信任 Surge 证书；模块之间可能冲突，请按需安装。'));
 box.append(info);
 const src=el('section','detail-section');src.append(el('strong',null,'来源'));
 const u=safeURL(p.sourceURL);if(u){const a=el('a',null,p.filename||u);a.href=u;a.target='_blank';a.rel='noopener noreferrer';src.append(a);}else src.append(el('span','detail-desc',p.filename||'未提供'));
 box.append(src,actions(p));$('#details').showModal();
}
function render(){
 const q=state.query.trim().toLocaleLowerCase();
 let rows=catalog.filter(p=>(state.all||p.featured)&&(state.tag==='全部'||p.tags?.includes(state.tag))&&(state.compat==='all'||p.status===state.compat)&&(!q||[p.name,p.filename,p.desc,...(p.tags||[])].join(' ').toLocaleLowerCase().includes(q)));
 if(state.sort==='name')rows.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
 if(state.sort==='date')rows.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
 $('#count').textContent=(state.tag==='全部'?'全部':state.tag)+' · '+rows.length+' 个模块';
 $('#empty').hidden=rows.length>0;
 const frag=document.createDocumentFragment();
 for(const p of rows){
  const card=el('article','card'),top=el('div','card-main'),identity=el('div','identity');
  const fallback=el('span','fallback',(p.name||'Y').trim().slice(0,1).toUpperCase()),img=el('img','plugin-icon');const icon=safeURL(p.icon);
  if(icon){img.src=icon;img.loading='lazy';img.alt='';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>img.replaceWith(fallback),{once:true});identity.append(img);}else identity.append(fallback);
  const names=el('div');names.append(el('div','name',p.name),el('div','authors',(p.authors||[]).map(a=>a.name).filter(Boolean).join(' · ')||'未注明作者'));
  identity.append(names);top.append(identity,el('p','description',p.desc||''));
  top.tabIndex=0;top.setAttribute('role','button');top.setAttribute('aria-label','查看 '+p.name+' 详情');
  top.addEventListener('click',()=>showDetail(p));
  top.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showDetail(p);}});
  const bottom=el('div','card-bottom'),meta=el('div','metadata'),tags=el('div','tags');
  for(const t of(p.tags||[]).slice(0,2))tags.append(el('span','tag',t));
  meta.append(tags,el('time','date',(p.date||'').slice(0,16)));
  bottom.append(meta,actions(p),el('div','status'+(p.status==='converted'?' ok':''),statusText(p)));
  card.append(top,bottom);frag.append(card);
 }
 $('#grid').replaceChildren(frag);
}
function home(){
 Object.assign(state,{query:'',tag:'全部',sort:'default',all:false,compat:'all'});
 $('#search').value='';$('#all').checked=false;$('#compat').value='all';
 document.querySelectorAll('[data-sort]').forEach(b=>b.classList.toggle('selected',b.dataset.sort==='default'));
 document.querySelectorAll('[data-tag]').forEach(b=>b.classList.toggle('selected',b.dataset.tag==='全部'));
 $('#about')?.classList.remove('active');$('#about')?.setAttribute('aria-pressed','false');
 if($('#details').open)$('#details').close();
 render();window.scrollTo(0,0);
}
$('#home').addEventListener('click',e=>{e.preventDefault();home();});
$('#search').addEventListener('input',e=>{state.query=e.target.value;render();});
$('#all').addEventListener('change',e=>{state.all=e.target.checked;render();});
$('#compat').addEventListener('change',e=>{state.compat=e.target.value;render();});
document.querySelectorAll('[data-sort]').forEach(b=>b.addEventListener('click',()=>{state.sort=b.dataset.sort;document.querySelectorAll('[data-sort]').forEach(n=>n.classList.toggle('selected',n===b));render();}));
$('#close').addEventListener('click',()=>$('#details').close());
$('#details').addEventListener('click',e=>{if(e.target===$('#details')){const r=$('#details').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#details').close();}});
$('#details').addEventListener('close',()=>{$('#about').classList.remove('active');$('#about').setAttribute('aria-pressed','false');});
$('#about').addEventListener('click',()=>{
 const b=$('#detail-body');
 b.replaceChildren(el('div','detail-name','YanyuAd'),el('p','detail-desc','由 YANYU 设计与维护的 Surge 模块目录。界面为本项目原创，模块由第三方插件配置自动转换，原作者署名与来源保留在详情页。'));
 const lic=el('section','detail-section');lic.append(el('strong',null,'许可与声明'));
 const p=el('p','detail-desc','派生材料遵循 CC BY-NC-SA 4.0，仅限非商业使用。');const l=el('a',null,'来源与许可');l.href='/sources.html';lic.append(p,l);b.append(lic);
 const c=el('section','detail-section');c.append(el('strong',null,'版权'),el('p','detail-desc','© '+new Date().getFullYear()+' YANYU · 所有版权归 YANYU 所有'));
 b.append(c);
 $('#about').classList.add('active');$('#about').setAttribute('aria-pressed','true');
 $('#details').showModal();
});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('#details').open){e.preventDefault();$('#search').focus();}});
try{
 const r=await fetch('/data/catalog.json',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
 snapshot=await r.json();catalog=snapshot.plugins;
 if(!Array.isArray(catalog)||!catalog.length)throw Error('目录为空');
 const tags=['全部',...new Set(catalog.flatMap(p=>p.tags||[]))];
 for(const t of tags){const b=el('button',t==='全部'?'selected':null,t);b.type='button';b.dataset.tag=t;b.addEventListener('click',()=>{state.tag=t;document.querySelectorAll('[data-tag]').forEach(n=>n.classList.toggle('selected',n===b));render();});$('#categories').append(b);}
 const dt=new Date(snapshot.generated_at),age=Date.now()-dt,late=age>48*3600*1000;
 $('#sync').textContent='每日同步 · '+(late?'数据更新延迟 · ':'')+'更新于 '+dt.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 render();
}catch{
 $('#count').textContent='暂时无法载入';$('#error').textContent='模块目录加载失败，请稍后刷新重试。';$('#error').hidden=false;
}
