import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
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
 * Preserves pre-existing global references and their entries without mutating or clearing external state.
 */
function isolateSubagentGlobals() {
  const hadQueue = Object.prototype.hasOwnProperty.call(globalThis, "__piSubagentQueue");
  const previousQueue = globalThis.__piSubagentQueue;
  const hadRuns = Object.prototype.hasOwnProperty.call(globalThis, "__piSubagentRuns");
  const previousRuns = globalThis.__piSubagentRuns;
  const hadConsumed = Object.prototype.hasOwnProperty.call(globalThis, "__piSubagentConsumedResults");
  const previousConsumed = globalThis.__piSubagentConsumedResults;

  // Provide isolated test instances instead of mutating or calling .clear() on pre-existing instances
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

async function createParentSession(dir, faux, extensionFactories) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory(),
    modelRuntime,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(dir),
    model: faux.getModel("faux-model"),
  });
  return session;
}

// -----------------------------------------------------------------------------
// Test 1: Background start returns immediately, allowing controller to proceed
// -----------------------------------------------------------------------------
test("background start returns immediately and allows controller session to proceed without blocking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-bg-"));
  let session;
  let bgTaskReleased = false;
  let releaseBgTask;
  const bgCompletion = new Promise((resolve) => {
    releaseBgTask = () => {
      bgTaskReleased = true;
      resolve({
        sessionId: "child-bg-1",
        sessionPath: join(dir, "child-bg-1.jsonl"),
        parentSessionId: "parent-session",
        parentToolCallId: "call-agent-1",
        profile: "general-purpose",
        description: "Background calculation",
        task: "Compute primes",
        runInBackground: true,
        status: "completed",
        result: "Calculated primes",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:05.000Z",
      });
    };
  });

  // [Mock] Extension runtime mock simulating asynchronous background execution
  const mockRuntime = {
    async start(req) {
      return {
        run: {
          sessionId: "child-bg-1",
          sessionPath: join(dir, "child-bg-1.jsonl"),
          parentSessionId: "parent-session",
          parentToolCallId: req.parentToolCallId,
          profile: req.profile,
          description: req.description,
          task: req.task,
          runInBackground: Boolean(req.runInBackground),
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        completion: bgCompletion,
      };
    },
    async resume() { throw new Error("unused"); },
    async get() { return null; },
    async steer() { throw new Error("unused"); },
    async notifyParent() {},
    markResultConsumed() {},
  };

  const globals = isolateSubagentGlobals();
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    session = await createParentSession(dir, faux, [
      createSubagentExtension(
        mockRuntime,
        () => [{ name: "general-purpose", displayName: "General", description: "General", tools: [], enabled: true }],
      ),
    ]);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("Agent", {
          prompt: "Compute primes in background",
          description: "Primes computation",
          run_in_background: true,
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxText("Background subagent dispatched. Controller proceeds immediately."),
      ]),
    ]);

    await session.prompt("Run primes in background");

    assert.equal(bgTaskReleased, false, "Background task must still be running when controller prompt finishes");

    const toolResult = session.agent.state.messages.find(
      (m) => m.role === "toolResult" && m.toolName === "Agent",
    );
    assert.ok(toolResult, "Agent toolResult must be present");
    assert.equal(toolResult.isError, false);
    const contentText = toolResult.content.map((b) => b.text ?? "").join("");
    assert.match(contentText, /Subagent started in background\. Session ID: child-bg-1/);
    assert.equal(toolResult.details?.runInBackground, true);
    assert.equal(toolResult.details?.status, "running");

    const assistantMessages = session.agent.state.messages.filter((m) => m.role === "assistant");
    assert.equal(assistantMessages.length, 2, "Parent session should proceed to next assistant turn without waiting");
    const lastText = assistantMessages[1].content.map((b) => b.text ?? "").join("");
    assert.match(lastText, /Background subagent dispatched\. Controller proceeds immediately/);
  } finally {
    releaseBgTask?.();
    session?.dispose();
    globals.restore();
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, "Temporary test directory must be removed");
  }
});

