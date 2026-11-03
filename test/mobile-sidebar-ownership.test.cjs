'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

async function runStaticContractChecks() {
  console.log('[Check 1] 运行静态代码契约断言...');

  const mod05Path = path.join(root, 'enhancements/modules/05-composer-and-input-workflow.js');
  const mod05Content = fs.readFileSync(mod05Path, 'utf8');

  // 1. 05 模块中严禁再触碰 sidebar.style / backdrop.style
  assert.ok(!mod05Content.includes('sidebar.style'), '05 模块严禁访问 sidebar.style');
  assert.ok(!mod05Content.includes('backdrop.style'), '05 模块严禁访问 backdrop.style');

  // 2. 05 模块中严禁打 data-drawer-active 与 pi-sidebar-drawer-active 标记
  assert.ok(!mod05Content.includes('data-drawer-active'), '05 模块严禁设置 data-drawer-active');
  assert.ok(!mod05Content.includes('pi-sidebar-drawer-active'), '05 模块严禁使用 pi-sidebar-drawer-active 类名');

  // 3. 旧函数必须保留供 04 与 PWA 消费者调用
  const requiredFunctions = [
    'function getSessionSidebarElement',
    'function isSessionSidebarOpen',
    'function closeSessionSidebar',
    'function openSessionSidebar',
    'function getSidebarToggleButton'
  ];
  for (const fn of requiredFunctions) {
    assert.ok(mod05Content.includes(fn), `05 模块必须保留旧函数定义: ${fn}`);
  }

  // 4. app/enhancements.css 必须剔除旧遮罩 patch
  const cssPath = path.join(root, 'app/enhancements.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  assert.ok(!cssContent.includes('data-drawer-active'), 'app/enhancements.css 严禁包含旧 data-drawer-active patch');
  assert.ok(!cssContent.includes('pi-sidebar-drawer-active'), 'app/enhancements.css 严禁包含旧 pi-sidebar-drawer-active patch');

  console.log('  -> 静态代码契约检查全部通过！');
}

async function runBrowserFixtureChecks() {
  console.log('[Check 2] 运行真实无头 Chromium 最小 fixture 预验收...');

  const mod05Path = path.join(root, 'enhancements/modules/05-composer-and-input-workflow.js');
  const mod05Content = fs.readFileSync(mod05Path, 'utf8');

  // 从 05 模块中提取移动手势代码段
  const startMarker = '// ==========================================\n  // Mobile Swipe';
  const endMarker = 'window.__PI_ENH_MOBILE_SWIPE__ = {';
  const startIndex = mod05Content.indexOf(startMarker);
  assert.ok(startIndex !== -1, '无法找到 05 移动手势段起始点');
  const endIndex = mod05Content.indexOf(endMarker, startIndex);
  assert.ok(endIndex !== -1, '无法找到 05 移动手势段结束点');

  const closingBraceIndex = mod05Content.indexOf('};', endIndex);
  const swipeModuleSnippet = mod05Content.substring(startIndex, closingBraceIndex + 2);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  // 收集控制台报错，断言零异常
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(new Error(msg.text()));
  });

  // 构造真实 DOM Fixture
  const htmlFixture = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Mobile Gesture Test Fixture</title>
  <style>
    body { margin: 0; padding: 0; font-family: sans-serif; overflow-x: hidden; }
    #session-sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; width: 280px;
      background: #1e1e24; color: #fff; z-index: 50;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
    }
    #session-sidebar.sidebar-open { transform: translateX(0); }
    .sidebar-overlay-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 40;
      opacity: 0; pointer-events: none; visibility: hidden;
      transition: opacity 0.2s ease;
    }
    .chat-view {
      padding: 20px; min-height: 100vh; background: #121214; color: #eee;
    }
    #file-panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: 320px;
      background: #252526; color: #fff; z-index: 60;
      transform: translateX(100%);
      transition: transform 0.2s ease;
    }
    #file-panel.right-panel-open { transform: translateX(0); }
    pre { background: #333; padding: 10px; overflow-x: auto; }
    textarea { width: 100%; height: 60px; }
  </style>
</head>
<body>
  <button id="sidebar-toggle-btn" aria-label="显示侧边栏" title="显示侧边栏">☰</button>
  <div id="session-sidebar" class="sidebar-container sessions-sidebar">
    <div style="padding: 16px;">侧边栏会话列表</div>
  </div>
  <div class="sidebar-overlay-backdrop"></div>
  <div class="chat-view">
    <h2>聊天窗口</h2>
    <p>模拟消息内容</p>
  </div>
  <div id="file-panel" class="right-panel-container">
    <div style="padding: 16px;">
      <h3>文件预览面板</h3>
      <pre><code>const a = 1; // 横向可滚动代码块</code></pre>
      <textarea placeholder="文件内输入框"></textarea>
      <div id="file-panel-drag-area" style="padding: 20px; background: #3a3d41; margin-top: 10px;">
        可滑动手势区
      </div>
    </div>
  </div>
  <script>
    // 模拟环境基础函数
    window.__PI_ENH_MANAGED_LISTENERS__ = [];
    window.addManagedListener = function(target, event, handler, options) {
      target.addEventListener(event, handler, options);
    };
    window.getPluginSetting = function(pluginId, key) {
      if (pluginId === 'mobile-swipe-drawer' && key === 'swipeDistance') return 30;
      return null;
    };
    window.isPluginEnabled = function(id) {
      return true;
    };
    let _filePanelOpen = false;
    window.isFilePanelOpen = function() {
      return _filePanelOpen;
    };
    window._setFilePanelOpen = function(val) {
      _filePanelOpen = val;
      const el = document.getElementById('file-panel');
      if (el) el.classList.toggle('right-panel-open', val);
    };
    let _filePanelCloseCalled = false;
    window.closeFilePanel = function() {
      _filePanelCloseCalled = true;
      window._setFilePanelOpen(false);
    };
    window._wasFilePanelCloseCalled = function() {
      return _filePanelCloseCalled;
    };
    window._resetFilePanelCloseFlag = function() {
      _filePanelCloseCalled = false;
    };

    // 占位全局变量
    var activeZoomDialog = null;

    // 注入 05 模块移动手势源码
    ${swipeModuleSnippet}
  </script>
</body>
</html>`;

  await page.setContent(htmlFixture);
  await page.waitForLoadState('domcontentloaded');

  // --- 测试用例 A: 屏幕中央右滑（试图滑出侧边栏），05 模块零所有权，绝不改变 sidebar.style / backdrop.style ---
  await page.evaluate(() => {
    window._resetFilePanelCloseFlag();
    window._setFilePanelOpen(false);

    // 触发 touchstart 于聊天区中央
    const touchStart = new Touch({
      identifier: 1,
      target: document.querySelector('.chat-view'),
      clientX: 50,
      clientY: 300,
    });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));

    // 触发 touchmove 向右滑 +120px
    const touchMove = new Touch({
      identifier: 1,
      target: document.querySelector('.chat-view'),
      clientX: 170,
      clientY: 300,
    });
    document.dispatchEvent(new TouchEvent('touchmove', { touches: [touchMove], changedTouches: [touchMove], bubbles: true }));

    // 触发 touchend
    document.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchMove], bubbles: true }));
  });

  const sidebarAndBackdropState = await page.evaluate(() => {
    const sidebar = document.getElementById('session-sidebar');
    const backdrop = document.querySelector('.sidebar-overlay-backdrop');
    return {
      sidebarTransform: sidebar.style.transform,
      backdropOpacity: backdrop.style.opacity,
      hasDataDrawerActive: backdrop.hasAttribute('data-drawer-active'),
      hasPiSidebarDrawerActive: document.documentElement.classList.contains('pi-sidebar-drawer-active'),
    };
  });

  assert.equal(sidebarAndBackdropState.sidebarTransform, '', '05 模块绝不能直接修改 sidebar.style.transform');
  assert.equal(sidebarAndBackdropState.backdropOpacity, '', '05 模块绝不能直接修改 backdrop.style.opacity');
  assert.equal(sidebarAndBackdropState.hasDataDrawerActive, false, '05 模块严禁设置 data-drawer-active');
  assert.equal(sidebarAndBackdropState.hasPiSidebarDrawerActive, false, '05 模块严禁添加 pi-sidebar-drawer-active 类名');
  console.log('  -> 用例 A 通过：屏幕滑动绝不触碰 sidebar 与 backdrop DOM 状态！');

  // --- 测试用例 B: 文件面板手势，仅从实际 file-panel 内部单指右滑关闭 ---
  await page.evaluate(() => {
    window._resetFilePanelCloseFlag();
    window._setFilePanelOpen(true);

    const dragArea = document.getElementById('file-panel-drag-area');
    const touchStart = new Touch({
      identifier: 2,
      target: dragArea,
      clientX: 100,
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));

    const touchMove = new Touch({
      identifier: 2,
      target: dragArea,
      clientX: 180, // deltaX = +80px (右滑)
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchmove', { touches: [touchMove], changedTouches: [touchMove], bubbles: true, cancelable: true }));

    const touchEnd = new Touch({
      identifier: 2,
      target: dragArea,
      clientX: 180,
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchEnd], bubbles: true }));
  });

  const filePanelCloseResult = await page.evaluate(() => window._wasFilePanelCloseCalled());
  assert.equal(filePanelCloseResult, true, '从文件面板内单指右滑超过阈值必须成功触发 closeFilePanel()');
  console.log('  -> 用例 B 通过：文件面板内右滑成功触发关闭！');

  // --- 测试用例 C: 文件面板手势纵向让位 ---
  await page.evaluate(() => {
    window._resetFilePanelCloseFlag();
    window._setFilePanelOpen(true);

    const dragArea = document.getElementById('file-panel-drag-area');
    const touchStart = new Touch({
      identifier: 3,
      target: dragArea,
      clientX: 100,
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));

    // 明显的纵向移动：deltaX = 10, deltaY = 60
    const touchMove = new Touch({
      identifier: 3,
      target: dragArea,
      clientX: 110,
      clientY: 260,
    });
    document.dispatchEvent(new TouchEvent('touchmove', { touches: [touchMove], changedTouches: [touchMove], bubbles: true, cancelable: true }));

    const touchEnd = new Touch({
      identifier: 3,
      target: dragArea,
      clientX: 110,
      clientY: 260,
    });
    document.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchEnd], bubbles: true }));
  });

  const verticalResult = await page.evaluate(() => window._wasFilePanelCloseCalled());
  assert.equal(verticalResult, false, '纵向滑动时必须让位原生滚动，不触发关闭');
  console.log('  -> 用例 C 通过：纵向滑动安全让位，不误触发关闭！');

  // --- 测试用例 D: 取消手势（touchcancel）不提交 ---
  await page.evaluate(() => {
    window._resetFilePanelCloseFlag();
    window._setFilePanelOpen(true);

    const dragArea = document.getElementById('file-panel-drag-area');
    const touchStart = new Touch({
      identifier: 4,
      target: dragArea,
      clientX: 100,
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));

    const touchMove = new Touch({
      identifier: 4,
      target: dragArea,
      clientX: 190, // deltaX = +90px
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchmove', { touches: [touchMove], changedTouches: [touchMove], bubbles: true, cancelable: true }));

    // 触发 touchcancel 取消
    document.dispatchEvent(new TouchEvent('touchcancel', { touches: [], changedTouches: [touchMove], bubbles: true }));
  });

  const cancelResult = await page.evaluate(() => window._wasFilePanelCloseCalled());
  assert.equal(cancelResult, false, '手势取消（touchcancel）必须不提交关闭');
  console.log('  -> 用例 D 通过：touchcancel 安全回弹且不提交关闭！');

  // --- 测试用例 E: 代码块与输入框内避让 ---
  await page.evaluate(() => {
    window._resetFilePanelCloseFlag();
    window._setFilePanelOpen(true);

    const codeEl = document.querySelector('#file-panel code');
    const touchStart = new Touch({
      identifier: 5,
      target: codeEl,
      clientX: 100,
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));

    const touchMove = new Touch({
      identifier: 5,
      target: codeEl,
      clientX: 180,
      clientY: 200,
    });
    document.dispatchEvent(new TouchEvent('touchmove', { touches: [touchMove], changedTouches: [touchMove], bubbles: true, cancelable: true }));

    document.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchMove], bubbles: true }));
  });

  const codeAvoidResult = await page.evaluate(() => window._wasFilePanelCloseCalled());
  assert.equal(codeAvoidResult, false, '代码块内触摸必须避让，不触发面板拖动与关闭');
  console.log('  -> 用例 E 通过：代码块与输入控件内触摸安全避让！');

  // 断言无控制台未捕获异常
  assert.equal(pageErrors.length, 0, `页面运行存在错误: ${pageErrors.map(e => e.message).join('; ')}`);

  await browser.close();
  console.log('  -> 真实 Chromium 浏览器最小 fixture 预验收全部通过！');
}

async function main() {
  console.log('=== 开始执行移动手势与侧边栏单一所有权预验收 ===');
  await runStaticContractChecks();
  await runBrowserFixtureChecks();
  console.log('=== 预验收成功完成！===');
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
