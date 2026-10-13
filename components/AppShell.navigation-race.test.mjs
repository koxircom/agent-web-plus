import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callbackBlock(name, nextMarker) {
  const start = source.indexOf(`  const ${name} = useCallback`);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextMarker} not found after ${name}`);
  return source.slice(start, end);
}

const callbacks = [
  callbackBlock("handleSelectSession", "\n  const handleNewSession"),
  callbackBlock("handleNewSession", "\n  // Global keyboard shortcuts"),
  callbackBlock("hydrateSelectedSession", "\n  const handleOpenSession"),
  callbackBlock("handleOpenSession", "\n  // Called by ChatWindow when a new session gets its real id from pi"),
  callbackBlock("handleSessionCreated", "\n  const deliverSessionNotification"),
  callbackBlock("handleSessionForked", "\n  const handleAskInNewChat"),
  callbackBlock("handleAskInNewChat", "\n  const handleInitialRestoreDone"),
];
const executableNavigation = (await transform(`${callbacks.join("\n")}\nglobalThis.navigation = { handleSelectSession, handleNewSession, handleOpenSession, hydrateSelectedSession, handleSessionCreated, handleSessionForked, handleAskInNewChat };`, {
  loader: "ts",
  target: "es2022",
})).code;

const lifecycleStart = source.indexOf("  useLayoutEffect(() => () => {", source.indexOf("const navigationIntentRef"));
const lifecycleEndMarker = "\n  }, [advanceNavigationIntent]);";
const lifecycleEnd = source.indexOf(lifecycleEndMarker, lifecycleStart) + lifecycleEndMarker.length;
assert.notEqual(lifecycleStart, -1, "navigation cleanup effect not found");
assert.ok(lifecycleEnd > lifecycleStart, "navigation cleanup effect end not found");
const lifecycle = source.slice(lifecycleStart, lifecycleEnd);

function makeHarness({ sessionCatalog = [], initialSession = { id: "initial", cwd: "/initial", projectKey: "/initial" }, fetchImpl } = {}) {
  const context = vm.createContext({
    URLSearchParams,
    console,
    encodeURIComponent,
    fetch: fetchImpl ?? (() => { throw new Error("unexpected fetch"); }),
    sendAgentCommand: async () => null,
    translate: (key) => key,
    window: { location: { pathname: "/", search: "" } },
    useCallback: (callback) => callback,
    useLayoutEffect: (effect) => { context.unmountCleanup = effect(); },
    navigationIntentRef: { current: 0 },
    navigationIntentAtRender: 0,
    workspaceRestoreTokenRef: { current: 0 },
    sessionCatalog,
    selectedSession: initialSession,
    newSessionCwd: null,
    activeCwd: "/initial",
    activeFileTabId: null,
    activeProjectKeyRef: { current: "/initial" },
    activeNewSessionDraftKeyRef: { current: null },
    branchLeafChangeFnRef: { current: null },
    isMobile: false,
    replaceSessionUrl() {},
    workspaceKeyOf: (session) => session.projectKey ?? session.cwd,
    parkedNewSessionDraftKey: (cwd) => `parked-new:${cwd}`,
    rekeyDraft() {},
    invalidateWorkspaceRestore() {},
    setSearchTarget() {},
    setFileTabs() {},
    setActiveFileTabId() {},
    setRightPanelOpen() {},
    setActiveTopPanel() {},
    setSidebarOpen() {},
    setNewSessionCwd(value) { context.newSessionCwd = typeof value === "function" ? value(context.newSessionCwd) : value; },
    setSelectedSession(value) { context.selectedSession = typeof value === "function" ? value(context.selectedSession) : value; },
    setSessionKey() {},
    setNewSessionDraftId() {},
    setBranchTree() {},
    setBranchActiveLeafId() {},
    setBranchSwitchLocked() {},
    setSystemPrompt() {},
    setSystemTools() {},
    setSystemInfoLoading() {},
    setInitialSessionRestored() {},
    refreshCount: 0,
    setRefreshKey() { context.refreshCount += 1; },
    setPendingQuotePrompt() {},
    handleSessionSubmissionChange() {},
  });
  context.advanceNavigationIntent = () => ++context.navigationIntentRef.current;
  vm.runInContext(`${executableNavigation}\n${lifecycle}`, context);
  return context;
}

function deferredFetch() {
  const requests = new Map();
  const fetchImpl = (url) => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    const request = { promise, resolve };
    requests.set(url, request);
    return request.promise;
  };
  return { fetchImpl, requests };
}

function response(info) {
  return { ok: true, json: async () => ({ info }) };
}

test("late session opens cannot override a later sidebar selection, New, or open", async (t) => {
  await t.test("sidebar selection cancels the pending open", async () => {
    const pending = deferredFetch();
    const context = makeHarness({ fetchImpl: pending.fetchImpl });
    const opening = context.navigation.handleOpenSession("slow");
    context.navigation.handleSelectSession({ id: "sidebar", cwd: "/sidebar", projectKey: "/sidebar" });
    pending.requests.get("/api/sessions/slow").resolve(response({ id: "slow", cwd: "/slow" }));
    await opening;
    assert.equal(context.selectedSession.id, "sidebar");
  });

  await t.test("New cancels the pending open", async () => {
    const pending = deferredFetch();
    const context = makeHarness({ fetchImpl: pending.fetchImpl });
    const opening = context.navigation.handleOpenSession("slow");
    context.navigation.handleNewSession("draft-2", "/draft-2");
    pending.requests.get("/api/sessions/slow").resolve(response({ id: "slow", cwd: "/slow" }));
    await opening;
    assert.equal(context.selectedSession, null);
    assert.equal(context.newSessionCwd, "/draft-2");
  });

  await t.test("the second open wins when the first request resolves last", async () => {
    const pending = deferredFetch();
    const context = makeHarness({ fetchImpl: pending.fetchImpl });
    const first = context.navigation.handleOpenSession("first");
    const second = context.navigation.handleOpenSession("second");
    pending.requests.get("/api/sessions/second").resolve(response({ id: "second", cwd: "/second", projectKey: "/second" }));
    await second;
    pending.requests.get("/api/sessions/first").resolve(response({ id: "first", cwd: "/first", projectKey: "/first" }));
    await first;
    assert.equal(context.selectedSession.id, "second");
  });
});

test("detail hydration reuses a complete catalogue row and otherwise reads only one session", async (t) => {
  await t.test("catalogue row avoids a request", () => {
    const catalogued = { id: "known", cwd: "/repo/worktree", projectKey: "/repo", detailsPending: false };
    const context = makeHarness({ sessionCatalog: [catalogued], initialSession: { id: "known", cwd: "/repo/worktree" } });
    context.navigation.hydrateSelectedSession("known", 0);
    assert.equal(context.selectedSession.projectKey, "/repo");
  });

  await t.test("missing metadata uses the session detail endpoint and is discarded after navigation", async () => {
    const pending = deferredFetch();
    const context = makeHarness({ fetchImpl: pending.fetchImpl, initialSession: { id: "created", cwd: "/repo/worktree" } });
    context.navigation.hydrateSelectedSession("created", 0, { id: "created", cwd: "/repo/worktree" });
    assert.deepEqual([...pending.requests.keys()], ["/api/sessions/created"]);
    context.navigation.handleNewSession("draft-2", "/repo/worktree");
    pending.requests.get("/api/sessions/created").resolve(response({ id: "created", cwd: "/repo/worktree", projectKey: "/repo" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.selectedSession, null);
  });
});

test("create and fork reuse current project metadata while retaining sidebar refresh", () => {
  const context = makeHarness({
    fetchImpl: () => { throw new Error("complete current metadata should avoid another request"); },
  });
  context.activeProjectKeyRef.current = "/repo";
  context.activeNewSessionDraftKeyRef.current = "new:draft:/repo";
  context.navigation.handleSessionCreated({ id: "created", cwd: "/repo", path: "/repo/session.jsonl", created: "", modified: "", messageCount: 1, firstMessage: "hello" }, "new:draft:/repo");
  assert.equal(context.selectedSession.projectKey, "/repo");
  assert.equal(context.refreshCount, 1);

  const forkContext = makeHarness({
    initialSession: { id: "source", cwd: "/repo", projectKey: "/repo" },
    fetchImpl: () => { throw new Error("fork should reuse source project metadata"); },
  });
  forkContext.navigation.handleSessionForked("forked");
  assert.equal(forkContext.selectedSession.id, "forked");
  assert.equal(forkContext.selectedSession.projectKey, "/repo");
  assert.equal(forkContext.refreshCount, 1);
});

test("a fork completion from an old navigation refreshes the sidebar without selecting the fork", () => {
  const context = makeHarness();
  context.navigation.handleNewSession("newer", "/newer");
  context.navigation.handleSessionForked("stale-fork");
  assert.equal(context.selectedSession, null);
  assert.equal(context.newSessionCwd, "/newer");
  assert.equal(context.refreshCount, 1);
});

test("an async Ask-in-New-Chat fork cannot replace later navigation", async () => {
  let resolveFork;
  const forkResult = new Promise((resolve) => { resolveFork = resolve; });
  const context = makeHarness();
  context.sendAgentCommand = () => forkResult;
  const asking = context.navigation.handleAskInNewChat("prompt", "source", "entry");
  context.navigation.handleNewSession("newer", "/newer");
  resolveFork({ newSessionId: "stale-fork" });
  await asking;
  assert.equal(context.selectedSession, null);
  assert.equal(context.newSessionCwd, "/newer");
  assert.equal(context.refreshCount, 1);
});

test("unmount cleanup invalidates pending open and detail hydration", async (t) => {
  await t.test("open", async () => {
    const pending = deferredFetch();
    const context = makeHarness({ fetchImpl: pending.fetchImpl });
    const opening = context.navigation.handleOpenSession("slow");
    context.unmountCleanup();
    pending.requests.get("/api/sessions/slow").resolve(response({ id: "slow", cwd: "/slow" }));
    await opening;
    assert.equal(context.selectedSession.id, "initial");
  });

  await t.test("hydration", async () => {
    const pending = deferredFetch();
    const context = makeHarness({
      fetchImpl: pending.fetchImpl,
      initialSession: { id: "selected", cwd: "/repo/worktree" },
    });
    context.navigation.hydrateSelectedSession("selected", 0);
    context.unmountCleanup();
    pending.requests.get("/api/sessions/selected").resolve(response({ id: "selected", cwd: "/repo/worktree", projectKey: "/repo" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.selectedSession.projectKey, undefined);
  });
});

test("create and fork still request the sidebar refresh", () => {
  assert.match(callbackBlock("handleSessionCreated", "\n  const deliverSessionNotification"), /setRefreshKey\(\(k\) => k \+ 1\);/);
  assert.match(callbackBlock("handleSessionForked", "\n  const handleAskInNewChat"), /setRefreshKey\(\(k\) => k \+ 1\);/);
});
