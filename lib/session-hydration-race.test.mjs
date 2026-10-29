import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bumpSessionEpoch, isEpochFresh, invalidatesSessionHistory, resetSyncClientStateForTests} from './session-sync-client.ts';

test('warm SSE tool replay and streaming deltas cannot invalidate first history hydration', async () => {
  resetSyncClientStateForTests();
  const epoch = bumpSessionEpoch('active-session');
  const pendingDiskRead = Promise.resolve(null);
  for (const type of ['agent_start', 'message_start', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
    assert.equal(invalidatesSessionHistory(type), false, type);
    if (invalidatesSessionHistory(type)) bumpSessionEpoch('active-session');
  }
  await pendingDiskRead;
  assert.equal(isEpochFresh('active-session', epoch), true, 'initial network fetch must remain reachable');
});

test('committed SSE messages, settlement barriers and compaction reject an older snapshot', () => {
  for (const type of ['connected', 'message_end', 'agent_settled', 'prompt_done', 'compaction_start', 'auto_compaction_start']) {
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

test('consecutive message_end invalidations recover without surfacing English write-race errors', () => {
  const sessionSource = readFileSync(new URL('../hooks/useAgentSession.ts', import.meta.url), 'utf8');
  const chatWindowSource = readFileSync(new URL('../components/ChatWindow.tsx', import.meta.url), 'utf8');

  // No raw English write-race error banner string in hook
  assert.doesNotMatch(sessionSource, /History changed while loading/);

  // Recovery timer with owner-scoped guard and unmount cleanup
  assert.match(sessionSource, /historyRecoveryTimerRef/);
  assert.match(sessionSource, /setTimeout\(\(\) => \{[\s\S]*?historyRecoveryTimerRef\.current = null;[\s\S]*?if \(ownsCurrentView\(\)\)/);

  // Fallback recovery tick during running state
  assert.match(sessionSource, /if \(!dataRef\.current\) void loadSession\(sid\)/);

  // ChatWindow cleans up dead duplicate error branch and prevents button compression
  const duplicateMatches = chatWindowSource.match(/if \(error && messages\.length === 0\)/g) || [];
  assert.equal(duplicateMatches.length, 1, 'Duplicate unreachable error branch must be eliminated');
  assert.match(chatWindowSource, /flexShrink:\s*0/);
  assert.match(chatWindowSource, /whiteSpace:\s*["']nowrap["']/);

  // Recovery timer bounded to max 3 attempts with pending dirty sid retention
  assert.match(sessionSource, /MAX_TIMER_RETRIES = 3/);
  assert.match(sessionSource, /historyRecoveryPendingDirtySidRef/);
  assert.match(sessionSource, /historyRecoveryTimerRef\.current\.sid === sid/);
  assert.match(sessionSource, /historyRecoveryPendingDirtySidRef\.current = sid/);

  // Error banner must be in normal document flow, not an absolute floating layer covering messages
  const bannerBlock = chatWindowSource.match(/key="session-offline-error-banner"[\s\S]*?<\/div>/)?.[0] || '';
  assert.doesNotMatch(bannerBlock, /position:\s*["']absolute["']/);
  assert.doesNotMatch(bannerBlock, /transform:/);
  assert.match(bannerBlock, /width:\s*["']100%["']/);

  // All t() calls in ChatWindow must conform to useI18n signature (no default string literal as 2nd arg)
  assert.doesNotMatch(chatWindowSource, /t\("chat\.[a-zA-Z0-9]+",\s*["'][^"']+["']\)/);
});
