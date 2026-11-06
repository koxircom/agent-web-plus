import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

const client = await import("./connection-diagnostics-client.ts");
const { beginConnectionAttempt, flushConnectionDiagnostics, _resetConnectionDiagnosticsClientForTests } = client;
const STORAGE_KEY = "pi-web:connection-diagnostics:v1";
const TRACE_HEADER = "X-Agent-Web-Trace-ID";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const originalGlobals = new Map();
const originalDateNow = Date.now;
let clock;
let tabModuleSerial = 0;

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

function setGlobal(name, value) {
  if (!originalGlobals.has(name)) originalGlobals.set(name, {
    own: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: globalThis[name],
  });
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function createBrowser({
  online = true,
  fetcher = async () => Response.json({ accepted: 0 }, { status: 503 }),
  localStorage: sharedLocalStorage,
  sessionStorage: tabSessionStorage,
} = {}) {
  const localStorage = sharedLocalStorage ?? new MemoryStorage();
  const sessionStorage = tabSessionStorage ?? new MemoryStorage();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const win = {
    localStorage,
    sessionStorage,
    addEventListener(name, fn) { windowListeners.set(name, fn); },
    removeEventListener(name, fn) { if (windowListeners.get(name) === fn) windowListeners.delete(name); },
    dispatch(name) { windowListeners.get(name)?.(); },
  };
  const doc = {
    visibilityState: "visible",
    addEventListener(name, fn) { documentListeners.set(name, fn); },
    removeEventListener(name, fn) { if (documentListeners.get(name) === fn) documentListeners.delete(name); },
    dispatch(name) { documentListeners.get(name)?.(); },
  };
  const nav = { onLine: online };
  const browser = {
    localStorage,
    sessionStorage,
    window: win,
    document: doc,
    navigator: nav,
    fetcher,
    activate() {
      setGlobal("window", win);
      setGlobal("document", doc);
      setGlobal("navigator", nav);
      setGlobal("localStorage", localStorage);
      setGlobal("fetch", browser.fetcher);
    },
    setOnline(value) { nav.onLine = value; },
    setFetch(value) { browser.fetcher = value; if (globalThis.window === win) setGlobal("fetch", value); },
  };
  browser.activate();
  return browser;
}

async function createTabClient() {
  tabModuleSerial++;
  return import(`./connection-diagnostics-client.ts?tab=${tabModuleSerial}`);
}

function readState(browser) {
  return JSON.parse(browser.localStorage.getItem(STORAGE_KEY) ?? "{}");
}

function readEvents(browser) {
  return (readState(browser).events ?? []).map((row) => row.event);
}

function acknowledged(payload) {
  return Response.json({ accepted: payload.events.length }, { status: 202 });
}

beforeEach(() => {
  clock = originalDateNow();
  Date.now = () => clock;
  createBrowser({ online: false });
  _resetConnectionDiagnosticsClientForTests({ clearStorage: true });
});

afterEach(() => {
  _resetConnectionDiagnosticsClientForTests({ clearStorage: true });
  Date.now = originalDateNow;
  for (const [name, saved] of originalGlobals) {
    if (saved.own) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: saved.value });
    else delete globalThis[name];
  }
  originalGlobals.clear();
});

