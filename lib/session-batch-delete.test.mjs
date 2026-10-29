import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": process.cwd(),
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
});

const { saveExecutionEngineSettings, codexConnectionIdentity } = await jiti.import(
  "./execution-engine-settings.ts",
);
const { POST } = await jiti.import("../app/api/sessions/batch-delete/route.ts");
const { executeBatchDelete, createBatchDeleteStream } = await jiti.import(
  "./session-batch-delete.ts",
);

async function parseNdjsonStream(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // 保留可能不完整的最后一行
    for (const line of lines) {
      if (line.trim()) {
        frames.push(JSON.parse(line));
      }
    }
  }
  if (buffer.trim()) {
    frames.push(JSON.parse(buffer));
  }
  return frames;
}

test("test harness rejects non-isolated targets before auth or network dispatch", () => {
  let dispatched = 0;
  const buildFixtureRequest = (origin) => {
    const url = new URL(origin);
    if (url.hostname !== "127.0.0.1" || !url.port || ["30141", "30142", "30143", "80", "443"].includes(url.port)) {
      throw new Error("production forbidden before authentication");
    }
    dispatched++;
    return new Request(`${origin}/api/sessions/batch-delete`, { method: "POST" });
  };
  for (const target of ["http://10.0.0.2:30141", "http://10.0.0.2:30142", "http://127.0.0.1:30141"]) {
    assert.throws(() => buildFixtureRequest(target), /production forbidden/);
  }
  assert.equal(dispatched, 0);
});

test("stream: true with 4 dummy Codex records: success, 404 missing, 409 busy fail, 504 unknown", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-4-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  const id1 = "codex:01900000-0000-7000-8000-000000000001";
  const id2 = "codex:01900000-0000-7000-8000-000000000002";
  const id3 = "codex:01900000-0000-7000-8000-000000000003";
  const id4 = "codex:01900000-0000-7000-8000-000000000004";
  const requestedIds = [id1, id2, id3, id4];

  const dispatched = [];
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });

    const match = url.match(/\/api\/sessions\/([^/]+)\/message-action/);
    if (match) {
      const threadId = match[1];
      dispatched.push(threadId);
      if (threadId === id1.slice(6)) {
        return Response.json({ ok: true });
      }
      if (threadId === id2.slice(6)) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (threadId === id3.slice(6)) {
        return Response.json({ error: "会话正在运行中，已受保护", code: "session_busy" }, { status: 409 });
      }
      if (threadId === id4.slice(6)) {
        // Simulate bridge timeout
        return Response.json({ error: "操作超时" }, { status: 504 });
      }
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  const req = new Request("http://localhost/api/sessions/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: requestedIds, stream: true }),
  });

  const res = await POST(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/x-ndjson; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "no-store, no-transform");
  assert.equal(res.headers.get("X-Accel-Buffering"), "no");

  const frames = await parseNdjsonStream(res.body);

  // 1. Verify start frame
  assert.equal(frames[0].type, "start");
  assert.equal(frames[0].total, 4);

  // 2. Verify item-start & result frames
  const itemStarts = frames.filter((f) => f.type === "item-start");
  const results = frames.filter((f) => f.type === "result");
  const doneFrame = frames.find((f) => f.type === "done");

  assert.equal(itemStarts.length, 4);
  assert.equal(results.length, 4);
  assert.ok(doneFrame);

  // Item 1: success deleted
  assert.equal(itemStarts[0].id, id1);
  assert.equal(itemStarts[0].index, 1);
  assert.equal(results[0].result.id, id1);
  assert.equal(results[0].result.ok, true);
  assert.equal(results[0].result.state, "deleted");
  assert.deepEqual(results[0].deletedSessionIds, [id1]);
  assert.equal(results[0].processed, 1);

  // Item 2: missing
  assert.equal(itemStarts[1].id, id2);
  assert.equal(itemStarts[1].index, 2);
  assert.equal(results[1].result.id, id2);
  assert.equal(results[1].result.ok, true);
  assert.equal(results[1].result.state, "missing");
  assert.equal(results[1].result.missing, true);
  assert.deepEqual(results[1].deletedSessionIds, [id2]);
  assert.equal(results[1].processed, 2);

  // Item 3: busy failed (allows continuing to next item)
  assert.equal(itemStarts[2].id, id3);
  assert.equal(itemStarts[2].index, 3);
  assert.equal(results[2].result.id, id3);
  assert.equal(results[2].result.ok, false);
  assert.equal(results[2].result.state, "failed");
  assert.match(results[2].result.error, /运行中/);
  assert.deepEqual(results[2].deletedSessionIds, []);
  assert.equal(results[2].processed, 3);

  // Item 4: timeout unknown
  assert.equal(itemStarts[3].id, id4);
  assert.equal(itemStarts[3].index, 4);
  assert.equal(results[3].result.id, id4);
  assert.equal(results[3].result.ok, false);
  assert.equal(results[3].result.state, "unknown");
  assert.deepEqual(results[3].deletedSessionIds, []);
  assert.equal(results[3].processed, 4);

  // Done frame
  assert.equal(doneFrame.total, 4);
  assert.equal(doneFrame.processed, 4);
  assert.equal(doneFrame.stopped, true); // id4 caused unknown so stopped is true
  assert.deepEqual(doneFrame.deletedSessionIds, [id1, id2]);
  assert.equal(doneFrame.results.length, 4);
  assert.equal(doneFrame.results[0].ok, true);
  assert.equal(doneFrame.results[1].ok, true);
  assert.equal(doneFrame.results[2].ok, false);
  assert.equal(doneFrame.results[3].ok, false);
});

