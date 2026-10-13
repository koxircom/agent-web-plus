import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{moduleCache:true});
const store=await jiti.import('./prompt-submissions.ts');
const client=await jiti.import('./agent-client.ts');
const entries=new Map();
const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
const cleanup=()=>{for(const row of store.getPendingPromptSubmissions())store.releasePromptSubmission(row.requestId);};
const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
function setup(t){const oldFetch=globalThis.fetch,oldWindow=globalThis.window;globalThis.window={sessionStorage:storage};t.after(()=>{cleanup();globalThis.fetch=oldFetch;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;});}
test('lost acceptance response is recovered by read-only receipt without resending',async t=>{
 setup(t);let posts=0,reads=0;
 globalThis.fetch=async(url,init)=>{if(init?.method==='POST'){posts++;const sent=JSON.parse(init.body);assert.match(sent.requestId,/^[a-f0-9]{32}$/);assert.equal(store.getPendingPromptSubmissions().length,1);throw TypeError('reset after admission');}reads++;return response({status:'committed',entryId:'saved-user'});};
 await client.sendAgentCommand('A',{type:'prompt',message:'已被接收'});assert.equal(posts,1);assert.equal(reads,1);assert.equal(store.getPendingPromptSubmissions().length,0);
});
test('request never reaching server remains visible with images and survives a fresh module load',async t=>{
 setup(t);let posts=0;const images=[{data:'eA==',mimeType:'image/png'}];
 globalThis.fetch=async(url,init)=>{if(init?.method==='POST'){posts++;throw TypeError('offline before dispatch');}return response({status:'unknown'});};
 await assert.rejects(client.sendAgentCommand('A',{type:'prompt',message:'不能丢失的引导',images}),/offline/);
 const rows=store.getPendingPromptSubmissions();assert.equal(rows.length,1);assert.equal(rows[0].status,'uncertain');assert.deepEqual(rows[0].images,images);
 const fresh=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');
 assert.equal(fresh.getPendingPromptSubmissions()[0].message,'不能丢失的引导');assert.deepEqual(fresh.getPendingPromptSubmissions()[0].images,images);assert.equal(posts,1);
});
test('negative receipt after lost response is definitive and releases backup',async t=>{
 setup(t);globalThis.fetch=async(url,init)=>{if(init?.method==='POST')throw TypeError('lost rejection');return response({status:'rejected',error:'model unavailable'});};
 await assert.rejects(client.sendAgentCommand('A',{type:'prompt',message:'退回输入框'}),e=>client.isPromptRejectedError(e)&&e.message==='model unavailable');assert.equal(store.getPendingPromptSubmissions().length,0);
});
test('HTML success response is not mistaken for acceptance',async t=>{
 setup(t);globalThis.fetch=async(url,init)=>init?.method==='POST'?new Response('<html>proxy</html>'):response({status:'unknown'});
 await assert.rejects(client.sendAgentCommand('A',{type:'prompt',message:'保留'}),/未确认/);assert.equal(store.getPendingPromptSubmissions().length,1);
});
test('quota failure rejects before POST rather than silently losing attachments',async t=>{
 setup(t);let posts=0;const original=storage.setItem;storage.setItem=()=>{throw Error('QuotaExceededError');};t.after(()=>storage.setItem=original);
 globalThis.fetch=async()=>{posts++;return response({success:true,receipt:{status:"committed"}});};
 await assert.rejects(client.sendAgentCommand('A',{type:'prompt',message:'大附件'}),e=>client.isPromptRejectedError(e));assert.equal(posts,0);assert.equal(store.getPendingPromptSubmissions().length,0);
});
test('queue preview hides only its requestId, retaining older sending and uncertain records',()=>{
 const rows=[
  {requestId:'older',sessionId:'A',message:'same text',status:'sending',streamingBehavior:'steer',createdAt:1},
  {requestId:'current',sessionId:'A',message:'same text',status:'sending',streamingBehavior:'steer',createdAt:2},
  {requestId:'uncertain',sessionId:'A',message:'same text',status:'uncertain',streamingBehavior:'steer',createdAt:3},
 ];
 const preview={requestId:'current',sessionId:'A',draftKey:'A'};
 assert.deepEqual(store.visiblePromptSubmissions(rows,preview,'A','A').map(r=>r.requestId),['older','uncertain']);
 assert.equal(rows.length,3,'presentation cannot mutate durable records');
 for(const wrong of [null,{...preview,requestId:'missing'},{...preview,sessionId:'B'},{...preview,draftKey:'B'}])
  assert.deepEqual(store.visiblePromptSubmissions(rows,wrong,'A','A'),rows);
 assert.deepEqual(store.visiblePromptSubmissions(rows,preview,'B','A'),rows);
 assert.deepEqual(store.visiblePromptSubmissions(rows,preview,'A','B'),rows);
 assert.deepEqual(store.visiblePromptSubmissions([{...rows[1],status:'uncertain'}],preview,'A','A').map(r=>r.requestId),['current']);
});
test('registered preview identity is the durable identity before dispatch, never inferred from text',async t=>{
 setup(t);let observed,posts=0;
 globalThis.fetch=async(url,init)=>{posts++;assert.equal(observed.requestId,JSON.parse(init.body).requestId);assert.equal(observed.sessionId,'A');assert.equal(store.getPendingPromptSubmissions()[0].requestId,observed.requestId);return response({success:true,receipt:{status:"committed"}});};
 await client.sendAgentCommand('A',{type:'prompt',message:'same text',streamingBehavior:'steer'},{onPromptRegistered:identity=>{observed=identity;}});
 assert.equal(posts,1);assert.equal(store.getPendingPromptSubmissions().length,0);
});
test('preview observer failure cannot interfere with delivery or replay',async t=>{
 setup(t);let posts=0;globalThis.fetch=async()=>{posts++;return response({success:true,receipt:{status:"committed"}});};
 await client.sendAgentCommand('A',{type:'prompt',message:'safe observer'},{onPromptRegistered:()=>{throw Error('presentation failed');}});
 assert.equal(posts,1);assert.equal(store.getPendingPromptSubmissions().length,0);
});
test('non-prompt commands do not create delivery records',async t=>{
 setup(t);globalThis.fetch=async()=>response({success:true,data:{model:'X'}});
 assert.deepEqual(await client.sendAgentCommand('A',{type:'get_state'}),{model:'X'});assert.equal(entries.size,0);
});

