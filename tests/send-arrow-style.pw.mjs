// send-arrow-style.pw.mjs
// Real browser Playwright verification of the bottom-right white/contrast up-arrow button geometry, colors, queues, and click/keyboard interactions.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));

// 1. Bundle real ChatInput + I18nProvider + React fixture with queue & state setters
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
      import React, { useState, useCallback, useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatInput } from './components/ChatInput';
      import { I18nProvider } from './hooks/useI18n';

      function TestApp() {
        const [isStreaming, setIsStreaming] = useState(false);
        const [queuedCount, setQueuedCount] = useState(0);
        const [draftKey, setDraftKey] = useState('send-arrow-fixture');
        const [theme, setTheme] = useState('dark');
        const [callLog, setCallLog] = useState([]);
        const [deliveredRequestIds, setDeliveredRequestIds] = useState([]);

        const logCall = useCallback((type, text) => {
          setCallLog(prev => [...prev, { type, text, ts: Date.now() }]);
          return true;
        }, []);

        const handleSend = useCallback((text) => logCall('send', text), [logCall]);
        const handleSteer = useCallback((text, images, onRegistered) => {
          const reqId = 'steer-' + Math.random().toString(36).slice(2, 9);
          logCall('steer', text);
          if (onRegistered) {
            onRegistered({ requestId: reqId, draftKey, durable: true });
            setDeliveredRequestIds(prev => [...prev, reqId]);
          }
          return true;
        }, [draftKey, logCall]);
        const handleFollowUp = useCallback((text, images, onRegistered) => {
          const reqId = 'followup-' + Math.random().toString(36).slice(2, 9);
          logCall('followup', text);
          if (onRegistered) {
            onRegistered({ requestId: reqId, draftKey, durable: true });
            setDeliveredRequestIds(prev => [...prev, reqId]);
          }
          return true;
        }, [draftKey, logCall]);

        useEffect(() => {
          document.documentElement.setAttribute('data-theme', theme);
        }, [theme]);

        const queuedMessages = React.useMemo(() => {
          if (queuedCount <= 0) return { steering: [], followUp: [], requestIds: { steering: [], followUp: [] } };
          const steerCount = Math.floor(queuedCount / 2);
          const followCount = queuedCount - steerCount;
          return {
            steering: Array.from({ length: steerCount }, (_, i) => 'Steer msg ' + i),
            followUp: Array.from({ length: followCount }, (_, i) => 'Followup msg ' + i),
            requestIds: { steering: [], followUp: [] },
          };
        }, [queuedCount]);

        window.__TEST_SETTER__ = {
          setIsStreaming,
          setQueuedCount,
          setTheme,
          setDraftKey,
          getCalls: () => callLog,
          clearCalls: () => setCallLog([]),
        };

        return (
          <div style={{ padding: '40px 16px', maxWidth: 820, margin: '0 auto' }}>
            <ChatInput
              key={draftKey}
              draftKey={draftKey}
              isStreaming={isStreaming}
              onSend={handleSend}
              onAbort={() => logCall('abort', '')}
              onSteer={handleSteer}
              onFollowUp={handleFollowUp}
              queuedMessages={queuedMessages}
              deliveredRequestIds={deliveredRequestIds}
              model={{ provider: 'openai', modelId: 'gpt-6.1-sol' }}
            />
          </div>
        );
      }

      createRoot(document.getElementById('root')).render(
        <I18nProvider>
          <TestApp />
        </I18nProvider>
      );
    `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  loader: {
    '.css': 'empty',
    '.woff2': 'empty',
    '.woff': 'empty',
    '.ttf': 'empty',
    '.svg': 'text',
    '.png': 'empty',
  },
  alias: {
    '@': root,
    'server-only': 'next/dist/compiled/server-only/empty.js',
  },
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env': '{}',
  },
});

// 2. Load authentic stylesheets: globals.css + composer.css + enhancements.css
const globals = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8')
  .split('[data-theme="mist"]')[0]
  .replace(/^@(?:import|source).*$/gm, '')
  .replace(/@theme\s*\{[^}]*\}/s, '');
const composerCss = fs.readFileSync(path.join(root, 'app/composer.css'), 'utf8');
const enhancementsCss = fs.readFileSync(path.join(root, 'app/enhancements.css'), 'utf8');
const fullCss = globals + composerCss + enhancementsCss;

// Output directory for screenshots
const screenshotDir = '/workspace/work/send155';
fs.mkdirSync(screenshotDir, { recursive: true });

function parseRgb(colorStr) {
  const m = colorStr?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

// 3. HTTP Server serving bundle, styles, and dummy API responses
let base = '';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, base || 'http://127.0.0.1');
  if (u.pathname === '/bundle.js') {
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    return res.end(bundle.outputFiles[0].text);
  }
  if (u.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      success: true,
      data: {},
      modelList: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', provider: 'openai' }],
    }));
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html data-theme="dark" lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${fullCss}
    body {
      margin: 0;
      background: var(--bg, #141416);
      color: var(--text, #ededed);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>`);
});

