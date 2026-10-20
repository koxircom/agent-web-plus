import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-status-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });
const { CodexStatusRevision, listCodexSessions, codexRunningStatus } = await jiti.import(process.env.PI_CODEX_ENGINE_TEST_MODULE || "./codex-engine.ts");
const { saveExecutionEngineSettings } = await jiti.import("../execution-engine-settings.ts");
const { codexBridgeRequest } = await jiti.import("./codex-bridge-client.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

test("Codex status revision is monotonic within an epoch and changes only with activity", () => {
  const revision = new CodexStatusRevision();
  const first = revision.update("identity-a", [{ id: "thread-a", status: "idle" }]);
  const unchanged = revision.update("identity-a", [{ id: "thread-a", status: "idle" }]);
  const changed = revision.update("identity-a", [{ id: "thread-a", status: "active" }]);

  assert.equal(unchanged.epoch, first.epoch);
  assert.equal(unchanged.revision, first.revision);
  assert.equal(changed.epoch, first.epoch);
  assert.equal(changed.revision, first.revision + 1);
});

test("Codex status starts a fresh epoch after process restart or identity change", () => {
  const firstProcess = new CodexStatusRevision();
  const previous = firstProcess.update("identity-a", [{ id: "thread-a", status: "idle" }]);
  const restartedProcess = new CodexStatusRevision();
  const restarted = restartedProcess.update("identity-a", [{ id: "thread-a", status: "idle" }]);
  const changedIdentity = firstProcess.update("identity-b", [{ id: "thread-a", status: "idle" }]);

  assert.notEqual(restarted.epoch, previous.epoch);
  assert.notEqual(changedIdentity.epoch, previous.epoch);
  assert.equal(restarted.revision, 1);
  assert.equal(changedIdentity.revision, 1);
});

test("explicit Codex session listings refresh the catalog and include newly added sessions", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];
  await saveExecutionEngineSettings({ defaultEngine: "codex", codex: {
    enabled: true, url: "http://127.0.0.1:19097", username: "test", password: "test-only",
  } });
  const firstId = "12345678-1234-1234-1234-123456789abc";
  const secondId = "22345678-1234-1234-1234-123456789abc";
  let rows = [{ id: firstId, title: "first", cwd: "/project", recency: 1 }];
  const response = (body, status = 200) => ({ ok: status < 400, status,
    headers: { getSetCookie: () => ["sid=test"] }, json: async () => body });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/login") return response({});
    if (path === "/api/auth") return response({ authenticated: true, csrf: "test" });
    if (path === "/api/sessions") return response({ sessions: rows });
    if (path === "/api/activity") return response({ sessions: rows.map(row => ({ id: row.id, status: "idle" })) });
    throw new Error(`Unexpected Codex request: ${path}`);
  };

  try {
    const first = await listCodexSessions();
    rows = [...rows, { id: secondId, title: "second", cwd: "/project", recency: 2 }];
    const second = await listCodexSessions();

    assert.deepEqual(first.sessions.map(session => session.id), [`codex:${firstId}`]);
    assert.deepEqual(second.sessions.map(session => session.id), [`codex:${firstId}`, `codex:${secondId}`]);
    assert.notEqual(second.sessionListVersion, first.sessionListVersion);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection === undefined) delete globalThis[connectionKey];
    else globalThis[connectionKey] = previousConnection;
  }
});

test("a cancelled catalog flight cannot overwrite a newer catalog result", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];
  await saveExecutionEngineSettings({ defaultEngine: "codex", codex: {
    enabled: true, url: "http://127.0.0.1:19097", username: "test", password: "test-only",
  } });
  const oldId = "32345678-1234-1234-1234-123456789abc";
  const newId = "42345678-1234-1234-1234-123456789abc";
  let sessionsStarted;
  const started = new Promise(resolve => { sessionsStarted = resolve; });
  let releaseOld;
  let sessionReads = 0;
  let rows = [{ id: newId, title: "new", cwd: "/project", recency: 2 }];
  const response = (body, status = 200) => ({ ok: status < 400, status,
    headers: { getSetCookie: () => ["sid=test"] }, json: async () => body });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/login") return response({});
    if (path === "/api/auth") return response({ authenticated: true, csrf: "test" });
    if (path === "/api/sessions") {
      sessionReads++;
      if (sessionReads === 1) {
        sessionsStarted();
        return new Promise(resolve => { releaseOld = () => resolve(response({ sessions: [{ id: oldId, title: "old", cwd: "/project", recency: 1 }] })); });
      }
      return response({ sessions: rows });
    }
    if (path === "/api/activity") return response({ sessions: rows.map(row => ({ id: row.id, status: "idle" })) });
    throw new Error(`Unexpected Codex request: ${path}`);
  };

  try {
    const controller = new AbortController();
    const cancelledList = listCodexSessions(controller.signal);
    await started;
    controller.abort();
    await assert.rejects(cancelledList, error => error?.name === "AbortError");

    const latest = await listCodexSessions();
    releaseOld();
    // Let the cancelled fetch that intentionally ignores AbortSignal finish its
    // response parsing and identity check before reading the committed cache.
    await new Promise(resolve => setTimeout(resolve, 25));
    const status = await codexRunningStatus();

    assert.deepEqual(latest.sessions.map(session => session.id), [`codex:${newId}`]);
    assert.deepEqual(status.statusSnapshot.executions.map(execution => execution.sessionId), [`codex:${newId}`]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection === undefined) delete globalThis[connectionKey];
    else globalThis[connectionKey] = previousConnection;
  }
});

