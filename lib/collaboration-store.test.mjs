import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CollaborationStore,
  normalizeResourceKey,
  parseResourceKey,
} from "./collaboration-store.ts";

test("normalizeResourceKey & parseResourceKey: strict scopes and directory traversal protection", () => {
  const cwd = "/workspace/project-a";
  const projKey = normalizeResourceKey("src_addon", "project", cwd);
  assert.equal(projKey, "proj:/workspace/project-a#src_addon");

  const parsedProj = parseResourceKey(projKey);
  assert.equal(parsedProj.scope, "project");
  assert.equal(parsedProj.cwd, "/workspace/project-a");
  assert.equal(parsedProj.label, "src_addon");

  const instKey = normalizeResourceKey("gpu_device_0", "instance");
  assert.equal(instKey, "inst:#gpu_device_0");

  const parsedInst = parseResourceKey(instKey);
  assert.equal(parsedInst.scope, "instance");
  assert.equal(parsedInst.label, "gpu_device_0");

  // Rejections
  assert.throws(() => normalizeResourceKey("../bad", "project", cwd), /路径穿越/);
  assert.throws(() => normalizeResourceKey(":bad", "project", cwd), /非法前缀/);
  assert.throws(() => normalizeResourceKey(".bad", "project", cwd), /非法前缀/);
  assert.throws(() => normalizeResourceKey("", "project", cwd), /长度必须在/);
  assert.throws(() => normalizeResourceKey("a".repeat(65), "project", cwd), /长度必须在/);
  assert.throws(() => normalizeResourceKey("hello", "project", undefined), /有效的工作目录/);
});

