// tests/composer-annotation-badge.pw.mjs
// Real browser Playwright verification of annotation badge inside composer card,
// 4-row grid topology, no-overlap checks, interactive click/edit/delete/session switch,
// and text submit serialization preservation.

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

// 1. Extract real module04 annotation logic from enhancements/modules/04-sidebar-and-session-management.js
const module04Source = fs.readFileSync(
  path.join(root, 'enhancements/modules/04-sidebar-and-session-management.js'),
  'utf8'
);

// Extract from closeNativeQuoteSelectionToolbar to window.__PI_ENH_ANNOTATIONS__
const startIndex = module04Source.indexOf('function closeNativeQuoteSelectionToolbar');
const endIndex = module04Source.indexOf('const syncAnnotationUi = () => {', startIndex);
assert.ok(startIndex !== -1 && endIndex !== -1, 'Must find annotation subsystem in module04');
const annotationSubsystemCode = module04Source.slice(startIndex, endIndex);

// 2. Build ChatInput React bundle
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
      import React, { useState, useCallback, useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatInput } from './components/ChatInput';
      import { I18nProvider } from './hooks/useI18n';
      import { setDraft, getDraft } from './lib/draft-store';

      function TestApp() {
        const [isStreaming, setIsStreaming] = useState(false);
        const [queuedCount, setQueuedCount] = useState(0);
        const [draftKey, setDraftKey] = useState('session-a');
        const [theme, setTheme] = useState('dark');
        const [compact, setCompact] = useState(false);
        const [callLog, setCallLog] = useState([]);

        const logCall = useCallback((type, text) => {
          setCallLog(prev => [...prev, { type, text, ts: Date.now() }]);
          return true;
        }, []);

        useEffect(() => {
          document.documentElement.setAttribute('data-theme', theme);
        }, [theme]);

        const queuedMessages = React.useMemo(() => {
          if (queuedCount <= 0) return { steering: [], followUp: [], requestIds: { steering: [], followUp: [] } };
          return {
            steering: Array.from({ length: 1 }, (_, i) => 'Steer msg ' + i),
            followUp: Array.from({ length: queuedCount - 1 }, (_, i) => 'Followup msg ' + i),
            requestIds: { steering: [], followUp: [] },
          };
        }, [queuedCount]);

        window.__TEST_CONTROL__ = {
          setIsStreaming,
          setQueuedCount,
          setTheme,
          setDraftKey,
          setCompact,
          setDraft,
          getDraft,
          getCalls: () => callLog,
        };

        return (
          <div style={{ padding: '40px 16px', maxWidth: 820, margin: '0 auto' }}>
            <ChatInput
              key={draftKey}
              draftKey={draftKey}
              isStreaming={isStreaming}
              compact={compact}
              onSend={(text) => logCall('send', text)}
              onAbort={() => logCall('abort', '')}
              queuedMessages={queuedMessages}
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

// 3. Load styles (Full globals without truncation, native ComposerQueue.css, composer.css, enhancements.css)
const rawGlobals = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const globals = rawGlobals
  .replace(/^@(?:import|source).*$/gm, '')
  .replace(/@theme\s*\{[^}]*\}/s, '');
const queueCss = fs.readFileSync(path.join(root, 'components/ComposerQueue.css'), 'utf8');
const composerCss = fs.readFileSync(path.join(root, 'app/composer.css'), 'utf8');
const enhancementsCss = fs.readFileSync(path.join(root, 'app/enhancements.css'), 'utf8');
const fullCss = globals + '\n' + queueCss + '\n' + composerCss + '\n' + enhancementsCss;

// Valid synthetic PNG data URLs (40x40 solid green and blue)
const VALID_GREEN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAARUlEQVR4nO3OMREAIAAAIUNZxsTG0hTeOzCwM+Ze52ejDggK1gFBwTogKFgHBAXrgKBgHRAUrAOCgnVAULAOCArWAcHXLp29h5OBQ+3WAAAAAElFTkSuQmCC';
const VALID_BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAQklEQVR4nO3OsREAIAwAoczt8nEK7y0o6Jk5u1/LA4KCdUBQsA4ICtYBQcE6IChYBwQF64CgYB0QFKwDgoJ1QPCxCxoUbuIgc497AAAAAElFTkSuQmCC';

// Screenshot directory
const screenshotDir = '/workspace/work';
fs.mkdirSync(screenshotDir, { recursive: true });

// 4. Test HTTP Server
let base = '';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, base || 'http://127.0.0.1');
  if (u.pathname === '/bundle.js') {
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    return res.end(bundle.outputFiles[0].text);
  }
  if (u.pathname === '/module04-annotation.js') {
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    return res.end(`
      (function() {
        window.isPluginEnabled = function(id) { return true; };
        ${annotationSubsystemCode}
      })();
    `);
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
  <script src="/module04-annotation.js"></script>
</body>
</html>`);
});

let browser;
let exitCode = 0;

try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(base + '/?session=session-a', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chat-composer-card');

  // Verify no console errors
  assert.equal(pageErrors.length, 0, `Initial load must have 0 errors, got: ${JSON.stringify(pageErrors)}`);

  console.log('--- Step 1: annotations = 0 ---');
  // Card host must be empty, display: none, height 0, without empty padding
  const hostInfo = await page.evaluate(() => {
    const host = document.querySelector('[data-pi-native-annotation-host]');
    if (!host) return null;
    const style = window.getComputedStyle(host);
    const rect = host.getBoundingClientRect();
    return {
      exists: true,
      display: style.display,
      height: rect.height,
      childCount: host.children.length,
      innerHTML: host.innerHTML.trim(),
    };
  });
  assert.ok(hostInfo?.exists, 'Native annotation host slot must exist in DOM');
  assert.equal(hostInfo.childCount, 0, 'Host must have 0 children when annotations=0');
  assert.equal(hostInfo.display, 'none', 'Host must have display: none when empty');
  assert.equal(hostInfo.height, 0, 'Host height must be 0 when empty');

  console.log('--- Step 2: annotations = 1 ---');
  // Add 1 annotation and sync
  await page.evaluate(() => {
    window.__PI_ENH_ANNOTATIONS__.clear();
    window.__PI_ENH_ANNOTATIONS__.add('这是选中的第一段文本内容', '第一条详细说明');
    window.__PI_ENH_ANNOTATIONS__.sync();
  });

  await page.waitForSelector('.pi-enh-annotation-badge');

  // Geometry check: badge inside card, textarea.y >= badge.bottom
  const step2Geom = await page.evaluate(() => {
    const card = document.querySelector('.chat-composer-card');
    const host = document.querySelector('[data-pi-native-annotation-host]');
    const rail = document.querySelector('.pi-enh-annotation-rail');
    const badge = document.querySelector('.pi-enh-annotation-badge');
    const textarea = document.querySelector('textarea.chat-input-textarea');
    const toolbar = document.querySelector('.chat-composer-add-btn');

    const cardBox = card.getBoundingClientRect();
    const badgeBox = badge.getBoundingClientRect();
    const textareaBox = textarea.getBoundingClientRect();
    const toolbarBox = toolbar.getBoundingClientRect();

    return {
      railParentIsHost: rail.parentElement === host,
      hostParentIsCard: host.closest('.chat-composer-card') === card,
      badgeLabel: badge.querySelector('.pi-enh-annotation-badge-label')?.textContent?.trim(),
      cardBox,
      badgeBox,
      textareaBox,
      toolbarBox,
    };
  });

  assert.ok(step2Geom.railParentIsHost, 'annotation rail must be child of native annotation host');
  assert.ok(step2Geom.hostParentIsCard, 'host must be inside composer card');
  assert.equal(step2Geom.badgeLabel, '1 条注释');

  // Badge inside card boundaries
  assert.ok(step2Geom.badgeBox.y >= step2Geom.cardBox.y, 'badge.y must be inside card.y');
  assert.ok(step2Geom.badgeBox.bottom <= step2Geom.cardBox.bottom, 'badge.bottom must be inside card.bottom');

  // Strict non-overlap: textarea.y >= badge.bottom
  const badgeToTextareaGap = step2Geom.textareaBox.y - step2Geom.badgeBox.bottom;
  assert.ok(
    badgeToTextareaGap >= 0,
    `textarea.y (${step2Geom.textareaBox.y}) must be >= badge.bottom (${step2Geom.badgeBox.bottom}), gap: ${badgeToTextareaGap}`
  );

  // Textarea to toolbar gap >= 0
  const textareaToToolbarGap = step2Geom.toolbarBox.y - step2Geom.textareaBox.bottom;
  assert.ok(
    textareaToToolbarGap >= 0,
    `toolbar.y (${step2Geom.toolbarBox.y}) must be >= textarea.bottom (${step2Geom.textareaBox.bottom}), gap: ${textareaToToolbarGap}`
  );

  console.log('--- Step 3: annotations multiple (3) + valid images + queue 3 + multiline text ---');
  // First update draft & session to render attachments, queue, and multiline text in React
  await page.evaluate(({ greenPng, bluePng }) => {
    window.__TEST_CONTROL__.setDraft('session-a-rich', {
      value: '这是第一行多行输入文本\n这是第二行多行输入文本\n这是第三行长段落文本内容',
      images: [
        { data: greenPng, mimeType: 'image/png' },
        { data: bluePng, mimeType: 'image/png' },
      ],
    });
    window.__TEST_CONTROL__.setQueuedCount(3);
    window.history.pushState(null, '', '?session=session-a-rich');
    window.__TEST_CONTROL__.setDraftKey('session-a-rich');
  }, { greenPng: VALID_GREEN_PNG, bluePng: VALID_BLUE_PNG });

  await page.waitForSelector('.chat-composer-attachments');
  await page.waitForSelector('.pi-enh-queue-panel');

  // Now add the 3 annotations for this session and sync
  await page.evaluate(() => {
    window.__PI_ENH_ANNOTATIONS__.clear();
    window.__PI_ENH_ANNOTATIONS__.add('这是选中的第一段文本内容', '第一条详细说明');
    window.__PI_ENH_ANNOTATIONS__.add('第二段被引用的文本内容', '第二条详细说明');
    window.__PI_ENH_ANNOTATIONS__.add('第三段重点高亮文本', '第三条重要批注');
    window.__PI_ENH_ANNOTATIONS__.sync();
  });

  await page.waitForSelector('.pi-enh-annotation-badge');

  // Helper to verify non-overlap and text safety
  const verifyTopologyAndTextSafe = async (viewportName) => {
    const data = await page.evaluate(() => {
      const queue = document.querySelector('.pi-enh-queue-panel');
      const card = document.querySelector('.chat-composer-card');
      const attachments = document.querySelector('.chat-composer-attachments');
      const badge = document.querySelector('.pi-enh-annotation-badge');
      const textarea = document.querySelector('textarea.chat-input-textarea');
      const toolbarBtn = document.querySelector('.chat-composer-add-btn');
      const sendBtn = document.querySelector('button.chat-composer-send');
      const imgs = Array.from(document.querySelectorAll('.chat-composer-attachments img'));

      // Image validity check (ensure naturalWidth > 0, NOT broken image)
      const imagesLoaded = imgs.length > 0 && imgs.every(img => img.naturalWidth > 0 && img.naturalHeight > 0);

      // Text safety checks
      const textareaStyle = window.getComputedStyle(textarea);
      const badgeText = badge.querySelector('.pi-enh-annotation-badge-label')?.textContent?.trim();

      return {
        queueBox: queue.getBoundingClientRect(),
        cardBox: card.getBoundingClientRect(),
        attachmentsBox: attachments.getBoundingClientRect(),
        badgeBox: badge.getBoundingClientRect(),
        textareaBox: textarea.getBoundingClientRect(),
        toolbarBox: toolbarBtn.getBoundingClientRect(),
        sendBox: sendBtn.getBoundingClientRect(),
        badgeText,
        imagesLoaded,
        imgCount: imgs.length,
        textareaWritingMode: textareaStyle.writingMode,
      };
    });

    assert.equal(data.badgeText, '3 条注释');
    assert.equal(data.imgCount, 2, '2 attachment images rendered');
    assert.ok(data.imagesLoaded, 'Attachment images must be validly rendered, not broken');
    assert.equal(data.textareaWritingMode, 'horizontal-tb', 'textarea must be horizontal writing mode (no vertical wrap)');

    // 1. Queue is above card: queue sits above card and seamlessly integrates via native -7px margin
    assert.ok(
      data.queueBox.top < data.cardBox.y && data.cardBox.y >= data.queueBox.bottom - 8,
      `[${viewportName}] outer queue top (${data.queueBox.top}) must be above card.y (${data.cardBox.y}) with clean border integration`
    );

    // 2. Attachments inside card top: attachments.y >= card.y
    assert.ok(data.attachmentsBox.y >= data.cardBox.y, `[${viewportName}] attachments inside card`);

    // 3. Badge below attachments: badge.y >= attachments.bottom
    assert.ok(
      data.badgeBox.y >= data.attachmentsBox.bottom,
      `[${viewportName}] badge.y (${data.badgeBox.y}) must be >= attachments.bottom (${data.attachmentsBox.bottom})`
    );

    // 4. Textarea below badge: textarea.y >= badge.bottom
    assert.ok(
      data.textareaBox.y >= data.badgeBox.bottom,
      `[${viewportName}] textarea.y (${data.textareaBox.y}) must be >= badge.bottom (${data.badgeBox.bottom})`
    );

    // 5. Toolbar below textarea: toolbar.y >= textarea.bottom
    assert.ok(
      data.toolbarBox.y >= data.textareaBox.bottom,
      `[${viewportName}] toolbar.y (${data.toolbarBox.y}) must be >= textarea.bottom (${data.textareaBox.bottom})`
    );

    // 6. Toolbar send button vertical alignment
    assert.ok(
      Math.abs(data.toolbarBox.y - data.sendBox.y) < 12,
      `[${viewportName}] toolbar buttons aligned: add=${data.toolbarBox.y}, send=${data.sendBox.y}`
    );
  };

  // Viewport 1: Desktop 1124x800
  await page.setViewportSize({ width: 1124, height: 800 });
  await page.waitForTimeout(100);
  await verifyTopologyAndTextSafe('1124_desktop');

  const screenshot1124Path = path.join(screenshotDir, 'composer-annotation-1124.png');
  await page.screenshot({ path: screenshot1124Path, fullPage: false });
  fs.chmodSync(screenshot1124Path, 0o644);
  console.log(`Saved desktop screenshot to ${screenshot1124Path}`);

  // Viewport 2: Mobile 390x844
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  await verifyTopologyAndTextSafe('390_mobile');

  const screenshot390Path = path.join(screenshotDir, 'composer-annotation-390.png');
  await page.screenshot({ path: screenshot390Path, fullPage: false });
  fs.chmodSync(screenshot390Path, 0o644);
  console.log(`Saved mobile screenshot to ${screenshot390Path}`);

  // Restore 1280x800 for remaining interactive steps
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(100);

  console.log('--- Step 4: interactive click popup, delete 1, then clear all ---');
  // Click badge summary to open list popover
  await page.click('.pi-enh-annotation-badge-summary');
  await page.waitForSelector('.pi-enh-annotation-list');

  const listInfo = await page.evaluate(() => {
    const list = document.querySelector('.pi-enh-annotation-list');
    const items = list.querySelectorAll('.pi-enh-annotation-list-item');
    const rect = list.getBoundingClientRect();
    return {
      visible: window.getComputedStyle(list).display !== 'none',
      itemCount: items.length,
      rect,
    };
  });
  assert.ok(listInfo.visible, 'annotation popover list must be visible on click');
  assert.equal(listInfo.itemCount, 3, 'popover must render all 3 annotations');

  // Click delete button on the first item in the list
  await page.click('.pi-enh-annotation-list-item .pi-enh-annotation-list-delete');

  // Verify badge label becomes 2
  const updatedBadgeLabel = await page.evaluate(() => {
    return document.querySelector('.pi-enh-annotation-badge-label')?.textContent?.trim();
  });
  assert.equal(updatedBadgeLabel, '2 条注释');

  // Clear all annotations
  await page.evaluate(() => {
    window.__PI_ENH_ANNOTATIONS__.clear();
    window.__PI_ENH_ANNOTATIONS__.sync();
  });

  // Verify badge removed and host becomes empty / display: none
  const clearedHost = await page.evaluate(() => {
    const host = document.querySelector('[data-pi-native-annotation-host]');
    const badge = document.querySelector('.pi-enh-annotation-badge');
    const rail = document.querySelector('.pi-enh-annotation-rail');
    return {
      badgeExists: Boolean(badge),
      railExists: Boolean(rail),
      hostDisplay: window.getComputedStyle(host).display,
      hostChildren: host.children.length,
    };
  });
  assert.equal(clearedHost.badgeExists, false, 'Badge must be removed after clear');
  assert.equal(clearedHost.railExists, false, 'Rail must be removed after clear');
  assert.equal(clearedHost.hostChildren, 0, 'Host must be completely empty');
  assert.equal(clearedHost.hostDisplay, 'none', 'Host must have display: none');

  console.log('--- Step 5: session isolation (切 session 不串) ---');
  // First switch to session-a and wait for remount
  await page.evaluate(() => {
    window.history.pushState(null, '', '?session=session-a');
    window.__TEST_CONTROL__.setDraftKey('session-a');
  });
  await page.waitForSelector('.chat-composer-card');

  // In session-a, add 1 annotation
  await page.evaluate(() => {
    window.__PI_ENH_ANNOTATIONS__.clear();
    window.__PI_ENH_ANNOTATIONS__.add('Session A 专用引用内容', 'A 注释');
    window.__PI_ENH_ANNOTATIONS__.sync();
  });
  await page.waitForSelector('.pi-enh-annotation-badge');
  assert.equal(
    await page.evaluate(() => document.querySelector('.pi-enh-annotation-badge-label')?.textContent?.trim()),
    '1 条注释'
  );

  // Switch to session-b
  await page.evaluate(() => {
    window.history.pushState(null, '', '?session=session-b');
    window.__TEST_CONTROL__.setDraftKey('session-b');
  });
  await page.waitForSelector('.chat-composer-card');
  await page.evaluate(() => {
    window.__PI_ENH_ANNOTATIONS__.sync();
  });

  const sessionBBadge = await page.evaluate(() => {
    return document.querySelector('.pi-enh-annotation-badge');
  });
  assert.equal(sessionBBadge, null, 'Session B must have 0 annotations');

  // Switch back to session-a
  await page.evaluate(() => {
    window.history.pushState(null, '', '?session=session-a');
    window.__TEST_CONTROL__.setDraftKey('session-a');
  });
  await page.waitForSelector('.chat-composer-card');
  await page.evaluate(() => {
    window.__PI_ENH_ANNOTATIONS__.sync();
  });
  const sessionABadge = await page.evaluate(() => {
    return document.querySelector('.pi-enh-annotation-badge-label')?.textContent?.trim();
  });
  assert.equal(sessionABadge, '1 条注释', 'Session A annotation restored without cross-session leakage');

  console.log('--- Step 6: text submit serialization preservation ---');
  const serialized = await page.evaluate(() => {
    const prep = window.__PI_ENH_PREPARE_ANNOTATION_SUBMISSION__('prompt', '用户输入的测试问题内容');
    return {
      text: prep?.text,
      hasCommit: typeof prep?.commit === 'function',
    };
  });
  assert.ok(serialized.hasCommit, 'prepare submission must return commit function');
  assert.match(serialized.text, /> \*\*引用 \[1\]\*\*：Session A 专用引用内容/);
  assert.match(serialized.text, /> \*\*注释\*\*：A 注释/);
  assert.match(serialized.text, /用户输入的测试问题内容/);

  // Clean up
  await page.evaluate(() => {
    window.__PI_ENH_ANNOTATIONS__.clear();
  });

  console.log('--- Step 7: compact mode disables host and prevents annotation attachment ---');
  await page.evaluate(() => {
    window.__TEST_CONTROL__.setCompact(true);
  });
  await page.waitForTimeout(100);

  const compactCheck = await page.evaluate(() => {
    const host = document.querySelector('[data-pi-native-annotation-host]');
    const composerHost = document.querySelector('[data-pi-native-composer-host]');
    window.__PI_ENH_ANNOTATIONS__.clear();
    window.__PI_ENH_ANNOTATIONS__.add('Compact 模式不应挂载的文本', '注释');
    window.__PI_ENH_ANNOTATIONS__.sync();
    const rail = document.querySelector('.pi-enh-annotation-rail');
    return {
      hasAnnotationHost: Boolean(host),
      hasComposerHost: Boolean(composerHost),
      railAttached: Boolean(rail),
    };
  });
  assert.equal(compactCheck.hasAnnotationHost, false, 'Compact mode must not have annotation host slot');
  assert.equal(compactCheck.hasComposerHost, true, 'Compact mode must retain native composer identity');
  assert.equal(compactCheck.railAttached, false, 'Annotation rail must not attach in compact mode');

  // Restore compact=false
  await page.evaluate(() => {
    window.__TEST_CONTROL__.setCompact(false);
    window.__PI_ENH_ANNOTATIONS__.clear();
  });

  console.log('All 6 browser verification steps passed successfully!');
} catch (err) {
  console.error('Test execution failed:', err);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}

process.exit(exitCode);
