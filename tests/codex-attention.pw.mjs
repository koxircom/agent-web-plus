import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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

const { createCodexAttentionMonitor } = await jiti.import("../lib/codex-attention-monitor.ts");

test("attention 状态真实 source-owner 与 monitor 生命周期", async () => {
  const sessionId = "codex:01901234-5678-7000-8000-000000000001";
  const notices = [];
  let snapshot = [
    {
      sessionId,
      title: "待回复方案会话",
      requests: [
        {
          id: "req-attention-1",
          method: "bridge/requestUserInputAsync",
          supported: true,
          params: { questions: [{ id: "q1", question: "是否同意部署？" }] },
        },
      ],
    },
  ];

  const monitor = createCodexAttentionMonitor({
    enabled: async () => true,
    read: async () => snapshot,
    notify: (notice) => {
      notices.push(notice);
      return "queued";
    },
  });

  // 1. 初次 tick 捕获待确认请求，进入 attention 队列
  await monitor.tick();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sessionId, sessionId);
  assert.equal(notices[0].kind, "question");
  assert.equal(notices[0].requestId, "req-attention-1");

  // 2. 状态源已解决（用户已回答，请求清空）
  snapshot = [{ sessionId, title: "已处理会话", requests: [] }];
  await monitor.tick();
  assert.equal(notices.length, 1, "请求解决后不产生新的待确认 attention 通知");

  await monitor.stop();
});

test("presentation-only: 基于 React 展示层输入契约验证 SessionSidebar 关注状态呈现与解除 (移动 390 与 桌面 1124)", async () => {
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { I18nProvider } from "./hooks/useI18n";
        import { SessionSidebar } from "./components/SessionSidebar";

        const initialSessions = [
          {
            id: "codex:attention-session",
            path: "/isolated/test.jsonl",
            cwd: "/workspace/project",
            name: "Attention 验收会话",
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: 2,
            firstMessage: "需要输入",
          }
        ];

        // [presentation-only] 直接注入 React 展示层输入契约，验证 SessionSidebar 徽标交互；不冒充 04-status 业务推导
        window.__PRESENTATION_STATUS_INPUT__ = { status: "attention" };
        window.__PI_ENH_GET_EFFECTIVE_PROJECT_STATUS_ENTRY__ = (id) => {
          return id === "codex:attention-session" ? window.__PRESENTATION_STATUS_INPUT__ : null;
        };

        function App() {
          const [status, setStatus] = useState("attention");
          window.setPresentationStatus = (newStatus) => {
            window.__PRESENTATION_STATUS_INPUT__ = { status: newStatus };
            setStatus(newStatus);
          };

          return (
            <I18nProvider>
              <div style={{ width: 320, height: 600, display: "flex" }}>
                <SessionSidebar
                  bootstrap={{
                    sessions: initialSessions,
                    sessionListVersion: 1,
                    runningSessionIds: [],
                    completionNotificationSuppressedSessionIds: [],
                    renderedAt: Date.now(),
                  }}
                  initialSessionId="codex:attention-session"
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

      // 验证 React 展示层输入契约处于 attention 状态下呈现 "待回复" 且具备专有类名
      await page.waitForFunction(() => {
        const row = document.querySelector(".pi-enh-session-needs-attention");
        const statusSpan = document.querySelector('span[title="等待你的回复"]');
        return Boolean(row && statusSpan && statusSpan.textContent.includes("待回复"));
      });

      // 更新展示层输入契约为 idle，验证 UI 解除待回复状态
      await page.evaluate(() => {
        window.setPresentationStatus("idle");
      });

      // 验证待回复标志解除
      await page.waitForFunction(() => {
        const row = document.querySelector(".pi-enh-session-needs-attention");
        return !row;
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