const results = [];
let browser;

try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  const viewports = [390, 1124];
  const themes = ['dark', 'light'];
  const queueScenarios = [0, 1, 3, 99];
  const pageErrors = [];
  const fixtureWarnings = [];

  for (const width of viewports) {
    const isMobile = width === 390;
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: isMobile,
      locale: 'zh-CN',
    });

    const page = await context.newPage();

    // Separate actual page errors from benign fixture API misses (test helper routing)
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') {
        if (text.includes('404') || text.includes('/api/') || text.includes('fixture')) {
          fixtureWarnings.push(text);
        } else {
          pageErrors.push(text);
        }
      }
    });

    await page.goto(base + '/');
    await page.locator('textarea').waitFor({ timeout: 10000 });

    for (const theme of themes) {
      await page.evaluate(t => window.__TEST_SETTER__.setTheme(t), theme);
      await page.waitForTimeout(60);

      // --- Matrix Scenario A: Idle Mode (empty vs full) ---
      await page.evaluate(() => window.__TEST_SETTER__.setIsStreaming(false));
      await page.evaluate(() => window.__TEST_SETTER__.setQueuedCount(0));

      // 1. Idle + Empty
      await page.locator('textarea').fill('');
      const idleEmptySendBtn = page.locator('button.chat-composer-send');
      await idleEmptySendBtn.waitFor();

      // Measure Send button 24px design invariant (never claim >= 32px)
      const emptyBtnBox = await idleEmptySendBtn.boundingBox();
      assert(emptyBtnBox, 'Send button exists');
      assert.equal(Math.round(emptyBtnBox.width), 24, `Send button width must be exactly 24px, got ${emptyBtnBox.width}`);
      assert.equal(Math.round(emptyBtnBox.height), 24, `Send button height must be exactly 24px, got ${emptyBtnBox.height}`);

      // Arrow SVG visible, contain >= 0, and no digit text inside button
      const emptySvg = idleEmptySendBtn.locator('svg');
      assert(await emptySvg.isVisible(), 'Arrow SVG visible in idle empty');
      const emptySvgBox = await emptySvg.boundingBox();
      assert(emptySvgBox && emptySvgBox.width > 0 && emptySvgBox.height > 0, 'Arrow SVG has positive size');

      // Containment assertion
      const emptyContainLeft = emptySvgBox.x - emptyBtnBox.x;
      const emptyContainTop = emptySvgBox.y - emptyBtnBox.y;
      const emptyContainRight = (emptyBtnBox.x + emptyBtnBox.width) - (emptySvgBox.x + emptySvgBox.width);
      const emptyContainBottom = (emptyBtnBox.y + emptyBtnBox.height) - (emptySvgBox.y + emptySvgBox.height);
      assert(emptyContainLeft >= -0.5 && emptyContainTop >= -0.5 && emptyContainRight >= -0.5 && emptyContainBottom >= -0.5,
        `Arrow SVG must be contained inside Send button, offsets: L=${emptyContainLeft}, T=${emptyContainTop}, R=${emptyContainRight}, B=${emptyContainBottom}`);

      // No text or digits inside Send button
      const emptyBtnText = (await idleEmptySendBtn.innerText()).trim();
      assert.equal(emptyBtnText, '', 'Send button must have 0 text digits');

      // Disabled state
      assert.equal(await idleEmptySendBtn.isDisabled(), true, 'Send button is disabled when input is empty');

      // 2. Idle + Full (Enabled)
      const promptText = '测试白底高对比度向上发送箭头';
      await page.locator('textarea').fill(promptText);
      await page.waitForFunction(() => !document.querySelector('button.chat-composer-send')?.disabled);
      // Wait for CSS background transition to settle
      await page.waitForTimeout(180);

      // Evaluate computed colors: white RGB in dark vs black in light
      const enabledColors = await idleEmptySendBtn.evaluate(el => {
        const cs = window.getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity };
      });
      const rgb = parseRgb(enabledColors.bg);
      assert(rgb, `Computed background must be valid RGB, got ${enabledColors.bg}`);

      if (theme === 'dark') {
        // Dark theme: white/light surface (#efefef -> rgb(239, 239, 239)), dark glyph
        assert(rgb.r >= 225 && rgb.g >= 225 && rgb.b >= 225,
          `Dark theme enabled Send button must have white/near-white RGB background (>=225), got r=${rgb.r}, g=${rgb.g}, b=${rgb.b}`);
      } else {
        // Light theme: dark/black surface (#0e0e11 -> rgb(14, 14, 17)), light glyph
        assert(rgb.r <= 30 && rgb.g <= 30 && rgb.b <= 30,
          `Light theme enabled Send button must have dark/black RGB background (<=30), got r=${rgb.r}, g=${rgb.g}, b=${rgb.b}`);
      }

      // 3. Test OnClick Callback Exactly Once
      await page.evaluate(() => window.__TEST_SETTER__.clearCalls());
      await idleEmptySendBtn.click();
      let calls = await page.evaluate(() => window.__TEST_SETTER__.getCalls());
      assert.equal(calls.length, 1, `Send click must trigger onSend exactly once, got ${calls.length}`);
      assert.equal(calls[0].type, 'send');
      assert.equal(calls[0].text, promptText);

      // 4. Test Keyboard submission (desktop Enter vs mobile Control+Enter)
      await page.locator('textarea').fill('回车键盘快捷发送测试');
      await page.waitForFunction(() => !document.querySelector('button.chat-composer-send')?.disabled);
      await page.evaluate(() => window.__TEST_SETTER__.clearCalls());

      if (isMobile) {
        await page.locator('textarea').press('Control+Enter');
      } else {
        await page.locator('textarea').press('Enter');
      }
      calls = await page.evaluate(() => window.__TEST_SETTER__.getCalls());
      assert.equal(calls.length, 1, `Keyboard trigger must execute onSend exactly once, got ${calls.length}`);
      assert.equal(calls[0].type, 'send');
      assert.equal(calls[0].text, '回车键盘快捷发送测试');

      // Screenshot for Idle Mode
      const idleImgPath = path.join(screenshotDir, `send155-${width}-${theme}-idle.png`);
      await page.screenshot({ path: idleImgPath, fullPage: false });
      fs.chmodSync(idleImgPath, 0o644);

      // --- Matrix Scenario B: Streaming Mode (Steer & FollowUp buttons) with Queue variations ---
      await page.evaluate(() => window.__TEST_SETTER__.setIsStreaming(true));

      for (const qCount of queueScenarios) {
        await page.evaluate(q => window.__TEST_SETTER__.setQueuedCount(q), qCount);
        await page.locator('textarea').fill('流式引导排队消息 ' + qCount);

        const steerBtn = page.locator('button.chat-composer-steer');
        const followupBtn = page.locator('button.chat-composer-followup');

        await steerBtn.waitFor();
        await followupBtn.waitFor();
        await page.waitForFunction(() => !document.querySelector('button.chat-composer-followup')?.disabled);
        await page.waitForTimeout(180);

        // Check geometries: 24px design invariant (never claim >= 32px)
        const steerBox = await steerBtn.boundingBox();
        const followBox = await followupBtn.boundingBox();
        assert(steerBox && followBox, 'Steer and FollowUp buttons both exist in streaming');
        assert.equal(Math.round(steerBox.width), 24, `Steer button width must be 24px, got ${steerBox.width}`);
        assert.equal(Math.round(steerBox.height), 24, `Steer button height must be 24px, got ${steerBox.height}`);
        assert.equal(Math.round(followBox.width), 24, `FollowUp button width must be 24px, got ${followBox.width}`);
        assert.equal(Math.round(followBox.height), 24, `FollowUp button height must be 24px, got ${followBox.height}`);

        // Topological non-overlap check: Steer and FollowUp must not overlap
        const steerRight = steerBox.x + steerBox.width;
        assert(followBox.x >= steerRight - 0.5,
          `FollowUp button (x=${followBox.x}) must not overlap adjacent Steer button (right=${steerRight})`);

        // Arrow containment in FollowUp
        const followSvg = followupBtn.locator('svg');
        assert(await followSvg.isVisible(), 'FollowUp SVG arrow visible');
        const followSvgBox = await followSvg.boundingBox();
        const followContainL = followSvgBox.x - followBox.x;
        const followContainT = followSvgBox.y - followBox.y;
        const followContainR = (followBox.x + followBox.width) - (followSvgBox.x + followSvgBox.width);
        const followContainB = (followBox.y + followBox.height) - (followSvgBox.y + followSvgBox.height);
        assert(followContainL >= -0.5 && followContainT >= -0.5 && followContainR >= -0.5 && followContainB >= -0.5,
          `FollowUp arrow SVG must be contained inside FollowUp button, L=${followContainL}, T=${followContainT}, R=${followContainR}, B=${followContainB}`);

        // No text digit in FollowUp button even when queue has 1, 3, 99
        const followText = (await followupBtn.innerText()).trim();
        assert.equal(followText, '', `FollowUp button must have 0 text digits regardless of queue count (${qCount}), got: "${followText}"`);

        // Colors of FollowUp button
        const followColors = await followupBtn.evaluate(el => {
          const cs = window.getComputedStyle(el);
          return { bg: cs.backgroundColor, color: cs.color };
        });
        const followRgb = parseRgb(followColors.bg);
        assert(followRgb, `FollowUp background must be valid RGB, got ${followColors.bg}`);
        if (theme === 'dark') {
          assert(followRgb.r >= 225 && followRgb.g >= 225 && followRgb.b >= 225,
            `Dark theme FollowUp button must have white/near-white RGB background (>=225), got r=${followRgb.r}, g=${followRgb.g}, b=${followRgb.b}`);
        } else {
          assert(followRgb.r <= 30 && followRgb.g <= 30 && followRgb.b <= 30,
            `Light theme FollowUp button must have dark/black RGB background (<=30), got r=${followRgb.r}, g=${followRgb.g}, b=${followRgb.b}`);
        }

        // Click FollowUp callback exactly once
        await page.evaluate(() => window.__TEST_SETTER__.clearCalls());
        await followupBtn.click();
        calls = await page.evaluate(() => window.__TEST_SETTER__.getCalls());
        assert.equal(calls.length, 1, `FollowUp click must trigger onFollowUp exactly once, got ${calls.length}`);
        assert.equal(calls[0].type, 'followup');

        // Click Steer callback exactly once
        await page.locator('textarea').fill('引导指令 ' + qCount);
        await page.waitForFunction(() => !document.querySelector('button.chat-composer-steer')?.disabled);
        await page.evaluate(() => window.__TEST_SETTER__.clearCalls());
        await steerBtn.click();
        calls = await page.evaluate(() => window.__TEST_SETTER__.getCalls());
        assert.equal(calls.length, 1, `Steer click must trigger onSteer exactly once, got ${calls.length}`);
        assert.equal(calls[0].type, 'steer');

        // Keyboard trigger during streaming
        await page.locator('textarea').fill('快捷流式触发 ' + qCount);
        await page.waitForFunction(() => !document.querySelector('button.chat-composer-followup')?.disabled);
        await page.evaluate(() => window.__TEST_SETTER__.clearCalls());

        if (isMobile) {
          await page.locator('textarea').press('Control+Enter');
          calls = await page.evaluate(() => window.__TEST_SETTER__.getCalls());
          assert.equal(calls.length, 1, `Mobile Control+Enter must trigger streaming action exactly once, got ${calls.length}`);
        } else {
          await page.locator('textarea').press('Enter');
          calls = await page.evaluate(() => window.__TEST_SETTER__.getCalls());
          assert.equal(calls.length, 1, `Desktop Enter must trigger onFollowUp exactly once, got ${calls.length}`);
          assert.equal(calls[0].type, 'followup');
        }

        // Take snapshot for queue 99 scenario
        if (qCount === 99) {
          const queueImgPath = path.join(screenshotDir, `send155-queue99-${width}-${theme}.png`);
          await page.screenshot({ path: queueImgPath, fullPage: false });
          fs.chmodSync(queueImgPath, 0o644);
        }
      }

      // Capture screenshot for streaming combination
      const streamingImgPath = path.join(screenshotDir, `send155-${width}-${theme}-streaming.png`);
      await page.screenshot({ path: streamingImgPath, fullPage: false });
      fs.chmodSync(streamingImgPath, 0o644);

      results.push({
        width,
        theme,
        idleScreenshot: `/workspace/work/send155/send155-${width}-${theme}-idle.png`,
        streamingScreenshot: `/workspace/work/send155/send155-${width}-${theme}-streaming.png`,
        buttonSize: '24x24',
        arrowContained: true,
        noTextDigits: true,
        steerFollowupNonOverlap: true,
        callbacksExactOnce: true,
      });
    }

    assert.equal(pageErrors.length, 0, `Page errors encountered: ${pageErrors.join('; ')}`);
    await context.close();
  }

  console.log(JSON.stringify({
    status: 'passed',
    casesEvaluated: results.length,
    matrixResults: results,
    buttonDesignInvariant: '24px strict',
    fixtureWarningsIgnored: fixtureWarnings.length,
  }, null, 2));

} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