test("failures are sanitized, terminal once, coalesced, and recovered with outage totals", () => {
  const browser = createBrowser({ online: false });
  const first = beginConnectionAttempt({
    operation: "history_read",
    url: `https://agent.example/api/sessions/${SESSION_A}/entries?token=URL_SECRET&prompt=BODY_SECRET`,
    sessionId: SESSION_A,
    engine: "codex",
    timeoutMs: 9000,
  });
  assert.match(first.headers[TRACE_HEADER], /^[a-f0-9-]{36}$/i);
  assert.equal(first.headers[TRACE_HEADER], first.traceId);
  first.fail(new TypeError("MESSAGE_SECRET"), { status: 503 });
  first.success(200);
  first.fail(new Error("SECOND_ERROR_SECRET"), { status: 401 });

  assert.equal(readEvents(browser).length, 1, "the first terminal result wins");
  assert.equal(readEvents(browser)[0].reason, "upstream_unavailable");

  clock += 10_000;
  const retry = beginConnectionAttempt({
    operation: "history_read",
    url: `https://agent.example/api/sessions/${SESSION_A}/entries?token=another-secret`,
    sessionId: SESSION_A,
    engine: "codex",
  });
  retry.fail(new TypeError("MESSAGE_SECRET"), { status: 503 });
  assert.equal(readEvents(browser).length, 1, "unchanged failures inside 30 seconds coalesce");

  clock += 1000;
  const recovered = beginConnectionAttempt({
    operation: "history_read",
    url: `https://agent.example/api/sessions/${SESSION_A}/entries`,
    sessionId: SESSION_A,
    engine: "codex",
  });
  recovered.success(200);
  const events = readEvents(browser);
  assert.equal(events.length, 2);
  assert.equal(events[0].route, "/api/sessions/:id/entries");
  assert.equal(events[0].sessionId, SESSION_A);
  assert.equal(events[0].engine, "codex");
  assert.equal(events[0].errorName, "TypeError");
  assert.equal(events[1].event, "recovered");
  assert.equal(events[1].reason, "recovered");
  assert.equal(events[1].attempts, 2);
  assert.ok(events[1].outageMs >= 11_000);
  assert.equal(events[1].status, 200);
  const stored = browser.localStorage.getItem(STORAGE_KEY);
  for (const secret of ["URL_SECRET", "BODY_SECRET", "MESSAGE_SECRET", "SECOND_ERROR_SECRET", "another-secret"]) {
    assert.equal(stored.includes(secret), false, `${secret} is never persisted`);
  }
});

test("expected cancellation is terminal but produces no failure or recovery event", () => {
  const browser = createBrowser({ online: false });
  const attempt = beginConnectionAttempt({ operation: "session_events", url: "/api/agent/events" });
  const abort = new Error("expected close");
  abort.name = "AbortError";
  attempt.fail(abort, { cancelled: true });
  attempt.success();
  assert.deepEqual(readEvents(browser), []);
});

test("offline events survive a module reset and flush only acknowledged records", async () => {
  const browser = createBrowser({ online: false });
  const attempt = beginConnectionAttempt({
    operation: "session_read",
    url: `https://agent.example/api/sessions/${SESSION_A}?token=LOCAL_SECRET`,
  });
  attempt.fail(new TypeError("PRIVATE_MESSAGE"));
  assert.equal(readEvents(browser).length, 1);
  assert.match(browser.localStorage.getItem(STORAGE_KEY), /PRIVATE_MESSAGE|network_error/);
  assert.equal(browser.localStorage.getItem(STORAGE_KEY).includes("LOCAL_SECRET"), false);

  _resetConnectionDiagnosticsClientForTests();
  browser.setOnline(true);
  const requests = [];
  browser.setFetch(async (url, options) => {
    requests.push({ url, options, payload: JSON.parse(options.body) });
    return acknowledged(requests.at(-1).payload);
  });
  await flushConnectionDiagnostics();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/diagnostics/connections");
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.equal(requests[0].options.headers["content-type"], "application/json");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].payload.events.length, 1);
  assert.equal(requests[0].payload.events[0].source, "browser");
  assert.equal(readEvents(browser).length, 0);
});