test("stream: true with 53 dummy Codex records: full serial confirmation and progress", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-53-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  const ids = Array.from({ length: 53 }, (_, i) => {
    const hex = String(i + 1).padStart(12, "0");
    return `codex:01900000-0000-7000-8000-${hex}`;
  });

  const dispatched = [];
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });
    const match = url.match(/\/api\/sessions\/([^/]+)\/message-action/);
    if (match) {
      dispatched.push(match[1]);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  const req = new Request("http://localhost/api/sessions/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, stream: true }),
  });

  const res = await POST(req);
  assert.equal(res.status, 200);

  const frames = await parseNdjsonStream(res.body);

  assert.equal(frames[0].type, "start");
  assert.equal(frames[0].total, 53);

  const itemStarts = frames.filter((f) => f.type === "item-start");
  const results = frames.filter((f) => f.type === "result");
  const doneFrame = frames.find((f) => f.type === "done");

  assert.equal(itemStarts.length, 53);
  assert.equal(results.length, 53);
  assert.ok(doneFrame);

  assert.equal(doneFrame.total, 53);
  assert.equal(doneFrame.processed, 53);
  assert.equal(doneFrame.stopped, false);
  assert.equal(doneFrame.deletedSessionIds.length, 53);
  assert.equal(doneFrame.results.length, 53);
  assert.ok(doneFrame.results.every((r) => r.ok === true && r.state === "deleted"));
  assert.equal(dispatched.length, 53);
});

test("unknown bridge failure stops scheduling further native mutations; unscheduled are not_started", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-unknown-stop-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  const id1 = "codex:01900000-0000-7000-8000-000000000001";
  const id2 = "codex:01900000-0000-7000-8000-000000000002";
  const id3 = "codex:01900000-0000-7000-8000-000000000003";
  const id4 = "codex:01900000-0000-7000-8000-000000000004";

  const dispatched = [];
  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });
    const match = url.match(/\/api\/sessions\/([^/]+)\/message-action/);
    if (match) {
      dispatched.push(match[1]);
      if (match[1] === id1.slice(6)) return Response.json({ ok: true });
      if (match[1] === id2.slice(6)) return Response.json({ error: "Native uncertainty" }, { status: 502 });
      // id3 & id4 should NEVER be reached!
      throw new Error("Should not dispatch further IDs after unknown");
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  const req = new Request("http://localhost/api/sessions/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id1, id2, id3, id4], stream: true }),
  });

  const res = await POST(req);
  const frames = await parseNdjsonStream(res.body);

  const doneFrame = frames.find((f) => f.type === "done");
  assert.ok(doneFrame);
  assert.equal(doneFrame.stopped, true);
  assert.equal(doneFrame.processed, 2); // only id1 and id2 attempted
  assert.equal(doneFrame.total, 4);

  // Exactly 2 network dispatches
  assert.deepEqual(dispatched, [id1.slice(6), id2.slice(6)]);

  const r1 = doneFrame.results.find((r) => r.id === id1);
  const r2 = doneFrame.results.find((r) => r.id === id2);
  const r3 = doneFrame.results.find((r) => r.id === id3);
  const r4 = doneFrame.results.find((r) => r.id === id4);

  assert.equal(r1.state, "deleted");
  assert.equal(r1.ok, true);

  assert.equal(r2.state, "unknown");
  assert.equal(r2.ok, false);

  assert.equal(r3.state, "not_started");
  assert.equal(r3.ok, false);

  assert.equal(r4.state, "not_started");
  assert.equal(r4.ok, false);
});

