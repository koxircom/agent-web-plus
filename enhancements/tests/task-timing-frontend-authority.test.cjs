'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/06-chat-view-and-tool-cards.js'), 'utf8');

function setupContext() {
  const context = {
    window: {},
    Date: { now: () => 1700000000000 },
    Math,
    isPluginEnabled: () => true,
    getCurrentSessionId: () => 'sess-1',
    activeCleanups: [],
    addManagedTimeout: (fn) => setTimeout(fn, 0),
    isDisposed: false,
    syncAllModelSpeedBadges: () => {},
    scheduleCurrentSessionMetrics: () => {},
    clearMinimapNavigationScrollGuard: () => {},
    clearNativeMinimapRevealScrollBlock: () => {},
  };
  vm.createContext(context);
  // Extract activeSessionTurns and recordActiveTurnStart and handleModelSpeedStreamEvent definitions
  const startIdx = source.indexOf('  // Active session turn start tracking:');
  const endIdx = source.indexOf('  window.__PI_ENH_HANDLE_MODEL_SPEED_STREAM_EVENT__ = handleModelSpeedStreamEvent;');
  assert.ok(startIdx > 0 && endIdx > startIdx, 'must locate active turns functions');
  const code = source.slice(startIdx, endIdx + '  window.__PI_ENH_HANDLE_MODEL_SPEED_STREAM_EVENT__ = handleModelSpeedStreamEvent;\n'.length);
  vm.runInContext(code, context);
  return context;
}

test('frontend 06 authoritative taskTiming preserves actual consumption start and rejects stale metrics uTime', () => {
  const ctx = setupContext();
  const { __PI_ENH_RECORD_ACTIVE_TURN_START__: recordStart, __PI_ENH_GET_ACTIVE_TURN_START__: getStart, __PI_ENH_ACTIVE_TURNS__: turns } = ctx.window;

  const actualStart = 1700000000000;
  recordStart('sess-1', actualStart, null, true, { taskId: 'task-A', authoritativeTaskTiming: true });

  assert.equal(getStart('sess-1'), actualStart);
  const trackedA = turns.get('sess-1');
  assert.equal(trackedA.taskId, 'task-A');
  assert.equal(trackedA.authoritativeTaskTiming, true);

  // 随后，历史 turns 的 metrics 尝试用旧消息的 timestamp (旧 uTime，例如 100 秒前) 覆盖
  const staleUtime = actualStart - 100000;
  recordStart('sess-1', staleUtime, 'msg-u1', true);

  // 权威计时必须保持不变，绝不被旧 uTime 覆盖！
  assert.equal(getStart('sess-1'), actualStart, 'stale metrics uTime must NOT overwrite authoritative taskTiming');
  assert.equal(turns.get('sess-1').startTime, actualStart);
});

test('frontend 06 preserves existing start on identical taskId and updates on new follow-up taskId', () => {
  const ctx = setupContext();
  const { __PI_ENH_RECORD_ACTIVE_TURN_START__: recordStart, __PI_ENH_GET_ACTIVE_TURN_START__: getStart, __PI_ENH_ACTIVE_TURNS__: turns } = ctx.window;

  const start1 = 1700000000000;
  recordStart('sess-1', start1, null, true, { taskId: 'task-A', authoritativeTaskTiming: true });

  // 相同 taskId 再次到来（例如重连 connected 或重复 state_sync）
  recordStart('sess-1', start1 + 5000, null, true, { taskId: 'task-A', authoritativeTaskTiming: true });
  assert.equal(getStart('sess-1'), start1, 'same taskId must preserve original startTime without restarting');

  // follow-up 任务 B 消费：新的 taskId 到来
  const startB = 1700000010000;
  ctx.Date.now = () => startB;
  recordStart('sess-1', startB, null, true, { taskId: 'task-B', authoritativeTaskTiming: true });
  assert.equal(getStart('sess-1'), startB, 'new follow-up taskId must establish new authoritative timing');
  assert.equal(turns.get('sess-1').taskId, 'task-B');
});

test('frontend 06 handleModelSpeedStreamEvent ignores redundant agent_start if authoritative timing exists', () => {
  const ctx = setupContext();
  const {
    __PI_ENH_HANDLE_MODEL_SPEED_STREAM_EVENT__: handleEvent,
    __PI_ENH_GET_ACTIVE_TURN_START__: getStart,
    __PI_ENH_CLEAR_ACTIVE_TURN__: clearTurn,
  } = ctx.window;

  const authoritativeStart = 1700000005000;
  ctx.Date.now = () => authoritativeStart;

  // 收到携带 taskTiming 的 message_start
  handleEvent('sess-1', {
    type: 'message_start',
    taskTiming: { taskId: 'task-A', startedAt: authoritativeStart },
  });
  assert.equal(getStart('sess-1'), authoritativeStart);

  // 重复/双 agent_start 到来，由于已确立 authoritativeTaskTiming，不得无限重置
  ctx.Date.now = () => authoritativeStart + 3000;
  handleEvent('sess-1', { type: 'agent_start' });
  assert.equal(getStart('sess-1'), authoritativeStart, 'redundant agent_start must not reset authoritative task timing');

  // 收到 connected 空闲终态时清理，不可被旧 timer 复活（在无权威运行中任务时）
  clearTurn('sess-1');
  handleEvent('sess-1', { type: 'connected', isStreaming: false, taskTiming: null });
  assert.equal(getStart('sess-1'), null, 'idle connected must clear active turn and prevent stale timer revive');
});

