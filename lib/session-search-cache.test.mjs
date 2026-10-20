import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {getSessionSearchCatalogScope} from './enhancement-sidebar-bridge.ts';

// Execute only the real data-search callbacks, not the frontend runtime/IIFE.
const text=fs.readFileSync(new URL('../enhancements/modules/03-session-cache-and-sync-engine.js',import.meta.url),'utf8');
const parsed=ts.createSourceFile('search.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const names=new Set(['getSearchCacheKey','getNativeSearchCatalog','getFromSearchCache','setToSearchCache','invalidateSearchCache','findNarrowableParentCache','handleEnhancedSessionSearch']);
const nodes=[];const visit=node=>{if(ts.isFunctionDeclaration(node)&&names.has(node.name?.text))nodes.push(node.getText(parsed));ts.forEachChild(node,visit);};visit(parsed);
assert.equal(nodes.length,names.size,'Actual search callbacks must be uniquely extracted');
const body=`const SESSION_SEARCH_CACHE=new Map();const SEARCH_CACHE_MAX_SIZE=120,SEARCH_CACHE_TTL=300000;let activeSearchAbortController=null;${nodes.join('\n')} return {search:handleEnhancedSessionSearch};`;
const row=(id,name,messageCount=1)=>({id,name,path:'/sessions/'+id+'.jsonl',cwd:'/work',firstMessage:name,messageCount,modified:'old'});
const hit=session=>({session,blockIndex:0,before:'body ',match:'clipro',after:' context'});
function harness(initial,fetchFn){
 let catalog=initial,calls=0;
 const deps={window:{location:{href:'http://fixture/'},__PI_ENH_GET_SEARCH_CATALOG__:()=>({sessions:catalog,scope:getSessionSearchCatalogScope(catalog)})},
  originalWindowFetch:async(...args)=>{calls++;return fetchFn(...args);},baseFetch:null,activeSessionFilterTagId:'all',knownSessionsMap:new Map([['ghost',row('ghost','CLIProxy stale')]]),
  createCachedResponse:data=>new Response(JSON.stringify(data)),scheduleSearchResultsHighlight(){},isPluginEnabled:()=>false,readSessionTagMappings:()=>({}),
  URL,Headers,Response,AbortController,Map,Set,Date};
 const functions=new Function('deps',`with(deps){${body}}`)(deps);
 return {deps,setCatalog:next=>catalog=next,calls:()=>calls,search:async q=>(await functions.search('/api/sessions/search?q='+q,{},'http://fixture/api/sessions/search?q='+q)).json()};
}

test('title matching uses current native catalogue and never resurrects old known metadata',async()=>{
 const a=row('body','unrelated'),b=row('title','CLIProxy settings');
 const h=harness([a,b],async()=>new Response(JSON.stringify({results:[hit(a)],truncated:false})));
 const result=await h.search('clipro');assert.deepEqual(result.results.map(x=>x.session.id).sort(),['body','title']);assert.equal(h.calls(),1);
});
test('same query reuses a stable catalogue, ignores activity timestamps, and invalidates removal',async()=>{
 const a=row('body','unrelated'),b=row('title','CLIProxy settings');
 const h=harness([a,b],async()=>new Response(JSON.stringify({results:[hit(a)],truncated:false})));
 await h.search('clipro');await h.search('clipro');assert.equal(h.calls(),1);
 h.setCatalog([{...a,modified:'new'},{...b,modified:'new'}]);await h.search('clipro');assert.equal(h.calls(),1);
 h.setCatalog([a]);const result=await h.search('clipro');assert.equal(h.calls(),2);assert.deepEqual(result.results.map(x=>x.session.id),['body']);
});
test('same query refetches when a session message count grows, but not for modified-only activity',async()=>{
 const a=row('body','unrelated',1),b=row('title','CLIProxy settings',1);
 const h=harness([a,b],async()=>new Response(JSON.stringify({results:[hit(a)],truncated:false})));
 await h.search('clipro');
 h.setCatalog([{...a,modified:'new'},{...b,modified:'new'}]);
 await h.search('clipro');assert.equal(h.calls(),1);
 h.setCatalog([{...a,messageCount:2},{...b,modified:'new'}]);
 await h.search('clipro');assert.equal(h.calls(),2);
});
test('prefix narrowing cannot cross catalogue identities',async()=>{
 const a=row('body','unrelated'),b=row('title','CLIProxy settings');
 const h=harness([a,b],async()=>new Response(JSON.stringify({results:[hit(a)],truncated:false})));
 await h.search('clip');h.setCatalog([a]);const result=await h.search('clipro');assert.equal(h.calls(),2);assert.deepEqual(result.results.map(x=>x.session.id),['body']);
});
test('late old search cannot overwrite the current-scope cache',async()=>{
 const old=row('old','CLIProxy old'),current=row('current','CLIProxy current');let release,request=0;
 const h=harness([old],async()=>{if(++request===1){await new Promise(r=>release=r);return new Response(JSON.stringify({results:[hit(old)],truncated:false}));}return new Response(JSON.stringify({results:[hit(current)],truncated:false}));});
 const pending=h.search('clipro');h.setCatalog([current]);assert.equal((await h.search('clipro')).results[0].session.id,'current');release();await pending;
 assert.equal((await h.search('clipro')).results[0].session.id,'current');assert.equal(h.calls(),2);
});
test('absence of the native bridge delegates to server results without local-title/cache fallback',async()=>{
 const a=row('body','unrelated'),h=harness([a],async()=>new Response(JSON.stringify({results:[hit(a)],truncated:false})));
 delete h.deps.window.__PI_ENH_GET_SEARCH_CATALOG__;
 assert.deepEqual((await h.search('clipro')).results.map(x=>x.session.id),['body']);await h.search('clipro');assert.equal(h.calls(),2);
});
test('tag scopes retain independent cached results',async()=>{
 const a=row('a','CLIProxy A'),b=row('b','CLIProxy B'),h=harness([a,b],async()=>new Response(JSON.stringify({results:[],truncated:false})));
 h.deps.isPluginEnabled=()=>true;h.deps.readSessionTagMappings=()=>({a:['first'],b:['second']});h.deps.activeSessionFilterTagId='first';
 assert.deepEqual((await h.search('clipro')).results.map(x=>x.session.id),['a']);h.deps.activeSessionFilterTagId='second';
 assert.deepEqual((await h.search('clipro')).results.map(x=>x.session.id),['b']);assert.equal(h.calls(),2);
});

test('identity lookups reach the real fetch with original abort/cache options and never read history caches',async()=>{
 let callback;
 const find=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='cachedSessionFetch')callback=node.getText(parsed);ts.forEachChild(node,find);};find(parsed);
 assert.ok(callback);
 for(const suffix of ['?lookup=1','?tail=50&lookup=1&x=2']){
  const input='/api/sessions/current'+suffix,controller=new AbortController(),init={cache:'no-store',signal:controller.signal};let calls=0;
  const response=new Response(JSON.stringify({sessionId:'current',exists:true}));
  const deps={baseFetch:async(gotInput,gotInit)=>{calls++;assert.equal(gotInput,input);assert.equal(gotInit,init);return response;},originalWindowFetch:null,getOrCreateSessionEntry(){assert.fail('Identity lookup must never read a cached transcript');},isPluginEnabled(){assert.fail('Identity lookup must bypass the cache plugin');}};
  const fetchIdentity=new Function('deps',`with(deps){${callback};return cachedSessionFetch;}`)(deps);
  assert.equal(await fetchIdentity(input,init),response);assert.equal(calls,1);
 }
});