test("memory retains an event while local persistence writes are unavailable", async () => {
  const storage = new MemoryStorage();
  const write = storage.setItem.bind(storage);
  let writesAvailable = false;
  storage.setItem = (key, value) => {
    if (!writesAvailable) throw new Error("storage unavailable");
    write(key, value);
  };
  const browser = createBrowser({ online: false, localStorage: storage });
  beginConnectionAttempt({ operation: "session_read", url: `/api/sessions/${SESSION_A}` }).fail(new Error("write failed"));
  await flushConnectionDiagnostics();

  writesAvailable = true;
  browser.setOnline(true);
  let accepted = 0;
  browser.setFetch(async (_url, options) => {
    accepted = JSON.parse(options.body).events.length;
    return Response.json({ accepted }, { status: 202 });
  });
  await flushConnectionDiagnostics();
  assert.equal(accepted, 1);
  assert.equal(readEvents(browser).length, 0);
});

test("failed logger attempts are rate limited to one per 15 seconds", async () => {
  const browser = createBrowser({ online: true });
  let calls = 0;
  browser.setFetch(async () => {
    calls++;
    if (calls === 1) throw new TypeError("logger network failure");
    return Response.json({ accepted: 1 }, { status: 202 });
  });
  beginConnectionAttempt({ operation: "status_poll", url: "/api/agent/running" }).fail(new Error("poll failed"));
  assert.equal(calls, 1, "recorded native failures trigger an immediate bounded flush");
  await flushConnectionDiagnostics();
  await flushConnectionDiagnostics();
  assert.equal(calls, 1);
  clock += 14_999;
  await flushConnectionDiagnostics();
  assert.equal(calls, 1);
  clock += 1;
  await flushConnectionDiagnostics();
  assert.equal(calls, 2);
  assert.equal(readEvents(browser).length, 0);
});

test("events appended during an in-flight batch remain queued", async () => {
  const browser = createBrowser({ online: true });
  let resolveFirst;
  let callCount = 0;
  browser.setFetch(() => {
    callCount++;
    return new Promise((resolve) => { resolveFirst = resolve; });
  });
  beginConnectionAttempt({ operation: "session_read", url: `/api/sessions/${SESSION_A}` }).fail(new Error("first"));
  const flushing = flushConnectionDiagnostics();
  beginConnectionAttempt({ operation: "session_read", url: `/api/sessions/${SESSION_B}` }).fail(new Error("second"));
  resolveFirst(Response.json({ accepted: 1 }, { status: 202 }));
  await flushing;
  assert.equal(callCount, 1);
  const pending = readEvents(browser);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, SESSION_B);
});

test("timeout and HTTP failures retain distinct reasons, and logger errors never escape", async () => {
  const browser = createBrowser({ online: false });
  const timedOut = beginConnectionAttempt({ operation: "session_read", url: `/api/sessions/${SESSION_A}` });
  timedOut.fail(new Error("timeout details"), { timedOut: true });
  const httpFailure = beginConnectionAttempt({ operation: "session_read", url: `/api/sessions/${SESSION_A}` });
  httpFailure.fail(new Error("proxy details"), { status: 503 });
  assert.deepEqual(readEvents(browser).map((event) => event.reason), ["request_timeout", "upstream_unavailable"]);

  browser.setOnline(true);
  browser.setFetch(async () => { throw new Error("logger down"); });
  assert.doesNotThrow(() => beginConnectionAttempt({ operation: "status_poll", url: "/api/agent/running" }).success(200));
  await assert.doesNotReject(flushConnectionDiagnostics());
  assert.equal(readEvents(browser).length, 2);
});

test("a response body that never resolves is aborted at the flush deadline and retained", async () => {
  const browser = createBrowser({ online: false });
  beginConnectionAttempt({ operation: "session_read", url: `/api/sessions/${SESSION_A}` }).fail(new Error("offline"));
  await flushConnectionDiagnostics();
  browser.setOnline(true);
  let signal;
  browser.setFetch(async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 202, json: () => new Promise(() => {}) };
  });

  const startedAt = originalDateNow();
  await flushConnectionDiagnostics();
  assert.ok(originalDateNow() - startedAt >= 2200, "flush remains bounded by the configured body timeout");
  assert.equal(signal.aborted, true);
  assert.equal(readEvents(browser).length, 1, "an unacknowledged batch remains queued");
});

