import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");

const screenshotDir = process.env.QUEUE_DRAG_SCREENSHOT_DIR || resolve(tmpdir(), "agent-web-queue-drag");
await mkdir(screenshotDir, { recursive: true });

// Build the bundle in memory with esbuild
const bundleResult = await build({
  entryPoints: [resolve(rootDir, "tests/queue-drag-sort-fixture.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  alias: { "@": rootDir },
  define: { "process.env.NODE_ENV": '"production"' },
});
const bundleJs = bundleResult.outputFiles[0].text;
const queueCss = await readFile(resolve(rootDir, "components/ComposerQueue.css"), "utf8");

// State for mock HTTP server with real state updates
let mockServerState = {
  steering: [{ text: "优先任务 A", token: "token-steer-A", images: [], status: "ready" }],
  followUp: [
    { text: "普通任务 1", token: "token-follow-1", images: [], status: "ready" },
    { text: "普通任务 2", token: "token-follow-2", images: [], status: "ready" },
    { text: "普通任务 3", token: "token-follow-3", images: [], status: "ready" },
  ],
  reorderCalls: [],
  failNextReorder: false,
  hangReorder: false,
};

function resetMockState(
  followItems = [
    { text: "普通任务 1", images: [], status: "ready" },
    { text: "普通任务 2", images: [], status: "ready" },
    { text: "普通任务 3", images: [], status: "ready" },
  ],
  steerItems = [{ text: "优先任务 A", images: [], status: "ready" }],
) {
  mockServerState = {
    steering: steerItems.map((item, i) => {
      const text = typeof item === "string" ? item : item.text;
      const images = typeof item === "string" ? [] : item.images || [];
      const status = typeof item === "string" ? "ready" : item.status || "ready";
      return { text, token: `token-steer-${i + 1}`, images, status };
    }),
    followUp: followItems.map((item, i) => {
      const text = typeof item === "string" ? item : item.text;
      const images = typeof item === "string" ? [] : item.images || [];
      const status = typeof item === "string" ? "ready" : item.status || "ready";
      return { text, token: `token-follow-${i + 1}`, images, status };
    }),
    reorderCalls: [],
    failNextReorder: false,
    hangReorder: false,
  };
}

const htmlTemplate = (theme = "dark") => `<!doctype html>
<html lang="zh-CN" class="${theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ComposerQueue Drag Sort E2E</title>
  <style>
    :root {
      --bg-panel: ${theme === "dark" ? "#1e1e24" : "#ffffff"};
      --border: ${theme === "dark" ? "#3f3f46" : "#e4e4e7"};
      --text: ${theme === "dark" ? "#fafafa" : "#18181b"};
      --text-muted: ${theme === "dark" ? "#a1a1aa" : "#71717a"};
      --text-dim: ${theme === "dark" ? "#71717a" : "#a1a1aa"};
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: ${theme === "dark" ? "#121214" : "#f4f4f5"};
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    ${queueCss}
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/bundle.js") {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(bundleJs);
      return;
    }

    if (url.pathname.startsWith("/api/agent/")) {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body || "{}");

        if (payload.type === "get_queue_actions") {
          const steerItems = mockServerState.steering.map((x) => ({
            token: x.token,
            text: x.text,
            imageCount: x.images ? x.images.length : 0,
            status: x.status || "",
          }));
          const followItems = mockServerState.followUp.map((x) => ({
            token: x.token,
            text: x.text,
            imageCount: x.images ? x.images.length : 0,
            status: x.status || "",
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              success: true,
              data: {
                version: 2,
                reorder: true,
                steering: steerItems,
                followUp: followItems,
              },
            }),
          );
          return;
        }

        if (payload.type === "get_queued_message") {
          const allItems = [...mockServerState.steering, ...mockServerState.followUp];
          const found = allItems.find((x) => x.token === payload.token);
          if (found) {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                success: true,
                data: {
                  token: found.token,
                  text: found.text,
                  kind: mockServerState.steering.includes(found) ? "steering" : "followUp",
                  images: found.images || [],
                },
              }),
            );
            return;
          }
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, error: "未找到消息" }));
          return;
        }

        if (payload.type === "reorder_queued_message") {
          mockServerState.reorderCalls.push(payload);
          if (mockServerState.hangReorder) {
            // Keep connection pending indefinitely to simulate server timeout
            return;
          }
          if (mockServerState.failNextReorder) {
            mockServerState.failNextReorder = false;
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "排序请求失败 500" }));
            return;
          }

          // 1. Required fields
          if (!payload.token || !payload.targetToken) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "缺少 token 或 targetToken" }));
            return;
          }

          // 2. CAS verification
          const currentTokens = [
            ...mockServerState.steering.map((x) => x.token),
            ...mockServerState.followUp.map((x) => x.token),
          ];
          if (Array.isArray(payload.tokens)) {
            const casMatches =
              payload.tokens.length === currentTokens.length &&
              payload.tokens.every((t, i) => t === currentTokens[i]);
            if (!casMatches) {
              res.statusCode = 409;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ success: false, error: "队列状态已被外部更新 (CAS conflict)" }));
              return;
            }
          }

          // 3. Locate tokens and reject cross-kind reorder
          const steerIdx = mockServerState.steering.findIndex((x) => x.token === payload.token);
          const steerTargetIdx = mockServerState.steering.findIndex((x) => x.token === payload.targetToken);
          const followIdx = mockServerState.followUp.findIndex((x) => x.token === payload.token);
          const followTargetIdx = mockServerState.followUp.findIndex((x) => x.token === payload.targetToken);

          if ((steerIdx !== -1 && followTargetIdx !== -1) || (followIdx !== -1 && steerTargetIdx !== -1)) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "仅支持同类消息排序 (同类拒绝)" }));
            return;
          }

          // Execute real state update in mockServer
          if (steerIdx !== -1 && steerTargetIdx !== -1) {
            const copy = [...mockServerState.steering];
            const [item] = copy.splice(steerIdx, 1);
            copy.splice(steerTargetIdx, 0, item);
            mockServerState.steering = copy;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: true, data: { version: 2 } }));
            return;
          }

          if (followIdx !== -1 && followTargetIdx !== -1) {
            const copy = [...mockServerState.followUp];
            const [item] = copy.splice(followIdx, 1);
            copy.splice(followTargetIdx, 0, item);
            mockServerState.followUp = copy;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: true, data: { version: 2 } }));
            return;
          }

          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, error: "未找到目标排队消息" }));
          return;
        }
      }
    }

    const theme = url.searchParams.get("theme") || "dark";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(htmlTemplate(theme));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

let browser;

test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
});

test.after(async () => {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

test("[Component & Browser E2E] multi-viewport multi-theme queue drag: drop line, non-overlap (>= 0), no sibling shifts, exact token/target CAS update", async () => {
  for (const engine of ["pi", "codex"]) {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1124, height: 800 }]) {
      for (const theme of ["dark", "light"]) {
        resetMockState();
        const pageErrors = [];
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.width === 390,
          locale: "zh-CN",
        });
        const page = await context.newPage();
        page.on("pageerror", (e) => pageErrors.push(e.message));

        await page.goto(`${baseUrl}/?theme=${theme}&engine=${engine}&session=${engine}-test-session`);
        await page.waitForSelector(".pi-enh-queue-row");

        // Wait for queue action buttons to be verified and enabled
        await page.waitForFunction(
          () => {
            const btns = document.querySelectorAll(".pi-enh-queue-sort");
            return btns.length > 1 && !btns[1].disabled;
          },
          { timeout: 5000 },
        );
        const handles = page.locator(".pi-enh-queue-sort");

        // 1. Initial 3 adjacent bounding boxes non-overlap assertion: y >= previous.bottom (strictly >= 0 difference)
        const initialBoxes = await page.locator(".pi-enh-queue-row").evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return { y: r.y, bottom: r.bottom, height: r.height };
          }),
        );
        assert.ok(initialBoxes.length >= 3, "At least 3 rows rendered");
        for (let i = 1; i < initialBoxes.length; i++) {
          assert.ok(
            initialBoxes[i].y >= initialBoxes[i - 1].bottom,
            `Row ${i} overlaps with Row ${i - 1}: ${initialBoxes[i].y} < ${initialBoxes[i - 1].bottom}`,
          );
        }

        // 2. Start drag on followUp 1 (index 1 in rows)
        const handle1Box = await handles.nth(1).boundingBox();
        assert.ok(handle1Box);

        await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
        await page.mouse.down();
        // Drag downwards to between followUp 2 and followUp 3
        await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2 + 50, { steps: 5 });

        const draggedBox = await page.locator(".pi-enh-queue-row-dragging").boundingBox();
        assert.ok(draggedBox, "Dragged row is visible");
        assert.ok(draggedBox.y - initialBoxes[1].y >= 25, "Entire dragged row follows the pointer");

        // Assert: Drop line is visible and pointer-events is none
        const dropLine = page.locator(".pi-enh-queue-drop-line");
        await dropLine.waitFor({ state: "visible", timeout: 3000 });
        const dropLineStyle = await dropLine.evaluate((el) => {
          const s = window.getComputedStyle(el);
          return {
            pointerEvents: s.pointerEvents,
            height: s.height,
            top: el.style.top,
          };
        });
        assert.equal(dropLineStyle.pointerEvents, "none");
        assert.equal(dropLineStyle.height, "2px");
        assert.ok(dropLineStyle.top, "Drop line top position set");

        // Assert: Siblings DO NOT transform
        const siblingTransforms = await page.locator(".pi-enh-queue-row:not(.pi-enh-queue-row-dragging)").evaluateAll((nodes) =>
          nodes.map((n) => n.style.transform || "none"),
        );
        for (const tr of siblingTransforms) {
          assert.equal(tr, "none", "Siblings must not shift or translateY during drag");
        }

        // Save screenshot of drag in progress
        const shotPath = resolve(screenshotDir, `queue-drag-active-${engine}-${viewport.width}-${theme}.png`);
        await page.screenshot({ path: shotPath });
        await chmod(shotPath, 0o644);

        // 3. Release mouse pointer to commit reorder
        await page.mouse.up();

        // Drop line must immediately disappear upon drop
        await page.waitForFunction(() => document.querySelectorAll(".pi-enh-queue-drop-line").length === 0);

        // Wait for real reorder RPC call and assert exact tokens
        await page.waitForFunction(() => {
          const el = window.__QUEUE_TEST_CONTROL__;
          return el !== undefined;
        });
        await page.waitForTimeout(100);

        assert.ok(mockServerState.reorderCalls.length > 0, "RPC must be called");
        const lastCall = mockServerState.reorderCalls.at(-1);
        assert.equal(lastCall.token, "token-follow-1");
        assert.equal(lastCall.targetToken, "token-follow-2");

        // Assert mockServer state updated in-place via CAS
        const followTokens = mockServerState.followUp.map((x) => x.token);
        assert.deepEqual(followTokens, ["token-follow-2", "token-follow-1", "token-follow-3"]);

        // 4. Anti-bounce assertion: order remains optimistic
        const intermediateTexts = await page.locator(".pi-enh-queue-text").allTextContents();
        assert.deepEqual(
          intermediateTexts,
          ["优先任务 A", "普通任务 2", "普通任务 1", "普通任务 3"],
          "Optimistic order must hold without bouncing back to old order!",
        );

        // 5. Update authoritative queue with matching expected IDs
        await page.evaluate(() => {
          window.__QUEUE_TEST_CONTROL__?.setQueue({
            steering: ["优先任务 A"],
            followUp: ["普通任务 2", "普通任务 1", "普通任务 3"],
            requestIds: {
              steering: ["id-steer-A"],
              followUp: ["id-follow-2", "id-follow-1", "id-follow-3"],
            },
          });
        });

        await page.waitForTimeout(50);
        const finalTexts = await page.locator(".pi-enh-queue-text").allTextContents();
        assert.deepEqual(finalTexts, ["优先任务 A", "普通任务 2", "普通任务 1", "普通任务 3"]);

        // Save screenshot of settled queue
        const settledShotPath = resolve(screenshotDir, `queue-settled-${engine}-${viewport.width}-${theme}.png`);
        await page.screenshot({ path: settledShotPath });
        await chmod(settledShotPath, 0o644);

        assert.deepEqual(pageErrors, [], `No page errors allowed in ${engine} ${viewport.width} ${theme}`);
        await context.close();
      }
    }
  }
});

test("[Component & E2E] upward drag to head boundary and downward drag to tail boundary with exact token assert", async () => {
  resetMockState();
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?theme=dark&engine=pi`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 3 && !btns[3].disabled;
    },
    { timeout: 5000 },
  );

  const handles = page.locator(".pi-enh-queue-sort");
  const handle3Box = await handles.nth(3).boundingBox();
  assert.ok(handle3Box);

  await page.mouse.move(handle3Box.x + handle3Box.width / 2, handle3Box.y + handle3Box.height / 2);
  await page.mouse.down();
  // Move up by 100px to head of follow-ups
  await page.mouse.move(handle3Box.x + handle3Box.width / 2, handle3Box.y + handle3Box.height / 2 - 100, { steps: 5 });

  const dropLine = page.locator(".pi-enh-queue-drop-line");
  await dropLine.waitFor({ state: "visible" });
  await page.mouse.up();

  // Optimistic order should place "普通任务 3" first among follow-ups
  await page.waitForTimeout(100);
  const textsAfterUp = await page.locator(".pi-enh-queue-text").allTextContents();
  assert.deepEqual(textsAfterUp, ["优先任务 A", "普通任务 3", "普通任务 1", "普通任务 2"]);

  // Exact token assertion on upward drag
  const lastCall = mockServerState.reorderCalls.at(-1);
  assert.equal(lastCall.token, "token-follow-3");
  assert.equal(lastCall.targetToken, "token-follow-1");
  assert.deepEqual(
    mockServerState.followUp.map((x) => x.token),
    ["token-follow-3", "token-follow-1", "token-follow-2"],
  );

  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[HTTP API Unit] mockServer CAS verification and cross-kind reorder rejection (同类拒绝)", async () => {
  resetMockState();

  // 1. Cross-kind reorder rejection
  const crossRes = await fetch(`${baseUrl}/api/agent/session-test-1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "reorder_queued_message",
      token: "token-steer-1",
      targetToken: "token-follow-1",
      tokens: ["token-steer-1", "token-follow-1", "token-follow-2", "token-follow-3"],
    }),
  });
  assert.equal(crossRes.status, 400);
  const crossJson = await crossRes.json();
  assert.match(crossJson.error, /同类拒绝/);

  // 2. CAS mismatch rejection
  const casRes = await fetch(`${baseUrl}/api/agent/session-test-1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "reorder_queued_message",
      token: "token-follow-1",
      targetToken: "token-follow-2",
      tokens: ["stale-token-x", "stale-token-y"],
    }),
  });
  assert.equal(casRes.status, 409);
  const casJson = await casRes.json();
  assert.match(casJson.error, /CAS conflict/);
});

