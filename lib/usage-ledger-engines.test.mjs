import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {combineUsageLedgers,readUsageByEngine}=await createJiti(import.meta.url).import('./usage-ledger-engines.ts');
const bucket=(engine,number)=>({engine,source:engine,sessionId:engine+':fixture',provider:'fixture',model:'fixture',role:'main',day:'2026-10-18',inputTokens:number,outputTokens:10,cacheReadTokens:20,cacheWriteTokens:0,totalTokens:number+30,messageCount:1,calls:1,records:1,costNano:engine==='pi'?1000:0,unpricedTokens:engine==='pi'?0:number+30,missingUsage:0});
const ledger=(engine,number)=>({version:2,snapshotId:engine,generatedAt:'2026-10-18T00:00:00Z',buckets:[bucket(engine,number)],sources:{[engine]:{fileCount:1}},sessions:{[engine+':fixture']:{name:engine}}});
const pi={value:{ledger:ledger('pi',100),mode:'legacy-central'}};
test('combined ledger reconciles physical components and preserves namespaced sessions',()=>{
 const {ledger:l,mode}=combineUsageLedgers(pi,{value:ledger('codex',200)});
 assert.equal(mode,'legacy-central');assert.equal(l.totals.totalTokens,360);assert.equal(l.totals.inputTokens,300);assert.equal(l.totals.cacheReadTokens,40);assert.equal(l.totals.costNano,1000);assert.equal(l.totals.unpricedTokens,230);assert.equal(Object.keys(l.sessions).length,2);assert.equal(l.engineStatus.codex.status,'ready');
});
test('unavailable and loading Codex are explicit partial coverage instead of complete zero',()=>{
 const absent=combineUsageLedgers(pi,{error:new Error('private remote detail')}).ledger;
 assert.equal(absent.engineStatus.codex.status,'unavailable');assert(!JSON.stringify(absent).includes('private remote'));assert.equal(absent.totals.totalTokens,130);
 const pending=combineUsageLedgers(pi,{value:{...ledger('codex',200),loading:true}}).ledger;
 assert.equal(pending.engineStatus.codex.status,'loading');assert.equal(pending.totals.totalTokens,360);assert.notEqual(pending.snapshotId,absent.snapshotId);
});
test('Pi failure can leave Codex view usable; disabled connector keeps existing Pi snapshot identity',()=>{
 const c=combineUsageLedgers({error:new Error('pi unavailable')},{value:ledger('codex',200)}).ledger;
 assert.equal(c.engineStatus.pi.status,'unavailable');assert.equal(c.totals.totalTokens,230);
 const p=combineUsageLedgers(pi,{value:null}).ledger;assert.equal(p.snapshotId,'pi');assert.equal(p.engineStatus.codex.status,'disabled');
 assert.throws(()=>combineUsageLedgers({error:new Error('none')},{value:null}),/none/);
});
test('read path isolates failures and uses a single read from each producer',async()=>{
 let reads=0;const result=await readUsageByEngine(async()=>{reads++;return pi.value},async()=>{reads++;throw new Error('down')});assert.equal(reads,2);assert.equal(result.ledger.engineStatus.codex.status,'unavailable');
});

test('partial Codex tails and counter gaps cannot masquerade as complete coverage',()=>{
 const tail=combineUsageLedgers(pi,{value:{...ledger('codex',200),sources:{codex:{complete:false,counterGapCount:0}}}}).ledger;assert.equal(tail.engineStatus.codex.status,'loading');
 const gap=combineUsageLedgers(pi,{value:{...ledger('codex',200),sources:{codex:{complete:false,counterGapCount:1}}}}).ledger;assert.equal(gap.engineStatus.codex.status,'unavailable');assert.equal(gap.totals.totalTokens,360);
});

test('missing native history files are explicit partial statistics and retain available totals',()=>{
 const result=combineUsageLedgers(pi,{value:{...ledger('codex',200),sources:{codex:{complete:false,unavailableHistoryCount:2}}}}).ledger;assert.equal(result.engineStatus.codex.status,'partial');assert.match(result.engineStatus.codex.message,/2/);assert.equal(result.totals.totalTokens,360);
});
