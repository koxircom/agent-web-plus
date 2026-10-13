import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildEnhancementHistoryState,
  clampHistoryLoadTail,
  createEarlierHistoryLoader,
  installNativeProcessCollapseFlag,
  isEnhancementPluginEnabled,
  markOptimisticUserMessage,
  NATIVE_PROCESS_COLLAPSE_VERSION,
  PROCESS_COLLAPSE_CHANGE_EVENT,
  reconcileDeliveredUserMessage,
  registerHistoryViewportBridges,
  registerSessionReloadAliases,
  subscribeProcessCollapseChange,
} from "./enhancement-chat-bridge.ts";

test("evaluates plugin toggle state and dispatches process-collapse change notifications", () => {
  const listeners = new Map();
  const storage = new Map();
  const win = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    },
    addEventListener: (type, fn) => {
      listeners.set(type, fn);
    },
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };

  installNativeProcessCollapseFlag(win);
  assert.equal(win.__PI_ENH_NATIVE_PROCESS_COLLAPSE__, NATIVE_PROCESS_COLLAPSE_VERSION);

  // Default enabled
  assert.equal(isEnhancementPluginEnabled("task-tool-auto-collapse", win), true);

  // Legacy per-plugin flag
  storage.set("pi-enh-plugin-task-tool-auto-collapse", "false");
  assert.equal(isEnhancementPluginEnabled("task-tool-auto-collapse", win), false);

  // Settings v1 feature override takes precedence over legacy key
  storage.set(
    "pi-enh-settings-v1",
    JSON.stringify({
      modules: { "conversation-navigation": { enabled: true } },
      features: { "task-tool-auto-collapse": { enabled: true } },
    }),
  );
  assert.equal(isEnhancementPluginEnabled("task-tool-auto-collapse", win), true);

  // Disabling parent module disables feature
  storage.set(
    "pi-enh-settings-v1",
    JSON.stringify({
      modules: { "conversation-navigation": { enabled: false } },
      features: { "task-tool-auto-collapse": { enabled: true } },
    }),
  );
  assert.equal(isEnhancementPluginEnabled("task-tool-auto-collapse", win), false);

  // Runtime function takes highest precedence
  win.__PI_ENH_IS_PLUGIN_ENABLED__ = (id) => id === "task-tool-auto-collapse";
  assert.equal(isEnhancementPluginEnabled("task-tool-auto-collapse", win), true);

  let notified = 0;
  const unsubscribe = subscribeProcessCollapseChange(() => {
    notified += 1;
  }, win);
  assert.ok(listeners.has(PROCESS_COLLAPSE_CHANGE_EVENT));
  listeners.get(PROCESS_COLLAPSE_CHANGE_EVENT)();
  assert.equal(notified, 1);
  unsubscribe();
  assert.equal(listeners.has(PROCESS_COLLAPSE_CHANGE_EVENT), false);
});

