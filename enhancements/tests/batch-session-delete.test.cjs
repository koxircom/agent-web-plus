const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../modules/05-composer-and-input-workflow.js','utf8');
const start=source.indexOf('  async function executeBatchDeleteSessions('),end=source.indexOf('\n  // 鼠标点击捕获监听',start);
const jobId='00000000-0000-4000-8000-000000000001',storageKey='pi-enh:session-batch-delete-job';

function frameSet(ids,states={},deletedById={}){
  const frames=[{type:'start',total:ids.length}],results=[],deleted=[];
  for(let index=0;index<ids.length;index++){
    const id=ids[index],state=states[id]||'deleted';
    if(state==='not_started'){
      results.push({id,ok:false,state});
      continue;
    }
    frames.push({type:'item-start',id,index:index+1,total:ids.length});
    const ok=state==='deleted'||state==='missing';
    const related=ok?(deletedById[id]||[id]):[];
    frames.push({type:'result',processed:frames.filter(f=>f.type==='result').length+1,total:ids.length,result:{id,ok,state},deletedSessionIds:related});
    results.push({id,ok,state});
    if(ok)for(const relatedId of related)if(!deleted.includes(relatedId))deleted.push(relatedId);
  }
  const stopped=ids.some(id=>states[id]==='unknown'||states[id]==='not_started');
  const processed=frames.filter(f=>f.type==='result').length;
  frames.push({type:'done',processed,total:ids.length,results,deletedSessionIds:deleted,stopped});
  return frames;
}

function fixture(frames,{ids=['a','b'],status=null,postMode=null,metaNotFound=false,failEvents=false,maxPage=256}={}){
  const cleaned=[],restored=[],confirmed=[],notified=[],requests=[],refreshes=[],toasts=[];
  const selectedSessionBatchIds=new Set(ids),rerenders=[];
  const storage=new Map();
  const serverStatus=status||(frames?.some(frame=>frame.type==='done')?(frames.at(-1)?.stopped?'stopped':'completed'):'running');
  const sequence=(frames||[]).map((frame,index)=>({seq:index+1,frame}));
  const c={
    console,Map,Set,Array,AbortController,ReadableStream,TextDecoder,TextEncoder,JSON,Math,String,Boolean,
    setTimeout,clearTimeout,batchDeleteInFlight:false,batchDeleteJob:null,batchDeleteJobEntry:null,
    batchDeleteObserverController:null,batchDeleteObserverGeneration:0,batchDeleteJobStorageKey:storageKey,isSessionBatchMode:false,
    batchDeleteModal:null,selectedSessionBatchIds,syncSessionBatchBar(){},syncSessionBatchRowStates(){},
    createBatchDeleteJobId:()=>jobId,
    saveBatchDeleteJobPointer(job){storage.set(storageKey,JSON.stringify({id:job.id,ids:job.ids}));},
    clearBatchDeleteJobPointer(){storage.delete(storageKey);},
    syncBatchDeleteJobEntry(){},removeBatchDeleteJobEntry(){},isBatchDeleteJobTerminal:job=>Boolean(job?.done),
    window:{localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
      __PI_ENH_RERENDER_SESSIONS__:()=>rerenders.push(1),history:{replaceState(){}},__PI_ENH_SESSION_DELETED__:id=>notified.push(id)},
    getCurrentSessionId:()=> 'b',markSessionAsDeleted(){throw Error('不应在服务端确认前乐观隐藏会话');},
    getSessionRowById:()=>null,markSessionDeleteConfirmed:id=>confirmed.push(id),
    cleanupDeletedSessionEverywhere:id=>cleaned.push(id),cleanupSessionUploadedFiles:async()=>{},
    restoreSessionDeleteState:id=>restored.push(id),requestSessionListRefresh:()=>refreshes.push(1),
    closeBatchDeleteModal(){},setSessionBatchMode(){},showToast:message=>toasts.push(message),sessionDeleteIcon:'',
    fetch:async(url,options={})=>{
      requests.push({url,options});
      if(options.method==='POST'){
        const posted=JSON.parse(options.body);
        assert.equal(storage.get(storageKey),JSON.stringify({id:posted.id,ids:posted.ids}),'必须在 POST 前持久化 jobId 和 ids');
        if(postMode==='lost-ack')throw Error('response lost');
        if(postMode==='reject')return jsonResponse({accepted:false,error:'request rejected'},409);
        return jsonResponse({id:jobId,ids,total:ids.length,status:'running',processed:0,lastSequence:0},202);
      }
      if(url.endsWith(`/jobs/${jobId}`)){
        if(metaNotFound)return jsonResponse({error:'not found'},404);
        return jsonResponse({id:jobId,ids,total:ids.length,status:serverStatus,processed:sequence.filter(item=>item.frame.type==='result').length,lastSequence:sequence.length});
      }
      if(url.includes(`/jobs/${jobId}/events`)){
        if(failEvents)throw Error('offline');
        const after=Number(new URL(url,'http://local').searchParams.get('after')||0);
        const page=sequence.filter(item=>item.seq>after).slice(0,maxPage);
        return jsonResponse({id:jobId,frames:page,lastSequence:sequence.length,status:serverStatus});
      }
      throw Error(`unexpected request ${url}`);
    },
  };
  vm.runInNewContext(source.slice(start,end)+'\nthis.run=executeBatchDeleteSessions;',c);
  return{c,cleaned,restored,confirmed,notified,requests,refreshes,rerenders,toasts,storage};
}

