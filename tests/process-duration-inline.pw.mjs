import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createIsolatedFixtureServer,
  launchIsolatedSessionBrowser,
} from "./fixtures/native-release-browser.mjs";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));

const bundle = await esbuild.build({
  entryPoints: [path.join(root, "tests/fixtures/process-duration-fixture.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  alias: { "@": root },
  loader: {
    ".css": "empty",
    ".woff2": "empty",
    ".woff": "empty",
    ".ttf": "empty",
    ".svg": "empty",
  },
  plugins: [
    {
      name: "css-module-stub",
      setup(build) {
        build.onResolve({ filter: /\.module\.css$/ }, (args) => ({
          path: args.path,
          namespace: "css-module-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "css-module-stub" }, () => ({
          contents: "export default {}",
          loader: "js",
        }));
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
});

test("ProcessDurationBadge inline layout & styling in 390px and 1124px viewports", async () => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --text-muted: #a1a1aa;
      --text-dim: #71717a;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    body {
      margin: 0;
      padding: 0;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>`;

  const serverInfo = await createIsolatedFixtureServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${serverInfo.port}`);
    if (url.pathname === "/bundle.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      return res.end(bundle.outputFiles[0].text);
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });

  const { browser, context, page, pageErrors, consoleErrors } =
    await launchIsolatedSessionBrowser(serverInfo.origin, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });

  try {
    await page.goto(`${serverInfo.origin}/`, { waitUntil: "networkidle" });

    // Ensure React rendered
    const completedContainer = page.locator('[data-testid="container-completed"]');
    await completedContainer.waitFor({ state: "visible" });

    // 1. Mobile viewport: 390px
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);

    const completedBadge = completedContainer.locator('[data-pi-subagent-duration="true"]');
    await completedBadge.waitFor({ state: "visible" });

    const badgeText = (await completedBadge.textContent())?.trim();
    assert.match(badgeText || "", /⏱️\s*≈\s*4秒/, "Badge text must contain ⏱️, ≈ and Chinese 4秒");

    const badgeTitle = await completedBadge.getAttribute("title");
    assert.equal(
      badgeTitle,
      "根据消息时间估算，非工具精确执行时间",
      "Badge title must declare estimation disclaimer",
    );

    // Style checks
    const badgeColor = await completedBadge.evaluate((el) => getComputedStyle(el).color);
    const badgeWeight = await completedBadge.evaluate((el) => getComputedStyle(el).fontWeight);
    const badgeSize = await completedBadge.evaluate((el) => getComputedStyle(el).fontSize);

    // #38bdf8 is rgb(56, 189, 248)
    assert.equal(badgeColor, "rgb(56, 189, 248)", "Color must match #38bdf8");
    assert.equal(badgeWeight, "500", "Font weight must be 500 matching live timer");
    assert.equal(badgeSize, "11px", "Font size must be 11px matching live timer");

    // Geometry & Layout in 390px:
    const svgBox = await completedContainer.locator("button svg").first().boundingBox();
    const labelSpan = completedContainer.locator("button > span > span").first();
    const labelBox = await labelSpan.boundingBox();
    const badgeBox = await completedBadge.boundingBox();
    const buttonBox = await completedContainer.locator("button").first().boundingBox();

    assert.ok(svgBox && labelBox && badgeBox && buttonBox, "All bounding boxes must exist");

    // Non-overlap across three segments
    assert.ok(
      svgBox.x + svgBox.width <= labelBox.x + 1,
      `SVG (${svgBox.x + svgBox.width}) must be before label (${labelBox.x}) without overlap`,
    );
    assert.ok(
      labelBox.x + labelBox.width <= badgeBox.x + 1,
      `Label (${labelBox.x + labelBox.width}) must be before badge (${badgeBox.x}) without overlap`,
    );

    // Badge follows label <= 12px (not pushed to far right!)
    const labelToBadgeDistance = badgeBox.x - (labelBox.x + labelBox.width);
    assert.ok(
      labelToBadgeDistance >= 0 && labelToBadgeDistance <= 12,
      `Distance between label and badge (${labelToBadgeDistance}px) must be <= 12px and >= 0`,
    );

    // Badge is NOT pushed to right edge
    const badgeToRightEdge = buttonBox.x + buttonBox.width - (badgeBox.x + badgeBox.width);
    assert.ok(
      badgeToRightEdge > 50,
      `Badge must naturally follow text, not pushed to the far right (right margin is ${badgeToRightEdge}px)`,
    );

    // No overflow
    assert.ok(
      badgeBox.x + badgeBox.width <= buttonBox.x + buttonBox.width,
      "Badge must not overflow button",
    );

    // Save screenshot for 390px
    fs.mkdirSync("/workspace/work", { recursive: true });
    await page.screenshot({ path: "/workspace/work/process-duration-inline-390.png" });
    fs.chmodSync("/workspace/work/process-duration-inline-390.png", 0o644);

    // 2. Desktop viewport: 1124px
    await page.setViewportSize({ width: 1124, height: 800 });
    await page.waitForTimeout(100);

    const deskLabelBox = await labelSpan.boundingBox();
    const deskBadgeBox = await completedBadge.boundingBox();
    const deskButtonBox = await completedContainer.locator("button").first().boundingBox();

    assert.ok(deskLabelBox && deskBadgeBox && deskButtonBox, "Desktop boxes must exist");
    const deskDistance = deskBadgeBox.x - (deskLabelBox.x + deskLabelBox.width);
    assert.ok(
      deskDistance >= 0 && deskDistance <= 12,
      `Desktop distance between label and badge (${deskDistance}px) must be <= 12px`,
    );
    const deskRightMargin = deskButtonBox.x + deskButtonBox.width - (deskBadgeBox.x + deskBadgeBox.width);
    assert.ok(
      deskRightMargin > 500,
      `On 1124px desktop, badge must follow label, not at far right (remaining right space is ${deskRightMargin}px)`,
    );

    await page.screenshot({ path: "/workspace/work/process-duration-inline-1124.png" });
    fs.chmodSync("/workspace/work/process-duration-inline-1124.png", 0o644);

    // 3. Theme consistency (Light & Dark)
    const toggleBtn = page.locator('[data-testid="toggle-theme"]');
    await toggleBtn.click();
    await page.waitForTimeout(100);

    const lightColor = await completedBadge.evaluate((el) => getComputedStyle(el).color);
    assert.equal(lightColor, "rgb(56, 189, 248)", "Color must remain #38bdf8 in light mode");

    // 4. Stopped timing does NOT tick
    const textBefore = (await completedBadge.textContent())?.trim();
    await page.waitForTimeout(1200);
    const textAfter = (await completedBadge.textContent())?.trim();
    assert.equal(
      textBefore,
      textAfter,
      "Stopped subagent timing must remain static and not tick",
    );

    // 5. Regular tools without subagent do not have badge
    const regularContainer = page.locator('[data-testid="container-regular"]');
    const regularBadgeCount = await regularContainer
      .locator('[data-pi-subagent-duration="true"]')
      .count();
    assert.equal(regularBadgeCount, 0, "Regular tool summary must not render duration badge");

    // 6. Running subagent has dynamic tick and timer emoji
    const runningBadge = page.locator(
      '[data-testid="container-running"] [data-pi-subagent-duration="true"]',
    );
    await runningBadge.waitFor({ state: "visible" });
    const runningText = (await runningBadge.textContent())?.trim();
    assert.match(runningText || "", /⏱️\s*≈/, "Running badge must contain ⏱️ and ≈");

    // 7. Zero page errors and zero console errors
    assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join(", ")}`);
    assert.equal(consoleErrors.length, 0, `Console errors: ${consoleErrors.join(", ")}`);
  } finally {
    await browser.close();
    await serverInfo.close();
  }
});
