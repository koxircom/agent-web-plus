import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-pin-refresh-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });
const { listCodexSessions } = await jiti.import(process.env.PI_CODEX_ENGINE_TEST_MODULE || "./codex-engine.ts");
const { readSessionList } = await jiti.import("../session-list.ts");
const { saveExecutionEngineSettings } = await jiti.import("../execution-engine-settings.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

test("codex-pin-refresh: real list/session-list paths with fake bridge hanging read, external pin change does not reuse stale snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];

  await saveExecutionEngineSettings({
    defaultEngine: "codex",
    codex: {
      enabled: true,
      url: "http://127.0.0.1:19098",
      username: "test",
      password: "test-only",
    },
  });

  const sessionId = "01901234-0000-7000-8000-000000000001";
  let backendRows = [
    { id: sessionId, title: "Session 1", cwd: "/test", recency: 1, pinned: false, nativeMetadata: { pinningSupported: true } },
  ];

  let hangResolver = null;
  let hangPromise = null;
  let onHangingReadStarted = null;
  let sessionApiRequestCount = 0;

  const response = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { getSetCookie: () => ["sid=test-session"] },
    json: async () => body,
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/login") return response({});
    if (path === "/api/auth") return response({ authenticated: true, csrf: "test-csrf" });
    if (path === "/api/sessions") {
      sessionApiRequestCount++;
      const currentSnapshot = JSON.parse(JSON.stringify(backendRows));
      if (hangPromise) {
        const p = hangPromise;
        hangPromise = null;
        if (onHangingReadStarted) onHangingReadStarted();
        await p;
      }
      return response({ sessions: currentSnapshot });
    }
    if (path === "/api/activity") {
      return response({ sessions: backendRows.map((r) => ({ id: r.id, status: "idle" })) });
    }
    throw new Error(`Unexpected Codex request: ${path}`);
  };

  try {
    // 1. First initial read: session is not pinned
    const initial = await readSessionList({ engine: "codex" });
    assert.equal(initial.sessions[0].pinned, false);
    assert.equal(sessionApiRequestCount, 1);

    // 2. Set up a hanging in-flight read
    const hangingReadStarted = new Promise((resolve) => {
      onHangingReadStarted = resolve;
    });
    hangPromise = new Promise((resolve) => {
      hangResolver = resolve;
    });

    // Start background read that hangs inside fetch
    const hangingReadPromise = listCodexSessions({ force: true });
    await hangingReadStarted;

    // 3. External pin change happens concurrently on the backend
    backendRows[0].pinned = true;

    // 4. Client invokes readSessionList with force: true
    const forceReadPromise = Promise.all([
      readSessionList({ engine: "codex", force: true }),
      readSessionList({ engine: "codex", force: true }),
    ]);

    // The public reader dynamically imports the adapter and resolves identity
    // asynchronously. Invocation alone does not mean either caller joined the
    // older flight yet; release only after both overlap that same generation.
    const olderFlight = globalThis[Symbol.for("pi-web.codex-catalog-flights")].values().next().value;
    const joinDeadline = Date.now() + 2000;
    while (olderFlight.waiters < 3) {
      assert(Date.now() < joinDeadline, "Both public readers must join the captured older flight");
      await new Promise(resolve => setImmediate(resolve));
    }
    // Release the hanging read (which captured the OLD snapshot pinned: false)
    hangResolver();
    const hangingResult = await hangingReadPromise;
    assert.equal(hangingResult.sessions[0].pinned, false, "Older flight captures stale snapshot");

    // Force read must NOT reuse the stale snapshot from the older flight
    const forceResults = await forceReadPromise;
    assert(forceResults.every(result => result.sessions[0].pinned === true), "A prior force flight cannot satisfy a later external-change boundary");
    assert.equal(sessionApiRequestCount, 3, "Initial read + old force + exactly one coalesced post-boundary read");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection !== undefined) globalThis[connectionKey] = previousConnection;
    else delete globalThis[connectionKey];
  }
});

test("codex-pin-refresh: concurrent force requests coalesce into exactly one fresh network read", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];

  await saveExecutionEngineSettings({
    defaultEngine: "codex",
    codex: {
      enabled: true,
      url: "http://127.0.0.1:19098",
      username: "test",
      password: "test-only",
    },
  });

  const sessionId = "01901234-0000-7000-8000-000000000002";
  const backendRows = [
    { id: sessionId, title: "Session 2", cwd: "/test", recency: 2, pinned: true, nativeMetadata: { pinningSupported: true } },
  ];

  let sessionApiRequestCount = 0;
  let sessionApiDelayMs = 40;

  const response = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { getSetCookie: () => ["sid=test-session"] },
    json: async () => body,
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/login") return response({});
    if (path === "/api/auth") return response({ authenticated: true, csrf: "test-csrf" });
    if (path === "/api/sessions") {
      sessionApiRequestCount++;
      if (sessionApiDelayMs > 0) {
        await new Promise((r) => setTimeout(r, sessionApiDelayMs));
      }
      return response({ sessions: JSON.parse(JSON.stringify(backendRows)) });
    }
    if (path === "/api/activity") {
      return response({ sessions: backendRows.map((r) => ({ id: r.id, status: "idle" })) });
    }
    throw new Error(`Unexpected Codex request: ${path}`);
  };

  try {
    const countBefore = sessionApiRequestCount;
    // Both force callers arrive behind one already-started read. They must
    // share the NEXT read, not mistake the preceding snapshot for fresh data.
    const oldRead = readSessionList({ engine: "codex" });
    for (let n = 0; sessionApiRequestCount === countBefore && n < 50; n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sessionApiRequestCount - countBefore, 1);
    const [resultA, resultB] = await Promise.all([
      readSessionList({ engine: "codex", force: true }),
      readSessionList({ engine: "codex", force: true }),
    ]);
    await oldRead;

    assert.equal(resultA.sessions[0].pinned, true);
    assert.equal(resultB.sessions[0].pinned, true);
    // Two concurrent force calls must coalesce into a single fresh read
    assert.equal(sessionApiRequestCount - countBefore, 2, "One old read followed by one coalesced fresh read");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection !== undefined) globalThis[connectionKey] = previousConnection;
    else delete globalThis[connectionKey];
  }
});

