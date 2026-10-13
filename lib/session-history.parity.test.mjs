import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, utimesSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const { buildSessionContext } = await jiti.import("./session-context.ts");
const {
  getSessionHistoryPool,
  SessionHistoryPool,
  HistoryAbortedError,
  HistoryTimeoutError,
} = await jiti.import("./session-history-pool.ts");
const {
  SessionHistoryIndexer,
  HistoryConflictError,
  HistoryBudgetExceededError,
  UnsupportedSessionVersionError,
} = await jiti.import("./session-history-indexer.ts");
const { handleSessionContextRequest } = await jiti.import("@/lib/session-context-service.ts");

const pool = getSessionHistoryPool();

test.after(async () => {
  await pool.closeAll();
});

function createTempDir(prefix = "pi-history-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content, timestamp: Date.parse(timestamp) },
  };
}

function assistantEntry(id, parentId, text, opts = {}) {
  const ts = opts.timestamp || "2026-01-01T00:00:32.000Z";
  const startTs = opts.startTs !== undefined ? opts.startTs : Date.parse(ts) - 32000;
  return {
    type: "message",
    id,
    parentId,
    timestamp: ts,
    message: {
      role: "assistant",
      provider: opts.provider || "test-prov",
      model: opts.model || "test-model",
      content: opts.rawStringContent !== undefined ? opts.rawStringContent : (opts.blocks || [{ type: "text", text }]),
      timestamp: startTs,
    },
  };
}

