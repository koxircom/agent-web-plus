import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  composeEnhancementWindowTitle,
  createSidebarShortcutsFallbackHandler,
  getEnhancementSearchResultDataProps,
  getEnhancementSessionHeadersHeight,
  getEnhancementSessionItemHeight,
  getEnhancementSessionItemTop,
  getEnhancementSessionOdooAddons,
  processEnhancementSearchResults,
  processEnhancementSessionGroups,
  registerEnhancementOpenSettings,
  registerEnhancementSidebarBridge,
} = await jiti.import("./enhancement-sidebar-bridge.ts");

test("native addon rows consume the authoritative getter across refresh, disable and recovery", () => {
  let items = [{ technical: "kx_portal", status: "已更新", isLatest: true }];
  const win = {
    __PI_ENH_GET_SESSION_ODOO_ADDONS__: (sessionId) => sessionId === "portal" ? items : [],
    __PI_ENH_GET_SESSION_ITEM_HEIGHT__: () => 100,
  };
  assert.deepEqual(getEnhancementSessionOdooAddons("portal", win), items);
  assert.deepEqual(getEnhancementSessionOdooAddons("other", win), []);
  assert.equal(getEnhancementSessionItemHeight("portal", 60, win), 100);
  items = [];
  assert.deepEqual(getEnhancementSessionOdooAddons("portal", win), []);
  items = [{ technical: "kx_portal", status: "已更新", isLatest: false }];
  assert.deepEqual(getEnhancementSessionOdooAddons("portal", win), items);
  win.__PI_ENH_GET_SESSION_ODOO_ADDONS__ = () => { throw new Error("unavailable"); };
  win.__PI_ENH_GET_SESSION_ITEM_HEIGHT__ = () => NaN;
  assert.deepEqual(getEnhancementSessionOdooAddons("portal", win), []);
  assert.equal(getEnhancementSessionItemHeight("portal", 60, win), 60);
});

test("registerEnhancementSidebarBridge exposes all 6 sidebar hooks and isolates multi-pane lifecycles", () => {
  const win = {};
  const callsA = [];
  const callsB = [];
  const unreadA = new Set(["s-1"]);
  const unreadB = new Set();

  const cleanupA = registerEnhancementSidebarBridge(
    {
      refreshSessions: (showLoading, force) => {
        callsA.push(["refresh", showLoading, force]);
        return "from-A";
      },
      getRawSessions: () => [{ id: "s-1" }],
      rerenderSessions: () => callsA.push(["rerender"]),
      notifySessionDeleted: (id) => callsA.push(["deleted", id]),
      setUnreadSession: (id, isUnread) => {
        if (isUnread) unreadA.add(id);
        else unreadA.delete(id);
      },
      isSessionUnread: (id) => unreadA.has(id),
    },
    win,
  );

  const cleanupB = registerEnhancementSidebarBridge(
    {
      refreshSessions: (showLoading, force) => {
        callsB.push(["refresh", showLoading, force]);
        return "from-B";
      },
      getRawSessions: () => [{ id: "s-2" }],
      rerenderSessions: () => callsB.push(["rerender"]),
      notifySessionDeleted: (id) => callsB.push(["deleted", id]),
      setUnreadSession: (id, isUnread) => {
        if (isUnread) unreadB.add(id);
        else unreadB.delete(id);
      },
      isSessionUnread: (id) => unreadB.has(id),
    },
    win,
  );

  assert.equal(typeof win.__PI_ENH_REFRESH_SESSIONS__, "function");
  assert.equal(typeof win.__PI_ENH_GET_RAW_SESSIONS__, "function");
  assert.equal(typeof win.__PI_ENH_RERENDER_SESSIONS__, "function");
  assert.equal(typeof win.__PI_ENH_SESSION_DELETED__, "function");
  assert.equal(typeof win.__PI_ENH_SET_UNREAD_SESSION__, "function");
  assert.equal(typeof win.__PI_ENH_IS_SESSION_UNREAD__, "function");

  win.__PI_ENH_REFRESH_SESSIONS__(true, false);
  assert.deepEqual(callsA, [["refresh", true, false]]);
  assert.deepEqual(callsB, [["refresh", true, false]]);

  assert.deepEqual(win.__PI_ENH_GET_RAW_SESSIONS__(), [{ id: "s-2" }]);

  win.__PI_ENH_RERENDER_SESSIONS__();
  win.__PI_ENH_SESSION_DELETED__("s-del");
  assert.deepEqual(callsA.slice(1), [["rerender"], ["deleted", "s-del"]]);
  assert.deepEqual(callsB.slice(1), [["rerender"], ["deleted", "s-del"]]);

  assert.equal(win.__PI_ENH_IS_SESSION_UNREAD__("s-1"), true);
  assert.equal(win.__PI_ENH_IS_SESSION_UNREAD__("s-2"), false);

  win.__PI_ENH_SET_UNREAD_SESSION__("s-2", true);
  assert.equal(win.__PI_ENH_IS_SESSION_UNREAD__("s-2"), true);
  assert.equal(unreadA.has("s-2"), true);
  assert.equal(unreadB.has("s-2"), true);

  // Unmounting pane B must keep pane A active without deleting global bridges.
  cleanupB();
  assert.equal(typeof win.__PI_ENH_GET_RAW_SESSIONS__, "function");
  assert.deepEqual(win.__PI_ENH_GET_RAW_SESSIONS__(), [{ id: "s-1" }]);

  win.__PI_ENH_SET_UNREAD_SESSION__("s-1", false);
  assert.equal(win.__PI_ENH_IS_SESSION_UNREAD__("s-1"), false);

  // External replacement is preserved on cleanup.
  const externalRefresh = () => "external";
  win.__PI_ENH_REFRESH_SESSIONS__ = externalRefresh;
  cleanupA();

  assert.equal(win.__PI_ENH_REFRESH_SESSIONS__, externalRefresh);
  assert.equal(win.__PI_ENH_GET_RAW_SESSIONS__, undefined);
  assert.equal(win.__PI_ENH_RERENDER_SESSIONS__, undefined);
  assert.equal(win.__PI_ENH_SESSION_DELETED__, undefined);
  assert.equal(win.__PI_ENH_SET_UNREAD_SESSION__, undefined);
  assert.equal(win.__PI_ENH_IS_SESSION_UNREAD__, undefined);
});

