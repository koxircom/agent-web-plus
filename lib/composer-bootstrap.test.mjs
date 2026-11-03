import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const module05 = fs.readFileSync(new URL('../enhancements/modules/05-composer-and-input-workflow.js', import.meta.url), 'utf8');
const component = fs.readFileSync(new URL('../components/ComposerQueue.tsx', import.meta.url), 'utf8');
const hook = fs.readFileSync(new URL('../hooks/useComposerQueueBridge.ts', import.meta.url), 'utf8');

test('native queue starts from explicit React session identity without synchronous enhancement bootstrap', () => {
  for (const retired of ['pi:native-queue-ready', 'pi:native-queue-snapshot', 'getEffectiveQueueSessionId', 'composerQueueNativeHost']) {
    assert.equal(module05.includes(retired), false, `${retired} must remain retired`);
  }
  assert.match(component, /useComposerQueueBridge\(/);
  assert.match(hook, /fetchQueueActions\(sessionId, controller\.signal\)/);
  assert.match(hook, /generationRef\.current !== gen/);
  assert.match(hook, /\[sessionId, signature, actionsEnabled, pluginEnabled\]/);
});

test('central scheduler has no references to retired queue bridge', () => {
  for (const file of fs.readdirSync(new URL('../enhancements/modules/', import.meta.url)).filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(new URL('../enhancements/modules/' + file, import.meta.url), 'utf8');
    for (const retired of ['syncComposerQueuePanel', 'fetchQueuedMessageDetail', 'pi:native-queue-snapshot', 'pi:native-queue-action']) {
      assert.equal(source.includes(retired), false, `${file}: retired queue reference ${retired}`);
    }
  }
});
