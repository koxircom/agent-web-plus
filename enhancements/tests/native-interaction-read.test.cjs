'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../modules/03-session-cache-and-sync-engine.js'), 'utf8');
const from = source.indexOf('  async function cachedSessionFetch(');
const to = source.indexOf('  function navigateSessionWithoutRsc(', from);
assert(from >= 0 && to > from);
function fixture() {
  const requests = [];
  const ctx = {
    baseFetch: async (input, init) => { requests.push({ input, init }); return { live: true }; },
    isPluginEnabled: () => true,
    isPrimarySessionDetailUrl: () => false,
    extractSessionIdFromUrl: () => 'session',
    knownSessionsMap: new Map([['session', {}]]),
    getOrCreateSessionEntry: () => ({ isRunning: false, state: { data: { running: false } } }),
    isChatSessionRunning: () => false,
    createCachedResponse: () => ({ cached: true }),
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(from, to) + '\nthis.read = cachedSessionFetch;', ctx);
  return { read: ctx.read, requests };
}
test('live interaction reads bypass an idle session cache and preserve cancellation options', async () => {
  const f = fixture(), controller = new AbortController();
  for (const input of ['/api/agent/session?interactions=1',
    new Request('http://localhost/api/agent/session?other=1&interactions=1')]) {
    const init = { cache: 'no-store', signal: controller.signal };
    assert.equal((await f.read(input, init)).live, true);
    assert.equal(f.requests.at(-1).input, input);
    assert.equal(f.requests.at(-1).init, init);
  }
  assert.equal(f.requests.length, 2);
});
test('ordinary idle-state reads keep their existing cache contract', async () => {
  const f = fixture();
  for (const url of ['/api/agent/session', '/api/agent/session?interactions=0']) {
    assert.equal((await f.read(url, { cache: 'no-store' })).cached, true);
  }
  assert.equal(f.requests.length, 0);
});

test('prompt receipts bypass idle-state substitution and preserve the original request', async () => {
  const f = fixture(), controller = new AbortController();
  for (const input of ['/api/agent/session?requestId=' + 'a'.repeat(32),
    new Request('http://localhost/api/agent/session?other=1&requestId=' + 'b'.repeat(32))]) {
    const init = {cache:'no-store',signal:controller.signal};
    assert.equal((await f.read(input,init)).live,true);
    assert.equal(f.requests.at(-1).input,input);
    assert.equal(f.requests.at(-1).init,init);
  }
  assert.equal(f.requests.length,2);
});