test("Worker parity: branches, compaction, settings, media, thinking, string, completedAt and deepEqual", async (t) => {
  const dir = createTempDir();
  const filePath = join(dir, "parity-session.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Root -> u1 -> mc1 -> a1 -> compact1 -> u2 -> [branch A: a2a]
  //                                           -> [branch B: tc1 -> a2b -> tr1]
  const entries = [
    { type: "session", version: 3, id: "parity-sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
    userEntry("u1", null, "Hello root"),
    { type: "model_change", id: "mc1", parentId: "u1", provider: "explicit-prov", modelId: "explicit-model", timestamp: "2026-01-01T00:00:01.000Z" },
    assistantEntry("a1", "mc1", "Reply 1", {
      blocks: [
        { type: "thinking", thinking: "Let me think deeply about parity..." },
        { type: "text", text: "Answer 1" },
      ],
      timestamp: "2026-01-01T00:00:33.000Z",
      startTs: Date.parse("2026-01-01T00:00:01.000Z"),
    }),
    {
      type: "compaction",
      id: "compact1",
      parentId: "a1",
      summary: "Compacted summary of u1/a1",
      firstKeptEntryId: "u1",
      tokensBefore: 500,
      timestamp: "2026-01-01T00:01:00.000Z",
    },
    userEntry("u2", "compact1", "Question 2"),
    // Branch A
    assistantEntry("a2a", "u2", "Legacy string reply", {
      rawStringContent: "Pure string assistant content",
      provider: "prov-a",
      model: "model-a",
      timestamp: "2026-01-01T00:02:10.000Z",
      startTs: Date.parse("2026-01-01T00:01:50.000Z"),
    }),
    // Branch B
    { type: "thinking_level_change", id: "tc1", parentId: "u2", thinkingLevel: "high", timestamp: "2026-01-01T00:02:00.000Z" },
    assistantEntry("a2b", "tc1", "Tool call reply", {
      blocks: [
        { type: "text", text: "Executed tool" },
      ],
      provider: "prov-b",
      model: "model-b",
      timestamp: "2026-01-01T00:02:30.000Z",
      startTs: Date.parse("2026-01-01T00:02:10.000Z"),
    }),
    {
      type: "message",
      id: "tr1",
      parentId: "a2b",
      timestamp: "2026-01-01T00:02:35.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        content: [
          { type: "text", text: "Tool output text" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
    },
  ];

  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // Query Branch A via worker pool
  const rawA = await pool.queryContext(filePath, {
    leafId: "a2a",
    tail: 50,
    deferThinking: true,
    deferToolResultImages: true,
    sessionId: "parity-sess",
  });
  const resA = JSON.parse(rawA);

  // Baseline in-memory execution via buildSessionContext
  const baselineA = buildSessionContext(entries.slice(1), "a2a", {
    tail: 50,
    deferThinking: true,
    deferToolResultImages: true,
    sessionId: "parity-sess",
  });

  // Strict deepEqual against JSON-normalized baseline
  assert.deepEqual(resA.context, JSON.parse(JSON.stringify(baselineA)));
  assert.equal(resA.context.model?.provider, "explicit-prov");
  assert.equal(resA.context.model?.modelId, "explicit-model");
  assert.equal(resA.context.thinkingLevel, "off");

  // Query Branch B
  const rawB = await pool.queryContext(filePath, {
    leafId: "tr1",
    tail: 50,
    deferThinking: true,
    deferToolResultImages: true,
    sessionId: "parity-sess",
  });
  const resB = JSON.parse(rawB);

  const baselineB = buildSessionContext(entries.slice(1), "tr1", {
    tail: 50,
    deferThinking: true,
    deferToolResultImages: true,
    sessionId: "parity-sess",
  });

  assert.deepEqual(resB.context, JSON.parse(JSON.stringify(baselineB)));
  assert.equal(resB.context.thinkingLevel, "high");
  assert.equal(resB.context.model?.provider, "explicit-prov");
});

test("Worker parity: pagination before/excludeLeaf upward without duplicating boundary", async (t) => {
  const dir = createTempDir();
  const filePath = join(dir, "page-session.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const entries = [{ type: "session", version: 3, id: "page-sess", cwd: dir }];
  for (let i = 0; i < 20; i++) {
    entries.push(userEntry(`u${i}`, i === 0 ? null : `a${i - 1}`, `Question ${i}`));
    entries.push(assistantEntry(`a${i}`, `u${i}`, `Answer ${i}`));
  }
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const page1Json = await pool.queryContext(filePath, { tail: 5 });
  const page1 = JSON.parse(page1Json).context;
  assert.equal(page1.messages.length, 5);
  const oldestOnPage1 = page1.entryIds[0];

  const page2Json = await pool.queryContext(filePath, {
    before: oldestOnPage1,
    tail: 5,
  });
  const page2 = JSON.parse(page2Json).context;
  assert.equal(page2.messages.length, 5);

  assert.ok(!page2.entryIds.includes(oldestOnPage1), "Page 2 must not duplicate boundary entry");
  assert.ok(page1.entryIds.every((id) => !page2.entryIds.includes(id)), "Page 1 and Page 2 must not overlap");
});

test("Settings retention: before on model_change preserves settings even when page is empty", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "model-change-boundary.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "s1", version: 3 }),
    JSON.stringify({ type: "model_change", id: "m1", parentId: null, provider: "prov-m1", modelId: "model-m1" }),
    JSON.stringify(userEntry("u1", "m1", "First message")),
  ].join("\n") + "\n");

  const indexer = new SessionHistoryIndexer();

  // before points to m1, excludeLeaf excludes m1, leaving page empty
  const resEmptyPage = JSON.parse(await indexer.queryContext(file, { before: "m1" }));
  assert.equal(resEmptyPage.context.messages.length, 0);
  assert.notEqual(resEmptyPage.context.model, null);
  assert.equal(resEmptyPage.context.model?.provider, "prov-m1");
  assert.equal(resEmptyPage.context.model?.modelId, "model-m1");

  // Worker pool also preserves settings on empty page
  const poolRes = JSON.parse(await pool.queryContext(file, { before: "m1" }));
  assert.equal(poolRes.context.messages.length, 0);
  assert.equal(poolRes.context.model?.provider, "prov-m1");
});

test("Cursor precedence: before overrides leafId=null and restores target branch", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "null-leaf-override.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "s1", version: 3 }),
    JSON.stringify(userEntry("u1", null, "Hello")),
    JSON.stringify(userEntry("u2", "u1", "World")),
  ].join("\n") + "\n");

  const indexer = new SessionHistoryIndexer();
  const res = JSON.parse(await indexer.queryContext(file, { leafId: null, before: "u2" }));
  assert.equal(res.context.messages.length, 1);
  assert.equal(res.context.entryIds[0], "u1");

  const poolRes = JSON.parse(await pool.queryContext(file, { leafId: null, before: "u2" }));
  assert.equal(poolRes.context.messages.length, 1);
  assert.equal(poolRes.context.entryIds[0], "u1");
});

