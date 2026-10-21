import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const module=readFileSync(new URL('../enhancements/modules/05-composer-and-input-workflow.js',import.meta.url),'utf8');
const hook=readFileSync(new URL('../hooks/useAgentSession.ts',import.meta.url),'utf8');
test('recall service has one native receipt/restore boundary and no direct draft fallback',()=>{
 for(const name of ['recallSingleQueuedMessage','recallAllQueuedMessages']){
  const start=module.indexOf('  async function '+name+'('),end=module.indexOf('\n  async function ',start+1),source=module.slice(start,end);
  assert.match(source,/nativeHost\.sendCommand/);assert.match(source,/nativeHost\.restoreRecall/);assert.doesNotMatch(source,/window\.fetch|handle\.restoreSubmission|savePersistedDraft/);
 }
 assert.doesNotMatch(module,/function deliverRecalledQueuePayload|function saveRecalledToOwnerPersistedDraft/);
 assert.match(module,/const signature = detail\.signature/);assert.doesNotMatch(module,/JSON\.stringify\(\[activeSid, detail\.entries\]\)/);
});
test('automatic receipt recovery stays enabled and uses the same native restoration owner',()=>{
 assert.match(hook,/confirmPendingSubmission\(row, true\)/);assert.doesNotMatch(hook,/confirmPendingSubmission\(row, false\)/);
 assert.match(hook,/restoreRecalledPrompts\(payload, restoreSubmission\)/);assert.doesNotMatch(hook,/restoredRecallsRef/);
 assert.match(hook,/restoreRecall: handleRestoreRecall/);
});
