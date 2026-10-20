import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveLoadedHistoryPrefix, viewMatchesBaseline, reconcileSyncResponse } from './session-sync-client.ts';
import { getVisibleRenderWindow } from './chat-lazy-load.ts';

function fixture() {
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: `history-${i}` }], timestamp: i }));
  const ids = messages.map((_, i) => `e${i}`);
  const base = { sessionId: 'owned', revision: 'r1', messages: messages.slice(2, 5), entryIds: ids.slice(2, 5), savedAt: 1 };
  const current = { messages: messages.slice(0, 5), entryIds: ids.slice(0, 5), oldestEntryId: 'e0', hasMore: false };
  const next = { sessionId: 'owned', snapshotRevision: 'r2', context: { messages: messages.slice(3), entryIds: ids.slice(3), oldestEntryId: 'e3', hasMore: true } };
  return { messages, ids, base, current, next };
}

test('a moving confirmed tail keeps loaded ancestors and paging cursor', () => {
  const { messages, ids, base, current, next } = fixture();
  const result = preserveLoadedHistoryPrefix(next, base, current);
  assert.deepEqual(result.context.messages, messages);
  assert.deepEqual(result.context.entryIds, ids);
  assert.equal(result.context.oldestEntryId, 'e0');
  assert.equal(result.context.hasMore, false);
  assert.equal(result.context.messages[0], current.messages[0]);
  assert.equal(next.context.messages.length, 3, 'server snapshot remains exact');
  assert.equal(base.messages.length, 3, 'old baseline remains exact');
  assert(viewMatchesBaseline({ ...base, messages: next.context.messages, entryIds: next.context.entryIds }, result.context.messages, result.context.entryIds));
});

test('uncommitted SSE tail never contaminates the widened confirmed view', () => {
  const { base, current, next } = fixture();
  current.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'uncommitted' }] });
  const result = preserveLoadedHistoryPrefix(next, base, current);
  assert.equal(result.context.messages.length, 6);
  assert(!JSON.stringify(result).includes('uncommitted'));
});

for (const reason of ['gap', 'branch', 'edited-overlap', 'wrong-session', 'uncertified-history']) {
  test(`rejects unsafe history retention: ${reason}`, () => {
    const { base, current, next } = fixture();
    if (reason === 'gap') next.context.entryIds = ['x3', 'x4', 'x5'];
    if (reason === 'branch') next.context.entryIds = ['e3', 'alternate', 'e5'];
    if (reason === 'edited-overlap') next.context.messages[0] = { role: 'assistant', content: 'edited' };
    if (reason === 'wrong-session') base.sessionId = 'other';
    if (reason === 'uncertified-history') current.messages[4] = { role: 'assistant', content: 'changed' };
    assert.equal(preserveLoadedHistoryPrefix(next, base, current), next);
  });
}

test('delta wire baseline stays narrow while only the visible view is widened', () => {
  const { base, current, next } = fixture();
  const result = reconcileSyncResponse({ sessionId: 'owned', status: 200, wireBaseline: base,
    currentMessages: current.messages, currentEntryIds: current.entryIds,
    payload: { protocol: 1, mode: 'delta', baseRevision: 'r1', revision: 'r2', dropCount: 1, keepCount: 2,
      tailMessages: [next.context.messages[2]], data: { ...next, context: { ...next.context, messages: undefined } } } });
  assert.equal(result.action, 'delta');
  assert.equal(preserveLoadedHistoryPrefix(result.data, base, current).context.messages.length, 6);
  assert.equal(result.newWireBaseline.messages.length, 3);
  assert.deepEqual(result.newWireBaseline.entryIds, ['e3', 'e4', 'e5']);
});

test('a retained render anchor prevents new output from re-hiding revealed history', () => {
  assert.equal(getVisibleRenderWindow(120, 100).startIndex, 20);
  assert.equal(getVisibleRenderWindow(145, 100, 20).startIndex, 20);
  assert.equal(getVisibleRenderWindow(150, 150, 70).startIndex, 0, 'explicit older-page reveal still wins');
  assert.equal(getVisibleRenderWindow(151, 150, 0).startIndex, 0, 'already revealed first node stays mounted');
});
test('an active exact native window can retain display ancestors without an idle cache revision',()=>{
 const {base,current,next,messages,ids}=fixture();
 const activeWindow={sessionId:base.sessionId,messages:base.messages,entryIds:base.entryIds};
 const kept=preserveLoadedHistoryPrefix({...next,snapshotRevision:null},activeWindow,current);
 assert.deepEqual(kept.context.entryIds,ids);assert.deepEqual(kept.context.messages,messages);
 assert.equal(kept.context.oldestEntryId,'e0');assert.equal(kept.snapshotRevision,null);
});
test('stable linear row IDs keep ancestors when an overlapped live tool finishes',()=>{
 const {base,current,next,ids}=fixture();
 next.context.messages[0]={...next.context.messages[0],content:[{type:'text',text:'native tool finished'}]};
 const kept=preserveLoadedHistoryPrefix(next,base,current,true);
 assert.deepEqual(kept.context.entryIds,ids);assert.equal(kept.context.messages[3].content[0].text,'native tool finished');
 next.context.entryIds[1]='different-branch-entry';assert.equal(preserveLoadedHistoryPrefix(next,base,current,true),next,'row identity mismatch still fails closed');
});