test("client cancel stops scheduling further native mutations; unscheduled marked not_started", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-cancel-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  const id1 = "codex:01900000-0000-7000-8000-000000000001";
  const id2 = "codex:01900000-0000-7000-8000-000000000002";
  const id3 = "codex:01900000-0000-7000-8000-000000000003";

  const abortController = new AbortController();
  const dispatched = [];

  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });
    const match = url.match(/\/api\/sessions\/([^/]+)\/message-action/);
    if (match) {
      dispatched.push(match[1]);
      if (match[1] === id1.slice(6)) {
        abortController.abort(); // Cancel right after first dispatch
        return Response.json({ ok: true });
      }
      throw new Error("Should not dispatch further IDs after cancel");
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  const req = new Request("http://localhost/api/sessions/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id1, id2, id3], stream: true }),
    signal: abortController.signal,
  });

  const res = await POST(req);
  const frames = await parseNdjsonStream(res.body);
  const doneFrame = frames.find((f) => f.type === "done");

  assert.ok(doneFrame);
  assert.equal(doneFrame.stopped, true);
  assert.equal(doneFrame.processed, 1);
  assert.deepEqual(dispatched, [id1.slice(6)]);

  assert.equal(doneFrame.results.find((r) => r.id === id1).ok, true);
  assert.equal(doneFrame.results.find((r) => r.id === id2).state, "not_started");
  assert.equal(doneFrame.results.find((r) => r.id === id3).state, "not_started");
});

test("legacy JSON request: mixed Pi and Codex with cascade and missing IDs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-legacy-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  // Create real Pi session files in the isolated agent dir: parent and child
  const sessionsDir = join(dir, "sessions", "test-project");
  await mkdir(sessionsDir, { recursive: true });

  const parentId = "01900000-0000-7000-8000-0000000000a1";
  const childId = "01900000-0000-7000-8000-0000000000b1";
  const parentFile = join(sessionsDir, `2026-01-01T00-00-00_${parentId}.jsonl`);
  const childFile = join(sessionsDir, `2026-01-01T00-01-00_${childId}.jsonl`);

  await writeFile(parentFile, JSON.stringify({ type: "session", id: parentId, timestamp: "2026-01-01T00:00:00Z", cwd: "/test" }) + "\n");
  await writeFile(childFile, JSON.stringify({ type: "session", id: childId, timestamp: "2026-01-01T00:01:00Z", cwd: "/test", parentSession: parentFile }) + "\n");

  const codexId = "codex:01900000-0000-7000-8000-0000000000c1";

  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });
    if (url.includes(`/api/sessions/${codexId.slice(6)}/message-action`)) {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  // Delete parentId (Pi) and codexId (Codex). Deleting parentId will cascade-reparent/cascade-delete childId.
  const req = new Request("http://localhost/api/sessions/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [parentId, codexId], stream: false }),
  });

  const res = await POST(req);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(Array.isArray(data.results));
  assert.equal(data.results.length, 2);
  assert.ok(data.results.every((r) => r.ok === true));
  assert.ok(data.deletedSessionIds.includes(parentId));
  assert.ok(data.deletedSessionIds.includes(codexId));
});

