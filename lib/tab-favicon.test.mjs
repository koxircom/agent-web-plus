import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createJiti } from 'jiti';
const j=createJiti(import.meta.url,{tsconfigPaths:true});
const {buildTabFaviconSvg,mountTabFavicon}=await j.import('./tab-favicon.ts');

test('engine symbols share the brand geometry and switch without a Pi symbol in Codex',()=>{
 for(const engine of ['pi','codex']){const svg=buildTabFaviconSvg(engine);assert.match(svg,new RegExp('data-brand-symbol="'+engine+'"'));assert.match(svg,/#4F5AE8/);assert.match(svg,/#7850E8/);assert.doesNotMatch(svg,/<text/);}
 assert.doesNotMatch(buildTabFaviconSvg('codex'),/data-brand-symbol="pi"/);
});
test('running and waiting badge counts retain their own colors and base symbol',()=>{
 for(const engine of ['pi','codex']){const attention=buildTabFaviconSvg(engine,{count:5,running:2,attention:3,hasAttention:true});assert.match(attention,/#f59e0b/);assert.match(attention,/>3<\/text>/);const running=buildTabFaviconSvg(engine,{count:2,running:2,attention:0,hasAttention:false});assert.match(running,/#3b82f6/);assert.match(running,/>2<\/text>/);assert.match(buildTabFaviconSvg(engine,{count:12,running:12}),/>9\+<\/text>/);}
});
test('unavailable, empty and invalid state removes stale badges',()=>{
 for(const status of [{count:0,running:3},{count:3,running:3,healthy:false},{count:3,running:Infinity},{count:3,running:-3}])assert.doesNotMatch(buildTabFaviconSvg('codex',status),/<text/);
});
class Icon {
 constructor(attrs={}){this.attrs={...attrs};this.sizes={set value(v){this.owner.attrs.sizes=v;},owner:this};this.removed=false;}
 getAttribute(n){return this.attrs[n]??null;}setAttribute(n,v){this.attrs[n]=v;}removeAttribute(n){delete this.attrs[n];}remove(){this.removed=true;}set href(v){this.attrs.href=v;}set type(v){this.attrs.type=v;}set rel(v){this.attrs.rel=v;}
}
function fixture(icons){const win=new EventTarget();const doc={head:{querySelectorAll:()=>icons,appendChild:n=>icons.push(n)},createElement:()=>new Icon()};return{doc,win};}
test('the native owner switches every fallback and restores exact metadata on unmount',()=>{
 const originals=[{href:'/icon.svg',type:'image/svg+xml',sizes:'any'},{href:'/favicon.ico',sizes:'32x32'}],icons=originals.map(a=>new Icon(a)),{doc,win}=fixture(icons);let stop=mountTabFavicon('pi',doc,win);assert(icons.every(i=>decodeURIComponent(i.attrs.href).includes('data-brand-symbol="pi"')));stop();assert.deepEqual(icons.map(i=>i.attrs),originals);stop=mountTabFavicon('codex',doc,win);win.__PI_WEB_PROJECT_TAB_STATUS__={count:2,running:2};win.dispatchEvent(new Event('pi-web-project-tab-status-change'));assert(icons.every(i=>decodeURIComponent(i.attrs.href).includes('>2</text>')));assert(icons.every(i=>decodeURIComponent(i.attrs.href).includes('data-brand-symbol="codex"')));stop();assert.deepEqual(icons.map(i=>i.attrs),originals);win.__PI_WEB_PROJECT_TAB_STATUS__={count:3,running:3};win.dispatchEvent(new Event('pi-web-project-tab-status-change'));assert.deepEqual(icons.map(i=>i.attrs),originals);
});
test('a missing fallback creates one managed link and removes it on cleanup',()=>{
 const icons=[],{doc,win}=fixture(icons);const stop=mountTabFavicon('codex',doc,win);assert.equal(icons.length,1);stop();assert(icons[0].removed);
});
test('AppShell supplies the current engine and explicit initial navigation hint',()=>{
 const source=fs.readFileSync(new URL('../components/AppShell.tsx',import.meta.url),'utf8');assert.match(source,/useTabFavicon\(executionEngineReady \? activeExecutionEngine : navigationEngine\(initialNavigation\) \?\? activeExecutionEngine\)/);
});
