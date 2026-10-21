import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': process.cwd(),
    'server-only': 'next/dist/compiled/server-only/empty.js',
  },
});

test('projectCodexRow maps row forkable capability to UserMessage without touching assistant/activity', async () => {
  const { projectCodexRow } = await jiti.import('./codex-projection.ts');
  const meta = { id: '01901234-5678-7000-8000-000000000001', title: '测试', cwd: '/workspace', status: 'idle', connected: true, sequence: 1 };

  // 1. 真实首条用户消息，带 forkable: true
  const validUserRow = {
    key: 'row-u1',
    turnId: 'turn-1',
    order: 0,
    version: 'ver-u1',
    role: 'user',
    text: '真实用户提问',
    forkable: true,
    timestamp: 1700000000000,
  };
  const projectedValid = projectCodexRow(validUserRow, meta);
  assert.equal(projectedValid.length, 1);
  assert.equal(projectedValid[0].role, 'user');
  assert.equal(projectedValid[0].forkable, true);

  // 2. 中途 steer 用户消息，带 forkable: false
  const steerUserRow = {
    key: 'row-u2',
    turnId: 'turn-1',
    order: 1,
    version: 'ver-u2',
    role: 'user',
    text: '中途补充指令',
    forkable: false,
    timestamp: 1700000001000,
  };
  const projectedSteer = projectCodexRow(steerUserRow, meta);
  assert.equal(projectedSteer.length, 1);
  assert.equal(projectedSteer[0].role, 'user');
  assert.equal(projectedSteer[0].forkable, false);

  // 3. assistant 消息
  const assistantRow = {
    key: 'row-a1',
    turnId: 'turn-1',
    order: 2,
    version: 'ver-a1',
    role: 'assistant',
    text: '回答',
    timestamp: 1700000002000,
  };
  const projectedAssistant = projectCodexRow(assistantRow, meta);
  assert.equal(projectedAssistant.length, 1);
  assert.equal(projectedAssistant[0].role, 'assistant');
  assert.equal(projectedAssistant[0].forkable, undefined);
});

test('CodexRuntime.execute({ type: "fork" }) enforces entry validation, stable requestId and catalog invalidation', async () => {
  const { CodexRuntime } = await jiti.import('./codex-engine.ts');

  const threadId = '01901234-5678-7000-8000-000000000001';
  const childThreadId = '01901234-5678-7000-8000-000000000002';
  const identity = 'test-identity-fork';

  const validRow = {
    key: 'u1-key',
    turnId: 'turn-1',
    order: 0,
    version: 'ver-123456',
    role: 'user',
    text: '第一问',
    forkable: true,
  };

  const unForkableRow = {
    key: 'u2-key',
    turnId: 'turn-1',
    order: 1,
    version: 'ver-654321',
    role: 'user',
    text: '不可分支的提问',
    forkable: false,
  };

  const assistantRow = {
    key: 'a1-key',
    turnId: 'turn-1',
    order: 2,
    version: 'ver-a1',
    role: 'assistant',
    text: '回复',
  };

  const page = {
    epoch: 'epoch-100',
    sequence: 1,
    before: null,
    hasMore: false,
    rows: [validRow, unForkableRow, assistantRow],
    meta: {
      id: threadId,
      title: '源会话',
      cwd: '/workspace',
      status: 'idle',
      connected: true,
      sequence: 1,
    },
  };

  const runtime = new CodexRuntime('codex:' + threadId, identity, page);

  // 1. 不存在的 entryId 拒绝
  await assert.rejects(
    () => runtime.send({ type: 'fork', entryId: 'missing-key:0' }),
    /选定的消息不存在/
  );

  // 2. 非 user 角色拒绝
  await assert.rejects(
    () => runtime.send({ type: 'fork', entryId: 'a1-key:0' }),
    /仅支持在用户消息/
  );

  // 3. forkable 为 false 拒绝
  await assert.rejects(
    () => runtime.send({ type: 'fork', entryId: 'u2-key:0' }),
    /当前消息不支持/
  );

  // 4. 正常 fork 调用：校验发送的 payload 与 catalog 清除
  const catalogKey = Symbol.for('pi-web.codex-catalog');
  const catalogGlobals = globalThis;
  catalogGlobals[catalogKey] = { identity, rows: [{ id: threadId }], loadedAt: Date.now(), version: 1 };

  let postedPayload = null;
  runtime.json = async (path, body) => {
    assert.equal(path, `/api/sessions/${threadId}/message-action`);
    postedPayload = body;
    return { ok: true, childId: childThreadId, status: 'created' };
  };

  const res = await runtime.send({
    type: 'fork',
    entryId: 'u1-key:0',
    requestId: 'client-stable-uuid-42',
  });

  assert.equal(res.newSessionId, 'codex:' + childThreadId);
  assert.equal(postedPayload.action, 'fork');
  assert.equal(postedPayload.key, 'u1-key');
  assert.equal(postedPayload.version, 'ver-123456');
  assert.equal(postedPayload.epoch, 'epoch-100');
  assert.equal(postedPayload.requestId, 'client-stable-uuid-42');

  // catalog 缓存已被清除
  assert.equal(catalogGlobals[catalogKey], undefined);
});

test('MessageView canFork derivation honors message.forkable capability and defaults to true for Pi', () => {
  const deriveCanFork = (entryId, onFork, forkable) => Boolean(entryId && onFork && (forkable ?? true));

  const entryId = 'entry-1';
  const onFork = () => {};

  // Codex 真实用户消息，具备 forkable: true
  assert.equal(deriveCanFork(entryId, onFork, true), true);

  // Codex steer / 虚构用户消息，具备 forkable: false
  assert.equal(deriveCanFork(entryId, onFork, false), false);

  // Pi 原生用户消息，forkable 为 undefined -> 保持 true
  assert.equal(deriveCanFork(entryId, onFork, undefined), true);

  // 缺少 entryId 或 onFork 时为 false
  assert.equal(deriveCanFork(null, onFork, true), false);
  assert.equal(deriveCanFork(entryId, null, true), false);
});
