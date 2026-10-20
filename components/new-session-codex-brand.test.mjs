import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createJiti } from 'jiti';
import fs from 'node:fs';

const j = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
const { NewSessionBrandHeader } = await j.import('./NewSessionBrandHeader.tsx');
const { I18nProvider } = await j.import('../hooks/useI18n.tsx');
const componentSource = fs.readFileSync(new URL('./NewSessionBrandHeader.tsx', import.meta.url), 'utf8');
const render = (props = {}) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: 'zh-CN' },
  React.createElement(NewSessionBrandHeader, {
    appVersion: '1.4.0-rc.4',
    piVersion: '1.3.0',
    updateData: null,
    ...props,
  }),
));

test('Codex shows installed and running versions separately with official links', () => {
  const html = render({ executionEngine: 'codex', codexStatus: {
    currentVersion: '0.163.0',
    installedVersion: '0.163.0',
    runningVersion: '0.162.0',
    runtimeStatus: 'running',
    activationState: 'waiting_for_idle',
    activationMessage: '等待当前任务空闲后切换',
    latestVersion: '0.164.0',
    updateAvailable: true,
    releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.164.0',
  } });

  assert.match(html, /Agent Web Plus/);
  assert.match(html, /data-pi-brand-engine="codex"/);
  const wordmark = html.match(/<text\b[^>]*data-pi-brand-part="wordmark"[^>]*>.*?<\/text>/s)[0];
  assert.equal(wordmark.replace(/<[^>]+>/g, ''), 'Agent Web Plus');
  assert.doesNotMatch(wordmark, /<tspan[^>]* [xy]=/);
  assert.match(wordmark, /letter-spacing="normal"/);
  assert.match(html, /data-pi-brand-part="codex-symbol"/);
  assert.match(html, /#4F5AE8/);
  assert.match(html, /#7850E8/);
  assert.match(html, /CLI 已安装/);
  assert.match(html, /data-pi-element="codex-cli-running-version-row"/);
  assert.match(html, /运行中 v0\.162\.0/);
  assert.ok(html.indexOf('data-pi-element="codex-cli-version-row"') < html.indexOf('data-pi-element="codex-cli-running-version-row"'));
  assert.match(html, /v1\.4\.0-rc\.4/);
  assert.match(html, /href="https:\/\/github\.com\/openai\/codex"/);
  assert.match(html, /href="https:\/\/github\.com\/openai\/codex\/releases\/tag\/rust-v0\.164\.0"/);
  assert.match(html, /待任务空闲后切换/);
  assert.doesNotMatch(html, /data-pi-element="pi-version"/);
});

test('unknown Codex versions and runtime states are explicit without a fake Pi version', () => {
  const html = render({ executionEngine: 'codex', codexStatus: {
    currentVersion: null,
    installedVersion: null,
    runningVersion: null,
    runtimeStatus: 'unknown',
    activationState: 'manual',
    activationMessage: '运行状态暂不可用',
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: '',
    versionError: '暂不可用',
    updateError: '查询失败',
  } });

  assert.match(html, /CLI 已安装/);
  assert.match(html, /运行状态暂不可用/);
  assert.match(html, /更新检查暂不可用/);
  assert.doesNotMatch(html, /v1\.3\.0/);
  assert.doesNotMatch(html, /等待当前任务空闲后切换/);
});

test('Pi keeps its engine symbol and installed Agent version under the Agent Web Plus brand', () => {
  const html = render();
  assert.match(html, /Agent Web Plus/);
  assert.match(html, /data-pi-brand-engine="pi"/);
  assert.match(html, /id="symbol-pi"/);
  assert.doesNotMatch(html, /codex-symbol/);
  assert.match(html, /v1\.3\.0/);
  assert.doesNotMatch(html, /Codex CLI/);
});

test('the native welcome version subtree rejects old enhancement ownership', () => {
  const source = fs.readFileSync(new URL('../enhancements/modules/06-chat-view-and-tool-cards.js', import.meta.url), 'utf8');
  assert.equal((source.match(/el\.closest\?\.\("\[data-pi-native-version-header\]"\)/g) || []).length, 2);
});

test('both engines share a bottom-aligned two-column header with a shrinking SVG', () => {
  for (const executionEngine of ['pi', 'codex']) {
    const html = render({ executionEngine });
    assert.match(html, /display:grid;grid-template-columns:minmax\(0, 1fr\) auto;align-items:end/);
    assert.match(html, /width:100%/);
    assert.match(html, /height:auto/);
    assert.match(html, /max-width:200px/);
    assert.doesNotMatch(html, /1 1 200px/);
  }
});

test('Codex status polling refreshes visibly and shares one effect-owned request controller', () => {
  assert.match(componentSource, /if \(!active \|\| document\.visibilityState === "hidden" \|\| inFlight\) return/);
  assert.match(componentSource, /setInterval\(\(\) => \{ void refreshCodexStatus\(\); \}, 30_000\)/);
  assert.match(componentSource, /addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(componentSource, /removeEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(componentSource, /controller\.abort\(\)/);
});