function jsonResponse(value,status=200){return{ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},json:async()=>value};}
function successful(ids,deletedById={}){return frameSet(ids,{},deletedById);}
async function waitUntil(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('condition not reached');}

test('job transport POSTs once, confirms only returned IDs, and preserves cascade cleanup',async()=>{
  const frames=successful(['a','b'],{a:['a','child'],b:['b']});
  const f=fixture(frames);
  await f.c.run(['a','b'],{});
  assert.equal(f.requests.filter(item=>item.options.method==='POST').length,1);
  assert.equal(f.requests[0].url,'/api/sessions/batch-delete/jobs');
  assert.deepEqual(f.cleaned,['a','child','b']);
  assert.deepEqual(f.confirmed,['a','child','b']);
  assert.deepEqual(f.notified,['a','child','b']);
  assert.deepEqual(f.restored,[]);
  assert.equal(f.refreshes.length,1);
  assert.equal(f.c.batchDeleteJob.done,true);
  assert.equal(f.storage.has(storageKey),true,'完成结果保留到用户明确关闭');
});

test('lost POST acknowledgement attaches by the persisted ID and never reposts',async()=>{
  const f=fixture(successful(['a']),{ids:['a'],postMode:'lost-ack'});
  await f.c.run(['a'],{});
  assert.equal(f.requests.filter(item=>item.options.method==='POST').length,1);
  assert.ok(f.requests.some(item=>item.url.endsWith(`/jobs/${jobId}`)&&item.options.method==='GET'));
  assert.ok(f.requests.some(item=>item.url.includes(`/jobs/${jobId}/events`)));
  assert.deepEqual(f.cleaned,['a']);
});

test('reattaching to a completed job reads the same event log without duplicate cleanup',async()=>{
  const f=fixture(successful(['a']),{ids:['a']});
  await f.c.run(['a'],{});
  const initialRequests=f.requests.length;
  await f.c.run(['a'],{},{resume:true,jobId});
  assert.equal(f.requests.slice(initialRequests).some(item=>item.options.method==='POST'),false);
  assert.deepEqual(f.cleaned,['a']);
  assert.deepEqual(f.notified,['a']);
  assert.equal(f.refreshes.length,2);
});

test('network observation failure leaves unresolved IDs pending and does not classify them',async()=>{
  const f=fixture([], {ids:['a','b'],status:'running',failEvents:true});
  const p=f.c.run(['a','b'],{});
  await waitUntil(()=>f.requests.some(item=>item.url.includes('/events')));
  f.c.batchDeleteObserverController.abort(Error('test disconnect'));
  await p;
  assert.equal(f.requests.filter(item=>item.options.method==='POST').length,1);
  assert.deepEqual(f.cleaned,[]);
  assert.deepEqual(f.restored,[]);
  assert.deepEqual([...f.c.selectedSessionBatchIds],[]);
  assert.equal(f.c.batchDeleteJob.done,false);
  assert.equal(f.c.batchDeleteJob.connectionState,'reconnecting');
  assert.ok(f.storage.has(storageKey));
});

test('stopped job keeps unknown separate from explicitly retryable not_started results',async()=>{
  const frames=[
    {type:'start',total:2},
    {type:'item-start',id:'a',index:1,total:2},
    {type:'result',processed:1,total:2,result:{id:'a',ok:false,state:'unknown'},deletedSessionIds:[]},
    {type:'done',processed:1,total:2,results:[{id:'a',ok:false,state:'unknown'},{id:'b',ok:false,state:'not_started'}],deletedSessionIds:[],stopped:true},
  ];
  const f=fixture(frames,{status:'stopped'});
  await f.c.run(['a','b'],{});
  assert.deepEqual(f.cleaned,[]);
  assert.deepEqual(f.restored,['a','b']);
  assert.deepEqual(Array.from(f.c.batchDeleteJob.unknownIds),['a']);
  assert.deepEqual(Array.from(f.c.batchDeleteJob.notStartedIds),['b']);
  assert.deepEqual([...f.c.selectedSessionBatchIds],[],'unknown 和 not_started 都不会自动重选');
  assert.equal(f.c.batchDeleteJob.done,true);
});

test('failed results remain available for explicit retry selection, with confirmed IDs retained',async()=>{
  const f=fixture(frameSet(['a','b'],{a:'deleted',b:'failed'},{a:['a']}));
  await f.c.run(['a','b'],{});
  assert.deepEqual(f.cleaned,['a']);
  assert.deepEqual(f.restored,['b']);
  assert.deepEqual(Array.from(f.c.batchDeleteJob.failedIds),['b']);
  assert.deepEqual(Array.from(f.c.batchDeleteJob.notStartedIds),[]);
  assert.deepEqual([...f.c.selectedSessionBatchIds],[]);
});

