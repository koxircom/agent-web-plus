"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/04-sidebar-and-session-management.js"), "utf8");
const bootstrapSource = fs.readFileSync(path.join(__dirname, "../modules/01-bootstrap-and-core-state.js"), "utf8");
const chatSource = fs.readFileSync(path.join(__dirname, "../modules/06-chat-view-and-tool-cards.js"), "utf8");
const liveSource = fs.readFileSync(path.join(__dirname, "../modules/07-kernel-scheduler-and-observers.js"), "utf8");

function extractBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end).trim();
}

const cleanTitle = extractBetween("function cleanSessionTitleBase(title)", "function stripProjectStatusTitleSuffix(title)");
const statusSnapshot = extractBetween("function getCurrentProjectTabStatusSnapshot()", "function syncProjectTabStatusSnapshot(force = false)");
const titleFormatter = extractBetween("function formatProjectTabTitle(base, snapshot)", "function composeProjectWindowTitle(base)");
const titleComposer = extractBetween("function composeProjectWindowTitle(base)", "window.__PI_ENH_COMPOSE_WINDOW_TITLE__ = composeProjectWindowTitle;");

function makeContext(entries, currentSessionId = "attention") {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const context = {
    window: { __PI_WEB_NATIVE_TITLE_BASE__: "work - Pi Web" },
    projectStatusDisposed: false,
    projectStatusModel: { list: () => entries, entry: (id) => byId.get(id) },
    isProjectStatusHealthy: () => true,
    projectStatusCatalog: new Map(entries.map((entry) => [entry.id, entry])),
    projectStatusState: { sessions: Object.fromEntries(entries.map((entry) => [entry.id, entry])) },
    getCurrentProjectStatusKey: () => "C:\\work",
    normalizeProjectStatusKey: (value) => String(value || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase(),
    getEffectiveProjectStatusEntry: (id) => byId.get(id),
    hasActiveAskUserOnScreen: () => true,
    getSessionIdFromCurrentUrl: () => currentSessionId,
    getSessionProjectStatusKey: (session) => String(session?.projectKey || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase(),
    isPluginEnabled: () => true,
    syncProjectTabStatusSnapshot: () => ({ count: 12, running: 10, attention: 2, healthy: true }),
  };
  vm.createContext(context);
  vm.runInContext(`${cleanTitle}\n${statusSnapshot}\n${titleFormatter}\n${titleComposer}\nthis.snapshot = getCurrentProjectTabStatusSnapshot;\nthis.compose = composeProjectWindowTitle;`, context);
  return context;
}

test("project tab snapshot counts runtime and waiting separately, excluding unread endings and interrupted", () => {
  const entries = [
    { id: "done-unread", projectKey: "c:\\work", status: "completed", unread: true },
    { id: "done-read", projectKey: "c:\\work", status: "completed", unread: false },
    { id: "attention", projectKey: "c:\\work", status: "attention", pendingRequests: [{ id: "ask-1" }] },
    { id: "pending", projectKey: "c:\\work", status: "attention", pendingRequests: [{ id: "ask-2" }] },
    { id: "running", projectKey: "c:\\work", status: "running", unread: true },
    { id: "interrupted", projectKey: "c:\\work", status: "interrupted", unread: true },
    { id: "other-project", projectKey: "c:\\other", status: "completed", unread: true },
  ];
  const snapshot = makeContext(entries).snapshot();
  assert.equal(snapshot.count, 3);
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.attention, 2);
  assert.equal(snapshot.hasAttention, true);
});

test("fullwidth project suffix preserves a literal count in the project name and repeated composition is stable", () => {
  const context = makeContext([]);
  const title = context.compose("foo（3） - Pi Web");
  assert.equal(title, "foo（3） 🔵10 🟡2");
  assert.equal(context.compose("foo（3） - Pi Web"), title);
  assert.equal(context.cleanSessionTitleBase("foo（3） - Pi Web"), "foo（3）");
});

test("the project title owner is the only title writer in the enhancement status modules", () => {
  assert.doesNotMatch(bootstrapSource, /document\.title\s*=|new MutationObserver\(cleanDomTitle\)/);
  assert.doesNotMatch(liveSource, /document\.title\s*=|applyProjectStatusTitle/);
  assert.doesNotMatch(source, /document\.title\s*=/);
  assert.doesNotMatch(chatSource, /(?:start|stop)AttentionTitleAlert/);
  assert.match(source, /window\.dispatchEvent\(new Event\("pi-enh-title-change"\)\)/);
});

test("unavailable status removes stale task numbers without an unexplained tab suffix",()=>{const c=makeContext([{id:"one",projectKey:"c:\\work",status:"running"}]);c.isProjectStatusHealthy=()=>false;assert.equal(c.snapshot().count,0);c.syncProjectTabStatusSnapshot=()=>c.snapshot();assert.equal(c.compose("work - Pi Web"),"work");});

// The favicon shows the matching state count, never a mixed blue/yellow sum.
test("compact titles omit zero counts and long status labels", () => {
  const c=makeContext([]);
  for(const [snapshot, expected] of [
    [{healthy:true,running:0,attention:0},"work"],
    [{healthy:true,running:2,attention:0},"work 🔵2"],
    [{healthy:true,running:0,attention:3},"work 🟡3"],
    [{healthy:true,running:12,attention:4},"work 🔵12 🟡4"],
    [{healthy:false,running:12,attention:4},"work"],
  ]){c.syncProjectTabStatusSnapshot=()=>snapshot;assert.equal(c.compose("work - Pi Web"),expected);}
});
test("favicon count matches its color when running and waiting coexist", () => {
  const sync=extractBetween("function syncProjectStatusFavicon(snapshot)","function getCurrentProjectTabStatusSnapshot()");
  let rendered,restored=0;const favicon={setAttribute(){}};const c={
    projectStatusDisposed:false,isPluginEnabled:()=>true,projectStatusOriginalIcons:new Map(),
    document:{head:{querySelectorAll:()=>[],querySelector:()=>favicon,appendChild(){}}},
    renderProjectStatusFavicon:(count,attention)=>{rendered={count,attention};},
    restoreProjectStatusFavicon:()=>{restored++;},
  };vm.createContext(c);vm.runInContext(sync+";this.sync=syncProjectStatusFavicon;",c);
  c.sync({count:5,running:2,attention:3,hasAttention:true});assert.deepEqual(rendered,{count:3,attention:true});
  c.sync({count:2,running:2,attention:0,hasAttention:false});assert.deepEqual(rendered,{count:2,attention:false});
  c.sync({count:0,running:0,attention:0,hasAttention:false});assert.equal(restored,1);
});
