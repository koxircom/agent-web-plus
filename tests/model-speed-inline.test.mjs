import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createJiti } from "jiti";

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MessageView } = await jiti.import("../components/MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const moduleSource = fs.readFileSync(path.join(sourceDir, "enhancements/modules/06-chat-view-and-tool-cards.js"), "utf8");
const helpers = ["modelSpeedColor", "upsertModelSpeedBadge"].map(name => {
  const match = moduleSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(match, `must extract ${name} from its owner`);
  return match[0];
}).join("\n");

// Use the actual component, not a handwritten imitation of its model header.
function renderMessage({ id, longName = false, isStreaming = false, compactProgress = false, provider = "gateway" }) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, {
      entryId: id,
      message: {
        role: "assistant", provider, model: "gpt-6.1-sol", timestamp: 1791474427000,
        content: [{ type: "text", text: "请在联系人页面查看：客户与供应商操作说明。" }],
      },
      modelNames: { "gateway:gpt-6.1-sol": longName ? "GPT-6.1 Sol · 很长的供应商及模型名称".repeat(8) : "GPT-6.1 Sol" },
      isStreaming, compactProgress,
    })));
}

function assertPlacement(rows, width) {
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.count, 1, `${row.id}: only one badge`);
    assert.ok(Math.abs(row.gap - 6) <= 1, `${row.id}: speed must immediately follow model (gap ${row.gap})`);
    assert.ok(Math.abs(row.centerDelta) <= 1, `${row.id}: model and speed must share a row`);
    assert.ok(row.left >= 0 && row.right <= width, `${row.id}: header must fit narrow screens`);
    assert.ok(row.modelWidth > 0, `${row.id}: speed must not hide the model`);
    assert.equal(row.ellipsis, "ellipsis");
  }
}

async function measure(page) {
  return page.locator('[data-pi-model-speed-host]').evaluateAll(hosts => hosts.map(host => {
    const model = host.previousElementSibling;
    const badge = host.querySelector('.pi-enh-model-speed');
    const m = model.getBoundingClientRect(), b = badge.getBoundingClientRect();
    return {
      id: host.closest('[data-entry-id]').getAttribute('data-entry-id'),
      count: host.querySelectorAll('.pi-enh-model-speed').length,
      gap: b.left - m.right, centerDelta: (b.top + b.height / 2) - (m.top + m.height / 2),
      left: m.left, right: b.right, modelWidth: m.width,
      ellipsis: getComputedStyle(model).textOverflow,
    };
  }));
}

test("real assistant headers keep live and historical speed beside the model on desktop and mobile", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const cases = [];
    for (const longName of [false, true]) {
      for (const isStreaming of [false, true]) {
        for (const compactProgress of [false, true]) {
          cases.push({ id: `model-${Number(longName)}-stream-${Number(isStreaming)}-compact-${Number(compactProgress)}`, longName, isStreaming, compactProgress });
        }
      }
    }
    // Two rendered segments of the same transcript entry must each own a badge.
    cases.push({ id: "split-entry", compactProgress: true }, { id: "split-entry" });
    const css = fs.readFileSync(path.join(sourceDir, "app/enhancements.css"), "utf8");
    const page = await browser.newPage();
    const receipts = [];
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.setContent(`<html class="dark"><head><style>${css}</style>
        <style>body{margin:16px;background:#191919;color:#ddd;font-family:Arial,sans-serif}</style></head>
        <body>${cases.map(renderMessage).join("")}${renderMessage({ id: "no-provider", provider: null })}</body></html>`);
      assert.equal(await page.locator('[data-entry-id="no-provider"] [data-pi-model-speed-host]').count(), 0);
      await page.addScriptTag({ content: helpers });
      assert.equal(await page.locator('[data-pi-model-speed-host]').first().evaluate(el => getComputedStyle(el).display), "none");
      await page.evaluate(() => {
        for (const msg of document.querySelectorAll('[data-message-role="assistant"]')) {
          upsertModelSpeedBadge(msg, { tps: 18.5, output: 185, durationSec: 10, live: true });
        }
      });
      assertPlacement(await measure(page), width);
      assert.equal(await page.locator('.pi-enh-model-speed[data-live="true"]').count(), cases.length);
      await page.evaluate(() => {
        for (const msg of document.querySelectorAll('[data-message-role="assistant"]')) {
          upsertModelSpeedBadge(msg, { tps: 27.9, output: 279, durationSec: 10, live: false });
          upsertModelSpeedBadge(msg, { tps: 27.9, output: 279, durationSec: 10, live: false });
        }
      });
      const rows = await measure(page);
      assertPlacement(rows, width);
      assert.equal(rows.length, cases.length);
      assert.deepEqual(await page.locator('.pi-enh-model-speed').allTextContents(), cases.map(() => "27.9 t/s"));
      assert.equal(await page.locator('.pi-enh-model-speed[data-live="false"]').count(), cases.length);
      assert.equal(await page.locator('[data-entry-id="split-entry"] .pi-enh-model-speed').count(), 2);
      receipts.push({ width, headers: rows.length, gap: 6, passed: true });
      if (process.env.PI_SPEED_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.PI_SPEED_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PI_SPEED_ARTIFACT_DIR, `headers-${width}.png`), fullPage: true });
      }
      // Prove the geometry check catches the reported right-aligned layout.
      await page.locator('[data-pi-model-speed-host]').first().evaluate(host => {
        host.parentElement.style.width = "100%";
        host.parentElement.style.justifyContent = "space-between";
      });
      const wrongRows = await measure(page);
      assert.throws(() => assertPlacement(wrongRows, width), /speed must immediately follow model/);
      // Clearing/disable and re-enable must not leave space or duplicate badges.
      await page.evaluate(() => {
        for (const msg of document.querySelectorAll('[data-message-role="assistant"]')) upsertModelSpeedBadge(msg, null);
      });
      assert.equal(await page.locator('.pi-enh-model-speed').count(), 0);
      assert.deepEqual(await page.locator('[data-pi-model-speed-host]').evaluateAll(hosts => hosts.map(h => getComputedStyle(h).display)), cases.map(() => "none"));
      await page.evaluate(() => {
        for (const msg of document.querySelectorAll('[data-message-role="assistant"]')) upsertModelSpeedBadge(msg, { tps: 30, output: 60, durationSec: 2, live: true });
      });
      assert.equal(await page.locator('.pi-enh-model-speed[data-live="true"]').count(), cases.length);
    }
    if (process.env.PI_SPEED_ARTIFACT_DIR) fs.writeFileSync(path.join(process.env.PI_SPEED_ARTIFACT_DIR, "layout.json"), JSON.stringify(receipts, null, 2));
  } finally {
    await browser.close();
  }
});