// -----------------------------------------------------------------------------
// Test 2: Completed subagent delivers positive notification to parent
// -----------------------------------------------------------------------------
test("completed background subagent delivers positive notification to parent with customType, prefix, and triggerTurn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-notify-positive-"));
  const delivered = [];

  // [Mock] Parent session mock with custom message delivery recorder
  const mockParentSession = {
    cwd: dir,
    sessionFile: join(dir, "parent.jsonl"),
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (msg, opts) => delivered.push({ msg, opts }),
    },
  };

  // [Mock] Controller dependencies providing mock parent session
  const controller = createSubagentController({
    getSession: (id) => (id === "parent-session" ? mockParentSession : null),
    registerSession: () => {},
    reopenSession: async () => mockParentSession,
    resolveSessionPath: async () => mockParentSession.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });

  const completedRun = {
    sessionId: "child-positive-1",
    sessionPath: join(dir, "child-positive-1.jsonl"),
    parentSessionId: "parent-session",
    parentToolCallId: "call-positive-1",
    profile: "general-purpose",
    description: "Positive notification delivery check",
    task: "Analyze system diagnostics",
    runInBackground: true,
    status: "completed",
    result: "Analysis complete: all diagnostics healthy.",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
  };

  const globals = isolateSubagentGlobals();
  try {
    // Notify parent when result was NOT collected via get_subagent_result beforehand
    await controller.extensionRuntime.notifyParent(completedRun);

    assert.equal(delivered.length, 1, "Notification must be delivered to parent session exactly once");

    const { msg, opts } = delivered[0];

    // Assert customType契约: must be "pi-web:subagent-notification"
    assert.equal(
      msg.customType,
      "pi-web:subagent-notification",
      "Notification must carry customType 'pi-web:subagent-notification'",
    );

    // Assert prefix契约: must start with SUBAGENT_NOTIFICATION_PREFIX to prevent compaction attribution (#875)
    assert.ok(
      msg.content.startsWith(SUBAGENT_NOTIFICATION_PREFIX),
      "Notification text must start with SUBAGENT_NOTIFICATION_PREFIX",
    );
    assert.match(
      msg.content,
      /Subagent child-positive-1 completed\.\n\nAnalysis complete: all diagnostics healthy\./,
    );

    // Assert triggerTurn契约: must trigger a follow-up turn on the parent session
    assert.equal(
      opts?.triggerTurn,
      true,
      "Notification delivery must set triggerTurn: true to prompt parent follow-up turn",
    );
    assert.equal(
      opts?.deliverAs,
      "followUp",
      "Notification delivery must specify deliverAs: 'followUp'",
    );

    // Assert tool details payload
    assert.equal(msg.details?.sessionId, "child-positive-1");
    assert.equal(msg.details?.status, "completed");
  } finally {
    globals.restore();
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  }
});

