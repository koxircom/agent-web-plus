"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
  acquireUsageLock,
  releaseUsageLock,
  resolveUsageStorage,
} = require("./usage-storage-paths.cjs");

const {
  generateUsageLedger,
  readState,
  buildLedger,
} = require("./generate-usage-ledger.js");

function createSandbox() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-concurrency-test-"));
  const dataDir = path.join(tmpDir, "data");
  const sessionsDir = path.join(tmpDir, "sessions");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const marker = { version: 1, instance: "nas" };
  fs.writeFileSync(path.join(dataDir, ".pi-usage-storage.json"), JSON.stringify(marker), "utf8");

  const emptyState = { version: 2, events: {}, sessions: {}, sources: {} };
  fs.writeFileSync(path.join(dataDir, "pi-usage-events-nas.json"), JSON.stringify(emptyState), "utf8");
  fs.writeFileSync(path.join(dataDir, "pi-usage-ledger-nas.json"), JSON.stringify({ version: 2, totals: {}, buckets: [] }), "utf8");
  fs.writeFileSync(path.join(dataDir, "pi-usage-ledger.json"), JSON.stringify({ version: 2, totals: {}, buckets: [] }), "utf8");
  fs.writeFileSync(path.join(dataDir, "pi-usage-frozen-history.json"), JSON.stringify({}), "utf8");

  return {
    tmpDir,
    dataDir,
    sessionsDir,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    },
  };
}

test("跨 namespace 锁不偷", async () => {
  const sb = createSandbox();
  try {
    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");
    const foreignPayload = {
      pid: 999999,
      token: "foreign-namespace-token-12345",
      hostname: "foreign-container",
      host: "foreign-container",
      pidnamespace: "4026539999",
      bootid: "foreign-boot-id-001",
      startticks: 123456,
      time: Date.now() - 300000,
      startedAt: new Date(Date.now() - 300000).toISOString(),
    };
    fs.writeFileSync(lockFile, JSON.stringify(foreignPayload), "utf8");

    let threw = false;
    try {
      acquireUsageLock(lockFile, { timeoutMs: 250, retryIntervalMs: 25 });
    } catch (err) {
      threw = true;
      assert.match(err.message, /Lock acquisition timed out/);
      assert.match(err.message, /foreign-container/);
      assert.match(err.message, /4026539999/);
    }
    assert.equal(threw, true, "Must throw lock acquisition timeout when foreign lock exists");
    assert.equal(fs.existsSync(lockFile), true, "Foreign lock must not be stolen or unlinked");

    const diskContent = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(diskContent.token, "foreign-namespace-token-12345");
  } finally {
    sb.cleanup();
  }
});

test("> staleAge 活持/死持锁坚决不偷 (deadPid or overdue)", async () => {
  const sb = createSandbox();
  try {
    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");
    const stalePayload = {
      pid: 1, // pid 1 在非主容器可能死或者活，无论如何都不偷
      token: "stale-token-54321",
      hostname: os.hostname(),
      host: os.hostname(),
      time: Date.now() - 7200000, // 2 小时前
      startedAt: new Date(Date.now() - 7200000).toISOString(),
    };
    fs.writeFileSync(lockFile, JSON.stringify(stalePayload), "utf8");

    let threw = false;
    try {
      acquireUsageLock(lockFile, { timeoutMs: 250, retryIntervalMs: 25, staleAgeMs: 500 });
    } catch (err) {
      threw = true;
      assert.match(err.message, /Lock acquisition timed out/);
    }
    assert.equal(threw, true, "Must timeout without recovering lock");
    assert.equal(fs.existsSync(lockFile), true, "Lock file must remain untouched even if overdue");
  } finally {
    sb.cleanup();
  }
});

test("releaseUsageLock 仅释放本进程拥有的 token + inode 匹配凭据，不乱 close / unlink", async () => {
  const sb = createSandbox();
  try {
    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");

    // 1. 尝试用错误凭据释放不存在或属于他人的锁
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 8888, token: "other-token" }), "utf8");
    releaseUsageLock(lockFile, 99999);
    assert.equal(fs.existsSync(lockFile), true, "Foreign lock must not be unlinked on bogus fd");

    // 2. 本进程正常获取锁
    fs.unlinkSync(lockFile);
    const fd = acquireUsageLock(lockFile);
    assert.ok(typeof fd === "number" && fd > 0);
    assert.equal(fs.existsSync(lockFile), true);

    // 3. 模拟锁文件内容被外部替换（token 不匹配）
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "tampered-token" }), "utf8");
    assert.throws(
      () => releaseUsageLock(lockFile, fd),
      /Lock ownership lost/i,
      "releaseUsageLock must throw ownership lost on token mismatch"
    );
    assert.equal(fs.existsSync(lockFile), true, "Lock file with mismatched token must not be unlinked");

    // 清理测试文件
    try { fs.unlinkSync(lockFile); } catch (_) {}
  } finally {
    sb.cleanup();
  }
});