test("Codex bridge propagates read aborts and marks upstream 5xx errors retryable", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];
  await saveExecutionEngineSettings({ defaultEngine: "codex", codex: {
    enabled: true, url: "http://127.0.0.1:19097", username: "test", password: "test-only",
  } });

  let notifyActivity;
  const activityRequested = new Promise(resolve => { notifyActivity = resolve; });
  let activityMode = "wait";
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/login") return { ok: true, status: 200, headers: { getSetCookie: () => ["sid=test"] }, json: async () => ({}) };
    if (path === "/api/auth") return { ok: true, status: 200, headers: {}, json: async () => ({ authenticated: true, csrf: "test" }) };
    if (path === "/api/activity" && activityMode === "wait") {
      notifyActivity();
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    return { ok: false, status: 503, headers: {}, json: async () => ({ error: "temporary outage" }) };
  };

  try {
    const controller = new AbortController();
    const pending = codexBridgeRequest("/api/activity", { hosts: { local: [] } }, { signal: controller.signal });
    await activityRequested;
    controller.abort();
    await assert.rejects(pending, error => error?.name === "AbortError");

    activityMode = "failure";
    await assert.rejects(
      codexBridgeRequest("/api/activity", { hosts: { local: [] } }),
      error => error.status === 503 && error.retryable === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection === undefined) delete globalThis[connectionKey];
    else globalThis[connectionKey] = previousConnection;
  }
});

test("a cancelled read cannot abort the shared Codex authentication flight", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];
  await saveExecutionEngineSettings({ defaultEngine: "codex", codex: {
    enabled: true, url: "http://127.0.0.1:19097", username: "test", password: "test-only",
  } });
  let loginSignal;
  let releaseLogin;
  let notifyLogin;
  const loginStarted = new Promise(resolve => { notifyLogin = resolve; });
  let activityReads = 0;
  const response = (body, status = 200) => ({ ok: status < 400, status,
    headers: { getSetCookie: () => ["sid=test"] }, json: async () => body });
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/login") {
      loginSignal = init.signal;
      notifyLogin();
      return new Promise(resolve => { releaseLogin = () => resolve(response({})); });
    }
    if (path === "/api/auth") return response({ authenticated: true, csrf: "test" });
    if (path === "/api/activity") { activityReads++; return response({ sessions: [] }); }
    throw new Error(`Unexpected Codex request: ${path}`);
  };

  try {
    const controller = new AbortController();
    const cancelledRead = codexBridgeRequest("/api/activity", { hosts: { local: [] } }, { signal: controller.signal });
    const survivingRead = codexBridgeRequest("/api/activity", { hosts: { local: [] } });
    await loginStarted;
    controller.abort();
    await assert.rejects(cancelledRead, error => error?.name === "AbortError");
    assert.equal(loginSignal.aborted, false);

    releaseLogin();
    await survivingRead;
    assert.equal(activityReads, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection === undefined) delete globalThis[connectionKey];
    else globalThis[connectionKey] = previousConnection;
  }
});

test("Codex login 5xx errors remain retryable startup failures", async () => {
  const originalFetch = globalThis.fetch;
  const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
  const previousConnection = globalThis[connectionKey];
  delete globalThis[connectionKey];
  await saveExecutionEngineSettings({ defaultEngine: "codex", codex: {
    enabled: true, url: "http://127.0.0.1:19097", username: "test", password: "test-only",
  } });
  globalThis.fetch = async () => ({ ok: false, status: 503,
    headers: { getSetCookie: () => [] }, json: async () => ({ error: "temporary authentication outage" }) });

  try {
    await assert.rejects(
      codexBridgeRequest("/api/activity", { hosts: { local: [] } }),
      error => error.status === 503 && error.retryable === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnection === undefined) delete globalThis[connectionKey];
    else globalThis[connectionKey] = previousConnection;
  }
});


