import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { formatSessionTitle, formatTimestamp } = await jiti.import("./CollaborationSettings.tsx");

const componentSource = await readFile(new URL("./CollaborationSettings.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const navSource = await readFile(new URL("../lib/settings-navigation.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

test("formatSessionTitle enforces real titles and strictly masks internal session IDs", () => {
  // 1. 合法真实标题保持原样
  assert.equal(formatSessionTitle("Odoo 18 进销存图片优化"), "Odoo 18 进销存图片优化");
  assert.equal(formatSessionTitle("群晖 SSD 写入排查"), "群晖 SSD 写入排查");
  assert.equal(formatSessionTitle("Fix composer focus"), "Fix composer focus");

  // 2. 内部 session ID / 编号 / UUID 严格脱敏回退为安全占位
  assert.equal(formatSessionTitle("S865"), "未命名会话（标题尚未生成）");
  assert.equal(formatSessionTitle("s102"), "未命名会话（标题尚未生成）");
  assert.equal(formatSessionTitle("12345678-1234-1234-1234-123456789abc"), "未命名会话（标题尚未生成）");
  assert.equal(formatSessionTitle("3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e"), "未命名会话（标题尚未生成）");

  // 3. 空值与非法值安全回退
  assert.equal(formatSessionTitle(""), "未命名会话（标题尚未生成）");
  assert.equal(formatSessionTitle("   "), "未命名会话（标题尚未生成）");
  assert.equal(formatSessionTitle(null), "未命名会话（标题尚未生成）");
  assert.equal(formatSessionTitle(undefined), "未命名会话（标题尚未生成）");
  assert.equal(formatSessionTitle(12345), "未命名会话（标题尚未生成）");
});

test("formatTimestamp handles ISO strings and fallbacks gracefully", () => {
  assert.equal(formatTimestamp(""), "-");
  assert.equal(formatTimestamp(null), "-");
  const formatted = formatTimestamp("2026-10-25T12:00:00.000Z");
  assert.ok(formatted.includes("2026"));
});

test("collaboration settings tab is native, requires no project and lazy-loads", () => {
  // 1. 在 settings-navigation.ts 中为原生受支持 section
  assert.match(navSource, /"collaboration"/);

  // 2. 在 SettingsPanel.tsx 中注册
  assert.match(panelSource, /\{ id: "collaboration", label: "协作接力", requiresProject: false \}/);
  assert.match(panelSource, /const loadCollaborationSettings = \(\) => import\("\.\/CollaborationSettings"\)/);
  assert.match(panelSource, /const CollaborationSettings = dynamic\(loadCollaborationSettings/);
  assert.match(panelSource, /\{sectionHost\("collaboration", <CollaborationSettings \/>\)\}/);

  // 3. 在 SETTINGS_NAV_GROUPS 中被归入 agent 组
  assert.match(panelSource, /"execution-engine", "collaboration", "learning"/);

  // 4. 原生图标定义
  assert.match(panelSource, /if \(section === "collaboration"\) return <svg/);
});

test("collaboration settings component strictly adheres to contract: read-only, no polling, abortable", () => {
  // 1. 单一 fetch，无 setInterval 或轮询
  assert.match(componentSource, /fetch\("\/api\/collaboration",/);
  assert.doesNotMatch(componentSource, /setInterval|setTimeout/);

  // 2. AbortController 严格处理卸载与请求竞争
  assert.match(componentSource, /new AbortController\(\)/);
  assert.match(componentSource, /abortControllerRef\.current\?\.abort\(\)/);
  assert.match(componentSource, /signal: controller\.signal/);

  // 3. 严格区分 loading / error / empty / content 四种状态
  assert.match(componentSource, /role="status" aria-busy="true"/);
  assert.match(componentSource, /role="alert"/);
  assert.match(componentSource, /settings-collaboration-empty/);
  assert.match(componentSource, /settings-collaboration-list/);

  // 4. 机制提示卡片包含必要说明（合作型互斥、Pi自动续做、Codex支持限制、跨容器边界、Token消耗提示）
  assert.match(componentSource, /合作型互斥/);
  assert.match(componentSource, /Pi 自动接力/);
  assert.match(componentSource, /消耗模型 Token/);
  assert.match(componentSource, /Codex 执行端暂不支持自动唤醒/);
  assert.match(componentSource, /通用锁仅限本实例/);
  assert.match(componentSource, /Odoo 插件锁按局域网配置共享/);
  assert.doesNotMatch(componentSource, /跨容器与不同实例的锁不自动共享/);

  // 5. 纯只读，无任何强制写按钮（无强制解锁、无改owner、无抢占）
  assert.doesNotMatch(componentSource, /强制解锁|抢占|强行释放|改写owner/);
  assert.match(componentSource, /刷新状态/);
});

test("collaboration settings panel styling adheres to native variables and responsive rules", () => {
  // 1. 局部命名与 CSS 变量复用
  assert.match(cssSource, /\.settings-collaboration-panel \{/);
  assert.match(cssSource, /\.settings-collaboration-card \{/);
  assert.match(cssSource, /var\(--bg-panel\)/);
  assert.match(cssSource, /var\(--border\)/);

  // 2. 严禁使用 !important 篡改 display 破坏状态机
  assert.doesNotMatch(cssSource, /\.settings-collaboration[^{]*\{[^}]*display:[^}]*!important/);

  // 3. 文本折行防溢出
  assert.match(cssSource, /overflow-wrap:\s*anywhere;/);
  assert.match(cssSource, /@media\s*\(max-width:\s*640px\)/);
});

test("navigating across sections maintains clean unmounted/hidden lifecycle without DOM leaks", () => {
  // 验证 SettingsPanel.tsx 中 sectionHost 实现：未访问不挂载，访问后以 hidden={section !== id} 保留状态，无额外后置脚本劫持
  assert.match(panelSource, /const sectionHost = \(id: SettingsSection, content: ReactNode\) =>/);
  assert.match(panelSource, /mountedSections\.has\(id\)/);
  assert.match(panelSource, /hidden=\{section !== id\}/);
  assert.doesNotMatch(componentSource, /document\.querySelector|document\.getElementById|replaceChildren/);
});
