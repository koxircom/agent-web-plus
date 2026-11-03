import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CODEX_UNKNOWN_CAPABILITY_EFFORTS,
  CODEX_DEFAULT_THINKING_LEVEL,
  effortToThinkingLevel,
  thinkingLevelToEffort,
  resolveCodexModelThinking,
  resolveCodexCatalogThinking,
} = await jiti.import("./codex-thinking-catalog.ts");
const { clampModelThinkingLevel } = await jiti.import("../model-thinking-level.ts");

test("1. 空数组场景 (Bug 根因场景)：efforts: [] 识别为未知 capability 并安全回退", () => {
  const model = {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    efforts: [],
  };

  const resolved = resolveCodexModelThinking(model);
  assert.equal(resolved.isUnknownCapability, true, "空数组必须识别为未知 capability");
  assert.deepEqual(
    resolved.thinkingLevels,
    [...CODEX_UNKNOWN_CAPABILITY_EFFORTS],
    "必须回落至原适配器既定低中高候选选项 ['low', 'medium', 'high']，严禁漏回落为空数组",
  );
  assert.equal(
    resolved.defaultThinkingLevel,
    CODEX_DEFAULT_THINKING_LEVEL,
    "默认思维深度必须保留既定 high 策略，严禁变为 off",
  );

  // 模拟 hook 选择链：clampModelThinkingLevel 不得把 high 误判为 off
  const displayLevel = clampModelThinkingLevel("high", resolved.thinkingLevels);
  assert.equal(displayLevel, "high", "hook 默认选择链必须计算为 high 而非 off");
});

test("2. 缺失场景：efforts 为 undefined 或 null 识别为未知 capability", () => {
  for (const rawEfforts of [undefined, null]) {
    const model = {
      id: "unknown-capability-model",
      name: "Unknown Capability Model",
      efforts: rawEfforts,
    };

    const resolved = resolveCodexModelThinking(model);
    assert.equal(resolved.isUnknownCapability, true, "缺失 efforts 必须识别为未知 capability");
    assert.deepEqual(resolved.thinkingLevels, ["low", "medium", "high"]);
    assert.equal(resolved.defaultThinkingLevel, "high");
  }
});

test("3. 已知 none 场景：显式保留 none -> off，且默认级别遵循为 off", () => {
  const model = {
    id: "legacy-model",
    name: "Legacy Model",
    efforts: ["none"],
  };

  const resolved = resolveCodexModelThinking(model);
  assert.equal(resolved.isUnknownCapability, false, "明确的 efforts 属于已知 capability");
  assert.deepEqual(resolved.thinkingLevels, ["off"], "显式 none 必须转换为 off");
  assert.equal(resolved.defaultThinkingLevel, "off", "仅支持 none 的模型默认必须为 off");

  // 确认在 hook 计算时 high 会被 clamp 约束为 off
  assert.equal(clampModelThinkingLevel("high", resolved.thinkingLevels), "off");
});

test("4. 已知 none + 其他级别：保留 off 与其他合法级别，并维持默认 high 策略", () => {
  const model = {
    id: "flexible-model",
    name: "Flexible Model",
    efforts: ["none", "low", "medium", "high"],
  };

  const resolved = resolveCodexModelThinking(model);
  assert.equal(resolved.isUnknownCapability, false);
  assert.deepEqual(resolved.thinkingLevels, ["off", "low", "medium", "high"]);
  assert.equal(resolved.defaultThinkingLevel, "high", "未指定 defaultEffort 时保留既定 high 策略");
});