test("stream parameter validation: non-boolean stream yields 400", async () => {
  const req1 = new Request("http://localhost/api/sessions/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["test-id"], stream: "true" }),
  });
  const res1 = await POST(req1);
  assert.equal(res1.status, 400);
  const data1 = await res1.json();
  assert.match(data1.error, /布尔值/);

  const req2 = new Request("http://localhost/api/sessions/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["test-id"], stream: 1 }),
  });
  const res2 = await POST(req2);
  assert.equal(res2.status, 400);
});

test("cancel before Pi deleteSessions submit results in 0 deleted files and not_started state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-pi-pre-cancel-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  const sessionsDir = join(dir, "sessions", "test-project");
  await mkdir(sessionsDir, { recursive: true });

  const piId1 = "01900000-0000-7000-8000-0000000000d1";
  const piId2 = "01900000-0000-7000-8000-0000000000d2";
  const file1 = join(sessionsDir, `2026-01-01T00-00-00_${piId1}.jsonl`);
  const file2 = join(sessionsDir, `2026-01-01T00-01-00_${piId2}.jsonl`);

  await writeFile(file1, JSON.stringify({ type: "session", id: piId1, timestamp: "2026-01-01T00:00:00Z", cwd: "/test" }) + "\n");
  await writeFile(file2, JSON.stringify({ type: "session", id: piId2, timestamp: "2026-01-01T00:01:00Z", cwd: "/test" }) + "\n");

  const abortController = new AbortController();

  // Cancel on first item-start frame before deleteSessions is called
  const res = await executeBatchDelete([piId1, piId2], {
    signal: abortController.signal,
    onFrame: (frame) => {
      if (frame.type === "item-start") {
        abortController.abort();
      }
    },
  });

  assert.equal(res.stopped, true);
  assert.equal(res.results.length, 2);
  assert.ok(res.results.every((r) => r.ok === false && r.state === "not_started"));
  assert.deepEqual(res.deletedSessionIds, []);

  // Both files must still exist on disk (0 deletions)
  const { stat } = await import("node:fs/promises");
  const stat1 = await stat(file1);
  const stat2 = await stat(file2);
  assert.ok(stat1.isFile());
  assert.ok(stat2.isFile());
});

test("cancel/stream break after Pi deleteSessions preserves confirmed deleted facts and cascade", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-pi-post-cancel-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  const sessionsDir = join(dir, "sessions", "test-project");
  await mkdir(sessionsDir, { recursive: true });

  const parentId = "01900000-0000-7000-8000-0000000000e1";
  const childId = "01900000-0000-7000-8000-0000000000e2";
  const parentFile = join(sessionsDir, `2026-01-01T00-00-00_${parentId}.jsonl`);
  const childFile = join(sessionsDir, `2026-01-01T00-01-00_${childId}.jsonl`);

  await writeFile(parentFile, JSON.stringify({ type: "session", id: parentId, timestamp: "2026-01-01T00:00:00Z", cwd: "/test" }) + "\n");
  await writeFile(childFile, [
    JSON.stringify({ type: "session", id: childId, timestamp: "2026-01-01T00:01:00Z", cwd: "/test", parentSession: parentFile }),
    JSON.stringify({ type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: parentId, parentSessionPath: parentFile } }),
  ].join("\n") + "\n");

  const abortController = new AbortController();

  // Cancel right after result frame arrives (deleteSessions has already executed on disk)
  const res = await executeBatchDelete([parentId], {
    signal: abortController.signal,
    onFrame: (frame) => {
      if (frame.type === "result") {
        abortController.abort(); // Cancel after disk deletion occurred
      }
    },
  });

  // Must retain true deleted state and child cascade
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].id, parentId);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].state, "deleted");
  assert.ok(res.deletedSessionIds.includes(parentId));
  assert.ok(res.deletedSessionIds.includes(childId));
});