// -----------------------------------------------------------------------------
// Test 3: get_subagent_result marks result consumed and suppresses duplicate completion notifications
// -----------------------------------------------------------------------------
test("get_subagent_result marks result consumed and suppresses duplicate completion notifications", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-dedup-"));
  let session;
  const consumedMarks = [];
  const delivered = [];

  const completedRun = {
    sessionId: "child-dedup-1",
    sessionPath: join(dir, "child-dedup-1.jsonl"),
    parentSessionId: "parent-session",
    parentToolCallId: "call-dedup",
    profile: "general-purpose",
    description: "Inspect DB",
    task: "Inspect DB",
    runInBackground: true,
    status: "completed",
    result: "DB check: healthy",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:02.000Z",
  };

  // [Mock] Parent session mock with custom message delivery recorder
  const parentSession = {
    cwd: dir,
    sessionFile: join(dir, "parent.jsonl"),
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (msg, opts) => delivered.push({ msg, opts }),
    },
  };

  // [Mock] Controller dependencies providing mock parent session
  const controller = createSubagentController({
    getSession: () => parentSession,
    registerSession: () => {},
    reopenSession: async () => parentSession,
    resolveSessionPath: async () => parentSession.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });

  // [Mock] Extension runtime mock delegating to controller while spying on markResultConsumed
  const mockRuntime = {
    ...controller.extensionRuntime,
    async get(id) {
      if (id === completedRun.sessionId) return completedRun;
      return null;
    },
    markResultConsumed(id) {
      consumedMarks.push(id);
      controller.extensionRuntime.markResultConsumed(id);
    },
  };

  const globals = isolateSubagentGlobals();
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    session = await createParentSession(dir, faux, [
      createSubagentExtension(
        mockRuntime,
        () => [{ name: "general-purpose", displayName: "General", description: "General", tools: [], enabled: true }],
      ),
    ]);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("get_subagent_result", { agent_id: "child-dedup-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxText("Received subagent output."),
      ]),
    ]);

    await session.prompt("Check status of child-dedup-1");

    const toolResult = session.agent.state.messages.find(
      (m) => m.role === "toolResult" && m.toolName === "get_subagent_result",
    );
    assert.ok(toolResult);
    assert.equal(toolResult.isError, false);
    const resultText = toolResult.content.map((b) => b.text ?? "").join("");
    assert.match(resultText, /Subagent child-dedup-1 completed\.\n\nDB check: healthy/);

    assert.deepEqual(consumedMarks, ["child-dedup-1"]);

    await controller.extensionRuntime.notifyParent(completedRun);

    assert.equal(delivered.length, 0, "Notification must be dropped because result was consumed");
  } finally {
    session?.dispose();
    globals.restore();
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  }
});

// -----------------------------------------------------------------------------
// Test 4: Racing notification held for running parent drops once consumed
// -----------------------------------------------------------------------------
test("racing notification waiting on busy parent drops notification once consumed during turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-race-"));
  const delivered = [];
  let isParentRunning = true;

  // [Mock] Parent session mock simulating busy running state
  const parent = {
    cwd: dir,
    sessionFile: join(dir, "parent.jsonl"),
    isAlive: () => true,
    isRunning: () => isParentRunning,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (msg, opts) => delivered.push({ msg, opts }),
    },
  };

  // [Mock] Controller dependencies providing mock busy parent
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async () => parent,
    resolveSessionPath: async () => parent.sessionFile,
    invalidateSessionList: () => {},
  });

  const run = {
    sessionId: "child-race-1",
    sessionPath: join(dir, "child-race-1.jsonl"),
    parentSessionId: "parent",
    parentToolCallId: "call-race",
    profile: "general-purpose",
    description: "Race check",
    task: "Heavy task",
    runInBackground: true,
    status: "completed",
    result: "Race outcome",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };

  const globals = isolateSubagentGlobals();
  try {
    const notifyPromise = controller.extensionRuntime.notifyParent(run);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(delivered.length, 0, "Notification must wait while parent is running");

    controller.extensionRuntime.markResultConsumed(run.sessionId);

    isParentRunning = false;
    await notifyPromise;

    assert.equal(delivered.length, 0, "Notification must be dropped because parent consumed result during turn");
  } finally {
    globals.restore();
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  }
});

