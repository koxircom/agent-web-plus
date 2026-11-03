import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("/workspace/pi-web/node_modules/playwright");
const { compileSettingsCss } = require("./native-settings-css.cjs");

test("models settings responsive layout: middle-width 2-column & small-screen generous 4-item scroll", async (t) => {
  const css = await compileSettingsCss();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    ${css}
  </style>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--text);
    }
    .test-container {
      margin: 20px auto;
    }
  </style>
</head>
<body>
  <div id="mount"></div>
</body>
</html>`;

  await page.setContent(html);

  // Helper to mount a panel into a container with a given inline width and block height
  async function mountPanel(type, containerWidth, containerHeight) {
    await page.evaluate(({ type, containerWidth, containerHeight }) => {
      const mount = document.getElementById("mount");
      mount.innerHTML = `
        <div class="test-container" style="width: ${containerWidth}px; height: ${containerHeight}px;">
          <div class="config-panel-surface" style="width: 100%; height: 100%;">
            <div class="config-panel-header">
              <strong class="config-panel-title">Settings</strong>
            </div>

            ${type === "models" ? `
            <div class="models-config-layout">
              <div class="config-split-view">
                <aside class="config-sidebar">
                  <div class="config-sidebar-list">
                    <button class="config-sidebar-item" id="model-item-0">
                      <span class="config-sidebar-text">Anthropic / Claude 3.7</span>
                    </button>
                    <button class="config-sidebar-item models-sidebar-indented-item" id="model-item-1">
                      <span class="config-sidebar-text">claude-3-7-sonnet</span>
                    </button>
                    <button class="config-sidebar-item models-sidebar-indented-item" id="model-item-2">
                      <span class="config-sidebar-text">claude-3-5-sonnet</span>
                    </button>
                    <button class="config-sidebar-item models-sidebar-indented-item" id="model-item-3">
                      <span class="config-sidebar-text">claude-3-5-haiku</span>
                    </button>
                    <button class="config-sidebar-item models-sidebar-indented-item" id="model-item-4">
                      <span class="config-sidebar-text">claude-3-opus</span>
                    </button>
                    <button class="config-sidebar-item models-sidebar-indented-item" id="model-item-5">
                      <span class="config-sidebar-text">claude-instant-1.2</span>
                    </button>
                  </div>
                  <div class="config-list-action">
                    <button type="button" class="config-list-action-button" id="add-provider-btn">Add Provider</button>
                  </div>
                </aside>
                <div class="config-detail">
                  <div class="config-detail-stack is-fill">
                    <div class="config-detail-header">
                      <div class="config-detail-header-info">
                        <div class="config-detail-title">claude-3-7-sonnet</div>
                      </div>
                    </div>
                    <div class="config-field">
                      <span class="config-field-label">Model ID</span>
                      <input class="config-field-input" value="claude-3-7-sonnet" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            ` : `
            <div class="config-split-view">
              <aside class="config-sidebar">
                <div class="config-sidebar-list">
                  <button class="config-sidebar-item"><span class="config-sidebar-text">Generic Tab Item 1</span></button>
                  <button class="config-sidebar-item"><span class="config-sidebar-text">Generic Tab Item 2</span></button>
                </div>
              </aside>
              <div class="config-detail">
                <div class="config-detail-stack is-fill">
                  <div>Generic Tab Detail</div>
                </div>
              </div>
            </div>
            `}

            <footer class="config-footer">
              <div class="config-footer-status">Ready</div>
              <div class="config-footer-actions">
                <button type="button" class="config-button-default">Cancel</button>
                <button type="button" class="config-button-primary" id="save-btn">Save</button>
              </div>
            </footer>
          </div>
        </div>
      `;
    }, { type, containerWidth, containerHeight });
  }

  // 1. Check middle width (650px, e.g. Foldable phone main area <= 720px)
  await t.test("middle-width (650px) keeps models panel two columns side-by-side without crushing", async () => {
    await mountPanel("models", 650, 600);

    const splitViewDirection = await page.$eval(
      ".models-config-layout > .config-split-view",
      (el) => getComputedStyle(el).flexDirection
    );
    assert.equal(splitViewDirection, "row", "Models panel should stay 2-column (flex-direction: row) at 650px");

    const sidebarBox = await page.$eval(".models-config-layout .config-sidebar", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const detailBox = await page.$eval(".models-config-layout .config-detail", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    assert.ok(sidebarBox.width >= 180 && sidebarBox.width <= 230, `Sidebar width should be reasonable: ${sidebarBox.width}px`);
    assert.ok(detailBox.x >= sidebarBox.x + sidebarBox.width, "Detail pane sits to the right of sidebar");
    assert.ok(sidebarBox.height > 400, `Sidebar height should be full height (>400px), not crushed to 160px: got ${sidebarBox.height}px`);
    assert.equal(Math.round(sidebarBox.y), Math.round(detailBox.y), "Sidebar and detail should be aligned horizontally at the top");
  });

  // 2. Check generic tab at 650px (must NOT be affected - stays column)
  await t.test("middle-width (650px) leaves other generic tabs unchanged (still column per default)", async () => {
    await mountPanel("generic", 650, 600);

    const genericDirection = await page.$eval(
      ".config-panel-surface > .config-split-view",
      (el) => getComputedStyle(el).flexDirection
    );
    assert.equal(genericDirection, "column", "Generic tab should still be column under max-width: 720px rule");

    const genericSidebarHeight = await page.$eval(
      ".config-panel-surface > .config-split-view > .config-sidebar",
      (el) => el.getBoundingClientRect().height
    );
    assert.ok(genericSidebarHeight <= 165, `Generic sidebar should remain clamped to <= 160px: got ${genericSidebarHeight}px`);
  });

  // 3. Check small screen (380px width, e.g. narrow phone portrait)
  await t.test("small-screen (380px) stacks models panel vertically with at least 4 visible model items and independent scroll", async () => {
    await mountPanel("models", 380, 650);

    const splitViewDirection = await page.$eval(
      ".models-config-layout > .config-split-view",
      (el) => getComputedStyle(el).flexDirection
    );
    assert.equal(splitViewDirection, "column", "Models panel should stack vertically on small screen (380px)");

    const sidebarBox = await page.$eval(".models-config-layout .config-sidebar", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    assert.ok(sidebarBox.height >= 190, `Sidebar height on small screen must be at least 190px: got ${sidebarBox.height}px`);

    // Verify 4 model items are all visible inside sidebar-list
    const items = await page.$$eval(".config-sidebar-item", (els) =>
      els.slice(0, 4).map((el) => {
        const rect = el.getBoundingClientRect();
        return { id: el.id, y: rect.y, bottom: rect.bottom, height: rect.height };
      })
    );
    assert.equal(items.length, 4, "Should have retrieved 4 model items");

    const listBox = await page.$eval(".config-sidebar-list", (el) => {
      const rect = el.getBoundingClientRect();
      return { y: rect.y, bottom: rect.bottom, height: rect.height };
    });

    for (let i = 0; i < 4; i++) {
      assert.ok(
        items[i].bottom <= listBox.bottom + 1, // allow 1px rounding
        `Item ${i} (${items[i].id}) bottom (${items[i].bottom}) should be within list bottom (${listBox.bottom})`
      );
      assert.ok(
        items[i].y >= listBox.y - 1,
        `Item ${i} (${items[i].id}) y (${items[i].y}) should be within list top (${listBox.y})`
      );
      if (i > 0) {
        assert.ok(
          items[i].y >= items[i - 1].bottom - 1,
          `Item ${i} must not overlap item ${i - 1}`
        );
      }
    }

    // Verify independent scrolling attributes
    const listOverflowY = await page.$eval(".config-sidebar-list", (el) => getComputedStyle(el).overflowY);
    const detailOverflowY = await page.$eval(".config-detail", (el) => getComputedStyle(el).overflowY);
    assert.equal(listOverflowY, "auto", "Sidebar list should have overflow-y: auto");
    assert.equal(detailOverflowY, "auto", "Detail pane should have overflow-y: auto");

    // Verify Add Provider button is anchored below list
    const addBtnBox = await page.$eval("#add-provider-btn", (el) => {
      const rect = el.getBoundingClientRect();
      return { y: rect.y, bottom: rect.bottom };
    });
    assert.ok(addBtnBox.y >= listBox.bottom - 1, "Add Provider button sits below the list");

    // Verify Save button in footer is at the bottom
    const saveBtnBox = await page.$eval("#save-btn", (el) => el.getBoundingClientRect());
    const detailBox = await page.$eval(".config-detail", (el) => el.getBoundingClientRect());
    assert.ok(saveBtnBox.y >= detailBox.bottom - 1, "Save button in footer sits below detail pane");
  });

  await browser.close();
});
