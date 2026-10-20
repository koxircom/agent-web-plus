import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const sessionListSource = await readFile(new URL("../../../lib/session-list.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd(), "server-only": "next/dist/compiled/server-only/empty.js" },
  interopDefault: true,
  moduleCache: false,
});
const { DELETE: deleteSession, GET: getSessionDetail, PATCH: renameSession } = await jiti.import("./[id]/route.ts");
const { GET: getSessionList } = await jiti.import("./route.ts");
const { GET: getRunningSessions } = await jiti.import("../agent/running/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const {
  cacheSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
} = await jiti.import("../../../lib/session-reader.ts");
const { getSessionHistoryPool } = await jiti.import("../../../lib/session-history-pool.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { AgentSessionWrapper } = await jiti.import("../../../lib/rpc-manager.ts");
const { GET: getSessionContext } = await jiti.import("./[id]/context/route.ts");

test("idle SDK bootstrap reads memory before its first message and switches to disk after persistence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bootstrap-read-"));
  const previousRegistry = globalThis.__piSessions;
  const manager = SessionManager.create(dir, dir);
  manager.appendCustomEntry("pi-web:tool-selection", { toolNames: [] });
  const id = manager.getSessionId(), file = manager.getSessionFile();
  const wrapper = {
    inner: { sessionManager: manager, sessionId: id },
    sessionFile: file, sessionId: id, cwd: dir,
    isAlive: () => true, isRunning: () => false,
    hasUnpersistedSession: AgentSessionWrapper.prototype.hasUnpersistedSession,
    send: async () => ({}),
  };
  globalThis.__piSessions = new Map([[id, wrapper]]);
  cacheSessionPath(id, file);
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    invalidateSessionPathCache(id);
    await getSessionHistoryPool().closeAll();
    await rm(dir, { recursive: true, force: true });
  });
  const routeContext = { params: Promise.resolve({ id }) };
  assert.equal(wrapper.hasUnpersistedSession(), true);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  const detail = await getSessionDetail(new Request(`http://localhost/api/sessions/${id}?sync=1&tree=summary`), routeContext);
  const payload = await detail.json();
  assert.equal(detail.status, 200, JSON.stringify(payload));
  assert.equal(payload.revision, null, "unpersisted memory must not become a certified disk baseline");
  assert.deepEqual(payload.data.context.messages, []);
  const context = await getSessionContext(new Request(`http://localhost/api/sessions/${id}/context?tail=5`), routeContext);
  assert.equal(context.status, 200, JSON.stringify(await context.clone().json()));
  assert.deepEqual((await context.json()).context.messages, []);
  await assert.rejects(readFile(file), { code: "ENOENT" }, "reading bootstrap must not invent a persisted transcript");

  manager.appendMessage({ role: "user", content: "First native prompt", timestamp: Date.now() });
  assert.equal(wrapper.hasUnpersistedSession(), false);
  const disk = await getSessionDetail(new Request(`http://localhost/api/sessions/${id}?tree=summary`), routeContext);
  const saved = await disk.json();
  assert.equal(disk.status, 200, JSON.stringify(saved));
  assert.equal(saved.context.messages[0].content, "First native prompt");
  assert.equal(typeof saved.snapshotRevision, "string");
  await rm(file);
  assert.equal(wrapper.hasUnpersistedSession(), false, "externally removed old history is not a new bootstrap");
});

test("list versions expose idle session creation, rename and deletion to other windows", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-list-sync-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionsDir = process.env.PI_SESSIONS_DIR;
  const previousUsageDataDir = process.env.PI_USAGE_DATA_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_SESSIONS_DIR = dir;
  delete process.env.PI_USAGE_DATA_DIR;
  invalidateSessionListCache();
  let sessionId;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = previousSessionsDir;
    if (previousUsageDataDir === undefined) delete process.env.PI_USAGE_DATA_DIR;
    else process.env.PI_USAGE_DATA_DIR = previousUsageDataDir;
    if (sessionId) invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });
  const list = async () => {
    const response = await getSessionList(new Request("http://localhost/api/sessions"));
    assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(await response.clone().json()));
    return response.json();
  };
  const initial = await list();
  assert.deepEqual(initial.sessions, []);

  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: "Cross-window search fixture", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Already finished" }], timestamp: Date.now() });
  sessionId = manager.getSessionId();
  invalidateSessionListCache();
  const created = await list();
  assert.ok(created.sessionListVersion > initial.sessionListVersion);
  assert.equal(created.sessions[0].id, sessionId);
  assert.deepEqual(created.runningSessionIds, []);

  const context = { params: Promise.resolve({ id: sessionId }) };
  const url = `http://localhost/api/sessions/${sessionId}`;
  const renamed = await renameSession(new Request(url, { method: "PATCH", body: JSON.stringify({ name: "Renamed elsewhere" }) }), context);
  assert.equal(renamed.status, 200);
  const poll = await (await getRunningSessions(new Request("http://localhost/api/agent/running?engine=pi"))).json();
  assert.deepEqual(poll.runningSessionIds, []);
  assert.ok(poll.sessionListVersion > created.sessionListVersion);
  const updated = await list();
  assert.equal(updated.sessionListVersion, poll.sessionListVersion);
  assert.equal(updated.sessions[0].name, "Renamed elsewhere");
  assert.equal((await list()).sessionListVersion, poll.sessionListVersion, "reads must not create a refresh loop");

  assert.equal((await deleteSession(new Request(url, { method: "DELETE" }), context)).status, 200);
  const deleted = await list();
  assert.ok(deleted.sessionListVersion > updated.sessionListVersion);
  assert.deepEqual(deleted.sessions, []);
  assert.equal((await (await getRunningSessions(new Request("http://localhost/api/agent/running?engine=pi"))).json()).sessionListVersion, deleted.sessionListVersion);
});

