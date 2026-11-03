import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  subscribeBrowserTitle,
  isResourceFallbackError,
  getActiveHubCount,
  getHubDebugInfo,
  resetAllSubscriptionsForTesting,
} = await jiti.import("./browser-title-subscription.ts");

const {
  writeAgentWebSettings,
  readAgentWebSettings,
  AGENT_WEB_SETTINGS_FILE,
} = await jiti.import("./browser-tab-title.ts");

test.beforeEach(() => {
  resetAllSubscriptionsForTesting();
});

test.afterEach(() => {
  resetAllSubscriptionsForTesting();
});

test("isResourceFallbackError accurately classifies ENOSPC, EMFILE, ENFILE only", () => {
  assert.equal(isResourceFallbackError({ code: "ENOSPC" }), true);
  assert.equal(isResourceFallbackError({ code: "EMFILE" }), true);
  assert.equal(isResourceFallbackError({ code: "ENFILE" }), true);
  assert.equal(isResourceFallbackError({ code: "EACCES" }), false);
  assert.equal(isResourceFallbackError({ code: "ENOENT" }), false);
  assert.equal(isResourceFallbackError({ code: "EINVAL" }), false);
  assert.equal(isResourceFallbackError(new Error("random")), false);
  assert.equal(isResourceFallbackError(null), false);
});

