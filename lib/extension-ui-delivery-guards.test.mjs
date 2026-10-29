import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {validateExtensionUiAck,validateExtensionUiSnapshot}=await jiti.import('./agent-client.ts');
const {refreshPendingExtensionUiRequest,isExtensionUiDeliveryCurrent}=await jiti.import('./extension-ui-queue.ts');
const {buildAskAnswerInputs}=await jiti.import('./ask-user.ts');
test('closed ACK must name the exact request; partial or absent identity is not confirmation',()=>{
 for(const ack of [{status:'closed'},{id:null,status:'closed'},{id:'other',status:'closed'},null,{id:'q',status:'unknown'}])assert.equal(validateExtensionUiAck(ack,'q','custom'),null);
 assert.deepEqual(validateExtensionUiAck({id:'q',status:'closed'},'q','custom'),{status:'closed'});
});
test('pending ACK and read-only snapshots require real UI request schemas',()=>{
 assert.equal(validateExtensionUiAck({id:'q',status:'pending',request:{id:'q',method:'custom',type:'fake'}},'q','custom'),null);
 for(const x of [{},{runtimeAlive:true},null,{runtimeAlive:false,pendingExtensionUiRequests:[{id:'q',method:'custom',type:'extension_ui_request'}]},{runtimeAlive:true,pendingExtensionUiRequests:[{id:'q',method:'unknown',type:'extension_ui_request'}]}])assert.throws(()=>validateExtensionUiSnapshot(x));
 for (const request of [{type:'extension_ui_request',id:'q',method:'custom'},{type:'extension_ui_request',id:'q',method:'custom',lines:5},{type:'extension_ui_request',id:'q',method:'custom',lines:[],askUser:{question:'broken'}}]) {
  assert.throws(()=>validateExtensionUiSnapshot({runtimeAlive:true,pendingExtensionUiRequests:[request]}));
  assert.equal(validateExtensionUiAck({id:'q',status:'pending',request},'q','custom'),null);
 }
 assert.deepEqual(validateExtensionUiSnapshot({runtimeAlive:true,pendingExtensionUiRequests:[]}),[]);
});
test('late pending HTTP snapshot never resurrects an SSE-closed request or displaces the next question',()=>{
 const next={id:'next'},queue=[next];assert.equal(refreshPendingExtensionUiRequest(queue,{id:'answered'}),queue);
 const current=[{id:'q',lines:['old']},next],update={id:'q',lines:['new']};assert.deepEqual(refreshPendingExtensionUiRequest(current,update),[update,next]);
});
test('A to B to A lifecycle invalidates the old pending response',()=>{
 assert.equal(isExtensionUiDeliveryCurrent({sessionId:'a',generation:0},{sessionId:'b',generation:1}),false);
 assert.equal(isExtensionUiDeliveryCurrent({sessionId:'a',generation:0},{sessionId:'a',generation:2}),false);
 assert.equal(isExtensionUiDeliveryCurrent({sessionId:'a',generation:2},{sessionId:'a',generation:2}),true);
});
test('optional ask flags cannot turn cursor navigation into NaN and submit the wrong option',()=>{
 const q={toolCallId:'t',question:'Choose',options:[{title:'A'},{title:'B'}]};
 const data=buildAskAnswerInputs(q,['❯ A','  B'],[1],'',false);
 assert(data.includes('\x1b[B'),'second option needs a real downward movement');assert.equal(data.at(-1),'\r');
});