test("session listing returns a gzip-compressed response when the client accepts it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-list-gzip-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  const firstMessage = "compressible session content ".repeat(500);
  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: firstMessage, timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() });
  invalidateSessionListCache();

  const response = await getSessionList(new Request("http://localhost/api/sessions", {
    headers: { "Accept-Encoding": "gzip" },
  }));

  assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(await response.clone().json()));
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  assert.match(response.headers.get("Vary") ?? "", /(?:^|,\s*)Accept-Encoding(?:\s*,|$)/i);
  const payload = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  assert.equal(payload.sessions[0].firstMessage, firstMessage);
});

test("deleting an unpersisted session shuts down its runtime and invalidates caches", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-empty-"));
  // The SDK catalogue uses agentDir/sessions even when the seal-worker root
  // is overridden. Keep both test roots valid regardless of prior test order.
  await mkdir(join(dir, "sessions"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionsDir = process.env.PI_SESSIONS_DIR;
  const previousUsageDataDir = process.env.PI_USAGE_DATA_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_SESSIONS_DIR = dir;
  delete process.env.PI_USAGE_DATA_DIR;
  const previousRegistry = globalThis.__piSessions;
  const ids = [];
  globalThis.__piSessions = new Map();
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = previousSessionsDir;
    if (previousUsageDataDir === undefined) delete process.env.PI_USAGE_DATA_DIR;
    else process.env.PI_USAGE_DATA_DIR = previousUsageDataDir;
    globalThis.__piSessions = previousRegistry;
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  for (const persistOnShutdown of [false, true]) {
    const manager = SessionManager.create(dir, dir);
    const id = manager.getSessionId();
    const filePath = manager.getSessionFile();
    ids.push(id);
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
    cacheSessionPath(id, filePath);
    let shutdownCalled = false;
    globalThis.__piSessions.set(id, {
      isAlive: () => true,
      isRunning: () => false,
      getPendingProjectRequests: () => [],
      shutdown: async () => {
        shutdownCalled = true;
        if (persistOnShutdown) await writeFile(filePath, JSON.stringify(manager.getHeader()));
        globalThis.__piSessions.delete(id);
      },
    });
    const before = (await (await getRunningSessions(new Request("http://localhost/api/agent/running?engine=pi"))).json()).sessionListVersion;
    const response = await deleteSession(
      new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id }) },
    );

    assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(await response.clone().json()));
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(shutdownCalled, true);
    assert.equal(globalThis.__piSessions.has(id), false);
    assert.equal(globalThis.__piSessionPathCache.has(id), false);
    assert.equal([...globalThis.__piPathToSessionIdCache.values()].includes(id), false);
    assert.ok((await (await getRunningSessions(new Request("http://localhost/api/agent/running?engine=pi"))).json()).sessionListVersion > before);
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
  }
});

