import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { resolveDomSource, normalizeDomCodeLocation } = await createJiti(import.meta.url).import('./source.ts');
const map = JSON.stringify({ version: 3, sources: ['src/Card.tsx'], sourcesContent: ['never transmit this source body'], names: [], mappings: 'AAAA' });
const hint = url => ({ frames: [{ url, line: 1, column: 1 }], componentName: 'Card' });

test('local sibling map uses existing authenticated engine/session file route without widening iframe sandbox', async () => {
  for (const engine of ['pi', 'codex']) {
    const requests = [];
    const result = await resolveDomSource(hint('file:///workspace/demo/app.js'), {
      pageUrl: 'http://127.0.0.1:30141/', filePath: '/workspace/demo/preview.html', sourceSessionId: engine + ':fixture', executionEngine: engine,
      html: '<script>let x=1;\n//# sourceMappingURL=app.js.map\n//# sourceURL=file:///workspace/demo/app.js\n</script>', signal: new AbortController().signal,
      load: async (url, signal) => { assert.equal(signal.aborted, false); requests.push(url); return map; },
    });
    assert.equal(result.filePath, 'src/Card.tsx'); assert.equal(result.line, 1); assert.equal(result.column, 1);
    assert.equal(requests.length, 1);
    const url = new URL(requests[0]);
    assert.equal(url.pathname, '/api/files/workspace/demo/app.js.map');
    assert.equal(url.searchParams.get('engine'), engine); assert.equal(url.searchParams.get('sessionId'), engine + ':fixture');
    assert.equal(url.searchParams.get('type'), 'download');
    assert.ok(!JSON.stringify(result).includes('source body'));
  }
});

test('untrusted hints cannot fetch cross-origin/API endpoints or files above the selected preview directory', async () => {
  for (const url of ['https://external.test/bundle.js', 'http://127.0.0.1:30141/api/private.js', 'http://127.0.0.1:30141/%61pi/private.js', 'file:///workspace/other/private.js']) {
    let requests = 0;
    const result = await resolveDomSource(hint(url), {
      pageUrl: 'http://127.0.0.1:30141/', filePath: '/workspace/demo/preview.html', signal: new AbortController().signal,
      load: async () => { requests++; return map; },
    });
    assert.equal(result, null, url); assert.equal(requests, 0, url);
  }
});

test('source location is bounded and URL credentials/query values never enter the annotation', () => {
  const result = normalizeDomCodeLocation({ filePath: 'https://u:secret@host/src/Card.tsx?token=secret#private', line: 12, column: 5, method: 'sourcemap', componentName: 'Card' });
  assert.equal(result.filePath, 'https://host/src/Card.tsx');
  for (const changed of [{ line: 0 }, { line: Infinity }, { column: -1 }, { componentName: 'a'.repeat(129) }, { filePath: 'javascript:alert(1)' }]) {
    assert.equal(normalizeDomCodeLocation({ ...result, ...changed }), null);
  }
});

test('multiple stack frames from one bundle read each asset only once per selection', async () => {
  const calls = [];
  const result = await resolveDomSource({ componentName: null, frames: [
    { url: 'http://127.0.0.1:30141/bundle.js', line: 1, column: 1 },
    { url: 'http://127.0.0.1:30141/bundle.js', line: 2, column: 1 },
  ] }, {
    pageUrl: 'http://127.0.0.1:30141/', signal: new AbortController().signal,
    load: async url => { calls.push(url); return url.endsWith('.map')
      ? JSON.stringify({ version: 3, sources: ['node_modules/react/index.js', 'src/Card.tsx'], names: [], mappings: 'AAAA;ACAA' })
      : 'react();\ncard();\n//# sourceMappingURL=bundle.js.map'; },
  });
  assert.equal(result.filePath, 'src/Card.tsx');
  assert.deepEqual(calls, ['http://127.0.0.1:30141/bundle.js', 'http://127.0.0.1:30141/bundle.js.map']);
});
