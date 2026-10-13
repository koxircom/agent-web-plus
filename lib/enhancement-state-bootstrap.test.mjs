import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  DURABLE_STATE_PROBE_TIMEOUT_MS,
  DURABLE_STATE_REVISION_KEY,
  DECORATION_OP_PREFIX,
  canUseLegacyModelsConfig,
  ensureEnhancementsRuntime: bootstrapEnsureRuntime,
} = await jiti.import("./enhancement-state-bootstrap.ts");

const {
  ensureEnhancementsRuntime: componentEnsureRuntime,
} = await jiti.import("../components/PiWebEnhancementsRuntime.tsx");

function createMockStorage(initialEntries = {}) {
  const map = new Map(Object.entries(initialEntries).map(([k, v]) => [k, String(v)]));
  return {
    get length() {
      return map.size;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, val) {
      map.set(String(key), String(val));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
  };
}

function createHarness({
  storageEntries = {},
  unreadableStorage = false,
  initialDurableFlag = undefined,
  fetchImpl = undefined,
} = {}) {
  const timeline = [];
  const appendedScripts = [];
  let currentScript = null;
  const activeTimers = new Map();
  let nextTimerId = 1;
  const timerCalls = [];
  const clearedTimerIds = [];
  const fetchCalls = [];

  const doc = {
    visibilityState: "visible",
    getElementById(id) {
      if (id === "pi-web-enhancements-script") return currentScript;
      return null;
    },
    createElement(tag) {
      assert.equal(tag, "script");
      const script = {
        id: "",
        src: "",
        async: false,
        onerror: null,
        removed: false,
        remove() {
          this.removed = true;
          if (currentScript === this) {
            currentScript = null;
          }
          timeline.push("remove_script");
        },
      };
      return script;
    },
    head: {
      appendChild(script) {
        currentScript = script;
        appendedScripts.push({
          script,
          nativeFlagAtLoad: win.__PI_ENH_NATIVE_STATE_API__,
          durableFlagAtLoad: win.__PI_ENH_DURABLE_STATE_ENABLED__,
        });
        timeline.push(`load_script:${ win.__PI_ENH_DURABLE_STATE_ENABLED__ }`);
        return script;
      },
    },
  };

  const setTimeoutMock = (fn, ms) => {
    const id = nextTimerId++;
    timerCalls.push({ id, ms, fn });
    activeTimers.set(id, { id, ms, fn });
    timeline.push(`set_timer:${ms}`);
    return id;
  };

  const clearTimeoutMock = (id) => {
    clearedTimerIds.push(id);
    activeTimers.delete(id);
    timeline.push("clear_timer");
  };

  const defaultFetch = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    timeline.push(`fetch:${init.method || "GET"}:${url}`);
    return new Response(null, {
      status: 200,
      headers: { "X-Pi-Enhancement-State": "present" },
    });
  };

  const win = {
    document: doc,
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url, init });
      timeline.push(`fetch:${init.method || "GET"}:${url}`);
      if (fetchImpl) {
        return fetchImpl(url, init, { timeline, activeTimers });
      }
      return defaultFetch(url, init);
    },
  };

  if (unreadableStorage) {
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("SecurityError: localStorage is disabled");
      },
    });
  } else {
    win.localStorage = createMockStorage(storageEntries);
  }

  if (initialDurableFlag !== undefined) {
    win.__PI_ENH_DURABLE_STATE_ENABLED__ = initialDurableFlag;
  }

  return {
    win,
    timeline,
    appendedScripts,
    activeTimers,
    timerCalls,
    clearedTimerIds,
    fetchCalls,
    get currentScript() {
      return currentScript;
    },
  };
}

