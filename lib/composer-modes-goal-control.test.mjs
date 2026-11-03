import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: {
    '@earendil-works/pi-ai': '/app/node_modules/@earendil-works/pi-ai/dist/index.js',
  },
});
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');
const composerModesExtension = (await jiti.import('/root/.pi/agent/extensions/composer-modes.ts')).default;

function createSessionFixture(t, options = {}) {
  const registeredCommands = new Map();
  const eventHandlers = new Map();
  const sessionEntries = [];
  let activeTools = ["read", "write", "bash", "edit", "grep", "find", "ls"];
  let isIdleVal = typeof options.idle === "boolean" ? options.idle : true;
  let aborted = false;

  const mockPi = {
    registerCommand(name, def) {
      registeredCommands.set(name, def);
    },
    on(event, handler) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event).push(handler);
    },
    appendEntry(type, data) {
      sessionEntries.push({ type: "custom", customType: type, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools) {
      activeTools = [...tools];
    },
    async emit(event, arg1, arg2) {
      const list = eventHandlers.get(event) || [];
      const results = [];
      for (const fn of list) {
        results.push(await fn(arg1, arg2));
      }
      return results;
    },
  };

  // 执行真实 extension 工厂注入
  composerModesExtension(mockPi);

  const inner = {
    sessionId: 'real-ext-goal-session',
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    abortBash() {},
    getActiveToolNames: () => [...activeTools],
    setActiveToolsByName: (tools) => { activeTools = [...tools]; },
    sessionManager: {
      getBranch: () => sessionEntries,
      getEntries: () => sessionEntries,
    },
    extensionRunner: {
      getRegisteredCommands: () => Array.from(registeredCommands.entries()).map(([name]) => ({ invocationName: name })),
      getCommand: (name) => registeredCommands.get(name),
      createCommandContext: () => ({
        isIdle: () => isIdleVal,
        abort: () => { aborted = true; },
        ui: {
          setStatus: (key, text) => {
            wrapper.extensionStatuses.set(key, text);
          },
          notify: () => {},
        },
        sessionManager: inner.sessionManager,
      }),
      emit: async () => {},
    },
    dispose() {},
    prompt: () => { throw new Error('direct goal control must not enter model prompt'); },
    getContextUsage: () => { throw new Error('must not read full context'); },
  };

  const wrapper = new AgentSessionWrapper(inner);
  wrapper.extensionsBound = true;

  t.after(() => wrapper.shutdown());

  return {
    wrapper,
    inner,
    mockPi,
    setIdle: (v) => { isIdleVal = v; },
    isAborted: () => aborted,
    resetAborted: () => { aborted = false; },
  };
}

test('real extension + wrapper: set goal mode, idle status is idle with timer zero', async t => {
  const h = createSessionFixture(t, { idle: true });

  // 1. 切换至 goal 模式
  await h.wrapper.send({ type: 'set_composer_mode', mode: 'goal' });
  const rawStatus = h.wrapper.extensionStatuses.get('composer-modes');
  assert.equal(JSON.parse(rawStatus).mode, 'goal');

  // 2. 注入目标文本（模拟用户首条非 slash 输入）
  const ctx = h.inner.extensionRunner.createCommandContext();
  await h.mockPi.emit('input', { text: '全链路验收自动化', source: 'user' }, ctx);

  const statusAfterInput = JSON.parse(h.wrapper.extensionStatuses.get('composer-modes'));
  assert.equal(statusAfterInput.goal, '全链路验收自动化');
  assert.equal(statusAfterInput.goalStatus, 'idle');
  assert.equal(statusAfterInput.goalElapsedMs, 0);
  assert.equal(statusAfterInput.goalActiveSinceMs, undefined, 'idle 状态下捕获目标不启动计时');
});

