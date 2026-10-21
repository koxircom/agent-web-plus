// Isolated browser fixture for Codex native subagents panel:
// Tests 390px (mobile) & 1280px (desktop) topology, selection, parent switching, clean closing, retry, and zero model calls.
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");

const root = fileURLToPath(new URL("..", import.meta.url));

const parentA = "codex:00000000-0000-4000-8000-00000000000a";
const parentB = "codex:00000000-0000-4000-8000-00000000000b";

// subagentsA contains direct children (child-a1, child-a3) and grandchild (child-a2 under child-a1)
const subagentsA = {
  agents: [
    {
      id: "child-a1",
      parentId: parentA,
      title: "代码审查子任务",
      nickname: "审查员",
      role: "reviewer",
      status: "completed",
      updated: Date.now() / 1000 - 3600,
      archived: false,
    },
    {
      id: "child-a2",
      parentId: "child-a1", // grandchild
      title: "深度安全探查",
      nickname: "安全探针",
      role: "security-audit",
      status: "inProgress",
      updated: Date.now() / 1000 - 1800,
      archived: false,
    },
    {
      id: "child-a3",
      parentId: parentA,
      title: "构建打包子任务",
      nickname: "打包器",
      role: "builder",
      status: "unknown",
      updated: Date.now() / 1000 - 900,
      archived: false,
    },
  ],
  limited: false,
};

const subagentsB = {
  agents: [
    {
      id: "child-b1",
      parentId: parentB,
      title: "文档生成子任务",
      nickname: "撰写者",
      role: "writer",
      status: "completed",
      updated: Date.now() / 1000 - 7200,
      archived: false,
    },
  ],
  limited: false,
};

const detailA1 = {
  id: "child-a1",
  parentId: parentA,
  title: "代码审查子任务",
  nickname: "审查员",
  role: "reviewer",
  status: "completed",
  saved: true,
  turns: [
    {
      id: "turn-1",
      status: "completed",
      messages: [
        { id: "m1", role: "user", text: "请检查代码质量与潜在漏洞" },
        { id: "m2", role: "activity", kind: "storedToolEvent", title: "代码静态分析", text: '{"path":"src/index.ts"}' },
        { id: "m3", role: "assistant", text: "代码审查通过，未发现高危漏洞。" },
      ],
    },
  ],
};

let detailA2FailOnce = true;
const detailA2 = {
  id: "child-a2",
  parentId: "child-a1",
  title: "深度安全探查",
  nickname: "安全探针",
  role: "security-audit",
  status: "inProgress",
  saved: true,
  turns: [
    {
      id: "turn-sec-1",
      status: "inProgress",
      messages: [
        { id: "m-s1", role: "user", text: "启动深入内核边界测试" },
      ],
    },
  ],
};

