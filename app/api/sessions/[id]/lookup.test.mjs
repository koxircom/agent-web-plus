import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { selectSessionReadRuntime } from "../../../../lib/session-read-source.ts";

const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const routeFile = ts.createSourceFile(
  "route.ts",
  routeSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const getDeclaration = routeFile.statements.find((statement) =>
  ts.isFunctionDeclaration(statement)
  && statement.name?.text === "GET"
  && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
);
assert.ok(getDeclaration, "route must export the GET callback");

// Keep this test coupled to the actual exported callback while avoiding the route's
// heavyweight module graph. The extracted function still runs with the real
// NextResponse implementation and controlled dependency seams.
const getFunctionSource = getDeclaration.getText(routeFile).replace(/^export\s+/, "");
const { outputText: compiledGet } = ts.transpileModule(`(${getFunctionSource})`, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});

function makeWrapper({ running, sessionFile = "" }) {
  let evictions = 0;
  return {
    isAlive: () => true,
    isRunning: () => running,
    evictIfDiskAhead: () => {
      evictions += 1;
      return false;
    },
    get sessionFile() {
      return sessionFile;
    },
    get evictions() {
      return evictions;
    },
  };
}

function makeHarness() {
  const state = {
    rpc: null,
    resolvedPath: null,
    fingerprint: null,
    header: null,
  };
  const calls = {
    resolvePath: 0,
    fingerprint: [],
    header: [],
    history: 0,
    snapshot: 0,
    sync: 0,
    start: 0,
  };
  const unsupported = (name) => {
    calls[name] += 1;
    throw new Error(`${name} must not run during lookup`);
  };
  const dependencyContext = {
    selectSessionReadRuntime,
    isSessionReadStable: () => true,
    NextResponse,
    existsSync: () => unsupported("existsSync"),
    statSync: () => unsupported("statSync"),
    deleteSessions: () => unsupported("deleteSessions"),
    attachSessionProjectInfo: () => unsupported("attachSessionProjectInfo"),
    openSessionManager: () => unsupported("openSessionManager"),
    resolveSessionPath: async () => {
      calls.resolvePath += 1;
      return state.resolvedPath;
    },
    resolveSessionIdByPath: () => unsupported("resolveSessionIdByPath"),
    invalidateSessionListCache: () => unsupported("invalidateSessionListCache"),
    invalidateSessionManagerCache: () => unsupported("invalidateSessionManagerCache"),
    getSessionFileFingerprint: (filePath) => {
      calls.fingerprint.push(filePath);
      return state.fingerprint;
    },
    readSessionHeader: (filePath) => {
      calls.header.push(filePath);
      return state.header;
    },
    getRpcSession: () => state.rpc,
    startRpcSession: () => unsupported("start"),
    startServerPerf: () => undefined,
    jsonResponse: () => unsupported("jsonResponse"),
    negotiateSessionSync: () => unsupported("negotiateSessionSync"),
    getSessionHistoryPool: () => {
      calls.history += 1;
      throw new Error("history worker must not run during lookup");
    },
    HistoryAbortedError: class HistoryAbortedError extends Error {},
    buildSessionDetailSnapshot: () => {
      calls.snapshot += 1;
      throw new Error("detail snapshot must not run during lookup");
    },
    GUARD_VERSION: "test-guard",
    ensureSessionWriteGuardInstalled: () => unsupported("ensureSessionWriteGuardInstalled"),
    URL,
    URLSearchParams,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Date,
    console,
  };
  const GET = new Script(compiledGet).runInNewContext(dependencyContext);
  assert.equal(typeof GET, "function", "AST extraction must evaluate to GET");
  return { state, calls, GET };
}

function lookupRequest(id) {
  return new Request(`http://localhost/api/sessions/${encodeURIComponent(id)}?lookup=1`);
}

async function invoke(harness, id) {
  return harness.GET(lookupRequest(id), { params: Promise.resolve({ id }) });
}

