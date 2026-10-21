import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {restoreRecalledPrompts}=await jiti.import('./queue-recall-client.ts');
const drafts=await jiti.import('./draft-store.ts');
const outbox=await jiti.import('./prompt-submissions.ts');
const restore=(text,images,key)=>drafts.restoreDraftSubmission(key,text,images);
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),clear:()=>data.clear()}};
const setup=t=>{
 const local=storage(),session=storage(),old={window:globalThis.window,localStorage:globalThis.localStorage,fetch:globalThis.fetch};
 globalThis.localStorage=local;globalThis.window={localStorage:local,sessionStorage:session,addEventListener(){},removeEventListener(){},dispatchEvent(){}};
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({success:true,data:{}})};
 t.after(()=>{for(const row of outbox.getPendingPromptSubmissions())outbox.releasePromptSubmission(row.requestId);for(const k of ['window','localStorage','fetch'])if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k]});
 return {local,calls:()=>calls};
};
const retain=async(sid,rid,text)=>outbox.retainPromptSubmission({requestId:rid,sessionId:sid,message:text,status:'recalled',streamingBehavior:'followUp',createdAt:Date.now()});

test('manual edit and later receipt recovery restore once while a lost ACK stays retryable',async t=>{
 setup(t);const sid=crypto.randomUUID(),rid=crypto.randomUUID();await retain(sid,rid,'original');drafts.setDraft(sid,{value:'draft',images:[]});
 let attempts=0;globalThis.fetch=async()=>{if(++attempts===1)throw Error('lost ACK');return Response.json({success:true,data:{cancelledPromptRequestIds:[rid]}})};
 const p={sessionId:sid,entries:[{requestId:rid,text:'original'}]};
 assert.equal(await restoreRecalledPrompts(p,restore),true);assert.equal(await restoreRecalledPrompts(p,restore),false);
 assert.equal(drafts.getDraft(sid).value,'original\n\ndraft');assert.equal(attempts,2);assert(!outbox.getPendingPromptSubmissions().some(x=>x.requestId===rid));drafts.clearDraft(sid);
});

test('cache disabled and remounted consumers share one in-memory owner without durable ACK',async t=>{
 const f=setup(t);f.local.setItem('pi-enh-plugin-composer-draft-cache','false');
 const sid=crypto.randomUUID(),rid=crypto.randomUUID();await retain(sid,rid,'original');const p={sessionId:sid,entries:[{requestId:rid,text:'original'}]};
 const oldComposer=(...args)=>restore(...args),newComposer=(...args)=>restore(...args);
 await restoreRecalledPrompts(p,oldComposer);await restoreRecalledPrompts(p,newComposer);
 assert.equal(drafts.getDraft(sid).value,'original');assert.equal(f.calls(),0);assert.equal(outbox.getPendingPromptSubmissions().find(x=>x.requestId===rid).recallRestored,undefined);drafts.clearDraft(sid);
});

test('partial batch races preserve same text with different request IDs and both attachments',async t=>{
 setup(t);const sid=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();await retain(sid,a,'same');await retain(sid,b,'same');
 const first={requestId:a,text:'same',images:[{data:'eA==',mimeType:'image/png'}]},second={requestId:b,text:'same',images:[{data:'eQ==',mimeType:'image/png'}]};
 await restoreRecalledPrompts({sessionId:sid,entries:[first]},restore);await restoreRecalledPrompts({sessionId:sid,entries:[first,second]},restore);
 assert.equal(drafts.getDraft(sid).value,'same\n\nsame');assert.equal(drafts.getDraft(sid).images.length,2);
 await restoreRecalledPrompts({sessionId:sid,entries:[first,second]},restore);assert.equal(drafts.getDraft(sid).images.length,2);drafts.clearDraft(sid);
});

test('late recall targets its origin; a failed restoration releases its claim',async t=>{
 setup(t);const a=crypto.randomUUID(),b=crypto.randomUUID(),rid=crypto.randomUUID();await retain(a,rid,'origin');drafts.setDraft(b,{value:'unrelated current draft',images:[]});
 const p={sessionId:a,targetDraftKey:a,entries:[{requestId:rid,text:'origin'}]};
 await assert.rejects(restoreRecalledPrompts(p,()=>{throw Error('draft unavailable')}));await restoreRecalledPrompts(p,restore);
 assert.equal(drafts.getDraft(a).value,'origin');assert.equal(drafts.getDraft(b).value,'unrelated current draft');drafts.clearDraft(a);drafts.clearDraft(b);
});
