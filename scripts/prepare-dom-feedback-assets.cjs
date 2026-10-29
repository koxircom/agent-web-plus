/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS build script */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), moduleRoot = path.dirname(require.resolve('html-to-image/package.json'));
assert.equal(require(path.join(moduleRoot, 'package.json')).version, '1.11.13');
const files = { 'dist/html-to-image.js': 'html-to-image-1.11.13.js', LICENSE: 'LICENSE' };
for (const [from, to] of Object.entries(files)) {
  const source = fs.readFileSync(path.join(moduleRoot, from)), target = path.join(root, 'public/dom-feedback', to);
  if (process.argv.includes('--verify')) assert(source.equals(fs.readFileSync(target)), 'DOM capture asset differs: ' + to);
  else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source); }
}
console.log('DOM capture 1.11.13 local assets verified');
