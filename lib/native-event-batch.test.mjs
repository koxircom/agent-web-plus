import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const {
  PROCESS_EPOCH,
  SessionEventRingBuffer,
  handleAgentEventBatchRequest,
  getOrCreateSessionEventHub,
  closeAllSessionEventHubs,
} = await jiti.import("./native-event-batch.ts");

const { BatchEventSource, createAgentEventBatchSource } = await jiti.import(
  "./native-event-batch-client.ts"
);

const { createTerminal, writeTerminal, killTerminal } = await jiti.import("./terminal-manager.ts");
const terminalEventsRoute = await jiti.import("../app/api/terminal/[id]/events/route.ts");

test("RingBuffer bounds entries and drops oldest on item and byte limits", () => {
  const ring = new SessionEventRingBuffer(3, 1000);
  assert.equal(ring.oldestSeq, 0);
  assert.equal(ring.latestSeq, 0);

  const seq1 = ring.push({ type: "msg1" });
  assert.equal(seq1, 1);
  assert.equal(ring.oldestSeq, 0);
  assert.equal(ring.latestSeq, 1);

  const seq2 = ring.push({ type: "msg2" });
  const seq3 = ring.push({ type: "msg3" });
  assert.equal(seq3, 3);
  assert.equal(ring.oldestSeq, 0);

  // Push 4th: should shift out seq1
  const seq4 = ring.push({ type: "msg4" });
  assert.equal(seq4, 4);
  assert.equal(ring.oldestSeq, 2);
  assert.equal(ring.latestSeq, 4);

  const events = ring.getEventsAfter(2);
  assert.deepEqual(events, [{ type: "msg3" }, { type: "msg4" }]);
});

test("RingBuffer counts UTF-8 bytes and drops a single oversized event", () => {
  const event = { type: "output", data: "😀" };
  const serialized = JSON.stringify(event);
  const byteLimit = Buffer.byteLength(serialized, "utf8") - 1;
  assert.ok(serialized.length < Buffer.byteLength(serialized, "utf8"));

  const ring = new SessionEventRingBuffer(5, byteLimit);
  const seq = ring.push(event);
  assert.equal(ring.latestSeq, seq);
  assert.equal(ring.oldestSeq, seq + 1);
  assert.deepEqual(ring.getEventsAfter(0), []);
});

test("RingBuffer keeps the JSON snapshot used for byte accounting", () => {
  const event = { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "short" }] } };
  const serialized = JSON.stringify(event);
  const ring = new SessionEventRingBuffer(2, Buffer.byteLength(serialized, "utf8"));
  ring.push(event);

  event.message.content[0].text += "x".repeat(5000);
  const buffered = ring.getEventsAfter(0)[0];
  assert.equal(JSON.stringify(buffered), serialized);
  assert.ok(Buffer.byteLength(JSON.stringify(buffered), "utf8") <= ring.maxBytes);
});

test("native batch snapshot and replay preserves end states without dropping events", async () => {
  const sessionId = "test-session-replay-" + Math.random().toString(36).slice(2, 7);
  let listener = null;
  const snapshotMsg = { role: "assistant", content: [{ type: "text", text: "Working..." }] };

  const fakeSession = {
    isStreaming: true,
    streamingMessage: snapshotMsg,
    isAlive: () => true,
    onEvent(l) {
      listener = l;
      return () => { listener = null; };
    },
  };

  // 1. First connection without cursor -> fresh snapshot
  const req1 = new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`);
  const res1 = await handleAgentEventBatchRequest(req1, sessionId, async () => fakeSession);
  assert.equal(res1.status, 200);
  assert.equal(res1.headers.get("Content-Type"), "application/json");

  const data1 = await res1.json();
  assert.equal(data1.reset, false);
  assert.ok(data1.epoch.startsWith(PROCESS_EPOCH + "."));
  assert.ok(data1.cursor.startsWith(data1.epoch + ":"));
  assert.ok(data1.events.some((e) => e.type === "connected" && e.sessionId === sessionId));
  assert.ok(data1.events.some((e) => e.type === "message_start" && e.message && e.message.role === "assistant"));

  // 2. Emit new events into hub: message_update and agent_end
  assert.ok(listener !== null, "Session event listener must be registered");
  listener({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: " Done!" },
  });
  listener({
    type: "agent_end",
  });

  // 3. Second request with cursor -> returns incremental delta and terminal agent_end
  const req2 = new Request(`http://localhost/api/agent/${sessionId}/events?format=batch&cursor=${encodeURIComponent(data1.cursor)}`);
  const res2 = await handleAgentEventBatchRequest(req2, sessionId, async () => fakeSession);
  const data2 = await res2.json();
  assert.equal(data2.reset, false);
  assert.equal(data2.events.length, 2);
  assert.equal(data2.events[0].type, "message_update");
  assert.equal(data2.events[1].type, "agent_end");
});

