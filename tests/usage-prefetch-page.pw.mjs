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
const require = createRequire(import.meta.url), { chromium } = require('playwright');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-prefetch-'));
const origin = 'http://127.0.0.1:31375', password = crypto.randomUUID();
const output = path.resolve(root, '../acceptance');
fs.mkdirSync(output, { recursive: true });
const bucket = { engine: 'codex', sessionId: 'codex:fixture', provider: 'fixture', model: 'fixture', role: 'main', day: '2026-10-18',
  inputTokens: 12000, outputTokens: 345, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12345,
  messageCount: 1, calls: 1, records: 1, costNano: 0, unpricedTokens: 12345, missingUsage: 0 };
const ledger = { version: 2, snapshotId: 'prefetched-fixture', generatedAt: '2026-11-05T00:00:00Z', buckets: [bucket], sessions: {},
  engineStatus: { pi: { status: 'ready' }, codex: { status: 'ready' } } };
let browser, child, log = '';
const cases = [];
try {
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(31375, '127.0.0.1', () => server.close(resolve)); });
  child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', '31375'],
    { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: scratch, PI_AGENT_DIR: scratch, PI_WEB_PASSWORD: password, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
  let ready = false;
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(log); try { if ((await fetch(origin + '/login')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }
  assert(ready, 'isolated server did not start');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const [engine, width] of [['codex', 1280], ['codex', 390], ['pi', 390]]) {
    const sid = engine === 'codex' ? 'codex:fixture' : 'pi-fixture';
    const session = { id: sid, path: '/isolated/session.jsonl', cwd: '/isolated', name: '隔离用量测试', created: '2026-10-18', modified: '2026-10-18', messageCount: 1, firstMessage: '隔离' };
    let usageRequests = 0;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, locale: 'zh-CN', serviceWorkers: 'block' });
    const token = `v1.${Math.floor(Date.now() / 1000) + 3600}.${crypto.randomBytes(16).toString('hex')}`;
    await context.addCookies([{ name: 'pi_web_session', value: token + '.' + crypto.createHmac('sha256', password).update('pi-web-session:' + token).digest('hex'), url: origin }]);
    await context.addInitScript(() => { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-enh-plugin-usage-cost-dashboard', 'true'); });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname, json = data => route.fulfill({ json: data });
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (!p.startsWith('/api/')) { if (/^\/pi-.*manifest\.json$/.test(p)) return json([]); return route.continue(); }
      if (p === '/api/usage/ledger') { usageRequests++; await new Promise(r => setTimeout(r, 300)); return json(ledger); }
      if (p === '/api/execution-engines') return json({ defaultEngine: engine, codex: { enabled: true, url: origin + '/native' } });
      if (p === '/api/execution-engines/check') return json({ connected: true, projects: [{ cwd: '/isolated' }] });
      if (p === '/api/cwd/validate') return json({ valid: true, cwd: '/isolated', exists: true });
      if (p === '/api/sessions') return json({ sessions: [session] });
      if (p.startsWith('/api/sessions/')) return json({ sessionId: sid, state: { isStreaming: false }, tree: [], leafId: null, totalActiveMs: 0, context: { messages: [], entryIds: [], hasMore: false } });
      if (p === '/api/agent/running') return json({ runningSessionIds: [], completionNotificationSuppressedSessionIds: [], sessionListVersion: 1 });
      if (p === '/api/enhancement-state') return route.fulfill({ status: 200, headers: { 'x-pi-enhancement-state': 'absent' } });
      return json({ success: true, data: {}, skills: [], tools: [], models: [], sessions: [], projects: [] });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?session=${encodeURIComponent(sid)}&engine=${engine}`, { waitUntil: 'domcontentloaded' });
    await page.locator('textarea').last().waitFor({ timeout: 20000 });
    await page.waitForFunction(() => window.__PI_ENH_USAGE_LEDGER__?.snapshotId === 'prefetched-fixture', null, { timeout: 25000 });
    assert.equal(usageRequests, 1, 'snapshot must load before opening settings');
    const sidebar = page.getByRole('button', { name: /^(显示侧边栏|Show sidebar)$/ });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.locator('[data-shortcut-id="general"]').click();
    const start = Date.now();
    await page.locator('.settings-section-tab').filter({ hasText: '用量统计' }).click();
    await page.locator('[data-usage-snapshot="prefetched-fixture"]').waitFor({ timeout: 10000 });
    const elapsedMs = Date.now() - start;
    assert.equal(await page.locator('[data-usage-snapshot]').getAttribute('data-total-tokens'), '12345');
    assert(elapsedMs < 2500, `warm panel took ${elapsedMs}ms`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/usage-prefetch-${engine}-${width}.png`, animations: 'disabled' });
    cases.push({ engine, width, prefetchBeforeOpen: true, displayedTokens: 12345, elapsedMs });
    await context.close();
  }
  console.log(JSON.stringify({ status: 'passed', cases }));
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(scratch, { recursive: true, force: true });
}
