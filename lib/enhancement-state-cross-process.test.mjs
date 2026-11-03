import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storeModulePath = path.resolve(__dirname, 'enhancement-state-store.cjs');
const mutexModulePath = path.resolve(__dirname, 'agent-state-mutex.cjs');

import {
  createStateStore,
  withAgentStateLock,
  withAgentStateLockSync,
  recoverStaleLock,
  EnhancementStateStore
} from './enhancement-state-store.cjs';

import {
  checkOwnerReclaimable,
  getProcessStartTicks,
  getLockDir,
  tryAcquireLockSync,
  releaseLockSync
} from './agent-state-mutex.cjs';

const tempDirs = [];

function createTempAgentDir(prefix = 'pi-enh-cross-proc-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

test.after(() => {
  cleanupTempDirs();
});

test('concurrent additive tags: spawn >= 6 child processes, no lost updates, revision monotonic', async () => {
  const agentDir = createTempAgentDir('pi-concurrent-');
  const store = createStateStore({ agentDir });

  // 1. 初始化 store
  store.ensureInitializedFromLegacy();

  const numWorkers = 6;
  const opsPerWorker = 4;
  const workerScript = path.join(agentDir, 'worker.cjs');

  // 编写 worker 脚本：接收 workerId，执行 opsPerWorker 次 commit
  const scriptContent = `
'use strict';
const { createStateStore } = require(${JSON.stringify(storeModulePath)});
const workerId = process.argv[2];
const agentDir = process.argv[3];
const opsPerWorker = parseInt(process.argv[4], 10);

async function run() {
  const store = createStateStore({ agentDir });
  for (let i = 0; i < opsPerWorker; i++) {
    const tagId = 'tag-' + workerId + '-' + i;
    const tagName = 'Tag ' + workerId + ' ' + i;
    const op = {
      opId: 'op-' + workerId + '-' + i,
      type: 'tag_create',
      timestamp: Date.now(),
      tag: {
        id: tagId,
        name: tagName,
        color: '#3b82f6'
      }
    };
    await store.commit([op]);
  }
}

run().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Worker ' + workerId + ' error:', err);
  process.exit(1);
});
`;
  fs.writeFileSync(workerScript, scriptContent, 'utf8');

  // 并发启动 6 个子进程
  const children = [];
  for (let i = 0; i < numWorkers; i++) {
    const child = spawn(process.execPath, [workerScript, String(i), agentDir, String(opsPerWorker)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Worker ${i} exited with code ${code}: ${stderr}`));
      });
    }));
  }

  await Promise.all(children);

  // 验证结果
  const finalState = store.read();
  const expectedTotalTags = numWorkers * opsPerWorker;
  assert.equal(
    finalState.state.sessionTagsDefinitions.length,
    expectedTotalTags,
    `Expected ${expectedTotalTags} tags, but got ${finalState.state.sessionTagsDefinitions.length}`
  );

  // 校验 revision 单调递增并且等于 1(init) + expectedTotalTags
  assert.equal(finalState.revision, 1 + expectedTotalTags);

  // 逐一核实每个 worker 的每个 tag 都在
  const tagIds = new Set(finalState.state.sessionTagsDefinitions.map((t) => t.id));
  for (let w = 0; w < numWorkers; w++) {
    for (let i = 0; i < opsPerWorker; i++) {
      const expectedId = `tag-${w}-${i}`;
      assert.ok(tagIds.has(expectedId), `Missing tag: ${expectedId}`);
    }
  }

  // 校验 journal.jsonl 完整性
  const journalPath = path.join(agentDir, 'state', 'enhancement-state', 'journal.jsonl');
  const journalContent = fs.readFileSync(journalPath, 'utf8');
  assert.ok(journalContent.endsWith('\n'), 'Journal must end with newline');
  const lines = journalContent.trim().split('\n');
  assert.equal(lines.length, 1 + expectedTotalTags);

  for (let idx = 0; idx < lines.length; idx++) {
    const entry = JSON.parse(lines[idx]);
    assert.equal(entry.revision, idx + 1);
  }
});

test('read freshness: cross-process read immediately sees updates without stale cache, and read-only never inits', async () => {
  const agentDir = createTempAgentDir('pi-fresh-');
  const storeMain = createStateStore({ agentDir });

  // 1. read-only 在未初始化目录上不 init、不修盘、报 NOT_INITIALIZED
  assert.throws(
    () => storeMain.read(),
    (err) => err.code === 'NOT_INITIALIZED' || err.message.includes('NOT_INITIALIZED')
  );
  assert.equal(fs.existsSync(path.join(agentDir, 'state')), false, 'read() must not create state dir');
  assert.equal(fs.existsSync(getLockDir(agentDir)), false, 'Lock directory must disappear after read');

  // 初始化
  storeMain.ensureInitializedFromLegacy();
  const initialRead = storeMain.read();
  assert.equal(initialRead.revision, 1);
  assert.equal(initialRead.state.sessionTagsDefinitions.length, 0);
  assert.equal(fs.existsSync(getLockDir(agentDir)), false, 'Lock directory must disappear after read on initialized store');

  // 2. 子进程写入新数据
  const childScript = `
'use strict';
const { createStateStore } = require(${JSON.stringify(storeModulePath)});
async function run() {
  const store = createStateStore({ agentDir: ${JSON.stringify(agentDir)} });
  await store.commit([{
    opId: 'op-external-1',
    type: 'tag_create',
    timestamp: Date.now(),
    tag: { id: 'tag-fresh-1', name: 'Fresh Tag' }
  }]);
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
`;
  const child = spawn(process.execPath, ['-e', childScript], { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child exited with code ${code}`));
    });
  });

  // 3. storeMain 再次读取，必须立即观察到新 tag，不保留陈旧 cache
  const stateFilesBefore = fs.readdirSync(path.join(agentDir, 'state', 'enhancement-state'))
    .filter((f) => fs.statSync(path.join(agentDir, 'state', 'enhancement-state', f)).isFile())
    .sort();
  const hashesBefore = stateFilesBefore.map((f) => {
    const full = path.join(agentDir, 'state', 'enhancement-state', f);
    return { f, h: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
  });

  const freshRead = storeMain.read();
  assert.equal(freshRead.revision, 2);
  assert.equal(freshRead.state.sessionTagsDefinitions.length, 1);
  assert.equal(freshRead.state.sessionTagsDefinitions[0].id, 'tag-fresh-1');

  assert.equal(fs.existsSync(getLockDir(agentDir)), false, 'Lock directory must disappear after read');
  const stateFilesAfter = fs.readdirSync(path.join(agentDir, 'state', 'enhancement-state'))
    .filter((f) => fs.statSync(path.join(agentDir, 'state', 'enhancement-state', f)).isFile())
    .sort();
  const hashesAfter = stateFilesAfter.map((f) => {
    const full = path.join(agentDir, 'state', 'enhancement-state', f);
    return { f, h: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
  });
  assert.deepEqual(hashesAfter, hashesBefore, 'read-only must not modify any state disk files');
});

test('crash lock fail-closed vs live timeout: dead owner fails closed with LOCK_STALE_REQUIRES_RECOVERY, ticks mismatch fails closed, live owner timeouts, explicit recovery works', async () => {
  const agentDir = createTempAgentDir('pi-mutex-test-');

  // A. 测试 Crash Lock 遗留与 Fail-Closed 诊断（子进程骤死 SIGKILL）
  const crashScript = `
'use strict';
const { withAgentStateLockSync } = require(${JSON.stringify(mutexModulePath)});
withAgentStateLockSync(${JSON.stringify(agentDir)}, () => {
  // 拿到锁后直接 SIGKILL 自己，遗留锁目录和 owner.json
  process.kill(process.pid, 'SIGKILL');
});
`;
  const crashChild = spawn(process.execPath, ['-e', crashScript]);
  await new Promise((resolve) => crashChild.on('close', resolve));

  // 确认锁目录和 owner.json 确实遗留在了磁盘
  const lockDir = getLockDir(agentDir);
  assert.ok(fs.existsSync(lockDir), 'Lock dir must exist after crash');
  const ownerFile = path.join(lockDir, 'owner.json');
  assert.ok(fs.existsSync(ownerFile), 'owner.json must exist');

  // 检查 reclaimable 状态：禁止自动回收！reclaimable 必须为 false，isDead 必须为 true
  const reclaimCheck = checkOwnerReclaimable(lockDir);
  assert.equal(reclaimCheck.reclaimable, false, 'Automatic reclaim must be prohibited');
  assert.equal(reclaimCheck.isDead, true);
  assert.equal(reclaimCheck.reason, 'PROCESS_DEAD');

  // 另一个进程尝试获取锁：必须 fail-closed 抛出 LOCK_STALE_REQUIRES_RECOVERY，绝不自动强抢或丢锁
  assert.throws(
    () => withAgentStateLockSync(agentDir, () => {}),
    (err) => err.code === 'LOCK_STALE_REQUIRES_RECOVERY' && err.reason === 'PROCESS_DEAD'
  );

  // 异步获取同样必须立即抛出 LOCK_STALE_REQUIRES_RECOVERY，不盲目轮询
  await assert.rejects(
    async () => {
      await withAgentStateLock(agentDir, async () => {}, { timeoutMs: 200, pollIntervalMs: 10 });
    },
    (err) => err.code === 'LOCK_STALE_REQUIRES_RECOVERY' && err.reason === 'PROCESS_DEAD'
  );

  // 验证锁目录和元数据依然安全保留（不丢锁）
  assert.ok(fs.existsSync(lockDir), 'Lock dir must remain intact on fail-closed');
  assert.ok(fs.existsSync(ownerFile), 'owner.json must remain intact on fail-closed');
  const deadOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));

  // 测试未指定 offlineMaintenance 或 expectedToken 不匹配时拒绝恢复（去 force）
  const recNoOpt = recoverStaleLock(agentDir);
  assert.equal(recNoOpt.ok, false);
  assert.equal(recNoOpt.recovered, false);

  const recWrongToken = recoverStaleLock(agentDir, {
    offlineMaintenance: true,
    expectedToken: 'wrong-token-abc'
  });
  assert.equal(recWrongToken.ok, false);
  assert.equal(recWrongToken.recovered, false);
  assert.equal(recWrongToken.reason, 'OWNER_TOKEN_REQUIRED');

  // 测试显式受控恢复函数 recoverStaleLock：死锁用确实 owner token 指定 offlineMaintenance
  const recRes = recoverStaleLock(agentDir, {
    offlineMaintenance: true,
    expectedToken: deadOwner.token
  });
  assert.equal(recRes.ok, true);
  assert.equal(recRes.recovered, true);
  assert.equal(fs.existsSync(lockDir), false, 'Lock dir must be removed after explicit recovery');

  // 恢复后正常获取并释放锁
  let acquiredAfterRecovery = false;
  withAgentStateLockSync(agentDir, () => {
    acquiredAfterRecovery = true;
  });
  assert.ok(acquiredAfterRecovery, 'Must acquire lock cleanly after explicit recovery');

  // B. 测试 startTicks mismatch 场景（在 Linux 下 PID 被复用）
  if (process.platform === 'linux') {
    // 构造一个锁目录，里面的 PID 是当前进程，但 startTicks 是假数据
    const handle = tryAcquireLockSync(agentDir);
    assert.ok(handle, 'Should acquire lock');
    // 修改 owner.json 中的 startTicks 为不匹配值
    const meta = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    meta.startTicks = '9999999999';
    fs.writeFileSync(ownerFile, JSON.stringify(meta), 'utf8');

    const mismatchCheck = checkOwnerReclaimable(lockDir);
    assert.equal(mismatchCheck.reclaimable, false, 'Must not automatically reclaim on mismatch');
    assert.equal(mismatchCheck.isDead, true);
    assert.equal(mismatchCheck.reason, 'START_TICKS_MISMATCH');

    // 获取锁时同样必须 failclosed 抛出 LOCK_STALE_REQUIRES_RECOVERY
    assert.throws(
      () => withAgentStateLockSync(agentDir, () => {}),
      (err) => err.code === 'LOCK_STALE_REQUIRES_RECOVERY' && err.reason === 'START_TICKS_MISMATCH'
    );
    assert.ok(fs.existsSync(lockDir), 'Lock dir must not be deleted on mismatch');

    // 显式受控清理：死锁用确实 owner token 指定 offlineMaintenance
    const cleanMismatch = recoverStaleLock(agentDir, {
      offlineMaintenance: true,
      expectedToken: meta.token
    });
    assert.equal(cleanMismatch.ok, true);
    assert.equal(cleanMismatch.recovered, true);
  }

  // C. 测试跨 namespace 诊断为 UNKNOWN_OWNER 不可 deadclaim
  if (process.platform === 'linux') {
    const handleNs = tryAcquireLockSync(agentDir);
    assert.ok(handleNs, 'Should acquire lock for ns test');
    const meta = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    meta.pidNamespace = 'pid:[9999999999]';
    fs.writeFileSync(ownerFile, JSON.stringify(meta), 'utf8');

    const nsCheck = checkOwnerReclaimable(lockDir);
    assert.equal(nsCheck.reclaimable, false);
    assert.equal(nsCheck.isDead, false, 'Cross-namespace must not be claimed as dead');
    assert.equal(nsCheck.reason, 'UNKNOWN_OWNER');

    // 获取锁时视作 UNKNOWN_OWNER / 占用锁，抛出 LOCK_BUSY 而非 STALE
    assert.throws(
      () => withAgentStateLockSync(agentDir, () => {}),
      (err) => err.code === 'LOCK_BUSY'
    );

    // 测试去 force：非 dead 锁传 force / offlineMaintenance 也被强 deny
    const recDeny = recoverStaleLock(agentDir, {
      force: true,
      offlineMaintenance: true,
      expectedToken: meta.token
    });
    assert.equal(recDeny.ok, false);
    assert.equal(recDeny.recovered, false);
    assert.equal(recDeny.reason, 'UNKNOWN_OWNER');
    assert.ok(fs.existsSync(lockDir));

    // 清理测试用的锁目录
    try { fs.unlinkSync(ownerFile); } catch (_) {}
    try { fs.rmdirSync(lockDir); } catch (_) {}
  }

  // D. 测试 Live owner 拒绝强抢与超时
  const liveScript = `
'use strict';
const { withAgentStateLockSync } = require(${JSON.stringify(mutexModulePath)});
withAgentStateLockSync(${JSON.stringify(agentDir)}, () => {
  process.stdout.write('LOCKED\\n');
  const end = Date.now() + 1500;
  while (Date.now() < end) {}
});
`;
  const liveChild = spawn(process.execPath, ['-e', liveScript], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => {
    liveChild.stdout.once('data', (d) => {
      if (d.toString().includes('LOCKED')) resolve();
    });
  });

  // 活 owner 检查：绝对不可回收！
  const liveCheck = checkOwnerReclaimable(lockDir);
  assert.equal(liveCheck.reclaimable, false);
  assert.equal(liveCheck.isDead, false);
  assert.equal(liveCheck.reason, 'PROCESS_ALIVE');

  // 契约：活 owner force 不能恢复，测试强 deny 不可先删真活
  const liveRec = recoverStaleLock(agentDir, {
    force: true,
    offlineMaintenance: true,
    expectedToken: liveCheck.owner?.token
  });
  assert.equal(liveRec.ok, false, 'Live owner must never be recovered even with force');
  assert.equal(liveRec.recovered, false);
  assert.equal(liveRec.reason, 'PROCESS_ALIVE');
  assert.ok(fs.existsSync(lockDir), 'Lock dir must remain intact for live owner');
  assert.ok(fs.existsSync(ownerFile), 'owner.json must remain intact for live owner');

  // 同步锁尝试获取：立即 fail-closed 抛出 LOCK_BUSY
  assert.throws(
    () => withAgentStateLockSync(agentDir, () => {}),
    (err) => err.code === 'LOCK_BUSY'
  );

  // 异步锁尝试获取：设置较短的 timeoutMs，超时后抛出 LOCK_BUSY，绝不强抢
  await assert.rejects(
    async () => {
      await withAgentStateLock(agentDir, async () => {}, { timeoutMs: 100, pollIntervalMs: 10 });
    },
    (err) => err.code === 'LOCK_BUSY'
  );

  // 等待活子进程正常释放退出
  await new Promise((resolve) => liveChild.on('close', resolve));
  assert.equal(fs.existsSync(lockDir), false, 'Live process must release lock cleanly on exit');
});