test('double confirm runs only one job creation request',async()=>{
  const f=fixture(successful(['a']),{ids:['a']});
  await Promise.all([f.c.run(['a'],{}),f.c.run(['a'],{})]);
  assert.equal(f.requests.filter(item=>item.options.method==='POST').length,1);
});

test('definitive accepted:false rejection clears the pointer without automatic resubmission',async()=>{
  const f=fixture([],{ids:['a'],postMode:'reject'});
  await f.c.run(['a'],{});
  assert.equal(f.requests.filter(item=>item.options.method==='POST').length,1);
  assert.equal(f.requests.some(item=>item.options.method==='GET'),false);
  assert.equal(f.storage.has(storageKey),false);
  assert.equal(f.c.batchDeleteJob,null);
  assert.deepEqual(f.cleaned,[]);
});

test('event pagination follows contiguous sequence numbers across 256-frame pages',async()=>{
  const ids=Array.from({length:130},(_,i)=>`id${i}`);
  const frames=successful(ids);
  const f=fixture(frames,{ids,maxPage:2});
  await f.c.run(ids,{});
  const pages=f.requests.filter(item=>item.url.includes('/events')).map(item=>Number(new URL(item.url,'http://local').searchParams.get('after')));
  assert.equal(pages.length,Math.ceil(frames.length/2));
  assert.deepEqual(pages,pages.map((_,index)=>index*2));
  assert.equal(f.c.batchDeleteJob.done,true);
  assert.equal(f.cleaned.length,130);
});

test('missing terminal done and malformed frames detach observation without inventing unknown results',async()=>{
  const frames=[
    {type:'start',total:2},
    {type:'item-start',id:'a',index:1,total:2},
    {type:'result',processed:1,total:2,result:{id:'a',ok:true,state:'deleted'},deletedSessionIds:['a']},
    {type:'item-start',id:'b',index:2,total:2},
  ];
  const f=fixture(frames,{status:'completed'});
  await f.c.run(['a','b'],{});
  assert.deepEqual(f.cleaned,['a']);
  assert.deepEqual(f.restored,[]);
  assert.deepEqual(Array.from(f.c.batchDeleteJob.unknownIds),[]);
  assert.equal(f.c.batchDeleteJob.done,false);
  assert.equal(f.storage.has(storageKey),true);
});

test('wrong total, contradictory state, unknown frame, and oversized frame fail closed',async t=>{
  const cases=[
    {name:'wrong total',frames:[{type:'start',total:99}]},
    {name:'contradictory state',frames:[{type:'start',total:1},{type:'item-start',id:'a',index:1,total:1},{type:'result',processed:1,total:1,result:{id:'a',ok:false,state:'deleted'},deletedSessionIds:[]}]},
    {name:'unknown type',frames:[{type:'start',total:1},{type:'bogus',payload:1}]},
    {name:'oversized frame',frames:[{type:'start',total:1,padding:'x'.repeat(70000)}]},
  ];
  for(const item of cases){
    await t.test(item.name,async()=>{
      const f=fixture(item.frames,{ids:['a'],status:'completed'});
      await f.c.run(['a'],{});
      assert.deepEqual(f.cleaned,[]);
      assert.deepEqual(Array.from(f.c.batchDeleteJob.unknownIds),[]);
      assert.equal(f.c.batchDeleteJob.done,false);
      assert.ok(f.storage.has(storageKey));
    });
  }
});

test('duplicate done and mismatched result IDs are rejected without retrying POST',async()=>{
  const valid=frameSet(['a'],{}, {a:['a']});
  const duplicate=valid.concat([valid.at(-1)]);
  const f=fixture(duplicate,{ids:['a'],status:'completed'});
  await f.c.run(['a'],{});
  assert.equal(f.requests.filter(item=>item.options.method==='POST').length,1);
  assert.deepEqual(f.cleaned,['a']);
  assert.equal(f.c.batchDeleteJob.done,false);
  assert.ok(f.storage.has(storageKey));

  const mismatched=successful(['a']);
  mismatched[2]={...mismatched[2],result:{...mismatched[2].result,id:'other'}};
  const second=fixture(mismatched,{ids:['a']});
  await second.c.run(['a'],{});
  assert.deepEqual(second.cleaned,[]);
  assert.equal(second.c.batchDeleteJob.done,false);
});

test('a restored pointer performs GET-only observation and retains 404 without resubmitting',async()=>{
  const f=fixture([],{ids:['a'],status:'running',metaNotFound:true});
  f.storage.set(storageKey,JSON.stringify({id:jobId,ids:['a']}));
  f.c.batchDeleteJob={id:jobId,ids:['a'],status:'running',processed:0,lastSequence:0,connectionState:'connecting',appliedDeletedIds:new Set(),failedIds:[],unknownIds:[],notStartedIds:[],done:false};
  await f.c.run(['a'],null,{resume:true,jobId});
  assert.equal(f.requests.some(item=>item.options.method==='POST'),false);
  assert.equal(f.c.batchDeleteJob.connectionState,'not_found');
  assert.ok(f.storage.has(storageKey));
});