test("Same-size rewrite with restored mtime invalidates index via ctime/ino", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "same-size.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const line1 = JSON.stringify({ type: "session", id: "s1", version: 3 }) + "\n";
  const line2A = JSON.stringify(userEntry("u1", null, "AAA 1234567890")) + "\n";
  writeFileSync(file, line1 + line2A);

  const indexer = new SessionHistoryIndexer();
  const idxA = indexer.getOrBuildIndex(file);
  const originalMtime = idxA.fingerprint.mtimeMs;

  // Wait a small moment to ensure tick advancement
  await new Promise((r) => setTimeout(r, 20));

  // Overwrite with exact same byte length but different content
  const line2B = JSON.stringify(userEntry("u1", null, "BBB 1234567890")) + "\n";
  assert.equal(Buffer.byteLength(line2A), Buffer.byteLength(line2B));
  writeFileSync(file, line1 + line2B);

  // Restore previous mtime using utimesSync
  const sec = Math.floor(originalMtime / 1000);
  utimesSync(file, sec, sec);

  // Calling getOrBuildIndex must detect ctime/ino change and refresh index
  const idxB = indexer.getOrBuildIndex(file);
  assert.equal(idxB.entries.length, 1);
  const contextJson = await indexer.queryContext(file, { tail: 10 });
  const parsed = JSON.parse(contextJson);
  assert.equal(parsed.context.messages[0].content, "BBB 1234567890");
});

test("Seek short-read and corruption trigger 409 conflict instead of silent skipping", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "seek-conflict.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const line0 = JSON.stringify({ type: "session", id: "s1", version: 3 }) + "\n";
  const line1 = JSON.stringify(userEntry("u1", null, "Initial line 1 with padding 1234567890")) + "\n";
  const line2 = JSON.stringify(userEntry("u2", "u1", "Initial line 2 with padding 1234567890")) + "\n";
  writeFileSync(file, line0 + line1 + line2);

  const indexer = new SessionHistoryIndexer();

  // Test 1: Seek short-read (< meta.length) throws 409
  indexer.seekReadHook = (offset, length) => {
    // Return buffer shorter than expected length
    return Buffer.alloc(Math.max(1, length - 10));
  };
  await assert.rejects(
    indexer.queryContext(file, { tail: 10 }),
    (err) => err instanceof HistoryConflictError || err.statusCode === 409,
    "Seek short-read must throw HistoryConflictError 409",
  );

  // Test 2: Seek parse error (corrupt JSON syntax) throws 409
  indexer.seekReadHook = () => {
    return Buffer.from("{{broken json syntax\n");
  };
  await assert.rejects(
    indexer.queryContext(file, { tail: 10 }),
    (err) => err instanceof HistoryConflictError || err.statusCode === 409,
    "Seek corrupt line must throw HistoryConflictError 409",
  );
});

test("8MB single-line UTF-8 across multiple chunks is parsed without corruption", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "huge-utf8-line.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Generate ~8MB Chinese UTF-8 string: "中文字符测试" is 18 bytes
  const chunkUnit = "中文字符测试🌟";
  const repeatCount = Math.floor((8 * 1024 * 1024) / Buffer.byteLength(chunkUnit, "utf8"));
  const massiveText = chunkUnit.repeat(repeatCount);

  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "s1", version: 3 }),
    JSON.stringify(userEntry("u1", null, massiveText)),
  ].join("\n") + "\n");

  const indexer = new SessionHistoryIndexer();
  const res = JSON.parse(await indexer.queryContext(file, { tail: 10 }));
  assert.equal(res.context.messages.length, 1);
  assert.equal(res.context.messages[0].content, massiveText);
});

test("Duplicate IDs and reference cycles are bounded without infinite loop", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "cycle.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Cycle: u1 -> u2 -> u1
  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "s1", version: 3 }),
    JSON.stringify(userEntry("u1", "u2", "Message 1")),
    JSON.stringify(userEntry("u2", "u1", "Message 2")),
  ].join("\n") + "\n");

  const indexer = new SessionHistoryIndexer();
  const res = JSON.parse(await indexer.queryContext(file, { leafId: "u2", tail: 10 }));
  assert.ok(res.context.messages.length <= 2, "Cycle walk must terminate safely");
});

