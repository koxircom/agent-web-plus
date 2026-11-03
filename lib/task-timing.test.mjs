import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createTaskTiming } = await jiti.import("./task-timing.ts");

test("createTaskTiming creates timing object with valid timestamp and task identifiers", () => {
  const now = Date.now();
  const timing = createTaskTiming(now, { taskId: "task-1", requestId: "req-1" });
  assert.equal(timing.taskId, "task-1");
  assert.equal(timing.requestId, "req-1");
  assert.equal(timing.startedAt <= now, true);
});

test("createTaskTiming falls back taskId to requestId if taskId omitted", () => {
  const timing = createTaskTiming(Date.now(), { requestId: "req-abc" });
  assert.equal(timing.taskId, "req-abc");
  assert.equal(timing.requestId, "req-abc");
});

test("createTaskTiming enforces strictly positive finite startedAt and rejects Infinity, NaN, zero and negative", () => {
  assert.throws(() => createTaskTiming(Infinity, { taskId: "t1" }), /positive finite/);
  assert.throws(() => createTaskTiming(-Infinity, { taskId: "t1" }), /positive finite/);
  assert.throws(() => createTaskTiming(NaN, { taskId: "t1" }), /positive finite/);
  assert.throws(() => createTaskTiming(0, { taskId: "t1" }), /positive finite/);
  assert.throws(() => createTaskTiming(-100, { taskId: "t1" }), /positive finite/);
});

test("createTaskTiming enforces valid taskId or requestId authority", () => {
  assert.throws(() => createTaskTiming(Date.now(), {}), /valid string taskId/);
  assert.throws(() => createTaskTiming(Date.now(), { taskId: "   " }), /valid string taskId/);
  assert.throws(() => createTaskTiming(Date.now(), { requestId: "  " }), /valid string taskId/);
});
