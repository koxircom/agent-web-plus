const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
for (const args of [
  ['--experimental-strip-types','--test','lib/learning.test.mjs'],
  ['tests/learning-settings-page.pw.mjs'],
]) {
  const result = spawnSync(process.execPath, args, {cwd:root,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