test("actual status pipeline keeps increasing when the old content hash decreases", async () => {
  const { createHash } = await import("node:crypto");
  const originalFetch = globalThis.fetch;
  const id = "22222222-2222-4222-8222-222222222222";
  const fingerprint = status => Number.parseInt(createHash("sha256").update(JSON.stringify([{ id, status }])).digest("hex").slice(0,12),16);
  const states = ["active", "idle"].sort((a,b) => fingerprint(b)-fingerprint(a));
  assert(fingerprint(states[0]) > fingerprint(states[1]));
  let current = states[0];
  await saveExecutionEngineSettings({ defaultEngine: "codex", codex: { enabled: true, url: "http://127.0.0.1:19096", username: "test", password: "test-only" } });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    const body = path === "/api/auth" ? { authenticated:true, csrf:"test" }
      : path === "/api/sessions" ? { sessions:[{id,cwd:"/project",title:"test",recency:1}] }
      : path === "/api/activity" ? { sessions:[{id,status:current}] } : {};
    return { ok:true,status:200,headers:{getSetCookie:()=>["sid=test"]},json:async()=>body };
  };
  try {
    await listCodexSessions();
    const first = await codexRunningStatus();
    current = states[1];
    const next = await codexRunningStatus(),unchanged = await codexRunningStatus();
    assert.equal(next.statusSnapshot.epoch,first.statusSnapshot.epoch);
    assert(next.statusSnapshot.revision > first.statusSnapshot.revision, "valid new status must not move revision backwards");
    assert.equal(unchanged.statusSnapshot.revision,next.statusSnapshot.revision);
    assert.equal(next.sessionListVersion,first.sessionListVersion);
  } finally { globalThis.fetch = originalFetch; }
});

async function withExpiredBridge(work) {
  const originalFetch=globalThis.fetch,key=Symbol.for('pi-web.codex-bridge-connection'),previous=globalThis[key];delete globalThis[key];
  await saveExecutionEngineSettings({defaultEngine:'codex',codex:{enabled:true,url:'http://127.0.0.1:19097',username:'fixture',password:'fixture-only'}});
  let logins=0,reads=0,writes=0,expire=false,holdLate=false,releaseLate,releaseFirst;
  const response=(value,status=200)=>({ok:status<400,status,headers:{getSetCookie:()=>['sid=fixture-'+logins]},json:async()=>value,body:{cancel:async()=>{}}});
  globalThis.fetch=async(input,options={})=>{
    const path=new URL(String(input)).pathname;
    if(path==='/api/login'){logins++;return response({})}
    if(path==='/api/auth')return response({authenticated:true,csrf:'generation-'+logins});
    if(options.method==='POST'){writes++;return response({error:'expired'},401)}
    reads++;
    if(holdLate&&logins===1){
      if(!releaseFirst)return new Promise(resolve=>{releaseFirst=()=>resolve(response({error:'expired'},401))});
      releaseFirst();return new Promise(resolve=>{releaseLate=()=>resolve(response({error:'late expired'},401))});
    }
    if(expire&&logins===1)return response({error:'expired'},401);
    return response({ok:true});
  };
  try{await codexBridgeRequest('/api/projects');await work({counts:()=>({logins,reads,writes}),expire:()=>{expire=true},hold:()=>{expire=true;holdLate=true},release:()=>releaseLate?.(),hasLate:()=>Boolean(releaseLate),response})}
  finally{globalThis.fetch=originalFetch;if(previous===undefined)delete globalThis[key];else globalThis[key]=previous}
}

test('an expired bridge read reauthenticates once and returns its original read result',async()=>withExpiredBridge(async h=>{
 h.expire();assert.deepEqual(await(await codexBridgeRequest('/api/projects')).json(),{ok:true});assert.deepEqual(h.counts(),{logins:2,reads:3,writes:0});
}));
test('a late concurrent 401 shares renewed credentials without erasing the newer login',{timeout:2000},async()=>withExpiredBridge(async h=>{
 h.hold();const first=codexBridgeRequest('/api/projects'),late=codexBridgeRequest('/api/projects');
 const deadline=Date.now()+1000;while(!h.hasLate()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert(h.hasLate());
 await first;h.release();await late;assert.deepEqual(h.counts(),{logins:2,reads:5,writes:0});
 await codexBridgeRequest('/api/projects');assert.equal(h.counts().logins,2);
}));
test('a rejected write is sent once and only a later read renews credentials',async()=>withExpiredBridge(async h=>{
 await assert.rejects(codexBridgeRequest('/api/sessions/thread/send',{text:'fixture'}),e=>e.status===401);
 assert.deepEqual(h.counts(),{logins:1,reads:1,writes:1});await codexBridgeRequest('/api/projects');assert.equal(h.counts().logins,2);assert.equal(h.counts().writes,1);
}));
test('a persistent 401 read stops after one renewal',async()=>withExpiredBridge(async h=>{
 const old=globalThis.fetch;globalThis.fetch=async(input,options)=>new URL(String(input)).pathname==='/api/projects'?h.response({error:'denied'},401):old(input,options);
 await assert.rejects(codexBridgeRequest('/api/projects'),e=>e.status===401);assert.equal(h.counts().logins,2);
}));
