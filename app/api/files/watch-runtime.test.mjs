// temp
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach, afterEach } from "node:test";
import { EventEmitter } from "node:events";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "watch-runtime-test-")));

const sourceRoot = new URL("../../..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": sourceRoot.replace(/\/$/, ""),
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
  interopDefault: true,
});

const { allowFileRoot } = await jiti.import(join(sourceRoot, "lib/file-access.ts"));
const { GET } = await jiti.import(join(sourceRoot, "app/api/files/[...path]/route.ts"));

allowFileRoot(root);

const originalWatch = fs.watch;
const originalStat = fs.promises.stat;

after(async () => {
  fs.watch = originalWatch;
  fs.promises.stat = originalStat;
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  fs.watch = originalWatch;
  fs.promises.stat = originalStat;
});

function segmentsOf(p) {
  return p.split("/").filter(Boolean);
}

function createSSEReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  let pendingResolvers = [];
  let isDone = false;

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          isDone = true;
          for (const { resolve, timer } of pendingResolvers) {
            clearTimeout(timer);
            resolve(null);
          }
          pendingResolvers = [];
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const sep = buffer.indexOf("\n\n");
          if (sep === -1) break;
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = "message";
          let data = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) {
              try {
                data = JSON.parse(line.slice(6));
              } catch {
                data = line.slice(6);
              }
            }
          }
          const parsed = { event, data };
          if (pendingResolvers.length > 0) {
            const { resolve, timer } = pendingResolvers.shift();
            clearTimeout(timer);
            resolve(parsed);
          } else {
            events.push(parsed);
          }
        }
      }
    } catch (e) {
      isDone = true;
      for (const { reject, timer } of pendingResolvers) {
        clearTimeout(timer);
        reject(e);
      }
      pendingResolvers = [];
    }
  })();

  function readEvent(timeoutMs = 4000) {
    if (events.length > 0) {
      return Promise.resolve(events.shift());
    }
    if (isDone) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = pendingResolvers.findIndex((p) => p.timer === timer);
        if (idx !== -1) pendingResolvers.splice(idx, 1);
        reject(new Error(`Timeout waiting for SSE event within ${timeoutMs}ms`));
      }, timeoutMs);
      pendingResolvers.push({ resolve, reject, timer });
    });
  }

  return {
    readEvent,
    async cancel() {
      try {
        await reader.cancel();
      } catch { /* ignore */ }
    },
  };
}

test("mock fs.watch throwing ENOSPC falls back to polling and handles update/delete/recreate", async () => {
  const filePath = join(root, "sample-enospc.pdf");
  await writeFile(filePath, "version 1");

  fs.watch = () => {
    const err = new Error("ENOSPC: no space left on device");
    err.code = "ENOSPC";
    throw err;
  };

  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");

  const sse = createSSEReader(response);
  try {
    const initEvent = await sse.readEvent();
    assert.equal(initEvent?.event, "connected");
    assert.equal(initEvent?.data?.mode, "poll");
    assert.equal(initEvent?.data?.filePath, filePath);

    // 1. Update file
    await new Promise((r) => setTimeout(r, 100));
    await writeFile(filePath, "version 2 content which is longer");
    const changeEvent1 = await sse.readEvent(2500);
    assert.equal(changeEvent1?.event, "change");
    assert.ok(changeEvent1?.data?.size > 0);

    // 2. Delete file
    await unlink(filePath);
    const deleteEvent = await sse.readEvent(2500);
    assert.equal(deleteEvent?.event, "change");
    assert.equal(deleteEvent?.data?.size, 0);

    // 3. Recreate file
    await writeFile(filePath, "version 3 recreated");
    const recreateEvent = await sse.readEvent(2500);
    assert.equal(recreateEvent?.event, "change");
    assert.ok(recreateEvent?.data?.size > 0);
  } finally {
    await sse.cancel();
  }
});

test("mock fs.watch throwing EMFILE falls back to polling and handles updates", async () => {
  const filePath = join(root, "sample-emfile.pdf");
  await writeFile(filePath, "initial emfile");

  fs.watch = () => {
    const err = new Error("EMFILE: too many open files");
    err.code = "EMFILE";
    throw err;
  };

  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  assert.equal(response.status, 200);
  const sse = createSSEReader(response);
  try {
    const initEvent = await sse.readEvent();
    assert.equal(initEvent?.event, "connected");
    assert.equal(initEvent?.data?.mode, "poll");

    await writeFile(filePath, "updated emfile content");
    const changeEvent = await sse.readEvent(2500);
    assert.equal(changeEvent?.event, "change");
    assert.ok(changeEvent?.data?.size > 0);
  } finally {
    await sse.cancel();
  }
});

test("mock fs.watch throwing EACCES or EPERM fails closed without polling", async () => {
  const filePath = join(root, "sample-eacces.pdf");
  await writeFile(filePath, "secret content");

  fs.watch = () => {
    const err = new Error("EACCES: permission denied");
    err.code = "EACCES";
    throw err;
  };

  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  assert.equal(response.status, 200);
  const sse = createSSEReader(response);
  try {
    const event = await sse.readEvent();
    assert.equal(event?.event, "error");
    assert.equal(event?.data?.message, "Failed to watch file");

    const next = await sse.readEvent(500).catch(() => null);
    assert.equal(next, null, "stream should close on permission error");
  } finally {
    await sse.cancel();
  }
});

