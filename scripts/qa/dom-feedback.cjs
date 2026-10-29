'use strict';
const { spawnSync } = require('node:child_process'), path = require('node:path');
for (const args of [
  ['scripts/prepare-dom-feedback-assets.cjs', '--verify'],
  ['--test', 'lib/dom-feedback/target.test.mjs', 'lib/dom-feedback/source.test.mjs', 'lib/dom-feedback/source-assets.test.mjs', 'lib/dom-feedback/capture.test.mjs', 'components/dom-feedback/DomFeedbackPicker.test.mjs'],
  ['tests/dom-feedback.pw.mjs'],
  ['tests/dom-feedback-sourcemap.pw.mjs'],
  ['tests/dom-feedback-page.pw.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
