import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const module=readFileSync(new URL('../enhancements/modules/05-composer-and-input-workflow.js',import.meta.url),'utf8');
const hook=readFileSync(new URL('../hooks/useAgentSession.ts',import.meta.url),'utf8');
test('recall service has one native receipt/restore boundary and no direct draft fallback',()=>{
 const client=readFileSync(new URL('./composer-queue-client.ts',import.meta.url),'utf8');
 for(const name of ['recallSingleQueuedMessage','recallAllQueuedMessages']){
  const start=client.indexOf('export async function '+name+'(');
  assert.ok(start >= 0, `native client owns ${name}`);
  const end=client.indexOf('\nexport ',start+1),source=client.slice(start,end < 0 ? undefined : end);
  assert.match(source,/sendAgentCommand/);assert.match(source,/onRestoreRecall/);assert.doesNotMatch(source,/window\.fetch|handle\.restoreSubmission|savePersistedDraft/);
  assert.doesNotMatch(module,new RegExp('function '+name+'\\('));
 }
 assert.doesNotMatch(module,/function deliverRecalledQueuePayload|function saveRecalledToOwnerPersistedDraft|pi:native-queue-snapshot/);
 const bridge=readFileSync(new URL('../hooks/useComposerQueueBridge.ts',import.meta.url),'utf8');
 assert.match(bridge,/state\.signature !== signature/);assert.match(bridge,/currentSessionIdRef/);
});
test('automatic receipt recovery stays enabled and uses the same native restoration owner',()=>{
 assert.match(hook,/confirmPendingSubmission\(row, true\)/);assert.doesNotMatch(hook,/confirmPendingSubmission\(row, false\)/);
 assert.match(hook,/restoreRecalledPrompts\(payload, restoreSubmission\)/);assert.doesNotMatch(hook,/restoredRecallsRef/);
 assert.match(hook,/restoreRecall: handleRestoreRecall/);
});
