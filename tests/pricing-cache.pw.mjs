import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": root,
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
  interopDefault: true,
  moduleCache: false,
});

const {
  UsagePricingManager,
  PRICING_REFRESH_INTERVAL_MS,
  PRICING_RETRY_COOLDOWN_MS,
} = await jiti.import("../lib/usage-pricing.ts");

function createMockRuntime(models, delayMs = 0) {
  let calls = 0;
  const factory = async () => {
    calls++;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return {
      getModels: () => models,
    };
  };
  return {
    factory,
    getCalls: () => calls,
  };
}

const fixtureModels = [
  {
    id: "gpt-6.1-sol",
    provider: "openai-codex",
    cost: {
      input: 2.0,
      output: 10.0,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    },
  },
  {
    id: "gpt-6.1-luna",
    provider: "openai-codex",
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.015,
      cacheWrite: 0.15,
    },
  },
];

test("pricing 缓存真实 module stale / inflight 去重不伪造 state", async () => {
  let currentTime = 1793540000000;
  const now = () => currentTime;

  const mockRuntime = createMockRuntime(fixtureModels, 30);
  let refreshCalls = 0;
  let refreshFn = async () => {
    refreshCalls++;
    return { completed: true };
  };

  const manager = new UsagePricingManager({
    now,
    runtimeFactory: mockRuntime.factory,
    refreshFn: (opts) => refreshFn(opts),
    initialCheckedAt: currentTime,
    isOffline: () => false,
  });

  // 1. Inflight 去重测试：并发 5 次 getPricing，singleflight 只调用 1 次 runtimeFactory
  const promises = Array.from({ length: 5 }, () => manager.getPricing());
  const snapshots = await Promise.all(promises);

  assert.equal(mockRuntime.getCalls(), 1, "并发 getPricing 调用必须通过 singleflight 去重，runtimeFactory 只执行 1 次");
  for (const s of snapshots) {
    assert.equal(s.version, 1);
    assert.equal(s.currency, "USD");
    assert.equal(s.unit, "per_1m_tokens");
    assert.equal(Boolean(s.models["gpt-6.1-sol"]), true);
    assert.equal(s.models["gpt-6.1-sol"].input, 2.0);
    assert.equal(s.models["gpt-6.1-sol"].output, 10.0);
  }

  // 2. 正常缓存读取：未过期前再次调用，直接返回有效缓存
  const cachedSnapshot = await manager.getPricing();
  assert.equal(mockRuntime.getCalls(), 1, "未发生变动时必须直接命中缓存");
  assert.equal(cachedSnapshot.refresh.state, "cached");

  // 3. Stale 判定与后台刷新：时间推进超过 24 小时
  currentTime += PRICING_REFRESH_INTERVAL_MS + 1000;
  const staleSnapshot = await manager.getPricing();
  // 必须识别 stale 并触发刷新，状态变为 refreshing 或更新，不伪造静态假数据
  const refreshPromise = manager.getRunningRefreshPromise();
  assert.equal(Boolean(refreshPromise), true, "过期后必须自动触发后台刷新 singleflight");
  assert.equal(staleSnapshot.refresh.state, "refreshing");

  // 等待后台刷新完成
  await refreshPromise;
  assert.equal(refreshCalls, 1, "后台 refreshFn 必须被正确调用 1 次");

  // 4. 刷新完成后状态变为 current
  const refreshedSnapshot = await manager.getPricing();
  assert.equal(refreshedSnapshot.refresh.state, "current");

  // 5. 损坏容错测试：后续后台刷新失败时，必须保持旧价不被清空，状态标记为 error
  const successAt = refreshedSnapshot.updatedAt;
  currentTime += PRICING_REFRESH_INTERVAL_MS + 10;
  refreshFn = async () => {
    throw new Error("ETIMEDOUT: 连接上游超时");
  };

  await manager.getPricing();
  const failPromise = manager.getRunningRefreshPromise();
  if (failPromise) await failPromise;

  const afterFailure = await manager.getPricing();
  assert.equal(afterFailure.refresh.state, "error");
  assert.equal(afterFailure.updatedAt, successAt);
  assert.deepEqual(afterFailure.models, refreshedSnapshot.models);
});