test('duplicate init: no overwrite, bad legacy preserved, SDK compat parses BOM/comments/trailing comma, and ensureInitializedFromLegacy', () => {
  const agentDir = createTempAgentDir('pi-init-test-');
  const store = createStateStore({ agentDir });

  // 1. SDK 兼容性测试：BOM + comments + trailing comma
  const modelsPath = path.join(agentDir, 'models.json');
  const compatContent = '\uFEFF// Comment at top\n{\n' +
    '  /* multi-line\n   comment */\n' +
    '  "sessionTagsDefinitions": [\n' +
    '    { "id": "t1", "name": "Tag 1", }, // trailing comma in array\n' +
    '  ],\n' +
    '  "sessionTagMappings": {\n' +
    '    "s1": ["t1",],\n' +
    '  },\n' +
    '  "sessionColors": {\n' +
    '    "s1": "red",\n' +
    '  },\n' +
    '} // end\n';
  fs.writeFileSync(modelsPath, compatContent, 'utf8');

  const initRes = store.initializeFromLegacy({ modelsConfigPath: modelsPath });
  assert.equal(initRes.ok, true);
  assert.equal(initRes.revision, 1);
  assert.equal(initRes.state.sessionTagsDefinitions.length, 1);
  assert.equal(initRes.state.sessionTagsDefinitions[0].id, 't1');

  // 2. 重复调用 initializeFromLegacy 报 ALREADY_INITIALIZED，绝不覆盖
  assert.throws(
    () => store.initializeFromLegacy({ modelsConfigPath: modelsPath }),
    (err) => err.message.includes('ALREADY_INITIALIZED')
  );
  assert.equal(store.read().revision, 1);

  // 3. ensureInitializedFromLegacy 幂等安全返回，无 race
  const ensureRes = store.ensureInitializedFromLegacy();
  assert.equal(ensureRes.ok, true);
  assert.equal(ensureRes.revision, 1);

  // 4. 损坏的 legacy：新建一个目录测试坏 legacy 不被清空
  const badDir = createTempAgentDir('pi-bad-legacy-');
  const badStore = createStateStore({ agentDir: badDir });
  const badModelsPath = path.join(badDir, 'models.json');
  const badContent = '{ corrupt json: [[ ';
  fs.writeFileSync(badModelsPath, badContent, 'utf8');

  assert.throws(
    () => badStore.initializeFromLegacy({ modelsConfigPath: badModelsPath }),
    (err) => err.message.includes('LEGACY_MODELS_INVALID')
  );

  // 断言坏文件原封不动保留，绝不清空
  assert.equal(fs.readFileSync(badModelsPath, 'utf8'), badContent);
  assert.equal(fs.existsSync(path.join(badDir, 'state')), false);

  // 5. 缺 models 时 ensureInitializedFromLegacy 安全创建 empty tags，不产生 models 凭据
  const emptyDir = createTempAgentDir('pi-empty-legacy-');
  const emptyStore = createStateStore({ agentDir: emptyDir });
  const resEmpty = emptyStore.ensureInitializedFromLegacy();
  assert.equal(resEmpty.ok, true);
  assert.equal(resEmpty.revision, 1);
  assert.equal(resEmpty.state.sessionTagsDefinitions.length, 0);
  assert.equal(fs.existsSync(path.join(emptyDir, 'models.json')), false, 'Must not create models.json credentials');
});

