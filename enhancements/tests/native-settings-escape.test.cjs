const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../modules/04-sidebar-and-session-management.js'), 'utf8');
const start = source.indexOf('  function handleGlobalEscapeKey(e) {');
const end = source.indexOf('\n  addManagedListener(document, "keydown", handleGlobalEscapeKey', start);
const handler = source.slice(start, end);

test('global Escape leaves native Settings and its nested dialogs to their owner', () => {
  const calls = [];
  const document = { querySelector(selector) {
    calls.push(selector);
    assert.equal(selector, '.settings-dialog-backdrop');
    return { click() { assert.fail('must not close native Settings'); } };
  } };
  const run = vm.runInNewContext(handler + '\nhandleGlobalEscapeKey', { document });
  run({ key: 'Escape', preventDefault() { assert.fail('native owner must receive Escape'); }, stopPropagation() { assert.fail('native owner must receive Escape'); } });
  assert.deepEqual(calls, ['.settings-dialog-backdrop']);
});

test('handled and composition Escape do not touch global overlays', () => {
  const run = vm.runInNewContext(handler + '\nhandleGlobalEscapeKey', {
    document: { querySelector() { assert.fail('must not inspect or close overlays'); } },
  });
  for (const flags of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) {
    run({ key: 'Escape', ...flags });
  }
});
