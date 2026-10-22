import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../bin/usage-guard/usage-ledger-core.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function atBeijing(day, hour = 12) {
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+08:00`);
}

function createBucket({
  engine = "codex",
  sessionId = "codex:sess-1",
  day = "2026-10-22",
  role = "main",
  model = "gpt-6.1-sol",
  provider = "openai-codex",
  controllerModel,
  controllerProvider,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  costNano = 0,
  unpricedTokens = 0,
  messageCount = 1,
  calls = 1,
  records = 1,
}) {
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const ts = atBeijing(day);
  const values = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    messageCount,
    calls,
    records,
    costNano,
    unpricedTokens,
    missingUsage: 0,
  };
  const timeline = [[ts, ...core.fields.map(f => values[f])]];
  const bucket = {
    ...values,
    engine,
    sessionId,
    day,
    role,
    model,
    provider,
    timeline,
  };
  if (controllerModel) bucket.controllerModel = controllerModel;
  if (controllerProvider) bucket.controllerProvider = controllerProvider;
  return bucket;
}

const samplePricing = {
  version: 1,
  currency: "USD",
  unit: "per_1m_tokens",
  updatedAt: "2026-10-22T00:00:00.000Z",
  refresh: {
    state: "ok",
    attemptedAt: "2026-10-22T00:00:00.000Z",
    message: "ok",
  },
  models: {
    "gpt-6.1-sol": {
      input: 2.00,
      output: 10.00,
      cacheRead: 0.10,
      cacheWrite: 2.50,
      source: "pi-sdk",
      provider: "openai-codex",
      modelId: "gpt-6.1-sol",
      tiered: false,
    },
    "gpt-6-luna": {
      input: 0.10,
      output: 0.50,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      source: "pi-sdk",
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      tiered: false,
    },
  },
};

test("existing pure core validate and checksum: old ledger remains valid and raw ledger is never mutated", () => {
  const b1 = createBucket({
    sessionId: "codex:root",
    inputTokens: 100,
    outputTokens: 50,
    costNano: 0,
    unpricedTokens: 150,
  });
  const ledger = {
    version: 2,
    snapshotId: "test-snapshot-1",
    generatedAt: "2026-10-22T00:00:00.000Z",
    buckets: [b1],
    sessions: { "codex:root": { title: "根任务" } },
    pricing: samplePricing,
  };

  const beforeClone = clone(ledger);

  // 1. 无 options.pricing 聚合：默认旧行为（Codex 成本保持 0）
  const defStats = core.aggregate(ledger);
  assert.equal(defStats.costNano, 0);
  assert.equal(defStats.unpricedTokens, 150);

  // 2. 校验通过
  const validated = core.validate(ledger);
  assert.ok(validated);

  // 3. 有 options.pricing 聚合
  const pricingStats = core.aggregate(ledger, { pricing: ledger.pricing });
  assert.ok(pricingStats.costNano > 0);
  assert.equal(pricingStats.unpricedTokens, 0);

  // 4. 不变量：raw ledger 完全没有被篡改
  assert.deepEqual(ledger, beforeClone);
});

test("sample Sol and Luna rate calculation: USD and nano match exact requirements", () => {
  // Sample Sol: input 544,400, output 36,600, cacheRead 8,190,000 -> $2.2738 (2,273,800,000 nano)
  const solBucket = createBucket({
    model: "gpt-6.1-sol",
    inputTokens: 544400,
    outputTokens: 36600,
    cacheReadTokens: 8190000,
    cacheWriteTokens: 0,
    costNano: 0,
    unpricedTokens: 544400 + 36600 + 8190000,
  });

  // Sample Luna: input 116,300, output 65,000, cacheRead 1,940,000 -> $0.06353 (63,530,000 nano)
  const lunaBucket = createBucket({
    model: "gpt-6-luna",
    inputTokens: 116300,
    outputTokens: 65000,
    cacheReadTokens: 1940000,
    cacheWriteTokens: 0,
    costNano: 0,
    unpricedTokens: 116300 + 65000 + 1940000,
  });

  const ledger = {
    version: 2,
    buckets: [solBucket, lunaBucket],
    pricing: samplePricing,
  };

  const stats = core.aggregate(ledger, { pricing: ledger.pricing });

  // 检查 Sol 费用
  const solModel = stats.modelBreakdowns.find(m => m.key === "gpt-6.1-sol");
  assert.equal(solModel.costNano, 2273800000);
  assert.equal(solModel.estimatedCostNano, 2273800000);
  assert.equal(solModel.unpricedTokens, 0);

  // 检查 Luna 费用
  const lunaModel = stats.modelBreakdowns.find(m => m.key === "gpt-6-luna");
  assert.equal(lunaModel.costNano, 63530000);
  assert.equal(lunaModel.estimatedCostNano, 63530000);
  assert.equal(lunaModel.unpricedTokens, 0);

  // 检查合计
  assert.equal(stats.costNano, 2273800000 + 63530000);
  assert.equal(stats.estimatedCostNano, 2273800000 + 63530000);
  assert.equal(stats.unpricedTokens, 0);
});

test("zero tokens and empty usage result in 0 cost without false failure", () => {
  const zeroBucket = createBucket({
    model: "gpt-6.1-sol",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costNano: 0,
    unpricedTokens: 0,
  });
  const ledger = { version: 2, buckets: [zeroBucket], pricing: samplePricing };
  const stats = core.aggregate(ledger, { pricing: ledger.pricing });
  assert.equal(stats.totalTokens, 0);
  assert.equal(stats.costNano, 0);
  assert.equal(stats.estimatedCostNano, 0);
  assert.equal(stats.unpricedTokens, 0);
});

test("unknown or illegal pricing preserves unpriced tokens instead of pretending zero cost", () => {
  const unknownBucket = createBucket({
    model: "gpt-unknown-special-edition",
    inputTokens: 10000,
    outputTokens: 2000,
    costNano: 0,
    unpricedTokens: 12000,
  });
  const illegalPricing = {
    version: 1,
    currency: "USD",
    unit: "per_1m_tokens",
    models: {
      "gpt-unknown-special-edition": {
        input: -5.0, // illegal negative
        output: "invalid", // illegal type
        cacheRead: NaN, // illegal NaN
      },
    },
  };

  const ledger = { version: 2, buckets: [unknownBucket], pricing: illegalPricing };
  const stats = core.aggregate(ledger, { pricing: ledger.pricing });
  assert.equal(stats.totalTokens, 12000);
  assert.equal(stats.costNano, 0);
  assert.equal(stats.estimatedCostNano, 0);
  assert.equal(stats.unpricedTokens, 12000, "Unpriced tokens must be retained, not 0");
});

test("native cost is prioritized: buckets with native costNano > 0 are preserved and not overwritten", () => {
  const nativeCostBucket = createBucket({
    model: "gpt-6.1-sol",
    inputTokens: 1000000,
    outputTokens: 1000000,
    costNano: 8888888, // native cost
    unpricedTokens: 0,
  });

  const ledger = { version: 2, buckets: [nativeCostBucket], pricing: samplePricing };
  const stats = core.aggregate(ledger, { pricing: ledger.pricing });
  assert.equal(stats.costNano, 8888888, "Native cost must be preserved exactly");
  assert.equal(stats.estimatedCostNano, 0, "Native cost must not be flagged as estimated");
  assert.equal(stats.unpricedTokens, 0);
});

test("filters: engine, role, and date compose consistently across all breakdown tables", () => {
  const piBucket = createBucket({
    engine: "pi",
    sessionId: "pi-sess",
    day: "2026-10-21",
    role: "main",
    model: "gemini-3.8-flash-high",
    inputTokens: 100000,
    outputTokens: 20000,
  });
  const codexMain = createBucket({
    engine: "codex",
    sessionId: "codex:p",
    day: "2026-10-22",
    role: "main",
    model: "gpt-6.1-sol",
    inputTokens: 100000,
    outputTokens: 20000,
  });
  const codexSub = createBucket({
    engine: "codex",
    sessionId: "codex:c",
    day: "2026-10-22",
    role: "subagent",
    model: "gpt-6-luna",
    controllerModel: "gpt-6.1-sol",
    inputTokens: 50000,
    outputTokens: 10000,
  });

  const ledger = {
    version: 2,
    sessions: {
      "codex:p": { title: "主任务" },
      "codex:c": { name: "子任务", parentSessionId: "codex:p" },
    },
    buckets: [piBucket, codexMain, codexSub],
    pricing: samplePricing,
  };

  // Filter engine: codex
  const codexOnly = core.aggregate(ledger, { engine: "codex", pricing: ledger.pricing });
  assert.equal(codexOnly.totalTokens, codexMain.totalTokens + codexSub.totalTokens);
  assert.equal(codexOnly.roles.main.totalTokens, codexMain.totalTokens);
  assert.equal(codexOnly.roles.subagent.totalTokens, codexSub.totalTokens);
  assert.ok(codexOnly.costNano > 0);

  // Subtask parent grouping: child usage explains parent and does not double-count parent total
  const parentSession = codexOnly.topSessions.find(s => s.id === "codex:p");
  assert.ok(parentSession);
  assert.equal(parentSession.totalTokens, codexMain.totalTokens + codexSub.totalTokens);
  assert.equal(parentSession.mainTokens, codexMain.totalTokens);
  assert.equal(parentSession.subagentTokens, codexSub.totalTokens);
  assert.equal(parentSession.subtasks.length, 1);
  assert.equal(parentSession.subtasks[0].name, "子任务");
  assert.ok(parentSession.subtasks[0].costNano > 0);

  // Filter role: subagent
  const subOnly = core.aggregate(ledger, { role: "subagent", pricing: ledger.pricing });
  assert.equal(subOnly.totalTokens, codexSub.totalTokens);
  assert.equal(subOnly.roles.main.totalTokens, 0);

  // Savings calculation flags estimation
  const solModelBreakdown = codexOnly.modelBreakdowns.find(m => m.key === "gpt-6.1-sol");
  assert.ok(solModelBreakdown);
  if (solModelBreakdown.dispatchedSubagents && solModelBreakdown.dispatchedSubagents.savedCost > 0) {
    assert.equal(solModelBreakdown.dispatchedSubagents.isEstimated, true, "Codex delegation savings must be flagged as estimated");
  }
});

test("rateResolver is exported and performs exact matching without fuzzy analogies", () => {
  assert.equal(typeof core.resolveRate, "function");

  // Exact match
  const solRes = core.resolveRate(samplePricing, "gpt-6.1-sol", "openai-codex", "gpt-6.1-sol", "codex");
  assert.ok(solRes);
  assert.deepEqual(solRes.rates, [2.00, 10.00, 0.10, 2.50]);

  // Codex 没匹配有效 rate 仍未定价，禁止 fallback 到 STANDARD_RATES
  const gpt56SolRes = core.resolveRate(samplePricing, "gpt-5.6-sol", "openai-codex", "gpt-5.6-sol", "codex");
  assert.equal(gpt56SolRes, null, "Codex model without explicit pricing must not fallback to STANDARD_RATES");

  // Pi 模型未命中有明确原 STD 时保留 fallback，不破坏 Gemini 等
  const geminiRes = core.resolveRate(samplePricing, "gemini-2.0-flash", "google", "gemini-2.0-flash", "pi");
  assert.ok(geminiRes, "Pi model with standard rate must fallback safely");
  assert.equal(geminiRes.source, "fallback");
  assert.deepEqual(geminiRes.rates, [0.10, 0.40, 0.025, 0.025]);

  // Unknown model
  const unknownRes = core.resolveRate(samplePricing, "totally-unknown-model", null, "unknown");
  assert.equal(unknownRes, null);
});

test("invalid null/string/partial/currency/unknown: strictly rejected with no silent fallback", () => {
  // 1. Snapshot invalid currency / version / unit
  const invalidCurrencyPricing = {
    ...samplePricing,
    currency: "CNY",
  };
  assert.equal(core.resolveRate(invalidCurrencyPricing, "gpt-6.1-sol", "openai-codex", "gpt-6.1-sol"), null);

  const invalidVersionPricing = {
    ...samplePricing,
    version: 2,
  };
  assert.equal(core.resolveRate(invalidVersionPricing, "gpt-6.1-sol", "openai-codex", "gpt-6.1-sol"), null);

  const invalidUnitPricing = {
    ...samplePricing,
    unit: "per_1k_tokens",
  };
  assert.equal(core.resolveRate(invalidUnitPricing, "gpt-6.1-sol", "openai-codex", "gpt-6.1-sol"), null);

  // 2. Explicit entry is null
  const nullEntryPricing = {
    ...samplePricing,
    models: {
      "test-null-model": null,
    },
  };
  assert.equal(core.resolveRate(nullEntryPricing, "test-null-model", "openai-codex", "test-null-model"), null);

  // 3. Rate is string (must not use Number(string) coercion)
  const stringRatePricing = {
    ...samplePricing,
    models: {
      "test-str-model": {
        input: "0.1",
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.1,
      },
    },
  };
  assert.equal(core.resolveRate(stringRatePricing, "test-str-model", "openai-codex", "test-str-model"), null);

  // 4. Rate is partial (missing cacheWrite or cacheRead)
  const partialRatePricing = {
    ...samplePricing,
    models: {
      "test-partial-model": {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        // missing cacheWrite
      },
    },
  };
  assert.equal(core.resolveRate(partialRatePricing, "test-partial-model", "openai-codex", "test-partial-model"), null);

  // 5. Explicit illegal entry on Pi model: must NOT silently fallback to STANDARD_RATES
  const illegalPiPricing = {
    ...samplePricing,
    models: {
      "gemini-2.0-flash": {
        input: null,
        output: "invalid",
        cacheRead: -1,
        cacheWrite: undefined,
      },
    },
  };
  const illegalPiRes = core.resolveRate(illegalPiPricing, "gemini-2.0-flash", "google", "gemini-2.0-flash", "pi");
  assert.equal(illegalPiRes, null, "Explicit illegal entry on Pi model must be rejected without fallback");
});

test("explicit free rate (0 cost): costNano=0, estimatedCostNano=0, unpricedTokens=0, isExplicitFree=true", () => {
  const freePricing = {
    version: 1,
    currency: "USD",
    unit: "per_1m_tokens",
    updatedAt: "2026-10-22T00:00:00.000Z",
    refresh: { state: "current", attemptedAt: "2026-10-22T00:00:00.000Z" },
    models: {
      "free-codex-model": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        source: "pricing",
        modelId: "free-codex-model",
      },
    },
  };

  const bMain = createBucket({
    engine: "codex",
    sessionId: "codex:free-p",
    day: "2026-10-22",
    role: "main",
    model: "free-codex-model",
    inputTokens: 10000,
    outputTokens: 2000,
    costNano: 0,
    unpricedTokens: 12000,
  });

  const bSub = createBucket({
    engine: "codex",
    sessionId: "codex:free-sub",
    day: "2026-10-22",
    role: "subagent",
    model: "free-codex-model",
    controllerModel: "free-codex-model",
    inputTokens: 5000,
    outputTokens: 1000,
    costNano: 0,
    unpricedTokens: 6000,
  });

  const ledger = {
    version: 2,
    sessions: {
      "codex:free-p": { title: "免费父会话" },
      "codex:free-sub": { name: "免费子任务", parentSessionId: "codex:free-p" },
    },
    buckets: [bMain, bSub],
    pricing: freePricing,
  };

  const stats = core.aggregate(ledger, { pricing: ledger.pricing });
  assert.equal(stats.totalTokens, 18000);
  assert.equal(stats.costNano, 0);
  assert.equal(stats.estimatedCostNano, 0);
  assert.equal(stats.unpricedTokens, 0);
  assert.equal(stats.isExplicitFree, true, "Total must be marked as explicit free");

  const m = stats.modelBreakdowns.find(x => x.key === "free-codex-model");
  assert.ok(m);
  assert.equal(m.costNano, 0);
  assert.equal(m.unpricedTokens, 0);
  assert.equal(m.isExplicitFree, true, "Model breakdown must be marked as explicit free");

  const parentSession = stats.topSessions.find(s => s.id === "codex:free-p");
  assert.ok(parentSession);
  assert.equal(parentSession.isExplicitFree, true);
  assert.equal(parentSession.subtasks[0].isExplicitFree, true);
  assert.equal(parentSession.subtasks[0].costNano, 0);
  assert.equal(parentSession.subtasks[0].unpricedTokens, 0);
});

test("raw ledger deepEqual and validate checksum: completely pure with zero mutations", () => {
  const b1 = createBucket({
    sessionId: "codex:mut-check",
    inputTokens: 12345,
    outputTokens: 6789,
    costNano: 0,
    unpricedTokens: 19134,
  });
  const ledger = {
    version: 2,
    snapshotId: "mutation-test-1",
    generatedAt: "2026-10-22T00:00:00.000Z",
    buckets: [b1],
    sessions: { "codex:mut-check": { title: "不变性检验" } },
    pricing: samplePricing,
  };

  const rawBefore = clone(ledger);

  // Run multiple aggregations with various filters and pricing
  core.aggregate(ledger, { pricing: ledger.pricing, engine: "all" });
  core.aggregate(ledger, { pricing: ledger.pricing, engine: "codex" });
  core.aggregate(ledger, { pricing: ledger.pricing, role: "main" });
  core.aggregate(ledger, {});

  // Raw ledger must be 100% deep equal to original
  assert.deepEqual(ledger, rawBefore);

  // Validate checksum must pass without errors
  const validated = core.validate(ledger);
  assert.ok(validated);
});
