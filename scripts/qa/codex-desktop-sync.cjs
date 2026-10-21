'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '../..');
const artifactDir = process.env.PI_CODEX_SYNC_ARTIFACT_DIR || path.join(root, 'scripts/qa/.quality-runs/artifacts');
fs.mkdirSync(artifactDir, { recursive: true });

const env = {
  ...process.env,
  PYTHONPATH: path.join(root, 'connectors/codex-bridge'),
  PI_CODEX_SYNC_ARTIFACT_DIR: artifactDir,
};

const commands = [
  {
    file: process.execPath,
    args: [
      '--test-concurrency=1',
      '--test',
      'lib/execution-engines/codex-metadata-sync.test.mjs',
      'lib/execution-engines/codex-fork.test.mjs',
      'lib/execution-engines/codex-projection.test.mjs',
      'lib/execution-engines/codex-delete.test.mjs',
      'lib/session-stats.test.mjs',
      'tests/fork-provenance-and-delete-guard.test.mjs',
      'app/api/sessions/batch-delete/route.test.mjs',
    ],
    cwd: root,
  },
  {
    file: 'python3',
    args: [
      '-m',
      'unittest',
      'test_active_writer',
      'test_contract',
      'test_queue_handoff',
      'test_shared_bridge',
      'test_fork_helper',
      'test_native_metadata_sync',
      'test_timeline_timestamp',
      '-q',
    ],
    cwd: path.join(root, 'connectors/codex-bridge/tests'),
  },
  {
    file: process.execPath,
    args: ['tests/codex-metadata-sync.pw.mjs'],
    cwd: root,
  },
  {
    file: process.execPath,
    args: ['tests/codex-user-message-fork.pw.mjs'],
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
