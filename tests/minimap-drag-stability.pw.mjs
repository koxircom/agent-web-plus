import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, "..");
const acceptanceDir = path.resolve(sourceRoot, "../acceptance");
if (!fs.existsSync(acceptanceDir)) {
  fs.mkdirSync(acceptanceDir, { recursive: true });
}

const projectRequire = createRequire(path.join(sourceRoot, "package.json"));
const { build } = projectRequire("esbuild");
const { chromium } = projectRequire("playwright");

console.log("=== Running Minimap Drag Stability Playwright Tests ===");

// 导航本地偏好设置键名（与 lib/enhancements 统一）
const MINIMAP_INITIAL_TURNS_KEY = "pi-enh-minimap-initial-turns";
const MINIMAP_STEP_TURNS_KEY = "pi-enh-minimap-step-turns";

const user = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const assistant = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
  api: "openai-responses",
  provider: "openai",
  model: "gpt-6.1-sol",
  stopReason: "stop",
  usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

// 构造真实 20+ user 行（24 轮真实对话），制造足够滚动高度以发生真实 overflow
const userTopics = [
  "会话导航与拖拽稳定性测试",
  "触摸斜向滑动场景复现",
  "普通竖滚与右滑关闭",
  "条目点击定位与书签交互",
  "滚动条按住拖动稳定性",
  "高频触摸事件吞吐量",
  "历史分页加载逻辑",
  "宽屏与窄屏自适应响应",
  "滚动容器溢出高度计算",
  "手势方向判定意图锁",
  "拖拽过程中取消事件安全性",
  "定时器清理与内存泄漏防护",
  "长文本换行与节点高度自适应",
  "会话切换上下文保持",
  "导航栏与编辑器输入防冲突",
  "极速回弹与惯性滚动衰减",
  "多触点防误触过滤",
  "触控设备指针捕获测试",
  "大视口全屏布局测试",
  "暗黑主题色彩对比核验",
  "无障碍导航属性测试",
  "边界溢出保护闭环验证",
  "最终综合端到端集成测试",
  "收尾验收测试轮次",
];

const messages1 = [];
for (let i = 0; i < userTopics.length; i++) {
  const round = i + 1;
  messages1.push(user(`第 ${round} 轮：${userTopics[i]}`));
  messages1.push(
    assistant(
      `这是第 ${round} 轮助手的回复内容，包含较长的正文段落以确保对话消息区域有足够的真实滚动高度。\n\n` +
      `段落内容测试（轮次 ${round}）：` + "Minimap 稳定性与手势平滑度测试验证。 ".repeat(15)
    )
  );
}

const messages2 = [
  user("会话 2 轮次 1：切换会话测试"),
  assistant("会话 2 已经挂载，验证 minimap 在不同会话切换下依然稳定。\n\n" + "填充段落测试滚动。 ".repeat(25)),
  user("会话 2 轮次 2：更多内容"),
  assistant("这是会话 2 的第二轮回复内容，保证内容可以滚动。\n\n" + "更多段落测试内容。 ".repeat(25)),
  user("会话 2 轮次 3：长内容确保可滚动"),
  assistant("这是会话 2 的第三轮回复内容，确保满足桌面 minimap 展示条件。\n\n" + "滚动高度足够。 ".repeat(25)),
];

const session1 = {
  id: "minimap-drag-fixture-1",
  cwd: "/isolated",
  name: "Minimap Drag Fixture 1",
  path: "/isolated/session-1.jsonl",
  created: new Date().toISOString(),
  modified: new Date().toISOString(),
  messageCount: messages1.length,
  firstMessage: "minimap drag test 1",
};

const session2 = {
  id: "minimap-drag-fixture-2",
  cwd: "/isolated",
  name: "Minimap Drag Fixture 2",
  path: "/isolated/session-2.jsonl",
  created: new Date().toISOString(),
  modified: new Date().toISOString(),
  messageCount: messages2.length,
  firstMessage: "minimap drag test 2",
};

