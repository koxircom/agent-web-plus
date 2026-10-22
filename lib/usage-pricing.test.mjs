import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  UsagePricingManager,
  buildPricingModels,
  validateAndExtractCost,
  readManualOverrides,
  PRICING_REFRESH_INTERVAL_MS,
} = await jiti.import("./usage-pricing.ts");

function createMockRuntime(models) {
  return async () => ({
    getModels: () => models,
  });
}

function fixtureModels() {
  return [
    {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      cost: {
        input: 4,
        output: 20,
        cacheRead: 0.4,
        cacheWrite: 5,
        tiers: [{ inputTokensAbove: 200000, input: 8 }],
      },
    },
    {
      id: "gpt-5.6-luna",
      provider: "openai-codex",
      cost: {
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
      },
    },
    {
      id: "free-model",
      provider: "openai-codex",
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    {
      id: "corrupted-model",
      provider: "openai-codex",
      cost: {
        input: 1,
        output: -5, // 负数非法
        cacheRead: 0.1,
        cacheWrite: 0,
      },
    },
    {
      id: "incomplete-model",
      provider: "openai-codex",
      cost: {
        input: 1,
        // output 缺失，不能造 0
      },
    },
    {
      id: "claude-3-5-sonnet",
      provider: "anthropic", // 非 openai-codex，应被忽略
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    },
  ];
}

test("费率验证与非法拒收：所有4费率finite>=0，明确0允许，缺失或非法不造0", () => {
  assert.equal(validateAndExtractCost(null), null);
  assert.equal(validateAndExtractCost(undefined), null);
  assert.equal(validateAndExtractCost({}), null);
  assert.equal(validateAndExtractCost({ input: 1, output: 2 }), null);
  assert.equal(
    validateAndExtractCost({ input: 1, output: -1, cacheRead: 0, cacheWrite: 0 }),
    null,
  );
  assert.equal(
    validateAndExtractCost({ input: 1, output: NaN, cacheRead: 0, cacheWrite: 0 }),
    null,
  );

  // 明确 0 允许
  const free = validateAndExtractCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(free, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tiered: false,
  });

  // 正常阶梯
  const tiered = validateAndExtractCost({
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite: 5,
    tiers: [{ inputTokensAbove: 100000 }],
  });
  assert.deepEqual(tiered, {
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite: 5,
    tiered: true,
  });
});

test("准确型号与未知型号：准确型号完全匹配，未知型号不造0不模糊猜测", () => {
  const models = buildPricingModels(fixtureModels(), new Map());
  // 准确型号
  assert.ok(models["gpt-5.6-sol"]);
  assert.equal(models["gpt-5.6-sol"].input, 4);
  assert.equal(models["gpt-5.6-sol"].output, 20);
  assert.equal(models["gpt-5.6-sol"].cacheRead, 0.4);
  assert.equal(models["gpt-5.6-sol"].cacheWrite, 5);
  assert.equal(models["gpt-5.6-sol"].tiered, true);
  assert.equal(models["gpt-5.6-sol"].source, "pi-sdk");
  assert.equal(models["gpt-5.6-sol"].provider, "openai-codex");

  // 非 openai-codex 被忽略
  assert.equal(models["claude-3-5-sonnet"], undefined);

  // 损坏与不完整模型被拒收，不进入字典
  assert.equal(models["corrupted-model"], undefined);
  assert.equal(models["incomplete-model"], undefined);

  // 未知型号不存在，不别名匹配，不造 0
  assert.equal(models["gpt-5.6-sol-preview"], undefined);
  assert.equal(models["unknown-model"], undefined);
});

