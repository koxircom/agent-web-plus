'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../usage-ledger-core.js');

const NOW = Date.parse('2026-10-18T04:00:00.000Z');
const TODAY = core.day(NOW);
const YESTERDAY = core.day(NOW - 86400000);

function bucket({ engine, model = 'gpt-6-sol', role = 'main', day = TODAY, sessionId = 'pi-session', inputTokens = 1000000, outputTokens = 0, costNano = 0, unpricedTokens = 0 } = {}) {
  const value = {
    sessionId,
    provider: 'openai',
    model,
    role,
    day,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    messageCount: 1,
    calls: role === 'subagent' ? 1 : 0,
    records: 1,
    costNano,
    unpricedTokens,
    missingUsage: 0,
  };
  if (engine !== undefined) value.engine = engine;
  return value;
}

function ledger(buckets, extra = {}) {
  return {
    version: 2,
    snapshotId: 'engine-fixture',
    generatedAt: '2026-10-18T04:00:00.000Z',
    buckets,
    sessions: {},
    ...extra,
  };
}

test('engine filter runs before models and composes with Beijing date, role, and model filters', () => {
  const pi = bucket({ engine: undefined, sessionId: 'pi-today', model: 'gpt-6-sol' });
  const codexToday = bucket({ engine: 'codex', role: 'subagent', sessionId: 'codex-today', unpricedTokens: 120 });
  const codexYesterday = bucket({ engine: 'codex', day: YESTERDAY, sessionId: 'codex-yesterday', model: 'gpt-6.1-sol' });
  const data = ledger([pi, codexToday, codexYesterday]);

  const combined = core.aggregate(data, { now: NOW });
  assert.equal(combined.totalTokens, pi.totalTokens + codexToday.totalTokens + codexYesterday.totalTokens);
  assert.equal(combined.modelBreakdowns.find(item => item.key === 'gpt-6-sol').totalTokens, pi.totalTokens + codexToday.totalTokens);

  const codex = core.aggregate(data, { engine: 'codex', now: NOW });
  assert.equal(codex.totalTokens, codexToday.totalTokens + codexYesterday.totalTokens);
  assert.deepEqual(codex.allModels.map(([key]) => key).sort(), ['gpt-6-sol', 'gpt-6.1-sol']);

  const crossFiltered = core.aggregate(data, {
    engine: 'codex', timeRange: 'today', role: 'subagent', model: 'gpt-6-sol', now: NOW,
  });
  assert.equal(crossFiltered.totalTokens, codexToday.totalTokens);
  assert.equal(crossFiltered.sessionCount, 1);
  assert.equal(crossFiltered.roles.subagent.totalTokens, codexToday.totalTokens);
  assert.equal(core.aggregate(data, { engine: 'pi', now: NOW }).totalTokens, pi.totalTokens);
});

test('missing engine remains Pi-compatible; unknown explicit engines are rejected', () => {
  const oldBucket = bucket({ sessionId: 'old-pi' });
  const codexBucket = bucket({ engine: 'codex', sessionId: 'codex' });
  const data = ledger([oldBucket, codexBucket]);
  assert.equal(core.aggregate(data, { engine: 'pi' }).totalTokens, oldBucket.totalTokens);
  assert.equal(core.aggregate(data, { engine: 'all' }).totalTokens, oldBucket.totalTokens + codexBucket.totalTokens);
  assert.throws(() => core.aggregate(data, { engine: 'other' }), /Invalid engine/);
  assert.throws(() => core.validate(ledger([bucket({ engine: 'other' })])), /Invalid bucket engine/);
});