test("CollaborationStore: fail-closed on corrupt store state", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-corrupt-"));
  const stateFile = path.join(tmpDir, "locks.json");
  fs.writeFileSync(stateFile, "{ broken json content");

  const store = new CollaborationStore({ stateFile });
  assert.throws(() => store.readState(), /fail-closed/);

  // Even acquire must fail closed and not overwrite broken state
  assert.rejects(
    () =>
      store.acquire({
        sessionId: "sess-1",
        ownerPid: process.pid,
        resources: ["res1"],
        scope: "instance",
      }),
    /fail-closed/,
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CollaborationStore: atomic grant, idempotent re-acquire, and strict release tokens", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-grant-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // 1. Initial acquire of 2 resources
  const res1 = await store.acquire({
    sessionId: "sess-1",
    sessionName: "任务会话 A",
    ownerPid: 1001,
    scope: "instance",
    resources: ["lock_source", "lock_test"],
  });

  assert.equal(res1.status, "acquired");
  assert.ok(res1.token);
  assert.equal(res1.generation, 2);
  assert.deepEqual(res1.resources, ["inst:#lock_source", "inst:#lock_test"]);

  // 2. Idempotent acquire by same session returns same token & generation
  const resIdempotent = await store.acquire({
    sessionId: "sess-1",
    ownerPid: 1001,
    scope: "instance",
    resources: ["lock_source", "lock_test"],
  });
  assert.equal(resIdempotent.status, "acquired");
  assert.equal(resIdempotent.token, res1.token);
  assert.equal(resIdempotent.generation, res1.generation);

  // 3. Release with invalid token is rejected
  await assert.rejects(
    () =>
      store.release({
        sessionId: "sess-1",
        token: "wrong-token",
        generation: res1.generation,
      }),
    /token\/generation mismatch/,
  );

  // 4. Release with stale generation is rejected
  await assert.rejects(
    () =>
      store.release({
        sessionId: "sess-1",
        token: res1.token,
        generation: 9999,
      }),
    /token\/generation mismatch/,
  );

  // 5. Successful release
  const rel = await store.release({
    sessionId: "sess-1",
    token: res1.token,
    generation: res1.generation,
  });
  assert.equal(rel.status, "released");
  assert.equal(rel.freedResources.length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CollaborationStore: hold-and-wait deadlock prevention", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-deadlock-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // Session 1 holds Resource A
  await store.acquire({
    sessionId: "sess-1",
    ownerPid: 1001,
    scope: "instance",
    resources: ["res_a"],
  });

  // Session 2 holds Resource B
  await store.acquire({
    sessionId: "sess-2",
    ownerPid: 1002,
    scope: "instance",
    resources: ["res_b"],
  });

  // Session 1 tries to acquire Resource B (currently held by Session 2).
  // Because Session 1 already holds Resource A and would have to wait,
  // hold-and-wait is strictly refused!
  await assert.rejects(
    () =>
      store.acquire({
        sessionId: "sess-1",
        ownerPid: 1001,
        scope: "instance",
        resources: ["res_b"],
      }),
    /拒绝保持并等待\(hold-and-wait\)/,
  );

  // Check that Session 1 still safely holds Resource A
  const state = store.readState();
  assert.equal(state.resources["inst:#res_a"]?.status, "held");
  assert.equal(state.resources["inst:#res_a"]?.owner?.sessionId, "sess-1");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CollaborationStore: FIFO queuing, handoff scheduling, and consumer ack", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-fifo-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // 1. Session 1 acquires lock
  const g1 = await store.acquire({
    sessionId: "sess-1",
    sessionName: "第一任务",
    ownerPid: 101,
    scope: "instance",
    resources: ["deploy_lock"],
  });
  assert.equal(g1.status, "acquired");

  // 2. Session 2 queues for deploy_lock with resumeTask
  const q2 = await store.acquire({
    sessionId: "sess-2",
    sessionName: "第二任务",
    ownerPid: 102,
    scope: "instance",
    resources: ["deploy_lock"],
    resumeTask: "部署完成后执行阶段验收",
  });
  assert.equal(q2.status, "queued");
  assert.equal(q2.position, 1);

  // 3. Session 3 queues for deploy_lock
  const q3 = await store.acquire({
    sessionId: "sess-3",
    sessionName: "第三任务",
    ownerPid: 103,
    scope: "instance",
    resources: ["deploy_lock"],
  });
  assert.equal(q3.status, "queued");
  assert.equal(q3.position, 2);

  // 4. Session 1 releases deploy_lock
  const rel1 = await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  assert.equal(rel1.status, "released");
  assert.ok(rel1.handoff);
  assert.equal(rel1.handoff.targetSessionId, "sess-2");
  assert.equal(rel1.handoff.resumeTask, "部署完成后执行阶段验收");
  assert.ok(rel1.handoff.token);

  // Check state: deploy_lock is in "handoff" state
  let state = store.readState();
  assert.equal(state.resources["inst:#deploy_lock"]?.status, "handoff");
  assert.equal(state.resources["inst:#deploy_lock"]?.handoff?.targetSessionId, "sess-2");

  // 5. Session 2 acks handoff
  const acked = await store.ackHandoff({
    sessionId: "sess-2",
    handoffId: rel1.handoff.handoffId,
    token: rel1.handoff.token,
  });
  assert.equal(acked, true);

  state = store.readState();
  assert.equal(state.resources["inst:#deploy_lock"]?.status, "held");
  assert.equal(state.resources["inst:#deploy_lock"]?.owner?.sessionId, "sess-2");
  assert.ok(state.consumedHandoffIds.includes(rel1.handoff.handoffId));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CollaborationStore: queue cancellation and handoff rescheduling", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-cancel-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: 101,
    scope: "instance",
    resources: ["shared_res"],
  });

  const q2 = await store.acquire({
    sessionId: "sess-2",
    ownerPid: 102,
    scope: "instance",
    resources: ["shared_res"],
  });

  const q3 = await store.acquire({
    sessionId: "sess-3",
    ownerPid: 103,
    scope: "instance",
    resources: ["shared_res"],
  });

  // Cancel sess-2
  const c2 = await store.cancel({ sessionId: "sess-2" });
  assert.equal(c2.cancelledCount, 1);

  // Release sess-1: should handoff directly to sess-3
  const rel1 = await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });
  assert.ok(rel1.handoff);
  assert.equal(rel1.handoff.targetSessionId, "sess-3");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CollaborationStore: getPublicStatus UI contract masking", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-public-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  await store.acquire({
    sessionId: "sess-secret-1234",
    sessionName: "Odoo 升级与测试",
    ownerPid: 101,
    scope: "project",
    cwd: "/workspace/odoo",
    resources: ["addon_pos"],
  });

  await store.acquire({
    sessionId: "sess-waiter-5678",
    ownerPid: 102,
    scope: "project",
    cwd: "/workspace/odoo",
    resources: ["addon_pos"],
    reason: "等待前序测试完成",
    resumeTask: "继续执行报表验证",
  });

  const status = store.getPublicStatus("Pi Web Plus (30141)");
  assert.equal(status.instanceLabel, "Pi Web Plus (30141)");
  assert.equal(status.capabilities.piAutoResume, true);
  assert.equal(status.capabilities.codexAutoResume, false);
  assert.equal(status.capabilities.scope, "instance");
  assert.equal(status.capabilities.enforcement, "cooperative");

  assert.equal(status.resources.length, 1);
  const r = status.resources[0];
  assert.equal(r.label, "addon_pos");
  assert.equal(r.status, "held");
  assert.equal(r.owner.title, "Odoo 升级与测试");
  // Ensure no internal token or sessionId is leaked
  assert.equal(r.owner.token, undefined);
  assert.equal(r.owner.sessionId, undefined);

  assert.equal(r.queue.length, 1);
  const q = r.queue[0];
  assert.equal(q.title, "未命名会话（标题尚未生成）"); // fallback because sessionName was undefined
  assert.equal(q.reason, "等待前序测试完成");
  assert.equal(q.resumeTask, "继续执行报表验证");
  assert.equal(q.sessionId, undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: ackHandoff preserves generation so target session can release with received token & generation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-ackgen-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: 101,
    scope: "instance",
    resources: ["res_gen_test"],
  });

  await store.acquire({
    sessionId: "sess-2",
    ownerPid: 102,
    scope: "instance",
    resources: ["res_gen_test"],
    resumeTask: "继续任务",
  });

  const rel = await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  const handoff = rel.handoff;
  assert.ok(handoff);
  const receivedToken = handoff.token;
  const receivedGeneration = handoff.generation;

  const ackOk = await store.ackHandoff({
    sessionId: "sess-2",
    handoffId: handoff.handoffId,
    token: receivedToken,
  });
  assert.equal(ackOk, true);

  // In broken code, ackHandoff bumped generation, so receivedGeneration will fail with mismatch
  const rel2 = await store.release({
    sessionId: "sess-2",
    token: receivedToken,
    generation: receivedGeneration,
  });
  assert.equal(rel2.status, "released");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: FIFO intersecting requests cannot barge in, non-intersecting can grant in parallel", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-fifo-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // sess-0 holds R1, sess-hold holds R9
  const g0 = await store.acquire({
    sessionId: "sess-0",
    ownerPid: 100,
    scope: "instance",
    resources: ["R1"],
  });
  const gHold = await store.acquire({
    sessionId: "sess-hold",
    ownerPid: 105,
    scope: "instance",
    resources: ["R9"],
  });

  // sess-2 (EARLIER) queues for [R1, R2]
  await store.acquire({
    sessionId: "sess-2",
    ownerPid: 102,
    scope: "instance",
    resources: ["R1", "R2"],
  });

  // sess-3 (LATER) queues for [R2, R9] (intersects with sess-2 on R2!)
  await store.acquire({
    sessionId: "sess-3",
    ownerPid: 103,
    scope: "instance",
    resources: ["R2", "R9"],
  });

  // sess-4 (DISJOINT) queues for [R4] (completely disjoint)
  await store.acquire({
    sessionId: "sess-4",
    ownerPid: 104,
    scope: "instance",
    resources: ["R4"],
  });

  // Now sess-hold releases R9!
  // In broken code: scheduleNextQueueEntry skips sess-2 (because R1 is busy) and grants [R2, R9] to sess-3!
  // In correct code: sess-3 MUST NOT be granted because earlier sess-2 is waiting on intersecting R2!
  // Meanwhile, disjoint sess-4 [R4] SHOULD be granted!
  const relHold = await store.release({
    sessionId: "sess-hold",
    token: gHold.token,
    generation: gHold.generation,
  });

  // Check state: sess-3 must NOT be handoff!
  const stateAfterRelease = store.readState();
  assert.notEqual(
    stateAfterRelease.resources["inst:#R2"]?.status,
    "handoff",
    "sess-3 must NOT jump the queue to take intersecting R2 while sess-2 is waiting",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: cancelling queue head immediately reschedules blocked intersecting waiter", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-cancelhead-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // sess-0 holds R1
  await store.acquire({
    sessionId: "sess-0",
    ownerPid: 100,
    scope: "instance",
    resources: ["R1"],
  });

  // sess-2 queues for [R1, R2] (head of queue)
  const q2 = await store.acquire({
    sessionId: "sess-2",
    ownerPid: 102,
    scope: "instance",
    resources: ["R1", "R2"],
  });

  // sess-3 queues for [R2] (blocked because intersecting with head sess-2)
  await store.acquire({
    sessionId: "sess-3",
    ownerPid: 103,
    scope: "instance",
    resources: ["R2"],
  });

  // Cancel sess-2 (the head)
  const cancelRes = await store.cancel({ sessionId: "sess-2", queueId: q2.queueId });
  assert.equal(cancelRes.cancelledCount, 1);

  // In broken code, cancel does NOT reschedule if it wasn't a handoff!
  // In correct code, cancelling queue head MUST reschedule and grant R2 to sess-3!
  assert.ok(cancelRes.rescheduledHandoff, "Cancelling queue head must reschedule blocked waiter");
  assert.equal(cancelRes.rescheduledHandoff?.targetSessionId, "sess-3");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: normalizeResourceKey canonicalizes cwd eliminating symlink aliases", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-symlink-"));
  const realDir = path.join(tmpDir, "real_project");
  const symlinkDir = path.join(tmpDir, "symlink_project");
  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, symlinkDir, "dir");

  const keyReal = normalizeResourceKey("mod_pos", "project", realDir);
  const keySym = normalizeResourceKey("mod_pos", "project", symlinkDir);

  assert.equal(keySym, keyReal, "Symlink project cwd must produce identical canonical key as realpath");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: partial held group expansion and partial release are strictly rejected", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-partial-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: 101,
    scope: "instance",
    resources: ["res_a", "res_b"],
  });

  // Attempt partial release (passing only one resource)
  await assert.rejects(
    () =>
      store.release({
        sessionId: "sess-1",
        token: g1.token,
        generation: g1.generation,
        resources: ["res_a"], // only one of two!
      }),
    /与获授资源组不一致|严禁部分释放/,
  );

  // Attempt expanding held lock
  await assert.rejects(
    () =>
      store.acquire({
        sessionId: "sess-1",
        ownerPid: 101,
        scope: "instance",
        resources: ["res_a", "res_b", "res_c"],
      }),
    /拒绝保持并等待|严禁扩组/,
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CollaborationStore: strict schema validation, 2MiB size limit, and corrupt status rejection", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-store-schema-"));

  // 1. Over 2MiB file size
  const bigFile = path.join(tmpDir, "big_locks.json");
  const bigBuffer = Buffer.alloc(2 * 1024 * 1024 + 10, " ");
  fs.writeFileSync(bigFile, bigBuffer);
  const storeBig = new CollaborationStore({ stateFile: bigFile });
  assert.throws(() => storeBig.readState(), /超过2MiB上限/);

  // 2. Corrupt resources as array instead of object
  const badArrFile = path.join(tmpDir, "bad_arr.json");
  fs.writeFileSync(
    badArrFile,
    JSON.stringify({
      version: 1,
      generation: 1,
      resources: [],
      consumedHandoffIds: [],
      updatedAt: new Date().toISOString(),
    }),
  );
  const storeArr = new CollaborationStore({ stateFile: badArrFile });
  assert.throws(() => storeArr.readState(), /fail-closed/);

  // 3. Bad resource status undefined but owner attached
  const badStatusFile = path.join(tmpDir, "bad_status.json");
  fs.writeFileSync(
    badStatusFile,
    JSON.stringify({
      version: 1,
      generation: 1,
      resources: {
        "inst:#bad_res": {
          key: "inst:#bad_res",
          label: "bad_res",
          scope: "instance",
          queue: [],
          owner: { sessionId: "bad", token: "tok", generation: 1, acquiredAt: "", ownerPid: 1 },
        },
      },
      consumedHandoffIds: [],
      updatedAt: new Date().toISOString(),
    }),
  );
  const storeStatus = new CollaborationStore({ stateFile: badStatusFile });
  assert.throws(() => storeStatus.readState(), /fail-closed/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