test('preflight acceptance retains original across refresh until a committed receipt',async t=>{
 setup(t);let posts=0;
 globalThis.fetch=async(_url,init)=>{assert.equal(init.method,'POST');posts++;return response({success:true,receipt:{status:'accepted'}})};
 await client.sendAgentCommand('A',{type:'prompt',message:'已接收但未写入记录'});
 assert.equal(store.getPendingPromptSubmissions()[0].status,'accepted');
 const fresh=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');
 assert.equal(fresh.getPendingPromptSubmissions()[0].message,'已接收但未写入记录');
 assert.equal(fresh.getPendingPromptSubmissions()[0].status,'accepted');assert.equal(posts,1);
});
test('server inbox restores a new tab without overwriting its local owner or sending',t=>{
 setup(t);
 const row={requestId:'server-pending-1',sessionId:'A',message:'server original',status:'accepted',createdAt:1};
 store.mergeServerPromptSubmissions([row]);store.mergeServerPromptSubmissions([{...row,message:'late response'}]);
 assert.equal(store.getPendingPromptSubmissions().length,1);assert.equal(store.getPendingPromptSubmissions()[0].message,'server original');
});

test('only actual failures require recovery; normal admission and reload retain a silent backup',t=>{
 setup(t);
 const row={requestId:'confirming',sessionId:'A',message:'durable original',status:'sending',createdAt:1};
 store.retainPromptSubmission(row);store.reconcilePromptSubmission(row.requestId,{status:'accepted'});
 assert.equal(store.getPendingPromptSubmissions()[0].status,'accepted');
 assert.equal(store.needsPromptRecovery(store.getPendingPromptSubmissions()[0]),false);
 assert.equal(JSON.parse(entries.get('pi-web:unconfirmed-prompts-v1'))[0].message,row.message);
 for(const status of ['unconfirmed','uncertain','recalled'])assert.equal(store.needsPromptRecovery({...row,status}),true);
 store.reconcilePromptSubmission(row.requestId,{status:'unconfirmed'});assert.equal(store.needsPromptRecovery(store.getPendingPromptSubmissions()[0]),true);
 store.reconcilePromptSubmission(row.requestId,{status:'accepted'});assert.equal(store.getPendingPromptSubmissions()[0].status,'unconfirmed','late admission cannot erase an earlier durability failure');
 store.markPromptSubmissionsRecalled([row.requestId]);store.reconcilePromptSubmission(row.requestId,{status:'accepted'});
 assert.equal(store.getPendingPromptSubmissions()[0].status,'recalled','late admission cannot erase recall recovery');
 store.releasePromptSubmission(row.requestId);store.reconcilePromptSubmission(row.requestId,{status:'accepted'});
 assert.equal(store.getPendingPromptSubmissions().length,0,'a delayed admission cannot resurrect a committed push');
});

