'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../modules/03-session-cache-and-sync-engine.js'), 'utf8');
const start = source.indexOf('  function renderSearchHighlight(');
const end = source.indexOf('\n  function highlightSearchResultsKeywords(', start);
assert.ok(start >= 0 && end > start);
const context = { escapeHtml: (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
test('highlights literal ampersands without corrupting HTML entities', () => {
  assert.equal(context.renderSearchHighlight('A & B', /(&)/gi), 'A <mark class="pi-enh-search-highlight">&amp;</mark> B');
});
test('escapes matched and unmatched markup while preserving separate matches', () => {
  assert.equal(context.renderSearchHighlight('<tag> & <tag>', /(<tag>)/gi), '<mark class="pi-enh-search-highlight">&lt;tag&gt;</mark> &amp; <mark class="pi-enh-search-highlight">&lt;tag&gt;</mark>');
});
test('unmatched text remains escaped', () => {
  assert.equal(context.renderSearchHighlight('<unsafe>', /(absent)/gi), '&lt;unsafe&gt;');
});
test('refresh preserves the focused match when its rendered text is unchanged', () => {
  let originalChanged = false;
  const element = {
    innerHTML: 'focused markup',
    querySelector: () => ({}),
    cloneNode: () => ({
      innerHTML: 'normal markup',
      querySelectorAll: () => [{classList: {remove: (name) => assert.equal(name, 'is-focused-mark')}}],
    }),
    setAttribute: () => { originalChanged = true; },
  };
  assert.equal(context.searchHighlightMatches(element, 'normal markup'), true);
  assert.equal(context.searchHighlightMatches(element, 'different markup'), false);
  assert.equal(originalChanged, false);
});