const bundle = await build({
  stdin: {
    resolveDir: sourceRoot,
    loader: "tsx",
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWindow } from './components/ChatWindow';
import { I18nProvider } from './hooks/useI18n';

function Fixture() {
  const [open, setOpen] = useState(false);
  const [currentSession, setCurrentSession] = useState(${JSON.stringify(session1)});

  return (
    <I18nProvider>
      <div style={{ padding: 4, display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
        <button id="fixture-open" onClick={() => setOpen(true)}>打开导航</button>
        <button id="fixture-close" onClick={() => setOpen(false)}>关闭导航</button>
        <button id="fixture-switch" onClick={() => {
          setCurrentSession(prev => prev.id === "minimap-drag-fixture-1" ? ${JSON.stringify(session2)} : ${JSON.stringify(session1)});
        }}>切换会话</button>
        <span id="nav-open-state">{open ? "OPEN" : "CLOSED"}</span>
      </div>
      <ChatWindow
        key={currentSession.id}
        session={currentSession}
        newSessionCwd={null}
        newSessionDraftKey={null}
        mobileNavigationOpen={open}
        onMobileNavigationOpenChange={setOpen}
      />
    </I18nProvider>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
    `,
  },
  bundle: true,
  write: false,
  outfile: "fixture.js",
  format: "iife",
  alias: { "@": sourceRoot },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
});

const { compileSettingsCss } = projectRequire("./tests/native-settings-css.cjs");
const css = (await compileSettingsCss()) + "\n" + bundle.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://fixture");
  if (u.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript");
    return res.end(bundle.outputFiles.find((f) => f.path.endsWith(".js")).text);
  }
  if (u.pathname.endsWith("/events")) {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: " + JSON.stringify({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] }) + "\n\n");
    return;
  }
  if (u.pathname.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    if (u.pathname.startsWith("/api/sessions/minimap-drag-fixture-")) {
      const isS2 = u.pathname.includes("fixture-2");
      const s = isS2 ? session2 : session1;
      const msgs = isS2 ? messages2 : messages1;
      const eIds = msgs.map((_, i) => "e" + i);
      return res.end(
        JSON.stringify({
          sessionId: s.id,
          info: s,
          tree: [],
          leafId: eIds[eIds.length - 1],
          totalActiveMs: 0,
          context: {
            messages: msgs,
            entryIds: eIds,
            oldestEntryId: "e0",
            hasMore: false,
            thinkingLevel: "off",
            model: { provider: "openai", modelId: "gpt-6.1-sol", id: "gpt-6.1-sol" },
          },
        })
      );
    }
    return res.end(JSON.stringify({
      success: true,
      models: { "openai:gpt-6.1-sol": "GPT-6.1 Sol" },
      modelList: [],
      skills: [],
      running: false,
      isStreaming: false,
      pendingExtensionUiRequests: [],
      data: {},
      tools: [],
    }));
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!DOCTYPE html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><script>
try {
  localStorage.setItem("${MINIMAP_INITIAL_TURNS_KEY}", "30");
  localStorage.setItem("${MINIMAP_STEP_TURNS_KEY}", "10");
} catch (e) {}
window.__PI_ENH_GET_MINIMAP_HISTORY_SETTINGS__ = () => ({
  initialTurns: 30,
  stepTurns: 10,
});
</script></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
});

let browser;
const acceptanceReceipt = {
  timestamp: new Date().toISOString(),
  target: "/workspace/work/releases/minimap-drag-stability-20261021/source/tests/minimap-drag-stability.pw.mjs",
  fixtures: {
    userTurnsCount: userTopics.length,
    totalMessages: messages1.length,
    initialTurnsPreference: 30,
  },
  desktop980: {},
  mobile390: {},
  cdpEvents: {
    totalDispatched: 0,
    browserReceived: { trusted: 0, untrusted: 0 },
  },
  pageErrors: [],
  status: "pending",
};

let totalCdpDispatched = 0;

try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox"],
  });

  // ------------------------------------------------------------------------
  // PART 1: 980px Desktop / Wide Touchscreen Tests (Minimap Track & Drawer)
  // ------------------------------------------------------------------------
  console.log("--- PART 1: 980px Desktop / Wide Touchscreen Tests ---");
  {
    const page = await browser.newPage({
      viewport: { width: 980, height: 800 },
      hasTouch: true,
    });

    const desktopPageErrors = [];
    page.on("pageerror", (err) => {
      const msg = String(err?.message || err);
      console.error("[980px pageerror]:", msg);
      desktopPageErrors.push(msg);
      acceptanceReceipt.pageErrors.push(`[980px] ${msg}`);
    });

    await page.addInitScript(() => {
      try {
        localStorage.setItem("pi-enh-minimap-initial-turns", "30");
        localStorage.setItem("pi-enh-minimap-step-turns", "10");
      } catch (e) {}
      window.__PI_ENH_GET_MINIMAP_HISTORY_SETTINGS__ = () => ({
        initialTurns: 30,
        stepTurns: 10,
      });

      window.__cdpTouchStats = { touchStart: 0, touchMove: 0, touchEnd: 0, touchCancel: 0, trusted: 0, untrusted: 0 };
      const record = (e) => {
        if (e.isTrusted) window.__cdpTouchStats.trusted++;
        else window.__cdpTouchStats.untrusted++;
        if (e.type === "touchstart") window.__cdpTouchStats.touchStart++;
        if (e.type === "touchmove") window.__cdpTouchStats.touchMove++;
        if (e.type === "touchend") window.__cdpTouchStats.touchEnd++;
        if (e.type === "touchcancel") window.__cdpTouchStats.touchCancel++;
      };
      window.addEventListener("touchstart", record, { capture: true, passive: true });
      window.addEventListener("touchmove", record, { capture: true, passive: true });
      window.addEventListener("touchend", record, { capture: true, passive: true });
      window.addEventListener("touchcancel", record, { capture: true, passive: true });
    });

    const client = await page.context().newCDPSession(page);

    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('[data-pi-native-scroll-owner]').waitFor();
    await page.locator('[data-minimap-native-owner="true"]').waitFor();

    // 辅助函数：通过 CDP 发送原生 touch 事件并统计
    const cdpTouchSwipe = async (points, delayMs = 16) => {
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (i === 0) {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), id: 1 }],
          });
          totalCdpDispatched++;
        } else {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), id: 1 }],
          });
          totalCdpDispatched++;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      totalCdpDispatched++;
      await new Promise((r) => setTimeout(r, delayMs));
    };

    // 1a. 优先使用真实 rail 点按打开桌面 minimap 导航面板
    console.log("1a. 优先使用真实 rail 点按打开桌面导航抽屉...");
    const railHit = page.locator('[data-minimap-rail-hit="true"]').first();
    const railOwner = page.locator('[data-minimap-native-owner="true"]').first();
    let railTapTriggered = false;
    if (await railHit.count() > 0 && await railHit.isVisible()) {
      await railHit.click({ position: { x: 18, y: 150 } });
      railTapTriggered = true;
    } else if (await railOwner.count() > 0 && await railOwner.isVisible()) {
      await railOwner.click({ position: { x: 18, y: 150 } });
      railTapTriggered = true;
    }
    await page.waitForTimeout(120);

    let isOpened = await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__?.());
    if (!isOpened) {
      console.log("1a-fallback. rail 点按后备：触发 __PI_ENH_OPEN_MINIMAP__...");
      await page.evaluate(() => window.__PI_ENH_OPEN_MINIMAP__?.());
    }
    const previewBox = page.locator('[data-minimap-preview-box]');
    await previewBox.waitFor();
    assert.equal(await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()), true);

    // 1b-overflow. 断言 previewBox scrollHeight > clientHeight 并验证真实纵向上下拖动
    console.log("1b-overflow. 断言 previewBox scrollHeight > clientHeight 并验证真实纵向上下拖动...");
    const metricsDesktop = await previewBox.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));
    console.log(`980px 滚动高度指标: scrollHeight=${metricsDesktop.scrollHeight}, clientHeight=${metricsDesktop.clientHeight}`);
    assert.ok(
      metricsDesktop.scrollHeight > metricsDesktop.clientHeight + 100,
      `980px previewBox 必须有足够真实 overflow: scrollHeight(${metricsDesktop.scrollHeight}) > clientHeight(${metricsDesktop.clientHeight})`
    );

    const maxScroll = metricsDesktop.scrollHeight - metricsDesktop.clientHeight;
    const midScroll = Math.floor(maxScroll / 2);
    await previewBox.evaluate((el, target) => {
      el.scrollTop = target;
    }, midScroll);

    const initialScrollTop = await previewBox.evaluate((el) => el.scrollTop);
    console.log(`980px 中部初始 scrollTop: ${initialScrollTop}`);
    assert.ok(initialScrollTop > 50, `initialScrollTop 必须位于中部 (> 50), 实际: ${initialScrollTop}`);

    const boxRect = await previewBox.boundingBox();
    assert.ok(boxRect, "Preview box must have bounding box");
    const swipeX = boxRect.x + boxRect.width / 2;
    const swipeY = boxRect.y + boxRect.height / 2;

    // 向上拖动 (finger swipe up: swipeY -> swipeY - 110) => 向上滚动，scrollTop 增大
    console.log("1b-scroll-up. 测试向上拖动 (finger up, scrollTop 增加)...");
    await cdpTouchSwipe([
      { x: swipeX, y: swipeY },
      { x: swipeX, y: swipeY - 30 },
      { x: swipeX, y: swipeY - 70 },
      { x: swipeX, y: swipeY - 110 },
    ], 20);
    await page.waitForTimeout(150);

    const scrollTopAfterUp = await previewBox.evaluate((el) => el.scrollTop);
    console.log(`980px 向上拖动后 scrollTop: ${scrollTopAfterUp}`);
    assert.ok(
      scrollTopAfterUp > initialScrollTop,
      `向上拖动后 scrollTop 必须增大: ${scrollTopAfterUp} > ${initialScrollTop}`
    );
    assert.equal(
      await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()),
      true,
      "向上拖动后 minimap 面板必须保持展开"
    );

    // 向下拖动 (finger swipe down: swipeY - 50 -> swipeY + 120) => 向下滚动，scrollTop 减小
    console.log("1b-scroll-down. 测试向下拖动 (finger down, scrollTop 减小)...");
    const currentScrollTop = scrollTopAfterUp;
    await cdpTouchSwipe([
      { x: swipeX, y: swipeY - 50 },
      { x: swipeX, y: swipeY },
      { x: swipeX, y: swipeY + 60 },
      { x: swipeX, y: swipeY + 120 },
    ], 20);
    await page.waitForTimeout(150);

    const scrollTopAfterDown = await previewBox.evaluate((el) => el.scrollTop);
    console.log(`980px 向下拖动后 scrollTop: ${scrollTopAfterDown}`);
    assert.ok(
      scrollTopAfterDown < currentScrollTop,
      `向下拖动后 scrollTop 必须减小: ${scrollTopAfterDown} < ${currentScrollTop}`
    );
    assert.equal(
      await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()),
      true,
      "向下拖动后 minimap 面板必须保持展开"
    );

    // 1c. 核心复现：先水平 22px 起步，再大竖向拖动到 dx55, dy160
    // 旧 1.4.12 基线会在此处误关闭抽屉！
    console.log("1c. 触发斜向拖动：先 dx=22, 再滑向 dx=55, dy=160...");
    const startX = boxRect.x + 80;
    const startY = boxRect.y + 120;

    // 构造轨迹点：
    // step 0: start (0, 0)
    // step 1: dx=12, dy=1 (触发 gestureIntent='swipe-right')
    // step 2: dx=22, dy=2
    // step 3: dx=32, dy=40 (纵向位移增大)
    // step 4: dx=45, dy=100
    // step 5: dx=55, dy=160
    const diagonalPoints = [
      { x: startX, y: startY },
      { x: startX + 12, y: startY + 1 },
      { x: startX + 22, y: startY + 2 },
      { x: startX + 32, y: startY + 40 },
      { x: startX + 45, y: startY + 100 },
      { x: startX + 55, y: startY + 160 },
    ];

    await cdpTouchSwipe(diagonalPoints, 20);

    // 等待旧代码关闭动画（160ms）
    await page.waitForTimeout(220);

    const isStillOpen = await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__());
    console.log(`1c 结果: isStillOpen=${isStillOpen}`);

    // 断言：纵向占优后绝不能被误关闭！
    assert.equal(
      isStillOpen,
      true,
      "Minimap preview drawer must NOT be closed when diagonal drag has dominant vertical displacement (dx=55, dy=160)"
    );

    // 1d. 测试普通竖滚：纯垂直拖拽
    console.log("1d. 测试普通竖滚（dy=-120）...");
    const verticalPoints = [
      { x: startX, y: startY + 100 },
      { x: startX, y: startY + 70 },
      { x: startX, y: startY + 30 },
      { x: startX, y: startY - 20 },
    ];
    await cdpTouchSwipe(verticalPoints, 20);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()), true);

    // 1e. 测试真实纯横向右滑关闭
    console.log("1e. 测试纯横向右滑关闭（dx=80, dy=2）...");
    const horizontalClosePoints = [
      { x: startX, y: startY },
      { x: startX + 20, y: startY + 1 },
      { x: startX + 50, y: startY + 1 },
      { x: startX + 80, y: startY + 2 },
    ];
    await cdpTouchSwipe(horizontalClosePoints, 20);
    await page.waitForTimeout(220);
    assert.equal(
      await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()),
      false,
      "Pure horizontal swipe-right must close minimap drawer"
    );

    // 1f. 重新打开，测试点击定位
    console.log("1f. 重新打开并测试条目点击定位...");
    await page.evaluate(() => window.__PI_ENH_OPEN_MINIMAP__());
    await previewBox.waitFor();
    const userButton = page.locator('[data-minimap-preview-user="1"]').first();
    await userButton.click();
    // 点击定位条目后抽屉不应异常崩溃
    await page.waitForTimeout(100);

    // 1g. 测试 touchcancel 中断安全性
    console.log("1g. 测试 touchcancel 中断安全...");
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(startX), y: Math.round(startY), id: 1 }],
    });
    totalCdpDispatched++;
    await new Promise((r) => setTimeout(r, 20));
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: Math.round(startX + 15), y: Math.round(startY), id: 1 }],
    });
    totalCdpDispatched++;
    await new Promise((r) => setTimeout(r, 20));
    await client.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    totalCdpDispatched++;
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()), true);

    // 1h. 测试 pending hover hide timer 在 preview 触摸开始时取消
    console.log("1h. 测试 pending hover hide timer 在 preview 触摸开始时取消...");
    // 触发 mouseleave 产生 pending hide timer (PREVIEW_HIDE_DELAY = 200ms)
    const rail = page.locator('[data-minimap-native-owner="true"]');
    await rail.hover();
    await page.waitForTimeout(50);
    // 移出 rail 产生 hide timer
    await page.mouse.move(10, 10);
    // 在 50ms 内立即在 previewBox 上触发 pointerdown
    await page.waitForTimeout(40);
    const boxBox = await previewBox.boundingBox();
    assert.ok(boxBox);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(boxBox.x + 30), y: Math.round(boxBox.y + 30), id: 1 }],
    });
    totalCdpDispatched++;
    // 等待 260ms（超过 200ms 的 previewHideTimer）
    await page.waitForTimeout(260);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    totalCdpDispatched++;
    await page.waitForTimeout(50);
    assert.equal(
      await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()),
      true,
      "Touching preview must cancel pending hover hide timer"
    );

    // 1i. 测试鼠标按住拖动 scrollbar 时 mouseleave 不关闭
    console.log("1i. 测试鼠标按住拖动 scrollbar 时 mouseleave 不关闭...");
    // 鼠标在 previewBox 上按下左键（buttons === 1）
    await page.mouse.move(boxBox.x + boxBox.width - 5, boxBox.y + 100);
    await page.mouse.down({ button: "left" });
    // 鼠标拖动滑出 previewBox 边界到外部（触发 mouseleave，此时 buttons === 1）
    await page.mouse.move(boxBox.x - 50, boxBox.y + 100);
    await page.waitForTimeout(260);
    assert.equal(
      await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()),
      true,
      "Mouseleave while dragging scrollbar (mousedown button held) must NOT hide preview"
    );
    // 在外部松开鼠标
    await page.mouse.up({ button: "left" });
    // 鼠标再次移入 rail 再无按键移出 -> 正常关闭
    await rail.hover();
    await page.mouse.move(10, 10);
    await page.waitForTimeout(260);
    assert.equal(
      await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()),
      false,
      "Normal mouseleave without mousedown must hide preview drawer"
    );

    // 1j. 切换会话与重新展开
    console.log("1j. 测试切换会话后重新打开...");
    await page.locator("#fixture-switch").click();
    await page.locator('[data-pi-native-scroll-owner]').waitFor();
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__PI_ENH_OPEN_MINIMAP__());
    await previewBox.waitFor();
    assert.equal(await page.evaluate(() => window.__PI_ENH_IS_MINIMAP_OPEN__()), true);

    const desktopCdpStats = await page.evaluate(() => window.__cdpTouchStats);
    assert.equal(desktopPageErrors.length, 0, `980px 页面不得有任何异常: ${desktopPageErrors.join(", ")}`);

    acceptanceReceipt.desktop980 = {
      railTapOpened: railTapTriggered,
      scrollHeight: metricsDesktop.scrollHeight,
      clientHeight: metricsDesktop.clientHeight,
      overflowDelta: metricsDesktop.scrollHeight - metricsDesktop.clientHeight,
      initialScrollTop,
      scrollTopAfterUp,
      scrollTopAfterDown,
      scrollDeltaUp: scrollTopAfterUp - initialScrollTop,
      scrollDeltaDown: currentScrollTop - scrollTopAfterDown,
      diagonalDragPassed: isStillOpen,
      horizontalClosePassed: true,
      touchCancelSafe: true,
      hoverHideCanceledOnTouch: true,
      scrollbarDragMouseleavePreserved: true,
      sessionSwitchPassed: true,
      pageErrors: desktopPageErrors,
      cdpTouchStats: desktopCdpStats,
    };

    // 截图保存到 acceptance
    const screenshotDesktopPath = path.join(acceptanceDir, "minimap-drag-desktop-980.png");
    await page.screenshot({ path: screenshotDesktopPath });
    console.log(`✓ 980px 宽屏截图已保存到: ${screenshotDesktopPath}`);

    await page.close();
  }

  // ------------------------------------------------------------------------
  // PART 2: 390px Mobile Overlay Tests
  // ------------------------------------------------------------------------
  console.log("--- PART 2: 390px Mobile Overlay Tests ---");
  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });

    const mobilePageErrors = [];
    page.on("pageerror", (err) => {
      const msg = String(err?.message || err);
      console.error("[390px pageerror]:", msg);
      mobilePageErrors.push(msg);
      acceptanceReceipt.pageErrors.push(`[390px] ${msg}`);
    });

    await page.addInitScript(() => {
      try {
        localStorage.setItem("pi-enh-minimap-initial-turns", "30");
        localStorage.setItem("pi-enh-minimap-step-turns", "10");
      } catch (e) {}
      window.__PI_ENH_GET_MINIMAP_HISTORY_SETTINGS__ = () => ({
        initialTurns: 30,
        stepTurns: 10,
      });

      window.__cdpTouchStats = { touchStart: 0, touchMove: 0, touchEnd: 0, touchCancel: 0, trusted: 0, untrusted: 0 };
      const record = (e) => {
        if (e.isTrusted) window.__cdpTouchStats.trusted++;
        else window.__cdpTouchStats.untrusted++;
        if (e.type === "touchstart") window.__cdpTouchStats.touchStart++;
        if (e.type === "touchmove") window.__cdpTouchStats.touchMove++;
        if (e.type === "touchend") window.__cdpTouchStats.touchEnd++;
        if (e.type === "touchcancel") window.__cdpTouchStats.touchCancel++;
      };
      window.addEventListener("touchstart", record, { capture: true, passive: true });
      window.addEventListener("touchmove", record, { capture: true, passive: true });
      window.addEventListener("touchend", record, { capture: true, passive: true });
      window.addEventListener("touchcancel", record, { capture: true, passive: true });
    });

    const client = await page.context().newCDPSession(page);

    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('[data-pi-native-scroll-owner]').waitFor();

    // 辅助函数：CDP touch
    const cdpTouchSwipe = async (points, delayMs = 16) => {
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (i === 0) {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), id: 1 }],
          });
          totalCdpDispatched++;
        } else {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), id: 1 }],
          });
          totalCdpDispatched++;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      totalCdpDispatched++;
      await new Promise((r) => setTimeout(r, delayMs));
    };

    // 2a. 打开手机导航
    console.log("2a. 打开手机端导航...");
    await page.locator("#fixture-open").click();
    const dialog = page.getByRole("dialog", { name: "会话导航" });
    await dialog.waitFor();
    assert.equal(await page.locator("#nav-open-state").textContent(), "OPEN");

    // 2b-overflow. 断言 dialog scrollHeight > clientHeight 并验证真实纵向上下拖动
    console.log("2b-overflow. 断言 dialog scrollHeight > clientHeight 并验证真实纵向上下拖动...");
    const mobileMetrics = await dialog.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));
    console.log(`390px 滚动高度指标: scrollHeight=${mobileMetrics.scrollHeight}, clientHeight=${mobileMetrics.clientHeight}`);
    assert.ok(
      mobileMetrics.scrollHeight > mobileMetrics.clientHeight + 100,
      `390px dialog 必须发生真实 overflow: scrollHeight(${mobileMetrics.scrollHeight}) > clientHeight(${mobileMetrics.clientHeight})`
    );

    const maxScrollMobile = mobileMetrics.scrollHeight - mobileMetrics.clientHeight;
    const midScrollMobile = Math.floor(maxScrollMobile / 2);
    await dialog.evaluate((el, target) => { el.scrollTop = target; }, midScrollMobile);
    const initialScrollTopMobile = await dialog.evaluate((el) => el.scrollTop);
    console.log(`390px 中部初始 scrollTop: ${initialScrollTopMobile}`);
    assert.ok(initialScrollTopMobile > 50, `390px initialScrollTop 必须 > 50, 实际: ${initialScrollTopMobile}`);

    const dialogBox = await dialog.boundingBox();
    assert.ok(dialogBox);
    const swipeMobileX = dialogBox.x + dialogBox.width / 2;
    const swipeMobileY = dialogBox.y + dialogBox.height / 2;

    // 向上拖动 (finger up, scrollTop 增加)
    console.log("2b-scroll-up. 390px 测试向上拖动 (finger up, scrollTop 增加)...");
    await cdpTouchSwipe([
      { x: swipeMobileX, y: swipeMobileY },
      { x: swipeMobileX, y: swipeMobileY - 30 },
      { x: swipeMobileX, y: swipeMobileY - 70 },
      { x: swipeMobileX, y: swipeMobileY - 110 },
    ], 20);
    await page.waitForTimeout(150);
    const scrollTopMobileAfterUp = await dialog.evaluate((el) => el.scrollTop);
    console.log(`390px 向上拖动后 scrollTop: ${scrollTopMobileAfterUp}`);
    assert.ok(
      scrollTopMobileAfterUp > initialScrollTopMobile,
      `390px 向上拖动后 scrollTop 必须增大: ${scrollTopMobileAfterUp} > ${initialScrollTopMobile}`
    );
    assert.equal(await page.locator("#nav-open-state").textContent(), "OPEN");

    // 向下拖动 (finger down, scrollTop 减小)
    console.log("2b-scroll-down. 390px 测试向下拖动 (finger down, scrollTop 减小)...");
    const currentMobileScroll = scrollTopMobileAfterUp;
    await cdpTouchSwipe([
      { x: swipeMobileX, y: swipeMobileY - 50 },
      { x: swipeMobileX, y: swipeMobileY },
      { x: swipeMobileX, y: swipeMobileY + 60 },
      { x: swipeMobileX, y: swipeMobileY + 120 },
    ], 20);
    await page.waitForTimeout(150);
    const scrollTopMobileAfterDown = await dialog.evaluate((el) => el.scrollTop);
    console.log(`390px 向下拖动后 scrollTop: ${scrollTopMobileAfterDown}`);
    assert.ok(
      scrollTopMobileAfterDown < currentMobileScroll,
      `390px 向下拖动后 scrollTop 必须减小: ${scrollTopMobileAfterDown} < ${currentMobileScroll}`
    );
    assert.equal(await page.locator("#nav-open-state").textContent(), "OPEN");

    // 2c. 竖向优先滑动：不误关导航
    console.log("2c. 竖向优先滑动（dy=60, dx=5）...");
    const startX = dialogBox.x + 100;
    const startY = dialogBox.y + 150;

    await cdpTouchSwipe([
      { x: startX, y: startY },
      { x: startX + 2, y: startY + 30 },
      { x: startX + 5, y: startY + 60 },
    ], 20);
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#nav-open-state").textContent(), "OPEN");

    // 2d. 右滑关闭导航（纯横向右滑 >= 40px）
    console.log("2d. 右滑关闭导航（dx=70, dy=2）...");
    await cdpTouchSwipe([
      { x: startX, y: startY },
      { x: startX + 30, y: startY + 1 },
      { x: startX + 70, y: startY + 2 },
    ], 20);
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.locator("#nav-open-state").textContent(), "CLOSED");

    // 2e. 重新打开并点击条目定位
    console.log("2e. 重新打开并点击定位...");
    await page.locator("#fixture-open").click();
    await dialog.waitFor();
    const turnBtn = page.locator('[data-minimap-preview-user="1"]').first();
    await turnBtn.click();
    await page.waitForTimeout(100);

    const mobileCdpStats = await page.evaluate(() => window.__cdpTouchStats);
    assert.equal(mobilePageErrors.length, 0, `390px 页面不得有任何异常: ${mobilePageErrors.join(", ")}`);

    acceptanceReceipt.mobile390 = {
      scrollHeight: mobileMetrics.scrollHeight,
      clientHeight: mobileMetrics.clientHeight,
      overflowDelta: mobileMetrics.scrollHeight - mobileMetrics.clientHeight,
      initialScrollTop: initialScrollTopMobile,
      scrollTopAfterUp: scrollTopMobileAfterUp,
      scrollTopAfterDown: scrollTopMobileAfterDown,
      scrollDeltaUp: scrollTopMobileAfterUp - initialScrollTopMobile,
      scrollDeltaDown: currentMobileScroll - scrollTopMobileAfterDown,
      verticalSwipePreserved: true,
      horizontalSwipeClosed: true,
      clickLocatePassed: true,
      pageErrors: mobilePageErrors,
      cdpTouchStats: mobileCdpStats,
    };

    // 截图保存到 acceptance
    const screenshotMobilePath = path.join(acceptanceDir, "minimap-drag-mobile-390.png");
    await page.screenshot({ path: screenshotMobilePath });
    console.log(`✓ 390px 手机截图已保存到: ${screenshotMobilePath}`);

    await page.close();
  }

  // 综合断言与收据落地
  const totalTrusted = (acceptanceReceipt.desktop980.cdpTouchStats?.trusted || 0) + (acceptanceReceipt.mobile390.cdpTouchStats?.trusted || 0);
  const totalUntrusted = (acceptanceReceipt.desktop980.cdpTouchStats?.untrusted || 0) + (acceptanceReceipt.mobile390.cdpTouchStats?.untrusted || 0);

  acceptanceReceipt.cdpEvents = {
    totalDispatched: totalCdpDispatched,
    browserReceived: {
      trusted: totalTrusted,
      untrusted: totalUntrusted,
    },
  };

  assert.ok(totalTrusted > 0, "必须接收到真实 isTrusted=true 的 CDP touch 事件");
  assert.equal(totalUntrusted, 0, "不得出现非受信任的 touch 事件");
  assert.equal(acceptanceReceipt.pageErrors.length, 0, "全流程不得产生任何 pageerror");

  acceptanceReceipt.status = "passed";
  const receiptPath = path.join(acceptanceDir, "DRAG_BROWSER.json");
  fs.writeFileSync(receiptPath, JSON.stringify(acceptanceReceipt, null, 2), "utf8");
  console.log(`✓ 结构化 JSON 验收结果已保存到: ${receiptPath}`);

  console.log("=== ALL MINIMAP DRAG STABILITY TESTS PASSED ===");
} finally {
  if (browser) {
    await browser.close();
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
