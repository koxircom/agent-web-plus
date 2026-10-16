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
function setup(t){const oldFetch=globalThis.fetch,oldWindow=globalThis.window,oldIndexedDB=globalThis.indexedDB;globalThis.window={sessionStorage:storage};delete globalThis.indexedDB;t.after(()=>{cleanup();globalThis.fetch=oldFetch;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;if(oldIndexedDB===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=oldIndexedDB;});}
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
test('the 20-item boundary rejects a new prompt without evicting any retained original',async t=>{
 setup(t);
 const rows=[];for(let index=0;index<20;index++){const row={requestId:`kept-${index}`,sessionId:'A',message:`original-${index}`,status:'uncertain',createdAt:index};await store.retainPromptSubmission(row);rows.push(row);}
 await assert.rejects(store.retainPromptSubmission({requestId:'twenty-first',sessionId:'A',message:'must remain in composer',status:'sending',createdAt:21}));
 assert.deepEqual(store.getPendingPromptSubmissions().map(row=>row.requestId),rows.map(row=>row.requestId));
 assert.equal(store.getPendingPromptSubmissions()[19].message,'original-19');
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

test('only actual failures require recovery; normal admission and reload retain a silent backup',async t=>{
 setup(t);
 const row={requestId:'confirming',sessionId:'A',message:'durable original',status:'sending',createdAt:1};
 await store.retainPromptSubmission(row);store.reconcilePromptSubmission(row.requestId,{status:'accepted'});
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
 await fresh.waitForPromptSubmissionRestore();
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

const nativeIndexedDB=globalThis.indexedDB;
function readTabRows(id){return new Promise((resolve,reject)=>{const req=nativeIndexedDB.open('pi-web-prompt-submissions-v1',1);req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const tx=db.transaction('submissions','readonly'),read=tx.objectStore('submissions').index('tabId').getAll(id);read.onsuccess=()=>resolve(read.result);read.onerror=()=>reject(read.error);tx.oncomplete=()=>db.close();};});}
async function waitForIdbRows(id,requestId,expected){for(let i=0;i<50;i++){const rows=await readTabRows(id);if(rows.some(r=>r.requestId===requestId)===expected)return rows;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('IndexedDB receipt transition did not settle');}
function failNextIndexedDbPut(source){let fail=true;return {open(name,version){const request=source.open(name,version);return new Proxy(request,{get(target,key){if(key==='result'&&target.result){const db=target.result;return new Proxy(db,{get(dbTarget,dbKey){if(dbKey==='transaction')return(storeName,mode)=>{const tx=dbTarget.transaction(storeName,mode);if(mode!=='readwrite')return tx;return new Proxy(tx,{get(txTarget,txKey){if(txKey==='objectStore')return name=>{const objectStore=txTarget.objectStore(name);return new Proxy(objectStore,{get(storeTarget,storeKey){if(storeKey==='put'&&fail)return()=>{fail=false;txTarget.abort();return undefined;};const value=Reflect.get(storeTarget,storeKey,storeTarget);return typeof value==='function'?value.bind(storeTarget):value;}});};const value=Reflect.get(txTarget,txKey,txTarget);return typeof value==='function'?value.bind(txTarget):value;},set(txTarget,txKey,value){return Reflect.set(txTarget,txKey,value,txTarget);}});};const value=Reflect.get(dbTarget,dbKey,dbTarget);return typeof value==='function'?value.bind(dbTarget):value;}});}return Reflect.get(target,key,target);},set(target,key,value){return Reflect.set(target,key,value,target);}});}};}
test('large image is durably in IndexedDB before one POST and survives refresh until receipt',async t=>{
 if(!nativeIndexedDB){t.skip('Node runtime does not expose IndexedDB');return;}
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window,oldIndexedDB=globalThis.indexedDB,entries=new Map();
 const sessionStorage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>{if(key==='pi-web:unconfirmed-prompts-v1'&&value.length>100_000)throw Error('quota');entries.set(key,value);},removeItem:key=>entries.delete(key)};
 globalThis.window={sessionStorage};globalThis.indexedDB=nativeIndexedDB;
 const isolated=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');
 const isolatedClient=await createJiti(import.meta.url,{moduleCache:false}).import('./agent-client.ts');
 await isolated.waitForPromptSubmissionRestore();
 const imageData='x'.repeat(6*1024*1024),images=[{data:imageData,mimeType:'image/png'}];let posts=0;
 globalThis.fetch=async(_url,init)=>{assert.equal(init.method,'POST');posts++;const body=JSON.parse(init.body);const tabId=entries.get('pi-web:prompt-submissions-tab-v1');const rows=await readTabRows(tabId);const saved=rows.find(row=>row.requestId===body.requestId);assert.ok(saved,'IndexedDB transaction must complete before POST');assert.equal(saved.images[0].data.length,imageData.length);return response({success:true,receipt:{status:'accepted'}});};
 t.after(()=>{globalThis.fetch=oldFetch;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;if(oldIndexedDB===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=oldIndexedDB;});
 await isolatedClient.sendAgentCommand('large-image-session',{type:'prompt',message:'keep this image',images});
 assert.equal(posts,1);assert.equal(entries.has('pi-web:unconfirmed-prompts-v1'),false,'large payload used IndexedDB, not Web Storage');
 const fresh=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');await fresh.waitForPromptSubmissionRestore();
 const [restored]=fresh.getPendingPromptSubmissions();assert.equal(restored.message,'keep this image');assert.equal(restored.images[0].data.length,imageData.length);
 fresh.reconcilePromptSubmission(restored.requestId,{status:'committed'});
 const rows=await waitForIdbRows(entries.get('pi-web:prompt-submissions-tab-v1'),restored.requestId,false);assert.equal(rows.length,0,'committed receipt deletes the exact row');
});
test('concurrent IDB retains merge into the latest snapshot without dropping either original',async t=>{
 if(!nativeIndexedDB){t.skip('Node runtime does not expose IndexedDB');return;}
 const oldWindow=globalThis.window,oldIndexedDB=globalThis.indexedDB,entries=new Map();
 globalThis.window={sessionStorage:{getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)}};globalThis.indexedDB=nativeIndexedDB;
 const fresh=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');await fresh.waitForPromptSubmissionRestore();
 const rows=[0,1].map(index=>({requestId:`parallel-${index}`,sessionId:'A',message:`parallel original ${index}`,status:'sending',createdAt:index}));
 t.after(()=>{globalThis.window=oldWindow;if(oldIndexedDB===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=oldIndexedDB;});
 await Promise.all(rows.map(row=>fresh.retainPromptSubmission(row)));
 assert.deepEqual(fresh.getPendingPromptSubmissions().map(row=>row.requestId).sort(),rows.map(row=>row.requestId).sort());
 const disk=await readTabRows(entries.get('pi-web:prompt-submissions-tab-v1'));assert.equal(disk.length,2);
 for(const row of rows)fresh.releasePromptSubmission(row.requestId);
 await Promise.all(rows.map(row=>waitForIdbRows(entries.get('pi-web:prompt-submissions-tab-v1'),row.requestId,false)));
});
test('failed IndexedDB transaction and failed fallback block POST while prior original remains recoverable',async t=>{
 if(!nativeIndexedDB){t.skip('Node runtime does not expose IndexedDB');return;}
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window,oldIndexedDB=globalThis.indexedDB,scope='transaction-failure-scope',entries=new Map([['pi-web:prompt-submissions-tab-v1',scope]]);
 const sessionStorage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>{if(key==='pi-web:unconfirmed-prompts-v1')throw Error('quota');entries.set(key,value);},removeItem:key=>entries.delete(key)};
 await new Promise((resolve,reject)=>{const request=nativeIndexedDB.open('pi-web-prompt-submissions-v1',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('submissions','readwrite');tx.objectStore('submissions').put({key:`${scope}:previous`,tabId:scope,requestId:'previous',sessionId:'A',message:'previous durable original',status:'uncertain',createdAt:1});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=tx.onabort=()=>reject(tx.error);};});
 globalThis.window={sessionStorage};globalThis.indexedDB=failNextIndexedDbPut(nativeIndexedDB);let posts=0;globalThis.fetch=async()=>{posts++;return response({success:true,receipt:{status:'committed'}});};
 const client=await createJiti(import.meta.url,{moduleCache:false}).import('./agent-client.ts');
 const command={type:'prompt',message:'failed message remains with caller'};
 t.after(()=>{globalThis.fetch=oldFetch;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;if(oldIndexedDB===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=oldIndexedDB;});
 await assert.rejects(client.sendAgentCommand('A',command),error=>error.code==='prompt_rejected'&&error.accepted===false);
 assert.equal(posts,0);assert.equal(command.message,'failed message remains with caller');
 globalThis.indexedDB=nativeIndexedDB;
 const recovered=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');await recovered.waitForPromptSubmissionRestore();
 assert.deepEqual(recovered.getPendingPromptSubmissions().map(row=>row.message),['previous durable original']);
});


test('restored server inbox does not consume local admission slots or erase old originals',async t=>{
 setup(t);
 const old=Array.from({length:21},(_,i)=>({requestId:`server-history-${i}`,sessionId:'A',message:`preserve old ${i}`,status:i<19?'unconfirmed':'recalled',createdAt:i}));
 store.mergeServerPromptSubmissions(old);
 const row={requestId:'new-after-server-history',sessionId:'A',message:'new current turn',status:'sending',createdAt:100};
 await store.retainPromptSubmission(row);
 assert.equal(store.getPendingPromptSubmissions().length,22);
 assert.deepEqual(store.getPendingPromptSubmissions().slice(0,21),old);
});
test('a durable server receipt frees only admission capacity, retaining original until committed',async t=>{
 setup(t);
 for(let i=0;i<20;i++)await store.retainPromptSubmission({requestId:`local-slot-${i}`,sessionId:'A',message:`original ${i}`,status:'sending',createdAt:i});
 await assert.rejects(store.retainPromptSubmission({requestId:'before-ack',sessionId:'A',message:'blocked',status:'sending',createdAt:30}));
 store.reconcilePromptSubmission('local-slot-0',{status:'accepted'});
 await store.retainPromptSubmission({requestId:'after-ack',sessionId:'A',message:'admitted',status:'sending',createdAt:31});
 assert.equal(store.getPendingPromptSubmissions().length,21);
 assert.equal(store.getPendingPromptSubmissions()[0].message,'original 0');
 assert.equal(store.getPendingPromptSubmissions()[0].status,'accepted');
});
test('restored inbox ownership is recovered after refresh before admitting a new local prompt',async t=>{
 setup(t);
 const rows=Array.from({length:21},(_,i)=>({requestId:`refresh-server-${i}`,sessionId:'A',message:`kept ${i}`,status:'unconfirmed',createdAt:i}));
 store.mergeServerPromptSubmissions(rows);
 const fresh=await createJiti(import.meta.url,{moduleCache:false}).import('./prompt-submissions.ts');
 await fresh.waitForPromptSubmissionRestore();fresh.mergeServerPromptSubmissions(rows);
 await fresh.retainPromptSubmission({requestId:'after-refresh',sessionId:'A',message:'new',status:'sending',createdAt:100});
 assert.equal(fresh.getPendingPromptSubmissions().length,22);
 for(const row of fresh.getPendingPromptSubmissions())fresh.releasePromptSubmission(row.requestId);
});
