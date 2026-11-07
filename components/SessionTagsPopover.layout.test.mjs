import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../app/enhancements.css',import.meta.url),'utf8');
const moduleSource=readFileSync(new URL('../enhancements/modules/02-plugin-registry-and-settings-schema.js',import.meta.url),'utf8');
const section=moduleSource.slice(moduleSource.indexOf('  function openSessionTagsPopover('),moduleSource.indexOf('  function renderTagsPanel('));
test('tag submenu has content-sized list with only viewport overflow',()=>{
 const list=css.match(/\.pi-enh-tags-list\s*\{([^}]+)\}/)?.[1];
 assert(list);assert.doesNotMatch(list,/max-height:\s*180px/);assert.match(list,/min-height:\s*0/);assert.match(list,/overflow-y:\s*auto/);
 assert.match(css,/\.pi-enh-session-tags-popover\s*\{[^}]*max-height:\s*calc\(100dvh - 16px\)/);
 assert.match(css,/\.pi-enh-tag-option\s*\{[^}]*flex-shrink:\s*0/);
});
test('popover measures actual height and clamps against visual viewport',()=>{
 assert.doesNotMatch(section,/const pHeight = 260/);
 assert.match(section,/const pHeight = popover\.offsetHeight/);
 assert.match(section,/window\.visualViewport/);
 assert.match(section,/listEl\.innerHTML = html;\s*if \(popover\.isConnected\) positionPopover\(\)/);
 for(const type of ['resize','scroll']){
  assert(section.includes(`window.visualViewport?.addEventListener("${type}", positionPopover)`));
  assert(section.includes(`window.visualViewport?.removeEventListener("${type}", positionPopover)`));
 }
 assert.match(section,/window\.removeEventListener\("resize", positionPopover\)/);
});
