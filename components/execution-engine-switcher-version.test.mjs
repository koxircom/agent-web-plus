import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("ExecutionEngineSwitcher displays build-injected version badge in connected state", () => {
  const switcher = read("./ExecutionEngineSwitcher.tsx");

  // 构建注入版本与默认参数
  assert.match(switcher, /const APP_VERSION = process\.env\.NEXT_PUBLIC_APP_VERSION;/);
  assert.match(switcher, /version = APP_VERSION/);

  // 已连接状态 badge 中显示 · v{version}
  assert.match(switcher, /className="pi-enh-header-version"/);
  assert.match(switcher, /\{`· v\$\{version\}`\}/);
  assert.match(switcher, /data-version=\{version\}/);

  // 保留离线、连接与状态文案
  assert.match(switcher, /connected \? "已连接" : "连接恢复中…"/);
  assert.match(switcher, /pending \? "正在切换…" :/);
  assert.match(switcher, /error \? "切换失败" :/);

  // 状态指示器颜色定义保留
  assert.match(switcher, /background: connected \? "#22c55e" : "#eab308"/);
});

test("native header owns status and version layout without enhancement overrides", () => {
  const css = read("../app/globals.css");

  // 顶栏单行自适应布局：收敛为真实容器类，禁止 !important 堆砌
  assert.match(css, /\.pi-native-engine-status\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/);
  assert.match(css, /\.pi-native-engine-status\s*\{[^}]*white-space:\s*nowrap;/);
  assert.match(css, /\.pi-native-sidebar-header-toolbar > \[data-pi-native-engine-switcher\]\s*\{[^}]*min-width:\s*0;/);
  assert.match(css, /\.pi-native-sidebar-header-actions\s*\{[^}]*flex-wrap:\s*nowrap;/);
  assert.doesNotMatch(read("../app/enhancements.css"), /\.pi-native-sidebar-header-toolbar\s*\{/);

  // 原生常驻版本号样式
  assert.match(css, /\.pi-enh-header-version\s*\{[^}]*font-family:\s*ui-monospace/);

  // 严禁旧补丁 calc(100% - 94px) 盲猜尺寸，严禁该模块出现 !important
  assert.doesNotMatch(css, /max-width:\s*calc\(100%\s*-\s*94px\)/);
  assert.doesNotMatch(css, /\.pi-native-sidebar-header-toolbar\s*\{[^}]*!important/);
  assert.doesNotMatch(css, /\.pi-enh-header-version\s*\{[^}]*!important/);
});

test("04 module completely retires syncPersistentVersionBadges without zombie code or queries", () => {
  const module04 = read("../enhancements/modules/04-sidebar-and-session-management.js");

  // 彻底退休 syncPersistentVersionBadges，不留空函数或 DOM query
  assert.doesNotMatch(module04, /syncPersistentVersionBadges/);

  // 移除老旧的 1.4.41 硬编码 DOM 覆写
  assert.doesNotMatch(module04, /const CURRENT_APP_VERSION = "1\.4\.41";/);
});
