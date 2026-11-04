'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/03-session-cache-and-sync-engine.js'), 'utf8');
const start = source.indexOf('  addManagedListener(window, "keydown", (e) => {\n    const target = e.target;');
const end = source.indexOf('\n  function syncSessionSearchTagFilterBar()', start);
assert.ok(start >= 0 && end > start);

function fixture(hovered) {
  const actions = [];
  const context = { window: {}, activeSearchFocusedCard: hovered, navigateCardSnippets: (card, direction) => actions.push([card, direction]), addManagedListener: (_window, _event, callback) => { context.keydown = callback; } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { actions, run(target, key = 'ArrowDown') { const event = { target, key, preventDefault() { this.prevented = true; }, stopPropagation() {} }; context.keydown(event); return event; } };
}
const card = () => ({ querySelectorAll: () => [{}, {}] });
test('arrow keys navigate the focused result without mouse hover', () => {
  const result = card();
  const f = fixture(null);
  const target = { closest(selector) { return selector.includes('data-search-session-id') ? result : null; } };
  assert.equal(f.run(target).prevented, true);
  assert.deepEqual(f.actions, [[result, 1]]);
});
test('arrow keys also work when the result itself is focused', () => {
  const result = card();
  result.closest = (selector) => selector.includes('data-search-session-id') ? result : null;
  const f = fixture(null);
  assert.equal(f.run(result, 'ArrowUp').prevented, true);
  assert.deepEqual(f.actions, [[result, -1]]);
});
test('typing controls keep their arrow keys even while a result is hovered', () => {
  const f = fixture(card());
  const event = f.run({ closest: () => ({}) });
  assert.equal(event.prevented, undefined);
  assert.deepEqual(f.actions, []);
});
test('hover navigation still works outside editable controls', () => {
  const result = card();
  const f = fixture(result);
  assert.equal(f.run({ closest: () => null }, 'ArrowUp').prevented, true);
  assert.deepEqual(f.actions, [[result, -1]]);
});
