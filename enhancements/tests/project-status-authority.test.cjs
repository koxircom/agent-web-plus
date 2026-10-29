"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../modules/04-sidebar-and-session-management.js"),"utf8");
function model(stored={}){const c={projectStatusState:{sessions:stored}};vm.createContext(c);vm.runInContext(source.slice(source.indexOf("  function createProjectStatusModel()"),source.indexOf("  // END STATUS MODEL"))+";this.model=createProjectStatusModel();",c);return c.model;}
function payload({revision=1,running=[],executions=[],pending=[]}={}){return{runningSessionIds:running,statusSnapshot:{version:1,epoch:"test",revision,executions},interactionState:{version:1,sessions:pending}};}
const session=id=>({id,cwd:"/work",name:id});
test("stored runtime facts never resurrect after refresh, even before the first server response",()=>{const m=model({ghost:{id:"ghost",projectKey:"/work",status:"running"},ask:{id:"ask",projectKey:"/work",status:"attention",pendingRequests:[{id:"old"}]}});m.setCatalog([session("ask")]);assert.equal(m.entry("ask").status,"idle");assert(!m.list().some(e=>e.id==="ghost"));});
test("runtime IDs reconcile orphaned ledger runs and missing receipts atomically",()=>{const m=model();m.setCatalog([session("old"),session("live")]);assert(m.apply(payload({running:["live"],executions:[{sessionId:"old",state:"running",runId:"a"}]}),100).accepted);assert.equal(m.entry("old").status,"idle");assert.equal(m.entry("live").status,"running");});
test("only current pending requests count as waiting; closure removes old cache attention",()=>{const m=model();m.setCatalog([session("one")]);m.apply(payload({running:["one"],pending:[{sessionId:"one",pendingRequests:[{id:"q",method:"select"}]}]}),100);assert.equal(m.summary("/work").attention,1);m.apply(payload({revision:2,executions:[{sessionId:"one",state:"ended",runId:"r"}]}),101);assert.equal(m.summary("/work").attention,0);assert.equal(m.entry("one").status,"completed");});
test("catalog deletion removes interrupted and running ghosts from every project count",()=>{const m=model();m.setCatalog([session("gone")]);m.apply(payload({executions:[{sessionId:"gone",state:"failed",runId:"r"}]}),100);assert.equal(m.summary("/work").interrupted,1);m.setCatalog([]);assert.equal(m.list().length,0);assert.equal(m.summary("/work").interrupted,0);});
test("out of order snapshots cannot resurrect a closed request",()=>{const m=model();m.setCatalog([session("one")]);m.apply(payload({revision:2}),100);assert(!m.apply(payload({revision:1,pending:[{sessionId:"one",pendingRequests:[{id:"q",method:"input"}]}]}),101).accepted);assert.equal(m.entry("one").status,"idle");});

test("switching Codex to Pi and back accepts the unchanged Codex stream without losing running state", () => {
  const m=model();m.setCatalog([session("codex:one"),session("pi-one")]);
  const codex=payload({revision:7,running:["codex:one"]});codex.statusSnapshot.epoch="codex-runtime";
  const pi=payload({revision:2,running:["pi-one"]});pi.statusSnapshot.epoch="pi-runtime";
  assert(m.apply(codex,100,"codex").accepted);
  assert(m.apply(pi,200,"pi").accepted);
  assert(m.apply(codex,300,"codex").accepted,"returning to a live engine is not a retired server epoch");
  assert.equal(m.entry("codex:one").status,"running");
  assert.equal(m.entry("pi-one").status,"idle");
  assert.equal(m.health().at,300);
  assert(m.apply(pi,400,"pi").accepted);
  assert.equal(m.entry("pi-one").status,"running");
});

test("engine switching preserves each stream's revision and retired epoch protections", () => {
  const m=model();
  const snapshot=(epoch,revision)=>{const p=payload({revision});p.statusSnapshot.epoch=epoch;return p;};
  assert(m.apply(snapshot("codex-old",7),100,"codex").accepted);
  assert(m.apply(snapshot("codex-new",1),200,"codex").accepted);
  assert(m.apply(snapshot("pi",100),300,"pi").accepted);
  assert.equal(m.apply(snapshot("codex-old",1000),400,"codex").accepted,false);
  assert(m.apply(snapshot("codex-new",2),500,"codex").accepted);
  assert(m.apply(snapshot("pi",100),600,"pi").accepted);
  assert.equal(m.apply(snapshot("codex-new",1),700,"codex").accepted,false);
  assert(m.apply(snapshot("codex-new",2),800,"codex").accepted);
  assert.equal(m.health().at,800);
});