test('real extension + wrapper: pause during busy Pi run sets paused first, freezes timer, aborts turn, and blocks continuation', async t => {
  const h = createSessionFixture(t, { idle: true });
  const ctx = h.inner.extensionRunner.createCommandContext();

  await h.wrapper.send({ type: 'set_composer_mode', mode: 'goal' });
  await h.mockPi.emit('input', { text: '实施重构', source: 'user' }, ctx);

  // 模拟进入运行状态（busy 模型 + 运行 bash）
  h.setIdle(false);
  h.inner.isStreaming = true;
  h.inner.isBashRunning = true;
  await h.mockPi.emit('agent_start', null, ctx);

  const activeStatus = JSON.parse(h.wrapper.extensionStatuses.get('composer-modes'));
  assert.equal(activeStatus.goalStatus, 'active');
  assert.equal(typeof activeStatus.goalActiveSinceMs, 'number');

  await new Promise(r => setTimeout(r, 20));

  // 通过 wrapper 的 composer_goal_action 发送 pause（busy 状态无锁直通）
  const pauseRes = await h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: { objective: '实施重构' },
  });

  const parsedAck = JSON.parse(pauseRes.extensionStatuses[0].text);
  assert.equal(parsedAck.paused, true);
  assert.equal(parsedAck.goalStatus, 'paused');
  assert.equal(parsedAck.goalActiveSinceMs, undefined, '计时器被立即冻结');
  assert.ok(parsedAck.goalElapsedMs >= 15, '已累计执行段');
  assert.equal(h.isAborted(), true, '必须调用 ctx.abort() 终止当前 Pi 轮');

  // 运行中止后，agent_before_settle 必须被阻断
  const boundary = { outcome: 'completed', context: { canContinue: false, llmMessages: [{ role: 'assistant' }], pendingMessages: [] } };
  const continuation = (await h.mockPi.emit('agent_before_settle', boundary, ctx))[0];
  assert.equal(continuation, undefined, 'paused 状态下严禁任何 goal 自动续跑');

  h.inner.isStreaming = false;
  h.inner.isBashRunning = false;
});

test('real extension + wrapper: agent_settled transitions run to idle, freezeTimer, and sets goalStatus idle', async t => {
  const h = createSessionFixture(t, { idle: true });
  const ctx = h.inner.extensionRunner.createCommandContext();

  await h.wrapper.send({ type: 'set_composer_mode', mode: 'goal' });
  await h.mockPi.emit('input', { text: '验证流程', source: 'user' }, ctx);

  // 启动并模拟工具调用完成
  h.setIdle(false);
  await h.mockPi.emit('agent_start', null, ctx);
  await h.mockPi.emit('turn_end', { toolResults: [{ success: true }] });
  await new Promise(r => setTimeout(r, 20));

  // 结束本轮 run（回到 idle 触发 agent_settled）
  h.setIdle(true);
  await h.mockPi.emit('agent_settled', null, ctx);

  const settledStatus = JSON.parse(h.wrapper.extensionStatuses.get('composer-modes'));
  assert.equal(settledStatus.goalStatus, 'idle', 'settled 后 goalStatus 必须是 idle');
  assert.equal(settledStatus.paused, undefined);
  assert.equal(settledStatus.goalActiveSinceMs, undefined, '计时器必须冻结');
  assert.ok(settledStatus.goalElapsedMs >= 15);
});

test('real extension + wrapper: restore idle does not accumulate offline wall-clock delta', async t => {
  const h = createSessionFixture(t, { idle: true });
  const ctx = h.inner.extensionRunner.createCommandContext();

  // 模拟从历史恢复，包含 50 秒前的活跃时间戳
  const offlineSince = Date.now() - 50000;
  const branchData = [
    {
      type: "custom",
      customType: "composer-modes",
      data: {
        version: 1,
        mode: "goal",
        goal: "长效持续目标",
        goalElapsedMs: 8000,
        goalActiveSinceMs: offlineSince,
      },
    },
  ];
  h.inner.sessionManager.getBranch = () => branchData;

  await h.mockPi.emit('session_start', null, ctx);
  const restored = JSON.parse(h.wrapper.extensionStatuses.get('composer-modes'));
  assert.equal(restored.goalElapsedMs, 8000, '恢复处于 idle 时绝对不能累加离线 50000ms');
  assert.equal(restored.goalActiveSinceMs, undefined);
  assert.equal(restored.goalStatus, 'idle');
});

test('real extension: plan mode tool guard remains strict and disallows write tools', async t => {
  const h = createSessionFixture(t, { idle: true });

  await h.wrapper.send({ type: 'set_composer_mode', mode: 'plan' });

  // 验证 plan mode guard
  const blockedBash = (await h.mockPi.emit('tool_call', { toolName: 'bash' }))[0];
  assert.equal(blockedBash.block, true);
  assert.match(blockedBash.reason, /计划模式限制/);

  const blockedWrite = (await h.mockPi.emit('tool_call', { toolName: 'write' }))[0];
  assert.equal(blockedWrite.block, true);

  const allowedRead = (await h.mockPi.emit('tool_call', { toolName: 'read' }))[0];
  assert.equal(allowedRead, undefined, 'read 允许执行');
});