// -----------------------------------------------------------------------------
// Test 5: Subagent queue FIFO execution and queued cancellation without starting
// -----------------------------------------------------------------------------
test("subagent queue FIFO execution and queued cancellation without starting", async () => {
  const queue = new SubagentQueue();
  const stateTransitions = [];
  let firstStarted = false;
  let secondStarted = false;
  let releaseFirst;

  const firstPromise = new Promise((resolve) => {
    releaseFirst = () => resolve("first result");
  });

  const first = queue.enqueue(
    "parent-session",
    1,
    async () => {
      firstStarted = true;
      return await firstPromise;
    },
    (state) => stateTransitions.push(["first", state]),
  );

  let secondCancelled = false;
  const second = queue.enqueue(
    "parent-session",
    1,
    async () => {
      secondStarted = true;
      return "second result";
    },
    (state) => stateTransitions.push(["second", state]),
    () => { secondCancelled = true; },
  );

  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);
  assert.deepEqual(stateTransitions, [
    ["first", "queued"],
    ["first", "running"],
    ["second", "queued"],
  ]);

  const cancelled = second.cancel();
  assert.equal(cancelled, true);
  assert.equal(secondCancelled, true);

  releaseFirst();
  assert.equal(await first.promise, "first result");

  const secondVal = await second.promise;
  assert.equal(secondVal, undefined);
  assert.equal(secondStarted, false, "Cancelled queued subagent must never run");
});

// -----------------------------------------------------------------------------
// Test 6: Controller abort cancels queued subagent and records aborted entry
// -----------------------------------------------------------------------------
test("controller abort cancels queued subagent and records aborted entry in session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-abort-queued-"));
  const entries = [
    {
      type: "custom",
      customType: "pi-web:subagent",
      data: {
        version: 1,
        parentSessionId: "parent-session",
        parentSessionPath: join(dir, "parent.jsonl"),
        parentToolCallId: "call-queued",
        profile: "builder",
        description: "Task Queued",
        task: "Build Queued",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
      },
    },
    {
      type: "custom",
      customType: "pi-web:subagent-result",
      data: { version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
    },
  ];

  let childPromptExecuted = false;
  // [Mock] Child session mock recording entry append and abort behavior
  const childInner = {
    sessionId: "child-q1",
    sessionFile: join(dir, "child-1.jsonl"),
    sessionManager: {
      getEntries: () => entries,
      appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    },
    prompt: async () => { childPromptExecuted = true; },
    getLastAssistantText: () => undefined,
    abort: async () => {},
  };

  const wrap = (inner) => ({
    inner,
    sessionFile: inner.sessionFile,
    cwd: dir,
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  });

  // [Mock] Parent session mock
  const parent = {
    inner: { sessionManager: { getSessionId: () => "parent-session" } },
    sessionFile: join(dir, "parent.jsonl"),
    cwd: dir,
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  };

  const sessions = new Map([
    ["child-q1", wrap(childInner)],
    ["parent-session", parent],
  ]);

  // Isolate global state to preserve external state without clearing
  const globals = isolateSubagentGlobals();
  const testQueue = globals.testQueue;

  // Enqueue blockers up to maxConcurrent limit (10) so the subsequent child enters "queued"
  let releaseBlockers;
  const blockerPromise = new Promise((resolve) => { releaseBlockers = resolve; });
  for (let i = 0; i < 10; i++) {
    testQueue.enqueue("parent-session", 10, () => blockerPromise, () => {});
  }

  // [Mock] Controller dependencies providing mock sessions
  const controller = createSubagentController({
    getSession: (id) => sessions.get(id),
    registerSession: () => {},
    reopenSession: async (id) => sessions.get(id),
    resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });

  try {
    const execution = await controller.extensionRuntime.resume({
      parentContext: parent.inner,
      parentToolCallId: "call-resume",
      sessionId: "child-q1",
      task: "task queued",
      description: "description queued",
    });

    assert.equal(execution.run.status, "queued");

    const queuedEntry = entries.find(
      (e) => e.customType === "pi-web:subagent-status" && e.data?.status === "queued",
    );
    assert.ok(queuedEntry, "Queued status entry must be appended to session");

    // Abort the queued subagent
    await controller.abort("child-q1");

    const result = await execution.completion;
    assert.equal(result.status, "aborted");
    assert.ok(result.completedAt);

    const abortedEntry = entries.at(-1);
    assert.equal(abortedEntry?.customType, "pi-web:subagent-result");
    assert.equal(abortedEntry?.data?.status, "aborted");

    assert.equal(childPromptExecuted, false, "Aborted queued subagent prompt must never execute");
  } finally {
    releaseBlockers?.();
    globals.restore();
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  }
});