test("options.write === false 只读扫描不获取写锁", async () => {
  const sb = createSandbox();
  try {
    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 7777, token: "occupied" }), "utf8");

    const sessionA = path.join(sb.sessionsDir, "sess-ro.jsonl");
    fs.writeFileSync(
      sessionA,
      JSON.stringify({ type: "session", id: "sess-ro", name: "Readonly Session" }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-ro-1",
        message: {
          role: "assistant",
          provider: "cliproxyapi",
          model: "gemini-3.8-flash-high",
          timestamp: Date.now(),
          usage: { input: 100, output: 50, cost: 0.001 },
        },
      }) + "\n",
      "utf8"
    );

    // 在锁被占用的情况下，write: false 扫描应当无阻塞执行成功
    const origEnv = process.env.PI_USAGE_DATA_DIR;
    process.env.PI_USAGE_DATA_DIR = sb.dataDir;
    try {
      const res = await generateUsageLedger({
        source: "nas",
        sessionsRoot: sb.sessionsDir,
        colleagueSessionsRoot: null,
        write: false,
      });

      assert.ok(res.ledger, "Ledger must be generated");
      assert.equal(res.ledger.totals.totalTokens, 150);
      assert.equal(fs.existsSync(lockFile), true, "External lock must remain untouched");
    } finally {
      process.env.PI_USAGE_DATA_DIR = origEnv;
    }
  } finally {
    sb.cleanup();
  }
});

test("gated scan 阻塞期间同锁 seal child 成功 + scan commit 完整保留 seal ingestion", async () => {
  const sb = createSandbox();
  try {
    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");
    const sealWorkerScript = path.join(__dirname, "pi-usage-seal-worker.cjs");

    // 创建两个 session：sess-A 和 sess-B
    const sessAFile = path.join(sb.sessionsDir, "sess-A.jsonl");
    const sessBFile = path.join(sb.sessionsDir, "sess-B.jsonl");

    fs.writeFileSync(
      sessAFile,
      JSON.stringify({ type: "session", id: "sess-A", name: "Session A" }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-A-1",
        message: {
          role: "assistant",
          provider: "cliproxyapi",
          model: "gemini-3.8-flash-high",
          timestamp: Date.now() - 5000,
          usage: { input: 200, output: 80, cost: 0.002 },
        },
      }) + "\n",
      "utf8"
    );

    fs.writeFileSync(
      sessBFile,
      JSON.stringify({ type: "session", id: "sess-B", name: "Session B" }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-B-1",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          timestamp: Date.now() - 4000,
          usage: { input: 300, output: 120, cost: 0.005 },
        },
      }) + "\n",
      "utf8"
    );

    const origEnv = process.env.PI_USAGE_DATA_DIR;
    process.env.PI_USAGE_DATA_DIR = sb.dataDir;

    let childSealedSuccessfully = false;

    try {
      const res = await generateUsageLedger({
        source: "nas",
        sessionsRoot: sb.sessionsDir,
        colleagueSessionsRoot: null,
        write: true,
        __onAfterScanOutsideLock: async () => {
          // 此时全量扫描已在锁外完成扫描，但尚未获取 lockFile 进入 commit
          // 断言此时 lockFile 并未被占有
          assert.equal(fs.existsSync(lockFile), false, "Lock must not be held during outside file scanning");

          // 在此并发执行 seal worker 封存 sess-B
          const sealPayload = {
            source: "nas",
            sessionsRoot: sb.sessionsDir,
            targets: [{ sessionId: "sess-B", path: sessBFile }],
            sealForDelete: true,
          };

          const child = spawnSync(process.execPath, [sealWorkerScript], {
            input: JSON.stringify(sealPayload),
            encoding: "utf8",
            env: { ...process.env, PI_USAGE_DATA_DIR: sb.dataDir },
          });

          if (child.status !== 0) {
            throw new Error(`Seal child failed (${child.status}): ${child.stderr || child.stdout}`);
          }

          const childOut = JSON.parse(child.stdout);
          assert.equal(childOut.ok, true, "Seal worker must return ok: true");
          assert.ok(childOut.targets["sess-B"], "sess-B must be sealed in targets");

          // 确认 state 文件中已经包含了 complete: true
          const sealedState = readState(path.join(sb.dataDir, "pi-usage-events-nas.json"));
          assert.ok(sealedState.sessions["sess-B"]?.ingestion?.complete === true, "sess-B ingestion must be marked complete");

          childSealedSuccessfully = true;
        },
      });

      assert.equal(childSealedSuccessfully, true, "Seal child must execute during gated scan pause");
      assert.ok(res.ledger, "Ledger generation must complete");

      // 验证 commit 后的持久化结果
      const finalState = readState(path.join(sb.dataDir, "pi-usage-events-nas.json"));

      // 核心断言 1：sess-B 的 ingestion.complete === true 必须完好保留，绝不能被全量扫描覆盖冲掉
      assert.equal(
        finalState.sessions["sess-B"]?.ingestion?.complete,
        true,
        "Concurrent seal ingestion.complete must be preserved in final state"
      );

      // 核心断言 2：sess-A 和 sess-B 的 events 均被完整 union 并入
      const events = Object.values(finalState.events);
      const aEvents = events.filter(e => e.sessionId === "sess-A");
      const bEvents = events.filter(e => e.sessionId === "sess-B");
      assert.ok(aEvents.length >= 1, "Session A events must be present");
      assert.ok(bEvents.length >= 1, "Session B events must be present");

      // 核心断言 3：ledger 汇总中包含了全部 tokens
      assert.equal(res.ledger.totals.inputTokens, 500); // 200 + 300
      assert.equal(res.ledger.totals.outputTokens, 200); // 80 + 120
    } finally {
      process.env.PI_USAGE_DATA_DIR = origEnv;
    }
  } finally {
    sb.cleanup();
  }
});
