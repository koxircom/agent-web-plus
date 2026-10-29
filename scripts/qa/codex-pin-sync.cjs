const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '../..');
for (const args of [
  ['--test', 'lib/execution-engines/codex-pin-refresh.test.mjs', 'lib/enhancement-sidebar-bridge.test.mjs'],
  ['tests/codex-pin-source-owner.pw.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