test("fatal error in stream causes stream error/truncation rather than fake processed 0/all failed done frame", async () => {
  const badIds = {
    [Symbol.iterator]() {
      throw new Error("Crash during batch initialization");
    },
  };

  const stream = createBatchDeleteStream(badIds, {
    origin: "api-batch",
  });

  const reader = stream.getReader();
  await assert.rejects(async () => {
    await reader.read();
  }, /Crash during batch initialization/);
});

test("HTTP 400 with uncertain message (standalone ValueError) marks unknown and stops further scheduling without retry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-400-uncertain-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  const id1 = "codex:01900000-0000-7000-8000-0000000000f1";
  const id2 = "codex:01900000-0000-7000-8000-0000000000f2";

  let id1Calls = 0;
  let id2Calls = 0;

  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });
    const match = url.match(/\/api\/sessions\/([^/]+)\/message-action/);
    if (match) {
      if (match[1] === id1.slice(6)) {
        id1Calls++;
        // Standalone ValueError response
        return Response.json(
          { error: "执行端未确认删除结果，请刷新会话列表后重试；不会自动重复删除" },
          { status: 400 },
        );
      }
      if (match[1] === id2.slice(6)) {
        id2Calls++;
        return Response.json({ ok: true });
      }
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  const res = await executeBatchDelete([id1, id2]);

  assert.equal(id1Calls, 1, "No automatic retry on uncertain 400");
  assert.equal(id2Calls, 0, "Must not continue to id2 after uncertain 400");
  assert.equal(res.stopped, true);

  const r1 = res.results.find((r) => r.id === id1);
  const r2 = res.results.find((r) => r.id === id2);

  assert.equal(r1.ok, false);
  assert.equal(r1.state, "unknown");
  assert.match(r1.error, /执行端未确认删除结果/);

  assert.equal(r2.ok, false);
  assert.equal(r2.state, "not_started");
});

test("confirmed native deletion receipt send failure does not overwrite native result or recount", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-enqueue-fail-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  const id1 = "codex:01900000-0000-7000-8000-000000000001";
  const id2 = "codex:01900000-0000-7000-8000-000000000002";

  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });
    if (url.includes(`/api/sessions/${id1.slice(6)}/message-action`)) {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  // onFrame throws when receiving result frame of id1 (simulating enqueue crash after native deletion)
  const res = await executeBatchDelete([id1, id2], {
    onFrame: (frame) => {
      if (frame.type === "result" && frame.result.id === id1) {
        throw new Error("Simulated enqueue failure");
      }
    },
  });

  assert.equal(res.stopped, true);
  const r1 = res.results.find((r) => r.id === id1);
  const r2 = res.results.find((r) => r.id === id2);

  // id1 MUST remain confirmed deleted, not overwritten as unknown or failed!
  assert.equal(r1.ok, true);
  assert.equal(r1.state, "deleted");
  assert.ok(res.deletedSessionIds.includes(id1));

  // id2 must be not_started
  assert.equal(r2.ok, false);
  assert.equal(r2.state, "not_started");
});

test("onFrame error at mixed Pi->Codex boundary halts further deletes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-mixed-boundary-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;

  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  await saveExecutionEngineSettings({ codex: { enabled: true, url: "http://127.0.0.1:19876" } });

  const sessionsDir = join(dir, "sessions", "test-project");
  await mkdir(sessionsDir, { recursive: true });

  const piId = "01900000-0000-7000-8000-000000000011";
  const piFile = join(sessionsDir, `2026-01-01T00-00-00_${piId}.jsonl`);
  await writeFile(piFile, JSON.stringify({ type: "session", id: piId, timestamp: "2026-01-01T00:00:00Z", cwd: "/test" }) + "\n");

  const codexId = "codex:01900000-0000-7000-8000-000000000022";
  let codexDispatched = false;

  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "Set-Cookie": "test=owned" } });
    if (url.endsWith("/api/auth")) return Response.json({ csrf: "owned", authenticated: true });
    if (url.includes(`/api/sessions/${codexId.slice(6)}/message-action`)) {
      codexDispatched = true;
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };

  // onFrame throws during Pi's result frame
  const res = await executeBatchDelete([piId, codexId], {
    onFrame: (frame) => {
      if (frame.type === "result" && frame.result.id === piId) {
        throw new Error("Stream broken at boundary");
      }
    },
  });

  assert.equal(codexDispatched, false, "Codex delete must NOT be dispatched after Pi boundary error");
  assert.equal(res.stopped, true);

  const rPi = res.results.find((r) => r.id === piId);
  const rCodex = res.results.find((r) => r.id === codexId);

  assert.equal(rPi.ok, true);
  assert.equal(rPi.state, "deleted");
  assert.equal(rCodex.ok, false);
  assert.equal(rCodex.state, "not_started");
});

