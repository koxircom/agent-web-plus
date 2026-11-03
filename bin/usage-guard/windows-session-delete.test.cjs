"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const child_process = require("node:child_process");

const hostPlatform = process.platform;

const targetBinDir = process.env.PI_USAGE_GUARD_TARGET_DIR
  ? path.resolve(process.env.PI_USAGE_GUARD_TARGET_DIR)
  : path.resolve(__dirname);

const sealWorkerScript = path.join(targetBinDir, "pi-usage-seal-worker.cjs");
const { atomicWrite, generateUsageLedger } = require(path.join(targetBinDir, "generate-usage-ledger.js"));
const {
  acquireUsageLock,
  releaseUsageLock,
} = require(path.join(targetBinDir, "usage-storage-paths.cjs"));

function createSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-del-test-"));
  const sessionsDir = path.join(base, "sessions");
  const dataDir = path.join(base, "data");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const prevEnv = process.env.PI_USAGE_DATA_DIR;
  // 建立存储目录合法结构
  const markerPath = path.join(dataDir, ".pi-usage-storage.json");
  fs.writeFileSync(markerPath, JSON.stringify({ version: 1, instance: "nas" }), "utf8");
  const emptyState = JSON.stringify({ version: 2, events: {}, sessions: {}, sources: {} });
  fs.writeFileSync(path.join(dataDir, "pi-usage-events-nas.json"), emptyState, "utf8");
  for (const f of [
    "pi-usage-ledger-nas.json",
    "pi-usage-ledger.json",
    "pi-usage-frozen-history.json",
  ]) {
    fs.writeFileSync(path.join(dataDir, f), "{}", "utf8");
  }
  process.env.PI_USAGE_DATA_DIR = dataDir;

  return {
    base,
    sessionsDir,
    dataDir,
    cleanup: () => {
      if (prevEnv !== undefined) {
        process.env.PI_USAGE_DATA_DIR = prevEnv;
      } else {
        delete process.env.PI_USAGE_DATA_DIR;
      }
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch (_) {}
    },
  };
}

function createWorkerHookScript(hookPath) {
  const code = `
"use strict";
const fs = require("node:fs");
const origOpenSync = fs.openSync;
const origCloseSync = fs.closeSync;
const origUnlinkSync = fs.unlinkSync;
const origFstatSync = fs.fstatSync;

const events = [];
const trackedLockFds = new Set();

fs.openSync = function (p, flags, mode) {
  const fd = origOpenSync.apply(fs, arguments);
  if (typeof p === "string" && p.includes(".lock")) {
    trackedLockFds.add(fd);
    events.push({ action: "open", fd, path: p });
  }
  return fd;
};

fs.closeSync = function (fd) {
  if (trackedLockFds.has(fd)) {
    let statBefore = null;
    try {
      statBefore = origFstatSync(fd);
    } catch (_) {}
    origCloseSync.apply(fs, arguments);
    let closedPhysically = false;
    try {
      origFstatSync(fd);
    } catch (err) {
      if (err.code === "EBADF") closedPhysically = true;
    }
    events.push({
      action: "close",
      fd,
      hadStatBefore: Boolean(statBefore && statBefore.isFile()),
      closedPhysically,
    });
    return;
  }
  return origCloseSync.apply(fs, arguments);
};

fs.unlinkSync = function (p) {
  if (typeof p === "string" && p.includes(".lock")) {
    events.push({ action: "unlink", path: p });
  }
  return origUnlinkSync.apply(fs, arguments);
};

process.on("exit", () => {
  const traceFile = process.env.PI_TEST_LOCK_TRACE_FILE;
  if (traceFile) {
    try {
      fs.writeFileSync(traceFile, JSON.stringify(events), "utf8");
    } catch (_) {}
  }
});
`;
  fs.writeFileSync(hookPath, code, "utf8");
}

