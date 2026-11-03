import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

const waitFor = async (fn, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > until) assert.fail("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("target 159 authoritative task timing: follow-up consumption, steer immunity, get_state/connected consistency", { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-timing-"));
  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  const promptAGate = defer();
  const promptAStarted = defer();
  const followUpGate = defer();

  t.after(async () => {
    promptAGate.resolve();
    followUpGate.resolve();
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
    await rm(dir, { recursive: true, force: true });
  });

  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");

  const faux = fauxProvider({ models: [{ id: "fixture" }] });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model: faux.getModel("fixture"),
    tools: [],
    sessionManager: manager,
    settingsManager,
  });

  const wrapper = new AgentSessionWrapper(session);
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  wrapper.start();
  t.after(() => wrapper.destroy());

  const events = [];
  wrapper.onEvent((e) => events.push(e));

  faux.setResponses([
    async () => {
      promptAStarted.resolve();
      await promptAGate.promise;
      return fauxAssistantMessage("prompt A response");
    },
    fauxAssistantMessage("steer handled"),
    async () => {
      await followUpGate.promise;
      return fauxAssistantMessage("followUp B response");
    },
  ]);

  const reqA = "req-prompt-a-" + Date.now();
  const reqSteer = "req-steer-" + Date.now();
  const reqB = "req-followup-b-" + Date.now();

  const promptAPromise = wrapper.send({
    type: "prompt",
    message: "prompt A task",
    requestId: reqA,
  });

  await promptAStarted.promise;

  // 1. 验证 prompt A 运行期间的 timing
  const timingA = wrapper.getCurrentTaskTiming();
  assert.ok(timingA, "prompt A must establish currentTaskTiming");
  assert.equal(timingA.requestId, reqA);
  assert.equal(timingA.taskId, reqA);
  const startA = timingA.startedAt;
  assert.ok(startA > 0 && startA <= Date.now());

  // 验证 get_state 返回相同的 taskTiming
  const stateA = await wrapper.send({ type: "get_state" });
  assert.ok(stateA.taskTiming, "get_state must expose taskTiming during prompt A");
  assert.equal(stateA.taskTiming.requestId, reqA);
  assert.equal(stateA.taskTiming.startedAt, startA);

  // 2. 发送 steer：steering 绝对不重置当前任务计时
  await wrapper.send({
    type: "prompt",
    message: "steer guidance",
    streamingBehavior: "steer",
    requestId: reqSteer,
  });

  const timingAfterSteer = wrapper.getCurrentTaskTiming();
  assert.equal(timingAfterSteer.requestId, reqA, "steer must not replace prompt A task id");
  assert.equal(timingAfterSteer.startedAt, startA, "steer must not reset running timer");

  // 3. 人为制造排队延迟并排入 followUp B（模拟排队旧时间戳与等待）
  await new Promise((r) => setTimeout(r, 60));

  const followUpAdmission = wrapper.send({
    type: "prompt",
    message: "followUp B task",
    streamingBehavior: "followUp",
    requestId: reqB,
  });
  await followUpAdmission;

  // 实际把 B 已入队的 raw object timestamp 设为过去
  const bRawMsg = session.agent.followUpQueue.messages[0];
  assert.ok(bRawMsg, "B message must be queued in followUpQueue");
  const artificialOldTimestamp = Date.now() - 30000;
  bRawMsg.timestamp = artificialOldTimestamp;

  // 验证：排队中时，尚未消费，timing 仍属于正在运行的 prompt A，排队期间 clock 绝不重置
  const timingWhileQueued = wrapper.getCurrentTaskTiming();
  assert.equal(timingWhileQueued.requestId, reqA);
  assert.equal(timingWhileQueued.startedAt, startA);

  // 4. 记录放行时刻，放行 prompt A，让第一轮结束，触发 SDK 消费队列中的 followUp B
  const gateReleaseTime = Date.now();
  promptAGate.resolve();
  await promptAPromise;

  // 等待 followUp B 的 message_start 到达
  await waitFor(() => {
    return events.some(
      (e) => e.type === "message_start" && e.message?.role === "user" && e.taskTiming?.requestId === reqB
    );
  });

  // 验证：SDK 同一个 run 期间仅发射了 1 个 agent_start
  const agentStarts = events.filter((e) => e.type === "agent_start");
  assert.equal(agentStarts.length, 1, "SDK followUp consumption within the same run must have only 1 agent_start");

  // 验证：followUp B 消费时产生全新的 timing，startedAt 取实际消费时刻 Date.now()，而非排队旧 timestamp
  const timingB = wrapper.getCurrentTaskTiming();
  assert.ok(timingB, "followUp B must establish currentTaskTiming upon consumption");
  assert.equal(timingB.requestId, reqB);
  assert.equal(timingB.taskId, reqB);
  assert.ok(timingB.startedAt > startA, "followUp B startedAt must be strictly newer than prompt A");
  assert.ok(timingB.startedAt >= gateReleaseTime, "followUp B startedAt must be >= actual consumption gate release time");
  assert.ok(timingB.startedAt > artificialOldTimestamp, "followUp B startedAt must be actual consumption time, not queue timestamp");

  // 验证：get_state 暴露 followUp B 的相同 timing，多次读取幂等
  const stateB1 = await wrapper.send({ type: "get_state" });
  assert.equal(stateB1.taskTiming?.requestId, reqB);
  assert.equal(stateB1.taskTiming?.startedAt, timingB.startedAt);

  const stateB2 = await wrapper.send({ type: "get_state" });
  assert.equal(stateB2.taskTiming?.startedAt, timingB.startedAt, "get_state taskTiming must be idempotent");

  // 5. 验证 SSE 重连：createAgentEventStream 暴露 connected 权威 timing 快照
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    wrapper.sessionId,
    Promise.resolve(wrapper)
  );
  const reader = stream.getReader();
  let connectedData = null;
  const decoder = new TextDecoder();
  while (!connectedData) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.type === "connected") {
          connectedData = parsed;
          break;
        }
      }
    }
  }
  await reader.cancel();

  assert.ok(connectedData, "reconnecting client must receive connected snapshot");
  assert.equal(connectedData.isStreaming, true);
  assert.ok(connectedData.taskTiming, "connected snapshot must expose active taskTiming");
  assert.equal(connectedData.taskTiming.requestId, reqB);
  assert.equal(connectedData.taskTiming.startedAt, timingB.startedAt, "connected must reflect authoritative runtime timing without restarting");

  // 6. 放行 followUp B，等待全部任务完成变为 idle
  followUpGate.resolve();
  await waitFor(() => !wrapper.isRunning());

  // 验证：idle 状态下，getCurrentTaskTiming 为 null，get_state taskTiming 为 null，不会被旧 timer 复活
  assert.equal(wrapper.getCurrentTaskTiming(), null, "idle wrapper must not expose stale timing");
  const idleState = await wrapper.send({ type: "get_state" });
  assert.equal(idleState.taskTiming, null, "idle get_state must return null taskTiming");
});

