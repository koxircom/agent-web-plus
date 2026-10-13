'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../modules/02-plugin-registry-and-settings-schema.js'), 'utf8');
const start = source.indexOf('  let lastNativeSessionTagsSignature');
const section = source.slice(start < 0 ? source.indexOf('  function syncSessionTagsRow()') : start, source.indexOf('  let activeSessionTagsPopover'));

function fixture(bridgeReady = true) {
  let calls = 0;
  const state = {enabled: true, definitions: [{id: 'done', name: '完成'}], mappings: {a: ['done']}};
  const context = {JSON, window: {}, isPluginEnabled: () => state.enabled,
    readSessionTagsDefinitions: () => state.definitions,
    readSessionTagMappings: () => state.mappings, syncSessionOdooAddonsLayout() {}};
  const ready = () => {context.window.__PI_ENH_RERENDER_SESSIONS__ = () => calls++;};
  if (bridgeReady) ready();
  vm.runInNewContext(section + '\nthis.sync=syncSessionTags;this.row=syncSessionTagsRow;this.remove=removeSessionTagsRowAll;', context);
  return {context, state, ready, calls: () => calls};
}

test('unchanged periodic, row and observer sync publish one tag snapshot', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) { f.context.sync(); f.context.row(); }
  assert.equal(f.calls(), 1);
  // JSON from a repeated server response has different references but equal state.
  f.state.definitions = JSON.parse(JSON.stringify(f.state.definitions));
  f.state.mappings = JSON.parse(JSON.stringify(f.state.mappings));
  f.context.sync();
  assert.equal(f.calls(), 1);
});

test('definition, mapping and enable changes each notify the native sidebar', () => {
  const f = fixture(); f.context.sync();
  f.state.definitions[0].name = '已完成'; f.context.sync();
  f.state.mappings = {}; f.context.row();
  f.state.enabled = false; f.context.remove();
  f.state.enabled = true; f.context.sync();
  assert.equal(f.calls(), 5);
});

test('an unavailable native bridge does not consume the initial snapshot', () => {
  const f = fixture(false); f.context.sync(); f.ready(); f.context.sync();
  assert.equal(f.calls(), 1);
});

test('a remounted native sidebar receives the current snapshot once', () => {
  const f = fixture(); f.context.sync(); f.ready(); f.context.sync(); f.context.sync();
  assert.equal(f.calls(), 2);
});

test('a native render followed by sidebar sync settles without a notification loop', () => {
  const f = fixture(false);
  const pending = [];
  let renders = 0;
  f.context.window.__PI_ENH_RERENDER_SESSIONS__ = () => {
    renders++;
    pending.push(() => f.context.sync());
  };
  f.context.sync();
  for (let i = 0; pending.length && i < 10; i++) pending.shift()();
  assert.equal(pending.length, 0);
  assert.equal(renders, 1);
  f.state.mappings = {};
  f.context.row();
  for (let i = 0; pending.length && i < 10; i++) pending.shift()();
  assert.equal(pending.length, 0);
  assert.equal(renders, 2);
});

test('an empty filtered list does not re-render or restore stale bootstrap groups', () => {
  const section = source.slice(source.indexOf('  function syncSessionOdooAddonsLayout()'), source.indexOf('  // Explicit state notifications only.'));
  let renders = 0;
  let processed = 0;
  const context = {
    latestKnownSessionGroups: [],
    window: {
      __PI_ENH_EARLY_SESSION_GROUPS__: [{root: {id: 'a'}}],
      __PI_ENH_GET_RAW_SESSIONS__: () => [{id: 'a'}],
      __PI_ENH_RERENDER_SESSIONS__: () => renders++,
    },
    document: {querySelectorAll: () => []},
    processSessionGroups: () => processed++,
  };
  vm.runInNewContext(section + '\nsyncSessionOdooAddonsLayout();', context);
  assert.equal(renders, 0);
  assert.equal(processed, 0);
});