test("history state and earlier loader enforce tail bounds, concurrency guards, and session-switch isolation", async () => {
  assert.equal(clampHistoryLoadTail(undefined), 250);
  assert.equal(clampHistoryLoadTail(null), 250);
  assert.equal(clampHistoryLoadTail(""), 250);
  assert.equal(clampHistoryLoadTail("invalid"), 250);
  assert.equal(clampHistoryLoadTail(10), 50);
  assert.equal(clampHistoryLoadTail(30), 50);
  assert.equal(clampHistoryLoadTail(180.4), 180);
  assert.equal(clampHistoryLoadTail(999), 500);

  const state = buildEnhancementHistoryState({
    sessionId: "sess-1",
    totalTurns: 12,
    hasEarlierMessages: true,
    entryIds: ["e1", "e2"],
    oldestEntryId: "e1",
  });
  assert.deepEqual(state, {
    sessionId: "sess-1",
    totalTurns: 12,
    hasEarlierMessages: true,
    entryIds: ["e1", "e2"],
    oldestEntryId: "e1",
  });

  let loading = false;
  let hasMore = true;
  let oldestId = "cursor-1";
  let currentSessionId = "sess-1";
  let activeLeafId = "leaf-1";
  let anchorCaptured = 0;
  let anchorCleared = 0;
  const loadedContexts = [];
  const requestedTails = [];

  let resolveFlight;
  const loadEarlier = createEarlierHistoryLoader({
    isLoading: () => loading,
    setLoading: (next) => {
      loading = next;
    },
    hasEarlierMessages: () => hasMore,
    getOldestEntryId: () => oldestId,
    getSessionId: () => currentSessionId,
    getActiveLeafId: () => activeLeafId,
    captureScrollAnchor: () => {
      anchorCaptured += 1;
    },
    clearScrollAnchor: () => {
      anchorCleared += 1;
    },
    loadContext: async (sid, leaf, before, options) => {
      requestedTails.push({ sid, leaf, before, tail: options.tail });
      return await new Promise((resolve) => {
        resolveFlight = resolve;
      });
    },
    onContextLoaded: (ctx) => {
      loadedContexts.push(ctx);
    },
  });

  // Start first request with tail=20 (clamped to 50)
  const firstPromise = loadEarlier(20);
  assert.equal(loading, true);
  assert.equal(anchorCaptured, 1);

  // Concurrent call while loading must return false immediately
  assert.equal(await loadEarlier(100), false);
  assert.equal(requestedTails.length, 1);
  assert.equal(requestedTails[0].tail, 50);

  resolveFlight({ messages: [{ role: "user", content: "older" }], entryIds: ["e0"] });
  assert.equal(await firstPromise, true);
  assert.equal(loading, false);
  assert.equal(loadedContexts.length, 1);
  assert.equal(anchorCleared, 0);

  // Switch session while a request is in flight: must not commit stale context
  const stalePromise = loadEarlier(600);
  assert.equal(requestedTails[1].tail, 500);
  currentSessionId = "sess-2";
  resolveFlight({ messages: [{ role: "user", content: "stale" }], entryIds: ["stale-0"] });
  assert.equal(await stalePromise, false);
  assert.equal(loadedContexts.length, 1);
  assert.equal(anchorCleared, 1);

  // Empty cursor or no earlier messages returns false without calling loadContext
  oldestId = null;
  assert.equal(await loadEarlier(100), false);
  oldestId = "cursor-2";
  hasMore = false;
  assert.equal(await loadEarlier(100), false);
  assert.equal(requestedTails.length, 2);
});

test("history viewport bridge cleanup only removes its own registered callbacks", () => {
  const win = {};
  const handlersA = {
    getHistoryState: () => buildEnhancementHistoryState({
      sessionId: "a",
      totalTurns: 1,
      hasEarlierMessages: false,
      entryIds: [],
      oldestEntryId: null,
    }),
    loadEarlier: async () => false,
    prepareHistoryCommit: () => {},
  };
  const handlersB = {
    getHistoryState: () => buildEnhancementHistoryState({
      sessionId: "b",
      totalTurns: 2,
      hasEarlierMessages: true,
      entryIds: ["b1"],
      oldestEntryId: "b1",
    }),
    loadEarlier: async () => true,
    prepareHistoryCommit: () => {},
  };

  const cleanupA = registerHistoryViewportBridges(win, handlersA);
  const cleanupB = registerHistoryViewportBridges(win, handlersB);

  // Late cleanup from A must not delete B's active bridges
  cleanupA();
  assert.equal(win.__PI_ENH_GET_HISTORY_STATE__, handlersB.getHistoryState);
  assert.equal(win.__PI_ENH_LOAD_EARLIER__, handlersB.loadEarlier);
  assert.equal(win.__PI_ENH_PREPARE_HISTORY_COMMIT__, handlersB.prepareHistoryCommit);

  cleanupB();
  assert.equal(win.__PI_ENH_GET_HISTORY_STATE__, undefined);
  assert.equal(win.__PI_ENH_LOAD_EARLIER__, undefined);
  assert.equal(win.__PI_ENH_PREPARE_HISTORY_COMMIT__, undefined);
});

