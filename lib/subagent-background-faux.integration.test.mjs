import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_ROOT = resolve(process.env.PI_WEB_CANDIDATE_ROOT ?? (() => {
  const parent = resolve(TEST_DIR, "..");
  if (existsSync(join(parent, "lib", "subagent-runtime.ts"))) return parent;
  return resolve(TEST_DIR, "../candidate");
})());
const CANDIDATE_NODE_MODULES = join(CANDIDATE_ROOT, "node_modules");
const { createJiti } = await import(pathToFileURL(join(CANDIDATE_NODE_MODULES, "jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works": join(CANDIDATE_NODE_MODULES, "@earendil-works"),
    "typebox": join(CANDIDATE_NODE_MODULES, "typebox/build/index.mjs"),
    "js-yaml": join(CANDIDATE_NODE_MODULES, "js-yaml"),
  },
});
const [piAi, piCodingAgent] = await Promise.all([
  import(pathToFileURL(join(CANDIDATE_NODE_MODULES, "@earendil-works/pi-ai/dist/index.js"))),
  import(pathToFileURL(join(CANDIDATE_NODE_MODULES, "@earendil-works/pi-coding-agent/dist/index.js"))),
]);
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = piAi;
const {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = piCodingAgent;
const [{ createSubagentController }, { createSubagentExtension }, { listSubagentProfiles }, { SubagentQueue }, { readSubagentSettings }] = await Promise.all([
  jiti.import(join(CANDIDATE_ROOT, "lib/subagent-runtime.ts")),
  jiti.import(join(CANDIDATE_ROOT, "lib/subagent-extension.ts")),
  jiti.import(join(CANDIDATE_ROOT, "lib/subagents.ts")),
  jiti.import(join(CANDIDATE_ROOT, "lib/subagent-queue.ts")),
  jiti.import(join(CANDIDATE_ROOT, "lib/subagent-settings.ts")),
]);
const { SUBAGENT_NOTIFICATION_PREFIX } = await jiti.import(join(CANDIDATE_ROOT, "lib/subagent-extension.ts"));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitFor(read, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return block.thinking;
    if (block.type === "toolCall") return JSON.stringify({ name: block.name, arguments: block.arguments });
    return "";
  }).join("\n");
}

function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return "";
}

function hasToolResultAfterLastUser(messages, toolName) {
  return countToolResultsAfterLastUser(messages, toolName) > 0;
}

function countToolResultsAfterLastUser(messages, toolName) {
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") lastUserIndex = index;
  }
  return messages.slice(lastUserIndex + 1).filter(
    (message) => message?.role === "toolResult" && message.toolName === toolName,
  ).length;
}

function lastToolResult(session, toolName) {
  const matches = session.agent.state.messages.filter(
    (message) => message?.role === "toolResult" && message.toolName === toolName,
  );
  return matches.length ? messageText(matches[matches.length - 1]) : "";
}

function toolTranscript(session) {
  return session.agent.state.messages.flatMap((message) => {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      return message.content.filter((block) => block?.type === "toolCall").map((block) => ({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      }));
    }
    if (message?.role === "toolResult") {
      return [{
        type: "toolResult",
        id: message.toolCallId,
        name: message.toolName,
        text: messageText(message).slice(0, 180),
      }];
    }
    return [];
  });
}

function isolateSubagentGlobals() {
  const names = ["__piSubagentQueue", "__piSubagentRuns", "__piSubagentConsumedResults"];
  const previous = names.map((name) => ({
    name,
    had: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: globalThis[name],
  }));
  globalThis.__piSubagentQueue = new SubagentQueue();
  globalThis.__piSubagentRuns = new Map();
  globalThis.__piSubagentConsumedResults = new Set();
  return () => {
    for (const item of previous) {
      if (item.had) globalThis[item.name] = item.value;
      else delete globalThis[item.name];
    }
  };
}

function wrapSession(inner, cwd) {
  return {
    inner,
    sessionFile: inner.sessionFile ?? inner.sessionManager.getSessionFile() ?? "",
    cwd,
    isAlive: () => !inner.isDisposed,
    isRunning: () => Boolean(inner.isStreaming || inner.agent?.state?.isStreaming),
    waitUntilReady: async () => {},
  };
}

