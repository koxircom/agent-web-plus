import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const queueActions = await import("./queue-actions.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function createQueuedUserMessage(text, images = []) {
  const content = [{ type: "text", text }];
  for (const img of images) {
    content.push({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    });
  }
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function createFakeQueueSession({ isStreaming = true, isCompacting = false } = {}) {
  const agent = new Agent({
    streamFn: async () => {
      throw new Error("Model streamFn must not be invoked during queue actions");
    },
  });
  agent.state.isStreaming = isStreaming;

  const session = {
    sessionId: `fake-session-${Math.random().toString(36).slice(2)}`,
    sessionFile: undefined,
    isStreaming,
    isCompacting,
    isBashRunning: false,
    agent,
    _steeringMessages: [],
    _followUpMessages: [],
    emitCount: 0,
    clearQueueCalls: 0,
    _emitQueueUpdate() {
      this.emitCount += 1;
    },
    enqueueSteering(text, images = []) {
      const msg = createQueuedUserMessage(text, images);
      this.agent.steer(msg);
      this._steeringMessages.push(text);
      return msg;
    },
    enqueueFollowUp(text, images = []) {
      const msg = createQueuedUserMessage(text, images);
      this.agent.followUp(msg);
      this._followUpMessages.push(text);
      return msg;
    },
    getSteeringMessages() {
      return [...this._steeringMessages];
    },
    getFollowUpMessages() {
      return [...this._followUpMessages];
    },
    clearQueue() {
      this.clearQueueCalls += 1;
      const steering = [...this._steeringMessages];
      const followUp = [...this._followUpMessages];
      this.agent.clearAllQueues();
      this._steeringMessages.length = 0;
      this._followUpMessages.length = 0;
      return { steering, followUp };
    },
    extensionRunner: {},
    sessionManager: {
      getCwd: () => "/tmp",
    },
    dispose() {},
  };

  return session;
}

test("duplicate text with different images stays isolated across snapshot, getQueuedMessage, promote, recall, and delete", () => {
  const session = createFakeQueueSession({ isStreaming: true });
  const imgA = [{ data: "aW1hZ2UtYQ==", mimeType: "image/png" }];
  const imgB = [
    { data: "aW1hZ2UtYjE=", mimeType: "image/jpeg" },
    { data: "aW1hZ2UtYjI=", mimeType: "image/webp" },
  ];

  session.enqueueFollowUp("same text", imgA);
  session.enqueueFollowUp("same text", imgB);

  const snap1 = queueActions.snapshot(session);
  assert.equal(snap1.version, 2);
  assert.equal(snap1.followUp.length, 2);
  assert.notEqual(snap1.followUp[0].token, snap1.followUp[1].token);
  assert.equal(snap1.followUp[0].text, "same text");
  assert.equal(snap1.followUp[0].imageCount, 1);
  assert.equal(snap1.followUp[1].text, "same text");
  assert.equal(snap1.followUp[1].imageCount, 2);

  const tokenA = snap1.followUp[0].token;
  const tokenB = snap1.followUp[1].token;

  const detailA = queueActions.getQueuedMessage(session, tokenA);
  const detailB = queueActions.getQueuedMessage(session, tokenB);
  assert.deepEqual(detailA.images, imgA);
  assert.deepEqual(detailB.images, imgB);

  // Recall only the second identical-text message; first must remain untouched with its own image
  const recalledB = queueActions.recall(session, tokenB);
  assert.equal(recalledB.version, 2);
  assert.equal(recalledB.token, tokenB);
  assert.equal(recalledB.kind, "followUp");
  assert.equal(recalledB.text, "same text");
  assert.deepEqual(recalledB.images, imgB);
  assert.equal(session.clearQueueCalls, 0);

  const snapAfterRecall = queueActions.snapshot(session);
  assert.equal(snapAfterRecall.followUp.length, 1);
  assert.equal(snapAfterRecall.followUp[0].token, tokenA);
  assert.deepEqual(queueActions.getQueuedMessage(session, tokenA).images, imgA);
});

test("recallAll atomically verifies expectedTokens and preserves all images without clear+requeue", () => {
  const session = createFakeQueueSession({ isStreaming: true });
  const steerImg = [{ data: "c3RlZXItaW1n", mimeType: "image/png" }];
  const followImg = [
    { data: "Zm9sbG93LWltZy0x", mimeType: "image/png" },
    { data: "Zm9sbG93LWltZy0y", mimeType: "image/gif" },
  ];

  session.enqueueSteering("steer with image", steerImg);
  session.enqueueFollowUp("follow plain", []);
  session.enqueueFollowUp("follow with 2 images", followImg);

  const snap = queueActions.snapshot(session);
  const allTokens = [
    ...snap.steering.map((item) => item.token),
    ...snap.followUp.map((item) => item.token),
  ];

  // Mismatched token order or subset must fail closed with zero mutation
  assert.throws(
    () => queueActions.recallAll(session, [allTokens[0], allTokens[1]]),
    /expectedTokens mismatch/,
  );
  assert.throws(
    () => queueActions.recallAll(session, [...allTokens].reverse()),
    /expectedTokens mismatch/,
  );
  assert.equal(session.agent.steeringQueue.messages.length, 1);
  assert.equal(session.agent.followUpQueue.messages.length, 2);
  assert.equal(session.emitCount, 0);

  // Exact token sequence drains all queues atomically and preserves images
  const recalled = queueActions.recallAll(session, allTokens);
  assert.equal(recalled.version, 2);
  assert.equal(recalled.entries.length, 3);
  assert.deepEqual(
    recalled.entries.map((e) => ({ text: e.text, kind: e.kind, token: e.token, images: e.images })),
    [
      { text: "steer with image", kind: "steering", token: allTokens[0], images: steerImg },
      { text: "follow plain", kind: "followUp", token: allTokens[1], images: [] },
      { text: "follow with 2 images", kind: "followUp", token: allTokens[2], images: followImg },
    ],
  );
  assert.equal(session.agent.steeringQueue.messages.length, 0);
  assert.equal(session._steeringMessages.length, 0);
  assert.equal(session.agent.followUpQueue.messages.length, 0);
  assert.equal(session._followUpMessages.length, 0);
  assert.equal(session.emitCount, 1);
  assert.equal(session.clearQueueCalls, 0);
});

test("stale tokens and cross-session tokens are rejected without mutating either session", () => {
  const sessionA = createFakeQueueSession({ isStreaming: true });
  const sessionB = createFakeQueueSession({ isStreaming: true });

  sessionA.enqueueFollowUp("msg A1", [{ data: "YTE=", mimeType: "image/png" }]);
  sessionA.enqueueFollowUp("msg A2");
  sessionB.enqueueFollowUp("msg B1", [{ data: "YjE=", mimeType: "image/png" }]);

  const snapA = queueActions.snapshot(sessionA);
  const snapB = queueActions.snapshot(sessionB);
  const tokenA1 = snapA.followUp[0].token;
  const tokenB1 = snapB.followUp[0].token;

  // Cross-session token usage must fail and leave sessionB untouched
  assert.throws(() => queueActions.getQueuedMessage(sessionB, tokenA1), /Token invalid/);
  assert.throws(() => queueActions.promote(sessionB, tokenA1), /Token invalid/);
  assert.throws(() => queueActions.recall(sessionB, tokenA1), /Token invalid/);
  assert.throws(() => queueActions.deleteQueued(sessionB, tokenA1), /Token invalid/);
  assert.throws(() => queueActions.recallAll(sessionB, [tokenA1]), /expectedTokens mismatch/);
  assert.equal(sessionB.agent.followUpQueue.messages.length, 1);
  assert.equal(sessionB._followUpMessages[0], "msg B1");
  assert.equal(sessionB.emitCount, 0);

  // Delete tokenA1 in sessionA, then verify tokenA1 is now stale
  const delRes = queueActions.deleteQueued(sessionA, tokenA1);
  assert.deepEqual(delRes, { version: 2, success: true });
  assert.equal(sessionA.agent.followUpQueue.messages.length, 1);
  assert.equal(sessionA._followUpMessages[0], "msg A2");

  const emitBeforeStale = sessionA.emitCount;
  assert.throws(() => queueActions.getQueuedMessage(sessionA, tokenA1), /Token invalid/);
  assert.throws(() => queueActions.promote(sessionA, tokenA1), /Token invalid/);
  assert.throws(() => queueActions.recall(sessionA, tokenA1), /Token invalid/);
  assert.throws(() => queueActions.deleteQueued(sessionA, tokenA1), /Token invalid/);
  assert.equal(sessionA.agent.followUpQueue.messages.length, 1);
  assert.equal(sessionA.emitCount, emitBeforeStale);
  assert.ok(tokenB1);
});

test("invalid attachment schema or two-layer queue desync fails closed before any mutation", () => {
  const session = createFakeQueueSession({ isStreaming: true });
  session.enqueueFollowUp("valid msg", [{ data: "dmFsaWQ=", mimeType: "image/png" }]);
  const { followUp } = queueActions.snapshot(session);
  const validToken = followUp[0].token;

  // Corrupt the image schema on a second message
  const badMsg = {
    role: "user",
    content: [
      { type: "text", text: "corrupt image" },
      { type: "image", data: "", mimeType: "text/plain" },
    ],
  };
  session.agent.followUpQueue.messages.push(badMsg);
  session._followUpMessages.push("corrupt image");

  assert.throws(() => queueActions.snapshot(session), /Incompatible message attachment schema/);
  assert.throws(() => queueActions.getQueuedMessage(session, validToken), /Incompatible message attachment schema/);
  assert.throws(() => queueActions.promote(session, validToken), /Incompatible message attachment schema/);
  assert.throws(() => queueActions.recall(session, validToken), /Incompatible message attachment schema/);
  assert.throws(() => queueActions.deleteQueued(session, validToken), /Incompatible message attachment schema/);
  assert.throws(() => queueActions.recallAll(session, [validToken]), /Incompatible message attachment schema/);

  // Ensure nothing was mutated when validation failed
  assert.equal(session.agent.followUpQueue.messages.length, 2);
  assert.equal(session._followUpMessages.length, 2);
  assert.equal(session.agent.steeringQueue.messages.length, 0);
  assert.equal(session.emitCount, 0);

  // Remove corrupt message and test two-layer length desync fail-closed
  session.agent.followUpQueue.messages.pop();
  assert.throws(() => queueActions.recall(session, validToken), /Queue desynchronized/);
  assert.equal(session.agent.followUpQueue.messages.length, 1);
  assert.equal(session.emitCount, 0);
});

test("AgentSessionWrapper dispatches all 6 atomic queue RPC commands plus clear_queue without external path dependencies", async () => {
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(rpcSource, /\/root\/\.pi/);
  assert.doesNotMatch(rpcSource, /enhancements\/pi-web-queue-actions/);
  assert.match(rpcSource, /case "get_queue_actions":[\s\S]*?snapshot\(this\.inner\)/);
  assert.match(rpcSource, /case "get_queued_message":[\s\S]*?getQueuedMessage\(this\.inner,\s*command\.token as string\)/);
  assert.match(rpcSource, /case "promote_queued_message":[\s\S]*?promote\(this\.inner,\s*command\.token as string\)/);
  assert.match(rpcSource, /case "recall_queued_message":[\s\S]*?recall\(this\.inner,\s*command\.token as string\)/);
  assert.match(rpcSource, /case "delete_queued_message":[\s\S]*?deleteQueued\(this\.inner,\s*command\.token as string\)/);
  assert.match(rpcSource, /case "recall_all_queued_messages":[\s\S]*?recallAll\(this\.inner,\s*command\.tokens as string\[\]\)/);

  const session = createFakeQueueSession({ isStreaming: true });
  const wrapper = new AgentSessionWrapper(session);

  try {
    const img1 = [{ data: "aW1nLTE=", mimeType: "image/png" }];
    const img2 = [{ data: "aW1nLTI=", mimeType: "image/jpeg" }];
    session.enqueueFollowUp("first follow-up", img1);
    session.enqueueFollowUp("second follow-up", img2);
    session.enqueueFollowUp("third follow-up", []);

    const snap = await wrapper.send({ type: "get_queue_actions" });
    assert.equal(snap.version, 2);
    assert.equal(snap.followUp.length, 3);
    const [t1, t2, t3] = snap.followUp.map((entry) => entry.token);

    const fetched = await wrapper.send({ type: "get_queued_message", token: t1 });
    assert.deepEqual(fetched, {
      text: "first follow-up",
      kind: "followUp",
      token: t1,
      images: img1,
    });

    const promoted = await wrapper.send({ type: "promote_queued_message", token: t1 });
    assert.deepEqual(promoted, {
      version: 2,
      queuedMessages: {
        steering: ["first follow-up"],
        followUp: ["second follow-up", "third follow-up"],
      },
    });

    const recalledSingle = await wrapper.send({ type: "recall_queued_message", token: t2 });
    assert.deepEqual(recalledSingle, {
      version: 2,
      recalledPromptRequestIds: [],
      cancelledPromptRequestIds: [],
      text: "second follow-up",
      kind: "followUp",
      token: t2,
      images: img2,
    });

    const deleted = await wrapper.send({ type: "delete_queued_message", token: t3 });
    assert.deepEqual(deleted, { version: 2, success: true, cancelledPromptRequestIds: [] });

    const recalledAll = await wrapper.send({ type: "recall_all_queued_messages", tokens: [t1] });
    assert.deepEqual(recalledAll, {
      version: 2,
      recalledPromptRequestIds: [],
      cancelledPromptRequestIds: [],
      entries: [
        {
          text: "first follow-up",
          kind: "steering",
          token: t1,
          images: img1,
        },
      ],
    });

    session.enqueueFollowUp("to be cleared", []);
    const cleared = await wrapper.send({ type: "clear_queue" });
    assert.deepEqual(cleared, { steering: [], followUp: ["to be cleared"], cancelledPromptRequestIds: [] });
  } finally {
    wrapper.destroy();
  }
});


test("delivered image-only steering retires the SDK text ghost without resending or clearing other images", () => {
  const session = createFakeQueueSession();
  const image = [{ data: "aW1hZ2UtYQ==", mimeType: "image/png" }];
  const delivered = session.enqueueSteering("", image);
  const next = session.enqueueSteering("", image);
  session.agent.steeringQueue.messages.shift();
  assert.throws(() => queueActions.snapshot(session), /steering queue length mismatch/);
  assert.equal(queueActions.reconcileDeliveredImageOnlyMessage(session, delivered), true);
  assert.deepEqual(session._steeringMessages, [""]);
  const snapshot = queueActions.snapshot(session);
  assert.equal(snapshot.steering[0].imageCount, 1);
  assert.equal(queueActions.getQueuedMessage(session, snapshot.steering[0].token).images.length, 1);
  assert.equal(queueActions.reconcileDeliveredImageOnlyMessage(session, next), false);
  assert.equal(queueActions.deleteQueued(session, snapshot.steering[0].token).success, true);
  assert.equal(session.clearQueueCalls, 0);
});

test("image-only follow-up delivery reconciles once and fails closed on unrelated corruption", () => {
  const session = createFakeQueueSession();
  const message = session.enqueueFollowUp("", [{ data: "aW1hZ2U=", mimeType: "image/png" }]);
  session.agent.followUpQueue.messages.shift();
  assert.equal(queueActions.reconcileDeliveredImageOnlyMessage(session, message), true);
  assert.equal(queueActions.reconcileDeliveredImageOnlyMessage(session, message), false);
  assert.equal(queueActions.snapshot(session).followUp.length, 0);
  session._steeringMessages.push("unrelated");
  assert.equal(queueActions.reconcileDeliveredImageOnlyMessage(session, message), false);
  assert.deepEqual(session._steeringMessages, ["unrelated"]);
});

 test("wrapper reconciles image-only delivery before broadcasting the user event", async () => {
 const session = createFakeQueueSession();
 let receive;
 session.subscribe = (handler) => { receive = handler; return () => {}; };
 const wrapper = new AgentSessionWrapper(session);
 wrapper.start();
 try {
  const delivered = session.enqueueSteering("", [{data:"aW1n",mimeType:"image/png"}]);
  session.agent.steeringQueue.messages.shift();
  receive({type:"message_start",message:delivered});
  const state = await wrapper.send({type:"get_queue_actions"});
  assert.equal(state.steering.length, 0);
  assert.equal(session.emitCount, 1);
  assert.equal(session.clearQueueCalls, 0);
 } finally { wrapper.destroy(); }
});


test("wrapper delivers user message and authoritative queue snapshot atomically", () => {
 const session = createFakeQueueSession(); let receive; const events = [];
 session.subscribe = handler => { receive = handler; return () => {}; };
 const wrapper = new AgentSessionWrapper(session);
 wrapper.onEvent(event => events.push(event)); wrapper.start();
 try {
  session.enqueueSteering("same text", [{data:"aW1n",mimeType:"image/png"}]);
  session.enqueueFollowUp("same text");
  const delivered = createQueuedUserMessage("same text");
  receive({type:"message_end",message:delivered});
  assert.equal(events.length, 1);
  assert.equal(events[0].message, delivered);
  assert.deepEqual(events[0].queuedMessages, {steering:["same text"],followUp:["same text"]});
  // Snapshot is detached, and no text-guess mutation removes duplicate entries.
  session._steeringMessages.length = 0;
  assert.deepEqual(events[0].queuedMessages.steering, ["same text"]);
  assert.equal(session.clearQueueCalls, 0);
 } finally { wrapper.destroy(); }
});

test("reorder preserves exact message/image identity and steering priority", async () => {
 const s = createFakeQueueSession();
 s.enqueueSteering("priority");
 const image = [{data: "aW1n", mimeType: "image/png"}];
 const a = s.enqueueFollowUp("duplicate", image);
 const b = s.enqueueFollowUp("duplicate");
 const snap = queueActions.snapshot(s);
 assert.equal(snap.reorder, true);
 const tokens = [...snap.steering, ...snap.followUp].map(x => x.token);
 assert.throws(() => queueActions.reorderQueued(s, tokens, tokens[1], tokens[0]), /same queue/);
 assert.throws(() => queueActions.reorderQueued(s, tokens.slice(1), tokens[1], tokens[2]), /expectedTokens/);
 assert.equal(s.emitCount, 0);
 const result = queueActions.reorderQueued(s, tokens, tokens[1], tokens[2]);
 assert.equal(result.version, 2);
 assert.deepEqual(s.agent.followUpQueue.messages, [b, a]);
 assert.deepEqual(queueActions.getQueuedMessage(s, tokens[1]).images, image);
 assert.equal(s.emitCount, 1);
 assert.equal(s.clearQueueCalls, 0);
 assert.throws(() => queueActions.reorderQueued(s, tokens, tokens[1], tokens[2]), /expectedTokens/);
 const now = queueActions.snapshot(s);
 const reordered = [...now.steering, ...now.followUp].map(x => x.token);
 queueActions.reorderQueued(s, reordered, reordered[1], reordered[1]);
 assert.equal(s.emitCount, 1);
 const wrapper = new AgentSessionWrapper(s);
 let ack;
 try {
  const w = await wrapper.send({type: "get_queue_actions"});
  const wt = [...w.steering, ...w.followUp].map(x => x.token);
  ack = await wrapper.send({type: "reorder_queued_message", tokens: wt, token: wt[2], targetToken: wt[1]});
 } finally { wrapper.destroy(); }
 assert.equal(ack.version, 2);
 assert.deepEqual(s.agent.followUpQueue.messages, [a, b]);
 const other = createFakeQueueSession(); other.enqueueFollowUp("other");
 assert.throws(() => queueActions.reorderQueued(other, tokens, tokens[1], tokens[2]), /expectedTokens/);
});
