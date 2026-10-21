import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCodexPage, projectCodexRow, projectCodexSession } from './codex-projection.ts';
const meta = {id:'12345678-1234-1234-1234-123456789abc', title:'已有聊天', cwd:'/remote/project', status:'idle', connected:false, sequence:3};
const row = {key:'abc-0', turnId:'turn',order:0,version:'123',role:'assistant',text:'已有消息'};
test('session time uses interaction recency rather than title or metadata update time',()=>{
 const recent=1788253847288,updated=1792248885;
 assert.equal(projectCodexSession({...meta,recency:recent,updatedAt:updated}).modified,new Date(recent).toISOString());
 for(const recency of [undefined,0,NaN])assert.equal(projectCodexSession({...meta,recency,updatedAt:updated}).modified,new Date(updated*1000).toISOString());
});
test('keeps real history and remote identity even when executor is idle',()=>{
 const page=projectCodexPage({epoch:'epoch',sequence:3,rows:[row],meta},'codex:'+meta.id);
 assert.equal(page.context.messages[0].content[0].text,'已有消息');
 assert.equal(page.header.cwd,meta.cwd);assert.equal(page.context.messages.length,page.context.entryIds.length);
 assert.equal(page.context.hasMore,false);assert.equal(page.executionEngine,'codex');
});
test('unfinished saved history retains explicit older-page path',()=>{
 const page=projectCodexPage({epoch:'epoch',sequence:3,rows:[row],meta:{...meta,historyComplete:false}},'codex:'+meta.id);
 assert.equal(page.context.hasMore,true);
});
test('image history points to authenticated Pi image proxy; reasoning is native thinking',()=>{
 const user=projectCodexRow({...row,role:'user',attachments:[{type:'localImage',uploadId:meta.id}]},meta)[0];
 assert.match(user.content[1].source.url,/^\/api\/execution-engines\/codex-image\?/);
 const reasoning=projectCodexRow({...row,role:'activity',kind:'reasoning'},meta)[0];
 assert.equal(reasoning.content[0].type,'thinking');
});
test('large tool results are deferred with exact remote cursor; completed tool is not left running',()=>{
 const page=projectCodexPage({epoch:'epoch',sequence:3,rows:[{...row,role:'activity',kind:'commandExecution',truncated:true,status:'completed',turnStatus:'inProgress'}],meta},'codex:'+meta.id);
 const result=page.context.messages.find(m=>m.role==='toolResult');
 assert.equal(result.inProgress,false);assert.deepEqual(result.deferredResult,{entryId:'epoch.abc-0',revision:'123'});
});
test('active last assistant is owned by the native SSE snapshot, not also saved history',()=>{
 const last={...row,turnStatus:'inProgress'};
 const page=projectCodexPage({epoch:'epoch',sequence:3,rows:[{...last,key:'commentary'},last],meta:{...meta,status:'active'}},'codex:'+meta.id);
 assert.equal(page.context.messages.length,1);assert.equal(page.context.entryIds[0],'commentary:0');
 const ended=projectCodexPage({epoch:'epoch',sequence:4,rows:[{...last,turnStatus:'completed'}],meta},'codex:'+meta.id);assert.equal(ended.context.messages.length,1);
});

 test('history exposes exact request to entry identities for duplicate text handover',()=>{
 const a={key:'a',role:'user',text:'same',requestId:'r-a'},b={key:'b',role:'user',text:'same',requestId:'r-b'};
 const projected=projectCodexPage({epoch:'e',sequence:1,rows:[a,b],meta:{id:'x',cwd:'/project',status:'idle'}},'codex:x');
 assert.deepEqual(projected.promptEntryIds,{'r-a':'a:0','r-b':'b:0'});
 });
test('navigation keeps full 100-input total while body contains only its last window',()=>{
 const projected=projectCodexPage({epoch:'e',sequence:1,rows:[{key:'u100',turnId:'t100',order:99,version:'1',role:'user',text:'第100轮'}],hasMore:true,meta:{...meta,userMessageCount:100,historyComplete:false}},'codex:'+meta.id);
 assert.equal(projected.navigationTotalTurns,100);assert.equal(projected.context.messages.length,1);assert.equal(projected.context.hasMore,true);
});
test('linear Codex history scope remains stable when the active tail appends during older paging',()=>{
 const first=projectCodexPage({epoch:'e',sequence:1,rows:[{...row,key:'initial'}],hasMore:true,meta},'codex:'+meta.id);
 const appended=projectCodexPage({epoch:'e',sequence:2,rows:[{...row,key:'initial'},{...row,key:'next-tool',role:'activity',kind:'commandExecution'}],hasMore:true,meta},'codex:'+meta.id);
 assert.equal(first.leafId,appended.leafId,'Appending a tool must not look like changing the Pi branch');
 assert.equal(first.leafId,null,'Codex has no projected Pi branch tree');
});