test("unauthorized file path returns 403 forbidden", async () => {
  const outsidePath = "/var/log/private-outside.log";
  const url = `http://localhost/api/files/${encodeURIComponent(outsidePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(outsidePath) }) });

  assert.equal(response.status, 403);
  const data = await response.json();
  assert.equal(data.error, "Access denied");
});

test("abort signal cleans up stream and stops sending events", async () => {
  const filePath = join(root, "sample-abort.pdf");
  await writeFile(filePath, "abort test initial");

  fs.watch = () => {
    const err = new Error("ENOSPC: mock");
    err.code = "ENOSPC";
    throw err;
  };

  const controller = new AbortController();
  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url, { signal: controller.signal });
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  const sse = createSSEReader(response);
  const initEvent = await sse.readEvent();
  assert.equal(initEvent?.event, "connected");

  // Abort connection
  controller.abort();

  const next = await sse.readEvent(500).catch(() => null);
  assert.equal(next, null, "stream should end after abort");

  // Modifying file after abort should not crash or enqueue to closed stream
  await writeFile(filePath, "abort test changed after abort");
  await new Promise((r) => setTimeout(r, 1200));
});

test("watcher runtime error gracefully falls back to polling without re-emitting connected", async () => {
  const filePath = join(root, "sample-runtime-fallback.pdf");
  await writeFile(filePath, "runtime test");

  const mockWatcher = new EventEmitter();
  mockWatcher.close = () => {};

  fs.watch = () => mockWatcher;

  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  const sse = createSSEReader(response);
  try {
    const initEvent = await sse.readEvent();
    assert.equal(initEvent?.event, "connected");
    assert.equal(initEvent?.data?.mode, "watch");

    // Emit runtime ENOSPC on active watcher
    const runtimeErr = new Error("ENOSPC in runtime");
    runtimeErr.code = "ENOSPC";
    mockWatcher.emit("error", runtimeErr);

    // Update file and verify polling catches it without an extra connected event
    await writeFile(filePath, "runtime test updated after fallback");
    const changeEvent = await sse.readEvent(2500);
    assert.equal(changeEvent?.event, "change");
    assert.ok(changeEvent?.data?.size > 0);
  } finally {
    await sse.cancel();
  }
});

test("running fs.promises.stat throwing EACCES terminates stream with fixed error and no fake deletion", async () => {
  const filePath = join(root, "sample-runtime-eacces.pdf");
  await writeFile(filePath, "initial content");

  let failStat = false;
  fs.promises.stat = async (p, ...args) => {
    if (failStat && typeof p === "string" && p === filePath) {
      const err = new Error(`EACCES: permission denied, stat '${filePath}'`);
      err.code = "EACCES";
      throw err;
    }
    return originalStat.call(fs.promises, p, ...args);
  };

  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  assert.equal(response.status, 200);
  const sse = createSSEReader(response);
  try {
    const initEvent = await sse.readEvent();
    assert.equal(initEvent?.event, "connected");

    failStat = true;
    await writeFile(filePath, "trigger eacces stat check");

    const event = await sse.readEvent(2500);
    assert.equal(event?.event, "error");
    assert.deepEqual(event?.data, { message: "Failed to watch file" });
    assert.ok(!JSON.stringify(event?.data).includes(filePath));

    const next = await sse.readEvent(500).catch(() => null);
    assert.equal(next, null, "stream should close after permission error");
  } finally {
    await sse.cancel();
  }
});

test("running fs.promises.stat throwing unknown error sends fixed error without leaking internal paths and cleans up", async () => {
  const filePath = join(root, "sample-runtime-unknown.pdf");
  await writeFile(filePath, "initial content");

  let failStat = false;
  fs.promises.stat = async (p, ...args) => {
    if (failStat && typeof p === "string" && p === filePath) {
      const err = new Error(`EIO: i/o error on device, stat '${filePath}'`);
      err.code = "EIO";
      throw err;
    }
    return originalStat.call(fs.promises, p, ...args);
  };

  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  assert.equal(response.status, 200);
  const sse = createSSEReader(response);
  try {
    const initEvent = await sse.readEvent();
    assert.equal(initEvent?.event, "connected");

    failStat = true;
    await writeFile(filePath, "trigger unknown stat error");

    const event = await sse.readEvent(2500);
    assert.equal(event?.event, "error");
    assert.deepEqual(event?.data, { message: "Failed to watch file" });
    assert.ok(!JSON.stringify(event?.data).includes(filePath));
    assert.ok(!JSON.stringify(event?.data).includes("EIO"));

    const next = await sse.readEvent(500).catch(() => null);
    assert.equal(next, null, "stream should close after unknown error");
  } finally {
    await sse.cancel();
  }
});

test("running fs.promises.stat throwing ENOTDIR emits missing change event instead of error", async () => {
  const filePath = join(root, "sample-runtime-enotdir.pdf");
  await writeFile(filePath, "initial content");

  let failStat = false;
  fs.promises.stat = async (p, ...args) => {
    if (failStat && typeof p === "string" && p === filePath) {
      const err = new Error(`ENOTDIR: not a directory, stat '${filePath}'`);
      err.code = "ENOTDIR";
      throw err;
    }
    return originalStat.call(fs.promises, p, ...args);
  };

  const url = `http://localhost/api/files/${encodeURIComponent(filePath.slice(1))}?type=watch&engine=pi&engine=pi`;
  const request = new NextRequest(url);
  const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(filePath) }) });

  assert.equal(response.status, 200);
  const sse = createSSEReader(response);
  try {
    const initEvent = await sse.readEvent();
    assert.equal(initEvent?.event, "connected");

    failStat = true;
    await writeFile(filePath, "trigger enotdir check");

    const changeEvent = await sse.readEvent(2500);
    assert.equal(changeEvent?.event, "change");
    assert.equal(changeEvent?.data?.size, 0);
  } finally {
    await sse.cancel();
  }
});
