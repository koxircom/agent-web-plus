const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

async function main() {
  console.log('--- 启动折叠标题与开关/slot单一所有权真实浏览器验收 ---');

  // 读取 CSS 确保真实样式呈现
  const globalsCss = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
  const composerCss = fs.readFileSync(path.join(root, 'app/composer.css'), 'utf8');

  // 构建真实客户端 Bundle
  const bundle = await esbuild.build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React, { useState, useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ExtensionStatusBar, getSafeSessionTitle } from './components/ExtensionStatusBar';
        import { I18nProvider } from './hooks/useI18n';
        import { isSettingsPluginEnabled } from './lib/settings-extensions';

        // 挂载辅助函数
        window.isSettingsPluginEnabled = isSettingsPluginEnabled;
        window.getSafeSessionTitle = getSafeSessionTitle;

        // 真实 toggle 窄逻辑（操作 storage 并派发局部明确事件）
        window.togglePluginSetting = function(enabled) {
          localStorage.setItem('pi-enh-plugin-collapsed-sidebar-session-title', enabled ? 'true' : 'false');
          try {
            const raw = localStorage.getItem('pi-enh-settings-v1') || '{}';
            const cfg = JSON.parse(raw);
            cfg.features = cfg.features || {};
            cfg.features['collapsed-sidebar-session-title'] = { enabled: Boolean(enabled) };
            localStorage.setItem('pi-enh-settings-v1', JSON.stringify(cfg));
          } catch (e) {}
          window.dispatchEvent(new CustomEvent('pi-collapsed-title-toggle', { detail: { enabled: Boolean(enabled) } }));
          if (window.__PI_WEB_SETTINGS_NATIVE__ && typeof window.__PI_WEB_SETTINGS_NATIVE__.notifyPreferencesChanged === 'function') {
            window.__PI_WEB_SETTINGS_NATIVE__.notifyPreferencesChanged();
          }
        };

        function TestApp() {
          const [collapsed, setCollapsed] = useState(true);
          const [expandedCallbackFired, setExpandedCallbackFired] = useState(false);
          const [hasLspStatus, setHasLspStatus] = useState(false);

          useEffect(() => {
            window.__setSidebarCollapsed = (val) => setCollapsed(val);
            window.__setHasLspStatus = (val) => setHasLspStatus(val);
            window.__hasExpandedCallbackFired = () => expandedCallbackFired;
            window.__resetCallback = () => setExpandedCallbackFired(false);
          }, [expandedCallbackFired]);

          const statuses = hasLspStatus ? [{ key: 'lsp', text: 'LSP: python 已就绪' }] : [];

          return (
            <div className="app-container" style={{ display: 'flex', width: '100%', height: '100%' }}>
              <div className="sidebar" style={{ width: 240, background: 'var(--bg-panel, #18181b)', borderRight: '1px solid var(--border, #27272a)', display: collapsed ? 'none' : 'block' }}>
                <div style={{ padding: 12, fontWeight: 'bold' }}>侧边栏会话列表</div>
              </div>
              <div className="main-content" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 1, padding: 16 }}>
                  <h3>会话内容区域</h3>
                  <p>测试侧边栏折叠与展开循环、插件开关切换对标题胶囊与 slot 显隐的影响。</p>
                </div>
                <div className="chat-composer-footer" style={{ borderTop: '1px solid var(--border, #27272a)', padding: '10px 16px', background: 'var(--bg-panel, #18181b)' }}>
                  <div className="mock-input" style={{ height: 42, background: 'var(--composer-input-bg, #27272a)', borderRadius: 6, marginBottom: 8 }} />
                  <ExtensionStatusBar
                    statuses={statuses}
                    widgets={[]}
                    session={{ id: 'sess-odoo-18', name: 'Odoo 18 报表与进销存优化' }}
                    sidebarCollapsed={collapsed}
                    onExpandSidebar={() => setExpandedCallbackFired(true)}
                    renderSlot={true}
                  />
                </div>
              </div>
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
    alias: { '@': root },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_APP_VERSION': '"1.4.41"',
    },
  });

  const bundleJs = bundle.outputFiles[0].text;

  // 启动内置 HTTP 服务
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('content-type', 'application/javascript');
      return res.end(bundleJs);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          :root {
            --bg-app: #09090b;
            --bg-panel: #18181b;
            --border: #27272a;
            --text: #f4f4f5;
            --text-muted: #a1a1aa;
            --accent: #3b82f6;
            --composer-input-bg: #27272a;
          }
          body {
            margin: 0;
            padding: 0;
            background: var(--bg-app);
            color: var(--text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            height: 100vh;
            overflow: hidden;
          }
          ${globalsCss}
          ${composerCss}
        </style>
      </head>
      <body>
        <div id="root" style="width: 100%; height: 100%;"></div>
        <script src="/bundle.js"></script>
      </body>
      </html>
    `);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const workDir = '/workspace/work';
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  try {
    // =========================================================================
    // 测试 1：Desktop 1124x800 - 真实开关 off/on + 折叠展开循环
    // =========================================================================
    console.log('[Test 1] 桌面视口 1124x800：开关 off/on + 折叠展开循环');
    const desktopPage = await browser.newPage({
      viewport: { width: 1124, height: 800 },
    });
    await desktopPage.goto(url);

    // 初始状态：折叠 sidebarCollapsed: true，插件默认开启
    await desktopPage.waitForSelector('.pi-enh-collapsed-session-title-badge', { timeout: 4000 });
    const badgeText = await desktopPage.$eval('.pi-enh-collapsed-session-title-badge-text', el => el.textContent.trim());
    assert.equal(badgeText, 'Odoo 18 报表与进销存优化', '标题徽章文本应正确展示当前会话标题');

    // 检查 shelf 占位，slot 不存在
    let slotEl = await desktopPage.$('.chat-composer-status-slot');
    assert.equal(slotEl, null, '标题徽章存在时，slot 不应渲染（shelf 作为唯一 owner）');

    // 验证 canonical metadata 读取
    const canonicalEnabledInitial = await desktopPage.evaluate(() => {
      return window.isSettingsPluginEnabled('collapsed-sidebar-session-title');
    });
    assert.equal(canonicalEnabledInitial, true, '初始 canonical schema 读取应为 true');

    // 点击交互测试
    await desktopPage.click('.pi-enh-collapsed-session-title-badge');
    const callbackFired = await desktopPage.evaluate(() => window.__hasExpandedCallbackFired());
    assert.equal(callbackFired, true, '点击标题徽章应触发展开回调 onExpandSidebar');

    // 截图桌面折叠状态落盘
    const desktopImgPath = path.join(workDir, 'collapsed-title-1124.png');
    await desktopPage.screenshot({ path: desktopImgPath, fullPage: true });
    fs.chmodSync(desktopImgPath, 0o644);
    console.log(`Saved screenshot: ${desktopImgPath}`);

    // -------------------------------------------------------------------------
    // 循环步骤 1：关闭插件开关（OFF）
    // -------------------------------------------------------------------------
    console.log('-> 步骤 1: 真实关闭开关 (togglePluginSetting(false))...');
    await desktopPage.evaluate(() => window.togglePluginSetting(false));

    // 断言 canonical metadata 读取更新为 false
    const canonicalDisabled = await desktopPage.evaluate(() => {
      return window.isSettingsPluginEnabled('collapsed-sidebar-session-title');
    });
    assert.equal(canonicalDisabled, false, '关闭后 canonical schema 读取应为 false');

    // 断言标题徽章立即消失
    await desktopPage.waitForSelector('.pi-enh-collapsed-session-title-badge', { state: 'detached', timeout: 2000 });

    // 断言 .chat-composer-status-slot 立即由 ExtensionStatusBar 渲染并可见（绝不被抑制！）
    slotEl = await desktopPage.waitForSelector('.chat-composer-status-slot', { timeout: 2000 });
    assert.ok(slotEl, '插件关闭后，slot 应正常呈现，绝不被抑制！');

    // -------------------------------------------------------------------------
    // 循环步骤 2：重新开启插件开关（ON）
    // -------------------------------------------------------------------------
    console.log('-> 步骤 2: 重新开启开关 (togglePluginSetting(true))...');
    await desktopPage.evaluate(() => window.togglePluginSetting(true));

    const canonicalReEnabled = await desktopPage.evaluate(() => {
      return window.isSettingsPluginEnabled('collapsed-sidebar-session-title');
    });
    assert.equal(canonicalReEnabled, true, '重新开启后 canonical schema 读取应恢复为 true');

    // 断言标题徽章恢复，slot 退出
    await desktopPage.waitForSelector('.pi-enh-collapsed-session-title-badge', { timeout: 2000 });
    slotEl = await desktopPage.$('.chat-composer-status-slot');
    assert.equal(slotEl, null, '重新开启后 slot 退出');

    // -------------------------------------------------------------------------
    // 循环步骤 3：侧边栏展开（sidebarCollapsed: false）
    // -------------------------------------------------------------------------
    console.log('-> 步骤 3: 侧边栏展开 (sidebarCollapsed: false)...');
    await desktopPage.evaluate(() => {
      window.__setSidebarCollapsed(false);
      window.__setHasLspStatus(true);
    });

    // 展开状态下不显示折叠标题徽章，原有 LSP 文本恢复
    await desktopPage.waitForSelector('.pi-enh-collapsed-session-title-badge', { state: 'detached', timeout: 2000 });
    const lspEl = await desktopPage.waitForSelector('.extension-status-text', { timeout: 2000 });
    const lspText = await lspEl.textContent();
    assert.match(lspText, /LSP: python 已就绪/, '侧栏展开时原有 LSP 状态应正常呈现');

    // -------------------------------------------------------------------------
    // 循环步骤 4：再次折叠侧边栏（sidebarCollapsed: true）
    // -------------------------------------------------------------------------
    console.log('-> 步骤 4: 再次折叠侧边栏 (sidebarCollapsed: true)...');
    await desktopPage.evaluate(() => {
      window.__setSidebarCollapsed(true);
      window.__setHasLspStatus(false);
    });
    await desktopPage.waitForSelector('.pi-enh-collapsed-session-title-badge', { timeout: 2000 });

    await desktopPage.close();

    // =========================================================================
    // 测试 2：Mobile 390x844 - 视口排版与单行截断
    // =========================================================================
    console.log('[Test 2] 移动端视口 390x844：排版自适应与截断');
    const mobilePage = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    await mobilePage.goto(url);

    const mobileBadge = await mobilePage.waitForSelector('.pi-enh-collapsed-session-title-badge', { timeout: 4000 });
    const mobileBox = await mobileBadge.boundingBox();
    console.log('Mobile Badge Box:', mobileBox);
    assert.ok(mobileBox.width > 50 && mobileBox.width <= 360, '移动端宽度在合理约束内');
    assert.ok(mobileBox.height >= 18 && mobileBox.height <= 32, '移动端高度紧凑');

    const styleInfo = await mobilePage.$eval('.pi-enh-collapsed-session-title-badge-text', el => {
      const s = window.getComputedStyle(el);
      return {
        textOverflow: s.textOverflow,
        whiteSpace: s.whiteSpace,
        overflow: s.overflow,
      };
    });
    assert.equal(styleInfo.textOverflow, 'ellipsis');
    assert.equal(styleInfo.whiteSpace, 'nowrap');

    const mobileImgPath = path.join(workDir, 'collapsed-title-390.png');
    await mobilePage.screenshot({ path: mobileImgPath, fullPage: true });
    fs.chmodSync(mobileImgPath, 0o644);
    console.log(`Saved screenshot: ${mobileImgPath}`);

    await mobilePage.close();

    console.log('--- 浏览器端真实开关、折叠循环与单一所有权验收全绿！---');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