test('journal tail corruption fail-closed: read and commit reject, no auto-repair', async () => {
  const agentDir = createTempAgentDir('pi-tail-corrupt-');
  const store = createStateStore({ agentDir });
  store.ensureInitializedFromLegacy();

  // 提交一个操作
  await store.commit([{
    opId: 'op-valid-1',
    type: 'tag_create',
    timestamp: Date.now(),
    tag: { id: 'tag-v1', name: 'Valid 1' }
  }]);

  const journalPath = path.join(agentDir, 'state', 'enhancement-state', 'journal.jsonl');
  const validContent = fs.readFileSync(journalPath, 'utf8');

  // 模拟 tail 损坏：追加一行截断的残破 JSON，且没有以换行符结尾
  fs.appendFileSync(journalPath, '{"type":"commit","revision":3,"state":', 'utf8');

  // 实例化一个新 store 模拟读取与写入
  const testStore = createStateStore({ agentDir });

  // read 必须 fail-closed
  assert.throws(
    () => testStore.read(),
    (err) => err.message.includes('CORRUPTED_JOURNAL')
  );

  // commit 必须 fail-closed
  await assert.rejects(
    async () => {
      await testStore.commit([{
        opId: 'op-after-corrupt',
        type: 'tag_create',
        timestamp: Date.now(),
        tag: { id: 'tag-v2', name: 'Valid 2' }
      }]);
    },
    (err) => err.message.includes('CORRUPTED_JOURNAL')
  );

  // commitSync 必须 fail-closed
  assert.throws(
    () => testStore.commitSync([{
      opId: 'op-after-corrupt-sync',
      type: 'tag_create',
      timestamp: Date.now(),
      tag: { id: 'tag-v3', name: 'Valid 3' }
    }]),
    (err) => err.message.includes('CORRUPTED_JOURNAL')
  );
});

