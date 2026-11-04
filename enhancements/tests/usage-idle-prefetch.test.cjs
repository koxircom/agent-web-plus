'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../modules/08-settings-panels-and-lifecycle.js'), 'utf8');
const start = source.indexOf('  let usageLedgerPrefetchCancel = null;');
const end = source.indexOf('  async function checkScriptUpdate()', start);
assert(start >= 0 && end > start, 'Usage lifecycle scheduler must remain in its owning module');
const schedulerSource = source.slice(start, end);

function fixture({ readyState = 'loading', visibilityState = 'visible', enabled = true } = {}) {
  const windowEvents = new Map();
  const documentEvents = new Map();
  const idle = new Map();
  const timers = new Map();
  const calls = [];
  const prefetchSignals = [];
  let next = 0;
  const document = {
    readyState,
    visibilityState,
    addEventListener: (name, callback) => documentEvents.set(name, callback),
    removeEventListener: (name, callback) => { if (documentEvents.get(name) === callback) documentEvents.delete(name); },
  };
  const window = {
    requestIdleCallback: callback => {
      const id = ++next;
      idle.set(id, () => { idle.delete(id); callback(); });
      return id;
    },
    cancelIdleCallback: id => idle.delete(id),
    addEventListener: (name, callback) => windowEvents.set(name, callback),
    removeEventListener: (name, callback) => { if (windowEvents.get(name) === callback) windowEvents.delete(name); },
    __PI_ENH_LOAD_OPTIONAL__: async name => {
      calls.push(name);
      return { prefetch: async signal => { calls.push('snapshot'); prefetchSignals.push(signal); } };
    },
  };
  const context = {
    window, document, isDisposed: false,
    AbortController,
    isLoginPage: () => false,
    isPluginEnabled: () => enabled,
    setTimeout: callback => { timers.set(++next, callback); return next; },
    clearTimeout: id => timers.delete(id),
  };
  vm.createContext(context);
  vm.runInContext(schedulerSource, context);
  return { context, window, document, windowEvents, documentEvents, idle, timers, calls, prefetchSignals };
}

test('Usage starts after DOM readiness, shares the snapshot and schedules bounded refresh', async () => {
  const f = fixture();
  f.context.scheduleUsageLedgerPrefetch();
  assert.equal(f.idle.size, 0);
  f.documentEvents.get('DOMContentLoaded')();
  assert.equal(f.idle.size, 1);
  assert.deepEqual(f.calls, []);
  [...f.idle.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['usage-panel', 'snapshot']);
  assert.equal(f.prefetchSignals[0] instanceof AbortSignal, true);
  assert.equal(f.timers.size, 1, 'a future refresh is scheduled after prefetch');
  f.context.scheduleUsageLedgerPrefetch();
  assert.equal(f.idle.size, 0);
  f.context.cancelUsageLedgerPrefetch();
  assert.equal(f.prefetchSignals[0].aborted, true, 'disable cancels only the idle consumer');
});

test('hidden pages defer work until visible and disabling cancels scheduled idle work', async () => {
  const hidden = fixture({ readyState: 'complete', visibilityState: 'hidden' });
  hidden.context.scheduleUsageLedgerPrefetch();
  assert.equal(hidden.idle.size, 0);
  hidden.document.visibilityState = 'visible';
  hidden.documentEvents.get('visibilitychange')();
  assert.equal(hidden.documentEvents.has('visibilitychange'), false);
  [...hidden.idle.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(hidden.calls, ['usage-panel', 'snapshot']);

  const disabled = fixture();
  disabled.context.scheduleUsageLedgerPrefetch();
  disabled.context.cancelUsageLedgerPrefetch();
  disabled.documentEvents.get('DOMContentLoaded')?.();
  assert.equal(disabled.idle.size, 0);
  assert.deepEqual(disabled.calls, []);
});

test('the startup prefetch is scheduled for both execution engines', () => {
  const startup = source.slice(source.lastIndexOf('// 页面加载完成后后台静默预热模型设置数据'));
  const usage = startup.match(/setTimeout\(\(\) => \{\s*if \(([^\n]+)\) scheduleUsageLedgerPrefetch\(\);/);
  assert(usage, 'startup schedules usage prefetch');
  assert.doesNotMatch(usage[1], /getComposerExecutionEngineHint|===\s*["']pi/);
});

test('a failed warmup schedules a retry and recovers while the page remains open', async () => {
  const f = fixture({ readyState: 'complete' });
  let attempts = 0;
  f.window.__PI_ENH_LOAD_OPTIONAL__ = async () => ({ prefetch: async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary failure');
    return { engineStatus: { pi: { status: 'ready' }, codex: { status: 'ready' } } };
  } });
  f.context.scheduleUsageLedgerPrefetch();
  [...f.idle.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  const [id, retry] = [...f.timers.entries()][0];
  f.timers.delete(id);
  retry();
  [...f.idle.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(f.timers.size, 1);
  f.context.cancelUsageLedgerPrefetch();
});
