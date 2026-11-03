import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = process.cwd();
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": root,
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
  interopDefault: true,
  moduleCache: false,
});

test("title naming 失败与恢复在 session catalog 中正确反映 source-owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "title-naming-pw-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = directory;

  const { listCodexSessions } = await jiti.import("../lib/execution-engines/codex-engine.ts");
  const { saveExecutionEngineSettings } = await jiti.import("../lib/execution-engine-settings.ts");

  const id = "12345678-aaaa-bbbb-cccc-123456789abc";
  const failure = { status: "failed", message: "自动命名失败，稍后将自动重试" };
  let currentTitleNaming = failure;

  const response = (body) => ({
    ok: true,
    status: 200,
    headers: { getSetCookie: () => ["sid=test"] },
    json: async () => body,
  });

  globalThis.fetch = async (input) => {
    const p = new URL(String(input)).pathname;
    if (p === "/api/login") return response({});
    if (p === "/api/auth") return response({ authenticated: true, csrf: "fixture" });
    if (p === "/api/sessions") {
      return response({
        sessions: [
          {
            id,
            title: "新聊天",
            cwd: "/fixture",
            recency: 1,
            titleNaming: currentTitleNaming,
          },
        ],
      });
    }
    if (p === "/api/activity") return response({ sessions: [{ id, status: "idle" }] });
    throw new Error("Unexpected path " + p);
  };

  try {
    await saveExecutionEngineSettings({
      defaultEngine: "codex",
      codex: {
        enabled: true,
        url: "http://127.0.0.1:19097",
        username: "fixture",
        password: "fixture",
      },
    });

    const failed = await listCodexSessions();
    assert.deepEqual(failed.sessions[0].titleNaming, failure);

    // 成功恢复后
    currentTitleNaming = null;
    const recovered = await listCodexSessions();
    assert.equal(recovered.sessions[0].titleNaming, null);
    assert.notEqual(recovered.sessionListVersion, failed.sessionListVersion);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("title naming 失败标签在真实界面中绑定 source-owner 且支持成功清除 (移动 390 与 桌面 1124)", async () => {
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { I18nProvider } from "./hooks/useI18n";
        import { SessionSidebar } from "./components/SessionSidebar";

        const makeSession = (id, name, titleNaming) => ({
          id,
          path: "/isolated/" + id + ".jsonl",
          cwd: "/workspace/project",
          name,
          titleNaming,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: name,
        });

        function App() {
          const [sessionAError, setSessionAError] = useState(true);
          window.__SET_SESSION_A_ERROR__ = setSessionAError;

          const sessions = [
            makeSession(
              "codex:session-A",
              "会话 A - 命名测试",
              sessionAError ? { status: "failed", message: "自动命名失败，稍后将自动重试" } : null
            ),
            makeSession(
              "codex:session-B",
              "会话 B - 正常命名",
              null
            ),
          ];

          return (
            <I18nProvider>
              <div style={{ width: 340, height: 600, display: "flex" }}>
                <SessionSidebar
                  key={"sidebar-" + sessionAError}
                  bootstrap={{
                    sessions,
                    sessionListVersion: sessionAError ? 1 : 2,
                    runningSessionIds: [],
                    completionNotificationSuppressedSessionIds: [],
                    renderedAt: Date.now(),
                  }}
                  initialSessionId="codex:session-A"
                  onSelectSession={() => {}}
                  onNewSession={() => {}}
                />
              </div>
            </I18nProvider>
          );
        }

        createRoot(document.getElementById("root")).render(<App />);
      `,
    },
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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/bundle.js") {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(bundle.outputFiles[0].text);
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });

  try {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1124, height: 768 },
    ]) {
      const pageErrors = [];
      const consoleErrors = [];

      const ctx = await browser.newContext({ viewport, locale: "zh-CN" });
      const page = await ctx.newPage();

      page.on("pageerror", (e) => pageErrors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });

      await page.goto(baseUrl);

      // 验证 Session A 呈现 "自动命名失败"
      const failedBadge = page.locator('span[data-pi-native-title-naming="failed"]');
      await failedBadge.waitFor();
      assert.equal(await failedBadge.innerText(), "自动命名失败");
      assert.equal(await failedBadge.getAttribute("title"), "自动命名失败，稍后将自动重试");

      // 验证 Session B 没有该错误标签 (严格隔离 source-owner)
      const sessionBRow = page.locator('[data-pi-enh-session-id="codex:session-B"]');
      await sessionBRow.waitFor();
      assert.equal(await sessionBRow.locator('span[data-pi-native-title-naming="failed"]').count(), 0);

      // 模拟 Session A 重新提炼成功，清除错误状态
      await page.evaluate(() => {
        window.__SET_SESSION_A_ERROR__(false);
      });

      // 验证错误标签已解除
      await page.waitForFunction(() => {
        return !document.querySelector('span[data-pi-native-title-naming="failed"]');
      });

      assert.equal(pageErrors.length, 0);
      assert.equal(consoleErrors.length, 0);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
