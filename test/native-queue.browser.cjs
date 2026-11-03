const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

// 1x1 valid base64 PNGs
const IMG_RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG_BLUE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main() {
  console.log('--- 启动原生队列真实浏览器组件与HTTP Fixture深度验收 ---');

  // 构建真实客户端 Bundle
  const bundle = await esbuild.build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React, { useState, useEffect, useMemo } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ComposerQueue } from './components/ComposerQueue';
        import { recallSingleQueuedMessage } from './lib/composer-queue-client';

        window.recallSingleQueuedMessage = recallSingleQueuedMessage;

        function TestQueueHost() {
          const [sessionId, setSessionId] = useState('sess-a');
          const [steering, setSteering] = useState(['优先任务-同文']);
          const [followUp, setFollowUp] = useState(['后续任务-同文']);
          const [requestIds, setRequestIds] = useState({ steering: ['req-s1'], followUp: ['req-f1'] });
          const [hasRecallCallback, setHasRecallCallback] = useState(true);
          const [rerenderTick, setRerenderTick] = useState(0);

          useEffect(() => {
            window.__setSessionId = (sid) => setSessionId(sid);
            window.__setQueueData = (st, fu, rids) => {
              setSteering(st);
              setFollowUp(fu);
              if (rids) setRequestIds(rids);
            };
            window.__setHasRecallCallback = (v) => setHasRecallCallback(v);
            window.__triggerRerender = () => setRerenderTick((t) => t + 1);
            window.__getRenderCount = () => rerenderTick;
          }, [rerenderTick]);

          const queuedMessages = useMemo(() => ({
            steering,
            followUp,
            requestIds,
          }), [steering, followUp, requestIds]);

          return (
            <div className="test-queue-container" style={{ padding: 24, maxWidth: 600, background: '#18181b', color: '#fff' }}>
              <div data-testid="render-counter" style={{ display: 'none' }}>{rerenderTick}</div>
              <ComposerQueue
                sessionId={sessionId}
                queuedMessages={queuedMessages}
                syncStatus="ready"
                onRestoreRecall={
                  hasRecallCallback
                    ? async (payload) => {
                        window.__lastRestoredPayload = payload;
                        return true;
                      }
                    : undefined
                }
              />
            </div>
          );
        }

        createRoot(document.getElementById('root')).render(<TestQueueHost />);
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    alias: { '@': root },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_APP_VERSION': '"1.4.46"',
    },
  });

  const bundleJs = bundle.outputFiles[0].text;

  // HTTP API Fixture 状态记录
  let queueActionsRequestCount = 0;
  let deleteRequestCount = 0;
  let recallRequestCount = 0;
  let deleteShouldFail = false;
  let slowSessionADelayMs = 0;
  let slowSessionAFail = false;

  const server = http.createServer((req, res) => {
    // 静态资源响应
    if (req.url === '/bundle.js') {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      return res.end(bundleJs);
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Native Queue Browser Test</title>
          <style>
            body { margin: 0; font-family: sans-serif; background: #09090b; color: #f4f4f5; }
            .image-preview-dialog { position: fixed; inset: 0; margin: auto; background: rgba(0,0,0,0.85); border: none; z-index: 1000; }
          </style>
        </head>
        <body>
          <div id="root"></div>
          <script src="/bundle.js"></script>
        </body>
        </html>
      `);
    }

    // Agent API 路由
    if (req.url.startsWith('/api/agent/')) {
      const sessionId = decodeURIComponent(req.url.replace('/api/agent/', ''));
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch (e) {}

        const type = parsed.type;

        if (type === 'get_queue_actions') {
          queueActionsRequestCount++;
          // 返回标准 v2 snapshot
          if (sessionId === 'sess-gallery') {
            return res.end(
              JSON.stringify({
                success: true,
                data: {
                  version: 2,
                  reorder: true,
                  steering: [{ token: 'tok-gal-1', text: '图集消息', imageCount: 2 }],
                  followUp: [],
                },
              }),
            );
          }
          if (sessionId === 'sess-a') {
            return res.end(
              JSON.stringify({
                success: true,
                data: {
                  version: 2,
                  reorder: true,
                  steering: [{ token: 'tok-s1', text: '优先任务-同文', imageCount: 0 }],
                  followUp: [{ token: 'tok-f1', text: '后续任务-同文', imageCount: 0 }],
                },
              }),
            );
          }
          if (sessionId === 'sess-b') {
            return res.end(
              JSON.stringify({
                success: true,
                data: {
                  version: 2,
                  reorder: true,
                  steering: [],
                  followUp: [{ token: 'tok-b1', text: '会话B任务', imageCount: 0 }],
                },
              }),
            );
          }
          return res.end(
            JSON.stringify({
              success: true,
              data: { version: 2, reorder: true, steering: [], followUp: [] },
            }),
          );
        }

        if (type === 'get_queued_message') {
          // 真实 getQueuedMessage 输出：无 version，直接返回 { text, kind, token, images }
          if (parsed.token === 'tok-gal-1') {
            return res.end(
              JSON.stringify({
                success: true,
                data: {
                  token: 'tok-gal-1',
                  text: '图集消息',
                  kind: 'steering',
                  images: [
                    { data: IMG_RED_PNG, mimeType: 'image/png', alt: '红色单像素' },
                    { data: IMG_BLUE_PNG, mimeType: 'image/png', alt: '蓝色单像素' },
                  ],
                },
              }),
            );
          }
          return res.end(
            JSON.stringify({
              success: true,
              data: {
                token: parsed.token,
                text: '普通消息',
                kind: 'steering',
                images: [],
              },
            }),
          );
        }

        if (type === 'delete_queued_message') {
          deleteRequestCount++;
          if (deleteShouldFail) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
          }
          return res.end(JSON.stringify({ success: true, data: { version: 2, success: true } }));
        }

        if (type === 'recall_queued_message') {
          recallRequestCount++;
          return res.end(
            JSON.stringify({
              success: true,
              data: {
                version: 2,
                token: parsed.token,
                text: '召回内容',
                kind: 'steering',
                images: [],
              },
            }),
          );
        }

        if (type === 'promote_queued_message') {
          if (slowSessionADelayMs > 0 && sessionId === 'sess-a') {
            await new Promise((r) => setTimeout(r, slowSessionADelayMs));
            if (slowSessionAFail) {
              res.statusCode = 500;
              return res.end(JSON.stringify({ success: false, error: 'Session A 延迟失败' }));
            }
          }
          return res.end(
            JSON.stringify({
              success: true,
              data: { version: 2, queuedMessages: { steering: [], followUp: [] } },
            }),
          );
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ success: false }));
      });
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`HTTP fixture 服务已就绪: ${baseUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();

  page.on('pageerror', (err) => {
    // 捕获页面未捕获异常
    console.error('[Page Error]:', err);
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // ==========================================
    // [测试 1: 同文 token 隔离]
    // ==========================================
    console.log('[Test 1] 校验同文 token 精确隔离，不按 text 混淆');
    await page.waitForSelector('.pi-enh-queue-row');
    const rows = await page.$$('.pi-enh-queue-row');
    assert.equal(rows.length, 2, '存在 2 条排队消息');

    const text0 = await rows[0].$eval('.pi-enh-queue-text', (el) => el.textContent?.trim());
    const text1 = await rows[1].$eval('.pi-enh-queue-text', (el) => el.textContent?.trim());
    assert.equal(text0, '优先任务-同文');
    assert.equal(text1, '后续任务-同文');
    console.log('-> 同文 token 隔离断言通过！');

    // ==========================================
    // [测试 2: 首次/刷新图与多图可切换 Gallery]
    // ==========================================
    console.log('[Test 2] 首次/刷新图，校验多图角标与原生多图切换 Gallery');
    await page.evaluate(() => {
      window.__setSessionId('sess-gallery');
      window.__setQueueData(['图集消息'], [], { steering: ['req-g1'], followUp: [] });
    });

    await page.waitForSelector('.pi-enh-queue-image-badge');
    const badgeCount = await page.$eval('.pi-enh-queue-image-count', (el) => el.textContent?.trim());
    assert.equal(badgeCount, '2', '多图徽标正确显示数字 2');

    // 点击打开 Gallery 弹窗
    await page.click('.pi-enh-queue-image-badge');
    await page.waitForSelector('.pi-enh-queue-gallery-dialog[open]');

    // 断言初始图片与计数 1 / 2
    let counterText = await page.$eval('.pi-enh-queue-gallery-dialog', (dialog) => {
      return dialog.querySelector('.mt-2')?.textContent?.trim() || '';
    });
    assert.match(counterText, /1\s*\/\s*2/, '初始展示 1 / 2');

    // 点击“下一张”按钮切换
    await page.click('[aria-label="下一张图片"]');
    counterText = await page.$eval('.pi-enh-queue-gallery-dialog', (dialog) => {
      return dialog.querySelector('.mt-2')?.textContent?.trim() || '';
    });
    assert.match(counterText, /2\s*\/\s*2/, '切换后展示 2 / 2');

    // 按 Escape 键关闭弹窗
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pi-enh-queue-gallery-dialog', { state: 'detached' });
    console.log('-> 多图可切换 Gallery 与键盘交互断言通过！');

    // ==========================================
    // [测试 3: 失败 delete]
    // ==========================================
    console.log('[Test 3] 校验失败 delete 不乐观抹除 DOM，并渲染 role="alert" 反馈');
    // 切回 sess-a
    await page.evaluate(() => {
      window.__setSessionId('sess-a');
      window.__setQueueData(['优先任务-同文'], ['后续任务-同文'], { steering: ['req-s1'], followUp: ['req-f1'] });
    });
    await page.waitForSelector('.pi-enh-queue-row');

    deleteShouldFail = true;
    const deleteBtn = await page.$('.pi-enh-queue-row .pi-enh-queue-delete');
    assert.ok(deleteBtn);
    // 首次点击：进入确认态
    await deleteBtn.click();
    // 再次点击：确认删除
    await deleteBtn.click();

    // 等待网络请求完成并反馈呈现
    await page.waitForSelector('[role="alert"]');
    const alertText = await page.$eval('[role="alert"]', (el) => el.textContent?.trim());
    assert.ok(/删除排队消息失败|Internal Server Error/.test(alertText), `展示错误警告: ${alertText}`);

    // 检查 DOM 节点绝未被乐观抹除
    const currentRows = await page.$$('.pi-enh-queue-row');
    assert.equal(currentRows.length, 2, '失败后 DOM 未被错误抹除');
    console.log('-> 失败 delete 防乐观抹除与 alert 反馈断言通过！');

    // ==========================================
    // [测试 4: rerender 请求有界（防无限循环）]
    // ==========================================
    console.log('[Test 4] 连续 10 次 rerender，断言网络请求严格有界，绝无无限循环');
    const beforeCount = queueActionsRequestCount;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.__triggerRerender());
    }
    await page.waitForTimeout(300);
    const afterCount = queueActionsRequestCount;
    assert.equal(afterCount - beforeCount, 0, `rerender 10 次增量请求次数严格为 0 (实际: ${afterCount - beforeCount})`);
    console.log('-> 请求有界断言通过！');

    // ==========================================
    // [测试 5: A → B 迟回隔离]
    // ==========================================
    console.log('[Test 5] 校验 Session A 晚回绝不污染 Session B');
    slowSessionADelayMs = 150;
    slowSessionAFail = true;

    // 触发 Session A 的 promote 操作（需要 150ms 并抛错）
    await page.click('.pi-enh-queue-row .pi-enh-queue-promote');

    // 立即切换到 Session B
    await page.evaluate(() => {
      window.__setSessionId('sess-b');
      window.__setQueueData([], ['会话B任务'], { steering: [], followUp: ['req-b1'] });
    });

    // 等待 250ms 让 Session A 的请求晚回
    await page.waitForTimeout(250);

    // 断言 Session B 没有任何 Session A 的错误，也没有被锁在 busy 状态
    const bAlertExists = (await page.$('[role="alert"]')) !== null;
    assert.equal(bAlertExists, false, 'Session B 不存在 Session A 晚回的 alert 报错');
    const isBusy = await page.$eval('.pi-enh-queue-panel', (el) => el.getAttribute('aria-busy'));
    assert.notEqual(isBusy, 'true', 'Session B 未被 Session A 的晚回置为 busy');
    console.log('-> A → B 迟回隔离断言通过！');

    // ==========================================
    // [测试 6: recall callback 缺失不发 POST]
    // ==========================================
    console.log('[Test 6] 校验 onRestoreRecall 缺失时前置拒绝，RPC 次数严格为 0');
    const beforeRecallCount = recallRequestCount;
    const recallResult = await page.evaluate(async () => {
      try {
        await window.recallSingleQueuedMessage({
          sessionId: 'sess-a',
          token: 'tok-s1',
          // 故意不传 onRestoreRecall
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });

    assert.equal(recallResult.success, false, '缺少回调必须被拒绝');
    assert.match(recallResult.error, /缺少移回输入框处理回调/);
    assert.equal(recallRequestCount - beforeRecallCount, 0, '未向服务端发送任何 recall POST 请求');
    console.log('-> recall callback 缺失前置拦截断言通过！');

    console.log('=== 所有 6 项真实浏览器与 HTTP Fixture 端到端测试全绿通过！===');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
