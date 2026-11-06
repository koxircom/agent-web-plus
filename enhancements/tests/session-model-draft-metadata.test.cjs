'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/02-plugin-registry-and-settings-schema.js'), 'utf8');
const start = source.indexOf('  const SESSION_MODEL_STORAGE_KEY =');
const end = source.indexOf('\n  const SESSION_COLOR_STORAGE_KEY =', start);
const modelMetadataSection = source.slice(start, end);
const storageKey = 'pi-enh-session-model-meta-v1';

function row(sessionId) {
  return {
    getAttribute(name) {
      return name === 'data-pi-enh-session-id' ? sessionId : null;
    },
  };
}

function fixture({ rows = [], responses = [], persisted = null } = {}) {
  let now = 1000;
  const timers = [];
  const requests = [];
  const rendered = [];
  const storage = new Map();
  if (persisted) storage.set(storageKey, JSON.stringify(persisted));

  const context = {
    isDisposed: false,
    Date: { now: () => now },
    document: { querySelectorAll: () => rows },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift() || { ok: false };
      return { ok: response.ok, json: async () => response.payload };
    },
    isPluginEnabled: () => true,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    renderSessionModelLabel: (target, metadata) => rendered.push({ target, metadata }),
    setTimeout(callback, delay) {
      if (delay === 600) timers.push(callback);
      else callback();
      return timers.length;
    },
    clearTimeout() {},
  };

  vm.createContext(context);
  vm.runInContext(`${modelMetadataSection}\nthis.api = {
    sync: syncSessionModelLabels,
    fetch: fetchSessionModelMetadata,
    enqueue: enqueueSessionModelMetadata,
    record: recordSessionModelMetadataFromPayload,
    persist: persistSessionModelMetadata,
    metadata: sessionModelMetadata,
    pending: pendingModelMetadataQueue,
  };`, context);
  // Only isolate the DOM renderer; exercise the actual queue/cache functions.
  context.renderSessionModelLabel = (target, metadata) => rendered.push({ target, metadata });

  return {
    api: context.api,
    requests,
    rendered,
    storage,
    setRows: nextRows => { rows = nextRows; },
    runPump: async () => {
      const callback = timers.shift();
      assert.equal(typeof callback, 'function', 'expected a queued metadata worker');
      await callback();
    },
    setNow: value => { now = value; },
    timerCount: () => timers.length,
  };
}

test('draft session rows stay out of requests and metadata; promotion to a real ID still fetches and renders', async () => {
  const draftId = 'new:550e8400-e29b-41d4-a716-446655440000:/workspace/odoo';
  const realId = '550e8400-e29b-41d4-a716-446655440001';
  const f = fixture({
    rows: [row(draftId)],
    persisted: {
      [draftId]: { provider: 'old', modelId: 'stale-draft-model', updatedAt: 1000 },
    },
    responses: [{
      ok: true,
      payload: { context: { model: { provider: 'test-provider', modelId: 'real-model' }, thinkingLevel: 'high' } },
    }],
  });

  assert.equal(f.api.metadata.has(draftId), false, 'persisted draft metadata must be ignored');
  f.api.sync();
  f.api.enqueue(draftId);
  await f.api.fetch(draftId);
  f.api.record(draftId, { context: { model: { modelId: 'draft-model' } } });
  assert.deepEqual(Array.from(f.api.pending), []);
  assert.equal(f.timerCount(), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.api.metadata.has(draftId), false);
  f.api.persist();
  assert.deepEqual(JSON.parse(f.storage.get(storageKey)), {});

  f.setRows([row(realId)]);
  f.api.sync();
  assert.equal(f.timerCount(), 1);
  await f.runPump();
  assert.deepEqual(f.requests.map(request => request.url), [
    `/api/sessions/${realId}?deferThinking=1&deferMedia=1&tail=1`,
  ]);
  assert.equal(f.api.metadata.get(realId).modelId, 'real-model');
  assert.deepEqual(Object.keys(JSON.parse(f.storage.get(storageKey))), [realId]);
  assert.equal(f.rendered.some(item => item.metadata?.modelId === 'real-model'), true);
});

test('a real session ID is fetched after row promotion and the existing 404 negative cache remains effective', async () => {
  const draftId = 'new:550e8400-e29b-41d4-a716-446655440000:/workspace/odoo';
  const realId = '550e8400-e29b-41d4-a716-446655440001';
  const f = fixture({ rows: [row(draftId), row(realId)], responses: [
    { ok: false },
    { ok: false },
  ] });

  f.api.sync();
  assert.equal(f.timerCount(), 1);
  await f.runPump();
  assert.deepEqual(f.requests.map(request => request.url), [
    `/api/sessions/${realId}?deferThinking=1&deferMedia=1&tail=1`,
  ]);
  assert.equal(f.api.metadata.get(realId).expiresAt, 6000);
  assert.equal(f.api.metadata.has(draftId), false);

  f.api.sync();
  assert.equal(f.timerCount(), 0, 'the five-second negative cache must suppress an immediate retry');
  f.setNow(6001);
  f.api.sync();
  assert.equal(f.timerCount(), 1, 'an expired negative cache may be retried');
  await f.runPump();
  assert.equal(f.requests.length, 2);
  assert.equal(f.api.metadata.has(draftId), false);
});

test('Codex sidebar reads model metadata from the existing state API without requesting history', async () => {
  const sid = 'codex:550e8400-e29b-41d4-a716-446655440001';
  const f = fixture({ rows: [row(sid)], responses: [{
    ok: true,
    payload: { state: { model: { provider: 'codex', id: 'gpt-6.1' }, thinkingLevel: 'high' } },
  }] });
  f.api.sync();
  await f.runPump();
  assert.deepEqual(f.requests.map(request => request.url), [`/api/agent/${encodeURIComponent(sid)}`]);
  assert.equal(f.api.metadata.get(sid).modelId, 'gpt-6.1');
  assert.equal(f.api.metadata.get(sid).thinkingLevel, 'high');
});
