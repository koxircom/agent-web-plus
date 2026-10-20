'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/image-editor.js'), 'utf8');
const start = source.indexOf('      function isActivePointer(event) {');
const end = source.indexOf('      canvas.addEventListener("pointerdown", onPointerDown);', start);
assert.notEqual(start, -1, 'image editor pointer helpers should exist');
assert.notEqual(end, -1, 'image editor pointer handlers should exist');
const pointerHandlers = source.slice(start, end);

function createHarness() {
  const context = {
    activeAction: null,
    activePointerId: null,
    actions: [],
    applyCropBtn: null,
    canvas: {
      width: 1000,
      height: 1000,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      setPointerCapture() {},
      releasePointerCapture() {},
    },
    color: '#ef4444',
    draftAction: null,
    drawing: false,
    isTwoFingerGesture: false,
    lastTwoFingerTime: 0,
    lineWidth: 4,
    MAX_UNDO_STEPS: 50,
    normalizeRect: () => ({ x: 0, y: 0, w: 0, h: 0 }),
    pointFromEvent: event => ({ x: event.x, y: event.y }),
    status: { textContent: '' },
    tool: 'rect',
    updateHistoryButtons() {},
    visibleRects: [],
  };
  context.redraw = () => {
    context.visibleRects = [...context.actions, ...(context.draftAction ? [context.draftAction] : [])]
      .filter(action => action.type === 'rect');
  };
  vm.createContext(context);
  vm.runInContext(`${pointerHandlers}\nglobalThis.handlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onEditorBlur };`, context);
  return context;
}

function pointer(pointerId, x, y, isPrimary = true) {
  return {
    pointerId,
    pointerType: 'touch',
    isPrimary,
    button: 0,
    x,
    y,
    preventDefault() {},
    stopPropagation() {},
  };
}

test('pointercancel discards an in-progress rectangle', () => {
  const h = createHarness();
  h.handlers.onPointerDown(pointer(1, 100, 100));
  h.handlers.onPointerMove(pointer(1, 500, 500));
  assert.equal(h.visibleRects.length, 1);

  h.handlers.onPointerCancel(pointer(1, 500, 500));

  assert.equal(h.actions.length, 0);
  assert.equal(h.draftAction, null);
  assert.equal(h.drawing, false);
  assert.equal(h.visibleRects.length, 0);
});

test('a secondary touch release cannot finish the primary pointer draft', () => {
  const h = createHarness();
  h.handlers.onPointerDown(pointer(1, 100, 100));
  h.handlers.onPointerMove(pointer(1, 500, 500));
  h.handlers.onPointerDown(pointer(2, 400, 400, false));
  h.handlers.onPointerUp(pointer(2, 400, 400, false));

  assert.equal(h.actions.length, 0);
  assert.notEqual(h.draftAction, null);

  h.handlers.onPointerUp(pointer(1, 500, 500));
  assert.equal(h.actions.length, 1);
});

test('rectangle drag threshold is measured in CSS pixels', () => {
  const tooSmall = createHarness();
  tooSmall.handlers.onPointerDown(pointer(1, 100, 100));
  tooSmall.handlers.onPointerMove(pointer(1, 130, 130)); // 3 CSS px at the configured canvas scale
  tooSmall.handlers.onPointerUp(pointer(1, 130, 130));
  assert.equal(tooSmall.actions.length, 0);

  const largeEnough = createHarness();
  largeEnough.handlers.onPointerDown(pointer(1, 100, 100));
  largeEnough.handlers.onPointerMove(pointer(1, 140, 140)); // 4 CSS px at the configured canvas scale
  largeEnough.handlers.onPointerUp(pointer(1, 140, 140));
  assert.equal(largeEnough.actions.length, 1);
});

test('window blur and a released pointer discard drafts without removing completed annotations', () => {
  for (const interrupt of ['blur', 'released']) {
    const h = createHarness();
    h.handlers.onPointerDown(pointer(1,100,100));
    h.handlers.onPointerMove(pointer(1,500,500));
    h.handlers.onPointerUp(pointer(1,500,500));
    h.handlers.onPointerDown(pointer(1,600,600));
    h.handlers.onPointerMove(pointer(1,900,900));
    if (interrupt === 'blur') h.handlers.onEditorBlur();
    else h.handlers.onPointerMove({...pointer(1,950,950), buttons:0});
    assert.equal(h.actions.length,1);
    assert.equal(h.draftAction,null);
    assert.equal(h.drawing,false);
    assert.equal(h.visibleRects.length,1);
  }
});

test('capture loss from another pointer does not cancel the active drawing', () => {
  const h = createHarness();
  h.handlers.onPointerDown(pointer(1,100,100));
  h.handlers.onPointerMove(pointer(1,500,500));
  h.handlers.onPointerCancel(pointer(2,500,500,false));
  assert.equal(h.drawing,true);
  h.handlers.onPointerUp(pointer(1,500,500));
  assert.equal(h.actions.length,1);
});