// -----------------------------------------------------------------------------
// Test 7: Controller abort stops running subagent and marks execution as aborted
// -----------------------------------------------------------------------------
test("controller abort stops running subagent and marks execution as aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-abort-running-"));
  const entries = [
    {
      type: "custom",
      customType: "pi-web:subagent",
      data: {
        version: 1,
        parentSessionId: "parent-session",
        parentSessionPath: join(dir, "parent.jsonl"),
        parentToolCallId: "call-run",
        profile: "builder",
        description: "Task running",
        task: "Build running",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
      },
    },
    {
      type: "custom",
      customType: "pi-web:subagent-result",
      data: { version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
    },
  ];

  let childRunning = false;
  let childAborted = false;
  let childPromptReject;
  // [Mock] Child session mock simulating active running prompt with abort handler
  const childInner = {
    sessionId: "child-running-1",
    sessionFile: join(dir, "child.jsonl"),
    sessionManager: {
      getEntries: () => entries,
      appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    },
    prompt: async () => {
      childRunning = true;
      return new Promise((_, reject) => {
        childPromptReject = reject;
      });
    },
    getLastAssistantText: () => undefined,
    abort: async () => {
      childAborted = true;
      childRunning = false;
      childPromptReject?.(new Error("Operation aborted"));
    },
  };

  const child = {
    inner: childInner,
    sessionFile: childInner.sessionFile,
    cwd: dir,
    isAlive: () => true,
    isRunning: () => childRunning,
    waitUntilReady: async () => {},
  };

  // [Mock] Parent session mock
  const parent = {
    inner: { sessionManager: { getSessionId: () => "parent-session" } },
    sessionFile: join(dir, "parent.jsonl"),
    cwd: dir,
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  };

  // Isolate global state to preserve external state without clearing
  const globals = isolateSubagentGlobals();

  // [Mock] Controller dependencies providing mock child and parent
  const controller = createSubagentController({
    getSession: (id) => id === "child-running-1" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });

  try {
    const execution = await controller.extensionRuntime.resume({
      parentContext: parent.inner,
      parentToolCallId: "call-resume-run",
      sessionId: "child-running-1",
      task: "continue task",
      description: "continue task",
    });

    // Wait until subagent prompt is active
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(child.isRunning(), true, "Subagent must be in running state");

    // Abort the running subagent
    await controller.abort("child-running-1");
    assert.equal(childAborted, true, "Inner session abort must be invoked");

    const result = await execution.completion;
    assert.equal(result.status, "aborted");
    assert.ok(result.completedAt);

    const abortedEntry = entries.at(-1);
    assert.equal(abortedEntry?.customType, "pi-web:subagent-result");
    assert.equal(abortedEntry?.data?.status, "aborted");
  } finally {
    globals.restore();
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  }
});