test("read-only GET invariant: subscribe does not mkdir on nonexistent agentDir", async () => {
  const nonExistentDir = path.join(os.tmpdir(), `non-existent-agent-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assert.equal(fs.existsSync(nonExistentDir), false);

  assert.throws(
    () => {
      subscribeBrowserTitle(nonExistentDir, {
        onSnapshot: () => {},
        onError: () => {},
      });
    },
    (err) => {
      assert.match(err.message, /Settings directory unavailable/);
      return true;
    }
  );

  // 关键铁律断言：严禁 mkdir
  assert.equal(fs.existsSync(nonExistentDir), false);
});

test("unknown error fails closed without fallback and does not leak physical path", async () => {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "pi-unknown-err-test-"));
  try {
    const mockFs = {
      ...fs,
      existsSync: fs.existsSync.bind(fs),
      watch: () => {
        const err = new Error(`EACCES: permission denied, watch '${testDir}'`);
        err.code = "EACCES";
        throw err;
      },
    };

    let reportedError = null;
    assert.throws(
      () => {
        subscribeBrowserTitle(
          testDir,
          {
            onSnapshot: () => {},
            onError: (err) => {
              reportedError = err;
            },
          },
          { fsModule: mockFs }
        );
      },
      (err) => err.code === "EACCES"
    );

    // 未知错误不降级到 poll，Hub 立即清理
    assert.equal(getActiveHubCount(), 0);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("injected ENOSPC falls back to single per-dir polling, shares 1 observer across 2 subscribers, and synchronizes real write+read", async () => {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "pi-enospc-sync-test-"));
  try {
    // 注入模拟抛出 ENOSPC 的 fs.watch
    let watchCallCount = 0;
    const mockFs = {
      ...fs,
      existsSync: fs.existsSync.bind(fs),
      watch: () => {
        watchCallCount++;
        const err = new Error(`ENOSPC: System limit for number of file watchers reached, watch '${testDir}'`);
        err.code = "ENOSPC";
        throw err;
      },
    };

    const sub1Updates = [];
    const sub2Updates = [];
    const fallbacks = [];

    // 订阅者 1 加入
    const handle1 = subscribeBrowserTitle(
      testDir,
      {
        onSnapshot: (snap) => sub1Updates.push(snap),
        onError: () => {},
        onFallback: (info) => fallbacks.push({ sub: 1, ...info }),
      },
      { fsModule: mockFs, pollIntervalMs: 50, debounceMs: 10 }
    );

    // 订阅者 2 加入（共享同一个 agentDir）
    const handle2 = subscribeBrowserTitle(
      testDir,
      {
        onSnapshot: (snap) => sub2Updates.push(snap),
        onError: () => {},
        onFallback: (info) => fallbacks.push({ sub: 2, ...info }),
      },
      { fsModule: mockFs, pollIntervalMs: 50, debounceMs: 10 }
    );

    // 验证：单一每 agentDir 共享 Hub，只有 1 个 observer (单一 poll timer)，且 watch 只被尝试一次
    assert.equal(getActiveHubCount(), 1);
    assert.equal(watchCallCount, 1);
    const debug = getHubDebugInfo(testDir);
    assert.ok(debug);
    assert.equal(debug.subscriberCount, 2);
    assert.equal(debug.mode, "poll");
    assert.equal(debug.fallbackCode, "ENOSPC");
    assert.equal(debug.hasWatcher, false);
    assert.equal(debug.hasPollTimer, true);

    // 验证两者均获知 fallback 模式与 code
    assert.equal(handle1.getMode(), "poll");
    assert.equal(handle1.getFallbackCode(), "ENOSPC");
    assert.equal(handle2.getMode(), "poll");
    assert.equal(handle2.getFallbackCode(), "ENOSPC");

    // 初始快照读取
    const initSnap1 = await handle1.getInitialSnapshot();
    assert.equal(initSnap1.revision, 0);
    assert.equal(initSnap1.title, "");

    // 跨进程真实写入：模拟另一进程写入 settings 文件
    await writeAgentWebSettings({ title: "Injected ENOSPC Shared Realtime", revision: 0 }, testDir);

    // 等待 fallback 轮询生效 (50ms pollIntervalMs)
    const deadline = Date.now() + 2000;
    while (
      (!sub1Updates.some((s) => s.title === "Injected ENOSPC Shared Realtime") ||
        !sub2Updates.some((s) => s.title === "Injected ENOSPC Shared Realtime")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(sub1Updates.length >= 1, "subscriber 1 received updates");
    assert.ok(sub2Updates.length >= 1, "subscriber 2 received updates");
    const last1 = sub1Updates[sub1Updates.length - 1];
    const last2 = sub2Updates[sub2Updates.length - 1];
    assert.equal(last1.title, "Injected ENOSPC Shared Realtime");
    assert.equal(last1.revision, 1);
    assert.equal(last2.title, "Injected ENOSPC Shared Realtime");
    assert.equal(last2.revision, 1);

    // 验证 cleanup：subscriber 1 退订后，仍有 1 个 subscriber，Hub 与 pollTimer 继续保持
    handle1.unsubscribe();
    const midDebug = getHubDebugInfo(testDir);
    assert.ok(midDebug);
    assert.equal(midDebug.subscriberCount, 1);
    assert.equal(midDebug.hasPollTimer, true);

    // subscriber 2 退订后，最后订阅者关闭：0 poll handles, 0 hubs
    handle2.unsubscribe();
    assert.equal(getActiveHubCount(), 0);
    assert.equal(getHubDebugInfo(testDir), null);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("normal watch path does not initiate polling timer", async () => {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "pi-watch-no-poll-test-"));
  try {
    let watchCreated = false;
    let mockWatcher = {
      on: () => {},
      removeAllListeners: () => {},
      close: () => {},
    };
    const mockFs = {
      ...fs,
      existsSync: fs.existsSync.bind(fs),
      watch: () => {
        watchCreated = true;
        return mockWatcher;
      },
    };

    const handle = subscribeBrowserTitle(
      testDir,
      { onSnapshot: () => {}, onError: () => {} },
      { fsModule: mockFs }
    );

    assert.equal(watchCreated, true);
    assert.equal(handle.getMode(), "watch");
    const debug = getHubDebugInfo(testDir);
    assert.ok(debug);
    assert.equal(debug.mode, "watch");
    // 正常 watch 路径严禁启动轮询 timer！
    assert.equal(debug.hasPollTimer, false);
    assert.equal(debug.hasWatcher, true);

    handle.unsubscribe();
    assert.equal(getActiveHubCount(), 0);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("runtime watcher error with ENOSPC transitions dynamically from watch to poll", async () => {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "pi-runtime-error-test-"));
  try {
    let errorHandler = null;
    const mockWatcher = {
      on: (event, handler) => {
        if (event === "error") errorHandler = handler;
      },
      removeAllListeners: () => {},
      close: () => {},
    };
    const mockFs = {
      ...fs,
      existsSync: fs.existsSync.bind(fs),
      watch: () => mockWatcher,
    };

    const fallbackEvents = [];
    const handle = subscribeBrowserTitle(
      testDir,
      {
        onSnapshot: () => {},
        onError: () => {},
        onFallback: (info) => fallbackEvents.push(info),
      },
      { fsModule: mockFs, pollIntervalMs: 50 }
    );

    assert.equal(handle.getMode(), "watch");
    assert.ok(typeof errorHandler === "function");

    // 模拟运行期 watcher 发生 ENOSPC 错误
    const err = new Error("ENOSPC in runtime watcher");
    err.code = "ENOSPC";
    errorHandler(err);

    // 动态平滑降级到 poll
    const debug = getHubDebugInfo(testDir);
    assert.ok(debug);
    assert.equal(debug.mode, "poll");
    assert.equal(debug.fallbackCode, "ENOSPC");
    assert.equal(debug.hasWatcher, false);
    assert.equal(debug.hasPollTimer, true);
    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0].mode, "poll");
    assert.equal(fallbackEvents[0].code, "ENOSPC");

    handle.unsubscribe();
    assert.equal(getActiveHubCount(), 0);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