test("registerEnhancementOpenSettings prioritizes AppShell setSettingsSection and prevents sidebar from clobbering it", () => {
  const win = {};
  const primarySections = [];
  const fallbackSections = [];

  const cleanupPrimary = registerEnhancementOpenSettings(
    (section) => primarySections.push(section),
    { win },
  );
  const cleanupFallback = registerEnhancementOpenSettings(
    (section) => fallbackSections.push(section),
    { fallback: true, win },
  );

  win.__PI_OPEN_SETTINGS__("usage");
  win.__PI_OPEN_SETTINGS__("settings");
  win.__PI_ENH_OPEN_SETTINGS__("notifications");
  assert.deepEqual(primarySections, ["usage", "general", "notifications"]);
  assert.deepEqual(fallbackSections, []);

  // Unmounting sidebar fallback must not remove primary AppShell handler.
  cleanupFallback();
  assert.equal(typeof win.__PI_OPEN_SETTINGS__, "function");
  assert.equal(typeof win.__PI_ENH_OPEN_SETTINGS__, "function");
  win.__PI_OPEN_SETTINGS__("models");
  win.__PI_ENH_OPEN_SETTINGS__("enhancements");
  assert.deepEqual(primarySections, ["usage", "general", "notifications", "models", "enhancements"]);

  cleanupPrimary();
  assert.equal(win.__PI_OPEN_SETTINGS__, undefined);
  assert.equal(win.__PI_ENH_OPEN_SETTINGS__, undefined);
});

test("createSidebarShortcutsFallbackHandler triggers native buttons when no primary setter is mounted", () => {
  const clicked = [];
  const buttons = [
    { disabled: false, click: () => clicked.push("models") },
    { disabled: false, click: () => clicked.push("skills") },
    { disabled: false, click: () => clicked.push("settings") },
  ];
  const host = {
    querySelectorAll: () => buttons,
  };
  const fallback = createSidebarShortcutsFallbackHandler(host);

  fallback("models");
  fallback("skills");
  fallback("enhancements");
  assert.deepEqual(clicked, ["models", "skills", "settings"]);
});

