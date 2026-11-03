import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentExtension, SUBAGENT_NOTIFICATION_PREFIX } = await jiti.import("./subagent-extension.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { SubagentQueue } = await jiti.import("./subagent-queue.ts");

/**
 * Isolates and restores subagent global state (__piSubagentQueue, __piSubagentRuns, __piSubagentConsumedResults).
 */
function isolateSubagentGlobals() {
  const hadQueue = Object.prototype.hasOwnProperty.call(globalThis, "__piSubagentQueue");
  const previousQueue = globalThis.__piSubagentQueue;
  const hadRuns = Object.prototype.hasOwnProperty.call(globalThis, "__piSubagentRuns");
  const previousRuns = globalThis.__piSubagentRuns;
  const hadConsumed = Object.prototype.hasOwnProperty.call(globalThis, "__piSubagentConsumedResults");
  const previousConsumed = globalThis.__piSubagentConsumedResults;

  const testQueue = new SubagentQueue();
  const testRuns = new Map();
  const testConsumed = new Set();

  globalThis.__piSubagentQueue = testQueue;
  globalThis.__piSubagentRuns = testRuns;
  globalThis.__piSubagentConsumedResults = testConsumed;

  return {
    testQueue,
    testRuns,
    testConsumed,
    restore() {
      if (hadQueue) {
        globalThis.__piSubagentQueue = previousQueue;
      } else {
        delete globalThis.__piSubagentQueue;
      }
      if (hadRuns) {
        globalThis.__piSubagentRuns = previousRuns;
      } else {
        delete globalThis.__piSubagentRuns;
      }
      if (hadConsumed) {
        globalThis.__piSubagentConsumedResults = previousConsumed;
      } else {
        delete globalThis.__piSubagentConsumedResults;
      }
    },
  };
}

/**
 * Resolves the real, live Gemini 3.8 Flash High model from the environment.
 * Fails closed without mocking if the model is unreachable.
 */
function resolveLiveGeminiModel(modelRuntime) {
  const model = modelRuntime.getModel("sub2api_cpa", "gemini-3.8-flash-high")
    || modelRuntime.getModel("cliproxyapi", "gemini-3.8-flash-high");
  if (!model) {
    throw new Error("Live Gemini 3.8 Flash High model not found in available providers (sub2api_cpa / cliproxyapi)");
  }
  return model;
}

function wrapSession(innerSession, sessionDir) {
  let alive = true;
  const sessionFile = innerSession.sessionFile
    || innerSession.sessionManager?.getSessionFile()
    || join(sessionDir, `${innerSession.sessionId}.jsonl`);
  return {
    inner: innerSession,
    sessionFile,
    cwd: sessionDir,
    isAlive: () => alive && !innerSession.isDisposed,
    isRunning: () => alive && Boolean(innerSession.isStreaming || innerSession.agent?.state?.isStreaming),
    waitUntilReady: async () => {},
    dispose: () => {
      alive = false;
      innerSession.dispose();
    },
  };
}

// -----------------------------------------------------------------------------
// Sequential test suite for live subagent lifecycle verification
// -----------------------------------------------------------------------------
test("live subagent lifecycle test suite", { concurrency: 1, timeout: 180000 }, async (t) => {
  // Test 1: Background start returns immediately, parent session proceeds concurrently
  await t.test("live: background start returns immediately and allows parent session to proceed concurrently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-live-subagent-bg-"));
    const globals = isolateSubagentGlobals();
    const sessions = new Map();
    let parentSession;

    try {
      const settingsManager = SettingsManager.create(dir, "/root/.pi/agent");
      const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
      const model = resolveLiveGeminiModel(modelRuntime);

      const controller = createSubagentController({
        getSession: (id) => sessions.get(id),
        registerSession: (inner) => {
          sessions.set(inner.sessionId, wrapSession(inner, dir));
        },
        reopenSession: async () => { throw new Error("reopen not expected in test"); },
        resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
        invalidateSessionList: () => {},
        isBuiltInSubagentsEnabled: () => true,
      });

      const services = await createAgentSessionServices({
        cwd: dir,
        agentDir: "/root/.pi/agent",
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          noExtensions: true,
        },
      });

      parentSession = (await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.create(dir),
        model,
      })).session;
      sessions.set(parentSession.sessionId, wrapSession(parentSession, dir));

      const tStart = Date.now();
      const execution = await controller.extensionRuntime.start({
        parentContext: {
          sessionManager: parentSession.sessionManager,
          toolCallId: "call-bg-start",
        },
        parentToolCallId: "call-bg-start",
        profile: "explore",
        task: "请计算 35 * 40 的结果，请只回复数字",
        description: "Live background multiplication",
        runInBackground: true,
        model: `${model.provider}/${model.id}`,
      });

      const launchElapsed = Date.now() - tStart;
      assert.ok(launchElapsed < 2500, `Background start must return quickly without waiting for inference (took ${launchElapsed}ms)`);
      assert.ok(execution.run.status === "queued" || execution.run.status === "running");

      // Parent session immediately prompts for its own turn without being blocked
      const parentPromptStart = Date.now();
      await parentSession.prompt("请只回复大写单词：READY");
      const parentPromptElapsed = Date.now() - parentPromptStart;
      const parentAnswer = parentSession.getLastAssistantText()?.trim();

      assert.equal(parentAnswer, "READY", "Parent session must complete prompt and receive expected answer concurrently");
      assert.ok(parentPromptElapsed > 0, "Parent prompt ran in real time");

      // Await background completion from the live model
      const childResult = await execution.completion;
      assert.equal(childResult.status, "completed");
      assert.ok(childResult.result, "Subagent result must not be empty");
      assert.match(childResult.result, /1400/, "Subagent calculation 35 * 40 = 1400 must be present");
    } finally {
      for (const s of sessions.values()) s.dispose?.();
      globals.restore();
      await rm(dir, { recursive: true, force: true });
      assert.equal(existsSync(dir), false, "Temporary test directory must be cleanly removed");
    }
  });

  // Test 2: In-flight status querying and disk persistence
  await t.test("live: background subagent status can be queried while running and reads from session on completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-live-subagent-query-"));
    const globals = isolateSubagentGlobals();
    const sessions = new Map();

    try {
      const settingsManager = SettingsManager.create(dir, "/root/.pi/agent");
      const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
      const model = resolveLiveGeminiModel(modelRuntime);

      const controller = createSubagentController({
        getSession: (id) => sessions.get(id),
        registerSession: (inner) => {
          sessions.set(inner.sessionId, wrapSession(inner, dir));
        },
        reopenSession: async () => { throw new Error("unused"); },
        resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
        invalidateSessionList: () => {},
        isBuiltInSubagentsEnabled: () => true,
      });

      const services = await createAgentSessionServices({
        cwd: dir,
        agentDir: "/root/.pi/agent",
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          noExtensions: true,
        },
      });

      const parentSession = (await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.create(dir),
        model,
      })).session;
      sessions.set(parentSession.sessionId, wrapSession(parentSession, dir));

      const execution = await controller.extensionRuntime.start({
        parentContext: {
          sessionManager: parentSession.sessionManager,
          toolCallId: "call-query-test",
        },
        parentToolCallId: "call-query-test",
        profile: "explore",
        task: "请只回复四个字：查询状态正常",
        description: "Live status check",
        runInBackground: true,
        model: `${model.provider}/${model.id}`,
      });

      // Query immediately while in-flight
      const inFlight = await controller.get(execution.run.sessionId);
      assert.ok(inFlight, "Subagent must be findable via controller.get while running");
      assert.equal(inFlight.sessionId, execution.run.sessionId);
      assert.equal(inFlight.parentSessionId, parentSession.sessionId);
      assert.ok(["queued", "running"].includes(inFlight.status));

      // Wait for completion
      const completed = await execution.completion;
      assert.equal(completed.status, "completed");

      // Query after completion from controller (persisted read from disk/cache)
      const afterCompletion = await controller.get(execution.run.sessionId);
      assert.ok(afterCompletion);
      assert.equal(afterCompletion.status, "completed");
      assert.ok(afterCompletion.completedAt);
      assert.match(afterCompletion.result ?? "", /查询状态正常/);

      // Verify disk persistence in the JSONL file
      const childSessionPath = sessions.get(execution.run.sessionId)?.sessionFile;
      assert.ok(childSessionPath && existsSync(childSessionPath), "Child session JSONL file must exist on disk");
      const jsonlContent = await readFile(childSessionPath, "utf8");
      assert.match(jsonlContent, /"customType":"pi-web:subagent"/);
      assert.match(jsonlContent, /"customType":"pi-web:subagent-status"/);
      assert.match(jsonlContent, /"customType":"pi-web:subagent-result"/);
    } finally {
      for (const s of sessions.values()) s.dispose?.();
      globals.restore();
      await rm(dir, { recursive: true, force: true });
      assert.equal(existsSync(dir), false);
    }
  });

  // Test 3: Actual formatted notification delivery to parent session
  await t.test("live: completed background subagent delivers actual formatted notification to parent session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-live-subagent-notify-"));
    const globals = isolateSubagentGlobals();
    const sessions = new Map();
    const deliveredNotifications = [];

    try {
      const settingsManager = SettingsManager.create(dir, "/root/.pi/agent");
      const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
      const model = resolveLiveGeminiModel(modelRuntime);

      const controller = createSubagentController({
        getSession: (id) => sessions.get(id),
        registerSession: (inner) => {
          sessions.set(inner.sessionId, wrapSession(inner, dir));
        },
        reopenSession: async () => { throw new Error("unused"); },
        resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
        invalidateSessionList: () => {},
        isBuiltInSubagentsEnabled: () => true,
      });

      const services = await createAgentSessionServices({
        cwd: dir,
        agentDir: "/root/.pi/agent",
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          noExtensions: true,
        },
      });

      const parentSession = (await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.create(dir),
        model,
      })).session;

      // Intercept sendCustomMessage to capture notification delivery
      const originalSendCustomMessage = parentSession.sendCustomMessage.bind(parentSession);
      parentSession.sendCustomMessage = async (msg, opts) => {
        deliveredNotifications.push({ msg, opts });
        return originalSendCustomMessage(msg, opts);
      };

      sessions.set(parentSession.sessionId, wrapSession(parentSession, dir));

      const execution = await controller.extensionRuntime.start({
        parentContext: {
          sessionManager: parentSession.sessionManager,
          toolCallId: "call-notify-test",
        },
        parentToolCallId: "call-notify-test",
        profile: "explore",
        task: "请只回复五个汉字：通知已收到",
        description: "Live notification test",
        runInBackground: true,
        model: `${model.provider}/${model.id}`,
      });

      // Wire up parent notification delivery exactly as subagent-extension.ts does
      void execution.completion.then(
        (run) => controller.extensionRuntime.notifyParent(run),
        (err) => console.error("Completion error:", err),
      );

      const childResult = await execution.completion;
      assert.equal(childResult.status, "completed");

      // Wait up to 5s for notification delivery to settle
      const deadline = Date.now() + 5000;
      while (deliveredNotifications.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.equal(deliveredNotifications.length, 1, "Parent session must receive exactly one notification");
      const { msg, opts } = deliveredNotifications[0];

      assert.equal(msg.customType, "pi-web:subagent-notification");
      assert.ok(msg.content.startsWith(SUBAGENT_NOTIFICATION_PREFIX));
      assert.match(msg.content, /通知已收到/);
      assert.equal(opts?.triggerTurn, true);
      assert.equal(opts?.deliverAs, "followUp");
      assert.equal(msg.details?.sessionId, execution.run.sessionId);
      assert.equal(msg.details?.status, "completed");
    } finally {
      for (const s of sessions.values()) s.dispose?.();
      globals.restore();
      await rm(dir, { recursive: true, force: true });
      assert.equal(existsSync(dir), false);
    }
  });

  // Test 4: Cancellation and memory cleanup
  await t.test("live: controller abort stops in-flight subagent and cleans up tracking memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-live-subagent-abort-"));
    const globals = isolateSubagentGlobals();
    const sessions = new Map();

    try {
      const settingsManager = SettingsManager.create(dir, "/root/.pi/agent");
      const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
      const model = resolveLiveGeminiModel(modelRuntime);

      const controller = createSubagentController({
        getSession: (id) => sessions.get(id),
        registerSession: (inner) => {
          sessions.set(inner.sessionId, wrapSession(inner, dir));
        },
        reopenSession: async () => { throw new Error("unused"); },
        resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
        invalidateSessionList: () => {},
        isBuiltInSubagentsEnabled: () => true,
      });

      const services = await createAgentSessionServices({
        cwd: dir,
        agentDir: "/root/.pi/agent",
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          noExtensions: true,
        },
      });

      const parentSession = (await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.create(dir),
        model,
      })).session;
      sessions.set(parentSession.sessionId, wrapSession(parentSession, dir));

      // Request a heavy generation so the run is active long enough to abort
      const execution = await controller.extensionRuntime.start({
        parentContext: {
          sessionManager: parentSession.sessionManager,
          toolCallId: "call-abort-test",
        },
        parentToolCallId: "call-abort-test",
        profile: "explore",
        task: "请详细阐述微积分基本定理的推导过程，包括柯西中值定理与黎曼积分的极限定义，篇幅不少于2000字",
        description: "Live abort check",
        runInBackground: true,
        model: `${model.provider}/${model.id}`,
      });

      // Poll briefly until the subagent is in running state
      for (let i = 0; i < 50; i++) {
        const s = await controller.get(execution.run.sessionId);
        if (s?.status === "running") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Verify it is registered in memory while running
      assert.equal(
        globalThis.__piSubagentRuns?.has(execution.run.sessionId),
        true,
        "In-flight subagent must be tracked in __piSubagentRuns",
      );

      // Abort the running subagent
      await controller.abort(execution.run.sessionId);

      const finalRun = await execution.completion;
      assert.equal(finalRun.status, "aborted");
      assert.ok(finalRun.completedAt);

      // Verify memory tracking is purged after completion
      assert.equal(
        globalThis.__piSubagentRuns?.has(execution.run.sessionId),
        false,
        "Subagent tracking must be removed from memory after abort settlement",
      );

      // Verify persisted result on disk
      const childSessionPath = sessions.get(execution.run.sessionId)?.sessionFile;
      assert.ok(childSessionPath && existsSync(childSessionPath));
      const jsonlContent = await readFile(childSessionPath, "utf8");
      assert.match(jsonlContent, /"customType":"pi-web:subagent-result"/);
      assert.match(jsonlContent, /"status":"aborted"/);
    } finally {
      for (const s of sessions.values()) s.dispose?.();
      globals.restore();
      await rm(dir, { recursive: true, force: true });
      assert.equal(existsSync(dir), false);
    }
  });
});
