import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });
const { CodexRuntime } = await jiti.import("./codex-engine.ts");
const { projectCodexComposer } = await jiti.import("./codex-projection.ts");
const meta = { id: "12345678-1234-1234-1234-123456789abc", cwd: "/project", title: "test", status: "idle", connected: true, sequence: 1,
 composerState: { version: 1, mode: "normal", capabilities: { plan: true, goal: true } } };
const runtime = () => new CodexRuntime("codex:" + meta.id, "identity", { epoch: "e", sequence: 1, rows: [], meta });

test("old connectors cannot silently enable unsupported goal/plan", () => {
 assert.deepEqual(projectCodexComposer({}), { version: 1, mode: "normal", capabilities: { goal: false, plan: false } });
 assert.equal(projectCodexComposer({ composerState: { version: 2, mode: "plan" } }).mode, "normal");
});
test("mode command uses one metadata operation, shares GET and SSE snapshot and never sends a prompt", async () => {
 const r = runtime(), calls = [], events = []; r.listeners.add(e => events.push(e));
 r.json = async (path, body) => { calls.push({path, body}); return {...meta, composerState: {...meta.composerState, mode: body?.mode || "plan"}}; };
 const result = await r.send({type: "set_composer_mode", mode: "plan"});
 assert.equal(calls.length, 1); assert.ok(calls[0].path.endsWith("/composer"));
 assert.equal(JSON.parse(result.extensionStatuses[0].text).mode, "plan");
 assert.equal(events[0].method, "setStatus"); assert.equal(events[0].statusText, result.extensionStatuses[0].text);
 const state = await r.send({type: "get_state"}); assert.equal(state.extensionStatuses[0].text, result.extensionStatuses[0].text);
 await assert.rejects(r.send({type: "set_composer_mode", mode: "typo"}), /参数无效/);
});
test("goal pause/resume uses explicit native actions with identity, never slash prompts", async () => {
 const r = runtime(), calls = [], expected = {objective: "真实目标", createdAt: 5};
 let goalStatus = "active";
 r.json = async (path, body) => { if (body) {calls.push({path, body}); goalStatus = body.status; return {confirmed:true};} return {...meta, composerState: {...meta.composerState, mode: "goal", goal: expected.objective, goalIdentity: expected, goalStatus, paused: goalStatus === "paused"}}; };
 for (const action of ["pause", "resume"]) {
  const result = await r.send({type: "composer_goal_action", action, expected});
  assert.equal(JSON.parse(result.extensionStatuses[0].text).goalStatus, action === "pause" ? "paused" : "active");
 }
 assert.equal(calls.length, 2); assert(calls.every(c => c.path.endsWith("/goal/status") && c.body.expected === expected && !c.body.text));
 assert.notEqual(calls[0].body.id, calls[1].body.id);
});
test("unconfirmed mode or goal actions never fabricate an enabled snapshot", async () => {
 const r = runtime(); r.json = async () => meta;
 await assert.rejects(r.send({type: "set_composer_mode", mode: "goal"}), /尚未确认/);
 await assert.rejects(r.send({type: "composer_goal_action", action: "pause", expected: {objective: "x"}}), /待确认/);
 assert.equal(r.meta.composerState.mode, "normal");
});
test("same native metadata is published only once, and external goal changes stay live", async () => {
 const r = runtime(), events = []; r.listeners.add(e => events.push(e));
 const next = {...meta, composerState: {...meta.composerState, mode: "goal", goal: "测试目标", goalStatus: "active"}};
 for (const sequence of [2, 3]) await r.accept({epoch: "e", sequence, rows: [], meta: next});
 const status = events.filter(e => e.method === "setStatus"); assert.equal(status.length, 1);
 assert.equal(JSON.parse(status[0].statusText).goal, "测试目标");
});

test("accepted history page projects its queue once and keeps repeated text identities separate", async () => {
 const r = runtime(), events = []; r.listeners.add(e => events.push(e)); let reads = 0;
 const next = {...meta}; Object.defineProperty(next, "submissions", {get() {reads++; return [{id: "q1",text: "same", mode: "queue",status: "queued"}, {id: "q2",text: "same", mode: "queue",status: "unknown"}];}});
 await r.accept({epoch:"e",sequence:2,rows:[1,2,3].map(n=>({key:"user"+n,role:"user",text:"sent",version:"v",turnId:"t",order:n})),meta:next});
 assert.equal(reads, 1); const queue = events.find(e=>e.type === "queue_update"); assert.deepEqual(queue.followUp,["same","same"]);
 assert.deepEqual(queue.deliveryStates,[{status:"queued"},{status:"unknown"}]);
});
test("externally resolved requests release partial answers without touching active requests", async () => {
 const r = runtime(); r.answers.set("resolved", {a:["stale"]}); r.answers.set("active", {a:["pending"]});
 r.meta = {...meta, requests:[{id:"active",method:"item/tool/requestUserInput",supported:true,params:{questions:[]}}]};
 r.updateRequests(); assert.equal(r.answers.has("resolved"),false); assert.equal(r.answers.has("active"),true);
});