test("pi-usage-seal-worker handles chunked stdin, large payload, UTF-8 across chunks and no trailing newline", async () => {
  const sb = createSandbox();
  try {
    const chineseTitle = "会话标题：Windows 会话删除可靠性修复测试 🚀 包含多字节字符与大Payload";
    // 构造有效 payload，targets 为空以验证 stdin 读取与解析闭环
    const payload = {
      version: 1,
      sessionsRoot: sb.sessionsDir,
      targets: [],
      notes: "A".repeat(128 * 1024) + " " + chineseTitle,
    };
    const jsonStr = JSON.stringify(payload); // 故意无结尾换行
    const buffer = Buffer.from(jsonStr, "utf8");

    const child = child_process.spawn(process.execPath, [sealWorkerScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutData = "";
    let stderrData = "";
    child.stdout.on("data", chunk => { stdoutData += chunk; });
    child.stderr.on("data", chunk => { stderrData += chunk; });

    // 分成极小块（64 字节）流式写入，模拟 TCP/管道 chunk 拆分与多字节 UTF-8 跨 chunk 边界
    const chunkSize = 64;
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const slice = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
      child.stdin.write(slice);
    }
    child.stdin.end();

    const exitCode = await new Promise(resolve => child.on("close", resolve));
    assert.equal(exitCode, 0, `Worker should exit with 0, stderr: ${stderrData}`);

    const res = JSON.parse(stdoutData.trim());
    assert.equal(res.ok, true, "Worker should output ok: true");
    assert.equal(res.version, 1, "Worker should output version: 1");
    assert.deepEqual(res.targets, {}, "Targets should be empty object");
  } finally {
    sb.cleanup();
  }
});

test("pi-usage-seal-worker rejects malformed / truncated stdin JSON cleanly", async () => {
  const child = child_process.spawn(process.execPath, [sealWorkerScript], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrData = "";
  child.stderr.on("data", chunk => { stderrData += chunk; });

  child.stdin.write('{"truncated": true');
  child.stdin.end();

  const exitCode = await new Promise(resolve => child.on("close", resolve));
  assert.equal(exitCode, 1, "Worker should exit with 1 on invalid JSON");
  assert.match(stderrData, /Invalid JSON input/);
});

test("atomicWrite skips directory fsync on Windows while preserving file fsync and rename", () => {
  const sb = createSandbox();
  try {
    const targetFile = path.join(sb.dataDir, "test-atomic.json");
    const testData = { message: "windows session delete atomic write", count: 42 };

    const originalPlatform = process.platform;
    let dirFsyncAttempted = false;
    let fileFsyncAttempted = false;
    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;

    try {
      // Mock win32 platform
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      // 劫持 fs.openSync 检测是否有对 dir 打开的读句柄（用于目录 fsync）
      fs.openSync = function (p, flags, mode) {
        if (p === sb.dataDir && flags === "r") {
          dirFsyncAttempted = true;
        }
        return originalOpenSync.call(fs, p, flags, mode);
      };

      fs.fsyncSync = function (fd) {
        fileFsyncAttempted = true;
        return originalFsyncSync.call(fs, fd);
      };

      atomicWrite(targetFile, testData);

      assert.equal(fileFsyncAttempted, true, "File fsync must be executed on temporary file");
      assert.equal(dirFsyncAttempted, false, "On Windows (win32), directory fsync should be skipped");
      assert.ok(fs.existsSync(targetFile), "Target file must exist after atomicWrite");
      const readBack = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      assert.deepEqual(readBack, testData, "Written content must match expected data");
    } finally {
      fs.openSync = originalOpenSync;
      fs.fsyncSync = originalFsyncSync;
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  } finally {
    sb.cleanup();
  }
});

test("atomicWrite on Linux / non-win32 retains directory fsync semantics", (t) => {
  if (hostPlatform === "win32") {
    t.skip("Directory fsync on Linux can only be genuinely tested on non-win32 host platforms");
    return;
  }
  const sb = createSandbox();
  try {
    const targetFile = path.join(sb.dataDir, "test-linux.json");
    const testData = { platform: "linux", safe: true };

    const originalPlatform = process.platform;
    let dirOpenedForFsync = false;
    const originalOpenSync = fs.openSync;

    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      fs.openSync = function (p, flags, mode) {
        if (p === sb.dataDir && flags === "r") {
          dirOpenedForFsync = true;
        }
        return originalOpenSync.call(fs, p, flags, mode);
      };

      atomicWrite(targetFile, testData);

      assert.equal(dirOpenedForFsync, true, "On Linux, directory open for fsync should occur");
      assert.ok(fs.existsSync(targetFile), "Target file must exist");
      const readBack = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      assert.deepEqual(readBack, testData);
    } finally {
      fs.openSync = originalOpenSync;
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  } finally {
    sb.cleanup();
  }
});

test("atomicWrite propagates real file write, fsync, and rename errors", () => {
  const sb = createSandbox();
  try {
    const targetFile = path.join(sb.dataDir, "test-fail.json");
    const testData = { error: "must throw" };
    const originalPlatform = process.platform;

    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      // 1. 真实 write 错误传播
      const originalWriteFileSync = fs.writeFileSync;
      try {
        fs.writeFileSync = () => {
          const err = new Error("ENOSPC: no space left on device, write");
          err.code = "ENOSPC";
          throw err;
        };
        assert.throws(
          () => atomicWrite(targetFile, testData),
          /ENOSPC/,
          "atomicWrite must propagate real write errors"
        );
      } finally {
        fs.writeFileSync = originalWriteFileSync;
      }
      assert.equal(
        fs.readdirSync(sb.dataDir).filter(f => f.endsWith(".tmp")).length,
        0,
        "Temporary files must be cleaned up on write failure"
      );

      // 2. 真实 fsync 错误传播
      const originalFsyncSync = fs.fsyncSync;
      try {
        fs.fsyncSync = () => {
          const err = new Error("EIO: i/o error, fsync");
          err.code = "EIO";
          throw err;
        };
        assert.throws(
          () => atomicWrite(targetFile, testData),
          /EIO/,
          "atomicWrite must propagate real fsync errors"
        );
      } finally {
        fs.fsyncSync = originalFsyncSync;
      }
      assert.equal(
        fs.readdirSync(sb.dataDir).filter(f => f.endsWith(".tmp")).length,
        0,
        "Temporary files must be cleaned up on fsync failure"
      );

      // 3. 真实 rename 错误传播
      const originalRenameSync = fs.renameSync;
      try {
        fs.renameSync = () => {
          const err = new Error("EACCES: permission denied, rename");
          err.code = "EACCES";
          throw err;
        };
        assert.throws(
          () => atomicWrite(targetFile, testData),
          /EACCES/,
          "atomicWrite must propagate real rename errors"
        );
      } finally {
        fs.renameSync = originalRenameSync;
      }
      assert.equal(
        fs.readdirSync(sb.dataDir).filter(f => f.endsWith(".tmp")).length,
        0,
        "Temporary files must be cleaned up on rename failure"
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  } finally {
    sb.cleanup();
  }
});

test("usage lock file descriptor is physically closed upon releaseUsageLock", () => {
  const sb = createSandbox();
  try {
    const lockFile = path.join(sb.dataDir, "test.lock");
    const fd = acquireUsageLock(lockFile);
    assert.ok(typeof fd === "number" && fd > 0, "acquireUsageLock should return a valid fd");

    // fd 此时应可正常 fstat
    const statBefore = fs.fstatSync(fd);
    assert.ok(statBefore.isFile(), "fd should reference a regular file");

    // 释放锁并传入 fd
    releaseUsageLock(lockFile, fd);

    // 验证 fd 已被实际关闭（继续 fstatSync 应报 EBADF）
    assert.throws(
      () => fs.fstatSync(fd),
      /EBADF/,
      "File descriptor must be closed after releaseUsageLock"
    );

    assert.equal(fs.existsSync(lockFile), false, "Lock file must be unlinked");
  } finally {
    sb.cleanup();
  }
});

test("generateUsageLedger properly releases and closes lock fd on both success and error", async () => {
  const sb = createSandbox();
  try {
    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");

    function runWithLockSpy(fn) {
      const origOpenSync = fs.openSync;
      const origCloseSync = fs.closeSync;
      const origUnlinkSync = fs.unlinkSync;
      const origFstatSync = fs.fstatSync;

      const events = [];
      const trackedLockFds = new Set();

      fs.openSync = function (p, flags, mode) {
        const fd = origOpenSync.apply(fs, arguments);
        if (typeof p === "string" && p.includes(".lock")) {
          trackedLockFds.add(fd);
          events.push({ action: "open", fd, path: p });
        }
        return fd;
      };

      fs.closeSync = function (fd) {
        if (trackedLockFds.has(fd)) {
          let statBefore = null;
          try {
            statBefore = origFstatSync(fd);
          } catch (_) {}
          origCloseSync.apply(fs, arguments);
          let closedPhysically = false;
          try {
            origFstatSync(fd);
          } catch (err) {
            if (err.code === "EBADF") closedPhysically = true;
          }
          events.push({
            action: "close",
            fd,
            hadStatBefore: Boolean(statBefore && statBefore.isFile()),
            closedPhysically,
          });
          return;
        }
        return origCloseSync.apply(fs, arguments);
      };

      fs.unlinkSync = function (p) {
        if (typeof p === "string" && p.includes(".lock")) {
          events.push({ action: "unlink", path: p });
        }
        return origUnlinkSync.apply(fs, arguments);
      };

      return Promise.resolve()
        .then(() => fn())
        .finally(() => {
          fs.openSync = origOpenSync;
          fs.closeSync = origCloseSync;
          fs.unlinkSync = origUnlinkSync;
        })
        .then(
          result => ({ ok: true, result, events }),
          error => ({ ok: false, error, events })
        );
    }

    // 1. 只读模式验证：scan 阶段不持写锁
    const readonlyOutcome = await runWithLockSpy(async () => {
      return generateUsageLedger({
        sessionsRoot: sb.sessionsDir,
        colleagueSessionsRoot: null,
        dataDir: sb.dataDir,
        write: false,
      });
    });

    assert.equal(readonlyOutcome.ok, true, "generateUsageLedger should succeed on empty sessions in readonly mode");
    const roOpen = readonlyOutcome.events.find(e => e.action === "open");
    assert.equal(roOpen, undefined, "Scan in readonly mode must not acquire write lock");

    // 2. 正常写模式验证：commit 阶段持写锁并在完成时物理关闭 fd 并 unlink
    const writeOutcome = await runWithLockSpy(async () => {
      return generateUsageLedger({
        sessionsRoot: sb.sessionsDir,
        colleagueSessionsRoot: null,
        dataDir: sb.dataDir,
      });
    });

    assert.equal(writeOutcome.ok, true, "generateUsageLedger should succeed in write mode");
    const writeTrace = writeOutcome.events;
    const succOpen = writeTrace.find(e => e.action === "open");
    assert.ok(succOpen, "Lock fd must be opened during commit in write mode");
    const succClose = writeTrace.find(e => e.action === "close" && e.fd === succOpen.fd);
    assert.ok(succClose, "Lock fd must be closed on ledger success");
    assert.equal(succClose.closedPhysically, true, "Lock fd must be physically closed on ledger success");
    const succUnlink = writeTrace.find(e => e.action === "unlink");
    assert.ok(succUnlink, "Lock file must be unlinked on ledger success");
    assert.ok(
      writeTrace.indexOf(succClose) < writeTrace.indexOf(succUnlink),
      "Close must precede unlink on ledger success"
    );
    assert.equal(fs.existsSync(lockFile), false, "Lock file must not remain after successful ledger run");

    // 3. scan 抛错场景验证：锁外扫描抛错，不曾持锁，也不会泄露锁
    const malformedFile = path.join(sb.sessionsDir, "malformed-session.jsonl");
    fs.writeFileSync(
      malformedFile,
      JSON.stringify({ type: "session", id: "sess-scan-error" }) + "\n" +
      "{\"invalid-json-line-causing-malformed-error\n" +
      JSON.stringify({ type: "message", id: "msg-after" }) + "\n",
      "utf8"
    );

    const errorOutcome = await runWithLockSpy(async () => {
      return generateUsageLedger({
        sessionsRoot: sb.sessionsDir,
        colleagueSessionsRoot: null,
        dataDir: sb.dataDir,
      });
    });

    assert.equal(errorOutcome.ok, false, "generateUsageLedger must throw when session scan fails");
    assert.match(errorOutcome.error.message, /malformed JSON/);
    const errorTrace = errorOutcome.events;
    const errOpen = errorTrace.find(e => e.action === "open");
    assert.equal(errOpen, undefined, "When scan throws outside lock, write lock must not have been acquired");
    assert.equal(fs.existsSync(lockFile), false, "Lock file must not exist when scan throws");
  } finally {
    sb.cleanup();
  }
});

test("实际 timestamp_UUID.jsonl 命名下 seal+unlink before commit availability 不可复活，且同一 session 并发 complete 与另 source 不被覆写", async () => {
  const sb = createSandbox();
  try {
    const sidA = "12345678-abcd-ef01-2345-6789abcdef01";
    const sidB = "87654321-dcba-10fe-5432-10fedcba9876";

    // 使用真实的 timestamp_UUID.jsonl 命名
    const fileA = path.join(sb.sessionsDir, `2026-04-18T10-00-00-000Z_${sidA}.jsonl`);
    const fileB = path.join(sb.sessionsDir, `2026-04-18T10-00-01-000Z_${sidB}.jsonl`);

    fs.writeFileSync(
      fileA,
      JSON.stringify({ type: "session", id: sidA, name: "Session A To Be Unlinked" }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-a-1",
        message: {
          role: "assistant",
          provider: "cliproxyapi",
          model: "gemini-3.8-flash-high",
          timestamp: 1713434400000,
          usage: { input: 100, output: 50, cost: 0.001 },
        },
      }) + "\n",
      "utf8"
    );

    fs.writeFileSync(
      fileB,
      JSON.stringify({ type: "session", id: sidB, name: "Session B Concurrent Complete" }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-b-1",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          timestamp: 1713434401000,
          usage: { input: 200, output: 80, cost: 0.002 },
        },
      }) + "\n",
      "utf8"
    );

    const origEnv = process.env.PI_USAGE_DATA_DIR;
    process.env.PI_USAGE_DATA_DIR = sb.dataDir;

    try {
      const stateFile = path.join(sb.dataDir, "pi-usage-events-nas.json");

      const res = await generateUsageLedger({
        source: "nas",
        sessionsRoot: sb.sessionsDir,
        colleagueSessionsRoot: null,
        dataDir: sb.dataDir,
        __onAfterScanOutsideLock: async () => {
          // 1. 模拟在锁外扫描完成之后、commit 获取写锁之前：
          // fileA 被 sealdelete + unlink 物理删除！
          fs.unlinkSync(fileA);

          // 2. 模拟并发写入磁盘 state：
          // - 同一 session (sidB) 被 seal-worker 写入了 complete: true 以及更好的 metadata
          // - 另一个 source (colleague) 写入了 sources.colleague
          const latestState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          latestState.sources["colleague"] = {
            scannedAt: "2026-04-18T10-05-00.000Z",
            fileCount: 5,
            audit: { assistant: 10 },
          };
          latestState.sessions[sidB] = {
            id: sidB,
            title: "Session B Concurrent Complete",
            sources: ["nas"],
            availableOn: ["nas"],
            ingestion: {
              source: "nas",
              scannedAt: "2026-04-18T10-05-00.000Z",
              complete: true,
              sealForDelete: true,
            },
          };
          fs.writeFileSync(stateFile, JSON.stringify(latestState), "utf8");
        },
      });

      const finalState = res.state;

      // 断言 1: fileA 虽在 scan 时被记录，但在 commit 时发现已被 unlink (lstat not same)，availableOn 不得复活！
      assert.ok(finalState.sessions[sidA], "Session A record exists in history");
      assert.deepEqual(
        finalState.sessions[sidA].availableOn || [],
        [],
        "Session A must NOT be available on nas after seal+unlink before commit"
      );

      // 断言 2: session B 并发的 complete: true 完整保留，不得被 candidate 冲掉
      assert.ok(finalState.sessions[sidB], "Session B record exists");
      assert.equal(
        finalState.sessions[sidB].ingestion?.complete,
        true,
        "Concurrent complete: true on session B must be preserved"
      );
      assert.equal(
        finalState.sessions[sidB].ingestion?.sealForDelete,
        true,
        "Concurrent sealForDelete flag must be preserved"
      );

      // 断言 3: 另 source (colleague) 的 sources 必须完整保留，不得被 candidateState 冲掉
      assert.ok(finalState.sources["colleague"], "Source colleague must exist");
      assert.equal(
        finalState.sources["colleague"].scannedAt,
        "2026-04-18T10-05-00.000Z",
        "Source colleague data must NOT be overwritten by candidateState"
      );
      assert.ok(finalState.sources["nas"], "Source nas must also be updated");
    } finally {
      process.env.PI_USAGE_DATA_DIR = origEnv;
    }
  } finally {
    sb.cleanup();
  }
});

test("pi-usage-seal-worker closes lock fd and unlinks in order on success", async () => {
  const sb = createSandbox();
  try {
    const sessionFile = path.join(sb.sessionsDir, "valid-sess.jsonl");
    const validLines = [
      JSON.stringify({ type: "session", id: "sess-success", name: "Valid Session" }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "completed task" }],
          stopReason: "stop",
        },
      }),
    ];
    fs.writeFileSync(sessionFile, validLines.join("\n") + "\n", "utf8");

    const hookScript = path.join(sb.base, "worker-success-hook.cjs");
    const traceFile = path.join(sb.base, "trace-success.json");
    createWorkerHookScript(hookScript);

    const payload = {
      version: 1,
      sessionsRoot: sb.sessionsDir,
      dataDir: sb.dataDir,
      targets: [{ sessionId: "sess-success", path: sessionFile }],
    };

    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");

    const child = child_process.spawn(process.execPath, ["-r", hookScript, sealWorkerScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_USAGE_DATA_DIR: sb.dataDir,
        PI_TEST_LOCK_TRACE_FILE: traceFile,
      },
    });

    let stdoutData = "";
    let stderrData = "";
    child.stdout.on("data", chunk => { stdoutData += chunk; });
    child.stderr.on("data", chunk => { stderrData += chunk; });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    const exitCode = await new Promise(resolve => child.on("close", resolve));
    assert.equal(exitCode, 0, `Worker should exit with 0, stderr: ${stderrData}`);

    const res = JSON.parse(stdoutData.trim());
    assert.equal(res.ok, true, "Worker should output ok: true");
    assert.ok(res.targets && res.targets["sess-success"], "Target session must be sealed");

    assert.ok(fs.existsSync(traceFile), "Trace file must be generated by preload hook");
    const trace = JSON.parse(fs.readFileSync(traceFile, "utf8"));

    const openEvent = trace.find(e => e.action === "open");
    assert.ok(openEvent, "Lock file must be opened");
    assert.ok(typeof openEvent.fd === "number" && openEvent.fd > 0, "Valid lock fd must be acquired");

    const closeEvent = trace.find(e => e.action === "close" && e.fd === openEvent.fd);
    assert.ok(closeEvent, "Lock fd must be closed via closeSync");
    assert.equal(closeEvent.hadStatBefore, true, "Lock fd must be a valid file before close");
    assert.equal(closeEvent.closedPhysically, true, "Lock fd must report EBADF after closeSync");

    const unlinkEvent = trace.find(e => e.action === "unlink");
    assert.ok(unlinkEvent, "Lock file must be unlinked");

    const closeIdx = trace.indexOf(closeEvent);
    const unlinkIdx = trace.indexOf(unlinkEvent);
    assert.ok(closeIdx < unlinkIdx, "Lock fd close must strictly precede unlink");

    assert.equal(fs.existsSync(lockFile), false, "Lock file must be unlinked from disk");
  } finally {
    sb.cleanup();
  }
});