test('late inbox snapshots cannot resurrect terminal submissions; identical new text remains valid',t=>{
 setup(t);const row={requestId:'late-snapshot',sessionId:'A',message:'same original',status:'accepted',createdAt:1};
 store.reconcilePromptSubmission(row.requestId,{status:'committed'});
 store.mergeServerPromptSubmissions([row]);assert.deepEqual(store.getPendingPromptSubmissions(),[]);
 store.mergeServerPromptSubmissions([{...row,requestId:'different-request'}]);
 assert.equal(store.getPendingPromptSubmissions().length,1);
});
test('legacy confirming backups migrate to normal admission without a recovery alert',async t=>{
 setup(t);entries.set('pi-web:unconfirmed-prompts-v1',JSON.stringify([{requestId:'legacy-normal',sessionId:'A',message:'preserved legacy original',status:'confirming',createdAt:1}]));
 const fresh=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');
 const [row]=fresh.getPendingPromptSubmissions();assert.equal(row.status,'accepted');assert.equal(row.message,'preserved legacy original');assert.equal(fresh.needsPromptRecovery(row),false);
 entries.delete('pi-web:unconfirmed-prompts-v1');
});
test('pending receipt cannot turn an active POST into a recovery or release its backup',async t=>{
 setup(t);let requestId;globalThis.fetch=async(url,init)=>{requestId=JSON.parse(init.body).requestId;assert.equal(client.isPromptSubmissionDispatching(requestId),true);return response({success:true,receipt:{status:'accepted'}})};
 await client.sendAgentCommand('A',{type:'prompt',message:'live'});assert.equal(client.isPromptSubmissionDispatching(requestId),false);
 assert.equal(store.getPendingPromptSubmissions()[0].status,'accepted');
 store.reconcilePromptSubmission(requestId,{status:'accepted',inFlight:false});assert.equal(store.getPendingPromptSubmissions()[0].status,'uncertain');
 store.reconcilePromptSubmission(requestId,{status:'accepted',inFlight:true});assert.equal(store.getPendingPromptSubmissions()[0].status,'accepted');
 store.reconcilePromptSubmission(requestId,{status:'unconfirmed'});store.reconcilePromptSubmission(requestId,{status:'accepted',inFlight:true});
 assert.equal(store.getPendingPromptSubmissions()[0].status,'unconfirmed');
});