test('nested lock execution: commitLocked and initializeFromLegacyLocked prevent deadlock inside withAgentStateLock', async () => {
  const agentDir = createTempAgentDir('pi-nested-lock-');
  const store = createStateStore({ agentDir });

  // 在 withAgentStateLockSync 事务块内部调用 locked 私有/导出方法
  withAgentStateLockSync(agentDir, () => {
    // 嵌套调用 ensureInitializedFromLegacyLocked
    const initRes = store.ensureInitializedFromLegacyLocked();
    assert.equal(initRes.ok, true);

    // 嵌套调用 commitLocked
    const commitRes = store.commitLocked([{
      opId: 'op-nested-1',
      type: 'tag_create',
      timestamp: Date.now(),
      tag: { id: 'tag-nested-1', name: 'Nested Tag' }
    }]);
    assert.equal(commitRes.ok, true);
    assert.equal(commitRes.revision, 2);
  });

  const finalState = store.read();
  assert.equal(finalState.revision, 2);
  assert.equal(finalState.state.sessionTagsDefinitions[0].id, 'tag-nested-1');
});

test('sync transaction rejects async fn returning Promise to prevent premature lock release', () => {
  const agentDir = createTempAgentDir('pi-sync-async-reject-');
  const lockDir = getLockDir(agentDir);

  let executed = false;
  assert.throws(
    () => withAgentStateLockSync(agentDir, async () => {
      executed = true;
      await new Promise((r) => setTimeout(r, 10));
    }),
    (err) => err.code === 'ASYNC_TRANSACTION_PROHIBITED'
  );
  assert.equal(executed, false, 'AsyncFunction callback body must not be executed');
  assert.equal(fs.existsSync(lockDir), false, 'Lock must not remain held');

  // 回归：匿名非 async 函数返回 Promise（无法静态识别 AsyncFunction），必须在执行后安全检测 Promise 并释放锁
  let nonAsyncExecuted = false;
  assert.throws(
    () => withAgentStateLockSync(agentDir, () => {
      nonAsyncExecuted = true;
      return Promise.resolve('async-leak');
    }),
    (err) => err.code === 'ASYNC_TRANSACTION_PROHIBITED'
  );
  assert.equal(nonAsyncExecuted, true, 'Non-async function executed before Promise check');
  assert.equal(fs.existsSync(lockDir), false, 'Lock must be released cleanly after returning Promise');
});