test("target 159 authoritative task timing: tool loop immunity, redundant agent_start immunity, and Stop terminal cleanup", { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-timing-stop-"));
  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  const runningGate = defer();
  const runStarted = defer();

  t.after(async () => {
    runningGate.resolve();
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
    await rm(dir, { recursive: true, force: true });
  });

  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");

  const faux = fauxProvider({ models: [{ id: "fixture" }] });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  let toolExecuted = 0;
  const customTool = {
    name: "ping",
    label: "Ping",
    description: "Ping tool",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      toolExecuted++;
      return { content: [{ type: "text", text: "pong" }] };
    },
  };

  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    modelRuntime: runtime,
    model: faux.getModel("fixture"),
    tools: ["ping"],
    customTools: [customTool],
    sessionManager: manager,
    settingsManager,
  });

  const wrapper = new AgentSessionWrapper(session);
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  wrapper.start();
  t.after(() => wrapper.destroy());

  const events = [];
  wrapper.onEvent((e) => events.push(e));

  // 1. 设置模型响应：第一轮返回工具调用（触发真实 SDK tool loop），第二轮等待 gate（模拟长时运行与 Stop）
  // 死锁防护证据：若 faux gate 不看 abort signal，当 wrapper.abort() 在内部等待 run idle 时，两者互相等待将发生死锁
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ping", {}),
    ], { stopReason: "toolUse" }),
    async () => {
      runStarted.resolve();
      // 监听 abort 信号，避免 Stop 时 faux gate 未放行导致死锁
      const onAbort = () => runningGate.resolve();
      session.agent.signal?.addEventListener("abort", onAbort, { once: true });
      await runningGate.promise;
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);

  const reqId = "req-tool-loop-" + Date.now();
  const promptPromise = wrapper.send({
    type: "prompt",
    message: "tool loop task",
    requestId: reqId,
  });

  // 等待真实工具执行完成并进入第二轮
  await runStarted.promise;

  // 验证工具 loop 真实发生且工具事件 count > 0
  assert.ok(toolExecuted > 0, "custom tool must be executed by real SDK");
  const toolEvents = events.filter((e) => e.type.includes("tool"));
  assert.ok(toolEvents.length >= 2, "must receive real tool_execution_start and tool_execution_end events");

  const initialTiming = wrapper.getCurrentTaskTiming();
  assert.ok(initialTiming, "task timing must be active during run");
  const initialStart = initialTiming.startedAt;

  // 2. 模拟偶发重复 agent_start：通过真实的 agent listener callback 明确调用（非 optionalNoop）
  assert.ok(session.agent.listeners && session.agent.listeners.size > 0, "session.agent must have real listeners");
  for (const listener of session.agent.listeners) {
    listener({ type: "agent_start" });
  }
  const timingAfterAgentStart = wrapper.getCurrentTaskTiming();
  assert.equal(timingAfterAgentStart.startedAt, initialStart, "redundant agent_start must not reset task timing");

  // 3. 执行 Stop（abort）
  // 由于设置了 onAbort 释放 runningGate，Stop 能安全结束 native run 而绝不死锁
  await wrapper.send({ type: "abort" });
  runningGate.resolve();
  await promptPromise.catch(() => {});

  // 验证 Stop 真实终态清理 timing 为 null
  assert.equal(wrapper.getCurrentTaskTiming(), null, "Stop must immediately clear currentTaskTiming");
});
