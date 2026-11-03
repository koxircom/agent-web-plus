const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../modules/05-composer-and-input-workflow.js'), 'utf8');
const start = source.indexOf('  function syncBatchDeleteJobEntry()');
const end = source.indexOf('  function stopBatchDeleteObserver()', start);
assert.ok(start >= 0 && end > start);

function fixture(done = true) {
  const listeners = new Map();
  let entry = null;
  let pointerClears = 0;
  let opened = 0;
  const sandbox = {
    batchDeleteJob: { id: 'owned-job', ids: ['owned-session'], processed: 1, status: 'completed', done },
    batchDeleteJobEntry: null,
    isPluginEnabled: () => true,
    isBatchDeleteJobTerminal: () => Boolean(sandbox.batchDeleteJob?.done),
    clearBatchDeleteJobPointer: () => { pointerClears++; },
    closeBatchDeleteModal: () => {},
    openBatchDeleteJobModal: () => { opened++; },
    removeBatchDeleteJobEntry: () => { entry = null; sandbox.batchDeleteJobEntry = null; },
    document: {
      getElementById: () => entry,
      createElement: () => ({ style: {}, setAttribute() {}, setPointerCapture() {},
        addEventListener(type, fn) { listeners.set(type, fn); } }),
      body: { appendChild(value) { entry = value; } },
    },
  };
  vm.runInNewContext(source.slice(start, end), sandbox);
  sandbox.syncBatchDeleteJobEntry();
  function send(type, x, y, overrides = {}) {
    const event = { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y,
      preventDefault() { this.prevented = true; }, ...overrides };
    listeners.get(type)?.(event);
    return event;
  }
  return { sandbox, send, clears: () => pointerClears, opened: () => opened, entry: () => entry };
}

for (const direction of [-1, 1]) {
  test(`terminal job horizontal swipe ${direction} clears only the saved job pointer`, () => {
    const f = fixture();
    f.send('pointerdown', 100, 100);
    const end = f.send('pointerup', 100 + direction * 80, 105);
    assert.equal(f.clears(), 1);
    assert.equal(f.sandbox.batchDeleteJob, null);
    assert.equal(f.entry(), null);
    assert.equal(end.prevented, true);
  });
}
test('running job cannot be dismissed with a horizontal swipe', () => {
  const f = fixture(false); f.send('pointerdown', 100, 100); f.send('pointerup', 200, 100);
  assert.equal(f.clears(), 0); assert.ok(f.entry());
});
test('short tap and vertical scroll preserve the prompt and normal click', () => {
  const f = fixture(); f.send('pointerdown', 100, 100); f.send('pointerup', 110, 105);
  f.send('click'); assert.equal(f.opened(), 1);
  f.send('pointerdown', 100, 100); f.send('pointerup', 180, 200);
  assert.equal(f.clears(), 0);
});
test('cancelled or lost pointer capture cannot dismiss the job', () => {
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const f = fixture(); f.send('pointerdown', 100, 100); f.send(type, 130, 100); f.send('pointerup', 200, 100);
    assert.equal(f.clears(), 0);
  }
});
test('a second pointer cancels the gesture', () => {
  const f = fixture(); f.send('pointerdown', 100, 100);
  f.send('pointerdown', 110, 100, { pointerId: 2, isPrimary: false }); f.send('pointerup', 200, 100);
  assert.equal(f.clears(), 0);
});
test('a stale gesture cannot dismiss a replacement job', () => {
  const f = fixture(); f.send('pointerdown', 100, 100);
  f.sandbox.batchDeleteJob = { done: true, ids: ['another'] }; f.send('pointerup', 200, 100);
  assert.equal(f.clears(), 0);
});
