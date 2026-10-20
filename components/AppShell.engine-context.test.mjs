import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { transform } from 'esbuild';
import { navigationEngine, withTabOpen, getInitialNavigation } from '../lib/initial-navigation.ts';
import { newSessionUrl } from '../lib/session-navigation.ts';
const source = await readFile(new URL('./AppShell.tsx', import.meta.url), 'utf8');
const syntax = ts.createSourceFile('AppShell.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function effectContaining(marker) {
  let match;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'useEffect' && node.getText(syntax).includes(marker)) match = node.getText(syntax);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(match, marker);
  return match;
}
const startup = (await transform(effectContaining('const generation = ++executionEngineSwitchRef.current'), {loader:'tsx'})).code;
const validation = (await transform(effectContaining('const requestedCwd = initialNavigation.requestedCwd'), {loader:'tsx'})).code;
const settle = async () => { for(let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve)); };
function harness(query, defaults = 'pi') {
  const context = vm.createContext({
    AbortController, URLSearchParams, navigationEngine, withTabOpen, newSessionUrl,
    initialNavigation: getInitialNavigation(new URLSearchParams(query)),
    getTabOpen: () => null,
    executionEngineReady: true, executionEngineRef:{current:'pi'}, executionEngineSwitchRef:{current:0}, executionEngineInitControllerRef:{current:null},
    navigationIntentRef:{current:0}, initialSessionIdRef:{current:null}, initialCwdEngineRef:{current:null}, codexProjectsRef:{current:[]},
    calls:[], urls:[], cwd:null,
    applyExecutionEngine(engine,cwd,reset){ context.calls.push({engine,cwd,reset});context.executionEngineRef.current=engine; },
    setCodexEnabled(){}, useEffect(fn){ context.cleanup=fn(); },
    setInitialCwdStatus(value){context.status=value;}, setInitialCwdError(){},
    suppressCwdBumpRef:{current:false}, activeNewSessionDraftKeyRef:{current:null}, setNewSessionDraftId(){},
    setNewSessionCwd(cwd){context.cwd=cwd;}, replaceSessionUrl(url){context.urls.push(url);},
    fetch: async url => ({ok:true,json:async()=>url.includes('/check') ? {connected:true,projects:[{cwd:'/remote'}]} : {defaultEngine:defaults,codex:{enabled:true}}}),
  });
  return context;
}
test('explicit Codex cwd beats a Pi default without replacing the requested directory', async () => {
  const c=harness('engine=codex&cwd=/remote');vm.runInContext(startup,c);await settle();
  assert.equal(c.initialCwdEngineRef.current,'codex');assert.equal(c.calls.at(-1).engine,'codex');assert.equal(c.calls.at(-1).reset,false);
});
test('Pi cwd link stays Pi with a Codex default and avoids optional Bridge probe', async () => {
  const c=harness('engine=pi&cwd=/local','codex');let requests=[];const fetch=c.fetch;c.fetch=url=>{requests.push(url);return fetch(url);};
  vm.runInContext(startup,c);await settle();assert.equal(c.calls.at(-1).engine,'pi');assert.equal(requests.length,1);
});
test('initial cwd validation uses the route engine and discards late success after project navigation', async () => {
  const c=harness('engine=codex&cwd=/remote');c.initialCwdEngineRef.current='codex';c.executionEngineRef.current='codex';
  let finish;const pending=new Promise(resolve=>finish=resolve);let body;
  c.fetch=async(_url,options)=>{body=JSON.parse(options.body);return pending;};
  vm.runInContext(validation,c);assert.deepEqual(body,{cwd:'/remote',engine:'codex'});
  c.navigationIntentRef.current++;finish({ok:true,json:async()=>({cwd:'/remote'})});await settle();assert.equal(c.cwd,null);assert.equal(c.urls.length,0);
});
test('matching validation canonicalizes both engine and cwd in the URL', async () => {
  const c=harness('engine=codex&cwd=/remote');c.initialCwdEngineRef.current='codex';c.executionEngineRef.current='codex';
  c.fetch=async()=>({ok:true,json:async()=>({cwd:'/remote'})});vm.runInContext(validation,c);await settle();
  assert.equal(c.cwd,'/remote');assert.equal(c.urls[0],'?engine=codex&cwd=%2Fremote');
});

test('legacy cwd link changes host only after rejection plus positive validation', async () => {
  const c=harness('cwd=/remote');const original=c.fetch;const hosts=[];
  c.fetch=async(url,options)=>{
    if(url==='/api/cwd/validate') {const engine=JSON.parse(options.body).engine;hosts.push(engine);return {ok:engine==='codex',status:engine==='codex'?200:400};}
    return original(url,options);
  };
  vm.runInContext(startup,c);await settle();assert.equal(c.initialCwdEngineRef.current,'codex');assert.deepEqual(hosts,['pi','codex']);
});
test('ambiguous legacy directory remains with the default host', async () => {
  const c=harness('cwd=/both');const original=c.fetch;const hosts=[];
  c.fetch=async(url,options)=>{
    if(url==='/api/cwd/validate') {hosts.push(JSON.parse(options.body).engine);return {ok:true};}
    return original(url,options);
  };
  vm.runInContext(startup,c);await settle();assert.equal(c.initialCwdEngineRef.current,'pi');assert.deepEqual(hosts,['pi']);
});

test('temporary host failures do not reroute a legacy Codex workspace to Pi', async () => {
  const c=harness('cwd=/remote','codex');const original=c.fetch;const hosts=[];
  c.fetch=async(url,options)=>{
    if(url==='/api/cwd/validate') {hosts.push(JSON.parse(options.body).engine);return {ok:false,status:503};}
    return original(url,options);
  };
  vm.runInContext(startup,c);await settle();assert.equal(c.initialCwdEngineRef.current,'codex');assert.deepEqual(hosts,['codex']);
});

test('network failure during legacy detection keeps the host and still mounts the sidebar', async () => {
  const c=harness('cwd=/local');const original=c.fetch;
  c.fetch=async(url,options)=>{if(url==='/api/cwd/validate')throw new TypeError('Failed to fetch');return original(url,options);};
  vm.runInContext(startup,c);await settle();assert.equal(c.initialCwdEngineRef.current,'pi');assert.equal(c.calls.at(-1).engine,'pi');
});
