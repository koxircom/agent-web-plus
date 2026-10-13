// Runs the real native component in an isolated page; no agent/API writes.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const loadDependency = createRequire(import.meta.url);
const esbuild = loadDependency(process.env.COMPOSER_ESBUILD_MODULE || 'esbuild');
const { chromium } = loadDependency(process.env.COMPOSER_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));

(async () => {
  const bundle = await esbuild.build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatInput } from './components/ChatInput';
      import { I18nProvider } from './hooks/useI18n';
      import { useChatAppearance } from './hooks/useChatAppearance';
      function Fixture() {
        const [key, remount] = React.useState(0);
        const [owner, setOwner] = React.useState("autogrow-fixture");
        const ref = React.useRef(null);
        const { setFontSize } = useChatAppearance();
        window.fixture = { remount: () => remount(k => k + 1), setFontSize, setOwner, promote: next => { ref.current.rekeyDraft(owner, next); setOwner(next); } };
        return <ChatInput ref={ref} key={key} onSend={()=>{}} onAbort={()=>{}} isStreaming={false}
          draftKey={owner} model={{provider:'openai',modelId:'gpt-6.1-sol'}}/>;
      }
      createRoot(document.getElementById('root')).render(<I18nProvider><Fixture/></I18nProvider>);
    ` },
    bundle: true, write: false, format: 'iife', alias: { '@': root },
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const globals = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8')
    .split('[data-theme="mist"]')[0].replace(/^@(?:import|source).*$/gm, '')
    .replace(/@theme\s*\{[^}]*\}/s, '');
  const css = globals + fs.readFileSync(path.join(root, 'app/composer.css'), 'utf8');
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text);
    } else if (req.url.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json'); res.end('{}');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(`<html data-theme="dark"><head><style>${css}
        body{margin:0;background:var(--bg);font-family:sans-serif}
        #root{max-width:820px;margin:80px auto}
        </style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
    }
  });
  let browser;
  const receipts = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true,
      ...(process.env.COMPOSER_CHROMIUM_PATH ? { executablePath: process.env.COMPOSER_CHROMIUM_PATH } : {}) });
    const errors = [];
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      let writes = 0;
      page.on('request', request => { if (!['GET','HEAD'].includes(request.method())) writes++; });
      await page.addInitScript(() => {
        localStorage.setItem('pi-web:composer-custom-height', '49'); // Legacy global height must be inert.
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
        window.heightIO = { reads: 0, writes: 0 };
        Storage.prototype.getItem = function(key) { if (key.startsWith('pi-web:composer-session-height:')) window.heightIO.reads++; return get.call(this, key); };
        Storage.prototype.setItem = function(key, value) { if (key.startsWith('pi-web:composer-session-height:')) window.heightIO.writes++; return set.call(this, key, value); };
        Storage.prototype.removeItem = function(key) { if (key.startsWith('pi-web:composer-session-height:')) window.heightIO.writes++; return remove.call(this, key); };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const textarea = page.locator('textarea'), handle = page.locator('.chat-composer-resizer');
      await textarea.waitFor();
      const metrics = () => textarea.evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight,
        locked: document.querySelector('.chat-composer-resizer').getAttribute('aria-pressed'),
        color: getComputedStyle(document.querySelector('.chat-composer-resizer-line')).backgroundColor,
        opacity: Number(getComputedStyle(document.querySelector('.chat-composer-resizer-line')).opacity),
        io: { ...window.heightIO }, overflow: document.documentElement.scrollWidth > innerWidth }));
      const fits = async name => {
        try { await page.waitForFunction(() => { const el = document.querySelector('textarea'); return el.scrollHeight <= el.clientHeight + 1; }, null, { timeout: 2500 }); }
        catch (error) { console.error(name, await metrics(), await textarea.evaluate(el => ({ style: el.getAttribute('style'), card: el.closest('.chat-composer-card').outerHTML.slice(0,1500) }))); throw error; }
        const value = await metrics(); assert.equal(value.overflow, false, name); receipts.push({ width, name, ...value });
      };
      const text = '自动高度验证\n'.repeat(5).trimEnd();
      await textarea.fill(text); await fits('legacy global height does not block autogrow');
      assert.equal((await metrics()).locked, 'false');
      const initial = await metrics();
      await handle.click();
      assert.equal((await metrics()).locked, 'true');
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.chat-composer-resizer-line')).opacity) === 1);
      await page.waitForFunction(() => {
        const el = document.querySelector('.chat-composer-resizer-line');
        const probe = document.createElement('span');
        probe.style.background = 'color-mix(in srgb, var(--chat-composer-focus-border) 90%, var(--text, #fff))';
        el.closest('.chat-composer-card').append(probe);
        const settled = getComputedStyle(el).backgroundColor === getComputedStyle(probe).backgroundColor;
        probe.remove();
        return settled;
      });
      const lockedStyle = await page.locator('.chat-composer-resizer-line').evaluate(el => {
        const style = getComputedStyle(el), card = el.closest('.chat-composer-card');
        const probe = document.createElement('span');
        probe.style.background = 'color-mix(in srgb, var(--chat-composer-focus-border) 90%, var(--text, #fff))';
        card.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual: style.backgroundColor, expected, shadow: style.boxShadow };
      });
      assert.equal(lockedStyle.actual, lockedStyle.expected, 'locked color follows the shared border with ten percent text-color lightening');
      assert.notEqual(lockedStyle.shadow, 'none', 'locked handle has a subtle static glow');
      receipts.push({ width, name: 'locked contrast', ...await metrics(), shadow: lockedStyle.shadow });
      const lockedBounds = await handle.boundingBox();
      await page.mouse.move(lockedBounds.x + lockedBounds.width / 2, lockedBounds.y + lockedBounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(lockedBounds.x + lockedBounds.width / 2, lockedBounds.y + lockedBounds.height / 2 - 5);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.chat-composer-resizer-line')).backgroundColor === 'rgb(255, 255, 255)', null, { timeout: 2000 });
      await page.mouse.up();
      assert.equal((await metrics()).locked, 'true', 'locked drag preserves lock');
      // Return to the original height before persistence checks.
      const lockHeight = await metrics();
      initial.height = lockHeight.height;
      await textarea.fill(text + '\n'.repeat(5) + '更多文字');
      assert.equal((await metrics()).height, initial.height, 'explicit lock fixes height');
      const ioBefore = (await metrics()).io;
      await textarea.press('End'); await textarea.press('x'); await textarea.press('y');
      assert.deepEqual((await metrics()).io, ioBefore, 'typing has no height-storage IO');
      await page.evaluate(() => fixture.setOwner('session-B'));
      await page.waitForFunction(() => document.querySelector('.chat-composer-resizer').getAttribute('aria-pressed') === 'false');
      await textarea.fill('B');
      assert.ok((await metrics()).height < initial.height, 'second session has independent automatic height');
      await page.evaluate(() => fixture.setOwner('autogrow-fixture'));
      await page.waitForFunction(() => document.querySelector('.chat-composer-resizer').getAttribute('aria-pressed') === 'true');
      assert.equal((await metrics()).height, initial.height);
      await page.reload(); await textarea.waitFor();
      await page.waitForFunction(() => document.querySelector('.chat-composer-resizer').getAttribute('aria-pressed') === 'true');
      assert.equal((await metrics()).height, initial.height, 'refresh restores locked height');
      await handle.click(); await textarea.fill(text); await fits('single click unlock restores automatic sizing');
      assert.equal((await metrics()).locked, 'false');
      const bounds = await handle.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      const beforeDragWrites = (await metrics()).io.writes;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 70, { steps: 8 });
      assert.equal((await metrics()).io.writes, beforeDragWrites, 'dragging does not persist each pointer move');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.chat-composer-resizer-line')).backgroundColor === 'rgb(255, 255, 255)');
      await page.mouse.up();
      assert.equal((await metrics()).io.writes, beforeDragWrites + 1, 'drag saves once');
      assert.equal((await metrics()).locked, 'true', 'completed drag automatically locks');
      const draggedHeight = (await metrics()).height;
      await textarea.fill('短');
      assert.equal((await metrics()).height, draggedHeight, 'release does not bounce to content height');
      await textarea.fill(text);
      assert.equal((await metrics()).height, draggedHeight, 'typing retains dragged height');
      await page.evaluate(() => fixture.remount());
      assert.equal((await metrics()).locked, 'true', 'remount retains dragged lock');
      assert.equal((await metrics()).height, draggedHeight);
      await handle.click(); await fits('click unlocks a dragged height');
      assert.equal((await metrics()).locked, 'false');
      const cancelBounds = await handle.boundingBox();
      await page.mouse.move(cancelBounds.x + cancelBounds.width / 2, cancelBounds.y + 10);
      await page.mouse.down();
      const beforeCancel = (await metrics()).io.writes;
      await page.mouse.move(cancelBounds.x + cancelBounds.width / 2, cancelBounds.y - 30);
      await handle.dispatchEvent('pointercancel');
      await page.mouse.up();
      assert.equal((await metrics()).io.writes, beforeCancel, 'cancelled drag does not persist');
      assert.equal((await metrics()).locked, 'false', 'cancelled drag remains automatic');
      await fits('cancel restores automatic sizing');
      const staleBounds = await handle.boundingBox();
      await page.mouse.move(staleBounds.x + staleBounds.width / 2, staleBounds.y + 10);
      await page.mouse.down();
      await page.mouse.move(staleBounds.x + staleBounds.width / 2, staleBounds.y - 30);
      const beforeSwitch = (await metrics()).io.writes;
      await page.evaluate(() => fixture.setOwner('session-B'));
      await page.mouse.up();
      assert.equal((await metrics()).io.writes, beforeSwitch, 'old gesture cannot write after session switch');
      assert.equal((await metrics()).locked, 'false');
      await page.evaluate(() => fixture.setOwner('autogrow-fixture'));
      await textarea.fill(text); await fits('session returns to automatic sizing');
      await handle.focus(); await page.keyboard.press('Enter');
      assert.equal((await metrics()).locked, 'true', 'keyboard locks');
      await page.keyboard.press('Space');
      assert.equal((await metrics()).locked, 'false', 'keyboard unlocks');
      await textarea.fill('窄屏自动换行验证文字'.repeat(width === 390 ? 12 : 20)); await fits('wrapped text autogrows');
      await textarea.fill('一行\n'.repeat(30));
      assert.ok((await metrics()).scroll > (await metrics()).height, 'long drafts retain eight-line scroll cap');
      await textarea.fill(''); await fits('clear shrinks to CSS minimum');
      assert.ok((await metrics()).height < 44);
      if (width === 390) {
        await handle.tap(); assert.equal((await metrics()).locked, 'true', 'touch tap locks once');
        await handle.tap(); assert.equal((await metrics()).locked, 'false', 'touch tap unlocks once');
      }
      await textarea.fill(text); await handle.click();
      await page.evaluate(() => fixture.promote('created-session'));
      await page.waitForFunction(() => document.querySelector('.chat-composer-resizer').getAttribute('aria-pressed') === 'true');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-web:composer-session-height:v1:created-session')).locked), true, 'draft promotion transfers height');
      assert.equal(await page.evaluate(() => localStorage.getItem('pi-web:composer-session-height:v1:autogrow-fixture')), null);
      if (process.env.COMPOSER_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.COMPOSER_ARTIFACT_DIR, `height-${width}.png`) });
      const promotedHeight = (await metrics()).height;
      if (width === 390) {
        await page.setViewportSize({ width, height: 100 });
        assert.ok((await metrics()).height <= 80, 'locked height clamps to a reduced mobile viewport');
        await page.setViewportSize({ width, height: 844 });
        assert.equal((await metrics()).height, promotedHeight, 'restoring viewport restores session height');
      }
      assert.equal(writes, 0, 'no model or server writes');
      await context.close();
    }
    const denied = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const deniedPage = await denied.newPage();
    deniedPage.on('pageerror', error => errors.push(error.message));
    await deniedPage.addInitScript(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (key.startsWith('pi-web:composer-session-height:')) throw new Error('denied'); return get.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('pi-web:composer-session-height:')) throw new Error('denied'); return set.call(this, key, value); };
    });
    await deniedPage.goto(`http://127.0.0.1:${server.address().port}`);
    const deniedHandle = deniedPage.locator('.chat-composer-resizer');
    await deniedHandle.click(); assert.equal(await deniedHandle.getAttribute('aria-pressed'), 'true', 'memory fallback locks');
    await deniedPage.evaluate(() => fixture.setOwner('other'));
    await deniedPage.waitForFunction(() => document.querySelector('.chat-composer-resizer').getAttribute('aria-pressed') === 'false');
    await deniedPage.evaluate(() => fixture.setOwner('autogrow-fixture'));
    await deniedPage.waitForFunction(() => document.querySelector('.chat-composer-resizer').getAttribute('aria-pressed') === 'true');
    await deniedHandle.click(); assert.equal(await deniedHandle.getAttribute('aria-pressed'), 'false', 'memory fallback unlocks');
    await denied.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, receipts, errors }, null, 2));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