async function createHarness(faux, maxConcurrent = 1) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-faux-"));
  const agentDir = join(root, "agent");
  const priorEnv = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    offline: process.env.PI_OFFLINE,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const restoreGlobals = isolateSubagentGlobals();
  const sessions = new Map();
  let parentSession;
  let modelRuntime;

  const cleanup = async () => {
    for (const host of sessions.values()) host.inner.dispose();
    restoreGlobals();
    if (priorEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorEnv.agentDir;
    if (priorEnv.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = priorEnv.offline;
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, "isolated agent directory must be removed");
  };

  try {
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(join(agentDir, "extensions", "subagent"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "subagent", "index.ts"), "export default function () {}\n");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      extensions: ["-extensions/subagent/index.ts"],
    }, null, 2));
    await writeFile(join(agentDir, "agents", "settings.json"), JSON.stringify({
      version: 1,
      builtInEnabled: true,
      maxConcurrent,
    }, null, 2));
    assert.equal(readSubagentSettings().maxConcurrent, maxConcurrent,
      "the real subagent runtime must read the isolated queue limit");

    modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const fakeModel = modelRuntime.getModel("faux", "faux-model");
    assert.ok(fakeModel, "isolated runtime must resolve only the Faux Provider model");

    const controller = createSubagentController({
      getSession: (sessionId) => sessions.get(sessionId),
      registerSession: (inner) => sessions.set(inner.sessionId, wrapSession(inner, root)),
      reopenSession: async () => { throw new Error("reopening an isolated test session was not expected"); },
      resolveSessionPath: async (sessionId) => sessions.get(sessionId)?.sessionFile ?? null,
      invalidateSessionList: () => {},
    });
    const extension = createSubagentExtension(
      controller.extensionRuntime,
      () => listSubagentProfiles(root),
    );
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.create(root, agentDir),
      modelRuntime,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension],
      },
    });
    parentSession = (await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(root),
      model: fakeModel,
    })).session;
    sessions.set(parentSession.sessionId, wrapSession(parentSession, root));

    assert.equal(parentSession.model.provider, "faux");
    const loadedExtensionPaths = services.resourceLoader.getExtensions().extensions
      .map((extension) => extension.path.replaceAll("\\", "/"));
    assert.ok(!loadedExtensionPaths.some((path) => path.includes("/extensions/subagent/")),
      `the exact user extension exclusion must prevent loading the legacy extension; loaded: ${loadedExtensionPaths.join(", ")}`);
    const activeToolNames = parentSession.getActiveToolNames();
    for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) {
      assert.ok(activeToolNames.includes(name), `${name} must be registered in the real Pi session`);
    }
    assert.ok(!activeToolNames.includes("subagent"), "the legacy subagent tool must not remain as a second entry point");
    return { root, agentDir, sessions, controller, parentSession, modelRuntime, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("real Pi sessions run background Agent, continue the parent, query, notify, and persist retrieval", { timeout: 30000 }, async () => {
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const childStarted = deferred();
  const releaseChild = deferred();
  const notificationSeen = deferred();
  const notifications = [];
  let childResultText;
  const respond = async (context) => {
    const messages = context.messages ?? [];
    const userText = latestUserText(messages);

    if (userText.includes("CHILD_TASK_BACKGROUND_TOKEN")) {
      childStarted.resolve();
      await releaseChild.promise;
      return fauxAssistantMessage(fauxText("CHILD_RESULT_BACKGROUND_TOKEN"));
    }
    if (userText.includes(SUBAGENT_NOTIFICATION_PREFIX)) {
      notifications.push(userText);
      notificationSeen.resolve(userText);
      return fauxAssistantMessage(fauxText("PARENT_RECEIVED_BACKGROUND_NOTIFICATION"));
    }
    if (userText.includes("START_BACKGROUND_TOKEN")) {
      if (hasToolResultAfterLastUser(messages, "Agent")) {
        return fauxAssistantMessage(fauxText("PARENT_CONTINUED_WHILE_CHILD_RUNNING"));
      }
      return fauxAssistantMessage(fauxToolCall("Agent", {
        subagent_type: "explore",
        prompt: "CHILD_TASK_BACKGROUND_TOKEN: return CHILD_RESULT_BACKGROUND_TOKEN",
        description: "Faux background lifecycle",
        run_in_background: true,
        model: "faux/faux-model",
      }), { stopReason: "toolUse" });
    }
    if (userText.includes("QUERY_IN_FLIGHT_TOKEN")) {
      if (hasToolResultAfterLastUser(messages, "get_subagent_result")) {
        return fauxAssistantMessage(fauxText("PARENT_QUERY_COMPLETED"));
      }
      return fauxAssistantMessage(fauxToolCall("get_subagent_result", {
        agent_id: globalThis.__fauxBackgroundSessionId,
      }), { stopReason: "toolUse" });
    }
    if (userText.includes("QUERY_TERMINAL_TOKEN")) {
      if (hasToolResultAfterLastUser(messages, "get_subagent_result")) {
        return fauxAssistantMessage(fauxText("PARENT_FINAL_QUERY_COMPLETED"));
      }
      return fauxAssistantMessage(fauxToolCall("get_subagent_result", {
        agent_id: globalThis.__fauxBackgroundSessionId,
      }), { stopReason: "toolUse" });
    }
    throw new Error(`Unexpected isolated Faux Provider prompt: ${userText.slice(0, 180)}`);
  };
  faux.setResponses(Array(24).fill(respond));
  const harness = await createHarness(faux);

  try {
    const parentTurn = harness.parentSession.prompt("START_BACKGROUND_TOKEN");
    await withTimeout(childStarted.promise, 5000, "the live child Pi session to start");
    await withTimeout(parentTurn, 5000, "the parent turn to continue");
    assert.equal(harness.parentSession.getLastAssistantText(), "PARENT_CONTINUED_WHILE_CHILD_RUNNING");

    const [sessionId, stored] = await waitFor(
      () => [...globalThis.__piSubagentRuns.entries()][0],
      "the in-memory run registration",
    );
    globalThis.__fauxBackgroundSessionId = sessionId;
    assert.equal(stored.run.runInBackground, true);
    assert.equal(stored.run.status, "running");
    assert.equal(harness.parentSession.model.provider, "faux");

    await harness.parentSession.prompt("QUERY_IN_FLIGHT_TOKEN");
    const inFlightText = lastToolResult(harness.parentSession, "get_subagent_result");
    assert.match(inFlightText, new RegExp(`Subagent ${sessionId} is running\\.`));
    assert.equal(notifications.length, 0, "the result query must not invent a completion notification");

    releaseChild.resolve();
    const completed = await withTimeout(stored.completion, 5000, "background completion");
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, "CHILD_RESULT_BACKGROUND_TOKEN");
    childResultText = completed.result;
    const delivered = await withTimeout(notificationSeen.promise, 5000, "the parent follow-up notification turn");
    assert.ok(delivered.startsWith(SUBAGENT_NOTIFICATION_PREFIX));
    assert.ok(delivered.includes(childResultText));
    await waitFor(
      () => harness.parentSession.getLastAssistantText() === "PARENT_RECEIVED_BACKGROUND_NOTIFICATION",
      "the parent notification response to finish",
    );
    assert.equal(notifications.length, 1);

    await harness.parentSession.prompt("QUERY_TERMINAL_TOKEN");
    const terminalText = lastToolResult(harness.parentSession, "get_subagent_result");
    assert.ok(terminalText.includes("completed"));
    assert.ok(terminalText.includes(childResultText));
    assert.equal(globalThis.__piSubagentRuns.has(sessionId), false, "completed runs must leave active memory tracking");

    const childHost = harness.sessions.get(sessionId);
    const childPath = childHost.sessionFile;
    assert.ok(existsSync(childPath), "the Pi child session must be persisted on disk");
    childHost.inner.dispose();
    const fromDisk = await harness.controller.get(sessionId);
    assert.equal(fromDisk.status, "completed");
    assert.equal(fromDisk.result, childResultText);
    const persistedText = await readFile(childPath, "utf8");
    assert.ok(persistedText.includes("CHILD_RESULT_BACKGROUND_TOKEN"));
  } finally {
    releaseChild.resolve();
    delete globalThis.__fauxBackgroundSessionId;
    await harness.cleanup();
  }
});

