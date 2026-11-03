import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

let cachedBundle = null;

export async function buildNativeInputBundle() {
  if (cachedBundle) return cachedBundle;
  const result = await build({
    entryPoints: [path.join(root, "tests/fixtures/native-input-release.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    loader: {
      ".css": "empty",
      ".woff2": "empty",
      ".woff": "empty",
      ".ttf": "empty",
      ".svg": "text",
      ".png": "empty",
    },
    alias: {
      "@": root,
      "server-only": "next/dist/compiled/server-only/empty.js",
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env": "{}",
    },
  });
  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

export function createHtmlTemplate() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Native Input Test</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --bg-panel: #252526;
      --border: #3c3c3c;
      --text: #cccccc;
      --text-dim: #888888;
      --accent: #0e639c;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--text);
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>`;
}

export async function startNativeInputServer(customHandler) {
  const bundleCode = await buildNativeInputBundle();
  const html = createHtmlTemplate();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");

      if (customHandler) {
        const handled = await customHandler(req, res, url);
        if (handled) return;
      }

      if (url.pathname === "/bundle.js") {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.end(bundleCode);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      res.statusCode = 404;
      res.end("Not Found");
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function runBrowserTest({ baseUrl, viewport, testFn }) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });

  const pageErrors = [];
  const consoleErrors = [];

  try {
    const context = await browser.newContext({
      viewport,
      locale: "zh-CN",
    });

    const page = await context.newPage();

    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(baseUrl);
    await page.waitForFunction(() => Boolean(window.__NATIVE_INPUT_API__));

    await testFn(page);

    assert.equal(pageErrors.length, 0, `Page errors encountered: ${JSON.stringify(pageErrors)}`);
    assert.equal(consoleErrors.length, 0, `Console errors encountered: ${JSON.stringify(consoleErrors)}`);
  } finally {
    await browser.close();
  }
}
