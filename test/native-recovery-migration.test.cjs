"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");
const module04Path = path.join(rootDir, "enhancements", "modules", "04-sidebar-and-session-management.js");
const module08Path = path.join(rootDir, "enhancements", "modules", "08-settings-panels-and-lifecycle.js");

test("Syntax validation: 04 and 08 modules parse without syntax errors", () => {
  const code04 = fs.readFileSync(module04Path, "utf8");
  const code08 = fs.readFileSync(module08Path, "utf8");

  // In IIFE sharding architecture, modules form an outer IIFE (() => { ... })();
  // Module 04 sits inside, Module 08 ends with })();
  assert.doesNotThrow(() => {
    new vm.Script(`(() => {\n${code04}\n})();`);
  }, "Module 04 syntax must be valid");

  assert.doesNotThrow(() => {
    new vm.Script(`(() => {\n${code08}`);
  }, "Module 08 syntax must be valid");
});

test("Module 08: forceHardReloadApp contains v1.4.46 recovery engine & preserves native shortcuts", () => {
  const code08 = fs.readFileSync(module08Path, "utf8");

  // 1. Native shortcut bar invariant
  assert.match(
    code08,
    /function removeBottomShortcutsBar\(\)\s*\{\s*window\.__PI_WEB_SETTINGS_NATIVE__\?\.setSidebarShortcuts\?\.\(null\);?\s*\}/,
    "removeBottomShortcutsBar must keep native delegate and not revert to old DOM removal"
  );

  // 2. Native current-origin instance info invariant
  assert.match(
    code08,
    /id:\s*"current-origin",\s*type:\s*"process",\s*displayName:\s*"Agent Web Plus 当前实例"/,
    "resolveCurrentPiInstanceInfo must keep native current-origin definition"
  );

  // 3. Monotonic clock and sliding budget
  assert.match(code08, /getMonotonicNow\s*=\s*\(\)\s*=>/, "Must declare getMonotonicNow");
  assert.match(code08, /performance\.now\(\)/, "Must use performance.now for monotonic time");
  assert.match(code08, /MAX_TOTAL_BUDGET_MS\s*=\s*65000/, "Total budget must be 65s");
  assert.match(code08, /STALL_TIMEOUT_MS\s*=\s*20000/, "Stall timeout must be 20s");

  // 4. RSC Flight regex extraction & root enhancement scripts
  assert.ok(code08.includes("const staticRegex ="), "Must contain staticRegex for Flight parsing");
  assert.match(code08, /rawUrls\.add\("\/pi-web-enhancements\.js"\)/, "Must always add /pi-web-enhancements.js");
  assert.match(code08, /rawUrls\.add\("\/pi-web-enhancement-loader\.js"\)/, "Must always add /pi-web-enhancement-loader.js");

  // 5. State object contract
  assert.match(
    code08,
    /window\.__PI_ENH_FORCE_RELOAD_STATE__\s*=\s*\{[\s\S]*?status:\s*"loading"[\s\S]*?urls:\s*\[\]\s*\}/,
    "Must initialize state object with full stats counters"
  );
  assert.match(
    code08,
    /window\.__PI_ENH_FORCE_HARD_RELOAD__\s*=\s*forceHardReloadApp;/,
    "Must export forceHardReloadApp to window"
  );
});