test("real Pi session cancellation aborts a running child and a queued child, then cleans both", { timeout: 30000 }, async () => {
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const runningChildStarted = deferred();
  const notificationIds = new Set();
  let runningSignal;
  let queuedChildPrompted = false;
  const cancelTasks = [
    {
      prompt: "CANCEL_RUNNING_CHILD_TOKEN",
      description: "Running cancel probe",
    },
    {
      prompt: "CANCEL_QUEUED_CHILD_TOKEN",
      description: "Queued cancel probe",
    },
  ];
  const respond = async (context, options) => {
    const messages = context.messages ?? [];
    const userText = latestUserText(messages);

    if (userText.includes("CANCEL_RUNNING_CHILD_TOKEN")) {
      runningSignal = options?.signal;
      runningChildStarted.resolve();
      if (!runningSignal) return fauxAssistantMessage(fauxText("NO_ABORT_SIGNAL"));
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fauxAssistantMessage(fauxText("CANCEL_TIMEOUT"))), 8000);
        runningSignal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(fauxAssistantMessage(fauxText("ABORT_SIGNAL_OBSERVED")));
        }, { once: true });
      });
    }
    if (userText.includes("CANCEL_QUEUED_CHILD_TOKEN")) {
      queuedChildPrompted = true;
      return fauxAssistantMessage(fauxText("QUEUED_CHILD_MUST_NOT_START"));
    }
    if (userText.includes(SUBAGENT_NOTIFICATION_PREFIX)) {
      const ids = [...userText.matchAll(/Subagent ([a-f0-9-]+) was stopped/g)].map((match) => match[1]);
      for (const id of ids) notificationIds.add(id);
      return fauxAssistantMessage(fauxText("PARENT_RECEIVED_CANCEL_NOTIFICATION"));
    }
    if (userText.includes("START_CANCEL_PAIR_TOKEN")) {
      const agentResultCount = countToolResultsAfterLastUser(messages, "Agent");
      if (agentResultCount < cancelTasks.length) {
        const task = cancelTasks[agentResultCount];
        return fauxAssistantMessage(fauxToolCall("Agent", {
          subagent_type: "explore",
          ...task,
          run_in_background: true,
          model: "faux/faux-model",
        }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxText("PARENT_CONTINUED_WITH_CANCEL_PAIR_RUNNING"));
    }
    throw new Error(`Unexpected isolated Faux Provider prompt: ${userText.slice(0, 180)}`);
  };
  faux.setResponses(Array(32).fill(respond));
  const harness = await createHarness(faux, 1);

  try {
    await harness.parentSession.prompt("START_CANCEL_PAIR_TOKEN");
    const agentTranscript = toolTranscript(harness.parentSession).filter(({ name }) => name === "Agent");
    const agentCalls = agentTranscript.filter(({ type }) => type === "toolCall");
    const agentResults = agentTranscript.filter(({ type }) => type === "toolResult");
    assert.equal(agentCalls.length, 2, `expected two Agent calls: ${JSON.stringify(agentTranscript)}`);
    assert.deepEqual(agentCalls.map(({ arguments: args }) => args.prompt), cancelTasks.map(({ prompt }) => prompt));
    assert.equal(agentResults.length, 2, `expected two Agent results: ${JSON.stringify(agentTranscript)}`);
    assert.deepEqual(
      agentResults.map(({ id }) => id).sort(),
      agentCalls.map(({ id }) => id).sort(),
      `each Agent call must have a result: ${JSON.stringify(agentTranscript)}`,
    );
    await withTimeout(runningChildStarted.promise, 5000, "the running child Pi session to start");
    assert.ok(runningSignal, "the Faux Provider receives the real Pi session abort signal");
    assert.equal(harness.parentSession.getLastAssistantText(), "PARENT_CONTINUED_WITH_CANCEL_PAIR_RUNNING");

    const runEntries = await waitFor(() => {
      const entries = [...globalThis.__piSubagentRuns.entries()];
      return entries.length === 2 && entries.find(([, run]) => run.run.status === "running")
        && entries.find(([, run]) => run.run.status === "queued")
        ? entries
        : null;
    }, "one running and one queued Pi subagent").catch((error) => {
      const observed = [...globalThis.__piSubagentRuns.entries()].map(([id, stored]) => ({
        id,
        status: stored.run.status,
        description: stored.run.description,
      }));
      error.message = `${error.message}; observed runs: ${JSON.stringify(observed)}; `
        + `parent toolExecution=${harness.parentSession.agent.toolExecution}; faux calls=${faux.state.callCount}; `
        + `tool transcript=${JSON.stringify(toolTranscript(harness.parentSession))}`;
      throw error;
    });
    const runningEntry = runEntries.find(([, run]) => run.run.status === "running");
    const queuedEntry = runEntries.find(([, run]) => run.run.status === "queued");
    const [runningId, runningStored] = runningEntry;
    const [queuedId, queuedStored] = queuedEntry;

    await harness.controller.abort(queuedId);
    const queuedResult = await withTimeout(queuedStored.completion, 5000, "queued cancellation");
    assert.equal(queuedResult.status, "aborted");
    assert.equal(globalThis.__piSubagentRuns.has(queuedId), false);
    assert.equal(queuedChildPrompted, false, "a cancelled queue entry must never create a Pi prompt");

    const abortStartedAt = Date.now();
    await harness.controller.abort(runningId);
    const runningResult = await withTimeout(runningStored.completion, 5000, "running cancellation");
    assert.ok(Date.now() - abortStartedAt < 3000, "a running FauxProvider stream should stop promptly on abort");
    assert.equal(runningSignal.aborted, true);
    assert.equal(runningResult.status, "aborted");
    assert.equal(globalThis.__piSubagentRuns.has(runningId), false);

    assert.equal((await harness.controller.get(queuedId)).status, "aborted");
    assert.equal((await harness.controller.get(runningId)).status, "aborted");
    await waitFor(
      () => notificationIds.has(queuedId) && notificationIds.has(runningId),
      "both cancellation notifications reaching the parent Pi session",
    );
  } finally {
    for (const [sessionId, stored] of globalThis.__piSubagentRuns) {
      void stored;
      await harness.controller.abort(sessionId).catch(() => {});
    }
    await harness.cleanup();
  }
});
