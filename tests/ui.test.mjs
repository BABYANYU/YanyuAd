import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.events={};this.dataset={};this.attributes={};this.textContent='';this.classList={add(){},remove(){},toggle(){}};}
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,f){this.events[k]=f;}select(){}remove(){this.removed=true;}showModal(){this.open=true;}close(){this.open=false;}
}
function nodes(e){return [e,...e.children.flatMap(nodes)];}
async function fixture(legacyCopyResult){
 const elements=new Map();for(const id of ['home','toast','detail-body','details','grid','count','empty','search','close','error','sync','categories'])elements.set('#'+id,new Element());
 const made=[];const document={body:new Element('body'),querySelector:s=>elements.get(s),querySelectorAll:()=>[],createElement:tag=>{const e=new Element(tag);made.push(e);return e;},createDocumentFragment:()=>new Element('fragment'),execCommand:()=>legacyCopyResult};
 const plugin={name:'Example',module:'/modules/example.sgmodule',tags:[],icon:null};
 await vm.runInNewContext('(async()=>{'+source+'})()',{document,navigator:{clipboard:{writeText:async()=>{throw Error('denied');}}},location:{origin:'https://ad.fakeyou.eu.org'},URL,Intl,Date,console,window:{scrollTo(){}},setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({generated_at:'2026-11-02T00:00:00Z',plugins:[plugin]})})},{timeout:2000});
 return {elements,made,all:nodes(elements.get('#grid'))};
}
test('legacy clipboard failure is reported as failure and the temporary field is removed',async()=>{const f=await fixture(false);await f.all.find(e=>e.tagName==='BUTTON'&&e.textContent==='复制').events.click();assert.equal(f.elements.get('#toast').textContent,'复制失败');assert.equal(f.made.find(e=>e.tagName==='TEXTAREA').removed,true);});
test('legacy clipboard success is reported accurately',async()=>{const f=await fixture(true);await f.all.find(e=>e.tagName==='BUTTON'&&e.textContent==='复制').events.click();assert.equal(f.elements.get('#toast').textContent,'已复制');});
test('missing icons use the fallback immediately and the detail title labels the dialog',async()=>{const f=await fixture(false);assert.equal(f.all.some(e=>e.tagName==='IMG'),false);await f.all.find(e=>e.attributes.role==='button').events.click();const heading=f.elements.get('#detail-body').children[0];assert.equal(heading.id,'detail-name');assert.equal(heading.textContent,'Example');assert.equal(f.elements.get('#details').open,true);});
