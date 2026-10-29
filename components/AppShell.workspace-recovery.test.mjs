import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";
import { newSessionUrl } from "../lib/session-navigation.ts";

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

// Extract the retry callback and the two effects from AppShell.tsx
function extractCodeSlice(startMarker, endMarker) {
  const start = appShellSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Start marker not found: ${startMarker}`);
  const end = appShellSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `End marker not found: ${endMarker}`);
  return appShellSource.slice(start, end + endMarker.length);
}

const retryCallbackCode = extractCodeSlice(
  "  const handleRetryInitialCwd = useCallback",
  "[executionEngineReady, initialCwdStatus, initialNavigation.requestedCwd, selectedSession]);",
);

const resumeEffectCode = extractCodeSlice(
  "  useEffect(() => {\n    if (initialCwdStatus !== \"error\") return;\n    const retryOnResume",
  "[handleRetryInitialCwd, initialCwdStatus]);",
);

const validateEffectCode = extractCodeSlice(
  "  useEffect(() => {\n    const requestedCwd = initialNavigation.requestedCwd;\n    if (!requestedCwd || !executionEngineReady) return;",
  "[executionEngineReady, initialCwdRetryGeneration, initialNavigation, selectedSession]);",
);

const transformedBundle = (await transform(
  [retryCallbackCode, resumeEffectCode, validateEffectCode, "globalThis.handleRetryInitialCwd = handleRetryInitialCwd;"].join("\n"),
  { loader: "ts", target: "es2022" },
)).code;

class EventTargetMock {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function createHarness({
  requestedCwd = "/workspace/project-codex",
  engine = "codex",
  fetchImpl,
} = {}) {
  const windowMock = new EventTargetMock();
  const documentMock = new EventTargetMock();
  documentMock.visibilityState = "visible";

  let status = "validating";
  let error = null;
  let newSessionCwd = null;
  let newSessionDraftId = null;
  let replacedUrl = null;
  let retryGeneration = 0;

  const effects = [];
  const cleanups = new Map();

  const runEffect = (index) => {
    cleanups.get(index)?.();
    const cleanup = effects[index].effectFn();
    if (typeof cleanup === "function") {
      cleanups.set(index, cleanup);
    }
  };

  const context = {
    initialNavigation: { requestedCwd },
    executionEngineReady: true,
    navigationIntentRef: { current: 1 },
    executionEngineRef: { current: engine },
    initialCwdEngineRef: { current: engine },
    selectedSessionIdRef: { current: null },
    selectedSession: null,
    newSessionCwdRef: { current: null },
    suppressCwdBumpRef: { current: false },
    activeNewSessionDraftKeyRef: { current: null },
    initialCwdStatus: status,
    initialCwdError: error,
    initialCwdRetryGeneration: retryGeneration,
    window: windowMock,
    document: documentMock,
    AbortController: globalThis.AbortController,
    newSessionUrl,
    replaceSessionUrl(url) {
      replacedUrl = url;
    },
    setInitialCwdStatus(s) {
      status = typeof s === "function" ? s(status) : s;
      context.initialCwdStatus = status;
    },
    setInitialCwdError(e) {
      error = typeof e === "function" ? e(error) : e;
      context.initialCwdError = error;
    },
    setInitialCwdRetryGeneration(updater) {
      retryGeneration = typeof updater === "function" ? updater(retryGeneration) : updater;
      context.initialCwdRetryGeneration = retryGeneration;
      runEffect(1);
    },
    setNewSessionCwd(cwd) {
      newSessionCwd = cwd;
      context.newSessionCwdRef.current = cwd;
    },
    setNewSessionDraftId(id) {
      newSessionDraftId = id;
    },
    useCallback(fn) {
      return fn;
    },
    useEffect(effectFn, deps) {
      const index = effects.length;
      effects.push({ effectFn, deps, index });
    },
    fetch: fetchImpl ?? (() => Promise.reject(new Error("fetch unmocked"))),
  };

  const vmContext = vm.createContext(context);
  vm.runInContext(transformedBundle, vmContext);

  return {
    context: vmContext,
    window: windowMock,
    document: documentMock,
    runResumeEffect: () => runEffect(0),
    runValidateEffect: () => runEffect(1),
    cleanupAll: () => {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    },
    get status() { return status; },
    get error() { return error; },
    get retryGeneration() { return retryGeneration; },
    get newSessionCwd() { return newSessionCwd; },
    get newSessionDraftId() { return newSessionDraftId; },
    get replacedUrl() { return replacedUrl; },
  };
}

test("AppShell workspace recovery: initial validate 502 enters error state and manual retry recovers", async () => {
  let callCount = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: "HTTP 502" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ cwd: "/workspace/project-codex" }),
      };
    },
  });

  // 1. Initial run: fails with 502
  harness.runValidateEffect();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(harness.status, "error");
  assert.equal(harness.error, "HTTP 502");
  assert.equal(harness.newSessionCwd, null);

  // 2. Manual retry: handleRetryInitialCwd invokes retry validation directly
  harness.context.handleRetryInitialCwd();
  assert.equal(harness.status, "validating");

  // 3. Second run succeeds with 200
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(harness.status, "ready");
  assert.equal(harness.error, null);
  assert.equal(harness.newSessionCwd, "/workspace/project-codex");
  assert.equal(harness.newSessionDraftId, "initial:/workspace/project-codex");
  assert.equal(harness.replacedUrl, newSessionUrl("/workspace/project-codex", "codex"));

  harness.cleanupAll();
});

test("AppShell workspace recovery: online event triggers re-validation and recovers", async () => {
  let callCount = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return { ok: false, status: 502, json: async () => ({ error: "HTTP 502" }) };
      }
      return { ok: true, status: 200, json: async () => ({ cwd: "/workspace/project-codex" }) };
    },
  });

  harness.runValidateEffect();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(harness.status, "error");

  // Mount resume effect in error state
  harness.runResumeEffect();

  // Dispatch online event: automatically triggers re-validation
  harness.window.dispatchEvent("online");
  assert.equal(harness.status, "validating");

  await new Promise((r) => setTimeout(r, 10));

  assert.equal(harness.status, "ready");
  assert.equal(harness.newSessionCwd, "/workspace/project-codex");

  harness.cleanupAll();
});

test("AppShell workspace recovery: visibilitychange event triggers re-validation only when visible", async () => {
  let callCount = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return { ok: false, status: 502, json: async () => ({ error: "HTTP 502" }) };
      }
      return { ok: true, status: 200, json: async () => ({ cwd: "/workspace/project-codex" }) };
    },
  });

  harness.runValidateEffect();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(harness.status, "error");

  harness.runResumeEffect();

  // Hidden visibilitychange does not trigger retry
  harness.document.visibilityState = "hidden";
  harness.document.dispatchEvent("visibilitychange");
  assert.equal(harness.status, "error");

  // Visible visibilitychange triggers retry
  harness.document.visibilityState = "visible";
  harness.document.dispatchEvent("visibilitychange");
  assert.equal(harness.status, "validating");

  await new Promise((r) => setTimeout(r, 10));

  assert.equal(harness.status, "ready");
  assert.equal(harness.newSessionCwd, "/workspace/project-codex");

  harness.cleanupAll();
});

test("AppShell workspace recovery: switching workspace/session cancels and rejects late response", async () => {
  let resolveValidate;
  const validatePromise = new Promise((resolve) => { resolveValidate = resolve; });

  const harness = createHarness({
    fetchImpl: () => validatePromise,
  });

  // Start validation
  harness.runValidateEffect();

  // User selects another session or switches cwd before response arrives
  harness.context.navigationIntentRef.current += 1; // Intent token advanced
  harness.context.selectedSessionIdRef.current = "session-123";
  harness.context.selectedSession = { id: "session-123", cwd: "/other" };

  // Resolve validate late with 200
  resolveValidate({
    ok: true,
    status: 200,
    json: async () => ({ cwd: "/workspace/project-codex" }),
  });
  await new Promise((r) => setTimeout(r, 10));

  // Late response was rejected: newSessionCwd is NOT overwritten
  assert.equal(harness.newSessionCwd, null);
  assert.equal(harness.status, "validating"); // does not update to ready

  // Online / retry also refuses to retry because failed workspace is no longer active
  let retried = false;
  harness.context.fetch = () => { retried = true; return Promise.reject(new Error("should not fetch")); };
  harness.context.handleRetryInitialCwd();
  assert.equal(retried, false);

  harness.cleanupAll();
});

test("AppShell workspace recovery: Pi and Codex engines are both supported", async () => {
  for (const engine of ["pi", "codex"]) {
    let calledEngine = null;
    const harness = createHarness({
      engine,
      requestedCwd: `/workspace/test-${engine}`,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        calledEngine = body.engine;
        return {
          ok: true,
          status: 200,
          json: async () => ({ cwd: body.cwd }),
        };
      },
    });

    harness.runValidateEffect();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(calledEngine, engine);
    assert.equal(harness.status, "ready");
    assert.equal(harness.newSessionCwd, `/workspace/test-${engine}`);
    assert.match(harness.replacedUrl, new RegExp(`engine=${engine}`));

    harness.cleanupAll();
  }
});

test("AppShell workspace recovery UI: error state renders path, reason, and retry button", () => {
  assert.match(appShellSource, /initialCwdStatus === "error"/);
  assert.match(appShellSource, /\{initialNavigation\.requestedCwd\}/);
  assert.match(appShellSource, /\{initialCwdError\}/);
  assert.match(appShellSource, /onClick=\{handleRetryInitialCwd\}/);
  assert.match(appShellSource, /locale === "zh-TW" \? "重試" : locale\.startsWith\("zh"\) \? "重试" : "Retry"/);
});
