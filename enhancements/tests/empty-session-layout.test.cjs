'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../modules/02-plugin-registry-and-settings-schema.js'), 'utf8');
const body = source.slice(source.indexOf('  function syncSessionOdooAddonsLayout()'), source.indexOf('  function syncSessionOdooAddons()'));
test('empty engine/project result never resurrects bootstrap groups or requests render', () => {
  let renders = 0, restored = 0;
  const context = {latestKnownSessionGroups: [], window: {
    __PI_ENH_EARLY_SESSION_GROUPS__: [{root:{id:'old-pi-session'}}],
    __PI_ENH_GET_RAW_SESSIONS__: () => [{id:'codex:other-project'}],
    __PI_ENH_RERENDER_SESSIONS__: () => renders++,
  }, document:{querySelectorAll:()=>[]}, processSessionGroups:()=>restored++};
  vm.runInNewContext(body+'\nfor(let i=0;i<20;i++)syncSessionOdooAddonsLayout();', context);
  assert.equal(renders,0); assert.equal(restored,0);
});
