'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../modules/03-session-cache-and-sync-engine.js'),'utf8');
const start=source.indexOf('  async function ensureSessionIngestedBeforeDelete('),end=source.indexOf('\n  // ==========================================',start);
function fixture({failLoad=false,running=false,changed=false}={}){
 const events=[],map=new Map();let ingested=false;
 const context={AbortController,setTimeout,clearTimeout,Date,knownSessionsMap:map,isSessionIngested:()=>ingested,originalWindowFetch:null,window:{location:{hostname:'127.0.0.1',port:'39031'}}};
 context.baseFetch=async url=>{events.push(url);const body=url.includes('/api/usage/ledger')?{version:2,buckets:[]}:url.includes('/api/sessions/')?{sessionId:'owned',leafId:changed&&ingested?'changed':'leaf',usageDeleteGuard:0}:{sessions:[{id:'owned'}],runningSessionIds:running?['owned']:[]};return{ok:true,json:async()=>body};};
 context.isSessionIngested=(_id,meta)=>ingested&&meta.leafId==='leaf';
 context.window.__PI_ENH_LOAD_OPTIONAL__=async name=>{events.push(name);if(failLoad)throw Error('组件失败');context.window.PiUsagePanel={fetchSnapshotOnce:async signal=>{assert(signal instanceof AbortSignal);events.push('snapshot');ingested=true;}};};
 vm.runInNewContext(source.slice(start,end)+'\nthis.guard=ensureSessionIngestedBeforeDelete;',context);return{context,events,map};
}
test('deletion guard loads the panel only when sealing is needed and rechecks the current leaf',async()=>{
 const f=fixture();assert.equal(await f.context.guard('owned'),true);assert.equal(f.events.filter(x=>x==='usage-panel').length,1);assert(f.events.indexOf('usage-panel')<f.events.indexOf('snapshot'));assert.equal(f.map.get('owned').leafId,'leaf');assert(f.events.includes('/api/usage/ledger'));assert(!f.events.some(x=>String(x).includes('http:')));assert.equal(f.events.filter(x=>x.includes('/api/sessions?')).length,2);
});
test('component failure, active execution, and concurrent leaf changes all block deletion',async()=>{
 for(const options of [{failLoad:true},{running:true},{changed:true}]){const f=fixture(options);await assert.rejects(f.context.guard('owned'),/删除已取消/);assert.equal(f.map.size,0);assert(!f.events.some(x=>/DELETE/.test(x)));if(options.running)assert(!f.events.includes('usage-panel'));}
});
test('native Codex deletion is checked by its owner and never enters the Pi usage seal',async()=>{
 const f=fixture();assert.equal(await f.context.guard('codex:01901234-5678-7000-8000-000000000001'),true);
 assert.deepEqual(f.events,[]);assert.equal(f.map.size,0);
 await assert.rejects(f.context.guard('codex:invalid'),/删除已取消/);
});