test("diagnostic endpoint attempts are excluded to prevent logger recursion", () => {
  const browser = createBrowser({ online: false });
  const attempt = beginConnectionAttempt({ operation: "upstream", url: "/api/diagnostics/connections?token=PRIVATE" });
  attempt.fail(new Error("logger failure"));
  assert.deepEqual(readEvents(browser), []);
});

test("Pi and Codex status outages remain independent on the shared route", () => {
  const browser = createBrowser({ online: false });
  const codexFailure = beginConnectionAttempt({
    operation: "status_poll",
    url: "/api/agent/running?engine=codex",
    engine: "codex",
  });
  codexFailure.fail(new TypeError("codex transport error"), { status: 503 });

  beginConnectionAttempt({
    operation: "status_poll",
    url: "/api/agent/running?engine=pi",
    engine: "pi",
  }).success(200);
  assert.deepEqual(readEvents(browser).map((event) => event.engine), ["codex"]);

  beginConnectionAttempt({
    operation: "status_poll",
    url: "/api/agent/running?engine=codex",
    engine: "codex",
  }).fail(new TypeError("codex transport error"), { status: 503 });
  assert.equal(readEvents(browser).length, 1, "the matching Codex outage remains coalesced");

  beginConnectionAttempt({
    operation: "status_poll",
    url: "/api/agent/running?engine=codex",
    engine: "codex",
  }).success(200);
  const events = readEvents(browser);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "recovered");
  assert.equal(events[1].engine, "codex");
  assert.equal(events[1].attempts, 2);
});

test("a healthy second tab cannot clear the first tab's outage", async () => {
  const storage = new MemoryStorage();
  const firstTab = createBrowser({ online: false, localStorage: storage });
  const tabA = client;
  const tabB = await createTabClient();
  _resetConnectionDiagnosticsClientForTests();
  tabB._resetConnectionDiagnosticsClientForTests();

  const outage = beginConnectionAttempt({ operation: "status_poll", url: "/api/agent/running?engine=pi", engine: "pi" });
  outage.fail(new TypeError("first tab lost connection"), { status: 503 });
  const pageA = readEvents(firstTab)[0].pageId;

  const secondTab = createBrowser({ online: false, localStorage: storage });
  tabB.beginConnectionAttempt({ operation: "status_poll", url: "/api/agent/running?engine=pi", engine: "pi" }).success(200);
  const state = readState(secondTab);
  assert.equal(state.outages.length, 1);
  assert.equal(state.outages[0].pageId, pageA);
  assert.equal(state.events.length, 1);

  firstTab.activate();
  tabA._resetConnectionDiagnosticsClientForTests();
  tabB._resetConnectionDiagnosticsClientForTests();
});

test("a stale tab does not resend events another tab acknowledged", async () => {
  const storage = new MemoryStorage();
  const firstTab = createBrowser({ online: false, localStorage: storage });
  const tabB = await createTabClient();
  tabB._resetConnectionDiagnosticsClientForTests();
  beginConnectionAttempt({ operation: "session_read", url: `/api/sessions/${SESSION_A}` }).fail(new Error("queued once"));
  assert.equal(readEvents(firstTab).length, 1);

  const secondTab = createBrowser({ online: true, localStorage: storage });
  const requests = [];
  secondTab.setFetch(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return acknowledged(requests.at(-1));
  });
  await tabB.flushConnectionDiagnostics();
  assert.equal(requests.length, 1);
  assert.equal(readEvents(secondTab).length, 0);

  firstTab.activate();
  let staleResends = 0;
  firstTab.setFetch(async () => {
    staleResends++;
    return Response.json({ accepted: 1 }, { status: 202 });
  });
  await flushConnectionDiagnostics();
  assert.equal(staleResends, 0);
  assert.equal(readEvents(firstTab).length, 0);
  tabB._resetConnectionDiagnosticsClientForTests();
});
