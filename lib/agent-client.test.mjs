import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: true,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");
// Use the browser store's published API with the same jiti module instance.
const { getPendingPromptSubmissions, retainPromptSubmission, releasePromptSubmission } = await jiti.import("./prompt-submissions.ts");
const entries = new Map();
const sessionStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
beforeEach(() => { entries.clear(); globalThis.window = { sessionStorage }; delete globalThis.indexedDB; });
afterEach(() => { for (const row of getPendingPromptSubmissions()) releasePromptSubmission(row.requestId); });


test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});

test("queue cancellation clears only matching local receipts", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; for (const row of getPendingPromptSubmissions()) releasePromptSubmission(row.requestId); });
  await retainPromptSubmission({requestId:"cancelled-request-1",sessionId:"sid",message:"same",status:"accepted",createdAt:1});
  await retainPromptSubmission({requestId:"retained-request-2",sessionId:"sid",message:"same",status:"accepted",createdAt:1});
  globalThis.fetch = async () => Response.json({success:true,data:{cancelledPromptRequestIds:["cancelled-request-1"]}});
  await sendAgentCommand("sid",{type:"delete_queued_message",token:"token"});
  assert.deepEqual(getPendingPromptSubmissions().map(row => row.requestId),["retained-request-2"]);
});
test("a lost response to a subsequently cancelled prompt never triggers replay", async (t) => {
  const previous = globalThis.fetch; const methods = [];
  t.after(() => { globalThis.fetch = previous; for (const row of getPendingPromptSubmissions()) releasePromptSubmission(row.requestId); });
  globalThis.fetch = async (_url, options) => {
    methods.push(options?.method ?? "GET");
    if (options?.method === "POST") throw new TypeError("response lost");
    return Response.json({status:"cancelled"});
  };
  await sendAgentCommand("sid",{type:"prompt",message:"discarded"});
  assert.deepEqual(methods,["POST","GET"]);
  assert.equal(getPendingPromptSubmissions().length,0);
});

test("recall acknowledgements require a saved draft and do not erase originals on transport loss", async t => {
 const previousFetch=globalThis.fetch, previousStorage=globalThis.localStorage;
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i]??null,get length(){return storage.size}};
 t.after(()=>{globalThis.fetch=previousFetch;if(previousStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=previousStorage});
 const client=await jiti.import('./agent-client.ts'), drafts=await jiti.import('./draft-store.ts');
 const rid='recalled-request-0001',sid='recalled-owner';await retainPromptSubmission({requestId:rid,sessionId:sid,message:'withdrawn original',status:'accepted',createdAt:1});
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({success:true,data:{cancelledPromptRequestIds:[],recalledPromptRequestIds:[rid]}})};
 await sendAgentCommand(sid,{type:'recall_all_queued_messages',tokens:['token']});
 assert.equal(getPendingPromptSubmissions()[0].status,'recalled');
 await client.acknowledgeRecalledPrompts(sid,[rid]);assert.equal(calls,1,'missing draft cannot acknowledge');
 drafts.setDraft(sid,{value:'withdrawn original',images:[]});globalThis.fetch=async()=>{calls++;throw TypeError('ack lost')};
 await client.acknowledgeRecalledPrompts(sid,[rid]);assert.equal(getPendingPromptSubmissions()[0].recallRestored,true);assert.equal(getPendingPromptSubmissions()[0].message,'withdrawn original');
 assert.ok([...storage.values()].some(v=>v.includes('withdrawn original')));
 globalThis.fetch=async()=>Response.json({success:true,data:{cancelledPromptRequestIds:[rid]}});
 await client.acknowledgeRecalledPrompts(sid,[rid]);assert.equal(getPendingPromptSubmissions().length,0);drafts.clearDraft(sid);
});