test("order and concurrency deduplication: two ensure entrypoints share one promise, set __PI_ENH_NATIVE_STATE_API__=true first, keep pending fail-closed, and load script only after HEAD resolves", async () => {
  let resolveHead;
  let capturedSignal = null;

  const harness = createHarness({
    fetchImpl: (_url, init) => {
      capturedSignal = init.signal;
      return new Promise((resolve) => {
        resolveHead = resolve;
      });
    },
  });

  // First ensure call (e.g. module top-level)
  const p1 = bootstrapEnsureRuntime(harness.win, { standaloneVersion: "1.0.0" });
  // Second ensure call while probe is still pending (e.g. React useEffect entrypoint)
  const p2 = componentEnsureRuntime(harness.win);

  assert.equal(p1, p2, "Both ensure entrypoints must return the exact same pending promise");
  assert.equal(harness.win.__PI_ENH_NATIVE_STATE_API__, true);
  assert.equal(
    harness.win.__PI_ENH_DURABLE_STATE_ENABLED__,
    true,
    "Pending state must remain fail-closed (durable=true)",
  );
  assert.equal(harness.fetchCalls.length, 1, "Must not issue duplicate HEAD requests");
  assert.equal(harness.fetchCalls[0].url, "/api/enhancement-state");
  assert.equal(harness.fetchCalls[0].init.method, "HEAD");
  assert.equal(harness.fetchCalls[0].init.cache, "no-store");
  assert.equal(harness.fetchCalls[0].init.credentials, "same-origin");
  assert.ok(capturedSignal, "AbortSignal must be passed to HEAD request");
  assert.equal(capturedSignal.aborted, false);
  assert.equal(harness.timerCalls.length, 1);
  assert.equal(harness.timerCalls[0].ms, DURABLE_STATE_PROBE_TIMEOUT_MS);
  assert.equal(
    harness.appendedScripts.length,
    0,
    "Must not load script before pending HEAD probe settles",
  );

  // Resolve HEAD with absent (and clean local storage -> should switch to false before loading script)
  resolveHead(
    new Response(null, {
      status: 200,
      headers: { "X-Pi-Enhancement-State": "absent" },
    }),
  );

  const finalDurable = await p1;
  assert.equal(finalDurable, false);
  assert.equal(harness.win.__PI_ENH_DURABLE_STATE_ENABLED__, false);
  assert.equal(harness.activeTimers.size, 0, "3000ms timer must be cleaned up in finally");
  assert.equal(harness.clearedTimerIds.length, 1);
  assert.equal(harness.appendedScripts.length, 1, "Script must be loaded exactly once");
  assert.equal(harness.appendedScripts[0].nativeFlagAtLoad, true);
  assert.equal(harness.appendedScripts[0].durableFlagAtLoad, false);
  assert.deepEqual(harness.timeline, [
    `set_timer:${DURABLE_STATE_PROBE_TIMEOUT_MS}`,
    "fetch:HEAD:/api/enhancement-state",
    "clear_timer",
    "load_script:false",
  ]);
});