test("a later first connection receives a fresh session snapshot", async () => {
  const sessionId = "test-session-fresh-snapshot-" + Math.random().toString(36).slice(2, 7);
  let snapshotMessage = { role: "assistant", content: [{ type: "text", text: "first" }] };
  const fakeSession = {
    isStreaming: true,
    streamingMessage: snapshotMessage,
    queuedMessages: { steering: ["old queued prompt"], followUp: [] },
    isAlive: () => true,
    onEvent: () => () => {},
  };

  const first = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`),
    sessionId,
    async () => fakeSession,
  );
  const firstPayload = await first.json();
  assert.ok(firstPayload.events.some((event) => event.type === "message_start" && event.message?.content?.[0]?.text === "first"));
  assert.ok(firstPayload.events.some((event) => event.type === "queue_update" && event.steering[0] === "old queued prompt"));

  snapshotMessage = { role: "assistant", content: [{ type: "text", text: "current" }] };
  fakeSession.isStreaming = false;
  fakeSession.streamingMessage = snapshotMessage;
  fakeSession.queuedMessages = { steering: [], followUp: [] };
  const second = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`),
    sessionId,
    async () => fakeSession,
  );
  const secondPayload = await second.json();
  assert.ok(secondPayload.events.some((event) => event.type === "connected" && event.isStreaming === false));
  assert.ok(secondPayload.events.some((event) => event.type === "message_start" && event.message?.content?.[0]?.text === "current"));
  assert.deepEqual(secondPayload.events.find((event) => event.type === "queue_update"), { type: "queue_update", steering: [], followUp: [] });
});

test("one client's reset does not filter another client's live message update", async () => {
  const sessionId = "test-session-client-reset-" + Math.random().toString(36).slice(2, 7);
  let listener = null;
  const firstMessage = { role: "assistant", content: [{ type: "text", text: "snapshot" }] };
  const fakeSession = {
    isStreaming: true,
    streamingMessage: firstMessage,
    isAlive: () => true,
    onEvent: (next) => { listener = next; return () => {}; },
  };
  const initialResponse = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`),
    sessionId,
    async () => fakeSession,
  );
  const initial = await initialResponse.json();

  fakeSession.streamingMessage = { role: "assistant", content: [{ type: "text", text: "new snapshot" }] };
  const resetResponse = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch&cursor=stale:0`),
    sessionId,
    async () => fakeSession,
  );
  assert.equal((await resetResponse.json()).reset, true);

  const updatedMessage = fakeSession.streamingMessage;
  listener({ type: "message_update", message: updatedMessage, assistantMessageEvent: { type: "text_delta", delta: "!" } });
  const secondClientResponse = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch&cursor=${encodeURIComponent(initial.cursor)}`),
    sessionId,
    async () => fakeSession,
  );
  const secondClient = await secondClientResponse.json();
  assert.equal(secondClient.reset, false);
  assert.ok(secondClient.events.some((event) => event.type === "message_update"));
});

test("a cursor from a destroyed hub resets after the same session hub is recreated", async () => {
  const sessionId = "test-session-hub-generation-" + Math.random().toString(36).slice(2, 7);
  let oldListener = null;
  const session = (onEvent) => ({
    isStreaming: false,
    isAlive: () => true,
    onEvent: (listener) => { onEvent(listener); return () => {}; },
  });
  const oldHub = getOrCreateSessionEventHub(sessionId, async () => session((listener) => { oldListener = listener; }));
  await oldHub.readyPromise;
  oldListener({ type: "agent_start" });
  oldListener({ type: "agent_end" });
  const staleCursor = oldHub.currentCursor();
  oldHub.destroy();

  let newListener = null;
  const newHub = getOrCreateSessionEventHub(sessionId, async () => session((listener) => { newListener = listener; }));
  await newHub.readyPromise;
  newListener({ type: "agent_start" });
  newListener({ type: "agent_end" });
  const response = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch&cursor=${encodeURIComponent(staleCursor)}`),
    sessionId,
    async () => session(() => {}),
  );
  const payload = await response.json();
  assert.equal(payload.reset, true);
  assert.notEqual(payload.epoch, staleCursor.slice(0, staleCursor.lastIndexOf(":")));
  newHub.destroy();
});

