import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CollaborationStore,
} from "./collaboration-store.ts";
import {
  readCollaborationWakeCandidates,
  registerCollaborationConsumer,
  startCollaborationDispatcher,
  stopCollaborationDispatcher,
  cancelCollaborationWakeups,
  COLLABORATION_MESSAGE_CUSTOM_TYPE,
} from "./collaboration-runtime.ts";

test("readCollaborationWakeCandidates: filters by pid, resumeTask, and consumed status", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-runtime-candidates-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // 1. Session 1 acquires lock
  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["res_a"],
  });

  // 2. Session 2 queues with resumeTask
  await store.acquire({
    sessionId: "sess-2",
    sessionName: "待续做会话",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["res_a"],
    resumeTask: "继续第二阶段检查",
  });

  // 3. Session 1 releases -> handoff to Session 2
  const rel = await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  assert.ok(rel.handoff);
  assert.equal(rel.handoff.targetSessionId, "sess-2");

  // Read candidates
  const candidates = readCollaborationWakeCandidates({ stateFile });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionId, "sess-2");
  assert.equal(candidates[0].sessionName, "待续做会话");
  assert.equal(candidates[0].ownerPid, process.pid);

  // Once acked, it is in consumedHandoffIds and candidate is no longer returned
  await store.ackHandoff({
    sessionId: "sess-2",
    handoffId: rel.handoff.handoffId,
    token: rel.handoff.token,
  });

  const candidatesAfterAck = readCollaborationWakeCandidates({ stateFile });
  assert.equal(candidatesAfterAck.length, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("registerCollaborationConsumer: drains immediately when idle and acks handoff", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-runtime-consumer-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // Session 1 holds and releases to Session 2
  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["worker_res"],
  });

  await store.acquire({
    sessionId: "sess-2",
    sessionName: "唤醒目标",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["worker_res"],
    resumeTask: "继续执行收尾工作",
  });

  await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  const messagesSent = [];
  let busy = false;

  const unregister = registerCollaborationConsumer({
    sessionId: "sess-2",
    stateFile,
    isBusy: () => busy,
    sendMessage: (msg, opts) => {
      messagesSent.push({ msg, opts });
      return Promise.resolve();
    },
  });

  // Retrieve consumer and invoke drain
  const consumers = (await import("./collaboration-runtime.ts")).getCollaborationSessionConsumers(stateFile);
  const consumer = consumers.get("sess-2");
  assert.ok(consumer);

  await consumer.drain();

  // Assert message was sent with triggerTurn and followUp
  assert.equal(messagesSent.length, 1);
  assert.equal(messagesSent[0].msg.customType, COLLABORATION_MESSAGE_CUSTOM_TYPE);
  assert.match(messagesSent[0].msg.content, /继续执行收尾工作/);
  assert.deepEqual(messagesSent[0].opts, { triggerTurn: true, deliverAs: "followUp" });

  // Assert store was acked and now held
  const state = store.readState();
  assert.equal(state.resources["inst:#worker_res"]?.status, "held");
  assert.equal(state.resources["inst:#worker_res"]?.owner?.sessionId, "sess-2");

  unregister();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("registerCollaborationConsumer: delays drain while busy until onSettled", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-runtime-busy-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["worker_busy"],
  });

  await store.acquire({
    sessionId: "sess-2",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["worker_busy"],
    resumeTask: "继续下一个批次",
  });

  await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  const messagesSent = [];
  let busy = true;
  let settledListener = null;

  const unregister = registerCollaborationConsumer({
    sessionId: "sess-2",
    stateFile,
    isBusy: () => busy,
    onSettled: (fn) => {
      settledListener = fn;
      return () => {
        settledListener = null;
      };
    },
    sendMessage: (msg, opts) => {
      messagesSent.push({ msg, opts });
      return Promise.resolve();
    },
  });

  const consumers = (await import("./collaboration-runtime.ts")).getCollaborationSessionConsumers(stateFile);
  const consumer = consumers.get("sess-2");
  assert.ok(consumer);

  // Drain while busy
  consumer.drain();

  // Should NOT send message yet
  assert.equal(messagesSent.length, 0);
  assert.ok(settledListener);

  // Now session settles
  busy = false;
  await settledListener();

  // Now message should be sent
  assert.equal(messagesSent.length, 1);
  assert.match(messagesSent[0].msg.content, /继续下一个批次/);

  unregister();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("startCollaborationDispatcher & stopCollaborationDispatcher lifecycle", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-runtime-dispatcher-"));
  const stateFile = path.join(tmpDir, "locks.json");

  const dispatcher = startCollaborationDispatcher({
    stateFile,
    pollIntervalMs: 100,
  });

  assert.ok(dispatcher.isAlive());

  // Calling again returns the existing singleton
  const d2 = startCollaborationDispatcher({ stateFile });
  assert.equal(d2, dispatcher);

  cancelCollaborationWakeups("sess-test", stateFile);

  await stopCollaborationDispatcher();
  assert.equal(dispatcher.isAlive(), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: readCollaborationWakeCandidates survives process restart and maps candidate to current pid", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-runtime-restart-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // Simulate handoff created by a previous process (PID 999999)
  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: 999999,
    scope: "instance",
    resources: ["res_restart"],
  });

  await store.acquire({
    sessionId: "sess-2",
    sessionName: "跨重启任务会话",
    ownerPid: 999999,
    scope: "instance",
    resources: ["res_restart"],
    resumeTask: "重启后自动恢复任务",
  });

  await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  // Current process has process.pid !== 999999
  // In broken code, readCollaborationWakeCandidates checks h.ownerPid === pid (fails!)
  // In correct code, valid grant in store is mapped to current pid
  const candidates = readCollaborationWakeCandidates({ stateFile });
  assert.equal(candidates.length, 1, "Must not drop valid grant due to old ownerPid");
  assert.equal(candidates[0].sessionId, "sess-2");
  assert.equal(candidates[0].ownerPid, process.pid, "Must map candidate ownerPid to current process.pid");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: performDrain has inflight guard to prevent duplicate sendMessage on concurrent drains", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-runtime-inflight-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  const g1 = await store.acquire({
    sessionId: "sess-1",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["res_inflight"],
  });

  await store.acquire({
    sessionId: "sess-2",
    sessionName: "并发防重发目标",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["res_inflight"],
    resumeTask: "单flight保护任务",
  });

  await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  let sendCount = 0;
  const unregister = registerCollaborationConsumer({
    sessionId: "sess-2",
    stateFile,
    isBusy: () => false,
    sendMessage: async () => {
      sendCount++;
      await new Promise((r) => setTimeout(r, 60));
    },
  });

  const consumers = (await import("./collaboration-runtime.ts")).getCollaborationSessionConsumers(stateFile);
  const consumer = consumers.get("sess-2");
  assert.ok(consumer);

  // Trigger concurrent drains while first is inflight
  consumer.drain();
  consumer.drain();
  consumer.drain();

  await new Promise((r) => setTimeout(r, 120));

  assert.equal(sendCount, 1, "sendMessage must be invoked exactly once (in-flight singleflight guard)");

  unregister();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("REPRO RED: cancelCollaborationSessionWakeups allows subsequent new acquire to resume safely", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-runtime-recancel-"));
  const stateFile = path.join(tmpDir, "locks.json");
  const store = new CollaborationStore({ stateFile });

  // 1. Session 2 had an earlier queue that got cancelled
  await store.acquire({
    sessionId: "sess-1",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["res_recancel"],
  });

  await store.acquire({
    sessionId: "sess-2",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["res_recancel"],
    resumeTask: "旧任务",
  });

  let messageSent = false;
  const unregister = registerCollaborationConsumer({
    sessionId: "sess-2",
    stateFile,
    isBusy: () => false,
    sendMessage: () => {
      messageSent = true;
      return Promise.resolve();
    },
  });

  // Cancel sess-2
  cancelCollaborationWakeups("sess-2", stateFile);

  // 2. Now sess-2 submits a NEW acquire for new task
  await store.acquire({
    sessionId: "sess-2",
    ownerPid: process.pid,
    scope: "instance",
    resources: ["res_recancel"],
    resumeTask: "新任务应该能被唤醒",
  });

  // Release sess-1 -> handoffs to sess-2
  const g1 = store.readState().resources["inst:#res_recancel"]?.owner;
  assert.ok(g1);
  await store.release({
    sessionId: "sess-1",
    token: g1.token,
    generation: g1.generation,
  });

  const consumers = (await import("./collaboration-runtime.ts")).getCollaborationSessionConsumers(stateFile);
  const consumer = consumers.get("sess-2");
  assert.ok(consumer);

  // In broken code, consumer remains permanently cancelled, so drain() does nothing!
  consumer.drain();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(messageSent, true, "New acquire must be able to drain even after prior cancellation");

  unregister();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
