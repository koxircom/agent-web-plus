import assert from 'node:assert/strict';
import test from 'node:test';
import { codexImagePath } from './codex-image-path.ts';

const thread = '12345678-1234-1234-1234-123456789abc';
const upload = 'abcdefab-1234-1234-1234-123456789abc';
const desktop = 'a'.repeat(64);

test('image paths accept exactly one scoped image identity', () => {
  assert.equal(codexImagePath(thread, upload, null), `/api/sessions/${thread}/uploads/${upload}/preview?variant=original`);
  assert.equal(codexImagePath(thread, null, desktop), `/api/sessions/${thread}/desktop-images/${desktop}`);
  for (const args of [[thread, upload, desktop], [thread, null, null], ['-'.repeat(36), upload, null],
    [thread, 'b'.repeat(36), null], [thread, null, 'z'.repeat(64)]]) {
    assert.equal(codexImagePath(...args), null);
  }
});
