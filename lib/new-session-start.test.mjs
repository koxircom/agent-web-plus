import { resolveExecutionEngine } from "./execution-engine-context.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createJiti} from 'jiti';
const {createPromptDeliveryStore,validPromptRequestId}=await createJiti(import.meta.url).import('./prompt-delivery.ts');
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../app/api/agent/new/route.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export async function POST','async function POST').replace('await (await import("@/lib/execution-engines/codex-engine")).createCodexSession', 'await createCodexFixture');
function harness(t,defaultEngine="pi"){
 const root=mkdtempSync(join(tmpdir(),'new-prompt-route-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=createPromptDeliveryStore(root);
 const calls=[];const created=[];let release;
 const ready=new Promise(r=>release=r);
 const session={inner:{model:{id:'fixture',provider:'fixture'},agent:{state:{thinkingLevel:'high'}}},send:async c=>{calls.push(c.type);if(c.type==='prompt')assert.equal(store.receipt('real',c.requestId).status,'pending');await ready;return {model:session.inner.model,thinkingLevel:'high'};}};
 const POST=vm.runInNewContext(stripTypeScriptTypes(source)+'\nPOST',{resolveExecutionEngine,RangeError,readExecutionEngineSettings:async()=>({defaultEngine}),Response:{json:body=>({body,status:200})},createCodexFixture:async(cwd,command)=>{created.push({engine:"codex",cwd,command});return {sessionId:"codex:fixture"};},NextResponse:{json:(body,options)=>({body,status:options?.status??200})},existsSync:()=>true,randomUUID,validPromptRequestId,runPromptDelivery:store.run,getPromptReceipt:store.receipt,allowFileRoot:()=>{},invalidateSessionListCache:()=>{},startRpcSession:async(...args)=>{created.push({engine:'pi',args});return {session,realSessionId:'real'};},Error,Set,String});
 return {POST,calls,release,created};
}
test('ensure_session returns identity and initial model without waiting for extension-bound get_state',async(t)=>{
 const h=harness(t);const result=await h.POST({json:async()=>({cwd:'/fixture',type:'ensure_session'})});
 assert.equal(result.body.sessionId,'real');assert.deepEqual(JSON.parse(JSON.stringify(result.body.model)),{provider:'fixture',modelId:'fixture'});assert.equal(result.body.thinkingLevel,'high');assert.deepEqual(h.calls,[]);
});
test('a direct first prompt still waits for readiness and dispatches once',async(t)=>{
 const h=harness(t);let settled=false;const request=h.POST({json:async()=>({cwd:'/fixture',type:'prompt',message:'hello'})}).then(r=>{settled=true;return r;});
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(h.calls,['get_state']);h.release();const result=await request;assert.equal(result.body.success,true);assert.ok(validPromptRequestId(result.body.requestId));assert.equal(result.body.receipt.status,'accepted');assert.deepEqual(h.calls,['get_state','prompt']);
});
test('invalid initial model is rejected before runtime creation',async(t)=>{
 const h=harness(t);const result=await h.POST({json:async()=>({cwd:'/fixture',type:'ensure_session',provider:'fixture'})});assert.equal(result.status,500);assert.deepEqual(h.calls,[]);
});

test('an invalid prompt identity is rejected before creating or dispatching a session',async(t)=>{
 const h=harness(t);const result=await h.POST({json:async()=>({cwd:'/fixture',type:'prompt',message:'hello',requestId:'bad'})});assert.equal(result.body.code,'prompt_rejected');assert.equal(result.body.accepted,false);assert.deepEqual(h.calls,[]);
});

test('an explicit Pi new request stays Pi when the shared default is Codex',async(t)=>{
 const h=harness(t,'codex');const result=await h.POST({json:async()=>({cwd:'/fixture',engine:'pi',type:'ensure_session'})});
 assert.equal(result.body.sessionId,'real');assert.equal(h.created[0].engine,'pi');
});
test('an explicit Codex new request stays Codex when the shared default is Pi',async(t)=>{
 const h=harness(t,'pi');const result=await h.POST({json:async()=>({cwd:'/fixture',engine:'codex',type:'ensure_session'})});
 assert.equal(result.body.sessionId,'codex:fixture');assert.equal(h.created[0].engine,'codex');assert.equal(h.created[0].command.engine,undefined);
});

test('invalid engine rejects before creating either runtime',async(t)=>{
 const h=harness(t,'codex');const result=await h.POST({json:async()=>({cwd:'/fixture',engine:'other',type:'ensure_session'})});assert.equal(result.status,400);assert.equal(h.created.length,0);
});