test("Module 08: forceHardReloadApp extracts RSC Flight chunks and root scripts correctly", async () => {
  const code08 = fs.readFileSync(module08Path, "utf8");

  // Extract forceHardReloadApp block
  const startMarker = "isForceReloading = false;";
  const endMarker = "window.__PI_ENH_FORCE_HARD_RELOAD__ = forceHardReloadApp;";
  const startIdx = code08.indexOf(startMarker);
  const endIdx = code08.indexOf(endMarker);
  assert.ok(startIdx !== -1 && endIdx !== -1, "forceHardReloadApp markers found");

  const snippet = code08.slice(startIdx, endIdx + endMarker.length);

  // Setup DOM / Fetch mock in vm context
  const mockHtml = `<!DOCTYPE html>
<html>
<head>
  <script src="/_next/static/chunks/webpack-main.js"></script>
  <link rel="stylesheet" href="/_next/static/css/app-style.css">
</head>
<body>
  <script>
    self.__next_f.push([1, "1:HL[\\"/_next/static/css/flight-style.css\\",\\"style\\"]\\n"]);
    self.__next_f.push([1, "2:I[12345,[\\"999\\",\\"static/chunks/app/flight-chunk.js\\"],\\"FlightApp\\"]\\n"]);
  </script>
</body>
</html>`;

  const fetchedUrls = [];
  const fakeWindow = {
    location: {
      href: "http://localhost:30141/?session=test-123",
      origin: "http://localhost:30141",
      replace: (target) => { fakeWindow.__replacedHref = target; }
    },
    sessionStorage: { setItem: () => {}, removeItem: () => {} },
    localStorage: { setItem: () => {}, removeItem: () => {} },
    document: {
      querySelector: () => null,
      querySelectorAll: () => []
    }
  };

  const sandbox = {
    window: fakeWindow,
    document: fakeWindow.document,
    URL,
    Set,
    Promise,
    Map,
    Array,
    String,
    Number,
    Math,
    Boolean,
    Error,
    navigator: {
      serviceWorker: {
        getRegistrations: async () => []
      }
    },
    performance: {
      now: () => Date.now()
    },
    DOMParser: class {
      parseFromString() {
        return {
          querySelectorAll: (selector) => {
            if (selector === "script[src]") {
              return [{ getAttribute: () => "/_next/static/chunks/webpack-main.js" }];
            }
            if (selector.includes('rel="stylesheet"')) {
              return [{ getAttribute: () => "/_next/static/css/app-style.css" }];
            }
            return [];
          }
        };
      }
    },
    fetch: async (url, opts) => {
      fetchedUrls.push({ url, opts });
      if (url.includes("_bust=")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
          text: async () => mockHtml
        };
      }
      const isCss = url.endsWith(".css");
      const isJs = url.endsWith(".js");
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k) => (k.toLowerCase() === "content-type" ? (isCss ? "text/css" : isJs ? "application/javascript" : "") : null)
        },
        text: async () => "/* asset content */"
      };
    },
    AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    showToast: () => {},
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(`
    let isForceReloading = false;
    ${snippet}
  `, sandbox);

  assert.equal(typeof sandbox.window.__PI_ENH_FORCE_HARD_RELOAD__, "function");
  await sandbox.window.__PI_ENH_FORCE_HARD_RELOAD__();

  const state = sandbox.window.__PI_ENH_FORCE_RELOAD_STATE__;
  assert.equal(state.status, "success", "Reload should succeed");
  assert.equal(state.failed, 0, "No assets should fail");

  const requestedUrls = state.urls;
  assert.ok(requestedUrls.some((u) => u.includes("/_next/static/chunks/webpack-main.js")), "DOM script included");
  assert.ok(requestedUrls.some((u) => u.includes("/_next/static/css/app-style.css")), "DOM CSS included");
  assert.ok(requestedUrls.some((u) => u.includes("/_next/static/chunks/app/flight-chunk.js")), "Flight chunk parsed & normalized");
  assert.ok(requestedUrls.some((u) => u.includes("/_next/static/css/flight-style.css")), "Flight CSS parsed");
  assert.ok(requestedUrls.some((u) => u.includes("/pi-web-enhancements.js")), "Root enhancement script included");
  assert.ok(requestedUrls.some((u) => u.includes("/pi-web-enhancement-loader.js")), "Root loader script included");
});

test("Module 04: decorateProjectStatusRows restores completed rows regardless of unread state", () => {
  const code04 = fs.readFileSync(module04Path, "utf8");

  // Verify the completed restore condition in source code
  const fnMatch = code04.match(/function decorateProjectStatusRows\(\)\s*\{[\s\S]*?^\s{2}\}/m);
  assert.ok(fnMatch, "decorateProjectStatusRows function found");
  const fnBody = fnMatch[0];

  assert.match(
    fnBody,
    /if\s*\(\s*status\s*===\s*"completed"\s*\)\s*\{\s*restoreStatusRow\(row\);\s*continue;\s*\}/,
    "Completed status must restore row unconditionally (whether unread or not)"
  );
  assert.doesNotMatch(
    fnBody,
    /status\s*===\s*"completed"\s*&&\s*!entry\.unread/,
    "Must not restrict completed restore to !entry.unread"
  );

  // Execute in isolated vm to verify behavior
  function createMockRow(id, native = false) {
    const attrs = new Map();
    if (native) attrs.set("data-pi-native-project-status", "true");
    const classList = new Set();
    return {
      id,
      hasAttribute: (name) => attrs.has(name),
      getAttribute: (name) => attrs.get(name) || null,
      setAttribute: (name, val) => attrs.set(name, String(val)),
      removeAttribute: (name) => attrs.delete(name),
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        contains: (c) => classList.has(c)
      },
      querySelector: () => null,
      style: {}
    };
  }

  const restored = [];
  const statusMap = {
    "s-completed-read": { status: "completed", unread: false },
    "s-completed-unread": { status: "completed", unread: true },
    "s-attention": { status: "attention", unread: false, pendingRequests: [] },
    "s-native": { status: "completed", unread: true }
  };

  const sandbox04 = {
    getSessionStatusRows: () => [
      createMockRow("s-completed-read"),
      createMockRow("s-completed-unread"),
      createMockRow("s-attention"),
      createMockRow("s-native", true)
    ],
    findSessionForStatusRow: (row) => ({ id: row.id }),
    getEffectiveProjectStatusEntry: (id) => statusMap[id] || null,
    restoreStatusRow: (row) => {
      restored.push(row.id);
      row.removeAttribute("data-pi-enh-project-status");
      row.removeAttribute("data-pi-enh-completed-unread");
      row.classList.remove("pi-enh-session-needs-attention");
    }
  };

  vm.createContext(sandbox04);
  vm.runInContext(fnBody, sandbox04);

  sandbox04.decorateProjectStatusRows();

  assert.ok(restored.includes("s-completed-read"), "Read completed row must be restored");
  assert.ok(restored.includes("s-completed-unread"), "Unread completed row MUST also be restored (no '本轮结束' label)");
  assert.ok(!restored.includes("s-native"), "Native project status row must be skipped");
});
