import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createCollaborationExtension } from "./collaboration-extension.ts";
import {
  startCollaborationDispatcher,
  stopCollaborationDispatcher,
  COLLABORATION_MESSAGE_CUSTOM_TYPE,
} from "./collaboration-runtime.ts";
import { CollaborationStore } from "./collaboration-store.ts";

test("real SDK faux sessions: identity binding, mutual exclusion, and auto handoff resumption", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-sdk-"));
  const stateFile = path.join(dir, "state", "collaboration-locks.json");
  const store = new CollaborationStore({ stateFile });

  let session1, session2;
  let turnsSession1 = 0;
  let turnsSession2 = 0;
  const messagesSession2 = [];

  t.after(async () => {
    await stopCollaborationDispatcher();
    session1?.dispose();
    session2?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Setup isolated faux model runtime
  const model = {
    id: "faux-collab",
    name: "faux-collab",
    api: "openai-completions",
    provider: "collab-provider",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
    allowNetwork: false,
  });
  modelRuntime.registerProvider("collab-provider", {
    api: "openai-completions",
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    models: [model],
  });

  modelRuntime.streamSimple = (_model, _prompt) => {
    turnsSession2++;

    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "task turn complete" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      });
    });
    return stream;
  };

  const tools1 = new Map();
  const tools2 = new Map();

  const extension = createCollaborationExtension({ stateFile });

  const loader1 = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        const origRegister = pi.registerTool.bind(pi);
        pi.registerTool = (tool) => {
          tools1.set(tool.name, tool);
          return origRegister(tool);
        };
        return extension.factory(pi);
      },
    ],
  });
  await loader1.reload();

  const loader2 = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        const origRegister = pi.registerTool.bind(pi);
        pi.registerTool = (tool) => {
          tools2.set(tool.name, tool);
          return origRegister(tool);
        };
        return extension.factory(pi);
      },
    ],
  });
  await loader2.reload();

  // Create Session 1
  const manager1 = SessionManager.create(dir, path.join(dir, "sessions1"));
  manager1.appendMessage({ role: "user", content: "session1 initial prompt", timestamp: Date.now() });
  ({ session: session1 } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    modelRuntime,
    tools: [],
    sessionManager: manager1,
    resourceLoader: loader1,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  }));

  // Create Session 2
  const manager2 = SessionManager.create(dir, path.join(dir, "sessions2"));
  manager2.appendMessage({ role: "user", content: "session2 initial prompt", timestamp: Date.now() });
  ({ session: session2 } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    modelRuntime,
    tools: [],
    sessionManager: manager2,
    resourceLoader: loader2,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  }));

  // Bind extensions to dispatch session_start
  await session1.bindExtensions?.({ mode: "rpc" });
  await session2.bindExtensions?.({ mode: "rpc" });

  // Hook session2 events
  session2.subscribe((e) => {
    messagesSession2.push(e);
  });

  const lockTool1 = tools1.get("resource_lock");
  assert.ok(lockTool1, "resource_lock tool must be registered in session1");

  const lockTool2 = tools2.get("resource_lock");
  assert.ok(lockTool2, "resource_lock tool must be registered in session2");

  // 1. Session 1 acquires lock "source_addon"
  const acqRes1 = await lockTool1.execute(
    "call-1",
    {
      action: "acquire",
      resources: ["source_addon"],
      scope: "project",
    },
    new AbortController().signal,
    () => {},
    { sessionManager: manager1, cwd: dir },
  );

  assert.equal(acqRes1.details.status, "acquired");
  const token1 = acqRes1.details.token;
  const gen1 = acqRes1.details.generation;
  assert.ok(token1);
  assert.ok(gen1);

  // 2. Session 2 tries to acquire "source_addon" -> enters FIFO queue with resumeTask
  const acqRes2 = await lockTool2.execute(
    "call-2",
    {
      action: "acquire",
      resources: ["source_addon"],
      scope: "project",
      resumeTask: "完成测试与部署验收",
    },
    new AbortController().signal,
    () => {},
    { sessionManager: manager2, cwd: dir },
  );

  assert.equal(acqRes2.details.status, "queued");
  assert.equal(acqRes2.details.position, 1);

  // Verify status in store
  const stateMid = store.readState();
  const key = `proj:${dir}#source_addon`;
  assert.equal(stateMid.resources[key]?.status, "held");
  assert.equal(stateMid.resources[key]?.owner?.sessionId, session1.sessionId);
  assert.equal(stateMid.resources[key]?.queue?.length, 1);
  assert.equal(stateMid.resources[key]?.queue[0]?.sessionId, session2.sessionId);

  // 3. Start collaboration dispatcher
  const dispatcher = startCollaborationDispatcher({
    stateFile,
    pollIntervalMs: 50,
  });

  // 4. Session 1 releases lock
  const relRes1 = await lockTool1.execute(
    "call-3",
    {
      action: "release",
      token: token1,
      generation: gen1,
    },
    new AbortController().signal,
    () => {},
    { sessionManager: manager1, cwd: dir },
  );

  assert.equal(relRes1.details.status, "released");

  // 5. Trigger dispatcher scan and await Session 2 auto handoff
  await dispatcher.triggerScan();

  // Wait for Session 2 turn to complete
  const start = performance.now();
  while (performance.now() - start < 4000) {
    if (turnsSession2 >= 1 && !session2.isStreaming) {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  // 6. Assertions
  const finalState = store.readState();
  assert.equal(
    finalState.resources[key]?.status,
    "held",
    "Lock should now be held by Session 2 after handoff ack",
  );
  assert.equal(
    finalState.resources[key]?.owner?.sessionId,
    session2.sessionId,
    "Owner should be updated to Session 2",
  );
  assert.equal(finalState.consumedHandoffIds.length, 1);

  assert.ok(turnsSession2 >= 1, "Session 2 should have executed auto resumed model turn");

  const branch2 = manager2.getBranch();
  const wakeEntry = branch2.find((e) => String(JSON.stringify(e)).includes("完成测试与部署验收"));
  assert.ok(wakeEntry, "Session 2 branch should record collaboration wake entry");

  // 7. Session 2 releases using credentials received in handoff message details
  const receivedDetails = wakeEntry.details || wakeEntry.message?.details;
  assert.ok(receivedDetails?.token, "Handoff message must contain token");
  assert.ok(receivedDetails?.generation, "Handoff message must contain generation");

  const relRes2 = await lockTool2.execute(
    "call-release-2",
    {
      action: "release",
      token: receivedDetails.token,
      generation: receivedDetails.generation,
      resources: ["source_addon"],
    },
    new AbortController().signal,
    () => {},
    { sessionManager: manager2, cwd: dir },
  );
  assert.equal(relRes2.details.status, "released");
  const stateAfterRel2 = store.readState();
  assert.equal(stateAfterRel2.resources[key]?.status, undefined, "Resource should be freed after Session 2 releases");

  // 8. Stop dispatcher: verify no wakeups occur after stop
  await stopCollaborationDispatcher();
  const initialTurnsAfterStop = turnsSession2;

  // Session 1 acquires and Session 2 queues
  const acq1Again = await lockTool1.execute(
    "call-again-1",
    { action: "acquire", resources: ["source_addon"], scope: "project" },
    new AbortController().signal,
    () => {},
    { sessionManager: manager1, cwd: dir },
  );
  await lockTool2.execute(
    "call-again-2",
    { action: "acquire", resources: ["source_addon"], scope: "project", resumeTask: "停止后不应自动触发" },
    new AbortController().signal,
    () => {},
    { sessionManager: manager2, cwd: dir },
  );

  // Session 1 releases while dispatcher is stopped
  await lockTool1.execute(
    "call-rel-again",
    { action: "release", token: acq1Again.details.token, generation: acq1Again.details.generation },
    new AbortController().signal,
    () => {},
    { sessionManager: manager1, cwd: dir },
  );

  // Wait brief period: Session 2 must NOT have new turn triggered because dispatcher is stopped
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(turnsSession2, initialTurnsAfterStop, "Dispatcher stopped: must not wake session");

  // 9. Restart dispatcher: pending handoff should now resume Session 2!
  const restartedDispatcher = startCollaborationDispatcher({
    stateFile,
    pollIntervalMs: 50,
  });
  await restartedDispatcher.triggerScan();

  const startRestartWait = performance.now();
  while (performance.now() - startRestartWait < 3000) {
    if (turnsSession2 > initialTurnsAfterStop && !session2.isStreaming) {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(turnsSession2 > initialTurnsAfterStop, "After restarting dispatcher, Session 2 safely resumes");
  await stopCollaborationDispatcher();
});
