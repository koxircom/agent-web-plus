import test from 'node:test';
import assert from 'node:assert/strict';
import {isBrowserTabAppearance,formatBrowserTabTitle,mountTabThemeColor} from './browser-tab-appearance.ts';
const prefs={titleTemplate:'{project} · {agent} · {text}',logoColor:'#ff6600',themeColor:'#112233'};
test('templates resolve per-project and per-engine without interpreting custom text as tokens',()=>{
 assert(isBrowserTabAppearance(prefs));
 assert.equal(formatBrowserTabTitle(prefs,{project:'Work',agent:'Codex',text:'正式 {project}',app:'Agent Web Plus'}),'Work · Codex · 正式 {project}');
 assert.equal(formatBrowserTabTitle({...prefs,titleTemplate:'{text}'},{project:'odoo',agent:'Pi Agent',text:'',app:'Agent Web Plus'}),'odoo');
 assert.equal(formatBrowserTabTitle({...prefs,titleTemplate:'{app}'},{project:'',agent:'Codex',text:'',app:'Agent Web Plus'}),'Agent Web Plus');
});
test('empty template fields do not leave orphan separators',()=>{
 const base={project:'Work',agent:'Codex',text:'',app:'Agent Web Plus'};
 assert.equal(formatBrowserTabTitle({...prefs,titleTemplate:'{project} · {text}'},base),'Work');
 assert.equal(formatBrowserTabTitle({...prefs,titleTemplate:'{text} · {project}'},base),'Work');
 assert.equal(formatBrowserTabTitle({...prefs,titleTemplate:'{project} · {text} · {agent}'},base),'Work · Codex');
 assert.equal(formatBrowserTabTitle({...prefs,titleTemplate:'{project} - {app}'},{...base,project:''}),'Agent Web Plus');
 assert.equal(formatBrowserTabTitle({...prefs,titleTemplate:'Custom: {text}'},base),'Custom:');
});
test('preferences reject unsupported tokens, controls, extra fields, excessive text and SVG color injection',()=>{
 for(const patch of [{titleTemplate:''},{titleTemplate:'  '},{titleTemplate:'{cwd}'},{titleTemplate:'{project'},{titleTemplate:'x\ny'},{titleTemplate:'😀'.repeat(161)},{logoColor:'red'},{themeColor:'\"/><script>'},{extra:true}])assert.equal(isBrowserTabAppearance({...prefs,...patch}),false,JSON.stringify(patch));
 assert(isBrowserTabAppearance({...prefs,titleTemplate:'😀'.repeat(160),logoColor:'',themeColor:''}));
});
class Meta{
 constructor(content){this.attrs=content==null?{}:{content};this.removed=false;}
 getAttribute(k){return this.attrs[k]??null;}setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}remove(){this.removed=true;}set content(v){this.attrs.content=v;}
}
test('theme owner restores each light/dark fallback and removes only its created metadata',()=>{
 const metas=[new Meta('#ffffff'),new Meta('#000000')];const doc={head:{querySelectorAll:()=>metas,appendChild:m=>metas.push(m)},createElement:()=>new Meta()};
 const stop=mountTabThemeColor('#112233',doc);assert.deepEqual(metas.map(m=>m.attrs.content),['#112233','#112233']);stop();assert.deepEqual(metas.map(m=>m.attrs.content),['#ffffff','#000000']);
 metas.length=0;const clean=mountTabThemeColor('#123456',doc);assert.equal(metas.length,1);clean();assert(metas[0].removed);
 assert.doesNotThrow(()=>mountTabThemeColor('invalid',{}));
});
