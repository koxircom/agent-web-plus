import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  ExtensionStatusBar,
  formatExtensionStatusLine,
  sanitizeExtensionStatusText,
  getSafeSessionTitle,
} = await jiti.import("./ExtensionStatusBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderStatusBar(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionStatusBar, props),
    ),
  );
}

test("sorts status text by hidden key like the Pi CLI footer", () => {
  const statuses = [
    { key: "20-memory", text: "memory" },
    { key: "90-notify", text: "notify" },
    { key: "10-permissions", text: "permissions" },
    { key: "05-ponytail", text: "ponytail" },
  ];

  assert.equal(
    formatExtensionStatusLine(statuses),
    "ponytail permissions memory notify",
  );
});

test("preserves status line breaks while normalizing horizontal whitespace", () => {
  assert.equal(
    sanitizeExtensionStatusText("  first\tsecond \r\n third  "),
    "first second\nthird",
  );
});

test("preserves explicit status lines without wrapping and scrolls long or tall output", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const statusLineRule = css.match(/\.extension-status-line\s*\{([^}]*)\}/)?.[1] ?? "";
  const statusTextRule = css.match(/\.extension-status-text\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(statusLineRule, /max-height:/);
  assert.match(statusLineRule, /align-items:\s*flex-start/);
  assert.match(statusLineRule, /overflow:\s*auto/);
  assert.match(statusTextRule, /white-space:\s*pre\s*;/);
  assert.doesNotMatch(statusTextRule, /overflow[^:]*:\s*hidden/);
  assert.doesNotMatch(statusTextRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(statusTextRule, /text-overflow:\s*ellipsis/);
});

test("renders a single status line without identifier keys", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
      { key: "05-ponytail", text: "ponytail" },
    ],
  });

  assert.match(html, /aria-label="ponytail memory"/);
  assert.match(html, /extension-status-shelf/);
  assert.match(html, /extension-status-line/);
  assert.match(html, /extension-status-text/);
  assert.match(html, />ponytail <span style=/);
  assert.match(html, />memory</);
  assert.doesNotMatch(html, /05-ponytail|20-memory/);
});

test("renders widgets and status text in one footer", () => {
  const html = renderStatusBar({
    statuses: [{ key: "status", text: "connected" }],
    widgets: [{
      key: "usage",
      lines: ["42%"],
      placement: "aboveEditor",
    }],
  });

  assert.match(html, /extension-status-shelf has-widgets has-status/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /usage/);
  assert.match(html, /connected/);
});

test("shared composer protocol does not reserve a JSON footer or hide other tools", () => {
 const composer = {key: "composer-modes", text: JSON.stringify({version:1,mode:"goal",goal:"目标正文"})};
 assert.equal(renderStatusBar({statuses:[composer]}), "");
 const html = renderStatusBar({statuses:[composer,{key:"lsp",text:"LSP 已就绪"}]});
 assert.match(html,/LSP 已就绪/); assert.doesNotMatch(html,/目标正文|composer-modes|&quot;version/);
});

test("getSafeSessionTitle filters out UUIDs and raw IDs while preserving clean titles", () => {
  assert.equal(getSafeSessionTitle(null), "会话");
  assert.equal(getSafeSessionTitle(undefined), "会话");
  assert.equal(getSafeSessionTitle({ id: "s-1", name: "" }), "会话");
  assert.equal(getSafeSessionTitle({ id: "s-1", name: "   " }), "会话");
  assert.equal(
    getSafeSessionTitle({
      id: "a52c3c90-9512-4217-ba5e-851f82be8fe5",
      name: "a52c3c90-9512-4217-ba5e-851f82be8fe5",
    }),
    "会话",
  );
  assert.equal(
    getSafeSessionTitle({
      id: "uuid-test",
      name: "12345678-1234-1234-1234-123456789abc",
    }),
    "会话",
  );
  assert.equal(
    getSafeSessionTitle({ id: "raw-session-id", name: "raw-session-id" }),
    "会话",
  );
  assert.equal(
    getSafeSessionTitle({
      id: "session-ok",
      name: "Odoo 18 报表与进销存优化",
    }),
    "Odoo 18 报表与进销存优化",
  );
});

