import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bumpSessionEpoch, isEpochFresh, invalidatesSessionHistory, resetSyncClientStateForTests} from './session-sync-client.ts';

test('warm SSE tool replay and streaming deltas cannot invalidate first history hydration', async () => {
  resetSyncClientStateForTests();
  const epoch = bumpSessionEpoch('active-session');
  const pendingDiskRead = Promise.resolve(null);
  for (const type of ['connected', 'agent_start', 'message_start', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
    assert.equal(invalidatesSessionHistory(type), false, type);
    if (invalidatesSessionHistory(type)) bumpSessionEpoch('active-session');
  }
  await pendingDiskRead;
  assert.equal(isEpochFresh('active-session', epoch), true, 'initial network fetch must remain reachable');
});

test('committed SSE messages and compaction still reject an older snapshot', () => {
  for (const type of ['message_end', 'compaction_start', 'auto_compaction_start']) {
    const epoch = bumpSessionEpoch('active-session');
    assert.equal(invalidatesSessionHistory(type), true);
    if (invalidatesSessionHistory(type)) bumpSessionEpoch('active-session');
    assert.equal(isEpochFresh('active-session', epoch), false);
  }
});

test('initial read has an owner-scoped bounded retry and retains stale commit checks', () => {
  const source = readFileSync(new URL('../hooks/useAgentSession.ts', import.meta.url), 'utf8');
  assert.match(source, /invalidatesSessionHistory\(event\.type\)/);
  assert.match(source, /latestLoadRequestRef\.current === readOwner/);
  assert.match(source, /ownsCurrentView\(\) && !messagesLoaded/);
  assert.match(source, /!options\?\.streamRetry/);
  assert.match(source, /if \(ownsCurrentView\(\)\) void loadSession\(sid, true, includeState, \{ force: true, streamRetry: true \}\)/);
  assert.match(source, /if \(!isCurrentRead\(\)\) return null/);
});