test("Unsupported session version > 3 rejects compatibility risk", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "v4-session.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "s1", version: 4 }),
    JSON.stringify(userEntry("u1", null, "Hello v4")),
  ].join("\n") + "\n");

  const indexer = new SessionHistoryIndexer();
  assert.throws(
    () => indexer.getOrBuildIndex(file),
    (err) => err instanceof UnsupportedSessionVersionError || /version 4/i.test(err.message),
  );
});

test("Budget guard: line > 32MiB rejects with 503 during accumulation", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "oversized-line.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fd = openSync(file, "w");
  const headerBuf = Buffer.from(JSON.stringify({ type: "session", id: "s1", version: 3 }) + "\n");
  const { writeSync } = await import("node:fs");
  writeSync(fd, headerBuf, 0, headerBuf.length);

  // Write 33MB of dummy characters without newline
  const chunkSize = 1024 * 1024;
  const chunkBuf = Buffer.alloc(chunkSize, "a");
  for (let i = 0; i < 33; i++) {
    writeSync(fd, chunkBuf, 0, chunkSize);
  }
  writeSync(fd, Buffer.from("\n"));
  closeSync(fd);

  const indexer = new SessionHistoryIndexer();
  assert.throws(
    () => indexer.getOrBuildIndex(file),
    (err) => err instanceof HistoryBudgetExceededError || err.statusCode === 503,
  );
});

test("Abort and Pool management: active cancel terminates worker and accepts subsequent requests", async (t) => {
  const dir = createTempDir();
  const file = join(dir, "active-abort.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "s1", version: 3 }),
    JSON.stringify(userEntry("u1", null, "Task 1")),
    JSON.stringify(userEntry("u2", "u1", "Task 2")),
  ].join("\n") + "\n");

  const controller = new AbortController();
  const abortPromise = pool.queryContext(file, { signal: controller.signal });
  // Cancel immediately after enqueue / dispatch
  controller.abort();

  await assert.rejects(
    abortPromise,
    (err) => err instanceof HistoryAbortedError || err.statusCode === 499,
  );

  // Subsequent request must be scheduled and handled cleanly by healthy worker
  const subsequentResult = await pool.queryContext(file, { tail: 5 });
  const parsed = JSON.parse(subsequentResult);
  assert.equal(parsed.context.messages.length, 2);
});

test("Pool closeAll and queued abort listener cleanup", async () => {
  const fixtureWorker = resolve(__dirname, "..", "tests", "fixtures", "test-exit-worker.cjs");
  const customPool = new SessionHistoryPool({
    maxWorkers: 1,
    workerScriptPath: fixtureWorker,
    requestTimeoutMs: 200,
  });

  const abortCtrl = new AbortController();
  // Queue task and abort before worker resolves
  const p1 = customPool.queryContext("/virtual/file1.jsonl", { signal: abortCtrl.signal });
  const p2 = customPool.queryContext("/virtual/file2.jsonl");

  abortCtrl.abort();

  await assert.rejects(p1, (err) => err instanceof HistoryAbortedError || err.statusCode === 499);

  // closeAll rejects remaining queued tasks
  const closePromise = customPool.closeAll();
  await assert.rejects(p2, (err) => /closed/i.test(err.message));
  await closePromise;
});

test("Pool request timeout rejects with 504 HistoryTimeoutError", async () => {
  const fixtureWorker = resolve(__dirname, "..", "tests", "fixtures", "test-exit-worker.cjs");
  const customPool = new SessionHistoryPool({
    maxWorkers: 1,
    workerScriptPath: fixtureWorker,
    requestTimeoutMs: 50, // 50ms timeout
  });

  try {
    await assert.rejects(
      customPool.queryContext("/virtual/slow-file.jsonl"),
      (err) => err instanceof HistoryTimeoutError || err.statusCode === 504,
    );
  } finally {
    await customPool.closeAll();
  }
});

test("Worker exit 0 unexpected crash rejects active task safely", async () => {
  const fixtureWorker = resolve(__dirname, "..", "tests", "fixtures", "test-exit-worker.cjs");
  const customPool = new SessionHistoryPool({
    maxWorkers: 1,
    workerScriptPath: fixtureWorker,
  });

  try {
    await assert.rejects(
      customPool.queryContext("/virtual/exit-file.jsonl"),
      (err) => /exited/i.test(err.message),
    );
  } finally {
    await customPool.closeAll();
  }
});

