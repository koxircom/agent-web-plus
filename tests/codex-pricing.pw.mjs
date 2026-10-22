import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = fileURLToPath(new URL("..", import.meta.url));
const acceptanceDir = path.resolve(root, "../acceptance");
fs.mkdirSync(acceptanceDir, { recursive: true });

function atBeijing(day, hour = 12) {
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+08:00`);
}

function makeTimeline(values, ts) {
  const fields = [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "totalTokens", "messageCount", "calls", "records", "costNano",
    "unpricedTokens", "missingUsage"
  ];
  return [[ts, ...fields.map(f => values[f] || 0)]];
}

function createLedgerFixture(pricingOverrides = {}) {
  const day = "2026-10-22";
  const parentId = "codex:00000000-0000-4000-8000-000000000001";
  const childId = "codex:00000000-0000-4000-8000-000000000002";

  // Sample Sol: 544,400 in, 36,600 out, 8,190,000 cacheRead -> $2.2738 (2,273,800,000 nano)
  const solValues = {
    inputTokens: 544400,
    outputTokens: 36600,
    cacheReadTokens: 8190000,
    cacheWriteTokens: 0,
    totalTokens: 544400 + 36600 + 8190000,
    messageCount: 5,
    calls: 1,
    records: 1,
    costNano: 0,
    unpricedTokens: 544400 + 36600 + 8190000,
    missingUsage: 0,
  };

  // Sample Luna: 116,300 in, 65,000 out, 1,940,000 cacheRead -> $0.06353 (63,530,000 nano)
  const lunaValues = {
    inputTokens: 116300,
    outputTokens: 65000,
    cacheReadTokens: 1940000,
    cacheWriteTokens: 0,
    totalTokens: 116300 + 65000 + 1940000,
    messageCount: 3,
    calls: 1,
    records: 1,
    costNano: 0,
    unpricedTokens: 116300 + 65000 + 1940000,
    missingUsage: 0,
  };

  const pricing = {
    version: 1,
    currency: "USD",
    unit: "per_1m_tokens",
    updatedAt: "2026-10-22 00:00",
    refresh: {
      state: "current",
      attemptedAt: "2026-10-22 00:00",
    },
    models: {
      "gpt-6.1-sol": {
        input: 2.00,
        output: 10.00,
        cacheRead: 0.10,
        cacheWrite: 2.50,
        source: "pi-sdk",
        provider: "openai-codex",
        modelId: "gpt-6.1-sol",
        tiered: false,
      },
      "gpt-6-luna": {
        input: 0.10,
        output: 0.50,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        source: "pi-sdk",
        provider: "openai-codex",
        modelId: "gpt-6-luna",
        tiered: false,
      },
    },
    ...pricingOverrides,
  };

  return {
    version: 2,
    snapshotId: "codex-pricing-fixture",
    generatedAt: "2026-10-22T04:00:00.000Z",
    sources: {
      codex: {
        engine: "codex",
        fileCount: 2,
        scannedAt: "2026-10-22 12:00",
      },
    },
    sessions: {
      [parentId]: { title: "Codex 架构方案设计" },
      [childId]: { name: "Codex 模块分析自动子任务", parentSessionId: parentId },
    },
    buckets: [
      {
        ...solValues,
        engine: "codex",
        sessionId: parentId,
        day,
        role: "main",
        model: "gpt-6.1-sol",
        provider: "openai-codex",
        timeline: makeTimeline(solValues, atBeijing(day, 10)),
      },
      {
        ...lunaValues,
        engine: "codex",
        sessionId: childId,
        day,
        role: "subagent",
        model: "gpt-6-luna",
        provider: "openai-codex",
        controllerModel: "gpt-6.1-sol",
        controllerProvider: "openai-codex",
        timeline: makeTimeline(lunaValues, atBeijing(day, 11)),
      },
    ],
    pricing,
  };
}

function checkNonOverlap(boxes) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = a.x < b.x + b.width - 0.5 && a.x + a.width - 0.5 > b.x;
      const overlapY = a.y < b.y + b.height - 0.5 && a.y + a.height - 0.5 > b.y;
      assert.ok(
        !(overlapX && overlapY),
        `Card ${i} and Card ${j} overlap! a=${JSON.stringify(a)}, b=${JSON.stringify(b)}`
      );
    }
  }
}

test("Playwright isolated usage panel: displays estimated cost, badge, no overlap across adjacent cards, phone & desktop", async () => {
  let currentLedger = createLedgerFixture();

  const coreJs = fs.readFileSync(path.join(root, "bin/usage-guard/usage-ledger-core.js"), "utf8");
  const panelJs = fs.readFileSync(path.join(root, "enhancements/pi-usage-panel.js"), "utf8");
  const globalsCss = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const enhancementsCss = fs.readFileSync(path.join(root, "app/enhancements.css"), "utf8");

  const html = `<!doctype html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #18181b;
      --bg-panel: #27272a;
      --bg-hover: #3f3f46;
      --bg-selected: #52525b;
      --border: rgba(255, 255, 255, 0.1);
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --text-dim: #71717a;
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    ${globalsCss}
    ${enhancementsCss}
  </style>
  <script>${coreJs}</script>
</head>
<body>
  <div id="usage-host" style="width: 100%; max-width: 1000px; margin: 0 auto;"></div>
  <script>${panelJs}</script>
  <script>
    window.__PI_ENH_USAGE_LEDGER__ = null;
    window.renderTestPanel = function(ledger) {
      window.__PI_ENH_USAGE_LEDGER__ = ledger;
      const host = document.getElementById("usage-host");
      host.innerHTML = "";
      window.PiUsagePanel.render(host, {}, { enabled: () => true });
    };
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/api/usage/ledger") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ledger: currentLedger }));
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  const browser = await chromium.launch({ headless: true });
  const report = {
    testedAt: new Date().toISOString(),
    desktop: {},
    phone: {},
    offlineFailureMode: {},
  };

  try {
    // 1. Desktop Test (1280x900)
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(ledger => window.renderTestPanel(ledger), currentLedger);

      // 等待面板内容出现
      await page.locator(".pi-enh-kpi-pro-grid").waitFor();

      // 断言预估费用卡片
      const cards = page.locator(".pi-enh-kpi-pro-card");
      assert.equal(await cards.count(), 4, "Must have exactly 4 KPI cards");

      const costCard = cards.nth(3);
      const costLabel = await costCard.locator(".kpi-pro-label").textContent();
      const costValue = await costCard.locator(".kpi-pro-value").textContent();
      const costHint = await costCard.locator(".kpi-pro-hint").textContent();

      assert.match(costLabel, /预估费用/);
      assert.match(costLabel, /参考估算/, "Must display estimate badge");
      // 544400 Sol ($2.274) + 116300 Luna ($0.064) = $2.337
      assert.match(costValue, /\$2\.33[78]/, "Must show calculated dollar amount");
      assert.doesNotMatch(costHint, /Codex 未提供费用/);
      assert.match(costHint, /按当前标准档参考价估算，非账单/);

      // 拓扑无重叠检查：4 个 KPI 卡片几何位置无重叠（尤其费用卡片与相邻 3 个卡片）
      const cardBoxes = [];
      for (let i = 0; i < 4; i++) {
        const box = await cards.nth(i).boundingBox();
        assert.ok(box, `Card ${i} must have bounding box`);
        cardBoxes.push(box);
      }
      checkNonOverlap(cardBoxes);

      // 角色卡片拓扑无重叠检查
      const roleCards = page.locator(".pi-enh-role-card");
      assert.equal(await roleCards.count(), 3);
      const roleBoxes = [];
      for (let i = 0; i < 3; i++) {
        const box = await roleCards.nth(i).boundingBox();
        assert.ok(box);
        roleBoxes.push(box);
      }
      checkNonOverlap(roleBoxes);

      // 数据来源核查
      const provenance = await page.locator("[data-usage-pricing-provenance]").textContent();
      assert.match(provenance, /价格参考：pi-sdk/);
      assert.match(provenance, /刷新状态：最新/);

      // 模型卡片与角色卡片显式参考估算区分断言
      const roleCostBadges = page.locator(".pi-enh-role-card [data-usage-cost-badge]");
      assert.ok(await roleCostBadges.count() > 0, "Role cards must have cost estimate badges");
      assert.match(await roleCostBadges.first().textContent(), /参考估算/);

      const modelCostBadges = page.locator(".pi-enh-model-card [data-usage-cost-badge]");
      assert.ok(await modelCostBadges.count() > 0, "Model breakdown cards must have cost estimate badges");
      assert.match(await modelCostBadges.first().textContent(), /参考估算/);

      // 展开子任务明细
      const details = page.locator("[data-usage-subtask-details]");
      if (await details.count() > 0) {
        await details.first().locator("summary").click();
        const subtaskRow = page.locator("[data-usage-subtask-row]").first();
        const subtaskCostText = await subtaskRow.locator("td").last().textContent();
        // Luna 自动子任务有估算费用，带有参考估算标记
        assert.match(subtaskCostText, /\$0\.06[34]/);
        assert.match(subtaskCostText, /参考估算/);
      }

      const desktopPngPath = path.join(acceptanceDir, "codex-pricing-desktop.png");
      await page.screenshot({ path: desktopPngPath, fullPage: true });

      report.desktop = {
        viewport: { width: 1280, height: 900 },
        costValue,
        costLabel: costLabel.trim(),
        costHint: costHint.trim(),
        screenshot: desktopPngPath,
        kpiCardsCount: 4,
        roleCardsCount: 3,
        nonOverlapPassed: true,
      };

      await context.close();
    }

    // 2. Phone Test (390x844)
    {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(ledger => window.renderTestPanel(ledger), currentLedger);

      await page.locator(".pi-enh-kpi-pro-grid").waitFor();

      const cards = page.locator(".pi-enh-kpi-pro-card");
      assert.equal(await cards.count(), 4);

      const costCard = cards.nth(3);
      const costValue = await costCard.locator(".kpi-pro-value").textContent();
      const costLabel = await costCard.locator(".kpi-pro-label").textContent();

      assert.match(costValue, /\$2\.33[78]/);
      assert.match(costLabel, /参考估算/);

      // 手机视口下 4 个卡片排成 2x2 网格，仍然严格无重叠
      const cardBoxes = [];
      for (let i = 0; i < 4; i++) {
        const box = await cards.nth(i).boundingBox();
        assert.ok(box);
        cardBoxes.push(box);
      }
      checkNonOverlap(cardBoxes);

      const phonePngPath = path.join(acceptanceDir, "codex-pricing-phone.png");
      await page.screenshot({ path: phonePngPath, fullPage: true });

      report.phone = {
        viewport: { width: 390, height: 844 },
        costValue,
        costLabel: costLabel.trim(),
        screenshot: phonePngPath,
        nonOverlapPassed: true,
      };

      await context.close();
    }

    // 3. Offline / Refresh Failure Mode Test (真实契约 state=error 且 updatedAt=null 保留参考价格文案不白屏)
    {
      const errorPricingLedger = createLedgerFixture({
        updatedAt: null,
        refresh: {
          state: "error",
          attemptedAt: "2026-10-22 00:00",
          message: "网络请求超时",
        },
      });

      // Desktop
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(ledger => window.renderTestPanel(ledger), errorPricingLedger);

      await page.locator(".pi-enh-kpi-pro-grid").waitFor();

      // 金额和卡片完整保留，绝不白屏
      const costValue = await page.locator(".pi-enh-kpi-pro-card").nth(3).locator(".kpi-pro-value").textContent();
      assert.match(costValue, /\$2\.33[78]/);

      // updatedAt null 时必须显示“尚未联网更新/内置目录”，绝不能伪造为“近期”
      const provenance = await page.locator("[data-usage-pricing-provenance]").textContent();
      assert.match(provenance, /尚未联网更新\/内置目录/);
      assert.match(provenance, /刷新状态：刷新受阻/);

      // 警告条友好呈现真实 error 刷新失败原因，同时说明保留参考价测算
      const warning = page.locator("[data-usage-pricing-refresh-warning]");
      assert.equal(await warning.count(), 1, "Must show refresh warning with real error state");
      const warningText = await warning.textContent();
      assert.match(warningText, /网络请求超时/);
      assert.match(warningText, /已安全保留当前标准档参考价测算/);

      const errorPngPath = path.join(acceptanceDir, "codex-pricing-error-refresh.png");
      await page.screenshot({ path: errorPngPath, fullPage: true });

      // Phone 视口下同样验证真实 error 不白屏
      const phoneContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const phonePage = await phoneContext.newPage();
      await phonePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await phonePage.evaluate(ledger => window.renderTestPanel(ledger), errorPricingLedger);
      await phonePage.locator(".pi-enh-kpi-pro-grid").waitFor();
      const phoneCost = await phonePage.locator(".pi-enh-kpi-pro-card").nth(3).locator(".kpi-pro-value").textContent();
      assert.match(phoneCost, /\$2\.33[78]/);
      const phoneWarning = phonePage.locator("[data-usage-pricing-refresh-warning]");
      assert.equal(await phoneWarning.count(), 1);
      await phoneContext.close();

      report.offlineFailureMode = {
        warningText: warningText.trim(),
        screenshot: errorPngPath,
        whiteScreenAvoided: true,
      };

      await context.close();
    }

    // 4. Explicit Free Rate Test (明确 0 费率全 0 显示 $0.000 参考估算且不是未定价)
    {
      const freeLedger = createLedgerFixture({
        models: {
          "gpt-6.1-sol": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            source: "free-tier",
            provider: "openai-codex",
            modelId: "gpt-6.1-sol",
          },
          "gpt-6-luna": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            source: "free-tier",
            provider: "openai-codex",
            modelId: "gpt-6-luna",
          },
        },
      });

      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(ledger => window.renderTestPanel(ledger), freeLedger);

      await page.locator(".pi-enh-kpi-pro-grid").waitFor();

      const costCard = page.locator(".pi-enh-kpi-pro-card").nth(3);
      const costValue = await costCard.locator(".kpi-pro-value").textContent();
      const costLabel = await costCard.locator(".kpi-pro-label").textContent();

      // 全 0 显示 $0.000 且标注参考估算，绝不能误判为“未定价”
      assert.equal(costValue.trim(), "$0.000");
      assert.match(costLabel, /参考估算/);
      assert.doesNotMatch(costLabel, /未定价/);

      // 模型卡片和角色卡片也要显式展示 $0.000 和参考估算
      const roleCost = await page.locator(".pi-enh-role-card .role-cost-value").first().textContent();
      assert.match(roleCost, /\$0\.000/);
      assert.match(roleCost, /参考估算/);

      // 展开子任务明细
      const details = page.locator("[data-usage-subtask-details]");
      if (await details.count() > 0) {
        await details.first().locator("summary").click();
        const subtaskRow = page.locator("[data-usage-subtask-row]").first();
        const subtaskCostText = await subtaskRow.locator("td").last().textContent();
        assert.match(subtaskCostText, /\$0\.000/);
        assert.match(subtaskCostText, /参考估算/);
      }

      await context.close();
    }

    // 写入验收报告 JSON
    const reportPath = path.join(acceptanceDir, "codex-pricing-acceptance.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log("Acceptance report saved:", reportPath);

  } finally {
    await browser.close();
    server.close();
  }
});