test("destroying a hub settles a waiting batch request", async () => {
  const sessionId = "test-session-destroy-pending-" + Math.random().toString(36).slice(2, 7);
  let resolveSession;
  const pendingSession = new Promise((resolve) => { resolveSession = resolve; });
  const hub = getOrCreateSessionEventHub(sessionId, () => pendingSession);
  const request = handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`),
    sessionId,
    () => pendingSession,
  );

  hub.destroy();
  const response = await request;
  assert.equal(response.status, 204);
  resolveSession({ isAlive: () => true, onEvent: () => () => {} });
});

test("an oversized event makes an older cursor explicitly reset", async () => {
  const sessionId = "test-session-oversized-event-" + Math.random().toString(36).slice(2, 7);
  let listener = null;
  const fakeSession = { isStreaming: false, isAlive: () => true, onEvent: (next) => { listener = next; return () => {}; } };
  const initialResponse = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`),
    sessionId,
    async () => fakeSession,
  );
  const initial = await initialResponse.json();
  listener({ type: "agent_start", padding: "x".repeat(4 * 1024 * 1024) });

  const response = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sessionId}/events?format=batch&cursor=${encodeURIComponent(initial.cursor)}`),
    sessionId,
    async () => fakeSession,
  );
  const payload = await response.json();
  assert.equal(payload.reset, true);
  assert.ok(payload.events.some((event) => event.type === "connected"));
});

test("overflow, wrong epoch, or invalid cursor triggers explicit reset with fresh snapshot", async () => {
  const sessionId = "test-session-reset-" + Math.random().toString(36).slice(2, 7);
  const fakeSession = {
    isStreaming: false,
    streamingMessage: undefined,
    isAlive: () => true,
    onEvent: () => () => {},
  };

  // 1. Bad epoch -> reset: true
  const reqBadEpoch = new Request(`http://localhost/api/agent/${sessionId}/events?format=batch&cursor=oldEpoch:1`);
  const resBadEpoch = await handleAgentEventBatchRequest(reqBadEpoch, sessionId, async () => fakeSession);
  const dataBadEpoch = await resBadEpoch.json();
  assert.equal(dataBadEpoch.reset, true);
  assert.ok(dataBadEpoch.epoch.startsWith(PROCESS_EPOCH + "."));
  assert.ok(dataBadEpoch.events.some((e) => e.type === "connected"));

  // 2. Future seq -> reset: true
  const reqFuture = new Request(`http://localhost/api/agent/${sessionId}/events?format=batch&cursor=${dataBadEpoch.epoch}:99999`);
  const resFuture = await handleAgentEventBatchRequest(reqFuture, sessionId, async () => fakeSession);
  const dataFuture = await resFuture.json();
  assert.equal(dataFuture.reset, true);
  assert.ok(dataFuture.events.some((e) => e.type === "connected"));
});

test("request signal abort does not destroy shared session hub", async () => {
  const sessionId = "test-session-abort-" + Math.random().toString(36).slice(2, 7);
  let unsubscribed = false;
  const fakeSession = {
    isStreaming: false,
    streamingMessage: undefined,
    isAlive: () => true,
    onEvent: () => () => { unsubscribed = true; },
  };

  const abortController = new AbortController();
  const req = new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`, {
    signal: abortController.signal,
  });

  abortController.abort();
  const res = await handleAgentEventBatchRequest(req, sessionId, async () => fakeSession);
  assert.equal(res.status, 204);
  assert.equal(unsubscribed, false, "Hub must not be destroyed when request aborts");

  // Subsequent request with healthy signal continues to work
  const reqHealthy = new Request(`http://localhost/api/agent/${sessionId}/events?format=batch`);
  const resHealthy = await handleAgentEventBatchRequest(reqHealthy, sessionId, async () => fakeSession);
  assert.equal(resHealthy.status, 200);
  const data = await resHealthy.json();
  assert.equal(data.reset, false);
});