test("24h首次：冷启动立即返回存量数据，触发后台刷新，不阻塞外网", async () => {
  let currentTime = 100_000_000;
  let refreshCalls = 0;
  let resolveRefresh;
  const refreshPromise = new Promise((resolve) => {
    resolveRefresh = resolve;
  });

  const manager = new UsagePricingManager({
    now: () => currentTime,
    initialCheckedAt: null,
    runtimeFactory: createMockRuntime(fixtureModels()),
    refreshFn: async () => {
      refreshCalls++;
      await refreshPromise;
      return { completed: true, changed: false };
    },
    isOffline: () => false,
  });

  // 首次调用立刻返回，不等待 refreshPromise
  const snapshot = await manager.getPricing();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.currency, "USD");
  assert.equal(snapshot.unit, "per_1m_tokens");
  assert.equal(snapshot.refresh.state, "refreshing");
  assert.ok(snapshot.models["gpt-5.6-sol"]);
  assert.equal(refreshCalls, 1);

  // 刷新完成
  resolveRefresh();
  await manager.getRunningRefreshPromise();

  // 再次获取，状态变为 current
  const second = await manager.getPricing();
  assert.equal(second.refresh.state, "current");
  assert.equal(second.updatedAt, new Date(currentTime).toISOString());
});

test("过期：超过24h后调用读取入口触发后台刷新，返回已有旧快照并在后台更新", async () => {
  let currentTime = 100_000_000;
  let refreshCalls = 0;
  let resolveRefresh;

  const manager = new UsagePricingManager({
    now: () => currentTime,
    initialCheckedAt: null,
    runtimeFactory: createMockRuntime(fixtureModels()),
    refreshFn: async () => {
      refreshCalls++;
      await new Promise((res) => {
        resolveRefresh = res;
      });
      return { completed: true, changed: true };
    },
    isOffline: () => false,
  });

  // 首次拉取并完成
  const first = await manager.getPricing();
  resolveRefresh();
  await manager.getRunningRefreshPromise();

  const refreshedFirst = await manager.getPricing();
  assert.equal(refreshedFirst.refresh.state, "current");
  assert.equal(refreshCalls, 1);

  // 时间推进 25 小时（> 24h）
  currentTime += PRICING_REFRESH_INTERVAL_MS + 3600_000;

  // 调用触发后台刷新，立即返回
  const expiredCall = await manager.getPricing();
  assert.equal(expiredCall.refresh.state, "refreshing");
  assert.equal(refreshCalls, 2);

  // 后台完成
  resolveRefresh();
  await manager.getRunningRefreshPromise();

  const afterRefresh = await manager.getPricing();
  assert.equal(afterRefresh.refresh.state, "current");
  assert.equal(afterRefresh.updatedAt, new Date(currentTime).toISOString());
});

test("成功：后台刷新完成更新模型费率与时间戳", async () => {
  let currentTime = 100_000_000;
  let models = [
    {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    },
  ];

  const manager = new UsagePricingManager({
    now: () => currentTime,
    initialCheckedAt: null,
    runtimeFactory: async () => ({ getModels: () => models }),
    refreshFn: async () => {
      // 刷新拉取到了新价格
      models = [
        {
          id: "gpt-5.6-sol",
          provider: "openai-codex",
          cost: { input: 3.5, output: 18, cacheRead: 0.35, cacheWrite: 4.5 },
        },
      ];
      return { completed: true, changed: true };
    },
    isOffline: () => false,
  });

  await manager.getPricing();
  await manager.getRunningRefreshPromise();

  const snapshot = await manager.getPricing();
  assert.equal(snapshot.refresh.state, "current");
  assert.equal(snapshot.models["gpt-5.6-sol"].input, 3.5);
  assert.equal(snapshot.models["gpt-5.6-sol"].output, 18);
});