function assertLookupHeaders(response) {
  assert.ok(response instanceof NextResponse, "lookup must return the real NextResponse");
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function assertNoHeavyReads(calls) {
  assert.equal(calls.history, 0);
  assert.equal(calls.snapshot, 0);
  assert.equal(calls.sync, 0);
  assert.equal(calls.start, 0);
}

test("lookup returns 200 only for a matching disk session header", async () => {
  const harness = makeHarness();
  harness.state.resolvedPath = "/sessions/valid.jsonl";
  harness.state.fingerprint = "dev:ino:size:mtime:ctime";
  harness.state.header = { type: "session", id: "valid-id" };

  const response = await invoke(harness, "valid-id");

  assert.equal(response.status, 200);
  assertLookupHeaders(response);
  assert.deepEqual(await response.json(), { sessionId: "valid-id", exists: true });
  assert.equal(harness.calls.resolvePath, 1);
  assert.deepEqual(harness.calls.fingerprint, ["/sessions/valid.jsonl"]);
  assert.deepEqual(harness.calls.header, ["/sessions/valid.jsonl"]);
  assertNoHeavyReads(harness.calls);
});

test("lookup returns 404 when the session path cannot be resolved", async () => {
  const harness = makeHarness();

  const response = await invoke(harness, "missing-id");

  assert.equal(response.status, 404);
  assertLookupHeaders(response);
  assert.deepEqual(await response.json(), { error: "Session not found" });
  assert.equal(harness.calls.resolvePath, 1);
  assert.deepEqual(harness.calls.fingerprint, []);
  assert.deepEqual(harness.calls.header, []);
  assertNoHeavyReads(harness.calls);
});

test("lookup rejects a stale cached path whose file fingerprint disappeared", async () => {
  const harness = makeHarness();
  harness.state.resolvedPath = "/sessions/stale.jsonl";
  harness.state.fingerprint = null;
  harness.state.header = { type: "session", id: "stale-id" };

  const response = await invoke(harness, "stale-id");

  assert.equal(response.status, 404);
  assertLookupHeaders(response);
  assert.deepEqual(await response.json(), { error: "Session not found" });
  assert.deepEqual(harness.calls.fingerprint, ["/sessions/stale.jsonl"]);
  assert.deepEqual(harness.calls.header, [], "header identity is not read after a missing fingerprint");
  assertNoHeavyReads(harness.calls);
});

test("lookup rejects a file whose header belongs to another session", async () => {
  const harness = makeHarness();
  harness.state.resolvedPath = "/sessions/wrong-header.jsonl";
  harness.state.fingerprint = "dev:ino:size:mtime:ctime";
  harness.state.header = { type: "session", id: "other-id" };

  const response = await invoke(harness, "requested-id");

  assert.equal(response.status, 404);
  assertLookupHeaders(response);
  assert.deepEqual(await response.json(), { error: "Session not found" });
  assert.deepEqual(harness.calls.fingerprint, ["/sessions/wrong-header.jsonl"]);
  assert.deepEqual(harness.calls.header, ["/sessions/wrong-header.jsonl"]);
  assertNoHeavyReads(harness.calls);
});

test("lookup accepts an active writer even before its session file exists", async () => {
  const harness = makeHarness();
  const wrapper = makeWrapper({ running: true });
  harness.state.rpc = wrapper;

  const response = await invoke(harness, "active-id");

  assert.equal(response.status, 200);
  assertLookupHeaders(response);
  assert.deepEqual(await response.json(), { sessionId: "active-id", exists: true });
  assert.equal(harness.calls.resolvePath, 0, "active lookup must not scan the session catalogue");
  assert.deepEqual(harness.calls.fingerprint, []);
  assert.deepEqual(harness.calls.header, []);
  assert.equal(wrapper.evictions, 0);
  assertNoHeavyReads(harness.calls);
});

test("lookup returns 404 for an idle retained wrapper whose file disappeared", async () => {
  const harness = makeHarness();
  const wrapper = makeWrapper({ running: false, sessionFile: "/sessions/disappeared.jsonl" });
  harness.state.rpc = wrapper;

  const response = await invoke(harness, "idle-id");

  assert.equal(response.status, 404);
  assertLookupHeaders(response);
  assert.deepEqual(await response.json(), { error: "Session not found" });
  assert.equal(harness.calls.resolvePath, 1);
  assert.equal(wrapper.evictions, 0, "lookup must not evict an idle wrapper");
  assertNoHeavyReads(harness.calls);
});