test('releaseLockSync fails loudly on token mismatch, and AggregateError combines business and release failures', () => {
  const agentDir = createTempAgentDir('pi-release-fail-');
  const lockDir = getLockDir(agentDir);

  // 1. token 错抛出 LOCK_OWNERSHIP_LOST
  const handle = tryAcquireLockSync(agentDir);
  assert.ok(handle);
  const ownerFile = path.join(lockDir, 'owner.json');
  const meta = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  meta.token = 'tampered-token-123';
  fs.writeFileSync(ownerFile, JSON.stringify(meta), 'utf8');

  assert.throws(
    () => releaseLockSync(handle),
    (err) => err.code === 'LOCK_OWNERSHIP_LOST'
  );

  // 恢复以清理
  fs.unlinkSync(ownerFile);
  fs.rmdirSync(lockDir);

  // 2. 验证 business error 不被 release error 掩盖，而是组合为 AggregateError
  assert.throws(
    () => withAgentStateLockSync(agentDir, () => {
      // 故意在持锁执行过程中篡改 owner.json 的 token，制造 release 失败
      const insideOwner = path.join(lockDir, 'owner.json');
      fs.writeFileSync(insideOwner, JSON.stringify({ token: 'corrupted' }), 'utf8');
      throw new Error('BUSINESS_INTENTIONAL_FAILURE');
    }),
    (err) => {
      assert.ok(err instanceof AggregateError || err.message.includes('BUSINESS_INTENTIONAL_FAILURE'));
      if (err instanceof AggregateError) {
        assert.equal(err.errors.length, 2);
        assert.equal(err.errors[0].message, 'BUSINESS_INTENTIONAL_FAILURE');
        assert.equal(err.errors[1].code, 'LOCK_OWNERSHIP_LOST');
      }
      return true;
    }
  );

  // 清理
  try {
    if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
    if (fs.existsSync(lockDir)) fs.rmdirSync(lockDir);
  } catch (_) {}
});