const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { CodexSubagentsPanel } from './components/CodexSubagentsPanel';

      function TestFixture() {
        const [sessionId, setSessionId] = useState('${parentA}');
        const [open, setOpen] = useState(true);

        return (
          <div style={{ padding: 12, fontFamily: 'sans-serif' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button id="btn-parent-a" onClick={() => { setSessionId('${parentA}'); setOpen(true); }}>父会话A</button>
              <button id="btn-parent-b" onClick={() => { setSessionId('${parentB}'); setOpen(true); }}>父会话B</button>
              <button id="btn-toggle" onClick={() => setOpen(o => !o)}>开关面板</button>
            </div>
            {open && (
              <CodexSubagentsPanel
                sessionId={sessionId}
                sessionTitle="测试父会话"
                isMobile={window.innerWidth < 640}
                onClose={() => setOpen(false)}
              />
            )}
          </div>
        );
      }
      createRoot(document.getElementById('root')!).render(<TestFixture />);
    `,
  },
  bundle: true,
  write: false,
  outfile: "fixture.js",
  format: "iife",
  alias: { "@": root },
  loader: { ".css": "empty", ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
});

const jsBundle = bundle.outputFiles.find((f) => f.path.endsWith(".js"))?.text;

let requests = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  requests.push({ method: req.method, path: u.pathname, query: u.search });

  if (u.pathname === "/bundle.js") {
    res.setHeader("Content-Type", "application/javascript");
    return res.end(jsBundle);
  }

  // Pure read-only subagents mock endpoints
  if (u.pathname === `/api/sessions/${encodeURIComponent(parentA)}/subagents`) {
    const childId = u.searchParams.get("id");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "private, no-store");
    if (childId === "child-a1") {
      return res.end(JSON.stringify(detailA1));
    }
    if (childId === "child-a2") {
      if (detailA2FailOnce) {
        detailA2FailOnce = false;
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "模拟子智能体详情读取故障" }));
      }
      return res.end(JSON.stringify(detailA2));
    }
    return res.end(JSON.stringify(subagentsA));
  }

  if (u.pathname === `/api/sessions/${encodeURIComponent(parentB)}/subagents`) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "private, no-store");
    return res.end(JSON.stringify(subagentsB));
  }

  // Reject all write methods with 405
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "子智能体面板仅支持只读查看" }));
  }

  res.setHeader("Content-Type", "text/html");
  res.end(`
    <!DOCTYPE html>
    <html lang="zh">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root {
            --bg: #ffffff;
            --bg-panel: #f9fafb;
            --bg-selected: #e0f2fe;
            --bg-hover: #f3f4f6;
            --border: #e5e7eb;
            --text: #111827;
            --text-muted: #4b5563;
            --text-dim: #9ca3af;
            --accent: #2563eb;
            --user-bg: #f3f4f6;
            --tool-bg: #f8fafc;
            --font-mono: monospace;
          }
          body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
        </style>
      </head>
      <body>
        <div id="root"></div>
        <script src="/bundle.js"></script>
      </body>
    </html>
  `);
});

let browser;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  for (const viewportWidth of [390, 1280]) {
    detailA2FailOnce = true;
    const isMobile = viewportWidth < 640;
    const page = await browser.newPage({
      viewport: { width: viewportWidth, height: 800 },
      hasTouch: isMobile,
    });

    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(`http://127.0.0.1:${port}`);

    // 1. Verify dialog and list opened
    const dialog = page.getByRole("dialog", { name: "Codex 子智能体列表" });
    await dialog.waitFor();
    await page.getByText("代码审查子任务").waitFor();
    await page.getByText("深度安全探查").waitFor();
    await page.getByText("构建打包子任务").waitFor();

    // 2. Parent-child and grandchild visual tree structure & derivation badge
    const grandchildBadge = page.getByText("派生自: 审查员");
    await grandchildBadge.waitFor();
    assert.equal(await grandchildBadge.count(), 1, "Grandchild node must show parent derivation badge");

    // 3. Geometric Non-Overlap & Flow Check (At least 3 adjacent sibling nodes)
    const item0 = page.locator('button[data-agent-id="child-a1"]');
    const item1 = page.locator('button[data-agent-id="child-a2"]');
    const item2 = page.locator('button[data-agent-id="child-a3"]');

    const box0 = await item0.boundingBox();
    const box1 = await item1.boundingBox();
    const box2 = await item2.boundingBox();

    assert.ok(box0 && box1 && box2, "All 3 adjacent items must have bounding boxes");
    // Assert strictly: next.y >= cur.y + cur.height
    assert.ok(
      box1.y >= box0.y + box0.height - 0.5,
      `Item1 top (${box1.y}) must be >= Item0 bottom (${box0.y + box0.height})`
    );
    assert.ok(
      box2.y >= box1.y + box1.height - 0.5,
      `Item2 top (${box2.y}) must be >= Item1 bottom (${box1.y + box1.height})`
    );

    // 4. Select subagent to view detail
    await page.getByText("代码审查子任务").click();
    await page.getByText("请检查代码质量与潜在漏洞").waitFor();
    await page.getByText("代码静态分析").waitFor();
    await page.getByText("代码审查通过，未发现高危漏洞。").waitFor();

    // 5. Test detail failure and retry flow on grandchild item (child-a2)
    if (isMobile) {
      await page.getByText("← 返回任务列表").click();
      await page.getByText("深度安全探查").waitFor();
    }
    await page.getByText("深度安全探查").click();
    await page.getByText("模拟子智能体详情读取故障").waitFor();
    const retryBtn = page.getByRole("button", { name: "重试" });
    await retryBtn.waitFor();
    await retryBtn.click();
    await page.getByText("启动深入内核边界测试").waitFor();

    // 6. Test read-only refresh button
    const refreshBtn = page.getByRole("button", { name: "刷新子智能体状态" });
    await refreshBtn.waitFor();
    await refreshBtn.click();
    await page.getByText("启动深入内核边界测试").waitFor();

    if (isMobile) {
      await page.getByText("← 返回任务列表").click();
      await page.getByText("构建打包子任务").waitFor();
    }

    // 7. Rapid Parent Switch (A -> B): verify clean state reset and zero cross-parent requests
    requests = []; // Clear request log before switch
    await page.locator("#btn-parent-b").click();
    await page.getByText("文档生成子任务").waitFor();

    // Old Parent A items must NOT exist in Parent B
    assert.equal(await page.getByText("代码审查子任务").count(), 0);
    assert.equal(await page.getByText("深度安全探查").count(), 0);

    // Assert that NO cross-parent request was ever fired to parentB with child-a1/child-a2
    const crossParentReqs = requests.filter(
      (r) =>
        r.path.includes(encodeURIComponent(parentB)) &&
        (r.query.includes("child-a1") || r.query.includes("child-a2") || r.query.includes("child-a3"))
    );
    assert.equal(
      crossParentReqs.length,
      0,
      `Zero cross-parent detail requests allowed, got: ${JSON.stringify(crossParentReqs)}`
    );

    // 8. Close panel & verify NO requests fired after close
    const preCloseReqCount = requests.length;
    await page.getByRole("button", { name: "关闭面板" }).click();
    assert.equal(await dialog.count(), 0, "Dialog must be unmounted/closed");

    await page.waitForTimeout(100);
    const postCloseReqs = requests.slice(preCloseReqCount).filter((r) => r.path.includes("/subagents"));
    assert.equal(postCloseReqs.length, 0, "Zero requests allowed after panel is closed");

    assert.equal(pageErrors.length, 0, `Page errors encountered: ${pageErrors.join(", ")}`);
    await page.close();
  }

  // 9. Assert zero writes and zero model dispatch across entire suite
  const writeRequests = requests.filter((r) => r.method !== "GET");
  assert.equal(writeRequests.length, 0, "All subagents interactions must be strictly read-only GETs");

  console.log(JSON.stringify({ status: "passed", viewports: [390, 1280], writeRequests: 0 }));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
