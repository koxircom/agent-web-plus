import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { listSessionsIncremental, resetSessionScanIndexForTests } = await jiti.import("./session-list-scanner.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const line = (entry) => JSON.stringify(entry) + "\n";
const message = (id, role, content, time = timestamp) => ({
  type: "message", id, parentId: null, timestamp: time, message: { role, content },
});

async function freshScanner() {
  return createJiti(import.meta.url, { moduleCache: false }).import("./session-list-scanner.ts");
}

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-"));
  const dir = join(root, "sessions", "project");
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(id, entries = [], extraHeader = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: root, timestamp, ...extraHeader }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, write, indexPath: join(root, "pi-web-session-index.json") };
}

async function sdkMetadata() {
  return (await SessionManager.listAll()).map((session) => {
    const info = { ...session };
    delete info.allMessagesText;
    return info;
  });
}

test("matches SDK metadata and tie ordering across cache hits, mutations, and restarts", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [
    message("a1", "user", [{ type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "request" }]),
    message("a2", "assistant", [{ type: "text", text: "answer" }]),
    message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-03T00:00:00.000Z"),
    { type: "custom", data: "x".repeat(256 * 1024) },
  ]);
  const b = write("b", [message("b1", "user", "forked request")], { parentSession: a });
  const c = write("c");
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, ...args) => {
    opened.push(path);
    return createReadStream(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function check(label, expectedReads) {
    const expected = await sdkMetadata();
    opened.length = 0;
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    assert.deepEqual([...opened].sort(), [...expectedReads].sort(), `${label}: scanned files`);
  }

  await check("cold", [a, b, c]);
  await check("warm", []);
  if (process.platform !== "win32") assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  resetSessionScanIndexForTests();
  await check("persisted cache", []);

  fs.appendFileSync(a, line({ type: "session_info", name: "  Renamed  " }));
  await check("rename preserves equal-time order", [a]);
  fs.appendFileSync(a, line({ type: "session_info", name: " " }));
  await check("explicit name clear", [a]);
  fs.appendFileSync(b, line(message("b2", "assistant", "new activity", "2026-01-02T00:00:00.000Z")));
  await check("append", [b]);
  write("a", [message("replacement", "user", "rewritten")]);
  await check("whole-file rewrite", [a]);
  const d = write("d", [message("d1", "user", "new session")]);
  fs.rmSync(c);
  await check("create and delete", [d]);

  resetSessionScanIndexForTests();
  fs.appendFileSync(a, line({ type: "session_info", name: "changed while stopped" }));
  fs.rmSync(b);
  await check("restart revalidates changed and deleted files", [a]);
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), [a, d].sort());
});