test("definite goal rejection and malformed receipt cannot be accepted as successful prompts", async () => {
 const r = runtime(); r.json = async()=>({status:"failed",error:"原会话已有目标，正文保留"});
 await assert.rejects(r.send({type:"prompt",requestId:"request-id-goal-rejected",message:"新目标"}), e=>e.status===409 && !e.deliveryUncertain);
 r.json = async()=>({});
 await assert.rejects(r.send({type:"prompt",requestId:"request-id-malformed",message:"不能丢失"}), e=>e.deliveryUncertain===true);
});

test('confirmed composer revision cannot be replaced by a delayed old poll or metadata read', async () => {
 const r=runtime(),events=[];r.listeners.add(e=>events.push(e));
 r.json=async()=>({...meta,composerState:{...meta.composerState,mode:'plan',revision:1}});
 await r.send({type:'set_composer_mode',mode:'plan'});
 await r.accept({epoch:'e',sequence:2,rows:[],meta:{...meta,composerState:{...meta.composerState,revision:0}}});
 assert.equal(r.meta.composerState.mode,'plan');
 r.json=async()=>({...meta,composerState:{...meta.composerState,revision:0}});
 const state=await r.send({type:'get_state'});assert.equal(JSON.parse(state.extensionStatuses[0].text).mode,'plan');
 await r.accept({epoch:'e',sequence:3,rows:[],meta:{...meta,composerState:{...meta.composerState,mode:'goal',revision:2}}});
 assert.equal(r.meta.composerState.mode,'goal');
 assert(!events.some(e=>e.method==='setStatus'&&JSON.parse(e.statusText).mode==='normal'));
});

test('composer merge accepts revision zero and legacy transitions but preserves confirmations across invalid or older snapshots', async () => {
 const r=runtime();
 const accept=(sequence,composerState)=>r.accept({epoch:'e',sequence,rows:[],meta:{...meta,composerState}});
 await accept(2,{version:1,mode:'goal',revision:0,capabilities:{goal:true,plan:true},goal:'revision zero'});
 assert.equal(r.meta.composerState.goal,'revision zero');

 // Once a revision is observed, an unversioned poll cannot erase it.
 await accept(3,{version:1,mode:'normal',capabilities:{goal:true,plan:true}});
 assert.equal(r.meta.composerState.mode,'goal');
 const legacy=runtime();
 await legacy.accept({epoch:'e',sequence:2,rows:[],meta:{...meta,composerState:{version:1,mode:'plan',capabilities:{goal:true,plan:true}}}});
 await legacy.accept({epoch:'e',sequence:3,rows:[],meta});
 assert.equal(legacy.meta.composerState.mode,'normal');

 await accept(4,{version:1,mode:'goal',revision:2,capabilities:{goal:true,plan:true},goal:'confirmed'});
 for (const [sequence,composerState] of [
  [5,undefined],
  [6,{version:2,mode:'normal',revision:3,capabilities:{goal:true,plan:true}}],
  [7,{version:1,mode:'invalid',revision:3,capabilities:{goal:true,plan:true}}],
  [8,{version:1,mode:'normal',revision:-1,capabilities:{goal:true,plan:true}}],
  [9,{version:1,mode:'normal',revision:1,capabilities:{goal:true,plan:true}}],
 ]) {
  await accept(sequence,composerState);
  assert.equal(r.meta.composerState.mode,'goal');
  assert.equal(r.meta.composerState.goal,'confirmed');
 }
 await accept(10,{version:1,mode:'plan',revision:3,capabilities:{goal:true,plan:true}});
 assert.equal(r.meta.composerState.mode,'plan');
});

test("accepted goal publishes the authoritative ordinary input state immediately, retaining the goal", async () => {
 const r=runtime(), events=[];r.listeners.add(e=>events.push(e));
 r.meta={...meta,composerState:{...meta.composerState,mode:"goal",revision:2}};
 r.json=async()=>({id:"server-id",status:"accepted",composerState:{...meta.composerState,mode:"normal",revision:3,goalKnown:true,goal:"继续执行的原生目标",goalStatus:"active"}});
 await r.send({type:"prompt",message:"目标内容",requestId:"12345678-1234-1234-1234-123456789abc"});
 assert.equal(r.meta.composerState.mode,"normal");
 assert.equal(r.meta.composerState.goal,"继续执行的原生目标");
 assert.equal(JSON.parse(events.find(e=>e.method==="setStatus").statusText).mode,"normal");
 // Delayed pre-send metadata cannot restore goal input mode.
 await r.accept({epoch:"e",sequence:4,rows:[],meta:{...meta,composerState:{...meta.composerState,mode:"goal",revision:2}}});
 assert.equal(r.meta.composerState.mode,"normal");
});
