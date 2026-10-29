import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { captureBoundedElement, captureFrameTarget } = await createJiti(import.meta.url).import('./capture.ts');

function element(width = 120, height = 48, descendants = 0) {
  let visits = 0;
  return {
    getBoundingClientRect: () => ({ width, height }),
    ownerDocument: { createTreeWalker: () => ({ nextNode: () => ++visits <= descendants ? {} : null }) },
    visits: () => visits,
  };
}

test('large targets stop before rasterization and descendant collection stops at 401 nodes', async () => {
  let calls = 0;
  const raster = async () => { calls++; return new Blob(['png']); };
  const huge = element(2401);
  await assert.rejects(captureBoundedElement(huge, raster), /范围较大/);
  assert.equal(huge.visits(), 0);
  const many = element(120, 48, 10000);
  await assert.rejects(captureBoundedElement(many, raster), /范围较大/);
  assert.equal(many.visits(), 401);
  assert.equal(calls, 0);
});

test('capture uses bounded output and filters editable values', async () => {
  let options;
  await captureBoundedElement(element(2400, 1200), async (_, value) => { options = value; return new Blob(['png']); });
  assert.equal(options.canvasWidth, 1280);
  assert.equal(options.canvasHeight, 640);
  assert.equal(options.skipFonts, true);
  assert.equal(options.pixelRatio, 1);
  assert.equal(options.filter({ matches: selector => selector.includes('textarea') }), false);
});

test('closing during an unfinished image capture aborts resource requests immediately', async () => {
  const controller = new AbortController();
  let resourceSignal;
  const pending = captureBoundedElement(element(), async (_, options) => {
    resourceSignal = options.fetchRequestInit.signal;
    return new Promise(() => {});
  }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /已取消/);
  assert.equal(resourceSignal.aborted, true);
});

test('closing a frame capture removes the pending message listener and cancels that exact frame request', async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const listeners = new Set(), messages = [];
  const frame = { dataset: { domFeedbackToken: 'fixture-token', domFeedbackFilePath: '/fixture.html' }, contentWindow: { postMessage: value => messages.push(value) } };
  globalThis.window = { addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) };
  globalThis.document = { querySelectorAll: () => [frame] };
  try {
    const controller = new AbortController();
    const pending = captureFrameTarget({ source: { filePath: '/fixture.html' } }, controller.signal);
    assert.equal(listeners.size, 1);
    controller.abort();
    assert.equal(listeners.size, 0);
    await assert.rejects(pending, /已取消/);
    assert.equal(messages[0].action, 'capture');
    assert.equal(messages[1].action, 'cancel-capture');
    assert.equal(messages[1].requestId, messages[0].requestId);
    assert.equal(messages[1].token, 'fixture-token');
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});