test("sessions are strictly isolated across multiple IDs", async () => {
  const sidA = "session-iso-A-" + Math.random().toString(36).slice(2, 7);
  const sidB = "session-iso-B-" + Math.random().toString(36).slice(2, 7);

  let listenerA = null;
  let listenerB = null;

  const sessionA = {
    isStreaming: false,
    streamingMessage: undefined,
    isAlive: () => true,
    onEvent: (l) => { listenerA = l; return () => {}; },
  };
  const sessionB = {
    isStreaming: false,
    streamingMessage: undefined,
    isAlive: () => true,
    onEvent: (l) => { listenerB = l; return () => {}; },
  };

  const resA1 = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sidA}/events?format=batch`),
    sidA,
    async () => sessionA
  );
  const dataA1 = await resA1.json();

  const resB1 = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sidB}/events?format=batch`),
    sidB,
    async () => sessionB
  );
  const dataB1 = await resB1.json();

  assert.notEqual(dataA1.events[0].sessionId, dataB1.events[0].sessionId);

  // Emit event in A only
  listenerA({ type: "agent_start" });

  const resA2 = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sidA}/events?format=batch&cursor=${encodeURIComponent(dataA1.cursor)}`),
    sidA,
    async () => sessionA
  );
  const dataA2 = await resA2.json();
  assert.equal(dataA2.reset, false);
  assert.equal(dataA2.events.length, 1);
  assert.equal(dataA2.events[0].type, "agent_start");

  // B must receive nothing
  const resB2 = await handleAgentEventBatchRequest(
    new Request(`http://localhost/api/agent/${sidB}/events?format=batch&cursor=${encodeURIComponent(dataB1.cursor)}`),
    sidB,
    async () => sessionB
  );
  const dataB2 = await resB2.json();
  assert.equal(dataB2.reset, false);
  assert.equal(dataB2.events.length, 0);
});

test("BatchEventSource client factory satisfies AgentEventSourceLike and closes cleanly", async () => {
  const source = createAgentEventBatchSource("session-client-test");
  assert.equal(typeof source.readyState, "number");
  assert.equal(typeof source.close, "function");
  assert.equal(source.onmessage, null);
  assert.equal(source.onerror, null);

  source.close();
  assert.equal(source.readyState, 2); // CLOSED
});

test("batch client validates payload before advancing its cursor and clears queue state on reset", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    reset: false,
    epoch: "other-epoch",
    cursor: "mismatched-epoch:9",
    events: [],
  }));
  const source = new BatchEventSource("session-client-validation", 100, 100, 100);
  clearTimeout(source.timer);
  source.timer = null;
  source.cursor = "old-epoch:4";
  source.epoch = "old-epoch";
  await source.poll();
  assert.equal(source.cursor, "old-epoch:4");
  assert.equal(fetch.mock.callCount(), 1);

  fetch.mock.mockImplementation(async () => Response.json({
    reset: false,
    epoch: "old-epoch",
    cursor: "old-epoch:5",
    events: [{ type: " " }],
  }));
  await source.poll();
  assert.equal(source.cursor, "old-epoch:4", "an invalid event type cannot advance the cursor");
  assert.equal(fetch.mock.callCount(), 2);
  source.close();

  fetch.mock.mockImplementation(async () => Response.json({
    reset: true,
    epoch: "new-epoch",
    cursor: "new-epoch:0",
    events: [{ type: "connected", isStreaming: false }],
  }));
  const resetSource = new BatchEventSource("session-client-reset", 100, 100, 100);
  clearTimeout(resetSource.timer);
  resetSource.timer = null;
  resetSource.cursor = "old-epoch:4";
  resetSource.epoch = "old-epoch";
  resetSource.hasPendingQueue = true;
  const delivered = [];
  resetSource.onmessage = (event) => delivered.push(JSON.parse(event.data));
  await resetSource.poll();
  assert.equal(resetSource.hasPendingQueue, false);
  assert.ok(delivered.some((event) => event.type === "queue_update" && event.steering.length === 0 && event.followUp.length === 0));
  resetSource.close();
});

