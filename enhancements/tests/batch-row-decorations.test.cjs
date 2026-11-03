'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.BATCH_DECORATION_SOURCE||path.join(__dirname,'../modules/02-plugin-registry-and-settings-schema.js'),'utf8');
function extract(name,next){const start=source.indexOf('  function '+name+'('),end=source.indexOf('\n  '+next,start);assert(start>=0&&end>start);return source.slice(start,end)}
function fixture({type='checkbox',editing=false}={}){
 const removed=[],attributes=new Map([['data-pi-enh-has-tags','true']]),parent={};
 const tag={firstElementChild:{},__renderedHtml:'retained',remove(){removed.push('tags')},parentElement:parent};
 const badge={parentElement:parent,textContent:'',getAttribute(){return null},setAttribute(){},remove(){removed.push('model')}};
 const count={parentElement:parent,nextSibling:badge};
 const meta={nextSibling:tag,parentElement:parent};parent.querySelector=()=>meta;
 const input={type};
 const row={querySelector(selector){if(selector==='input')return input;if(selector==='input:not([type="checkbox"])')return type==='checkbox'?null:input;if(selector==='.pi-enh-session-model-badge')return badge;if(selector==='.pi-enh-session-tags-row')return tag;if(selector==='.pi-enh-session-meta')return meta;return null},getAttribute(k){return k==='data-pi-enh-editing'?(editing?'true':null):attributes.get(k)},setAttribute(k,v){attributes.set(k,v)},removeAttribute(k){attributes.delete(k)}};
 const context={document:{createElement(){throw Error('existing decoration identity must be retained')}},isPluginEnabled:()=>true,findSessionMessageCountElement:()=>count,getSessionTags:()=>[{id:'tag',name:'Pi未完成',color:'#f59e0b'}],getTagPaletteItem:()=>({}),escapeHtml:x=>x};
 vm.createContext(context);vm.runInContext(extract('renderSessionModelLabel','async function fetchSessionModelMetadata')+'\n'+extract('syncSessionTagsRow','function removeSessionTagsRowAll'),context);
 return {removed,attributes,tag,badge,run(){context.renderSessionModelLabel(row,{provider:'test',modelId:'GPT-6.1',thinkingLevel:'high'});context.syncSessionTagsRow(row,'owned-session')}};
}
test('adding a batch checkbox retains tags and model/thinking metadata',()=>{const f=fixture();f.run();assert.deepEqual(f.removed,[]);assert.equal(f.attributes.get('data-pi-enh-has-tags'),'true');assert.equal(f.badge.textContent,'GPT-6.1 · high')});
test('a real rename input still hides tags and model metadata',()=>{const f=fixture({type:'text'});f.run();assert.deepEqual(f.removed,['model','tags']);assert.equal(f.attributes.has('data-pi-enh-has-tags'),false)});
test('the explicit rename flag still hides decorations even with a checkbox',()=>{const f=fixture({editing:true});f.run();assert.deepEqual(f.removed,['model','tags'])});