// -----------------------------------------------------------------------------
// Test 8: Lifecycle completion cleans up run tracking from active runs map
// -----------------------------------------------------------------------------
test("lifecycle completion cleans up subagent run tracking from memory and allows retrieval from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-cleanup-"));
  const entries = [
    {
      type: "custom",
      customType: "pi-web:subagent",
      data: {
        version: 1,
        parentSessionId: "parent-session",
        parentSessionPath: join(dir, "parent.jsonl"),
        parentToolCallId: "call-clean",
        profile: "builder",
        description: "Task cleanup",
        task: "Build cleanup",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
      },
    },
    {
      type: "custom",
      customType: "pi-web:subagent-result",
      data: { version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "Clean result" },
    },
  ];

  let releasePrompt;
  // [Mock] Child session mock simulating completion on prompt release
  const childInner = {
    sessionId: "child-clean-1",
    sessionFile: join(dir, "child.jsonl"),
    sessionManager: {
      getEntries: () => entries,
      appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    },
    prompt: async () => new Promise((resolve) => { releasePrompt = resolve; }),
    getLastAssistantText: () => "Completed cleanly",
    abort: async () => {},
  };

  const child = {
    inner: childInner,
    sessionFile: childInner.sessionFile,
    cwd: dir,
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  };

  // [Mock] Parent session mock
  const parent = {
    inner: { sessionManager: { getSessionId: () => "parent-session" } },
    sessionFile: join(dir, "parent.jsonl"),
    cwd: dir,
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  };

  // Isolate global state to preserve external state without clearing
  const globals = isolateSubagentGlobals();

  // [Mock] Controller dependencies providing mock child and parent
  const controller = createSubagentController({
    getSession: (id) => id === "child-clean-1" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });

  try {
    const execution = await controller.extensionRuntime.resume({
      parentContext: parent.inner,
      parentToolCallId: "call-resume-clean",
      sessionId: "child-clean-1",
      task: "finish task",
      description: "finish task",
    });

    // Subagent is now executing in-flight: should be tracked in memory
    assert.equal(
      globalThis.__piSubagentRuns?.has("child-clean-1"),
      true,
      "Active subagent run must be registered in memory while running",
    );

    // Release the prompt to let execution finish
    releasePrompt();
    const result = await execution.completion;
    assert.equal(result.status, "completed");

    // Memory tracking must be cleaned up after completion
    assert.equal(
      globalThis.__piSubagentRuns?.has("child-clean-1"),
      false,
      "Finished subagent run must be removed from active runs map",
    );

    // Later retrieval retrieves the persisted terminal run from session entries
    const retrieved = await controller.get("child-clean-1");
    assert.ok(retrieved);
    assert.equal(retrieved.status, "completed");
    assert.equal(retrieved.result, "Completed cleanly");
  } finally {
    releasePrompt?.();
    globals.restore();
    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  }
});

// -----------------------------------------------------------------------------
// Test 9: Global state isolation helper preserves pre-existing globals without clearing
// -----------------------------------------------------------------------------
test("global state isolation helper preserves pre-existing global references and contents without clearing", () => {
  const sentinelRun = { sessionId: "external-run-id" };
  const externalRuns = new Map([["external-run-id", sentinelRun]]);
  const externalQueue = new SubagentQueue();
  const externalConsumed = new Set(["consumed-external"]);

  globalThis.__piSubagentRuns = externalRuns;
  globalThis.__piSubagentQueue = externalQueue;
  globalThis.__piSubagentConsumedResults = externalConsumed;

  const isolation = isolateSubagentGlobals();
  try {
    assert.notEqual(globalThis.__piSubagentRuns, externalRuns);
    assert.notEqual(globalThis.__piSubagentQueue, externalQueue);
    assert.notEqual(globalThis.__piSubagentConsumedResults, externalConsumed);
    assert.equal(globalThis.__piSubagentRuns.size, 0);

    // Simulate test adding items to the isolated environment
    globalThis.__piSubagentRuns.set("test-child", { sessionId: "test-child" });
    globalThis.__piSubagentConsumedResults.add("test-child");
  } finally {
    isolation.restore();
  }

  // Pre-existing objects and their contents must be fully intact
  assert.equal(globalThis.__piSubagentRuns, externalRuns);
  assert.equal(globalThis.__piSubagentRuns.has("external-run-id"), true);
  assert.equal(globalThis.__piSubagentRuns.has("test-child"), false);
  assert.equal(globalThis.__piSubagentRuns.get("external-run-id"), sentinelRun);
  assert.equal(globalThis.__piSubagentQueue, externalQueue);
  assert.equal(globalThis.__piSubagentConsumedResults, externalConsumed);
  assert.equal(globalThis.__piSubagentConsumedResults.has("consumed-external"), true);
  assert.equal(globalThis.__piSubagentConsumedResults.has("test-child"), false);

  // Clean up test fixture
  delete globalThis.__piSubagentRuns;
  delete globalThis.__piSubagentQueue;
  delete globalThis.__piSubagentConsumedResults;
});