test("Route service mapping: 504, 499, 503, 409, 404 and authoritative live history", async () => {
  // Test 1: Worker throws timeout -> 504
  const mockPoolTimeout = {
    queryContext: async () => {
      const err = new Error("Query timeout");
      err.statusCode = 504;
      err.name = "HistoryTimeoutError";
      throw err;
    },
  };

  const req1 = new Request("http://localhost/api/sessions/s1/context");
  const res1 = await handleSessionContextRequest(req1, { id: "s1" }, {
    pool: mockPoolTimeout,
    getRpc: () => undefined,
    resolvePath: async () => "/fake/path.jsonl",
  });
  assert.equal(res1.status, 504);

  // Test 2: Client aborted -> 499
  const abortCtrl = new AbortController();
  abortCtrl.abort();
  const req2 = new Request("http://localhost/api/sessions/s1/context", { signal: abortCtrl.signal });
  const res2 = await handleSessionContextRequest(req2, { id: "s1" }, {
    pool: {
      queryContext: async () => {
        const err = new Error("Aborted");
        err.name = "HistoryAbortedError";
        throw err;
      },
    },
    getRpc: () => undefined,
    resolvePath: async () => "/fake/path.jsonl",
  });
  assert.equal(res2.status, 499);

  // Test 3: Queue full -> 503 with Retry-After header
  const req3 = new Request("http://localhost/api/sessions/s1/context");
  const res3 = await handleSessionContextRequest(req3, { id: "s1" }, {
    pool: {
      queryContext: async () => {
        const err = new Error("Queue full");
        err.statusCode = 503;
        err.name = "HistoryQueueFullError";
        throw err;
      },
    },
    getRpc: () => undefined,
    resolvePath: async () => "/fake/path.jsonl",
  });
  assert.equal(res3.status, 503);
  assert.equal(res3.headers.get("Retry-After"), "1");

  // Test 4: Conflict -> 409
  const req4 = new Request("http://localhost/api/sessions/s1/context");
  const res4 = await handleSessionContextRequest(req4, { id: "s1" }, {
    pool: {
      queryContext: async () => {
        const err = new Error("Conflict");
        err.statusCode = 409;
        err.name = "HistoryConflictError";
        throw err;
      },
    },
    getRpc: () => undefined,
    resolvePath: async () => "/fake/path.jsonl",
  });
  assert.equal(res4.status, 409);

  // Test 5: Session not found -> 404
  const req5 = new Request("http://localhost/api/sessions/nonexistent/context");
  const res5 = await handleSessionContextRequest(req5, { id: "nonexistent" }, {
    getRpc: () => undefined,
    resolvePath: async () => null,
  });
  assert.equal(res5.status, 404);

  // Test 6: Live history remains authoritative even if disk cannot resolve its cursor
  const mockLiveRpc = {
    isAlive: () => true,
    isRunning: () => true,
    inner: {
      sessionManager: {
        getSessionFile: () => "/live/sess.jsonl",
        getLeafId: () => "live_leaf_1",
        getEntries: () => [
          { type: "session", id: "live_s", version: 3 },
          userEntry("live_u1", null, "Live question"),
          assistantEntry("live_leaf_1", "live_u1", "Live answer"),
        ],
      },
    },
  };

  const req6 = new Request("http://localhost/api/sessions/live_s/context");
  const res6 = await handleSessionContextRequest(req6, { id: "live_s" }, {
    pool: {
      queryContext: async () => {
        const err = new Error("Cursor not found");
        err.name = "CursorNotFoundError";
        throw err;
      },
    },
    getRpc: () => mockLiveRpc,
    resolvePath: async () => "/live/sess.jsonl",
  });
  assert.equal(res6.status, 200);
  const data6 = await res6.json();
  assert.equal(data6.context.messages.length, 2);
  assert.equal(data6.context.entryIds[1], "live_leaf_1");
});

