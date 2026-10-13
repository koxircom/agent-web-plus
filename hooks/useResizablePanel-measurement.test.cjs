'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');

test('panel renders reuse measured bounds; resize updates bounds, width and ARIA together', () => {
  const slots = [], effects = [], listeners = new Map();
  let cursor = 0, reads = 0, maximum = 800;
  const effect = (callback, dependencies) => {
    const index = cursor++;
    const prior = slots[index];
    if (!prior || !dependencies || dependencies.some((value, i) => value !== prior.dependencies[i])) {
      slots[index] = { dependencies };
      effects.push(() => { prior?.cleanup?.(); slots[index].cleanup = callback(); });
    }
  };
  const react = {
    useCallback: callback => callback,
    useRef: initial => slots[cursor++] ??= { current: initial },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
  const module = { exports: {} };
  const source = fs.readFileSync(__dirname + '/useResizablePanel.ts', 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : { clampPanelWidth: (value, min, max) => Math.min(max, Math.max(min, value)) },
    window: {
      localStorage: { getItem: () => null, setItem() {} },
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name),
    },
    document: { body: { style: {} }, addEventListener() {}, removeEventListener() {} },
  });
  const options = {
    ariaLabel: 'Panel', cssVariable: '--panel', defaultWidth: 600,
    getMaxWidth: () => { reads++; return maximum; },
    growthDirection: 'right', maxWidth: 1000, minWidth: 100,
    storageKey: 'panel', widthRef: { current: 600 },
  };
  const render = () => { cursor = 0; return module.exports.useResizablePanel(options); };
  const flushEffects = () => { while (effects.length) effects.shift()(); };

  assert.equal(render().separatorProps['aria-valuemax'], 1000, 'server-safe initial bound');
  assert.equal(reads, 0, 'render must not measure DOM');
  flushEffects();
  const measured = reads;
  assert.equal(render().separatorProps['aria-valuemax'], 800);
  render();
  assert.equal(reads, measured, 'unrelated renders must not force layout');

  maximum = 400;
  listeners.get('resize')();
  const resized = render();
  assert.equal(resized.separatorProps['aria-valuemax'], 400);
  assert.equal(resized.separatorProps['aria-valuenow'], 400);
  assert.equal(options.widthRef.current, 400);
  maximum = 900;
  resized.reclampWidth();
  assert.equal(render().separatorProps['aria-valuemax'], 900, 'explicit pane layout changes refresh bounds');
});