test("does not turn a readable catalogue into an authoritative empty list after root EACCES", async (t) => {
  const { root, write } = fixture(t);
  const sessionPath = write("kept", [message("kept-1", "user", "keep")]);
  assert.equal((await listSessionsIncremental()).length, 1);
  const sessionsDir = join(root, "sessions");
  const originalReaddir = fs.promises.readdir;
  t.mock.method(fs.promises, "readdir", async (target, ...args) => {
    if (String(target) === sessionsDir) throw Object.assign(new Error("mount denied"), { code: "EACCES" });
    return originalReaddir(target, ...args);
  });
  syncBuiltinESMExports();
  try {
    const scanner = await freshScanner();
    await assert.rejects(scanner.listSessionsIncremental(), (error) => error?.code === "EACCES");
    assert.equal(globalThis.__piWebScanIndex?.has(sessionPath), true, "the last good index must survive the failed read");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("does not discard a good index when one project directory returns EACCES", async (t) => {
  const { dir, write } = fixture(t);
  const sessionPath = write("kept", [message("kept-1", "user", "keep")]);
  assert.equal((await listSessionsIncremental()).length, 1);
  const originalReaddir = fs.promises.readdir;
  t.mock.method(fs.promises, "readdir", async (target, ...args) => {
    if (String(target) === dir) throw Object.assign(new Error("project denied"), { code: "EACCES" });
    return originalReaddir(target, ...args);
  });
  syncBuiltinESMExports();
  try {
    const scanner = await freshScanner();
    await assert.rejects(scanner.listSessionsIncremental(), (error) => error?.code === "EACCES");
    assert.equal(globalThis.__piWebScanIndex?.has(sessionPath), true, "the last good index must survive the failed project read");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("does not delete a good index entry after a file stat EIO", async (t) => {
  const { root, write } = fixture(t);
  const sessionPath = write("kept", [message("kept-1", "user", "keep")]);
  assert.equal((await listSessionsIncremental()).length, 1);
  const originalStat = fs.promises.stat;
  t.mock.method(fs.promises, "stat", async (target, ...args) => {
    if (String(target) === sessionPath) throw Object.assign(new Error("I/O failure"), { code: "EIO" });
    return originalStat(target, ...args);
  });
  syncBuiltinESMExports();
  try {
    const scanner = await freshScanner();
    await assert.rejects(scanner.listSessionsIncremental(), (error) => error?.code === "EIO");
    assert.equal(globalThis.__piWebScanIndex?.has(sessionPath), true, "the last good index must survive the failed stat");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("drains concurrent scan failures and recovers without unhandled rejections", async (t) => {
  const { write } = fixture(t);
  const firstPath = write("first", [message("first-1", "user", "first")]);
  const secondPath = write("second", [message("second-1", "user", "second")]);
  assert.equal((await listSessionsIncremental()).length, 2);
  fs.appendFileSync(firstPath, line({ type: "session_info", name: "changed-first" }));
  fs.appendFileSync(secondPath, line({ type: "session_info", name: "changed-second" }));

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let streamCalls = 0;
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const originalCreateReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (filePath, ...args) => {
    if (String(filePath) === firstPath) {
      streamCalls += 1;
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(Object.assign(new Error("first scan I/O failure"), { code: "EIO" })));
      return stream;
    }
    if (String(filePath) === secondPath) {
      streamCalls += 1;
      const stream = new Readable({ read() {} });
      secondGate.then(() => stream.destroy(Object.assign(new Error("second scan I/O failure"), { code: "EIO" })));
      return stream;
    }
    return originalCreateReadStream(filePath, ...args);
  });
  syncBuiltinESMExports();
  try {
    const scanner = await freshScanner();
    let settled = false;
    const pending = scanner.listSessionsIncremental().finally(() => { settled = true; });
    const startedDeadline = Date.now() + 3000;
    while (streamCalls < 2 && Date.now() < startedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(streamCalls, 2, "both file reads should be started");
    assert.equal(settled, false, "the first failure must wait for other started reads");
    releaseSecond();
    await assert.rejects(pending, (error) => error?.code === "EIO");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "drained worker failures must not become unhandled rejections");
  } finally {
    releaseSecond?.();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onUnhandled);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  const recovered = await listSessionsIncremental();
  assert.deepEqual(recovered.map((session) => session.id).sort(), ["first", "second"]);
});

test("summary and full scans retain a valid header whose cwd is absent", async (t) => {
  const { write } = fixture(t);
  write("legacy", [message("legacy-1", "user", "legacy")], { cwd: undefined });

  const summary = await listSessionsIncremental({ deferDetails: true });
  const full = await listSessionsIncremental();
  assert.deepEqual(summary.map((session) => session.id), ["legacy"]);
  assert.deepEqual(full.map((session) => session.id), ["legacy"]);
  assert.equal(summary[0].cwd, "");
  assert.equal(full[0].cwd, "");
});

test("a fresh agent without a sessions directory is an ordinary empty catalogue", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-empty-agent-"));
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  t.after(() => {
    resetSessionScanIndexForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(await listSessionsIncremental(), []);
  assert.equal(fs.existsSync(join(root, "sessions")), false, "a read must not create the sessions directory");
});

test("a broken non-directory project symlink is skipped without hiding readable sessions", { skip: process.platform === "win32" }, async (t) => {
  const { root, write } = fixture(t);
  write("kept", [message("kept-1", "user", "keep")]);
  const targetFile = join(root, "not-a-project-directory");
  fs.writeFileSync(targetFile, "not a directory");
  fs.symlinkSync(targetFile, join(root, "sessions", "broken-project"), "dir");

  const sessions = await listSessionsIncremental();
  assert.deepEqual(sessions.map((session) => session.id), ["kept"]);
});

test("discards malformed persisted entries and rebuilds the list from valid session files", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("b", [message("b1", "user", "also healthy")]);
  const expected = await listSessionsIncremental();
  const pristine = fs.readFileSync(indexPath, "utf8");
  const corruptions = [
    ["missing fingerprint", (entry) => { delete entry.fp; }],
    ["null fingerprint", (entry) => { entry.fp = null; }],
    ["string size", (entry) => { entry.fp.size = String(entry.fp.size); }],
    ["negative size", (entry) => { entry.fp.size = -1; }],
    ["invalid mtime", (entry) => { entry.fp.mtimeMs = null; }],
    ["missing metadata", (entry) => { delete entry.info; }],
    ["mismatched path", (entry) => { entry.info.path = "/elsewhere/session.jsonl"; }],
    ["invalid id", (entry) => { entry.info.id = null; }],
    ["invalid cwd", (entry) => { entry.info.cwd = []; }],
    ["invalid first message", (entry) => { entry.info.firstMessage = 1; }],
    ["invalid name", (entry) => { entry.info.name = {}; }],
    ["invalid parent", (entry) => { entry.info.parentSessionPath = []; }],
    ["invalid count", (entry) => { entry.info.messageCount = -1; }],
    ["invalid created", (entry) => { entry.info.created = "not a date"; }],
    ["invalid modified", (entry) => { entry.info.modified = "not a date"; }],
    ["null date", (entry) => { entry.info.created = null; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const index = JSON.parse(pristine);
    corrupt(index.entries[a]);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    const sessions = await listAllSessions({ force: true });
    assert.deepEqual(sessions.map((s) => s.id), expected.map((s) => s.id), label);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, `${label}: repaired cache survives restart`);
  }
  for (const source of ["{", "null", '{"version":2,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"broken":null}}']) {
    fs.writeFileSync(indexPath, source);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, source);
  }
});

test("retains SDK handling of partial lines, activity timestamps, and empty sessions", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [
    message("a1", "assistant", "not the first user message"),
    message("a2", "user", []),
    { ...message("a3", "user", "user message"), message: { role: "user", content: "user message", timestamp: Date.parse("2026-01-04T00:00:00.000Z") } },
  ]);
  fs.appendFileSync(a, '{"unfinished":');
  const b = write("b");
  fs.writeFileSync(b, "\nnot json\n" + fs.readFileSync(b, "utf8"));
  fs.writeFileSync(join(dir, "invalid.jsonl"), line(message("invalid", "user", "no header")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("defers changed-file details to a later scan", async (t) => {
  const { write } = fixture(t);
  const sessionPath = write("deferred", [
    message("d1", "user", "deferred request"),
    message("d2", "assistant", "deferred answer"),
  ]);

  // A summary listing reads only the header and stat, so the transcript-derived
  // fields stay empty and the row is marked as pending.
  const summary = await listSessionsIncremental({ deferDetails: true });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].path, sessionPath);
  assert.equal(summary[0].detailsPending, true);
  assert.equal(summary[0].messageCount, 0);
  assert.equal(summary[0].firstMessage, "");
  assert.equal(summary[0].id, "deferred");
  assert.equal(summary[0].cwd, process.env.PI_CODING_AGENT_DIR);

  // The normal listing still hydrates the exact details.
  const detailed = await listSessionsIncremental();
  assert.equal(detailed[0].detailsPending, undefined);
  assert.equal(detailed[0].messageCount, 2);
  assert.equal(detailed[0].firstMessage, "deferred request");
});

test("a summary listing does not downgrade an already-scanned file", async (t) => {
  const { write } = fixture(t);
  write("cached", [message("c1", "user", "cached request")]);

  const detailed = await listSessionsIncremental();
  assert.equal(detailed[0].messageCount, 1);

  // The cached entry is complete, so the summary listing serves it as-is. The
  // scan index is persisted across restarts, so this is the common path: a
  // first paint should not blank details it is already holding.
  const summary = await listSessionsIncremental({ deferDetails: true });
  assert.equal(summary[0].detailsPending, undefined);
  assert.equal(summary[0].messageCount, 1);
  assert.equal(summary[0].firstMessage, "cached request");
  assert.equal((await listSessionsIncremental())[0].messageCount, 1);
});

test("a summary listing defers only the files the index has not scanned", async (t) => {
  const { write } = fixture(t);
  write("cached", [message("c1", "user", "cached request")]);
  assert.equal((await listSessionsIncremental())[0].messageCount, 1);

  // A file the index has never seen has no details to reuse, so it is the one
  // row that comes back pending — the point of the summary mode.
  write("fresh", [message("f1", "user", "fresh request")]);
  const summary = await listSessionsIncremental({ deferDetails: true });
  const byId = Object.fromEntries(summary.map((row) => [row.id, row]));
  assert.equal(byId.cached.detailsPending, undefined);
  assert.equal(byId.cached.messageCount, 1);
  assert.equal(byId.fresh.detailsPending, true);
  assert.equal(byId.fresh.messageCount, 0);
});

test("discovers sessions through project directory symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  write("a", [message("a1", "user", "linked")]);
  const external = join(root, "external-project");
  fs.renameSync(dir, external);
  fs.symlinkSync(external, dir, "dir");
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});