test("pi-usage-seal-worker closes lock fd even when seal fails midway after acquiring lock", async () => {
  const sb = createSandbox();
  try {
    // 构造真实输入：首行合法 session header，最后一行截断导致 ingestion incomplete
    const sessionFile = path.join(sb.sessionsDir, "trunc-sess.jsonl");
    const validHeader = JSON.stringify({ type: "session", id: "sess-midway-fail", name: "Midway Fail Session" }) + "\n";
    const truncatedLastLine = '{"type":"message","id":"msg-midway","incomplete":';
    fs.writeFileSync(sessionFile, validHeader + truncatedLastLine, "utf8");

    const hookScript = path.join(sb.base, "worker-fail-hook.cjs");
    const traceFile = path.join(sb.base, "trace-fail.json");
    createWorkerHookScript(hookScript);

    const payload = {
      version: 1,
      sessionsRoot: sb.sessionsDir,
      dataDir: sb.dataDir,
      targets: [{ sessionId: "sess-midway-fail", path: sessionFile }],
    };

    const lockFile = path.join(sb.dataDir, "pi-usage-events-nas.json.lock");

    const child = child_process.spawn(process.execPath, ["-r", hookScript, sealWorkerScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_USAGE_DATA_DIR: sb.dataDir,
        PI_TEST_LOCK_TRACE_FILE: traceFile,
      },
    });

    let stderrData = "";
    child.stderr.on("data", chunk => { stderrData += chunk; });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    const exitCode = await new Promise(resolve => child.on("close", resolve));
    assert.equal(exitCode, 1, "Worker should exit with 1 on ingestion incomplete failure");
    assert.match(stderrData, /Session ingestion incomplete/);

    assert.ok(fs.existsSync(traceFile), "Trace file must be generated by preload hook");
    const trace = JSON.parse(fs.readFileSync(traceFile, "utf8"));

    const openEvent = trace.find(e => e.action === "open");
    assert.ok(openEvent, "Lock must be acquired before scan error");
    assert.ok(typeof openEvent.fd === "number" && openEvent.fd > 0, "Valid lock fd must be acquired");

    const closeEvent = trace.find(e => e.action === "close" && e.fd === openEvent.fd);
    assert.ok(closeEvent, "Lock fd must be closed during error cleanup");
    assert.equal(closeEvent.hadStatBefore, true, "Lock fd must be a valid file before close");
    assert.equal(closeEvent.closedPhysically, true, "Lock fd must report EBADF after closeSync");

    const unlinkEvent = trace.find(e => e.action === "unlink");
    assert.ok(unlinkEvent, "Lock file must be unlinked during error cleanup");

    const closeIdx = trace.indexOf(closeEvent);
    const unlinkIdx = trace.indexOf(unlinkEvent);
    assert.ok(closeIdx < unlinkIdx, "Lock fd close must strictly precede unlink during error cleanup");

    assert.equal(fs.existsSync(lockFile), false, "Lock file must not remain on error");
  } finally {
    sb.cleanup();
  }
});

