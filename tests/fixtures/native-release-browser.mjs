import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

export const FIXTURE_DISCLAIMER = "QA-A-COMPONENT-HTTP-EVIDENCE-ONLY-MAIN-GATE-REVIEWS-FULL-SITE";

/**
 * Creates an isolated localhost HTTP server.
 * Explicitly rejects non-localhost and production host headers.
 */
export async function createIsolatedFixtureServer(handler) {
  let server;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const host = req.headers.host || "";
      // Hard rejection against external/production hosts
      if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ error: "External/production access strictly rejected" }));
      }
      res.setHeader("x-fixture-evidence", FIXTURE_DISCLAIMER);
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    server,
    port,
    origin,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/**
 * Launch Chromium with error tracking and network fencing to localhost only.
 */
export async function launchIsolatedSessionBrowser(origin, options = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const pageErrors = [];
  const consoleErrors = [];

  const context = await browser.newContext({
    viewport: options.viewport || { width: 1280, height: 800 },
    isMobile: Boolean(options.isMobile),
    hasTouch: Boolean(options.isMobile),
  });

  const page = await context.newPage();

  page.on("pageerror", (err) => {
    pageErrors.push(err.message || String(err));
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Ignore browser built-in network status logs from intentional 4xx/5xx fixture responses
      if (text.includes("favicon.ico") || text.includes("Failed to load resource")) {
        return;
      }
      consoleErrors.push(text);
    }
  });

  // Network fence: only allow requests to our isolated fixture server origin
  await page.route("**/*", (route) => {
    const reqUrl = new URL(route.request().url());
    if (reqUrl.origin === origin) {
      return route.continue();
    }
    // Block any external or production outgoing calls
    return route.abort("blockedbyclient");
  });

  return {
    browser,
    context,
    page,
    pageErrors,
    consoleErrors,
    assertCleanErrors() {
      assert.deepEqual(pageErrors, [], `Expected 0 page errors, got: ${JSON.stringify(pageErrors)}`);
      assert.deepEqual(consoleErrors, [], `Expected 0 console errors, got: ${JSON.stringify(consoleErrors)}`);
    },
    async close() {
      try {
        await context.close();
      } catch {}
      try {
        await browser.close();
      } catch {}
    },
  };
}

/**
 * Verify vertical non-overlapping flow geometry between sequential sibling boxes.
 */
export function assertVerticalGeometryNonOverlap(boxes, label = "rows") {
  assert.ok(boxes.length >= 2, `${label} must contain at least 2 boxes for geometric check`);
  for (let i = 0; i < boxes.length - 1; i++) {
    const cur = boxes[i];
    const next = boxes[i + 1];
    const curBottom = cur.y + cur.height;
    // next row must begin at or below current row bottom (tolerance 0.5px for subpixel rendering)
    const gap = next.y - curBottom;
    assert.ok(
      gap >= -0.5,
      `Geometric overlap detected between ${label}[${i}] and ${label}[${i + 1}]: ` +
      `cur.bottom=${curBottom}, next.y=${next.y}, gap=${gap} (must be >= 0)`
    );
  }
}