test("composeEnhancementWindowTitle respects plugin toggle and falls back on hook errors", () => {
  const base = "pi-web - Pi Web";

  assert.equal(composeEnhancementWindowTitle(base, undefined), base);
  assert.equal(composeEnhancementWindowTitle(base, {}), base);

  assert.equal(
    composeEnhancementWindowTitle(base, {
      __PI_ENH_IS_PLUGIN_ENABLED__: () => true,
      __PI_ENH_COMPOSE_WINDOW_TITLE__: () => "🔵 pi-web",
    }),
    "🔵 pi-web",
  );

  // Plugin disabled -> native fallback
  assert.equal(
    composeEnhancementWindowTitle(base, {
      __PI_ENH_IS_PLUGIN_ENABLED__: (id) => id !== "project-status-indicator",
      __PI_ENH_COMPOSE_WINDOW_TITLE__: () => "🔵 pi-web",
    }),
    base,
  );

  // Hook throws -> native fallback
  assert.equal(
    composeEnhancementWindowTitle(base, {
      __PI_ENH_COMPOSE_WINDOW_TITLE__: () => {
        throw new Error("boom");
      },
    }),
    base,
  );
});

test("sidebar group and virtual coordinate helpers fall back safely on hook failure", () => {
  const groups = [{ root: { id: "a" } }, { root: { id: "b" } }];

  assert.equal(
    processEnhancementSessionGroups(groups, {
      __PI_ENH_PROCESS_SESSION_GROUPS__: () => {
        throw new Error("group error");
      },
    }),
    groups,
  );

  assert.equal(
    getEnhancementSessionHeadersHeight(groups, {
      __PI_ENH_GET_SESSION_HEADERS_HEIGHT__: () => 28,
    }),
    28,
  );
  assert.equal(
    getEnhancementSessionHeadersHeight(groups, {
      __PI_ENH_GET_SESSION_HEADERS_HEIGHT__: () => {
        throw new Error("height error");
      },
    }),
    0,
  );

  assert.equal(
    getEnhancementSessionItemTop(2, groups, 54, {
      __PI_ENH_GET_SESSION_ITEM_TOP__: () => 136,
    }),
    136,
  );
  assert.equal(
    getEnhancementSessionItemTop(2, groups, 54, {
      __PI_ENH_GET_SESSION_ITEM_TOP__: () => {
        throw new Error("top error");
      },
    }),
    108,
  );
});

test("SessionSearch helpers expose only verified data attributes and fall back on hook failure", () => {
  const raw = [{ session: { id: "s1" }, match: "hello" }];
  assert.deepEqual(
    processEnhancementSearchResults(raw, {
      __PI_ENH_PROCESS_SEARCH_RESULTS__: () => {
        throw new Error("search error");
      },
    }),
    raw,
  );

  const props = getEnhancementSearchResultDataProps({
    session: { id: "s-archived" },
    searchGroup: "archived",
    searchProjectKey: "/workspace/pi-web",
    searchProjectTitle: "pi-web",
    isArchived: true,
    isFirstArchived: true,
    archivedSearchCount: 3,
  });

  assert.deepEqual(props, {
    "data-search-session-id": "s-archived",
    "data-search-group": "archived",
    "data-search-project-key": "/workspace/pi-web",
    "data-search-project-title": "pi-web",
    "data-search-archived": "true",
    "data-search-archived-first": "true",
    "data-search-archive-divider": "已归档会话 · 3 个匹配",
  });
  assert.equal("data-search-other" in props, false);
  assert.equal("data-search-other-first" in props, false);
  assert.equal("data-search-other-count" in props, false);
});

test("source files wire the restored contracts for SessionSidebar, AppShell, and SessionSearch", async () => {
  const [sidebarSource, shellSource, searchSource] = await Promise.all([
    readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/SessionSearch.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(sidebarSource, /registerEnhancementSidebarBridge\(/);
  assert.doesNotMatch(sidebarSource, /pi-enh-native-session-actions|handleDeleteClick|performDelete/);
  assert.match(sidebarSource, /row\.addEventListener\(SESSION_ROW_RENAME_EVENT, rename\)/);
  assert.match(sidebarSource, /row\.removeEventListener\(SESSION_ROW_RENAME_EVENT, rename\)/);

  assert.match(shellSource, /__PI_WEB_NATIVE_TITLE_BASE__/);
  assert.match(shellSource, /composeEnhancementWindowTitle\(requestedBase,\s*win\)/);
  assert.match(shellSource, /pi-enh-title-change/);
  assert.match(shellSource, /registerEnhancementOpenSettings\(/);
  assert.match(shellSource, /data-pi-enh-shortcuts-host="true"/);

  assert.match(searchSource, /processEnhancementSearchResults\(response\?\.results\)/);
  assert.match(searchSource, /\.\.\.getEnhancementSearchResultDataProps\(item\)/);
});