test("renders collapsed title badge occupying LSP position when sidebarCollapsed is true", () => {
  const html = renderStatusBar({
    statuses: [{ key: "lsp", text: "LSP 已就绪" }],
    sidebarCollapsed: true,
    collapsedTitle: "Odoo 18 报表与进销存优化",
  });

  assert.match(html, /pi-enh-collapsed-session-title-badge/);
  assert.match(html, /has-collapsed-title/);
  assert.match(html, /Odoo 18 报表与进销存优化/);
  assert.match(html, /title="当前会话：Odoo 18 报表与进销存优化（点击展开会话列表）"/);
  assert.match(html, /aria-label="当前会话：Odoo 18 报表与进销存优化（点击展开会话列表）"/);
  // 折叠时占 LSP 位置，不显示原有 LSP 文本
  assert.doesNotMatch(html, /LSP 已就绪/);
});

test("restores native LSP status when sidebar is expanded", () => {
  const html = renderStatusBar({
    statuses: [{ key: "lsp", text: "LSP 已就绪" }],
    sidebarCollapsed: false,
    collapsedTitle: "Odoo 18 报表与进销存优化",
  });

  // 展开时原 LSP 不变，不渲染标题胶囊
  assert.doesNotMatch(html, /pi-enh-collapsed-session-title-badge/);
  assert.doesNotMatch(html, /has-collapsed-title/);
  assert.match(html, /LSP 已就绪/);
  assert.match(html, /extension-status-line/);
});

test("renders collapsed title badge in shelf even when statuses and widgets are empty", () => {
  const html = renderStatusBar({
    statuses: [],
    widgets: [],
    sidebarCollapsed: true,
    collapsedTitle: "新特性调研与重构",
  });

  assert.match(html, /extension-status-shelf/);
  assert.match(html, /has-collapsed-title/);
  assert.match(html, /pi-enh-collapsed-session-title-badge/);
  assert.match(html, /新特性调研与重构/);
});

test("respects enabled controlled prop to suppress collapsed title when disabled", () => {
  const html = renderStatusBar({
    statuses: [{ key: "lsp", text: "LSP 已就绪" }],
    sidebarCollapsed: true,
    collapsedTitle: "Odoo 18 报表与进销存优化",
    enabled: false,
  });

  // controlled enabled 为 false 时，即使折叠也不显示折叠标题，保持原 LSP
  assert.doesNotMatch(html, /pi-enh-collapsed-session-title-badge/);
  assert.match(html, /LSP 已就绪/);
});

test("renders fallback slot when shelf has no content and renderSlot is true (single owner)", () => {
  // 1. 当插件 disabled、折叠侧栏、无 status/widget 时，渲染 slot，绝不被抑制
  const htmlDisabled = renderStatusBar({
    statuses: [],
    widgets: [],
    sidebarCollapsed: true,
    collapsedTitle: "Odoo 18 报表与进销存优化",
    enabled: false,
    renderSlot: true,
  });
  assert.match(htmlDisabled, /chat-composer-status-slot/);
  assert.doesNotMatch(htmlDisabled, /extension-status-shelf/);

  // 2. 当侧栏展开、无 status/widget 时，渲染 slot
  const htmlExpanded = renderStatusBar({
    statuses: [],
    widgets: [],
    sidebarCollapsed: false,
    collapsedTitle: "Odoo 18 报表与进销存优化",
    enabled: true,
    renderSlot: true,
  });
  assert.match(htmlExpanded, /chat-composer-status-slot/);
  assert.doesNotMatch(htmlExpanded, /extension-status-shelf/);

  // 3. 当插件 enabled 且折叠时，渲染 shelf 中的标题徽章，不渲染 slot
  const htmlEnabledCollapsed = renderStatusBar({
    statuses: [],
    widgets: [],
    sidebarCollapsed: true,
    collapsedTitle: "Odoo 18 报表与进销存优化",
    enabled: true,
    renderSlot: true,
  });
  assert.match(htmlEnabledCollapsed, /extension-status-shelf/);
  assert.match(htmlEnabledCollapsed, /pi-enh-collapsed-session-title-badge/);
  assert.doesNotMatch(htmlEnabledCollapsed, /chat-composer-status-slot/);
});

test("supports session prop directly to compute title without AppShell UI helper dependency", () => {
  const html = renderStatusBar({
    statuses: [],
    widgets: [],
    sidebarCollapsed: true,
    session: { id: "s-123", name: "进销存调拨单打印修复" },
    renderSlot: true,
  });

  assert.match(html, /pi-enh-collapsed-session-title-badge/);
  assert.match(html, /进销存调拨单打印修复/);
  assert.doesNotMatch(html, /chat-composer-status-slot/);
});


