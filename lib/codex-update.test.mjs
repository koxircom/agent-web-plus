import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { isNewerReleaseVersion } from './release-version.ts';

const source = fs.readFileSync(new URL('./codex-update.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('update.ts', source, ts.ScriptTarget.Latest, true);
const fn = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'getCodexCliReleaseStatus');
const js = ts.transpileModule(`(${fn.getText(file).replace('export ', '')})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/;\s*$/, '');
const run = (bridge, release) => new Function(
  'codexBridgeJson',
  'latest',
  'VERSION',
  'isNewerReleaseVersion',
  `return ${js}`,
)(bridge, release, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, isNewerReleaseVersion)();

test('installed and running CLI versions stay distinct; release comparison uses installed version', async () => {
  const result = await run(async path => {
    assert.equal(path, '/api/projects?includeVersion=1');
    return {
      codexCliVersion: '0.163.0',
      codexCliInstalledVersion: '0.163.0',
      codexCliRunningVersion: '0.162.0',
      codexCliRuntimeStatus: 'running',
      codexCliActivationState: 'waiting_for_idle',
      codexCliActivationMessage: '等待当前任务空闲后切换',
    };
  }, async () => ({ latestVersion: '0.163.0', releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.163.0' }));

  assert.equal(result.installedVersion, '0.163.0');
  assert.equal(result.currentVersion, '0.163.0');
  assert.equal(result.runningVersion, '0.162.0');
  assert.equal(result.runtimeStatus, 'running');
  assert.equal(result.activationState, 'waiting_for_idle');
  assert.equal(result.activationMessage, '等待当前任务空闲后切换');
  assert.equal(result.updateAvailable, false);
});

test('unknown runtime version remains null and does not affect installed-version update checks', async () => {
  const result = await run(async () => ({
    codexCliInstalledVersion: '0.163.0',
    codexCliRunningVersion: 'not-a-version',
    codexCliRuntimeStatus: 'unknown',
    codexCliActivationState: 'manual',
    codexCliActivationMessage: '运行状态暂不可用',
  }), async () => ({ latestVersion: '0.164.0', releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.164.0' }));

  assert.equal(result.installedVersion, '0.163.0');
  assert.equal(result.runningVersion, null);
  assert.equal(result.runtimeStatus, 'unknown');
  assert.equal(result.updateAvailable, true);
});

test('same installed and latest versions do not offer an update', async () => {
  const result = await run(async () => ({
    codexCliInstalledVersion: '0.163.0',
    codexCliRuntimeStatus: 'stopped',
  }), async () => ({ latestVersion: '0.163.0', releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.163.0' }));

  assert.equal(result.updateAvailable, false);
});

test('legacy connector falls back to codexCliVersion without fabricating a running version', async () => {
  const result = await run(async () => ({ codexCliVersion: '0.162.1' }), async () => ({
    latestVersion: '0.163.0',
    releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.163.0',
  }));

  assert.equal(result.installedVersion, '0.162.1');
  assert.equal(result.currentVersion, '0.162.1');
  assert.equal(result.runningVersion, null);
  assert.equal(result.runtimeStatus, 'unknown');
  assert.equal(result.activationState, 'manual');
  assert.equal(result.updateAvailable, true);
});

test('release failure preserves the installed CLI version and does not claim it is up to date', async () => {
  const result = await run(async () => ({ codexCliInstalledVersion: '0.162.1' }), async () => ({ latestVersion: null, releaseUrl: null }));

  assert.equal(result.installedVersion, '0.162.1');
  assert.equal(result.currentVersion, '0.162.1');
  assert.equal(result.updateAvailable, false);
  assert(result.updateError);
});

test('gateway failure leaves CLI versions unknown and never offers a blind upgrade', async () => {
  const result = await run(async () => { throw new Error('gateway unavailable'); }, async () => ({
    latestVersion: '0.163.0',
    releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.163.0',
  }));

  assert.equal(result.installedVersion, null);
  assert.equal(result.currentVersion, null);
  assert.equal(result.runningVersion, null);
  assert.equal(result.runtimeStatus, 'unknown');
  assert.equal(result.updateAvailable, false);
  assert(result.versionError);
});
