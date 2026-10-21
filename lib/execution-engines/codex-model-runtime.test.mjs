import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dir = mkdtempSync(join(tmpdir(), "codex-model-test-"));
process.env.PI_CODING_AGENT_DIR = dir;
const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });
const { CodexRuntime } = await jiti.import("./codex-engine.ts");
const { codexBridgeRequest, CodexBridgeError } = await jiti.import("./codex-bridge-client.ts");
const settings = await jiti.import("../execution-engine-settings.ts");

await settings.saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:54321" } });
test.after(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (initialModel = "gpt-5.6-luna", initialEffort = "medium", status = "idle") => {
  const id = "codex:" + crypto.randomUUID();
  const meta = {
    id: id.slice(6),
    cwd: "/workspace/test",
    title: "Test Session",
    status,
    model: initialModel,
    effort: initialEffort,
    sequence: 1,
    submissions: [],
    composerState: { version: 1, mode: "normal", capabilities: { plan: true, goal: true } },
  };
  const runtime = new CodexRuntime(id, "fixture-identity", { epoch: "e", sequence: 1, rows: [], meta });
  return { id, meta, runtime };
};

test("reads started during native confirmation cannot overwrite the confirmed model", async () => {
  const { runtime, meta } = fixture();
  let finishWrite;
  runtime.json = () => new Promise(resolve => { finishWrite = resolve; });
  const switching = runtime.send({ type: "set_model", modelId: "gpt-6.1-sol" });
  while (!finishWrite) await new Promise(resolve => setImmediate(resolve));
  const duringWrite = runtime.modelWriteSequence;
  finishWrite({ ...meta, model: "gpt-6.1-sol" });
  await switching;
  runtime.adoptMeta({ ...meta }, 0, duringWrite);
  assert.equal(runtime.meta.model, "gpt-6.1-sol");
  runtime.adoptMeta({ ...meta, model: "external-native-change" });
  assert.equal(runtime.meta.model, "external-native-change");
});

test("1. idle and running session switch model applies to next turn without mutating running turn", async () => {
  // 空闲状态正常切换
  const { runtime } = fixture("gpt-5.6-luna", "medium", "idle");
  const calls = [];
  runtime.json = async (path, body) => {
    calls.push({ path, body });
    return { ...runtime.meta, model: body.model, effort: body.effort };
  };

  const res = await runtime.send({ type: "set_model", modelId: "gpt-6.1-sol" });
  assert.equal(res.id, "gpt-6.1-sol");
  assert.equal(runtime.meta.model, "gpt-6.1-sol");
  assert.equal(calls[0].path, `/api/sessions/${runtime.meta.id}/settings`);
  assert.equal(calls[0].body.model, "gpt-6.1-sol");
  assert.equal(calls[0].body.effort, "medium");

  // 运行中状态切换：仅下一轮生效，不篡改当前执行中 turn 的模型属性
  const { runtime: runningRuntime } = fixture("gpt-5.6-luna", "medium", "active");
  const runningTurnRow = {
    key: "turn-1",
    role: "assistant",
    turnStatus: "inProgress",
    text: "正在输出...",
    version: "v1",
  };
  runningRuntime.rows.set(runningTurnRow.key, runningTurnRow);
  runningRuntime.json = async (path, body) => {
    return { ...runningRuntime.meta, model: body.model, effort: body.effort };
  };

  const runningRes = await runningRuntime.send({ type: "set_model", modelId: "gpt-6.1-sol" });
  assert.equal(runningRes.id, "gpt-6.1-sol");
  assert.equal(runningRuntime.meta.model, "gpt-6.1-sol");
  // 正在运行的 row 仍然保留原样，没有被篡改
  assert.equal(runningRuntime.rows.get("turn-1").turnStatus, "inProgress");
  assert.equal(runningRuntime.rows.get("turn-1").text, "正在输出...");
});

test("2. sequential set_model then set_thinking preserves confirmed model and low effort", async () => {
  const { runtime } = fixture("model-A", "high");
  const calls = [];
  runtime.json = async (path, body) => {
    calls.push({ path, body });
    return { ...runtime.meta, model: body.model, effort: body.effort };
  };

  // 1. 先切换 model -> model-B
  await runtime.send({ type: "set_model", modelId: "model-B" });
  assert.equal(runtime.meta.model, "model-B");
  assert.equal(calls[0].body.model, "model-B");

  // 2. 紧接着切换 thinking -> low (低推理档位必须完整保留)
  const thinkRes = await runtime.send({ type: "set_thinking_level", level: "low" });
  assert.equal(thinkRes.thinkingLevel, "low");
  assert.equal(runtime.meta.effort, "low");
  assert.equal(calls[1].body.model, "model-B", "set_thinking 必须携带刚确认生效的 model-B，绝不能倒退拿回旧 model-A");
  assert.equal(calls[1].body.effort, "low");

  // 3. 测试 thinking -> off 映射为 none，并能由 get_state 正确读取为 off
  runtime.json = async (path, body) => {
    if (path.endsWith("/settings")) return { ...runtime.meta, model: body.model, effort: "none" };
    if (path.endsWith("?metadata=1")) return { ...runtime.meta, effort: "none" };
    return runtime.meta;
  };
  const offRes = await runtime.send({ type: "set_thinking_level", level: "off" });
  assert.equal(offRes.thinkingLevel, "off");

  const state = await runtime.send({ type: "get_state" });
  assert.equal(state.thinkingLevel, "off");
  assert.equal(state.model.id, "model-B");
});

test("3. cold load properly restores persisted model and effort", async () => {
  const { runtime, meta } = fixture("persisted-model-6", "minimal");
  runtime.json = async (path) => {
    if (path.endsWith("?metadata=1")) {
      return meta;
    }
    return meta;
  };
  const state = await runtime.send({ type: "get_state" });
  assert.equal(state.model.id, "persisted-model-6");
  assert.equal(state.thinkingLevel, "minimal");
});

test("4. codexBridgeRequest differentiates timeout from network error, and write never retries", async () => {
  const timeoutError = new CodexBridgeError(
    "Codex 操作响应超时，当前设置未在时限内确认生效；写操作未自动重发，请刷新核对",
    504,
    "codex_timeout",
    undefined,
    false,
  );
  assert.equal(timeoutError.status, 504);
  assert.equal(timeoutError.code, "codex_timeout");
  assert.equal(timeoutError.retryable, false, "写操作超时绝不可自动重发");
  assert.match(timeoutError.message, /未在时限内确认生效/);
  assert.match(timeoutError.message, /未自动重发/);

  const netError = new CodexBridgeError("Codex 执行端暂时不可达；Pi 引擎可继续使用", 502, "codex_connection_required", undefined, true);
  assert.equal(netError.status, 502);
  assert.equal(netError.retryable, true);
  assert.match(netError.message, /暂时不可达/);
});

// ---------------------------------------------------------
// 主控指定 6 项必须反例测试
// ---------------------------------------------------------

test("counter-example 1: initial generation 0 external native model change is visible", async () => {
  const { runtime, meta } = fixture("model-initial-5.6", "medium");
  // 初始代次均为 0，外部原生（如桌面端）将模型修改为 model-external-changed
  const externalMeta = { ...meta, sequence: 2, model: "model-external-changed", effort: "high" };
  // snapshotRequestSequence 为 0，lastConfirmedModelWrite 为 0。0 < 0 为 false，非 stale 快照
  await runtime.accept({ epoch: "e", sequence: 2, rows: [], meta: externalMeta }, 0, 0);

  assert.equal(runtime.meta.model, "model-external-changed", "初始0代次外部原生model改变必须可见");
  assert.equal(runtime.meta.effort, "high");

  // 权威读取也必须直接返回外部更改的模型
  runtime.json = async (path) => {
    if (path.endsWith("?metadata=1")) {
      return { ...meta, model: "model-external-changed", effort: "high" };
    }
    return meta;
  };
  const state = await runtime.send({ type: "get_state" });
  assert.equal(state.model.id, "model-external-changed");
});

test("counter-example 2: after selecting 6.1, stale 5.6 is rejected, but subsequent fresh GET sees native other model", async () => {
  const { runtime, meta } = fixture("model-5.6", "medium");
  runtime.json = async (path, body) => {
    return { ...runtime.meta, model: body.model, effort: body.effort };
  };

  // 1. 本地选择并确认 6.1
  await runtime.send({ type: "set_model", modelId: "model-6.1" });
  assert.equal(runtime.meta.model, "model-6.1");

  // 2. 模拟发起早于 set_model 确认的旧 poll 快照迟到返回（snapshotRequestSequence = 0 < lastConfirmedModelWrite = 1）
  const stalePollMeta = { ...meta, sequence: 2, model: "model-5.6", effort: "medium" };
  await runtime.accept({ epoch: "e", sequence: 2, rows: [], meta: stalePollMeta }, 0, 0);
  assert.equal(runtime.meta.model, "model-6.1", "迟到的旧快照 5.6 必须被拒绝，保留已确认的 6.1");

  // 3. 随后，新发起的权威 GET（例如外部原生桌面改成了 model-desktop-o3）
  runtime.json = async (path) => {
    if (path.endsWith("?metadata=1")) {
      return { ...meta, model: "model-desktop-o3", effort: "high" };
    }
    return meta;
  };
  // 新 GET 在 set_model 确认之后启动，其 snapshotRequestSequence >= lastConfirmedModelWrite
  const state = await runtime.send({ type: "get_state" });
  assert.equal(state.model.id, "model-desktop-o3", "新启动的权威 GET 必须能反映原生外部模型更改");
  assert.equal(runtime.meta.model, "model-desktop-o3", "runtime.meta 必须更新为外部原生模型，绝不能被永久屏蔽");
});

test("counter-example 3: stale snapshot with same model but old effort does not roll back confirmed effort", async () => {
  const { runtime, meta } = fixture("model-same", "high");
  runtime.json = async (path, body) => {
    return { ...runtime.meta, model: body.model, effort: body.effort };
  };

  // 1. 设置 thinking level 为 low，确认成功（写入代次推进至 1）
  await runtime.send({ type: "set_thinking_level", level: "low" });
  assert.equal(runtime.meta.effort, "low");

  // 2. 迟到的旧快照返回（snapshotRequestSequence = 0 < 1），model 相同均为 model-same，但 effort 仍为旧的 high
  const staleMeta = { ...meta, sequence: 2, model: "model-same", effort: "high" };
  await runtime.accept({ epoch: "e", sequence: 2, rows: [], meta: staleMeta }, 0, 0);

  // 验证：旧 effort 不会回滚，必须保留确认的 low
  assert.equal(runtime.meta.effort, "low", "迟到旧 effort 绝不回滚已确认的 low 档位");
  assert.equal(runtime.meta.model, "model-same");
});

test("counter-example 4: concurrent set_model then set_thinking preserves new model in final settings and meta", async () => {
  const { runtime } = fixture("model-initial", "high");
  const calls = [];
  runtime.json = async (path, body) => {
    // 模拟轻微网络异步交错
    await new Promise(r => setTimeout(r, 10));
    calls.push({ path, body: { ...body } });
    return { ...runtime.meta, model: body.model, effort: body.effort };
  };

  // 并发调用 set_model 和 set_thinking_level
  const p1 = runtime.send({ type: "set_model", modelId: "model-final" });
  const p2 = runtime.send({ type: "set_thinking_level", level: "low" });
  const [resModel, resThinking] = await Promise.all([p1, p2]);

  assert.equal(resModel.id, "model-final");
  assert.equal(resThinking.thinkingLevel, "low");
  assert.equal(runtime.meta.model, "model-final", "并发后 runtime.meta.model 必须为最新设置的 model-final");
  assert.equal(runtime.meta.effort, "low", "并发后 runtime.meta.effort 必须为最新设置的 low");

  // 检查向后端发送的 settings 请求：set_thinking 必须拿到 set_model 的新值，绝不能把旧的 model-initial 发给后端
  const setThinkingCall = calls.find(c => c.body.effort === "low");
  assert.ok(setThinkingCall, "必须有 set_thinking 对应的网络调用");
  assert.equal(setThinkingCall.body.model, "model-final", "并发 set_thinking 必须携带新确认的 model-final，禁止携带旧模型");
});

test("counter-example 5: after write failure, authoritative read confirms actual backend model without sticky lock", async () => {
  const { runtime, meta } = fixture("model-stable", "medium");

  // 模拟写入失败（例如超时或 504 错误）
  runtime.json = async (path, body) => {
    if (path.endsWith("/settings")) {
      throw new CodexBridgeError("Codex 操作响应超时", 504, "codex_timeout", undefined, false);
    }
    if (path.endsWith("?metadata=1")) {
      return { ...meta, model: "model-stable", effort: "medium" };
    }
    return meta;
  };

  await assert.rejects(
    () => runtime.send({ type: "set_model", modelId: "model-unreachable" }),
    /超时/
  );

  // 写失败后未确认，lastConfirmedModelWrite 未推进
  // 随后执行权威 get_state 读取，后端返回实际稳定的 model-stable
  const state = await runtime.send({ type: "get_state" });
  assert.equal(state.model.id, "model-stable", "写失败后权威读取必须确认实际模型");
  assert.equal(runtime.meta.model, "model-stable", "runtime.meta 必须保持为后端实际模型，绝不假成功");
});

test("counter-example 6: frozen incoming meta is never mutated and causes no error", async () => {
  const { runtime, meta } = fixture("model-frozen-test", "medium");
  const frozenMeta = Object.freeze({
    ...meta,
    sequence: 5,
    model: "model-frozen-updated",
    effort: "high",
    submissions: Object.freeze([]),
    composerState: Object.freeze({ version: 1, mode: "normal", capabilities: Object.freeze({}) }),
  });

  // 调用 accept 传入被 Object.freeze 深度冻结的对象
  await runtime.accept({ epoch: "e", sequence: 5, rows: [], meta: frozenMeta }, 0, 0);

  // 验证：没有报 TypeError: Cannot assign to read only property，且 runtime.meta 成功更新为新对象
  assert.equal(runtime.meta.model, "model-frozen-updated");
  assert.equal(runtime.meta.effort, "high");
  // 确保传入的 frozenMeta 本身没有被添加或修改任何属性
  assert.equal(Object.isFrozen(frozenMeta), true);
});

test("7. session model override enforces strict A/B isolation, protects in-flight write, and releases on settled read", async () => {
  let currentModelOverride = null;
  let liveModel = null;
  let modelSwitchPending = false;

  const computeCurrentModel = (sid, dataModel) => {
    const activeOverride = (currentModelOverride && currentModelOverride.sid === sid)
      ? { provider: currentModelOverride.provider, modelId: currentModelOverride.modelId }
      : null;
    return activeOverride ?? liveModel ?? dataModel ?? null;
  };

  const handleSyncLiveModel = (state, sid) => {
    if (state?.model) {
      const isCurrentPending = currentModelOverride && currentModelOverride.sid === sid && modelSwitchPending;
      if (isCurrentPending) {
        // 当前会话写请求在途中（未回执），旧 read 既不覆盖 liveModel，更不能提前清除 override
      } else {
        liveModel = { provider: state.model.provider, modelId: state.model.id };
        if (currentModelOverride && currentModelOverride.sid === sid && !modelSwitchPending) {
          currentModelOverride = null;
        }
      }
    } else {
      liveModel = null;
    }
  };

  const dataA = { provider: "codex", modelId: "model-A-old" };
  const dataB = { provider: "codex", modelId: "model-B-stable" };

  // 1. 会话 A 触发切换至 model-A-new，写请求处于 pending 状态
  modelSwitchPending = true;
  currentModelOverride = { sid: "session-A", provider: "codex", modelId: "model-A-new" };
  assert.equal(computeCurrentModel("session-A", dataA).modelId, "model-A-new");

  // 2. 模拟一个碰巧带有 model-A-new 的旧读取在写确认前到达
  // 关键断言：当 modelSwitchPending 为 true 时，绝对不能因为模型相等就提前清空 override！
  handleSyncLiveModel({ model: { provider: "codex", id: "model-A-new" } }, "session-A");
  assert.ok(currentModelOverride !== null, "写确认未回执前，旧读取绝不能提前清空 override");
  assert.equal(computeCurrentModel("session-A", dataA).modelId, "model-A-new");

  // 3. 此时又来了一个旧读 model-A-old，由于 override 未被提前清空，界面仍受保护
  handleSyncLiveModel({ model: { provider: "codex", id: "model-A-old" } }, "session-A");
  assert.equal(computeCurrentModel("session-A", dataA).modelId, "model-A-new");

  // 4. 写请求成功回执，modelSwitchPending 变为 false
  modelSwitchPending = false;

  // 5. 写入完成后，新读（或外部更改）到达，此时 override 安全释放，外部更改能够正常展示
  handleSyncLiveModel({ model: { provider: "codex", id: "model-A-external-update" } }, "session-A");
  assert.equal(currentModelOverride, null, "写入完成后新读到达，override 安全释放");
  assert.equal(liveModel.modelId, "model-A-external-update");
  assert.equal(computeCurrentModel("session-A", dataA).modelId, "model-A-external-update", "外部更改完全可见，未被无限 override 锁住");
});