test('Codex keeps its unpriced count and zero cost while Pi retains SDK reference pricing', () => {
  const pi = bucket({ sessionId: 'pi-priced' });
  const codex = bucket({ engine: 'codex', sessionId: 'codex-unpriced', costNano: 9000000000, unpricedTokens: 100 });
  const data = ledger([pi, codex]);

  const piStats = core.aggregate(data, { engine: 'pi' });
  const codexStats = core.aggregate(data, { engine: 'codex' });
  assert.ok(piStats.costNano > 0);
  assert.equal(codexStats.costNano, 0);
  assert.equal(codexStats.unpricedTokens, 100);
  assert.equal(codexStats.codexTokens, codex.totalTokens);
  assert.equal(codexStats.modelBreakdowns[0].costNano, 0);
});

function panelFixture(initialLedger, { connected = false, fetchLedgers = [] } = {}) {
  const storage = new Map();
  const timers = new Map();
  const fetchCalls = [];
  let timerId = 0;
  const engineSelect = { value: 'all', onchange: null };
  const panel = {
    dataset: {},
    innerHTML: '',
    isConnected: connected,
    querySelector(selector) { return selector === '[data-usage-engine-select]' ? engineSelect : null; },
    querySelectorAll() { return []; },
  };
  const context = {
    console,
    AbortController,
    Date,
    __PI_ENH_USAGE_LEDGER__: initialLedger,
    PiUsageLedger: core,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetch: async url => {
      fetchCalls.push(url);
      const next = fetchLedgers.length ? fetchLedgers.shift() : initialLedger;
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'x-pi-usage-mode' ? 'native-local' : null },
        text: async () => JSON.stringify(next),
      };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../pi-usage-panel.js'), 'utf8'), context);
  return { context, panel, engineSelect, storage, timers, fetchCalls };
}

test('engine dropdown persists selection, resets model, and marks a legacy cache as Pi-only while refreshing', () => {
  const oldLedger = ledger([bucket({ model: 'gpt-6-sol' })]);
  const f = panelFixture(oldLedger);
  f.context.PiUsagePanel.setFilters({ model: 'gpt-6-sol' });
  f.context.PiUsagePanel.render(f.panel, {}, { enabled: () => true });
  assert.match(f.panel.innerHTML, /data-usage-engine-select/);
  assert.match(f.panel.innerHTML, /<option value="all"[^>]*>全部<\/option>/);
  assert.match(f.panel.innerHTML, /<option value="pi"[^>]*>Pi Agent<\/option>/);
  assert.match(f.panel.innerHTML, /<option value="codex"[^>]*>Codex<\/option>/);

  f.engineSelect.value = 'codex';
  f.engineSelect.onchange({ target: f.engineSelect });
  const filters = f.context.PiUsagePanel.getFilters();
  assert.equal(filters.engine, 'codex');
  assert.equal(filters.model, 'all');
  assert.equal(filters.timeRange, 'all');
  assert.equal(filters.role, 'all');
  const saved = JSON.parse(f.storage.get('pi-enh-usage-filters'));
  assert.equal(saved.engine, 'codex');
  assert.equal(saved.model, 'all');
  assert.match(f.panel.innerHTML, /Codex：旧快照仅包含 Pi Agent/);
  assert.match(f.panel.innerHTML, /data-usage-engine-status/);
  assert.equal(f.fetchCalls.length, 0, 'disconnected fixture does not start a request');

  f.context.PiUsagePanel.resetFilters();
  assert.equal(f.context.PiUsagePanel.getFilters().engine, 'all');
});

test('Codex loading status polls the shared snapshot and stops when the status changes', async () => {
  const loading = ledger([], {
    engineStatus: { pi: { status: 'ready' }, codex: { status: 'loading', message: 'Codex 快照生成中' } },
  });
  const ready = ledger([], {
    snapshotId: 'engine-fixture-ready',
    generatedAt: '2026-10-18T04:00:02.000Z',
    engineStatus: { pi: { status: 'ready' }, codex: { status: 'ready' } },
  });
  const f = panelFixture(loading, { connected: true, fetchLedgers: [loading, ready] });
  f.context.PiUsagePanel.render(f.panel, {}, { enabled: () => true });
  assert.match(f.panel.innerHTML, /Codex 快照生成中；当前为已获取部分/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 2000).length, 1);

  const [timerId, timer] = [...f.timers.entries()].find(([, item]) => item.delay === 2000);
  f.timers.delete(timerId);
  await timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(f.panel.innerHTML, /data-usage-engine-status/);
  assert.equal([...f.timers.values()].filter(item => item.delay === 2000).length, 0);
  f.context.PiUsagePanel.dispose(f.panel);
});

