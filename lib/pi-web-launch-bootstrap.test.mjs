import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the actual launcher preloads its SDK bootstrap with a portable file URL', () => {
  const cli = process.env.PI_WEB_TEST_CLI || fileURLToPath(new URL('../bin/pi-web.js', import.meta.url));
  const realRequire = createRequire(cli);
  let spawned;
  const mockRequire = (name) => {
    // This unit exercises argv wiring, independent of an existing production build.
    if (name === 'fs') return { ...fs, existsSync: value =>
      value === path.join(path.dirname(cli), '..', '.next') || fs.existsSync(value) };
    if (name === 'child_process') return { spawn: (exe, args) => {
      spawned = { exe, args };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      return child;
    }};
    if (name === './process-lifecycle') return { wireChildProcessLifecycle() {} };
    if (name === './pi-web-options') return { parseLaunchOptions: () => ({ port: '30141', hostname: '127.0.0.1', openBrowser: false }) };
    return realRequire(name);
  };
  mockRequire.resolve = realRequire.resolve;
  vm.runInNewContext(fs.readFileSync(cli, 'utf8'), { require: mockRequire, __dirname: path.dirname(cli), process, console });
  assert.equal(spawned.exe, process.execPath);
  assert.equal(spawned.args[0], '--import');
  assert.equal(new URL(spawned.args[1]).protocol, 'file:');
  assert.equal(fileURLToPath(spawned.args[1]), path.join(path.dirname(cli), 'pi-agent-runtime-bootstrap.mjs'));
  const env = { ...process.env };
  delete env.PI_WEB_PORT; // The bootstrap exits without opening any agent or writing runtime state.
  assert.equal(execFileSync(process.execPath, ['--import', spawned.args[1], '-e', 'process.stdout.write("preload-ok")'], { env, encoding: 'utf8' }), 'preload-ok');
});
