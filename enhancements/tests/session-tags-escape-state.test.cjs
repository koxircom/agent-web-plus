const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulesDir = path.join(__dirname, '../modules');
const registrySource = fs.readFileSync(path.join(modulesDir, '02-plugin-registry-and-settings-schema.js'), 'utf8');
const sidebarSource = fs.readFileSync(path.join(modulesDir, '04-sidebar-and-session-management.js'), 'utf8');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Escape closes the sidebar menu with session tag popover state owned by module 02', () => {
  const state = registrySource.match(/^  let activeSessionTagsPopover = null;\n  let activeSessionTagsCleanup = null;\n  let activeSessionTagsTriggerItem = null;$/m);

  const closePopover = extract(registrySource, '  function closeSessionTagsPopover(', '\n  function openSessionTagsPopover(');
  const closeMenu = extract(sidebarSource, '  function closeMenu() {', '\n  window.__PI_ENH_SET_ACTIVE_MENU__');
  const escapeHandler = extract(sidebarSource, '  function handleGlobalEscapeKey(e) {', '\n  addManagedListener(document, "keydown", handleGlobalEscapeKey');
  const menu = {
    removed: false,
    querySelector() { return null; },
    remove() { this.removed = true; },
  };
  const eventCalls = [];
  const context = {
    activeMenu: menu,
    document: { querySelector() { return null; } },
    usageDashboardModal: null,
    batchDeleteModal: null,
    isSessionBatchMode: false,
    annotationEditor: null,
    closeNativeQuoteSelectionToolbar() { return false; },
    durationTooltip: null,
    usageTooltip: null,
    hideAllTooltips() {},
  };
  const handler = vm.runInNewContext(
    `${state ? state[0] : ''}\n${closePopover}\n${closeMenu}\n${escapeHandler}\nhandleGlobalEscapeKey`,
    context,
  );

  handler({
    key: 'Escape',
    preventDefault() { eventCalls.push('preventDefault'); },
    stopPropagation() { eventCalls.push('stopPropagation'); },
    stopImmediatePropagation() { eventCalls.push('stopImmediatePropagation'); },
  });

  assert.equal(menu.removed, true);
  assert.deepEqual(eventCalls, ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']);
});