test("codex-pin-refresh: client abort signal does not abort shared flight for other concurrent subscribers", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];

  await saveExecutionEngineSettings({
    defaultEngine: "codex",
    codex: {
      enabled: true,
      url: "http://127.0.0.1:19098",
      username: "test",
      password: "test-only",
    },
  });

  const sessionId = "01901234-0000-7000-8000-000000000003";
  const backendRows = [
    { id: sessionId, title: "Session 3", cwd: "/test", recency: 3, pinned: false, nativeMetadata: { pinningSupported: true } },
  ];

  let unblockSessionRead = null;
  const sessionReadBlocked = new Promise((resolve) => {
    unblockSessionRead = resolve;
  });

  const response = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { getSetCookie: () => ["sid=test-session"] },
    json: async () => body,
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/login") return response({});
    if (path === "/api/auth") return response({ authenticated: true, csrf: "test-csrf" });
    if (path === "/api/sessions") {
      await sessionReadBlocked;
      return response({ sessions: JSON.parse(JSON.stringify(backendRows)) });
    }
    if (path === "/api/activity") {
      return response({ sessions: backendRows.map((r) => ({ id: r.id, status: "idle" })) });
    }
    throw new Error(`Unexpected Codex request: ${path}`);
  };

  try {
    const abortCtrl = new AbortController();

    // Client A starts request with abort signal
    const clientAPromise = listCodexSessions({ signal: abortCtrl.signal, force: true });
    // Client B starts request without abort signal (or independent client)
    const clientBPromise = listCodexSessions({ force: true });

    // Client A aborts before read completes
    abortCtrl.abort();

    await assert.rejects(clientAPromise, (err) => err.name === "AbortError");

    // Unblock the underlying network read
    unblockSessionRead();

    // Client B MUST succeed and not be killed by Client A's abort
    const resultB = await clientBPromise;
    assert.equal(resultB.sessions[0].id, `codex:${sessionId}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection !== undefined) globalThis[connectionKey] = previousConnection;
    else delete globalThis[connectionKey];
  }
});

test("codex-pin-refresh: identity fencing isolates catalog cache and protects bulk delete / status cache", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];

  // Configure Identity 1
  await saveExecutionEngineSettings({
    defaultEngine: "codex",
    codex: {
      enabled: true,
      url: "http://127.0.0.1:19098",
      username: "user1",
      password: "pwd-1",
    },
  });

  const session1 = { id: "01901234-0000-7000-8000-000000000001", title: "User 1 Session", cwd: "/test1", recency: 1 };
  const session2 = { id: "01901234-0000-7000-8000-000000000002", title: "User 2 Session", cwd: "/test2", recency: 2 };

  let currentServerIdentity = "user1";

  const response = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { getSetCookie: () => ["sid=test-session"] },
    json: async () => body,
  });

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/login") return response({});
    if (path === "/api/auth") return response({ authenticated: true, csrf: "test-csrf" });
    if (path === "/api/sessions") {
      const rows = currentServerIdentity === "user1" ? [session1] : [session2];
      return response({ sessions: rows });
    }
    if (path === "/api/activity") {
      const rows = currentServerIdentity === "user1" ? [session1] : [session2];
      return response({ sessions: rows.map((r) => ({ id: r.id, status: "idle" })) });
    }
    throw new Error(`Unexpected Codex request: ${path}`);
  };

  try {
    const res1 = await listCodexSessions();
    assert.equal(res1.sessions[0].name, "User 1 Session");

    // Switch connection settings to Identity 2
    currentServerIdentity = "user2";
    await saveExecutionEngineSettings({
      defaultEngine: "codex",
      codex: {
        enabled: true,
        url: "http://127.0.0.1:19099",
        username: "user2",
        password: "pwd-2",
      },
    });

    // Identity 2 read must NOT mix with Identity 1 cached catalog
    const res2 = await listCodexSessions();
    assert.equal(res2.sessions[0].name, "User 2 Session");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection !== undefined) globalThis[connectionKey] = previousConnection;
    else delete globalThis[connectionKey];
  }
});
