import test from "node:test";
import assert from "node:assert/strict";
import { createRealBulkDeleteHttpServer } from "./fixtures/bulk-delete-real-http.mjs";

const makeJobId = (tag) => `test-job-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const makeSessionId = (num) => `session-qa-c-${String(num).padStart(4, "0")}`;

test("session-delete-jobs HTTP: POST /jobs creates task, validates idempotency & rejects conflicts", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const jobId = makeJobId("create");
  const sessionIds = [makeSessionId(1), makeSessionId(2)];
  await fixture.addSession(sessionIds[0]);
  await fixture.addSession(sessionIds[1]);

  // 1. Valid job creation returns 202 Accepted with expected structure and headers
  const postRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId, ids: sessionIds }),
  });
  assert.equal(postRes.status, 202, `Expected status 202, got ${postRes.status}`);
  assert.equal(postRes.headers.get("Cache-Control"), "no-store");

  const created = await postRes.json();
  assert.equal(created.id, jobId);
  assert.deepEqual(created.ids, sessionIds);
  assert.equal(created.total, 2);
  assert.ok(["running", "completed"].includes(created.status));
  assert.ok(Number.isSafeInteger(created.processed));
  assert.ok(Number.isSafeInteger(created.lastSequence));

  // 2. Duplicate submission with exact same IDs is idempotent and returns 202
  const dupRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId, ids: sessionIds }),
  });
  assert.equal(dupRes.status, 202);
  const dupBody = await dupRes.json();
  assert.equal(dupBody.id, jobId);

  // 3. Duplicate submission with conflicting IDs is rejected with 409 Conflict
  const conflictRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId, ids: [makeSessionId(99)] }),
  });
  assert.equal(conflictRes.status, 409);
  const conflictBody = await conflictRes.json();
  assert.equal(conflictBody.accepted, false);
  assert.ok(conflictBody.error);
});

test("session-delete-jobs HTTP: POST /jobs validates input fields fail-closed", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  // 1. Missing or invalid request body
  const emptyRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(emptyRes.status, 400);
  const emptyBody = await emptyRes.json();
  assert.equal(emptyBody.accepted, false);

  // 2. Invalid job ID (too short or traversal)
  for (const badId of ["short-id", "../traversal-escape", "invalid spaces in id", "!@#$%^&*()_+"]) {
    const res = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: badId, ids: [makeSessionId(1)] }),
    });
    assert.equal(res.status, 400, `Bad ID '${badId}' should return 400`);
    const body = await res.json();
    assert.equal(body.accepted, false);
  }

  // 3. Invalid session IDs (empty list, traversal path, non-string)
  const validJobId = makeJobId("val");
  const badIdSets = [
    [],
    ["../escape-session"],
    ["session/with/slashes"],
    ["session\\with\\backslashes"],
    [12345],
  ];

  for (const ids of badIdSets) {
    const res = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: validJobId, ids }),
    });
    assert.equal(res.status, 400, `Invalid ids ${JSON.stringify(ids)} should return 400`);
    const body = await res.json();
    assert.equal(body.accepted, false);
  }
});

test("session-delete-jobs HTTP: GET /jobs lists active/recent jobs", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const jobId = makeJobId("list");
  const sessionIds = [makeSessionId(1)];
  await fixture.addSession(sessionIds[0]);

  await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId, ids: sessionIds }),
  });

  const listRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.headers.get("Cache-Control"), "no-store");

  const data = await listRes.json();
  assert.ok(Array.isArray(data.jobs));
  const matched = data.jobs.find((j) => j.id === jobId);
  assert.ok(matched, `Job ${jobId} should appear in GET /jobs list`);
  assert.equal(matched.total, 1);
});

test("session-delete-jobs HTTP: GET /jobs/:id returns status or 404/400", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const jobId = makeJobId("status");
  const sessionIds = [makeSessionId(10)];
  await fixture.addSession(sessionIds[0]);

  await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId, ids: sessionIds }),
  });

  // Query existing job
  const getRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs/${jobId}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get("Cache-Control"), "no-store");
  const job = await getRes.json();
  assert.equal(job.id, jobId);
  assert.deepEqual(job.ids, sessionIds);

  // Query non-existent job
  const notFoundId = makeJobId("notfound");
  const notFoundRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs/${notFoundId}`);
  assert.equal(notFoundRes.status, 404);

  // Query malformed job ID
  const malformedRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs/bad-id`);
  assert.equal(malformedRes.status, 400);
});

test("session-delete-jobs HTTP: GET /jobs/:id/events streams journal frames with cursor", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const jobId = makeJobId("events");
  const s1 = makeSessionId(21);
  const s2 = makeSessionId(22);
  await fixture.addSession(s1);
  await fixture.addSession(s2);

  await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId, ids: [s1, s2] }),
  });

  // Query events from beginning
  const eventsRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs/${jobId}/events?after=0`);
  assert.equal(eventsRes.status, 200);
  assert.equal(eventsRes.headers.get("Cache-Control"), "no-store");

  const eventsData = await eventsRes.json();
  assert.equal(eventsData.id, jobId);
  assert.ok(Array.isArray(eventsData.frames));
  assert.ok(eventsData.frames.length >= 1, "Must contain at least start frame");
  assert.equal(eventsData.frames[0].frame.type, "start");

  // Query with invalid / out of bounds cursor
  const outOfBoundsRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs/${jobId}/events?after=999999`);
  assert.equal(outOfBoundsRes.status, 409);

  const nonNumericRes = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs/${jobId}/events?after=abc`);
  assert.equal(nonNumericRes.status, 400);
});

test("session-delete-jobs HTTP: End-to-end execution poll completes with done receipt", async (t) => {
  const fixture = await createRealBulkDeleteHttpServer();
  t.after(async () => await fixture.close());

  const jobId = makeJobId("e2e");
  const s1 = makeSessionId(31);
  const s2 = makeSessionId(32);
  const p1 = await fixture.addSession(s1);
  const p2 = await fixture.addSession(s2);

  await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId, ids: [s1, s2] }),
  });

  let completedJob = null;
  let allFrames = [];
  let cursor = 0;

  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${fixture.origin}/api/sessions/batch-delete/jobs/${jobId}/events?after=${cursor}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    if (data.frames.length > 0) {
      allFrames.push(...data.frames);
      cursor = allFrames[allFrames.length - 1].seq;
    }
    if (data.status === "completed" || data.status === "stopped") {
      completedJob = data;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.ok(completedJob, "Batch delete job must finish within poll timeout");
  assert.equal(completedJob.status, "completed");
  assert.equal(completedJob.processed, 2);

  const doneFrame = allFrames.find((f) => f.frame.type === "done");
  assert.ok(doneFrame, "Event stream must contain done frame");
  assert.equal(doneFrame.frame.processed, 2);
  assert.deepEqual(doneFrame.frame.deletedSessionIds.sort(), [s1, s2].sort());

  // Physical files must be removed
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(p1), false, `${p1} must be removed`);
  assert.equal(existsSync(p2), false, `${p2} must be removed`);
});