test("explicit boolean flags from inline bootstrap skip network wait and prevent downgrade when local revision or outbox exists", async () => {
  // 1. Explicit true -> no HEAD fetch, stays true
  const hTrue = createHarness({ initialDurableFlag: true });
  const resTrue = await bootstrapEnsureRuntime(hTrue.win);
  assert.equal(resTrue, true);
  assert.equal(hTrue.fetchCalls.length, 0);
  assert.equal(hTrue.win.__PI_ENH_NATIVE_STATE_API__, true);
  assert.equal(hTrue.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hTrue.appendedScripts.length, 1);

  // 2. Explicit false with clean localStorage -> no HEAD fetch, stays false
  const hFalseClean = createHarness({
    initialDurableFlag: false,
    storageEntries: { [DURABLE_STATE_REVISION_KEY]: "0" },
  });
  const resFalseClean = await bootstrapEnsureRuntime(hFalseClean.win);
  assert.equal(resFalseClean, false);
  assert.equal(hFalseClean.fetchCalls.length, 0);
  assert.equal(hFalseClean.win.__PI_ENH_DURABLE_STATE_ENABLED__, false);
  assert.equal(hFalseClean.appendedScripts.length, 1);
  assert.equal(hFalseClean.appendedScripts[0].durableFlagAtLoad, false);

  // 3. Explicit false but local old revision > 0 -> must NOT downgrade, forced to true without network wait
  const hFalseOldRev = createHarness({
    initialDurableFlag: false,
    storageEntries: { [DURABLE_STATE_REVISION_KEY]: "4" },
  });
  const resFalseOldRev = await bootstrapEnsureRuntime(hFalseOldRev.win);
  assert.equal(resFalseOldRev, true);
  assert.equal(hFalseOldRev.fetchCalls.length, 0);
  assert.equal(hFalseOldRev.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hFalseOldRev.appendedScripts[0].durableFlagAtLoad, true);

  // 4. Explicit false but local outbox key exists -> must NOT downgrade, forced to true
  const hFalseOutbox = createHarness({
    initialDurableFlag: false,
    storageEntries: { [`${DECORATION_OP_PREFIX}op-123`]: '{"opId":"op-123"}' },
  });
  const resFalseOutbox = await bootstrapEnsureRuntime(hFalseOutbox.win);
  assert.equal(resFalseOutbox, true);
  assert.equal(hFalseOutbox.fetchCalls.length, 0);
  assert.equal(hFalseOutbox.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hFalseOutbox.appendedScripts[0].durableFlagAtLoad, true);

  // 5. Explicit false but localStorage is unreadable -> must NOT downgrade, forced to true
  const hFalseUnreadable = createHarness({
    initialDurableFlag: false,
    unreadableStorage: true,
  });
  const resFalseUnreadable = await bootstrapEnsureRuntime(hFalseUnreadable.win);
  assert.equal(resFalseUnreadable, true);
  assert.equal(hFalseUnreadable.fetchCalls.length, 0);
  assert.equal(hFalseUnreadable.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
});

test("HEAD absent with local old revision, outbox keys, or unreadable localStorage stays fail-closed (durable=true)", async () => {
  const absentFetch = async () =>
    new Response(null, {
      status: 200,
      headers: { "X-Pi-Enhancement-State": "absent" },
    });

  // Case 1: absent + old revision > 0 -> true
  const hOldRev = createHarness({
    storageEntries: { [DURABLE_STATE_REVISION_KEY]: "1" },
    fetchImpl: absentFetch,
  });
  assert.equal(await bootstrapEnsureRuntime(hOldRev.win), true);
  assert.equal(hOldRev.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hOldRev.appendedScripts[0].durableFlagAtLoad, true);

  // Case 2: absent + pending outbox op -> true
  const hOutbox = createHarness({
    storageEntries: {
      [DURABLE_STATE_REVISION_KEY]: "0",
      [`${DECORATION_OP_PREFIX}pending-1`]: '{"opId":"pending-1"}',
    },
    fetchImpl: absentFetch,
  });
  assert.equal(await bootstrapEnsureRuntime(hOutbox.win), true);
  assert.equal(hOutbox.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hOutbox.appendedScripts[0].durableFlagAtLoad, true);

  // Case 3: absent + unreadable localStorage -> true
  const hUnreadable = createHarness({
    unreadableStorage: true,
    fetchImpl: absentFetch,
  });
  assert.equal(await bootstrapEnsureRuntime(hUnreadable.win), true);
  assert.equal(hUnreadable.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hUnreadable.appendedScripts[0].durableFlagAtLoad, true);

  // Case 4: direct helper check for corrupted revision string
  assert.equal(
    canUseLegacyModelsConfig(createMockStorage({ [DURABLE_STATE_REVISION_KEY]: "NaN" })),
    false,
  );
});

test("network failure, non-200 status, unknown header, and 3000ms AbortController timeout all stay fail-closed (durable=true) and clean up timers", async () => {
  // 1. Network error
  const hNetErr = createHarness({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(await bootstrapEnsureRuntime(hNetErr.win), true);
  assert.equal(hNetErr.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hNetErr.activeTimers.size, 0);
  assert.equal(hNetErr.appendedScripts.length, 1);

  // 2. Non-200 status (e.g. 401/403/500) even with absent header
  for (const status of [401, 403, 404, 500, 503]) {
    const hStatus = createHarness({
      fetchImpl: async () =>
        new Response(null, {
          status,
          headers: { "X-Pi-Enhancement-State": "absent" },
        }),
    });
    assert.equal(await bootstrapEnsureRuntime(hStatus.win), true);
    assert.equal(hStatus.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
    assert.equal(hStatus.activeTimers.size, 0);
  }

  // 3. 200 status with missing or unknown header
  for (const headerVal of [null, "", "unknown", "initializing"]) {
    const headers = headerVal === null ? {} : { "X-Pi-Enhancement-State": headerVal };
    const hUnknown = createHarness({
      fetchImpl: async () => new Response(null, { status: 200, headers }),
    });
    assert.equal(await bootstrapEnsureRuntime(hUnknown.win), true);
    assert.equal(hUnknown.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
    assert.equal(hUnknown.activeTimers.size, 0);
  }

  // 4. 3000ms AbortController timeout when request hangs
  let hangingSignal = null;
  const hTimeout = createHarness({
    fetchImpl: (_url, init) => {
      hangingSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    },
  });

  const timeoutPromise = bootstrapEnsureRuntime(hTimeout.win);
  assert.equal(hTimeout.timerCalls.length, 1);
  assert.equal(hTimeout.timerCalls[0].ms, 3000);
  assert.equal(hangingSignal.aborted, false);
  assert.equal(hTimeout.appendedScripts.length, 0);

  // Trigger the 3000ms timeout callback
  hTimeout.timerCalls[0].fn();
  assert.equal(hangingSignal.aborted, true);

  assert.equal(await timeoutPromise, true);
  assert.equal(hTimeout.win.__PI_ENH_DURABLE_STATE_ENABLED__, true);
  assert.equal(hTimeout.activeTimers.size, 0);
  assert.equal(hTimeout.appendedScripts.length, 1);
  assert.equal(hTimeout.appendedScripts[0].durableFlagAtLoad, true);
});

test("hot reload (__PI_ENH_RELOAD__) and script onerror retries remain intact", async () => {
  const h = createHarness({
    fetchImpl: async () =>
      new Response(null, {
        status: 200,
        headers: { "X-Pi-Enhancement-State": "present" },
      }),
  });

  await bootstrapEnsureRuntime(h.win, { standaloneVersion: "1.0.0" });
  assert.equal(h.appendedScripts.length, 1);
  assert.match(h.currentScript.src, /^\/pi-web-enhancements\.js\?v=koxir-1\.0\.0$/);

  // Simulate script onerror retry (up to 3 retries with backoff 1000, 2000, 3000)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const prevScript = h.currentScript;
    prevScript.onerror();
    const retryTimer = h.timerCalls.at(-1);
    assert.equal(retryTimer.ms, 1000 * attempt);
    retryTimer.fn();
    assert.equal(prevScript.removed, true);
    assert.equal(h.appendedScripts.length, 1 + attempt);
    assert.match(h.currentScript.src, /&t=\d+$/);
  }

  // 4th error does not schedule another retry
  const timersBeforeFourthErr = h.timerCalls.length;
  h.currentScript.onerror();
  assert.equal(h.timerCalls.length, timersBeforeFourthErr);

  // Manual hot reload via __PI_ENH_RELOAD__ replaces script even after __PI_WEB_ENHANCEMENTS_LOADED__ = true
  h.win.__PI_WEB_ENHANCEMENTS_LOADED__ = true;
  const scriptBeforeReload = h.currentScript;
  h.win.__PI_ENH_RELOAD__();
  assert.equal(scriptBeforeReload.removed, true);
  assert.equal(h.appendedScripts.length, 5);
  assert.match(h.currentScript.src, /&t=\d+$/);
});

test("bootstrap sets __PI_OFFICIAL_AGENT_VERSION__ and prevents canonical fake 0.99.1 override", async () => {
  const h1 = createHarness({
    fetchImpl: async () =>
      new Response(null, {
        status: 200,
        headers: { "X-Pi-Enhancement-State": "present" },
      }),
  });

  // Default version falls back safely to real SDK (0.87.1)
  await bootstrapEnsureRuntime(h1.win, { standaloneVersion: "1.1.0" });
  assert.equal(h1.win.__PI_OFFICIAL_AGENT_VERSION__, "0.87.1");

  const h2 = createHarness({
    fetchImpl: async () =>
      new Response(null, {
        status: 200,
        headers: { "X-Pi-Enhancement-State": "present" },
      }),
  });

  // Explicit official version is preserved
  await bootstrapEnsureRuntime(h2.win, {
    standaloneVersion: "1.1.0",
    officialPiVersion: "0.87.1",
  });
  assert.equal(h2.win.__PI_OFFICIAL_AGENT_VERSION__, "0.87.1");

  const h3 = createHarness({
    fetchImpl: async () =>
      new Response(null, {
        status: 200,
        headers: { "X-Pi-Enhancement-State": "present" },
      }),
  });

  // Fake canonical version 0.99.1 is sanitized and replaced with real SDK version
  h3.win.__PI_OFFICIAL_AGENT_VERSION__ = "0.99.1";
  await bootstrapEnsureRuntime(h3.win, {
    standaloneVersion: "1.1.0",
    officialPiVersion: "0.87.1",
  });
  assert.equal(h3.win.__PI_OFFICIAL_AGENT_VERSION__, "0.87.1");
});

test("standalone manifests remain private and supplied defaults contain no user metadata", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const publicDir = join(process.cwd(), "public");

  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert(packageJson.files.includes("!public/pi-*-manifest.json"), "Instance manifests must stay out of published packages");
  // Runtime manifests are installed separately by each instance. A source
  // snapshot extracted from a release may omit them; inspect only supplied
  // defaults, without requiring or importing NAS user metadata into the repo.
  for (const [name, validate] of [
    ["pi-shortcuts-manifest.json", (value) => assert(Array.isArray(value) && value.length >= 4)],
    ["pi-tags-manifest.json", (value) => { assert.deepEqual(value.definitions, []); assert.deepEqual(value.mappings, {}); }],
    ["pi-odoo-addons-manifest.json", (value) => assert.deepEqual(value.sessions, {})],
  ]) {
    const path = join(publicDir, name);
    if (existsSync(path)) validate(JSON.parse(readFileSync(path, "utf8")));
  }

  // 4. loader bridge script
  const loaderPath = join(publicDir, "pi-web-enhancement-loader.js");
  assert.equal(existsSync(loaderPath), true);
  const loaderContent = readFileSync(loaderPath, "utf8");
  assert.match(loaderContent, /__PI_WEB_LOADER_INJECTED__/);
});

test("native state endpoints omit instance query param while legacy preserves selector isolation", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const mod2Content = readFileSync(join(process.cwd(), "enhancements", "modules", "02-plugin-registry-and-settings-schema.js"), "utf8");
  const mod8Content = readFileSync(join(process.cwd(), "enhancements", "modules", "08-settings-panels-and-lifecycle.js"), "utf8");

  // Verify native mode omits instance query parameter for state endpoint
  assert.match(
    mod2Content,
    /const endpoint\s*=\s*isNative\s*\?\s*`\$\{getDurableStateBaseUrl\(\)\}\/enhancement-state`\s*:\s*`\$\{getDurableStateBaseUrl\(\)\}\/enhancement-state\?instance=\$\{getDurableStateInstanceParam\(\)\}`/
  );

  // Verify native mode omits instance query parameter for operations endpoint
  assert.match(
    mod2Content,
    /const endpoint\s*=\s*isNative\s*\?\s*`\$\{getDurableStateBaseUrl\(\)\}\/enhancement-state\/operations`\s*:\s*`\$\{getDurableStateBaseUrl\(\)\}\/enhancement-state\/operations\?instance=\$\{getDurableStateInstanceParam\(\)\}`/
  );

  // Verify 10.0.0.89 is recognized as Windows host and not Synology NAS
  assert.match(mod8Content, /hostname === "10\.0\.0\.89"/);
});



test('first boot uses content hash and integrity; hot reload and retry discover current compatible bytes', async () => {
  const oldPath=process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_PATH;
  const oldIntegrity=process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_INTEGRITY;
  process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_PATH='/pi-web-assets/enhancements-1234567890abcdef.js';
  process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_INTEGRITY='sha256-accepted';
  try {
    const h=createHarness({initialDurableFlag:true});
    await bootstrapEnsureRuntime(h.win);
    const first=h.appendedScripts[0].script;
    assert.equal(first.src,process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_PATH);
    assert.equal(first.integrity,'sha256-accepted');
    assert.equal(first.crossOrigin,'anonymous');
    h.win.__PI_ENH_RELOAD__(true);
    const next=h.appendedScripts[1].script;
    assert.match(next.src,/^\/pi-web-enhancements\.js\?v=.*&t=/);
    assert.equal(next.integrity,undefined);
    assert.equal(first.removed,true);
  } finally {
    if(oldPath===undefined)delete process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_PATH;else process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_PATH=oldPath;
    if(oldIntegrity===undefined)delete process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_INTEGRITY;else process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_INTEGRITY=oldIntegrity;
  }
});
