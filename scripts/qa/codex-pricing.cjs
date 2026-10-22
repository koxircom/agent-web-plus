'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '../..');
const artifactDir = process.env.PI_CODEX_PRICING_ARTIFACT_DIR || path.join(root, 'scripts/qa/.quality-runs/artifacts');
fs.mkdirSync(artifactDir, { recursive: true });

const env = {
  ...process.env,
  PYTHONPATH: path.join(root, 'connectors/codex-bridge'),
  PI_CODEX_PRICING_ARTIFACT_DIR: artifactDir,
};

const commands = [
  {
    file: process.execPath,
    args: [
      '--test-concurrency=1',
      '--test',
      'lib/model-catalog-refresh.test.mjs',
      'lib/usage-pricing.test.mjs',
      'lib/usage-pricing-routes.test.mjs',
      'tests/codex-pricing.test.mjs',
    ],
    cwd: root,
  },
  {
    file: process.execPath,
    args: ['tests/codex-pricing.pw.mjs'],
    cwd: root,
  },
];

for (const c of commands) {
  const result = spawnSync(c.file, c.args, {
    cwd: c.cwd || root,
    stdio: 'inherit',
    shell: false,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