test("reload aliases preserve enhancement wrapper, route to active/current pane, and clean up safely", () => {
  const calls = [];
  const win = {
    location: { search: "?session=pane-b" },
  };

  // Simulate enhancement wrapper registered before React mounts
  const enhWrapper = (notify = true) => {
    calls.push({ source: "enh-wrapper", notify });
    return win.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__?.(notify);
  };
  win.__PI_ENH_RELOAD_CURRENT_SESSION__ = enhWrapper;

  const cleanupPaneA = registerSessionReloadAliases(win, {
    getSessionId: () => "pane-a",
    isActive: () => false,
    reloadSession: (sid, showLoading, includeState, options) => {
      calls.push({ pane: "A", sid, showLoading, includeState, options });
      return "reloaded-a";
    },
  });

  const cleanupPaneB = registerSessionReloadAliases(win, {
    getSessionId: () => "pane-b",
    isActive: () => true,
    reloadSession: (sid, showLoading, includeState, options) => {
      calls.push({ pane: "B", sid, showLoading, includeState, options });
      return "reloaded-b";
    },
  });

  // Pre-existing enhancement wrapper must never be overwritten
  assert.equal(win.__PI_ENH_RELOAD_CURRENT_SESSION__, enhWrapper);
  assert.equal(typeof win.__PI_WEB_RELOAD_SESSION__, "function");
  assert.equal(typeof win.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__, "function");

  // Calling enhancement wrapper delegates to native current session reload -> active pane B
  assert.equal(win.__PI_ENH_RELOAD_CURRENT_SESSION__(false), "reloaded-b");
  assert.deepEqual(calls.slice(-2), [
    { source: "enh-wrapper", notify: false },
    { pane: "B", sid: "pane-b", showLoading: false, includeState: true, options: undefined },
  ]);

  // Specific session reload routes to matching pane A even when pane B is active
  assert.equal(win.__PI_WEB_RELOAD_SESSION__("pane-a", true, true, { force: true }), "reloaded-a");
  assert.deepEqual(calls.at(-1), {
    pane: "A",
    sid: "pane-a",
    showLoading: true,
    includeState: true,
    options: { force: true },
  });

  // Unmounting pane A leaves bridges intact for pane B
  cleanupPaneA();
  assert.equal(win.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__(true), "reloaded-b");

  // Unmounting pane B cleans up native bridges but preserves enhancement wrapper
  cleanupPaneB();
  assert.equal(win.__PI_WEB_RELOAD_SESSION__, undefined);
  assert.equal(win.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__, undefined);
  assert.equal(win.__PI_ENH_RELOAD_CURRENT_SESSION__, enhWrapper);
});

test("reload aliases install and clean up fallback __PI_ENH_RELOAD_CURRENT_SESSION__ when no wrapper exists", () => {
  const win = {};
  const cleanup = registerSessionReloadAliases(win, {
    getSessionId: () => "solo-session",
    isActive: () => true,
    reloadSession: (sid, showLoading, includeState) => `${sid}:${showLoading}:${includeState}`,
  });

  assert.equal(typeof win.__PI_ENH_RELOAD_CURRENT_SESSION__, "function");
  assert.equal(win.__PI_ENH_RELOAD_CURRENT_SESSION__(true), "solo-session:true:true");

  cleanup();
  assert.equal(win.__PI_ENH_RELOAD_CURRENT_SESSION__, undefined);
});