test("session listing supports cheap summaries and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("summary"\) === "1"/);
  assert.match(listRoute, /readSessionList\(\{\s*summary,\s*force,\s*engine\s*\}\)/);
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(sessionListSource, /options\.summary \? listSessionSummaries\(\) : listAllSessions\(\{ force: options\.force \}\)/);
  assert.match(sessionListSource, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(sessionListSource, /mergeSessionLists\(sessions, runtime\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads prefer active writers while context delegates to its read service", () => {
  const liveLookup = detailRoute.indexOf("getRpcSession(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(detailRoute.indexOf("resolveSessionPath(id)") > liveLookup);
  assert.match(detailRoute, /selectSessionReadRuntime\(liveWrapper\)/);
  assert.match(detailRoute, /buildSessionDetailSnapshot\(liveRpc\.inner\.sessionManager/);
  assert.match(detailRoute, /pool\.querySessionDetailResult\(actualFilePath/);
  assert.match(contextRoute, /return handleSessionContextRequest\(req, \{ id \}\)/);
});

test("detail reads probe disk only on force/mount and evict a stale idle wrapper", () => {
  assert.match(detailRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(detailRoute, /force && liveWrapper\?\.evictIfDiskAhead\(\)/);
  assert.doesNotMatch(contextRoute, /evictIfDiskAhead|readLatestSessionEntryId/);
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("deleting a session removes all persisted subagent descendants", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-reparent-"));
  await mkdir(join(dir, "sessions"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionsDir = process.env.PI_SESSIONS_DIR;
  const previousUsageDataDir = process.env.PI_USAGE_DATA_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_SESSIONS_DIR = dir;
  delete process.env.PI_USAGE_DATA_DIR;
  invalidateSessionListCache();
  const grandparentPath = join(dir, "grandparent.jsonl");
  const parentPath = join(dir, "parent.jsonl");
  const childPath = join(dir, "child.jsonl");
  const grandchildPath = join(dir, "grandchild.jsonl");
  const parentId = "delete-reparent-parent";
  const childId = "delete-reparent-child";
  const grandchildId = "delete-reparent-grandchild";
  const header = (id, parentSession) => JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    ...(parentSession ? { parentSession } : {}),
  });
  await writeFile(grandparentPath, `${header("delete-reparent-grandparent")}\n`);
  await writeFile(parentPath, `${header(parentId, grandparentPath)}\n`);
  await writeFile(childPath, [
    header(childId, parentPath),
    JSON.stringify({
      type: "custom",
      customType: "pi-web:subagent",
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: parentId,
        parentSessionPath: parentPath,
        profile: "Explore",
        description: "Inspect parser",
      },
    }),
    "",
  ].join("\n"));
  await writeFile(grandchildPath, [
    header(grandchildId, childPath),
    JSON.stringify({
      type: "custom",
      customType: "pi-web:subagent",
      id: "grandchild-meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: childId,
        parentSessionPath: childPath,
        profile: "Review",
        description: "Review parser",
      },
    }),
    "",
  ].join("\n"));
  cacheSessionPath(parentId, parentPath);
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = previousSessionsDir;
    if (previousUsageDataDir === undefined) delete process.env.PI_USAGE_DATA_DIR;
    else process.env.PI_USAGE_DATA_DIR = previousUsageDataDir;
    invalidateSessionPathCache(parentId);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${parentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parentId }) },
  );

  assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(await response.clone().json()));
  await assert.rejects(readFile(parentPath), { code: "ENOENT" });
  await assert.rejects(readFile(childPath), { code: "ENOENT" });
  await assert.rejects(readFile(grandchildPath), { code: "ENOENT" });
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.equal(detail.info.projectRoot, "/tmp");
  assert.equal(typeof detail.info.projectKey, "string");
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    runtimeAlive: true,
    state: { isStreaming: true },
  });
});

test("disk session detail uses the worker and preserves summary, info and usage fields", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-disk-detail-worker-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionsDir = process.env.PI_SESSIONS_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_SESSIONS_DIR = dir;
  globalThis.__piSessions = new Map();

  const manager = SessionManager.create(dir);
  const firstMessage = "worker detail fixture";
  manager.appendMessage({ role: "user", content: firstMessage, timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "worker detail answer" }], timestamp: Date.now() });
  const id = manager.getSessionId();
  const leafId = manager.getLeafId();
  cacheSessionPath(id, manager.getSessionFile());
  invalidateSessionListCache();

  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = previousSessionsDir;
    globalThis.__piSessions = previousRegistry;
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await getSessionHistoryPool().closeAll();
    await rm(dir, { recursive: true, force: true });
  });

  const response = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}?tree=summary&tail=1`),
    { params: Promise.resolve({ id }) },
  );
  const detail = await response.json();

  assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(await response.clone().json()));
  assert.equal(detail.sessionId, id);
  assert.equal(detail.info.id, id);
  assert.equal(detail.info.firstMessage, firstMessage);
  assert.equal(detail.info.projectRoot, dir);
  assert.equal(typeof detail.info.projectKey, "string");
  assert.equal(detail.leafId, leafId);
  assert.deepEqual(detail.context.entryIds, [leafId]);
  assert.equal(detail.stats.totalMessages, 2);
  assert.equal(typeof detail.totalActiveMs, "number");
  assert.equal(detail.treeFormat, "summary");
  assert.equal(typeof detail.snapshotRevision, "string");
  assert.ok(detail.usageDeleteGuard);
});

test("session detail returns a gzip-compressed response when the client accepts it", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-gzip-test";
  const timestamp = "2026-09-05T00:00:00.000Z";
  const firstMessage = "large session detail content ".repeat(500);
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: firstMessage },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-gzip-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`, {
      headers: { "Accept-Encoding": "gzip" },
    }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(await response.clone().json()));
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  const payload = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  assert.equal(payload.info.firstMessage, firstMessage);
});
