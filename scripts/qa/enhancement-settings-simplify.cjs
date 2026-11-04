const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
for (const args of [
  ['--experimental-strip-types','--test','enhancements/tests/core-feature-settings.test.cjs','enhancements/tests/modules-panel-renderer.test.cjs','lib/enhancement-chat-bridge.test.mjs','lib/settings-extensions.test.mjs'],
  ['tests/enhancement-settings-simplify.pw.mjs'],
]) {
  const result = spawnSync(process.execPath, args, {cwd:root,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