test('disposing a loading panel clears its per-panel poll timer', async () => {
  const loading = ledger([], {
    engineStatus: { pi: { status: 'ready' }, codex: { status: 'loading' } },
  });
  const f = panelFixture(loading, { connected: true });
  f.context.PiUsagePanel.render(f.panel, {}, { enabled: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 2000).length, 1);
  f.context.PiUsagePanel.dispose(f.panel);
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 2000).length, 0);
});


test('Codex nested workers count as one conversation while physical totals/date/role filters stay exact',()=>{
 const root='codex:root',child='codex:child',nested='codex:nested';
 const data=ledger([bucket({engine:'codex',sessionId:root,inputTokens:100}),bucket({engine:'codex',sessionId:child,role:'subagent',inputTokens:20}),bucket({engine:'codex',sessionId:nested,role:'subagent',inputTokens:30}),bucket({engine:'codex',sessionId:child,role:'subagent',day:YESTERDAY,inputTokens:40}),bucket({sessionId:'pi',inputTokens:5})],{sessions:{[root]:{title:'真实主会话'},[child]:{parentSessionId:root,title:'子任务甲'},[nested]:{parentSessionId:child,title:'子任务乙'},pi:{title:'Pi会话'}}});
 const today=core.aggregate(data,{engine:'codex',timeRange:'today',now:NOW});
 assert.equal(today.sessionCount,1);assert.equal(today.physicalSessionCount,3);assert.equal(today.totalTokens,150);assert.equal(today.topSessions[0].id,root);assert.equal(today.topSessions[0].title,'真实主会话');assert.equal(today.topSessions[0].subagentCount,2);assert.equal(today.topSessions[0].subagentTokens,50);assert.equal(today.modelBreakdowns[0].sessionCount,1);
 const children=core.aggregate(data,{engine:'codex',role:'subagent',timeRange:'today',now:NOW});assert.equal(children.totalTokens,50);assert.equal(children.sessionCount,1);
 const main=core.aggregate(data,{engine:'codex',role:'main',timeRange:'today',now:NOW});assert.equal(main.totalTokens,100);assert.equal(main.topSessions[0].subagentCount,0);
 assert.equal(core.aggregate(data,{engine:'codex',timeRange:'yesterday',now:NOW}).totalTokens,40);
 const combined=core.aggregate(data,{timeRange:'today',now:NOW});assert.equal(combined.totalTokens,155);assert.equal(combined.sessionCount,2);
 assert.equal(core.aggregate(data,{engine:'pi',timeRange:'today',now:NOW}).sessionCount,1);
});
test('missing parents, malformed values and cycles cannot hide or merge independent execution records',()=>{
 for(const sessions of [{'codex:a':{parentSessionId:'codex:missing'}},{'codex:a':{parentSessionId:42}},{'codex:a':{parentSessionId:'codex:b'},'codex:b':{parentSessionId:'codex:a'}}]){
  const data=ledger([bucket({engine:'codex',sessionId:'codex:a'}),bucket({engine:'codex',sessionId:'codex:b'})],{sessions});const stats=core.aggregate(data,{engine:'codex'});assert.equal(stats.sessionCount,2);assert.equal(stats.totalTokens,2000000);
 }
});
test('server and browser use the identical accounting source',()=>{
 assert.equal(fs.readFileSync(path.join(__dirname,'../usage-ledger-core.js'),'utf8'),fs.readFileSync(path.join(__dirname,'../../bin/usage-guard/usage-ledger-core.js'),'utf8'));
});
