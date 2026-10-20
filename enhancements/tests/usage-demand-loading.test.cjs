'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const folder = path.resolve(__dirname, '..');
const snapshot = JSON.stringify({ version: 2, generatedAt: '2026-10-02T00:00:00.000Z', snapshotId: 'owned-fixture', buckets: [] });

function fixture(responseText = snapshot) {
  const calls = [];
  const cache = new Map();
  let resolveFetch;
  const context = {
    location: { protocol: 'http:', hostname: '127.0.0.1' },
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    sessionStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    fetch: url => {
      calls.push(url);
      return new Promise(resolve => {
        resolveFetch = () => resolve({
          ok: true,
          status: 200,
          headers: { get: name => name.toLowerCase() === 'x-pi-usage-mode' ? 'native-local' : null },
          text: async () => responseText,
        });
      });
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(folder + '/usage-ledger-core.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync(folder + '/pi-usage-panel.js', 'utf8'), context);
  return { context, calls, cache, resolveFetch: () => resolveFetch?.() };
}

test('startup stays cold; idle prefetch and a signalled foreground open share one validated request', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0, 'the panel module does not fetch before its lifecycle owner schedules prefetch');

  const controller = new AbortController();
  const cancelled = f.context.PiUsagePanel.fetchSnapshotOnce(controller.signal);
  const prefetch = f.context.PiUsagePanel.prefetch();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /^\/api\/usage\/ledger\?/);
  controller.abort();
  await assert.rejects(cancelled, /取消/);
  f.resolveFetch();
  const fresh = await prefetch;
  assert.equal(fresh.snapshotId, 'owned-fixture');
  assert.equal(f.context.PiUsagePanel.read().snapshotId, 'owned-fixture');
  assert.equal(f.context.__PI_ENH_USAGE_LEDGER_MODE__, 'native-local');
  assert.equal(f.cache.get('pi-enh-usage-ledger-cache'), JSON.stringify(fresh));
  assert.equal(typeof f.context.PiUsagePanel.refresh, 'function', 'manual refresh and deletion proof remain available');
});

test('invalid API data is rejected and never becomes a cache or an empty success', async () => {
  const f = fixture('{"version":2,"buckets":[{"role":"invalid"}]}');
  const request = f.context.PiUsagePanel.prefetch();
  f.resolveFetch();
  await assert.rejects(request, /Invalid execution role/);
  assert.equal(f.context.PiUsagePanel.read(), null);
  assert.equal(f.cache.has('pi-enh-usage-ledger-cache'), false);
  assert.equal(f.calls.length, 1, 'invalid data does not fall back to downloading the enhancement bundle');
});