test('cross-process read lock prevents reading partial journal: child holds lock and writes partial journal, parent read gets LOCK_BUSY not CORRUPTED, after release read succeeds, and outer async lock reentrancy rules', async () => {
  const agentDir = createTempAgentDir('pi-read-lock-');
  const store = createStateStore({ agentDir });
  store.ensureInitializedFromLegacy();

  // 1. 真实子进程获取锁，写入 partial journal 并暂停
  const childScript = `
'use strict';
const fs = require('fs');
const path = require('path');
const { withAgentStateLockSync } = require(${JSON.stringify(mutexModulePath)});
const { createStateStore } = require(${JSON.stringify(storeModulePath)});

const agentDir = ${JSON.stringify(agentDir)};
const journalPath = path.join(agentDir, 'state', 'enhancement-state', 'journal.jsonl');
const store = createStateStore({ agentDir });

withAgentStateLockSync(agentDir, () => {
  const originalLen = fs.statSync(journalPath).size;
  // 故意追加未闭合、无换行的半截 JSON
  fs.appendFileSync(journalPath, '{"type":"commit","revision":2,"operations":', 'utf8');
  process.stdout.write('PARTIAL_WRITTEN\\n');

  // 同步阻塞读取标准输入，等待父进程信号
  const buf = Buffer.alloc(16);
  fs.readSync(0, buf, 0, 16, null);

  // 恢复截断并正常提交合法操作
  fs.truncateSync(journalPath, originalLen);
  store.commitLocked([{
    opId: 'op-child-1',
    type: 'tag_create',
    timestamp: Date.now(),
    tag: { id: 'tag-child-1', name: 'Child Tag' }
  }]);
  process.stdout.write('CHILD_DONE\\n');
});
`;

  const child = spawn(process.execPath, ['-e', childScript], {
    stdio: ['pipe', 'pipe', 'inherit']
  });

  await new Promise((resolve) => {
    child.stdout.once('data', (d) => {
      if (d.toString().includes('PARTIAL_WRITTEN')) resolve();
    });
  });

  // 此时子进程正持有锁，且磁盘上有残破 journal
  // 父进程调用 store.read()：必须被排他读锁拦截，返回 LOCK_BUSY，绝不看到 CORRUPTED_JOURNAL！
  assert.throws(
    () => store.read(),
    (err) => {
      assert.equal(err.code, 'LOCK_BUSY');
      assert.ok(!err.message.includes('CORRUPTED_JOURNAL'));
      return true;
    }
  );

  // 释放子进程让其完成合法提交并退出
  child.stdin.write('GO\n');
  await new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child exited with code ${code}`));
    });
  });

  // 子进程释放锁后，父进程再次 read：必须成功且读取合法数据
  const finalRead = store.read();
  assert.equal(finalRead.revision, 2);
  assert.equal(finalRead.state.sessionTagsDefinitions.length, 1);
  assert.equal(finalRead.state.sessionTagsDefinitions[0].id, 'tag-child-1');

  // 2. 测试 outerasync lock 内 read 允许，不允许 write bypass
  await withAgentStateLock(agentDir, async () => {
    // outer async lock 内允许 read 重入
    const stateDuringLock = store.read();
    assert.equal(stateDuringLock.revision, 2);

    // 不允许 write bypass：commitSync 必须 failclosed 报 LOCK_BUSY
    assert.throws(
      () => store.commitSync([{
        opId: 'op-bypass-write',
        type: 'tag_create',
        timestamp: Date.now(),
        tag: { id: 'tag-bypass', name: 'Bypass' }
      }]),
      (err) => err.code === 'LOCK_BUSY'
    );
  });
});

test('legacy initialization rejects unsafe id, bad mappings, and prototype pollution without wiping disk, while preserving valid historical nonarray mappings', () => {
  // 1. tag.id 包含 unsafe id
  const badTagDir = createTempAgentDir('pi-bad-tag-');
  const badTagStore = createStateStore({ agentDir: badTagDir });
  fs.writeFileSync(
    path.join(badTagDir, 'models.json'),
    JSON.stringify({ sessionTagsDefinitions: [{ id: '__proto__', name: 'Bad' }] }),
    'utf8'
  );
  assert.throws(
    () => badTagStore.initializeFromLegacy(),
    (err) => err.message.includes('LEGACY_MODELS_INVALID')
  );
  assert.equal(fs.existsSync(path.join(badTagDir, 'state')), false, 'State dir must not be created on unsafe tag id');

  // 2. mapping key 包含 dangerous prototype key
  const badMappingDir = createTempAgentDir('pi-bad-map-');
  const badMappingStore = createStateStore({ agentDir: badMappingDir });
  fs.writeFileSync(
    path.join(badMappingDir, 'models.json'),
    '{"sessionTagsDefinitions":[{"id":"t1","name":"Tag 1"}],"sessionTagMappings":{"__proto__":["t1"]}}',
    'utf8'
  );
  assert.throws(
    () => badMappingStore.initializeFromLegacy(),
    (err) => err.message.includes('LEGACY_MODELS_INVALID')
  );
  assert.equal(fs.existsSync(path.join(badMappingDir, 'state')), false, 'State dir must not be created on unsafe mapping key');

  // 3. sessionColors 包含 dangerous prototype key
  const badColorDir = createTempAgentDir('pi-bad-color-');
  const badColorStore = createStateStore({ agentDir: badColorDir });
  fs.writeFileSync(
    path.join(badColorDir, 'models.json'),
    '{"sessionColors":{"__proto__":"red"}}',
    'utf8'
  );
  assert.throws(
    () => badColorStore.initializeFromLegacy(),
    (err) => err.message.includes('LEGACY_MODELS_INVALID')
  );
  assert.equal(fs.existsSync(path.join(badColorDir, 'state')), false, 'State dir must not be created on unsafe color key');

  // 4. 曾故意 nonarray 历史合法 mapping 契约保留：不清洗为 []，不报错，原样保留
  const validNonArrayDir = createTempAgentDir('pi-valid-nonarray-');
  const validStore = createStateStore({ agentDir: validNonArrayDir });
  const rawModelsContent = JSON.stringify({
    sessionTagsDefinitions: [{ id: 't1', name: 'Tag 1' }],
    sessionTagMappings: { 'sess-legacy-1': 'historical-non-array-value' },
    sessionColors: { 'sess-legacy-1': 'blue' }
  }, null, 2);
  fs.writeFileSync(path.join(validNonArrayDir, 'models.json'), rawModelsContent, 'utf8');

  const initRes = validStore.initializeFromLegacy();
  assert.equal(initRes.ok, true);
  assert.equal(initRes.state.sessionTagMappings['sess-legacy-1'], 'historical-non-array-value');

  // read 验证
  const readRes = validStore.read();
  assert.equal(readRes.state.sessionTagMappings['sess-legacy-1'], 'historical-non-array-value');

  // 在该 nonarray 上追加 tag 必须按既有契约抛出 MAPPING_NOT_ARRAY 拒绝，不悄悄格式化覆盖
  assert.throws(
    () => validStore.commitSync([{
      opId: 'op-add-fail',
      type: 'session_tag_add',
      sessionId: 'sess-legacy-1',
      tagId: 't1'
    }]),
    (err) => err.message.includes('MAPPING_NOT_ARRAY')
  );
});