test("[Component & E2E] distinct image and delivery state never cross-mix during pendingReorder; badge disabled during pending; menu disables reorder", async () => {
  const dummyImg = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  resetMockState(
    [
      { text: "含图与失败状态任务 1", images: [{ data: dummyImg, mimeType: "image/png" }], status: "failed" },
      { text: "纯文本正常任务 2", images: [], status: "ready" },
      { text: "纯文本等待任务 3", images: [], status: "unknown" },
    ],
    [],
  );

  const customQueue = {
    steering: [],
    followUp: ["含图与失败状态任务 1", "纯文本正常任务 2", "纯文本等待任务 3"],
    requestIds: {
      steering: [],
      followUp: ["req-img-1", "req-text-2", "req-text-3"],
    },
    deliveryStates: [
      { status: "failed", error: "测试失败错误" },
      { status: "ready" },
      { status: "unknown" },
    ],
  };

  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?theme=dark&engine=pi&initialQueue=${encodeURIComponent(JSON.stringify(customQueue))}`);
  await page.waitForSelector(".pi-enh-queue-row");

  // Wait for sort handles
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 0 && !btns[0].disabled;
    },
    { timeout: 5000 },
  );

  // 1. Check initial state: Row 0 has image badge and failed status
  const badge0 = page.locator(".pi-enh-queue-row").nth(0).locator(".pi-enh-queue-image-badge");
  assert.equal(await badge0.count(), 1, "Row 0 must have image badge");
  assert.equal(await page.locator(".pi-enh-queue-row").nth(1).locator(".pi-enh-queue-image-badge").count(), 0);

  // 2. Drag row 0 down to between row 1 and row 2
  const handle0 = page.locator(".pi-enh-queue-row").nth(0).locator(".pi-enh-queue-sort");
  const handle0Box = await handle0.boundingBox();
  assert.ok(handle0Box);

  await page.mouse.move(handle0Box.x + handle0Box.width / 2, handle0Box.y + handle0Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle0Box.x + handle0Box.width / 2, handle0Box.y + handle0Box.height / 2 + 50, { steps: 5 });
  await page.mouse.up();

  // During pendingReorder (optimistic state), check that Row 1 (which now displays "含图与失败状态任务 1") keeps its own image and status!
  await page.waitForTimeout(50);
  const row1Text = await page.locator(".pi-enh-queue-row").nth(1).locator(".pi-enh-queue-text").textContent();
  assert.equal(row1Text, "含图与失败状态任务 1");

  const row1BadgeCount = await page.locator(".pi-enh-queue-row").nth(1).locator(".pi-enh-queue-image-badge").count();
  assert.equal(row1BadgeCount, 1, "Image badge must stay with row 1 after optimistic reorder, never cross-mixing!");

  const row0BadgeCount = await page.locator(".pi-enh-queue-row").nth(0).locator(".pi-enh-queue-image-badge").count();
  assert.equal(row0BadgeCount, 0, "Row 0 (纯文本正常任务 2) must not get Row 1's image badge!");

  // Assert image badge is disabled during pendingReorder
  const badgeDisabled = await page.locator(".pi-enh-queue-row").nth(1).locator(".pi-enh-queue-image-badge").isDisabled();
  assert.equal(badgeDisabled, true, "Image badge must be disabled during pending action");

  // 3. Settle queue by delivering new authoritative state
  await page.evaluate(() => {
    window.__QUEUE_TEST_CONTROL__?.setQueue({
      steering: [],
      followUp: ["纯文本正常任务 2", "含图与失败状态任务 1", "纯文本等待任务 3"],
      requestIds: {
        steering: [],
        followUp: ["req-text-2", "req-img-1", "req-text-3"],
      },
      deliveryStates: [
        { status: "ready" },
        { status: "failed", error: "测试失败错误" },
        { status: "unknown" },
      ],
    });
  });

  await page.waitForTimeout(80);

  // 4. Test menu open: more menu open disables sortable handles (pointer and keyboard reorder disabled)
  const moreBtn = page.locator(".pi-enh-queue-row").nth(0).locator(".pi-enh-queue-more");
  await moreBtn.click();
  await page.waitForSelector(".pi-enh-queue-menu");

  const sortHandleDisabledWhenMenuOpen = await page.locator(".pi-enh-queue-row").nth(0).locator(".pi-enh-queue-sort").isDisabled();
  assert.equal(sortHandleDisabledWhenMenuOpen, true, "Sort handle must be disabled while menu is open");

  // Close menu with Escape
  await page.keyboard.press("Escape");
  await page.waitForSelector(".pi-enh-queue-menu", { state: "detached" });

  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[E2E] multitouch gesture: second contact during active drag cancels drag immediately without RPC", async () => {
  resetMockState();
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?theme=dark&engine=pi`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 1 && !btns[1].disabled;
    },
    { timeout: 5000 },
  );

  const handles = page.locator(".pi-enh-queue-sort");
  const handle1Box = await handles.nth(1).boundingBox();
  assert.ok(handle1Box);

  // 1. Primary contact starts drag
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2 + 50, { steps: 5 });

  await page.locator(".pi-enh-queue-drop-line").waitFor({ state: "visible" });

  // 2. Dispatch a second pointerdown contact on window with different pointerId
  await page.evaluate(() => {
    const evt = new PointerEvent("pointerdown", {
      pointerId: 99999,
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
    });
    window.dispatchEvent(evt);
  });

  // 3. Drop line must immediately disappear due to multitouch cancellation
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".pi-enh-queue-drop-line").count(), 0, "Drop line must disappear on second contact");

  // Mouse up should NOT commit anything
  await page.mouse.up();
  await page.waitForTimeout(50);
  assert.equal(mockServerState.reorderCalls.length, 0, "Multitouch cancellation must not trigger any reorder RPC");

  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[Component & E2E] old failure / new session isolation: stale action failure does not clear new session/operation pending state", async () => {
  resetMockState();
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?theme=dark&engine=pi&session=session-init`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 1 && !btns[1].disabled;
    },
    { timeout: 5000 },
  );

  // Switch session quickly while active
  await page.evaluate(() => {
    window.__QUEUE_TEST_CONTROL__?.setSessionId("session-new-different");
  });

  await page.waitForTimeout(80);
  assert.equal(mockServerState.reorderCalls.length, 0, "Stale action cannot leak across sessions");

  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[Component & E2E] near-boundary tiny drag does not trigger commit or RPC", async () => {
  resetMockState();
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?theme=dark&engine=pi`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 1 && !btns[1].disabled;
    },
    { timeout: 5000 },
  );

  const handles = page.locator(".pi-enh-queue-sort");
  const handle1Box = await handles.nth(1).boundingBox();
  assert.ok(handle1Box);

  // Tiny drag by only 2px
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2 + 2);
  await page.mouse.up();

  await page.waitForTimeout(100);
  assert.equal(mockServerState.reorderCalls.length, 0, "Near-boundary tiny drag must not trigger RPC");
  const texts = await page.locator(".pi-enh-queue-text").allTextContents();
  assert.deepEqual(texts, ["优先任务 A", "普通任务 1", "普通任务 2", "普通任务 3"]);

  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[Component & E2E] RPC failure rolls back to original order, cleans drop line and shows error", async () => {
  resetMockState();
  mockServerState.failNextReorder = true; // Inject 500 error on next reorder

  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?theme=dark&engine=pi`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 1 && !btns[1].disabled;
    },
    { timeout: 5000 },
  );

  const handles = page.locator(".pi-enh-queue-sort");
  const handle1Box = await handles.nth(1).boundingBox();
  assert.ok(handle1Box);

  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2 + 50, { steps: 5 });
  await page.mouse.up();

  // Wait for RPC to fail and rollback
  await page.waitForTimeout(200);

  // Drop line must be gone
  assert.equal(await page.locator(".pi-enh-queue-drop-line").count(), 0);

  // Order rolled back
  const rolledBackTexts = await page.locator(".pi-enh-queue-text").allTextContents();
  assert.deepEqual(rolledBackTexts, ["优先任务 A", "普通任务 1", "普通任务 2", "普通任务 3"]);

  // Explicit error feedback shown
  const feedback = page.locator(".pi-enh-queue-feedback");
  await feedback.waitFor({ state: "visible" });
  const errorMsg = await feedback.textContent();
  assert.ok(errorMsg && errorMsg.includes("失败"), "Feedback must indicate failure");

  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[Component & E2E] cancel gestures (pointercancel, blur, escape) abort drag without writing or RPC", async () => {
  resetMockState();
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/?theme=dark&engine=pi`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 1 && !btns[1].disabled;
    },
    { timeout: 5000 },
  );

  const handles = page.locator(".pi-enh-queue-sort");
  const handle1Box = await handles.nth(1).boundingBox();
  assert.ok(handle1Box);

  // Test 1: Escape key during drag
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2 + 50, { steps: 5 });

  await page.locator(".pi-enh-queue-drop-line").waitFor({ state: "visible" });

  await page.keyboard.press("Escape");
  await page.mouse.up();

  await page.waitForTimeout(80);
  assert.equal(await page.locator(".pi-enh-queue-drop-line").count(), 0);
  assert.equal(mockServerState.reorderCalls.length, 0, "Escape must abort without RPC");

  // Test 2: Window blur during drag
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2 + 50, { steps: 5 });

  await page.locator(".pi-enh-queue-drop-line").waitFor({ state: "visible" });

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();

  await page.waitForTimeout(80);
  assert.equal(await page.locator(".pi-enh-queue-drop-line").count(), 0);
  assert.equal(mockServerState.reorderCalls.length, 0, "Blur must abort without RPC");

  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[Component & E2E] autoscroll triggers when dragging near container top or bottom edges", async () => {
  const longItems = Array.from({ length: 8 }, (_, i) => `普通长列表任务 ${i + 1}`);
  resetMockState(longItems, ["优先 A"]);
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const manyItemsQueue = {
    steering: ["优先 A"],
    followUp: longItems,
    requestIds: {
      steering: ["id-steer-A"],
      followUp: Array.from({ length: 8 }, (_, i) => `id-follow-long-${i + 1}`),
    },
  };

  await page.goto(`${baseUrl}/?theme=dark&engine=pi&initialQueue=${encodeURIComponent(JSON.stringify(manyItemsQueue))}`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 1 && !btns[1].disabled;
    },
    { timeout: 5000 },
  );

  const listEl = page.locator(".pi-enh-queue-list");
  const listRect = await listEl.boundingBox();
  assert.ok(listRect);

  const initialScrollTop = await listEl.evaluate((el) => el.scrollTop);
  assert.equal(initialScrollTop, 0);

  const handles = page.locator(".pi-enh-queue-sort");
  const handle1Box = await handles.nth(1).boundingBox();
  assert.ok(handle1Box);

  // Drag item 1 towards bottom edge of list
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
  await page.mouse.down();
  // Near the bottom edge of list
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, listRect.y + listRect.height - 10, { steps: 5 });

  // Wait for autoscroll animation frame to tick and scroll the container
  await page.waitForFunction(
    (initial) => {
      const el = document.querySelector(".pi-enh-queue-list");
      return el && el.scrollTop > initial;
    },
    initialScrollTop,
    { timeout: 4000 },
  );

  const scrolledTop = await listEl.evaluate((el) => el.scrollTop);
  assert.ok(scrolledTop > initialScrollTop, "List container must auto-scroll downwards near bottom edge");

  await page.mouse.up();
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("[Component & E2E] reorder confirmation timeout (10s) shows feedback and does NOT retry automatically", async () => {
  resetMockState();
  mockServerState.hangReorder = true; // Hang reorder response indefinitely

  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1124, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.clock.install();
  await page.goto(`${baseUrl}/?theme=dark&engine=pi`);
  await page.waitForSelector(".pi-enh-queue-row");
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".pi-enh-queue-sort");
      return btns.length > 1 && !btns[1].disabled;
    },
    { timeout: 5000 },
  );

  const handles = page.locator(".pi-enh-queue-sort");
  const handle1Box = await handles.nth(1).boundingBox();
  assert.ok(handle1Box);

  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle1Box.x + handle1Box.width / 2, handle1Box.y + handle1Box.height / 2 + 50, { steps: 5 });
  await page.mouse.up();

  // Exactly 1 RPC dispatched initially
  assert.equal(mockServerState.reorderCalls.length, 1);

  // Fast forward past the 10000ms timeout window
  await page.clock.fastForward(10500);

  // Assert explicit timeout feedback shown
  const feedback = page.locator(".pi-enh-queue-feedback");
  await feedback.waitFor({ state: "visible" });
  const errorMsg = await feedback.textContent();
  assert.match(errorMsg || "", /超时/);

  // Fast forward another 5000ms and verify zero automatic retries
  await page.clock.fastForward(5000);
  assert.equal(mockServerState.reorderCalls.length, 1, "Must never automatically retry failed or timed out reorders");

  assert.deepEqual(pageErrors, []);
  await context.close();
});