test("Real 60MB synthetic session: cold index build, warm seek read, monotonic event loop delay, and reader bytes metrics", async (t) => {
  const dir = createTempDir("pi-60mb-test-");
  const filePath = join(dir, "large-session.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const header = { type: "session", version: 3, id: "large-60mb", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
  writeFileSync(filePath, JSON.stringify(header) + "\n");

  const largeToolPayload = "x".repeat(256 * 1024); // 256KB output block
  let prevId = null;
  const targetTotalBytes = 60 * 1024 * 1024;
  let currentBytes = 0;
  let counter = 0;

  let bufferChunk = "";
  while (currentBytes < targetTotalBytes) {
    counter++;
    const uId = `u_${counter}`;
    const u = userEntry(uId, prevId, `User request #${counter}`);
    const aId = `a_${counter}`;
    const a = assistantEntry(aId, uId, `Executing tool command #${counter}`);
    const tId = `tr_${counter}`;
    const tr = {
      type: "message",
      id: tId,
      parentId: aId,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: `call_${counter}`,
        content: [{ type: "text", text: `Stdout #${counter}: ${largeToolPayload}` }],
      },
    };
    prevId = tId;

    bufferChunk += JSON.stringify(u) + "\n" + JSON.stringify(a) + "\n" + JSON.stringify(tr) + "\n";
    if (bufferChunk.length >= 4 * 1024 * 1024) {
      appendFileSync(filePath, bufferChunk);
      currentBytes += Buffer.byteLength(bufferChunk);
      bufferChunk = "";
    }
  }
  if (bufferChunk.length > 0) {
    appendFileSync(filePath, bufferChunk);
    currentBytes += Buffer.byteLength(bufferChunk);
  }

  const stat = statSync(filePath);
  const actualSizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  assert.ok(stat.size >= 55 * 1024 * 1024, `Generated file size must be ~60MB, got ${actualSizeMb}MB`);

  // Monotonic performance tick sampler: interval max(0, now - lastTick - 5)
  let lastTick = performance.now();
  let maxLag = 0;
  let sampleCount = 0;
  const loopInterval = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - lastTick - 5);
    if (lag > maxLag) maxLag = lag;
    sampleCount++;
    lastTick = now;
  }, 5);

  const indexer = new SessionHistoryIndexer();

  // Cold build via pool in worker thread while monitoring monotonic event loop ticks on main thread
  const coldStart = performance.now();
  await pool.queryContext(filePath, { tail: 50 });
  const coldDurationMs = performance.now() - coldStart;

  clearInterval(loopInterval);
  assert.ok(sampleCount > 0, "Monotonic loop sampler must record tick samples");
  console.log(`[60MB Metrics] Monotonic loop lag max: ${maxLag.toFixed(2)} ms (samples: ${sampleCount})`);

  // Assert unchanged index scan 0 bytes
  const unchangedIdx1 = indexer.getOrBuildIndex(filePath);
  const bytesBeforeUnchanged = indexer.getTotalBytesRead();
  const unchangedIdx2 = indexer.getOrBuildIndex(filePath);
  const scanBytesUnchanged = indexer.getTotalBytesRead() - bytesBeforeUnchanged;
  assert.equal(unchangedIdx1.fingerprint.ino, unchangedIdx2.fingerprint.ino);
  assert.equal(scanBytesUnchanged, 0, "Unchanged index rebuild must read 0 bytes from disk (cache hit)");

  // Warm seek read: instrument actual bytesRead from disk
  const bytesBeforeWarm = indexer.getTotalBytesRead();
  const warmStart = performance.now();
  const warmJson = await indexer.queryContext(filePath, { tail: 50 });
  const warmDurationMs = performance.now() - warmStart;
  const actualDiskBytesRead = indexer.getTotalBytesRead() - bytesBeforeWarm;

  const warmData = JSON.parse(warmJson);
  assert.equal(warmData.context.entryIds[warmData.context.entryIds.length - 1], prevId);

  console.log(`[60MB Metrics] File size: ${actualSizeMb} MB`);
  console.log(`[60MB Metrics] Cold index build: ${coldDurationMs.toFixed(1)} ms`);
  console.log(`[60MB Metrics] Warm seek read duration: ${warmDurationMs.toFixed(1)} ms`);
  console.log(`[60MB Metrics] Actual disk bytesRead for 50-entry page: ${(actualDiskBytesRead / 1024).toFixed(1)} KB`);

  // Assert warm disk bytesRead << file size (6.4MB for 50 entries vs 60MB file size, < 15%)
  assert.ok(
    actualDiskBytesRead < 10 * 1024 * 1024 && actualDiskBytesRead < stat.size * 0.2,
    `Warm seek read must read << file size (read ${actualDiskBytesRead} bytes vs ${stat.size} bytes)`,
  );
});
