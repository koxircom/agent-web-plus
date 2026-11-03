const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outDir = '/workspace/work/send155';

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// 提取 baseline (app bundle) 与 155 candidate 中的 syncComposerQueueBadge 函数
function extractSyncFunctions() {
  const appBundlePath = '/app/public/pi-web-enhancements.js';
  const candModulePath = path.join(
    root,
    'enhancements/modules/05-composer-and-input-workflow.js',
  );

  let baselineFn = '';
  if (fs.existsSync(appBundlePath)) {
    const content = fs.readFileSync(appBundlePath, 'utf8');
    const m = content.match(/function syncComposerQueueBadge\([\s\S]*?\n  \}/);
    if (m) baselineFn = m[0];
  }
  if (!baselineFn) {
    // 兜底保留旧 05 模块核心逻辑：使用带 "button[title*='排队']" 的选择器
    baselineFn = `function syncComposerQueueBadge(count) {
      const qCount = Math.max(0, Number(count) || 0);
      const followupBtn = document.querySelector(".chat-composer-followup, button.pi-enh-cursor-followup, button[title*='排队'], button[title*='后续消息']");
      if (followupBtn) {
        let badge = followupBtn.querySelector(".pi-enh-queue-count-badge");
        if (qCount > 0) {
          if (!badge) {
            badge = document.createElement("span");
            badge.className = "pi-enh-queue-count-badge";
            badge.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--accent,#6366f1);color:#fff;font-size:10px;font-weight:700;line-height:1;margin-left:4px;";
            followupBtn.appendChild(badge);
          }
          badge.textContent = String(qCount);
          badge.title = \`当前队列中有 \${qCount} 个任务在排队等待执行\`;
          badge.style.display = "inline-flex";
        } else if (badge) {
          badge.remove();
        }
      }
    }`;
  }

  let candidateFn = '';
  if (fs.existsSync(candModulePath)) {
    const content = fs.readFileSync(candModulePath, 'utf8');
    const m = content.match(/function syncComposerQueueBadge\([\s\S]*?\n  \}/);
    if (m) candidateFn = m[0];
  }
  if (!candidateFn) {
    throw new Error('无法从 05-composer-and-input-workflow.js 提取 155 candidate 的 syncComposerQueueBadge 函数');
  }

  return { baselineFn, candidateFn };
}