test('Codex maps authoritative last occupancy separately from cumulative usage without double counting cache',async()=>{
 const {projectCodexUsage}=await import('./codex-projection.ts');
 const source={...meta,contextUsage:{usedTokens:125000,contextWindow:500000},tokenUsage:{inputTokens:900000,cachedInputTokens:800000,outputTokens:100000,reasoningOutputTokens:50000,totalTokens:1000000}};
 const usage=projectCodexUsage(source);assert.deepEqual(usage.contextUsage,{tokens:125000,contextWindow:500000,percent:25});assert.deepEqual(usage.tokens,{input:100000,cacheRead:800000,cacheWrite:0,output:100000,total:1000000});
 const page=projectCodexPage({epoch:'e',sequence:1,rows:[],meta:source},'codex:'+meta.id);assert.deepEqual(page.usage,usage);
});
test('missing or unsafe usage stays unknown, with valid zero and unknown window preserved',async()=>{
 const {projectCodexUsage}=await import('./codex-projection.ts');assert.deepEqual(projectCodexUsage(meta),{contextUsage:null,tokens:null});
 assert.deepEqual(projectCodexUsage({...meta,contextUsage:{usedTokens:0,contextWindow:null}}).contextUsage,{tokens:0,contextWindow:0,percent:null});
 for(const bad of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,true])assert.equal(projectCodexUsage({...meta,contextUsage:{usedTokens:bad,contextWindow:500000}}).contextUsage,null);
 assert.equal(projectCodexUsage({...meta,tokenUsage:{inputTokens:5,cachedInputTokens:6,outputTokens:2,totalTokens:7}}).tokens,null);
});

test('normalizeCodexTimestamp converts ISO, epoch seconds and ms into exact milliseconds, and ignores invalid/missing',async()=>{
 const {normalizeCodexTimestamp}=await import('./codex-projection.ts');
 assert.equal(normalizeCodexTimestamp(1792563900123), 1792563900123);
 assert.equal(normalizeCodexTimestamp(1729500000), 1729500000000);
 assert.equal(normalizeCodexTimestamp("1729500000"), 1729500000000);
 assert.equal(normalizeCodexTimestamp("1792563900123"), 1792563900123);
 assert.equal(normalizeCodexTimestamp("2026-10-21T06:25:00.123Z"), 1792563900123);
 assert.equal(normalizeCodexTimestamp("2026-10-21T06:25:00Z"), 1792563900000);

 for(const bad of [undefined, null, '', '  ', 'invalid-time', -100, 0, NaN, Infinity, true, false, {}]) {
   assert.equal(normalizeCodexTimestamp(bad), undefined);
 }
});

test('projectCodexRow stably passes valid timestamps to User and Assistant messages, and keeps unknown as undefined',async()=>{
 const {projectCodexRow}=await import('./codex-projection.ts');
 const userWithMs = projectCodexRow({...row, role:'user', timestamp: 1792563900123}, meta)[0];
 assert.equal(userWithMs.timestamp, 1792563900123);

 const userWithIso = projectCodexRow({...row, role:'user', timestamp: "2026-10-21T06:25:00.123Z"}, meta)[0];
 assert.equal(userWithIso.timestamp, 1792563900123);

 const asstWithSeconds = projectCodexRow({...row, role:'assistant', timestamp: 1729500000}, meta)[0];
 assert.equal(asstWithSeconds.timestamp, 1729500000000);

 const reasoningWithTime = projectCodexRow({...row, role:'activity', kind:'reasoning', timestamp: 1792563900123}, meta)[0];
 assert.equal(reasoningWithTime.timestamp, 1792563900123);

 const toolMessages = projectCodexRow({...row, role:'activity', kind:'commandExecution', timestamp: 1792563900123}, meta);
 assert.equal(toolMessages[0].timestamp, 1792563900123);
 assert.equal(toolMessages[1].timestamp, 1792563900123);

 // Without timestamp, must stay undefined without fabrication
 const userWithoutTime = projectCodexRow({...row, role:'user', timestamp: undefined}, meta)[0];
 assert.equal(userWithoutTime.timestamp, undefined);
 assert.equal('timestamp' in userWithoutTime, false);

 const asstWithoutTime = projectCodexRow({...row, role:'assistant', timestamp: undefined}, meta)[0];
 assert.equal(asstWithoutTime.timestamp, undefined);
 assert.equal('timestamp' in asstWithoutTime, false);
});

test('projectCodexPage passes distinct timestamps through message list without drift across reads',async()=>{
 const rows = [
   { key:'u-1', turnId:'t1', order:0, version:'v1', role:'user', text:'提问1', timestamp: 1792563901000 },
   { key:'a-1', turnId:'t1', order:1, version:'v2', role:'assistant', text:'回答1', timestamp: 1792563905000 },
   { key:'u-2', turnId:'t2', order:2, version:'v3', role:'user', text:'提问2（无时间）' },
   { key:'a-2', turnId:'t2', order:3, version:'v4', role:'assistant', text:'回答2', timestamp: "2026-10-21T06:25:10.000Z" },
 ];
 const page1 = projectCodexPage({ epoch:'e', sequence:1, rows, meta }, 'codex:' + meta.id);
 const page2 = projectCodexPage({ epoch:'e', sequence:2, rows, meta }, 'codex:' + meta.id);

 assert.equal(page1.context.messages[0].timestamp, 1792563901000);
 assert.equal(page1.context.messages[1].timestamp, 1792563905000);
 assert.equal(page1.context.messages[2].timestamp, undefined);
 assert.equal(page1.context.messages[3].timestamp, 1792563910000);

 // Time does not drift across multiple reads
 for(let i = 0; i < page1.context.messages.length; i++) {
   assert.equal(page1.context.messages[i].timestamp, page2.context.messages[i].timestamp);
 }
});

