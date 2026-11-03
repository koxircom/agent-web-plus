import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createRealBulkDeleteHttpServer } from "./fixtures/bulk-delete-real-http.mjs";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const root = path.resolve(".");
const storagePaths = require(path.join(root, "bin/usage-guard/usage-storage-paths.cjs"));
const cjsGuard = require(path.join(root, "bin/usage-guard/pi-usage-delete-guard.cjs"));

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": root,
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
  interopDefault: true,
});

const { loadUsageDeleteGuard, sealAndDeleteSync, sealAndDelete } = await jiti.import(path.join(root, "lib/usage-delete-guard.ts"));
const { deleteSessions } = await jiti.import(path.join(root, "lib/session-delete.ts"));

test("session-delete nonblocking HTTP: actual guard spawns real child with blocking lock and loopstats", async (t) => {
  let pingHandled = 0;
  const fixture = await createRealBulkDeleteHttpServer({
    fallbackHandler(req, res, { urlObj, method }) {
      if (urlObj.pathname === "/api/test-ping" && method === "GET") {
        pingHandled++;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ ok: true, pingHandled }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
    },
  });
  t.after(async () => await fixture.close());

  const s1 = "session-nb-1";
  const s2 = "session-nb-2";
  await fixture.addSession(s1);
  await fixture.addSession(s2);

  // 定位实际 storage lock 路径并由父进程持锁造成真实 blocking lock
  const dataDir = path.join(fixture.sandboxDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, "pi-usage-events-nas.json.lock");
  const blockerFd = storagePaths.acquireUsageLock(lockFile, { timeoutMs: 5000 });

  // Monitor event-loop ticks during deletion (loopstats)
  const loopstats = { ticks: 0 };
  const tickTimer = setInterval(() => {
    loopstats.ticks++;
  }, 10);

  // Send DELETE request and concurrently send GET ping request
  const deletePromise = fetch(`${fixture.origin}/api/sessions/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [s1, s2] }),
  });

  // 延迟 60ms 释放 blocker 锁，使得在后台排队的真实子进程顺利获取锁并完成 seal
  const releaseTimer = setTimeout(() => {
    try {
      storagePaths.releaseUsageLock(lockFile, blockerFd);
    } catch (_) {}
  }, 60);

  // 确保在子进程被 blocking lock 阻挡排队期间，HTTP ping 能够并发无阻塞响应
  const pingRes = await fetch(`${fixture.origin}/api/test-ping`);
  assert.equal(pingRes.status, 200);
  const pingBody = await pingRes.json();
  assert.equal(pingBody.ok, true);
  assert.equal(pingHandled, 1);

  const delRes = await deletePromise;
  clearInterval(tickTimer);
  clearTimeout(releaseTimer);

  assert.equal(delRes.status, 200);
  const delBody = await delRes.json();
  assert.equal(delBody.results.length, 2);
  assert.ok(delBody.results.every((r) => r.ok));

  assert.ok(loopstats.ticks >= 2, `Event loop must tick during delete (got ${loopstats.ticks})`);
});

test("session-delete nonblocking: seal failure guarantees 0 unlinks and maintains consistency", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const validId = "session-valid-keep";
  const corruptId = "session-corrupt-fail";
  const p1 = await fixture.addSession(validId);
  const p2 = await fixture.addSession(corruptId);

  // Corrupt p2 JSONL
  fs.appendFileSync(p2, '{"type":"message","corrupt":');

  const res = await fetch(`${fixture.origin}/api/sessions/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [validId, corruptId] }),
  });

  const body = await res.json();
  assert.ok(body.results.every((r) => !r.ok), "All targets must report failure");

  assert.equal(fs.existsSync(p1), true, "Valid session must NOT be unlinked on batch seal failure");
  assert.equal(fs.existsSync(p2), true, "Corrupted session must NOT be unlinked");
});

test("session-delete: legacy sealAndDeleteSync remains functional with identical signature", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const s1 = "session-sync-legacy";
  const p1 = await fixture.addSession(s1);

  const onDeletedCalled = [];
  const res = sealAndDeleteSync(new Map([[s1, p1]]), (id, p) => onDeletedCalled.push({ id, p }));
  assert.equal(res.ok, true);
  assert.equal(res.deletedCount, 1);
  assert.equal(fs.existsSync(p1), false);
  assert.equal(onDeletedCalled.length, 1);
  assert.equal(onDeletedCalled[0].id, s1);
});

test("session-delete nonblocking HTTP: cleanup foreign same-pid wrong-token lock is never deleted", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const dataDir = path.join(fixture.sandboxDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, "pi-usage-events-nas.json.lock");

  // 模拟外来 foreign 任务遗留的 same-pid 但 wrong-token 锁
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: process.pid,
      ownerRequestToken: "wrong-foreign-owner-token",
      time: Date.now(),
    }),
    "utf8"
  );

  // cleanupWorkerLockSafely 核验并拒绝删除该外国锁
  cjsGuard.cleanupWorkerLockSafely(process.pid, lockFile, true, "expected-own-request-token");
  assert.equal(fs.existsSync(lockFile), true, "Foreign same-pid wrong-token lock must NOT be cleaned up");

  // 清理
  try { fs.unlinkSync(lockFile); } catch (_) {}
});