async function main() {
  console.log('=== [155 回归测试] 队列操作栏无数字徽标与几何拓扑端到端验收 ===');

  const { baselineFn, candidateFn } = extractSyncFunctions();

  // 1. 读取真实 CSS 资产
  const queueCssPath = path.join(root, 'components/ComposerQueue.css');
  const enhancementsCssPath = path.join(root, 'app/enhancements.css');
  const queueCss = fs.existsSync(queueCssPath) ? fs.readFileSync(queueCssPath, 'utf8') : '';
  const enhancementsCss = fs.existsSync(enhancementsCssPath) ? fs.readFileSync(enhancementsCssPath, 'utf8') : '';

  // 2. 使用 esbuild 构建 React ComposerQueue 真实组件
  console.log('正在构建真实 React ComposerQueue 客户端 bundle...');
  const bundle = await esbuild.build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React, { useState, useMemo } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ComposerQueue } from './components/ComposerQueue';

        function TestQueueHost() {
          const [sessionId] = useState('sess-queue-155');
          const [steering] = useState(['优先引导任务：核验系统状态']);
          const [followUp] = useState(['排队任务 1：整理日志', '排队任务 2：生成报告']);
          const [requestIds] = useState({
            steering: ['req-s1'],
            followUp: ['req-f1', 'req-f2'],
          });

          const queuedMessages = useMemo(() => ({
            steering,
            followUp,
            requestIds,
          }), [steering, followUp, requestIds]);

          return (
            <div className="test-host" style={{ padding: '24px 12px', maxWidth: 820, margin: '0 auto' }}>
              <ComposerQueue
                sessionId={sessionId}
                executionEngine="pi"
                queuedMessages={queuedMessages}
                syncStatus="ready"
                onRestoreRecall={async () => true}
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
      'process.env.NEXT_PUBLIC_APP_VERSION': '"1.4.55"',
    },
  });

  const bundleJs = bundle.outputFiles[0].text;

  // 3. 启动轻量 HTTP v2 API Fixture
  let queueActionsCount = 0;
  let promoteRequestCount = 0;
  let deleteRequestCount = 0;
  let lastPromoteToken = null;

  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      return res.end(bundleJs);
    }
    if (req.url === '/styles.css') {
      res.setHeader('content-type', 'text/css; charset=utf-8');
      return res.end(`
        /* 真实 Dark 模式 CSS 变量 */
        :root, html.dark, [data-theme="dark"] {
          color-scheme: dark;
          --bg: #18181b;
          --bg-panel: #27272a;
          --bg-hover: #3f3f46;
          --bg-selected: #52525b;
          --border: #3f3f46;
          --text: #f4f4f5;
          --text-muted: #a1a1aa;
          --text-dim: #71717a;
          --accent: #6366f1;
          --accent-hover: #818cf8;
          --chat-content-max-width: 820px;
        }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #18181b;
          color: #f4f4f5;
        }
        ${queueCss}
        ${enhancementsCss}
      `);
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`
        <!doctype html>
        <html class="dark" data-theme="dark">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>ComposerQueue Regression Acceptance</title>
          <link rel="stylesheet" href="/styles.css">
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
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch (e) {}

        const type = parsed.type;

        if (type === 'get_queue_actions') {
          queueActionsCount++;
          return res.end(
            JSON.stringify({
              success: true,
              data: {
                version: 2,
                reorder: true,
                steering: [
                  { token: 'tok-s1', text: '优先引导任务：核验系统状态', imageCount: 0 },
                ],
                followUp: [
                  { token: 'tok-f1', text: '排队任务 1：整理日志', imageCount: 0 },
                  { token: 'tok-f2', text: '排队任务 2：生成报告', imageCount: 0 },
                ],
              },
            }),
          );
        }

        if (type === 'promote_queued_message') {
          promoteRequestCount++;
          lastPromoteToken = parsed.token;
          return res.end(JSON.stringify({ success: true, data: { version: 2 } }));
        }

        if (type === 'delete_queued_message') {
          deleteRequestCount++;
          return res.end(JSON.stringify({ success: true, data: { version: 2 } }));
        }

        res.statusCode = 404;
        return res.end(JSON.stringify({ success: false, error: 'Not found' }));
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

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const report = {
    task: 'queue-action-no-count',
    sendVersion: 'send155',
    timestamp: new Date().toISOString(),
    rootCauseInvestigation: {
      description: "旧 05 模块选择器包含 button[title*='排队']，误将 title='删除此排队消息' 的垃圾桶按钮识别为 followupBtn",
      baselineTrashBadgeReproduced: 0,
      candidate155TrashBadgeCount: 0,
    },
    viewports: {},
    passed: false,
    artifacts: [],
  };

  try {
    // ========================================================
    // 阶段 1：根因重现与对比 (Baseline vs 155 Current)
    // ========================================================
    console.log('\n[阶段 1] 校验根因重现：旧 writer 把垃圾桶当 followup 误挂 badge vs 155 彻底无 badge');
    const p1 = await browser.newPage({
      viewport: { width: 1124, height: 800 },
    });
    await p1.goto(baseUrl, { waitUntil: 'networkidle' });
    await p1.waitForSelector('.pi-enh-queue-row', { timeout: 10000 });

    // 确认已渲染 3 个 siblings
    const rowCount = await p1.locator('.pi-enh-queue-row').count();
    assert.equal(rowCount, 3, `预期渲染 3 个兄弟行，实际渲染 ${rowCount}`);

    // a. 运行 baseline 函数 (count = 2)
    const baselineResult = await p1.evaluate((fnCode) => {
      // 动态注入并执行 baseline 函数
      const fn = new Function('count', `${fnCode}; return syncComposerQueueBadge(count);`);
      fn(2);

      const deleteBtns = Array.from(document.querySelectorAll('.pi-enh-queue-delete'));
      const badgesOnTrash = deleteBtns.map((b) => b.querySelector('.pi-enh-queue-count-badge')).filter(Boolean);
      const firstTrashBadgeText = badgesOnTrash[0]?.textContent || null;
      return {
        trashBadgeCount: badgesOnTrash.length,
        badgeText: firstTrashBadgeText,
      };
    }, baselineFn);

    console.log(`-> Baseline 运行结果: 垃圾桶中徽标数 = ${baselineResult.trashBadgeCount}, 文本 = ${baselineResult.badgeText}`);
    assert.equal(baselineResult.trashBadgeCount, 1, '旧 writer 必须精确重现垃圾桶误挂 1 个徽标');
    assert.equal(baselineResult.badgeText, '2', '旧 writer 误挂的数字必须为队列总数 2');
    report.rootCauseInvestigation.baselineTrashBadgeReproduced = baselineResult.trashBadgeCount;

    // 清理 DOM 中的脏徽标
    await p1.evaluate(() => {
      document.querySelectorAll('.pi-enh-queue-count-badge').forEach((el) => el.remove());
    });

    // b. 运行 155 candidate 函数 (count = 2)
    const candidateResult = await p1.evaluate((fnCode) => {
      const fn = new Function('count', `${fnCode}; return syncComposerQueueBadge(count);`);
      fn(2);

      const allActionBadges = document.querySelectorAll('.pi-enh-queue-actions .pi-enh-queue-count-badge');
      const deleteBadges = document.querySelectorAll('.pi-enh-queue-delete .pi-enh-queue-count-badge');
      return {
        actionBadgesCount: allActionBadges.length,
        trashBadgesCount: deleteBadges.length,
      };
    }, candidateFn);

    console.log(`-> 155 Candidate 运行结果: 垃圾桶徽标数 = ${candidateResult.trashBadgesCount}, 操作栏徽标数 = ${candidateResult.actionBadgesCount}`);
    assert.equal(candidateResult.trashBadgesCount, 0, '155 candidate 下垃圾桶绝不能有任何数字徽标');
    assert.equal(candidateResult.actionBadgesCount, 0, '155 candidate 下操作栏内部绝无任何数字徽标');
    report.rootCauseInvestigation.candidate155TrashBadgeCount = candidateResult.trashBadgesCount;

    await p1.close();

    // ========================================================
    // 阶段 2：双视口 (390 Mobile & 1124 Desktop) Dark 几何拓扑与交互断言
    // ========================================================
    const viewportsToTest = [
      { width: 390, height: 844, isMobile: true, label: '390' },
      { width: 1124, height: 800, isMobile: false, label: '1124' },
    ];

    for (const vp of viewportsToTest) {
      console.log(`\n[阶段 2] 视口 ${vp.label} (${vp.width}x${vp.height}) Dark 模式验收...`);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.isMobile,
      });
      const page = await context.newPage();

      const pageErrors = [];
      const consoleErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.pi-enh-queue-row', { timeout: 10000 });

      // 1. 3 row y >= prev bottom (拓扑几何垂直无重叠)
      const rowsBox = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.pi-enh-queue-row'));
        return rows.map((r) => {
          const rect = r.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height };
        });
      });

      assert.equal(rowsBox.length, 3, `视口 ${vp.label}: 必须存在 3 个队列行`);
      assert(
        rowsBox[1].top >= rowsBox[0].bottom - 0.5,
        `视口 ${vp.label}: 行 1 与行 0 发生垂直重叠: row[1].top=${rowsBox[1].top}, row[0].bottom=${rowsBox[0].bottom}`,
      );
      assert(
        rowsBox[2].top >= rowsBox[1].bottom - 0.5,
        `视口 ${vp.label}: 行 2 与行 1 发生垂直重叠: row[2].top=${rowsBox[2].top}, row[1].bottom=${rowsBox[1].bottom}`,
      );
      console.log(`-> 视口 ${vp.label}: 3 行垂直拓扑无重叠断言通过 (y >= prev bottom)`);

      // 2. promote / delete / more bbox non-overlap (横向无重叠)
      const actionNonOverlap = await page.evaluate(() => {
        const actionGroups = Array.from(document.querySelectorAll('.pi-enh-queue-actions'));
        const overlaps = [];
        for (let gIdx = 0; gIdx < actionGroups.length; gIdx++) {
          const group = actionGroups[gIdx];
          const buttons = Array.from(group.querySelectorAll('button')).filter((b) => {
            const style = window.getComputedStyle(b);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
          // 按横坐标排序
          buttons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          for (let i = 0; i < buttons.length - 1; i++) {
            const cur = buttons[i].getBoundingClientRect();
            const next = buttons[i + 1].getBoundingClientRect();
            if (next.left < cur.right - 0.5) {
              overlaps.push({
                group: gIdx,
                curClass: buttons[i].className,
                nextClass: buttons[i + 1].className,
                curRight: cur.right,
                nextLeft: next.left,
              });
            }
          }
        }
        return overlaps;
      });
      assert.equal(
        actionNonOverlap.length,
        0,
        `视口 ${vp.label}: 操作栏按钮存在重叠: ${JSON.stringify(actionNonOverlap)}`,
      );
      console.log(`-> 视口 ${vp.label}: promote / delete / more 横向无重叠断言通过`);

      // 3. 所有 buttons SVG contain (SVG 必须完全包含在 button 盒内)
      const svgContainment = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('.pi-enh-queue-panel button'));
        const leaks = [];
        for (const btn of buttons) {
          const svg = btn.querySelector('svg');
          if (!svg) continue;
          const btnRect = btn.getBoundingClientRect();
          const svgRect = svg.getBoundingClientRect();
          const contained =
            svgRect.left >= btnRect.left - 0.5 &&
            svgRect.right <= btnRect.right + 0.5 &&
            svgRect.top >= btnRect.top - 0.5 &&
            svgRect.bottom <= btnRect.bottom + 0.5;
          if (!contained) {
            leaks.push({
              btnClass: btn.className,
              btnRect,
              svgRect,
            });
          }
        }
        return leaks;
      });
      assert.equal(
        svgContainment.length,
        0,
        `视口 ${vp.label}: 按钮内部 SVG 发生溢出: ${JSON.stringify(svgContainment)}`,
      );
      console.log(`-> 视口 ${vp.label}: 所有 buttons SVG contain 断言通过`);

      // 4. 无可视 digits 在 action group
      const digitsInActions = await page.evaluate(() => {
        const groups = Array.from(document.querySelectorAll('.pi-enh-queue-actions'));
        const found = [];
        for (const g of groups) {
          // 获取所有直接文本与子元素文本
          const text = g.innerText || '';
          const digits = text.match(/\d+/g);
          if (digits && digits.length > 0) {
            found.push({ text, digits });
          }
        }
        return found;
      });
      assert.equal(
        digitsInActions.length,
        0,
        `视口 ${vp.label}: 操作栏中检测到可视数字: ${JSON.stringify(digitsInActions)}`,
      );
      console.log(`-> 视口 ${vp.label}: 操作栏无可视 digits 断言通过`);

      // 5. pointer hover / focus delete confirming 再取消（不真 delete API） geometry 稳
      const firstDelete = page.locator('.pi-enh-queue-delete').first();
      await firstDelete.hover();
      await firstDelete.focus();

      const initialDeleteBox = await firstDelete.boundingBox();

      // 单次点击进入 confirming
      await firstDelete.click();
      await page.waitForFunction(() => {
        const btn = document.querySelector('.pi-enh-queue-delete');
        return btn && btn.classList.contains('pi-enh-queue-delete-confirming');
      });

      const confirmingTitle = await firstDelete.getAttribute('title');
      assert.equal(confirmingTitle, '再次点击确认删除');

      const confirmingDeleteBox = await firstDelete.boundingBox();
      // 验证几何尺寸未突变
      assert(
        Math.abs(confirmingDeleteBox.width - initialDeleteBox.width) <= 1,
        `confirming 宽度发生异常跳变: ${confirmingDeleteBox.width} vs ${initialDeleteBox.width}`,
      );
      assert(
        Math.abs(confirmingDeleteBox.height - initialDeleteBox.height) <= 1,
        `confirming 高度发生异常跳变: ${confirmingDeleteBox.height} vs ${initialDeleteBox.height}`,
      );

      // 保存 confirming 状态截图
      const confirmingPng = path.join(outDir, 'queue-action-confirming.png');
      if (vp.label === '1124') {
        await page.screenshot({ path: confirmingPng });
        fs.chmodSync(confirmingPng, 0o644);
        report.artifacts.push(confirmingPng);
      }

      // 取消确认状态：点击页面外部空白区域使之取消，或通过失焦
      await page.evaluate(() => {
        // 触发失焦 / 点击空白
        document.body.click();
      });
      // 确认未发起真实 delete API 请求
      assert.equal(deleteRequestCount, 0, '安全红线：取消 confirming 绝不能调用真实 delete API');
      console.log(`-> 视口 ${vp.label}: delete confirming 几何稳定且未触碰 delete API 断言通过`);

      // 6. click promote actual fixture exactly once
      const promoteBtn = page.locator('.pi-enh-queue-promote').first();
      const prevPromoteCount = promoteRequestCount;
      await promoteBtn.click();
      await page.waitForTimeout(300);
      assert.equal(
        promoteRequestCount,
        prevPromoteCount + 1,
        `promote 真实 fixture 必须精确触发 1 次，当前 count: ${promoteRequestCount}`,
      );
      assert.equal(lastPromoteToken, 'tok-f1', 'promote 传递的 token 必须精确匹配首个 follow-up');
      console.log(`-> 视口 ${vp.label}: click promote 精确调用真实 fixture 1 次通过`);

      // 7. hide menu no issues (打开并关闭 more 菜单)
      const moreBtn = page.locator('.pi-enh-queue-more').first();
      await moreBtn.click();
      await page.waitForSelector('.pi-enh-queue-menu', { timeout: 3000 });
      assert.equal(await moreBtn.getAttribute('aria-expanded'), 'true');

      // 再次点击关闭菜单
      await moreBtn.click();
      await page.waitForFunction(() => !document.querySelector('.pi-enh-queue-menu'));
      assert.equal(await moreBtn.getAttribute('aria-expanded'), 'false');
      console.log(`-> 视口 ${vp.label}: popover 菜单展开与关闭无异常通过`);

      // 截取当前视口完整截图
      const vpPng = path.join(outDir, `queue-action-${vp.label}.png`);
      await page.screenshot({ path: vpPng });
      fs.chmodSync(vpPng, 0o644);
      report.artifacts.push(vpPng);

      assert.equal(pageErrors.length, 0, `页面错误: ${pageErrors.join(', ')}`);
      assert.equal(consoleErrors.length, 0, `控制台错误: ${consoleErrors.join(', ')}`);

      report.viewports[vp.label] = {
        rowsBox,
        actionNonOverlap: true,
        svgContainment: true,
        digitsInActions: 0,
        confirmingGeometryStable: true,
        deleteRequestCount,
        promoteRequestCount,
        menuToggleClean: true,
        pageErrors,
        consoleErrors,
      };

      await context.close();
    }

    report.passed = true;
    const reportJsonPath = path.join(outDir, 'queue-action-report.json');
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), { mode: 0o644 });
    report.artifacts.push(reportJsonPath);

    console.log('\n=== 所有断言全部通过！验收产物已落盘至 /workspace/work/send155/ ===');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('\n❌ 回归测试执行失败:\n', err);
  process.exit(1);
});