test("batch request timeout aborts the request and allows a retry", async (t) => {
  let calls = 0;
  let errors = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const source = new BatchEventSource("session-client-timeout", 1, 5, 5);
  source.onerror = () => { errors++; };
  await new Promise((resolve) => setTimeout(resolve, 30));
  source.close();
  const stoppedAt = calls;
  const errorsAtClose = errors;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(stoppedAt >= 2, "the timed-out poll is retried");
  assert.equal(calls, stoppedAt, "close prevents additional retries");
  assert.equal(errors, errorsAtClose, "close prevents late error callbacks");
  assert.ok(fetch.mock.callCount() >= 2);
});

test("terminal batch events return instant JSON without permanent listeners and survive reconnect", async () => {
  let termId;
  try {
    termId = createTerminal(process.cwd(), 80, 24);
  } catch {
    // If node-pty is unavailable in unit environment, skip gracefully
    return;
  }

  try {
    // 1. Initial short-batch request
    const req1 = new Request(`http://localhost/api/terminal/${termId}/events?format=batch`);
    const res1 = await terminalEventsRoute.GET(req1, { params: Promise.resolve({ id: termId }) });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("Content-Type"), "application/json");

    const data1 = await res1.json();
    assert.ok(data1.output);
    assert.equal(data1.output.type, "output");
    assert.equal(typeof data1.output.offset, "number");
    assert.equal(data1.exited, false);

    // 2. Incremental polling after offset
    const currentOffset = data1.output.offset;
    writeTerminal(termId, "echo batch-test\n");

    // Wait 50ms for PTY echo
    await new Promise((r) => setTimeout(r, 50));

    const req2 = new Request(`http://localhost/api/terminal/${termId}/events?format=batch&after=${currentOffset}`);
    const res2 = await terminalEventsRoute.GET(req2, { params: Promise.resolve({ id: termId }) });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.ok(data2.output);
    assert.ok(data2.output.offset >= currentOffset);

    // 3. Exit shell and poll exit
    writeTerminal(termId, "exit\n");
    await new Promise((r) => setTimeout(r, 80));

    const req3 = new Request(`http://localhost/api/terminal/${termId}/events?format=batch&after=${data2.output.offset}`);
    const res3 = await terminalEventsRoute.GET(req3, { params: Promise.resolve({ id: termId }) });
    const data3 = await res3.json();
    assert.equal(data3.exited, true);
  } finally {
    try { killTerminal(termId); } catch {}
  }
});

test("cleanup closes all session event hubs", () => {
  closeAllSessionEventHubs();
});


test("first and reset batch snapshots retain and replay live pending interaction identities", async()=>{
 const sessionId="pending-ui-reconnect-"+Math.random();
 let pending=[{type:"extension_ui_request",id:"question-1",method:"input",title:"Which task?"},{type:"extension_ui_request",id:"question-2",method:"select",title:"Where?"}];
 const session={isStreaming:false,streamingMessage:null,isAlive:()=>true,
  getPendingExtensionUiRequests:()=>pending,
  onEvent(listener){for(const event of pending)listener(event);return()=>{};}};
 const read=async cursor=>{const response=await handleAgentEventBatchRequest(new Request("http://localhost/api/agent/"+sessionId+"/events?format=batch"+(cursor?"&cursor="+encodeURIComponent(cursor):"")),sessionId,async()=>session);return response.json()};
 const first=await read();
 assert.deepEqual(first.events.find(e=>e.type==="connected").pendingExtensionUiIds,["question-1","question-2"]);
 assert.deepEqual(first.events.filter(e=>e.type==="extension_ui_request").map(e=>e.id),["question-1","question-2"]);
 pending=[pending[1]];
 const reset=await read("old-epoch:0");
 assert.equal(reset.reset,true);
 assert.deepEqual(reset.events.find(e=>e.type==="connected").pendingExtensionUiIds,["question-2"]);
 assert.deepEqual(reset.events.filter(e=>e.type==="extension_ui_request").map(e=>e.id),["question-2"]);
 pending=[];
 const cleared=await read();
 assert.deepEqual(cleared.events.find(e=>e.type==="connected").pendingExtensionUiIds,[]);
 assert.equal(cleared.events.some(e=>e.type==="extension_ui_request"),false);
 closeAllSessionEventHubs();
});
