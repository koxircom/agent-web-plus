'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/05-composer-and-input-workflow.js'), 'utf8');
const start = source.indexOf('  function ensureBatchCheckboxOnRow(');
const end = source.indexOf('\n  function updateSingleBatchRow(', start);
assert.ok(start >= 0 && end > start);

test('checkbox identifies the displayed session and follows row reuse', () => {
  const makeElement = () => ({
    attributes: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    appendChild(child) { this.children.push(child); },
    querySelector() { return this.children[0]; },
  });
  const context = { document: { createElement: makeElement } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const row = {
    title: '第一条会话', firstElementChild: {}, wrap: null,
    querySelector() { return this.wrap; },
    getAttribute(name) { return name === 'data-pi-enh-session-title' ? this.title : name === 'data-pi-enh-session-title-id' ? ':test-title:' : null; },
    insertBefore(wrap) { this.wrap = wrap; },
  };
  const checkbox = context.ensureBatchCheckboxOnRow(row, 'one').children[0];
  assert.equal(checkbox.attributes['aria-label'], '选择会话：第一条会话');
  assert.equal(checkbox.attributes['aria-labelledby'], ':test-title:');
  row.title = '第二条会话';
  assert.equal(context.ensureBatchCheckboxOnRow(row, 'two').children[0], checkbox);
  assert.equal(checkbox.attributes['aria-label'], '选择会话：第二条会话');
  assert.equal(checkbox.attributes['data-session-id'], 'two');
  row.title = '';
  context.ensureBatchCheckboxOnRow(row, 'two');
  assert.equal(checkbox.attributes['aria-label'], '选择会话：two');
});