test("失败旧价：后台刷新失败时保持上次有效快照，标记error并附带message与attemptedAt", async () => {
  let currentTime = 100_000_000;
  let shouldFail = false;

  const manager = new UsagePricingManager({
    now: () => currentTime,
    initialCheckedAt: null,
    runtimeFactory: createMockRuntime(fixtureModels()),
    refreshFn: async () => {
      if (shouldFail) {
        throw new Error("ETIMEDOUT: 连接上游超时");
      }
      return { completed: true, changed: false };
    },
    isOffline: () => false,
  });

  // 首次成功
  await manager.getPricing();
  await manager.getRunningRefreshPromise();

  const initial = await manager.getPricing();
  assert.equal(initial.refresh.state, "current");
  const oldSolCost = initial.models["gpt-5.6-sol"];
  assert.ok(oldSolCost);

  // 推进 25 小时，下一次刷新失败
  currentTime += PRICING_REFRESH_INTERVAL_MS + 1000;
  shouldFail = true;

  await manager.getPricing();
  await manager.getRunningRefreshPromise();

  // 失败后再次检查
  const afterFailure = await manager.getPricing();
  assert.equal(afterFailure.refresh.state, "error");
  assert.equal(afterFailure.refresh.message, "ETIMEDOUT: 连接上游超时");
  assert.ok(afterFailure.refresh.attemptedAt);
  // 保持旧价，不被清空或置 0！
  assert.deepEqual(afterFailure.models["gpt-5.6-sol"], oldSolCost);
});

test("乱序单飞：高并发同时触发仅发起一次后台刷新", async () => {
  let currentTime = 100_000_000;
  let refreshCalls = 0;
  let resolveRefresh;

  const manager = new UsagePricingManager({
    now: () => currentTime,
    initialCheckedAt: null,
    runtimeFactory: createMockRuntime(fixtureModels()),
    refreshFn: async () => {
      refreshCalls++;
      await new Promise((res) => {
        resolveRefresh = res;
      });
      return { completed: true, changed: false };
    },
    isOffline: () => false,
  });

  // 并发 10 次调用
  const promises = Array.from({ length: 10 }, () => manager.getPricing());
  const results = await Promise.all(promises);

  assert.equal(refreshCalls, 1);
  for (const res of results) {
    assert.equal(res.refresh.state, "refreshing");
    assert.ok(res.models["gpt-5.6-sol"]);
  }

  resolveRefresh();
  await manager.getRunningRefreshPromise();
});

