import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-tab-section-'));
const output = path.resolve(root, '../acceptance');
const password = crypto.randomUUID();
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let child, browser, log = '';
const errors = [], cases = [];
fs.mkdirSync(output, { recursive: true });
try {
  child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: scratch, PI_AGENT_DIR: scratch, PI_WEB_PASSWORD: password, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', x => { log += x; });
  child.stderr.on('data', x => { log += x; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(origin + '/login')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'isolated server started');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const [engine, width] of [['pi', 1280], ['pi', 390], ['codex', 1280], ['codex', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, locale: 'zh-CN', serviceWorkers: 'block' });
    const token = 'v1.' + (Math.floor(Date.now() / 1000) + 3600) + '.' + crypto.randomBytes(16).toString('hex');
    await context.addCookies([{ name: 'pi_web_session', value: token + '.' + crypto.createHmac('sha256', password).update('pi-web-session:' + token).digest('hex'), url: origin }]);
    await context.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), p = url.pathname;
      const json = data => route.fulfill({ json: data });
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (!p.startsWith('/api/')) return route.continue();
      if (p.startsWith('/api/ui-settings/browser-title')) return route.continue();
      if (!['GET', 'HEAD'].includes(request.method()) && !['/api/cwd/validate', '/api/execution-engines/check'].includes(p)) return route.fulfill({ status: 403, json: { error: 'fixture write blocked' } });
      if (p === '/api/execution-engines') return json({ defaultEngine: engine, codex: { enabled: true, url: origin + '/native' } });
      if (p === '/api/execution-engines/check') return json({ connected: true, projects: [{ cwd: '/isolated' }] });
      if (p === '/api/cwd/validate') return json({ valid: true, cwd: '/isolated', exists: true });
      if (p === '/api/sessions') return json({ sessions: [] });
      if (p === '/api/project-trust') return json({ trusted: true, requiresTrust: false });
      if (p === '/api/agent/running') return json({ runningSessionIds: [], completionNotificationSuppressedSessionIds: [], sessionListVersion: 1 });
      if (p === '/api/worktrees') return json({ isGit: false, projectRoot: '/isolated', currentWorktreePath: '/isolated', worktrees: [] });
      if (p === '/api/enhancement-state') return route.fulfill({ status: 200, headers: { 'x-pi-enhancement-state': 'absent' } });
      return json({ success: true, data: {}, skills: [], tools: [], models: [], sessions: [], projects: [] });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?engine=' + engine + '&cwd=%2Fisolated', { waitUntil: 'domcontentloaded' });
    await page.locator('textarea').last().waitFor();
    const sidebar = page.getByRole('button', { name: /^(显示侧边栏|Show sidebar)$/ });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.locator('[data-shortcut-id="general"]').click();
    assert.equal(await page.locator('.settings-browser-tab').count(), 0, 'general no longer mounts tab editor');
    const nav = page.locator('.settings-section-tab[data-section-id="browser-tab"]');
    await nav.click();
    await page.getByRole('heading', { name: '浏览器标签页', exact: true }).waitFor();
    const title = page.locator('#settings-browser-tab-title');
    const template = page.locator('#settings-browser-tab-template');
    await title.fill(`测试-${engine}-${width}`);
    await template.fill('{project} · {text}');
    await page.locator('#settings-tab-logoColor').fill('#247e81');
    await page.locator('.settings-section-tab[data-section-id="general"]').click();
    await nav.click();
    assert.equal(await title.inputValue(), `测试-${engine}-${width}`, 'unsaved draft survives section switches');
    await page.getByRole('button', { name: '保存标签页设置' }).click();
    await page.getByText('已保存，同一服务的其他页面会自动同步', { exact: true }).waitFor();
    const saved = await page.evaluate(async () => (await fetch('/api/ui-settings/browser-title')).json());
    assert.equal(saved.title, `测试-${engine}-${width}`);
    assert.equal(saved.appearance.titleTemplate, '{project} · {text}');
    assert.equal(saved.appearance.logoColor, '#247e81');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('textarea').last().waitFor();
    const openSidebar = page.getByRole('button', { name: /^(显示侧边栏|Show sidebar)$/ });
    if (await openSidebar.isVisible()) await openSidebar.click();
    await page.locator('[data-shortcut-id="general"]').click();
    await page.locator('.settings-section-tab[data-section-id="browser-tab"]').click();
    await page.waitForFunction(expected => document.querySelector('#settings-browser-tab-title')?.value === expected, `测试-${engine}-${width}`);
    const geometry = await page.evaluate(() => {
      const host = document.querySelector('.settings-dialog-main').getBoundingClientRect();
      const panel = document.querySelector('.settings-browser-tab').getBoundingClientRect();
      const input = document.querySelector('#settings-browser-tab-template').getBoundingClientRect();
      return { left: Math.round(input.left - host.left), right: Math.round(host.right - input.right), overflow: document.documentElement.scrollWidth > innerWidth, panelWidth: Math.round(panel.width) };
    });
    assert.ok(geometry.left >= 12 && geometry.right >= 10 && geometry.panelWidth > 100, JSON.stringify(geometry));
    assert.equal(geometry.overflow, false);
    await page.screenshot({ path: `${output}/browser-tab-${engine}-${width}.png`, animations: 'disabled' });
    cases.push({ engine, width, geometry });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', cases }));
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(scratch, { recursive: true, force: true });
}
