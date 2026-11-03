const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '../..');
for (const [args, env] of [
  [['--test', 'lib/session-batch-delete.test.mjs', 'lib/session-delete-jobs.test.mjs', 'tests/session-delete-jobs-http.test.mjs', 'enhancements/tests/batch-session-delete.test.cjs', 'enhancements/tests/batch-delete-result-details.test.cjs', 'enhancements/tests/batch-range-selection.test.cjs', 'enhancements/tests/batch-row-decorations.test.cjs', 'enhancements/tests/batch-touch-activation.test.cjs', 'enhancements/tests/batch-delete-dismiss.test.cjs', 'enhancements/tests/session-delete-cleanup.test.cjs'], {}],
  [['tests/codex-bulk-delete-progress.pw.mjs'], {}],
]) {
  const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