test("manual保护：models.json 中的手动配置优先，且source标为manual", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-test-"));
  const modelsJsonPath = path.join(tmpDir, "models.json");

  try {
    // 写入 manual override
    fs.writeFileSync(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "openai-codex": {
            modelOverrides: {
              "gpt-5.6-sol": {
                cost: {
                  input: 9.99,
                  output: 49.99,
                  cacheRead: 0.99,
                  cacheWrite: 9.99,
                },
              },
            },
          },
        },
      }),
    );

    const manager = new UsagePricingManager({
      runtimeFactory: async () => ModelRuntime.create({ modelsPath: modelsJsonPath }),
      modelsJsonPath,
      isOffline: () => true,
    });

    const snapshot = await manager.getPricing();
    const sol = snapshot.models["gpt-5.6-sol"];
    assert.equal(sol.source, "manual");
    assert.equal(sol.input, 9.99);
    assert.equal(sol.output, 49.99);

    // 未手动配置的保持 pi-sdk
    const luna = snapshot.models["gpt-5.6-luna"];
    assert.equal(luna.source, "pi-sdk");
    assert.equal(luna.input, 0.2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("复用 models-store checkedAt 防服务重启频繁拉取", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-test-"));
  const modelsStorePath = path.join(tmpDir, "models-store.json");
  const currentTime = 200_000_000;
  let refreshCalled = false;

  try {
    // 写入 2 小时前的 checkedAt（未满 24h）
    fs.writeFileSync(
      modelsStorePath,
      JSON.stringify({
        "openai-codex": {
          checkedAt: currentTime - 2 * 3600_000,
        },
      }),
    );

    const manager = new UsagePricingManager({
      now: () => currentTime,
      runtimeFactory: createMockRuntime(fixtureModels()),
      refreshFn: async () => {
        refreshCalled = true;
        return { completed: true, changed: false };
      },
      modelsStorePath,
      isOffline: () => false,
    });

    const snapshot = await manager.getPricing();
    assert.equal(snapshot.refresh.state, "cached");
    assert.equal(snapshot.updatedAt, null); // SDK checkedAt 仅证明曾尝试，不证明下载成功
    assert.equal(refreshCalled, false); // 未触发后台刷新
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("离线模式：PI_OFFLINE 为真时不触发刷新且状态为 offline", async () => {
  let refreshCalled = false;
  const manager = new UsagePricingManager({
    runtimeFactory: createMockRuntime(fixtureModels()),
    refreshFn: async () => {
      refreshCalled = true;
      return { completed: true, changed: false };
    },
    isOffline: () => true,
  });

  const snapshot = await manager.getPricing();
  assert.equal(snapshot.refresh.state, "offline");
  assert.equal(refreshCalled, false);
});

test("实证1：真实 SDK API 隔离测试验证 effectiveModel costs 与 builtin 一致，含 partial 与 models[].cost", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-sdk-real-"));
  const modelsJsonPath = path.join(tmpDir, "models.json");
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;

  try {
    // 写入包含 partial override（零费率 input: 0）和 models[].cost 显式覆盖的 models.json
    fs.writeFileSync(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "openai-codex": {
            modelOverrides: {
              "gpt-5.6-luna": {
                cost: {
                  input: 0, // 零费率显式指定
                },
              },
            },
            models: [
              {
                id: "gpt-6.1-sol",
                cost: {
                  input: 1.88,
                  output: 9.88,
                  cacheRead: 0.18,
                  cacheWrite: 2.18,
                },
              },
            ],
          },
        },
      }),
    );

    // 使用真实 SDK ModelRuntime.create，绝不虚构 getModels
    const manager = new UsagePricingManager({
      runtimeFactory: () => ModelRuntime.create({ modelsPath: modelsJsonPath }),
      modelsJsonPath,
      isOffline: () => true,
    });

    const snapshot = await manager.getPricing();

    // 1. 验证内置未改动模型费率与 SDK builtin 精确一致
    const sol = snapshot.models["gpt-5.6-sol"];
    assert.ok(sol);
    assert.equal(sol.input, 4);
    assert.equal(sol.output, 20);
    assert.equal(sol.cacheRead, 0.4);
    assert.equal(sol.cacheWrite, 5);
    assert.equal(sol.source, "pi-sdk");

    const astra = snapshot.models["gpt-6-astra"];
    assert.ok(astra);
    assert.equal(astra.input, 10);
    assert.equal(astra.output, 50);
    assert.equal(astra.cacheRead, 1);
    assert.equal(astra.cacheWrite, 12.5);
    assert.equal(astra.source, "pi-sdk");

    // 2. 验证 partial 零费率覆盖不丢，其余字段由 SDK 从 catalog 补齐，且 source 标为 manual
    const luna = snapshot.models["gpt-5.6-luna"];
    assert.ok(luna);
    assert.equal(luna.input, 0); // 手动 partial 零费率优先不丢
    assert.equal(luna.output, 1.2); // 由 SDK runtime 原生补齐
    assert.equal(luna.cacheRead, 0.02);
    assert.equal(luna.cacheWrite, 0.25);
    assert.equal(luna.source, "manual");

    // 3. 验证 models[].cost 覆盖生效且 source 标为 manual
    const sol61 = snapshot.models["gpt-6.1-sol"];
    assert.ok(sol61);
    assert.equal(sol61.input, 1.88);
    assert.equal(sol61.output, 9.88);
    assert.equal(sol61.source, "manual");
  } finally {
    if (prevAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    else delete process.env.PI_CODING_AGENT_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("实证2：store 单路径 mtime/checkedAt 变动无需等 24h 即可重取 runtime 成本并同步", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-store-sync-"));
  const modelsStorePath = path.join(tmpDir, "models-store.json");
  let currentTime = 100_000_000;
  let runtimeCalls = 0;

  try {
    const initialCheckedAt = currentTime - 3600_000; // 1 小时前
    fs.writeFileSync(
      modelsStorePath,
      JSON.stringify({
        "openai-codex": {
          checkedAt: initialCheckedAt,
        },
      }),
    );

    let runtimeSolInput = 4;
    const manager = new UsagePricingManager({
      now: () => currentTime,
      modelsStorePath,
      runtimeFactory: async () => {
        runtimeCalls++;
        return {
          getModels: () => [
            {
              id: "gpt-5.6-sol",
              provider: "openai-codex",
              cost: { input: runtimeSolInput, output: 20, cacheRead: 0.4, cacheWrite: 5 },
            },
          ],
        };
      },
      refreshFn: async () => {
        throw new Error("绝不应触发后台网络刷新");
      },
      isOffline: () => false,
    });

    // 首次获取
    const first = await manager.getPricing();
    assert.equal(first.models["gpt-5.6-sol"].input, 4);
    assert.equal(first.updatedAt, null);
    assert.equal(runtimeCalls, 1);

    // 用户/原生在外部刷新了目录，写回了新的 checkedAt（比当前时间只前 5 分钟），此时未满 24h
    const newCheckedAt = currentTime - 300_000;
    runtimeSolInput = 3.66; // store 变动伴随的 runtime 成本更新
    fs.writeFileSync(
      modelsStorePath,
      JSON.stringify({
        "openai-codex": {
          checkedAt: newCheckedAt,
        },
      }),
    );

    // 立即同步新费率，但外部 SDK checkedAt 不作为已证实的成功更新时间
    const second = await manager.getPricing();
    assert.equal(second.models["gpt-5.6-sol"].input, 3.66);
    assert.equal(second.updatedAt, null);
    assert.equal(runtimeCalls, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("实证3：成功 refresh 后 freshModels 为空/损坏不能清掉有效 cached 模型，失败保旧且状态 error", async () => {
  let currentTime = 100_000_000;
  let returnCorrupted = false;

  const validModels = [
    {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    },
  ];

  const manager = new UsagePricingManager({
    now: () => currentTime,
    initialCheckedAt: null,
    runtimeFactory: async () => {
      if (returnCorrupted) {
        // 返回损坏或空的模型列表
        return {
          getModels: () => [
            {
              id: "gpt-5.6-sol",
              provider: "openai-codex",
              cost: { input: -1, output: NaN, cacheRead: 0.4, cacheWrite: 5 },
            },
          ],
        };
      }
      return { getModels: () => validModels };
    },
    refreshFn: async () => {
      return { completed: true, changed: true };
    },
    isOffline: () => false,
  });

  // 1. 首次刷新成功
  await manager.getPricing();
  await manager.getRunningRefreshPromise();
  const initial = await manager.getPricing();
  assert.equal(initial.refresh.state, "current");
  assert.equal(initial.models["gpt-5.6-sol"].input, 4);

  // 2. 推进 25 小时，触发下一次刷新，此时上游返回了损坏模型
  currentTime += PRICING_REFRESH_INTERVAL_MS + 1000;
  returnCorrupted = true;

  await manager.getPricing();
  await manager.getRunningRefreshPromise();

  // 3. 校验：损坏不能清掉有效 cached 模型，状态设为 error，保持旧价
  const afterCorrupted = await manager.getPricing();
  assert.equal(afterCorrupted.refresh.state, "error");
  assert.equal(afterCorrupted.models["gpt-5.6-sol"].input, 4);
  assert.equal(afterCorrupted.updatedAt, new Date(100_000_000).toISOString());
});

test("实证4：初始化高并发 getPricing 进行 singleflight runtime 读取", async () => {
  let runtimeCalls = 0;
  let resolveRuntime;
  const runtimeGate = new Promise((res) => {
    resolveRuntime = res;
  });

  const manager = new UsagePricingManager({
    runtimeFactory: async () => {
      runtimeCalls++;
      await runtimeGate;
      return {
        getModels: () => [
          {
            id: "gpt-5.6-sol",
            provider: "openai-codex",
            cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
          },
        ],
      };
    },
    initialCheckedAt: null,
    isOffline: () => true,
  });

  // 并发 10 个 getPricing 调用
  const promises = Array.from({ length: 10 }, () => manager.getPricing());
  resolveRuntime();
  const snapshots = await Promise.all(promises);

  // 验证 10 个调用全得到一致结果，且 runtimeFactory 仅被调用 1 次
  assert.equal(runtimeCalls, 1);
  for (const snap of snapshots) {
    assert.equal(snap.models["gpt-5.6-sol"].input, 4);
  }
});

test("实证5：models.json mtime 变更重取失败不能永久吞并把 mtime 标已同步，后续 read 可重试", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-retry-"));
  const modelsJsonPath = path.join(tmpDir, "models.json");
  let shouldFail = false;

  try {
    fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers: { "openai-codex": {} } }));

    let currentSolInput = 4;
    const manager = new UsagePricingManager({
      modelsJsonPath,
      initialCheckedAt: null,
      runtimeFactory: async () => {
        if (shouldFail) {
          throw new Error("Temporary runtime error");
        }
        return {
          getModels: () => [
            {
              id: "gpt-5.6-sol",
              provider: "openai-codex",
              cost: { input: currentSolInput, output: 20, cacheRead: 0.4, cacheWrite: 5 },
            },
          ],
        };
      },
      isOffline: () => true,
    });

    // 首次初始化
    const first = await manager.getPricing();
    assert.equal(first.models["gpt-5.6-sol"].input, 4);

    // 修改 models.json，并更新 mtime，但 runtime 第一次重取抛出异常
    shouldFail = true;
    currentSolInput = 8.88;
    fs.writeFileSync(
      modelsJsonPath,
      JSON.stringify({ providers: { "openai-codex": { modelOverrides: { "gpt-5.6-sol": { cost: { input: 8.88 } } } } } }),
    );
    const futureTime = (Date.now() + 5000) / 1000;
    fs.utimesSync(modelsJsonPath, futureTime, futureTime);

    // 第一次尝试更新：失败但保留旧有效快照
    const failCall = await manager.getPricing();
    assert.equal(failCall.models["gpt-5.6-sol"].input, 4);

    // 运行时恢复正常，再次 read：应该能重新尝试同步成功，而不是永久认为 mtime 已同步！
    shouldFail = false;
    const retryCall = await manager.getPricing();
    assert.equal(retryCall.models["gpt-5.6-sol"].input, 8.88);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test("SDK 失败仍写 checkedAt：后续读取不能清除失败或把旧价标最新", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-sdk-failed-check-"));
  const store = path.join(dir, "models-store.json");
  let now = 100_000_000, fail = false, refreshes = 0;
  const manager = new UsagePricingManager({
    now: () => now, modelsStorePath: store, modelsJsonPath: path.join(dir, "models.json"),
    runtimeFactory: createMockRuntime(fixtureModels()), isOffline: () => false,
    refreshFn: async () => {
      refreshes++;
      // 与真实 SDK remote-catalog-provider.js 非 2xx 行为相同：失败也持久化 checkedAt。
      fs.writeFileSync(store, JSON.stringify({ "openai-codex": { checkedAt: now, models: fixtureModels() } }));
      return { completed: !fail, changed: false };
    },
  });
  try {
    await manager.getPricing(); await manager.getRunningRefreshPromise();
    const good = await manager.getPricing();
    assert.equal(good.refresh.state, "current");
    const successAt = good.updatedAt;
    now += PRICING_REFRESH_INTERVAL_MS + 1; fail = true;
    await manager.getPricing(); await manager.getRunningRefreshPromise();
    const failed = await manager.getPricing();
    assert.equal(failed.refresh.state, "error");
    assert.equal(failed.updatedAt, successAt);
    assert.deepEqual(failed.models, good.models);
    assert.equal((await manager.getPricing()).refresh.state, "error");
    assert.equal(refreshes, 2);
    now += 300_001;
    await manager.getPricing(); await manager.getRunningRefreshPromise();
    assert.equal(refreshes, 3, "失败 checkedAt 不能压制五分钟冷却后重试");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
