import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dir = mkdtempSync(join(tmpdir(), "codex-first-model-test-"));
process.env.PI_CODING_AGENT_DIR = dir;
const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });
const settings = await jiti.import("../execution-engine-settings.ts");
await settings.saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:54321" } });

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

const { createCodexSession, getCodexRuntime } = await jiti.import("./codex-engine.ts");

function setupBridgeMock(options = {}) {
  const calls = [];
  const sessionModels = new Map();
  const sessionEfforts = new Map();
  const sentPrompts = [];

  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    const path = urlStr.replace("http://127.0.0.1:54321", "");
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, body, method: opts.method || "GET" });

    if (path === "/api/login") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Set-Cookie": "session=test" }
      });
    }
    if (path === "/api/auth") {
      return new Response(JSON.stringify({ authenticated: true, csrf: "csrf-token" }));
    }
    if (path === "/api/projects") {
      return new Response(JSON.stringify({
        projects: [
          { key: "projA", name: "Project A", cwd: "/workspace/projA" },
          { key: "projB", name: "Project B", cwd: "/workspace/projB" },
          { key: "work", name: "Work", cwd: "/home/koxir/Work" },
        ]
      }));
    }
    if (path.startsWith("/api/projects/catalog")) {
      if (options.catalogFails) {
        return new Response(JSON.stringify({ error: "Catalog unavailable" }), { status: 500 });
      }
      if (options.catalogEmpty) {
        return new Response(JSON.stringify({ models: [] }));
      }
      const isProjB = path.includes("projB");
      const defaultId = isProjB ? "model-beta" : (options.defaultCatalogModel || "gpt-6.1-sol");
      return new Response(JSON.stringify({
        models: isProjB
          ? [
              { id: "model-beta", name: "Model Beta", isDefault: true, efforts: ["low", "high"] },
              { id: "model-legacy", name: "Model Legacy", isDefault: false, efforts: ["high"] },
            ]
          : [
              { id: defaultId, name: "Default Model", isDefault: true, efforts: ["low", "medium", "high"] },
              { id: "gpt-5.6-luna", name: "Native Default", isDefault: false, efforts: ["low", "medium", "high"] },
            ]
      }));
    }
    if (path === "/api/sessions") {
      const sessionId = crypto.randomUUID();
      // Native initial state: 5.6-luna medium
      sessionModels.set(sessionId, "gpt-5.6-luna");
      sessionEfforts.set(sessionId, "medium");
      return new Response(JSON.stringify({ id: sessionId }));
    }
    if (path.includes("/timeline")) {
      const match = path.match(/\/api\/sessions\/([^/?]+)\/timeline/);
      const sessionId = match ? match[1] : "unknown";
      return new Response(JSON.stringify({
        epoch: "1",
        sequence: 1,
        rows: [],
        meta: {
          id: sessionId,
          title: "新聊天",
          model: sessionModels.get(sessionId) || "gpt-5.6-luna",
          effort: sessionEfforts.get(sessionId) || "medium",
          submissions: [],
          rows: []
        }
      }));
    }
    if (path.includes("/settings")) {
      if (options.settingsGate) {
        await options.settingsGate;
      }
      const match = path.match(/\/api\/sessions\/([^/?]+)\/settings/);
      const sessionId = match ? match[1] : "unknown";
      if (options.settingsFails) {
        return new Response(JSON.stringify({ error: "Settings rejected" }), { status: 500 });
      }
      if (options.settingsEmptyModelAck) {
        return new Response(JSON.stringify({}));
      }
      const settingsCount = calls.filter(c => c.path.includes("/settings")).length;
      if (options.settingsEmptyThinkingAck && settingsCount >= 2) {
        return new Response(JSON.stringify({}));
      }
      if (options.settingsModelMismatchOnThinking && settingsCount >= 2) {
        sessionModels.set(sessionId, "gpt-5.6-luna");
        sessionEfforts.set(sessionId, body?.effort || "high");
        return new Response(JSON.stringify({
          id: sessionId,
          title: "新聊天",
          model: "gpt-5.6-luna",
          effort: body?.effort || "high",
        }));
      }
      if (body?.model) sessionModels.set(sessionId, body.model);
      if (body?.effort) sessionEfforts.set(sessionId, body.effort);
      return new Response(JSON.stringify({
        id: sessionId,
        title: "新聊天",
        model: sessionModels.get(sessionId),
        effort: sessionEfforts.get(sessionId),
      }));
    }
    if (path.includes("/send")) {
      const match = path.match(/\/api\/sessions\/([^/?]+)\/send/);
      const sessionId = match ? match[1] : "unknown";
      sentPrompts.push({
        sessionId,
        id: body?.id,
        text: body?.text,
        model: sessionModels.get(sessionId),
        effort: sessionEfforts.get(sessionId),
      });
      return new Response(JSON.stringify({ status: "accepted", id: body?.id }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  return { calls, sessionModels, sessionEfforts, sentPrompts };
}

test("1. catalog 默认 6.1 / native 默认 5.6: 未传 modelId 在 create 后确认为 6.1，随后真实 runtime.send 记录 6.1 与 high", async () => {
  const { calls, sessionModels, sentPrompts } = setupBridgeMock({ defaultCatalogModel: "gpt-6.1-sol" });

  const result = await createCodexSession("/home/koxir/Work", { type: "ensure_session" });

  assert.equal(result.success, true);
  assert.equal(result.model.modelId, "gpt-6.1-sol", "最终模型必须是 catalog default 6.1 而不是 native 5.6");
  const threadId = result.sessionId.replace(/^codex:/, "");
  assert.equal(sessionModels.get(threadId), "gpt-6.1-sol", "底层 session 实际模型状态必须确认为 6.1");

  const settingsCall = calls.find(c => c.path.includes("/settings") && c.body?.model);
  assert.ok(settingsCall, "必须向 bridge /settings 发送确认请求");
  assert.equal(settingsCall.body.model, "gpt-6.1-sol");

  const runtime = await getCodexRuntime(result.sessionId);
  await runtime.send({ type: "prompt", message: "hello codex", requestId: "req-1" });

  assert.equal(sentPrompts.length, 1, "真实 prompt 必须且只发送一次");
  assert.equal(sentPrompts[0].model, "gpt-6.1-sol", "发送时底层模型必须确认为 6.1");
  assert.equal(sentPrompts[0].effort, "high", "发送时底层 thinking 必须确认为 high");
});

test("2. 显式其他 model 和 low/off thinkingLevel 保留并在真实 runtime.send 中记录", async () => {
  // Case A: 显式 5.6-luna + low
  {
    const { sessionModels, sessionEfforts, sentPrompts } = setupBridgeMock({ defaultCatalogModel: "gpt-6.1-sol" });

    const result = await createCodexSession("/home/koxir/Work", {
      type: "ensure_session",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "low",
    });

    assert.equal(result.success, true);
    assert.equal(result.model.modelId, "gpt-5.6-luna", "显式 modelId 必须完整保留");
    assert.equal(result.thinkingLevel, "low", "显式 low thinkingLevel 必须完整保留");

    const threadId = result.sessionId.replace(/^codex:/, "");
    assert.equal(sessionModels.get(threadId), "gpt-5.6-luna");
    assert.equal(sessionEfforts.get(threadId), "low");

    const runtime = await getCodexRuntime(result.sessionId);
    await runtime.send({ type: "prompt", message: "explicit low prompt", requestId: "req-2a" });

    assert.equal(sentPrompts.length, 1);
    assert.equal(sentPrompts[0].model, "gpt-5.6-luna");
    assert.equal(sentPrompts[0].effort, "low");
  }

  // Case B: 显式 thinkingLevel: off -> effort: none
  {
    const { sessionEfforts, sentPrompts } = setupBridgeMock({ defaultCatalogModel: "gpt-6.1-sol" });

    const result = await createCodexSession("/home/koxir/Work", {
      type: "ensure_session",
      modelId: "gpt-6.1-sol",
      thinkingLevel: "off",
    });

    assert.equal(result.success, true);
    assert.equal(result.thinkingLevel, "off");
    const threadId = result.sessionId.replace(/^codex:/, "");
    assert.equal(sessionEfforts.get(threadId), "none");

    const runtime = await getCodexRuntime(result.sessionId);
    await runtime.send({ type: "prompt", message: "off prompt", requestId: "req-2b" });

    assert.equal(sentPrompts.length, 1);
    assert.equal(sentPrompts[0].effort, "none");
  }
});

test("3. 默认目录不可用或目录为空时，创建前 fail closed，创建会话次数为 0，发送数为 0", async () => {
  // Case A: catalog 失败
  {
    const { calls, sentPrompts } = setupBridgeMock({ catalogFails: true });

    await assert.rejects(
      async () => {
        await createCodexSession("/home/koxir/Work", { type: "ensure_session" });
      },
      /Codex 目录获取失败/,
    );

    const sessionCreates = calls.filter(c => c.path === "/api/sessions");
    assert.equal(sessionCreates.length, 0, "目录不可用时必须 fail closed，严禁调用 /api/sessions 创建孤立会话");
    assert.equal(sentPrompts.length, 0, "未创建会话严禁发送 prompt");
  }

  // Case B: catalog 返回 empty
  {
    const { calls, sentPrompts } = setupBridgeMock({ catalogEmpty: true });

    await assert.rejects(
      async () => {
        await createCodexSession("/home/koxir/Work", { type: "ensure_session" });
      },
      /Codex 目录无可用模型/,
    );

    const sessionCreates = calls.filter(c => c.path === "/api/sessions");
    assert.equal(sessionCreates.length, 0, "目录空时必须 fail closed，严禁创建孤立会话");
    assert.equal(sentPrompts.length, 0);
  }
});

test("4. confirm mismatch 与空 ACK 均拒绝，且 prompt 发送数为 0", async () => {
  // Case A: /settings 返回 500
  {
    const { sentPrompts } = setupBridgeMock({ settingsFails: true });
    await assert.rejects(
      async () => {
        await createCodexSession("/home/koxir/Work", { type: "ensure_session" });
      },
    );
    assert.equal(sentPrompts.length, 0, "settings 失败时 prompt 发送数为 0");
  }

  // Case B: /settings 返回空对象 ACK（model 未确认）
  {
    const { sentPrompts } = setupBridgeMock({ settingsEmptyModelAck: true });
    await assert.rejects(
      async () => {
        await createCodexSession("/home/koxir/Work", { type: "ensure_session" });
      },
      /Codex 模型设置未得到原生确认/,
    );
    assert.equal(sentPrompts.length, 0, "model 空对象 ACK 时 prompt 发送数为 0");
  }

  // Case C: model 确认但 thinking 返回空对象 ACK（thinking 未确认）
  {
    const { sentPrompts } = setupBridgeMock({ settingsEmptyThinkingAck: true });
    await assert.rejects(
      async () => {
        await createCodexSession("/home/koxir/Work", { type: "ensure_session" });
      },
      /Codex thinking level 设置未得到原生确认/,
    );
    assert.equal(sentPrompts.length, 0, "thinking 空对象 ACK 时 prompt 发送数为 0");
  }

  // Case D: thinking 响应把 model 回退导致 mismatch
  {
    const { sentPrompts } = setupBridgeMock({ settingsModelMismatchOnThinking: true });
    await assert.rejects(
      async () => {
        await createCodexSession("/home/koxir/Work", { type: "ensure_session" });
      },
      /Codex thinking level 设置未得到原生确认/,
    );
    assert.equal(sentPrompts.length, 0, "model 被回退 mismatch 时 prompt 发送数为 0");
  }
});

test("5. 延迟 settings gate: 未确认前 ensure 未 resolve 且 send 计数为 0，release 后真实 runtime.send 记录 6.1", async () => {
  let releaseGate;
  const settingsGate = new Promise((resolve) => { releaseGate = resolve; });
  const { sentPrompts } = setupBridgeMock({ defaultCatalogModel: "gpt-6.1-sol", settingsGate });

  let resolved = false;
  const ensurePromise = createCodexSession("/home/koxir/Work", { type: "ensure_session" }).then((res) => {
    resolved = true;
    return res;
  });

  // 延迟微任务以确认处于 pending
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false, "settings gate 未释放前，ensureSession 绝不能提前 resolve");
  assert.equal(sentPrompts.length, 0, "settings gate 未释放前，prompt 发送数必须为 0");

  // 释放 gate
  releaseGate();
  const session = await ensurePromise;
  assert.equal(session.success, true);
  assert.equal(session.model.modelId, "gpt-6.1-sol");

  const runtime = await getCodexRuntime(session.sessionId);
  await runtime.send({ type: "prompt", message: "send after release", requestId: "req-gate-1" });

  assert.equal(sentPrompts.length, 1);
  assert.equal(sentPrompts[0].model, "gpt-6.1-sol");
  assert.equal(sentPrompts[0].text, "send after release");
});

test("6. 不同 cwd 目录使用对应默认模型并成功发送 prompt", async () => {
  const { sessionModels, sentPrompts } = setupBridgeMock({ defaultCatalogModel: "gpt-6.1-sol" });

  // Workspace A -> gpt-6.1-sol
  const resA = await createCodexSession("/workspace/projA", { type: "ensure_session" });
  assert.equal(resA.model.modelId, "gpt-6.1-sol");
  assert.equal(sessionModels.get(resA.sessionId.replace(/^codex:/, "")), "gpt-6.1-sol");
  const runtimeA = await getCodexRuntime(resA.sessionId);
  await runtimeA.send({ type: "prompt", message: "A prompt", requestId: "req-A" });

  // Workspace B -> model-beta
  const resB = await createCodexSession("/workspace/projB", { type: "ensure_session" });
  assert.equal(resB.model.modelId, "model-beta");
  assert.equal(sessionModels.get(resB.sessionId.replace(/^codex:/, "")), "model-beta");
  const runtimeB = await getCodexRuntime(resB.sessionId);
  await runtimeB.send({ type: "prompt", message: "B prompt", requestId: "req-B" });

  assert.equal(sentPrompts.length, 2);
  assert.equal(sentPrompts[0].model, "gpt-6.1-sol");
  assert.equal(sentPrompts[1].model, "model-beta");
});
