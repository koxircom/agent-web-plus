import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd(), "server-only": "next/dist/compiled/server-only/empty.js" }, interopDefault: true });
const { GET: getAgent } = await jiti.import("./[id]/route.ts");
const { GET: getSession } = await jiti.import("../sessions/[id]/state/route.ts");
const { GET: getRunning } = await jiti.import("./running/route.ts");

test("pending interaction reads use live memory without SDK commands or runtime creation", async (t) => {
  const prior = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = prior; });
  const id = "isolated-pending-interaction";
  const question = { type: "extension_ui_request", id: "question", method: "custom", lines: [],
    askUser: { toolCallId: "tool", question: "Choose", options: [{ title: "A" }] } };
  let pending = [question];
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    getPendingExtensionUiRequests: () => pending,
    send: () => { throw new Error("An interaction read must not call the SDK"); },
  }]]);
  const read = async (sid = id) => {
    const result = await getAgent(new Request("http://localhost/api/agent/" + sid + "?interactions=1"),
      { params: Promise.resolve({ id: sid }) });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    return result.json();
  };
  assert.deepEqual(await read(), { pendingExtensionUiRequests: [question], uncommittedPrompts: [] });
  pending = [];
  assert.deepEqual(await read(), { pendingExtensionUiRequests: [], uncommittedPrompts: [] });
  assert.deepEqual(await read("absent"), { pendingExtensionUiRequests: [], uncommittedPrompts: [] });
  assert.equal(globalThis.__piSessions.has("absent"), false);
  globalThis.__piSessions.get(id).isAlive = () => false;
  assert.deepEqual(await read(), { pendingExtensionUiRequests: [], uncommittedPrompts: [] });
});

test("idle retained runtime and active turns report the same activity on both state routes and sidebar", async (t) => {
  const prior = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = prior; });
  const id = "isolated-activity-contract";
  for (const state of [
    { isStreaming: false, isPromptRunning: false, isCompacting: false, isBashRunning: false },
    { isStreaming: true, isPromptRunning: false, isCompacting: false, isBashRunning: false },
    { isStreaming: false, isPromptRunning: true, isCompacting: false, isBashRunning: false },
    { isStreaming: false, isPromptRunning: false, isCompacting: true, isBashRunning: false },
    { isStreaming: false, isPromptRunning: false, isCompacting: false, isBashRunning: true },
  ]) {
    const busy = Object.values(state).some(Boolean);
    globalThis.__piSessions = new Map([[id, {
      sessionId: id,
      isAlive: () => true,
      isRunning: () => busy,
      getPendingProjectRequests: () => [],
      hasSuppressedCompletionNotifications: () => false,
      send: async (cmd) => { assert.equal(cmd.type, "get_state"); return state; },
    }]]);
    for (const get of [getAgent, getSession]) {
      const result = await get(new Request("http://localhost/api/isolated"), { params: Promise.resolve({ id }) });
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { running: busy, runtimeAlive: true, state });
    }
    const sidebar = await (await getRunning(new Request("http://localhost/api/agent/running?engine=pi"))).json();
    assert.equal(sidebar.runningSessionIds.includes(id), busy);
  }
});

test('recall acknowledgements do not start a runtime and cannot remove an active submission',async()=>{
 const {POST}=await jiti.import('./[id]/route.ts');const delivery=await jiti.import('../../../lib/prompt-delivery.ts');
 const sid=crypto.randomUUID(),id=crypto.randomUUID();await delivery.runPromptDelivery(sid,id,{message:'retained'},async()=>null);
 const ack=()=>POST(new Request('http://localhost/api/agent/'+sid,{method:'POST',body:JSON.stringify({type:'acknowledge_recalled_prompts',requestIds:[id]})}),{params:Promise.resolve({id:sid})});
 assert.deepEqual((await (await ack()).json()).data.cancelledPromptRequestIds,[]);assert.equal(delivery.getPromptReceipt(sid,id).status,'accepted');
 delivery.recallPromptDelivery(sid,id);assert.deepEqual((await (await ack()).json()).data.cancelledPromptRequestIds,[id]);assert.equal(delivery.getPromptReceipt(sid,id).status,'cancelled');assert.equal(globalThis.__piSessions?.has(sid)??false,false);
});