test('frontend 06 rejects non-finite/invalid startedAt or missing string taskId and ignores stale state with earlier startedAt', () => {
  const ctx = setupContext();
  const {
    __PI_ENH_HANDLE_MODEL_SPEED_STREAM_EVENT__: handleEvent,
    __PI_ENH_RECORD_ACTIVE_TURN_START__: recordStart,
    __PI_ENH_GET_ACTIVE_TURN_START__: getStart,
    __PI_ENH_ACTIVE_TURNS__: turns,
  } = ctx.window;

  // 1. 非法 startedAt / 无 id 权威被严格拒绝
  handleEvent('sess-1', {
    type: 'message_start',
    taskTiming: { taskId: '', startedAt: 1700000000000 },
  });
  assert.equal(getStart('sess-1'), null, 'empty taskId must be rejected');

  handleEvent('sess-1', {
    type: 'message_start',
    taskTiming: { taskId: 'task-1', startedAt: Infinity },
  });
  assert.equal(getStart('sess-1'), null, 'Infinity startedAt must be rejected');

  handleEvent('sess-1', {
    type: 'message_start',
    taskTiming: { taskId: 'task-1', startedAt: -100 },
  });
  assert.equal(getStart('sess-1'), null, 'negative startedAt must be rejected');

  // 2. 正常确立任务 B 权威计时
  const startB = 1700000010000;
  ctx.Date.now = () => startB;
  handleEvent('sess-1', {
    type: 'message_start',
    taskTiming: { taskId: 'task-B', startedAt: startB },
  });
  assert.equal(getStart('sess-1'), startB);

  // 3. 迟到的旧 task A（startedAt 更早，例如 1700000005000）或旧 state 快照到来，绝不可回退当前较新任务 B
  const staleEarlierStart = startB - 5000;
  handleEvent('sess-1', {
    type: 'state_sync',
    taskTiming: { taskId: 'task-A-stale', startedAt: staleEarlierStart },
  });
  assert.equal(getStart('sess-1'), startB, 'stale state with earlier startedAt must NOT roll back current task B');
  assert.equal(turns.get('sess-1').taskId, 'task-B');

  // 4. 旧 connected (isStreaming: false, taskTiming: null) 到来，不可冲掉当前已确立的权威任务 B
  handleEvent('sess-1', { type: 'connected', isStreaming: false, taskTiming: null });
  assert.equal(getStart('sess-1'), startB, 'stale connected snapshot must NOT cancel active authoritative task B');
});

test('frontend 03 readSessionRunningState unwraps json.success/data envelopes consistently', () => {
  const source03 = fs.readFileSync(path.join(__dirname, '../modules/03-session-cache-and-sync-engine.js'), 'utf8');
  const context = {
    window: {},
    Date: { now: () => 1700000000000 },
    Boolean,
    Array,
  };
  vm.createContext(context);
  const startIdx = source03.indexOf('  function readSessionRunningState(payload) {');
  const endIdx = source03.indexOf('  async function cachedSessionFetch(input, init) {');
  assert.ok(startIdx > 0 && endIdx > startIdx, 'locate readSessionRunningState');
  const code = source03.slice(startIdx, endIdx);
  vm.runInContext(code, context);

  const readRunning = context.readSessionRunningState;
  assert.equal(typeof readRunning, 'function');

  // 直接传原生 state
  assert.equal(readRunning({ state: { isStreaming: true } }), true);
  assert.equal(readRunning({ state: { isStreaming: false, isPromptRunning: false, isBashRunning: false } }), false);

  // 包裹在 { success: true, data: { ... } } 格式
  assert.equal(readRunning({ success: true, data: { state: { isStreaming: true } } }), true);
  assert.equal(readRunning({ success: true, data: { state: { isStreaming: false, isPromptRunning: false } } }), false);

  // 包裹在 { data: { state: { ... } } }
  assert.equal(readRunning({ data: { state: { isBashRunning: true } } }), true);
  assert.equal(readRunning({ data: { state: { isBashRunning: false, isStreaming: false } } }), false);
});

test('frontend 06 activeSessionTurns maintains strict cross-session isolation', () => {
  const ctx = setupContext();
  ctx.Date.now = () => 1700000005000;
  const { __PI_ENH_RECORD_ACTIVE_TURN_START__: recordStart, __PI_ENH_GET_ACTIVE_TURN_START__: getStart } = ctx.window;

  recordStart('sess-A', 1700000001000, null, true, { taskId: 'task-A', authoritativeTaskTiming: true });
  recordStart('sess-B', 1700000002000, null, true, { taskId: 'task-B', authoritativeTaskTiming: true });

  assert.equal(getStart('sess-A'), 1700000001000);
  assert.equal(getStart('sess-B'), 1700000002000);
});