test("batch is fenced to its original Codex connection when configuration changes mid-delete", async t => {
  const dir = await mkdtemp(join(tmpdir(), "batch-delete-identity-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR, priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });
  const original = "http://127.0.0.1:19877", changed = "http://127.0.0.1:19878";
  await saveExecutionEngineSettings({ codex: { enabled: true, url: original } });
  const ids = [1, 2, 3].map(i => `codex:01900000-0000-7000-8000-${String(i).padStart(12, "0")}`);
  const dispatched = [];
  globalThis.fetch = async url => {
    if (url.endsWith("/api/auth")) return Response.json({ authenticated: true, csrf: "fixture" });
    if (url.endsWith("/api/login")) return Response.json({ ok: true });
    dispatched.push(url);
    await saveExecutionEngineSettings({ codex: { enabled: true, url: changed } });
    return Response.json({ ok: true });
  };
  const result = await executeBatchDelete(ids);
  assert.equal(dispatched.length, 1);
  assert(dispatched.every(url => url.startsWith(original)));
  assert.deepEqual(result.results.map(row => row.state), ["deleted", "failed", "not_started"]);
  assert.equal(result.stopped, true);
});

test("real native busy refusal is safe failure, but timeout mentioning a queue stays unknown", async () => {
  const { isCodexUncertainDeleteError } = await jiti.import("./execution-engines/codex-engine.ts");
  const nativeBusy = Object.assign(new Error("会话正在执行任务或等待回复，请结束当前任务后再删除"), { status: 400 });
  assert.equal(isCodexUncertainDeleteError(nativeBusy), false);
  for (const message of ["队列状态未知", "timed out waiting for queue", "权限检查后未确认删除结果", "某个参数处理异常"]) {
    assert.equal(isCodexUncertainDeleteError(Object.assign(new Error(message), { status: 400 })), true, message);
  }
});

for (const missing of [true, false]) test(`background job reconciles uncertain mutation with read-only metadata: missing=${missing}, never retries delete`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-delete-reconcile-'));
  const previous = process.env.PI_CODING_AGENT_DIR, previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => { globalThis.fetch = previousFetch; if(previous === undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(dir,{recursive:true,force:true}); });
  await saveExecutionEngineSettings({codex:{enabled:true,url:'http://127.0.0.1:19879'}});
  const ids=[1,2].map(i=>`codex:01900009-0000-7000-8000-${String(i).padStart(12,'0')}`),writes=[],reads=[];
  globalThis.fetch=async (url,options)=>{
    if(url.endsWith('/api/auth'))return Response.json({authenticated:true,csrf:'fixture'});
    if(url.endsWith('/api/login'))return Response.json({ok:true});
    if(url.endsWith('/message-action')) {writes.push(url);return writes.length===1 ? Response.json({error:'uncertain native mutation'}, {status:504}) : Response.json({ok:true});}
    assert.equal(options?.method ?? 'GET','GET');assert(url.endsWith('?metadata=1'));reads.push(url);
    return Response.json(missing?{error:'not found'}:{id:ids[0]}, {status:missing?404:200});
  };
  const result=await executeBatchDelete(ids,{expectedCodexIdentity:await codexConnectionIdentity(),reconcileUncertainDeletes:true});
  assert.equal(reads.length,1);assert.equal(new Set(writes).size,writes.length);
  assert.deepEqual(result.results.map(row=>row.state),missing?['missing','deleted']:['unknown','not_started']);
  assert.equal(writes.length,missing?2:1);assert.equal(result.stopped,!missing);
});