test("5. 已知 xhigh 场景与真实 defaultEffort 遵循", () => {
  // Case A: 包含 xhigh 但未显式指定 defaultEffort -> 默认保留 high
  const modelA = {
    id: "model-xhigh-default",
    name: "Model XHigh",
    efforts: ["low", "medium", "high", "xhigh"],
  };
  const resolvedA = resolveCodexModelThinking(modelA);
  assert.deepEqual(resolvedA.thinkingLevels, ["low", "medium", "high", "xhigh"]);
  assert.equal(resolvedA.defaultThinkingLevel, "high");

  // Case B: 包含 xhigh 且真实目录指定 defaultEffort: "xhigh" -> 默认遵循目录为 xhigh
  const modelB = {
    id: "model-xhigh-custom",
    name: "Model XHigh Custom",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
  };
  const resolvedB = resolveCodexModelThinking(modelB);
  assert.deepEqual(resolvedB.thinkingLevels, ["low", "medium", "high", "xhigh"]);
  assert.equal(resolvedB.defaultThinkingLevel, "xhigh", "必须遵循真实目录的 defaultEffort");
});

test("6. catalog 顶层 currentEffort 遵循且不污染显式选择", () => {
  const model = {
    id: "model-catalog-fallback",
    name: "Model Fallback",
    efforts: ["low", "medium", "high"],
  };

  const resolved = resolveCodexModelThinking(model, "medium");
  assert.equal(resolved.defaultThinkingLevel, "medium", "模型未定义 defaultEffort 时遵循目录 currentEffort");

  // 显式选择不受默认值污染测试
  const userExplicitLevel = "off";
  const expectedSentEffort = thinkingLevelToEffort(userExplicitLevel);
  assert.equal(expectedSentEffort, "none", "用户显式选择 off 必须原样转换为 none，不被 defaultEffort 污染");
});

test("7. 双向转换函数与边界转换测试", () => {
  assert.equal(effortToThinkingLevel("none"), "off");
  assert.equal(effortToThinkingLevel("low"), "low");
  assert.equal(effortToThinkingLevel("high"), "high");

  assert.equal(thinkingLevelToEffort("off"), "none");
  assert.equal(thinkingLevelToEffort("low"), "low");
  assert.equal(thinkingLevelToEffort("high"), "high");
});

test("8. clampModelThinkingLevel 兜底防错：未知空数组能力绝不把请求 clamp 为 off", () => {
  assert.equal(clampModelThinkingLevel("high", []), "high");
  assert.equal(clampModelThinkingLevel("low", []), "low");
  assert.equal(clampModelThinkingLevel("medium", []), "medium");
  assert.equal(clampModelThinkingLevel("xhigh", []), "xhigh");
  assert.equal(clampModelThinkingLevel("off", []), "off");
  assert.equal(clampModelThinkingLevel(null, []), null);
});

test("9. resolveCodexCatalogThinking 完整目录解析回归", () => {
  const catalog = {
    models: [
      { id: "gpt-6.1-sol", name: "Sol", efforts: [], isDefault: true },
      { id: "legacy-agent", name: "Legacy", efforts: ["none"] },
      { id: "codex-max", name: "Max", efforts: ["medium", "high", "xhigh"], defaultEffort: "xhigh" },
    ],
    currentEffort: "high",
  };

  const summary = resolveCodexCatalogThinking(catalog);
  assert.equal(summary.defaultModelId, "gpt-6.1-sol");
  assert.equal(summary.defaultThinkingLevel, "high", "默认模型 gpt-6.1-sol 思考深度必须为 high");
  assert.deepEqual(summary.thinkingLevels["codex:gpt-6.1-sol"], ["low", "medium", "high"]);
  assert.deepEqual(summary.thinkingLevels["codex:legacy-agent"], ["off"]);
  assert.deepEqual(summary.thinkingLevels["codex:codex-max"], ["medium", "high", "xhigh"]);
});


test("native ultra capability and default remain intact through catalog projection", () => {
  const result = resolveCodexCatalogThinking({models:[{id:"native-ultra",efforts:["low","medium","high","xhigh","max","ultra"],defaultEffort:"ultra",isDefault:true},{id:"native-xhigh",efforts:["low","medium","high","xhigh"],defaultEffort:"medium"}]});
  assert.deepEqual(result.thinkingLevels["codex:native-ultra"],["low","medium","high","xhigh","max","ultra"]);
  assert.equal(result.defaultThinkingLevel,"ultra");
  assert.equal(result.thinkingLevels["codex:native-xhigh"].includes("ultra"),false);
});
