import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const shell=read('./AppShell.tsx'),sidebar=read('./SessionSidebar.tsx'),control=read('./ExecutionEngineSwitcher.tsx'),selector=read('./ModelSelector.tsx');
test('header reuses the responsive model menu and preserves engine availability and real status',()=>{
 assert.match(control,/import \{ ModelSelector, type ModelSelectorOption \} from "\.\/ModelSelector"/);
 assert.match(control,/ariaLabel="切换 Agent"/);
 assert.match(control,/selectedLabel=\{engine === "pi" \? "Pi Agent" : "Codex"\}/);
 assert.match(control,/placement="down"/);assert.match(control,/disabled=\{pending \|\| !onChange\}/);
 assert.match(control,/disabled: !codexEnabled/);assert.doesNotMatch(control,/<select/);
 assert.match(selector,/placement\?: "up" \| "down" \| "auto"/);
 assert.match(selector,/disabled\?: boolean/);assert.match(selector,/disabled=\{disabled\}/);
 assert.match(sidebar,/<ExecutionEngineSwitcher engine=\{executionEngine\} connected=\{runningStatusHealthy\}/);
 assert(!sidebar.includes('<PiWebTitle'));
 assert.match(shell,/onExecutionEngineChange=\{switchExecutionEngine\}/);
});
test('new Codex drafts use the selected project and leave authorization to the server',()=>{
 const start=shell.indexOf('    const cwd =',shell.indexOf('const handleNewSession'));
 const end=shell.indexOf('    if (!cwd) return;',start);
 const statement=stripTypeScriptTypes(shell.slice(start,end)+';globalThis.actual=cwd;');
 for(const requestedCwd of ['/CODEX','/Work','/odoo']){
  const context={requestedCwd,executionEngineRef:{current:'codex'},codexProjectsRef:{current:['/CODEX','/Work','/odoo']},codexCwdRef:{current:'/CODEX'}};
  vm.runInNewContext(statement,context);assert.equal(context.actual,requestedCwd);
 }
 const context={requestedCwd:'/outside',executionEngineRef:{current:'codex'},codexProjectsRef:{current:['/CODEX']},codexCwdRef:{current:'/CODEX'}};
 vm.runInNewContext(statement,context);assert.equal(context.actual,'/outside');
 const engine=fs.readFileSync(new URL('../lib/execution-engines/codex-engine.ts',import.meta.url),'utf8');assert.match(engine,/codexProjects\(\)\)\.find\(p => p\.cwd === cwd\)/);assert.match(engine,/if \(!project\) throw new Error/);
});
test('stale engine-switch completion cannot reset a newer navigation choice',async()=>{
 const start=shell.indexOf('  const switchExecutionEngine = useCallback'),end=shell.indexOf('  // Global keyboard shortcuts',start);
 const deferred=Promise.withResolvers(),applied=[];
 const context={useCallback:f=>f,executionEngineSwitchRef:{current:0},executionEngineInitControllerRef:{current:null},fetch:()=>deferred.promise,setCodexEnabled(){},applyExecutionEngine:(...a)=>applied.push(a),codexProjectsRef:{current:[]},codexCwdRef:{current:null}};
 vm.runInNewContext(stripTypeScriptTypes(shell.slice(start,end)+';globalThis.switchEngine=switchExecutionEngine;'),context);
 const pending=context.switchEngine('pi');context.executionEngineSwitchRef.current++;
 deferred.resolve({ok:true,json:async()=>({defaultEngine:'pi',codex:{enabled:true}})});await pending;
 assert.deepEqual(applied,[]);
});
test('a visible authorized project remains usable while startup metadata is still loading',()=>{
 const start=shell.indexOf('    const cwd =',shell.indexOf('const handleNewSession')),end=shell.indexOf('    if (!cwd) return;',start);
 const context={requestedCwd:'/Work',executionEngineRef:{current:'codex'},codexProjectsRef:{current:[]},codexCwdRef:{current:null}};
 vm.runInNewContext(stripTypeScriptTypes(shell.slice(start,end)+';globalThis.actual=cwd;'),context);
 assert.equal(context.actual,'/Work');
});

test('a reloaded draft cwd is scoped to its initial engine during switching',()=>{
 assert.match(shell,/initialCwd=\{initialCwdEngineRef.current === catalogEngine \? initialNavigation.requestedCwd : null\}/);
 assert.match(shell,/skipInitialProjectSelection=\{initialCwdEngineRef.current === catalogEngine && initialNavigation.requestedCwd !== null\}/);
});
test('an open shared menu consumes Escape before the task guard, skips IME, and restores focus',()=>{
 const start=selector.indexOf('    const handleMenuEscape ='),end=selector.indexOf('    window.addEventListener("keydown", handleMenuEscape, true);',start);
 assert(start>=0&&end>start);assert.match(selector,/window.removeEventListener\("keydown", handleMenuEscape, true\)/);
 const results=[],scope={setOpen:v=>results.push(['open',v]),setFilter:v=>results.push(['filter',v]),triggerRef:{current:{focus:v=>results.push(['focus',v.preventScroll])}}};
 vm.runInNewContext(stripTypeScriptTypes(selector.slice(start,end))+';globalThis.escape=handleMenuEscape;',scope);
 const event={key:'Escape',isComposing:false,preventDefault:()=>results.push(['prevent']),stopPropagation:()=>results.push(['stop'])};
 scope.escape({...event,isComposing:true});assert.equal(results.length,0);
 scope.escape(event);assert.deepEqual(results,[['prevent'],['stop'],['filter',''],['open',false],['focus',true]]);
});

test('Agent labels shrink to their text while model field labels retain their default stretch',()=>{
 const css=read('../app/globals.css');
 assert.match(css,/\[data-pi-native-engine-switcher\] \.model-selector > button \{[^}]*--model-selector-label-flex: 0 1 auto;/);
 assert.match(selector,/flex: "var\(--model-selector-label-flex, 1\)"/);
});