test("user-message-reconcile marks optimistic messages non-enumerably and falls back safely on errors or disabled state", () => {
  const optimistic = markOptimisticUserMessage({
    role: "user",
    content: "hello",
    timestamp: 123,
  });

  assert.equal(optimistic.__piEnhOptimistic, true);
  assert.equal(Object.keys(optimistic).includes("__piEnhOptimistic"), false);
  assert.equal(JSON.stringify(optimistic).includes("__piEnhOptimistic"), false);

  const serverMsg = { role: "user", content: "hello", timestamp: 124, id: "srv-1" };
  const prev = [optimistic];
  const fallback = () => [...prev.slice(0, -1), serverMsg];

  // 1. Hook active and replaces message
  const winWithHook = {
    __PI_ENH_RECONCILE_USER_MESSAGE__: (list, delivered, opts) => {
      assert.equal(opts.lastFingerprint, "fp-1");
      assert.equal(opts.serverFingerprint, "fp-1");
      assert.equal(list[0].__piEnhOptimistic, true);
      return [delivered];
    },
  };
  assert.deepEqual(
    reconcileDeliveredUserMessage(
      prev,
      serverMsg,
      { lastFingerprint: "fp-1", serverFingerprint: "fp-1", fingerprintFn: () => "fp-1", fallback },
      winWithHook,
    ),
    [serverMsg],
  );

  // 2. Hook throws -> fallback still preserves the message without dropping
  const winThrowing = {
    __PI_ENH_RECONCILE_USER_MESSAGE__: () => {
      throw new Error("boom");
    },
  };
  assert.deepEqual(
    reconcileDeliveredUserMessage(
      prev,
      serverMsg,
      { lastFingerprint: "fp-1", serverFingerprint: "fp-1", fingerprintFn: () => "fp-1", fallback },
      winThrowing,
    ),
    [serverMsg],
  );

  // 3. Hook disabled -> delegates to native fallback
  const winDisabled = {
    __PI_ENH_RECONCILE_USER_MESSAGE__: (_list, _delivered, opts) => opts.fallback(),
  };
  assert.deepEqual(
    reconcileDeliveredUserMessage(
      prev,
      serverMsg,
      { lastFingerprint: "fp-1", serverFingerprint: "fp-1", fingerprintFn: () => "fp-1", fallback },
      winDisabled,
    ),
    [serverMsg],
  );
});

test("ChatWindow and useAgentSession wire the enhancement bridges in source", async () => {
  const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

  assert.match(chatWindowSource, /data-pi-enh-native-process="true"/);
  assert.match(chatWindowSource, /registerHistoryViewportBridges/);
  assert.match(chatWindowSource, /restoreScrollTop\(container\.scrollHeight, prevScrollDistanceRef\.current\)/);

  assert.match(hookSource, /markOptimisticUserMessage\(userMsg\)/);
  assert.match(hookSource, /reconcileDeliveredUserMessage\(prev, delivered,/);
  assert.match(hookSource, /registerSessionReloadAliases\(getEnhancementWindow\(\),/);
  assert.match(hookSource, /historyCursorRef\.current === before/);
});


test("resident metrics bridge reads only the matching active native owner and survives peer cleanup", () => {
  const win = { location: { search: "?session=two" } };
  const one = { sessionId: "one", context: { messages: [], entryIds: [] } };
  const two = { sessionId: "two", context: { messages: [], entryIds: [] } };
  const unregisterOne = registerSessionReloadAliases(win, {
    getSessionId: () => "one", isActive: () => true, getSessionData: () => one,
    reloadSession: () => { throw new Error("Reading metrics must not reload"); },
  });
  let active = true;
  let current = two;
  const unregisterTwo = registerSessionReloadAliases(win, {
    getSessionId: () => "two", isActive: () => active, getSessionData: () => current,
    reloadSession: () => { throw new Error("Reading metrics must not reload"); },
  });
  assert.equal(win.__PI_WEB_GET_RESIDENT_SESSION_DATA__("two"), two);
  assert.equal(win.__PI_WEB_GET_RESIDENT_SESSION_DATA__("missing"), null);
  current = one;
  assert.equal(win.__PI_WEB_GET_RESIDENT_SESSION_DATA__("two"), null);
  current = two; active = false;
  assert.equal(win.__PI_WEB_GET_RESIDENT_SESSION_DATA__("two"), null);
  active = true;
  unregisterOne();
  assert.equal(win.__PI_WEB_GET_RESIDENT_SESSION_DATA__("two"), two);
  unregisterTwo();
  assert.equal(win.__PI_WEB_GET_RESIDENT_SESSION_DATA__, undefined);
});
