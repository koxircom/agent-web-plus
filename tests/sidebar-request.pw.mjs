// Exercise the real SessionSidebar -> FileExplorer request path with fixture APIs only.
// Compare checkout snapshots with:
//   PI_PERF_BASELINE=1 PI_PERF_RESULT_PATH=/tmp/sidebar-before.json node tests/sidebar-request.pw.mjs
//   PI_PERF_RESULT_PATH=/tmp/sidebar-after.json node tests/sidebar-request.pw.mjs
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const load = createRequire(import.meta.url);
const esbuild = load("esbuild");
const { chromium } = load(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(process.env.PI_PERF_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const baseline = process.env.PI_PERF_BASELINE === "1";
const initialCwd = "/fixture/workspace-a";
const nextCwd = "/fixture/workspace-b";
const quietWindowMs = 180;
const requestTimeoutMs = 5_000;
const session = {
  id: "sidebar-request-fixture",
  path: "/fixture/workspace-a/session.jsonl",
  cwd: initialCwd,
  name: "Sidebar request fixture",
  created: "2026-10-10T12:00:00Z",
  modified: "2026-10-10T12:00:00Z",
  messageCount: 1,
  firstMessage: "Sidebar request fixture",
};
const bootstrap = {
  renderedAt: Date.now(),
  sessions: [session],
  sessionListVersion: 1,
  runningSessionIds: [],
  completionNotificationSuppressedSessionIds: [],
  decorations: {
    ok: true,
    revision: 1,
    state: {
      sessionTagsDefinitions: [],
      sessionTagMappings: {},
      sessionColors: {},
      enhancementSettingsByClient: {},
    },
    storageVersion: 1,
  },
};
const bundle = await esbuild.build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { SessionSidebar } from "./components/SessionSidebar";
      import { I18nProvider } from "./hooks/useI18n";

      const bootstrap = ${JSON.stringify(bootstrap)};
      window.fixture = { bumpRefreshKey: null, setCwd: null };

      function App() {
        const [explorerRefreshKey, setExplorerRefreshKey] = React.useState(0);
        const [cwd, setCwd] = React.useState(${JSON.stringify(initialCwd)});
        React.useEffect(() => {
          window.fixture.bumpRefreshKey = () => setExplorerRefreshKey((key) => key + 1);
          window.fixture.setCwd = (nextCwd) => setCwd(nextCwd);
        }, []);

        return <div style={{ height: 800, width: 360, display: "flex" }}>
          <SessionSidebar
            bootstrap={bootstrap}
            initialSessionId={bootstrap.sessions[0].id}
            selectedSessionId={bootstrap.sessions[0].id}
            selectedCwd={cwd}
            explorerRefreshKey={explorerRefreshKey}
            onExplorerRefresh={() => setExplorerRefreshKey((key) => key + 1)}
            onSelectSession={() => {}}
            onNewSession={() => {}}
          />
        </div>;
      }

      createRoot(document.getElementById("root")).render(
        <I18nProvider initialLocale="zh-CN"><App /></I18nProvider>
      );
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
});

const requests = [];
const pageErrors = [];
let browser;

function sendJson(response, data, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(data));
}

function requestUrl(request) {
  return new URL(request.url, "http://sidebar-request.fixture");
}

function listRequestCwd(url) {
  const encodedPath = url.pathname.slice("/api/files/".length);
  return `/${encodedPath.split("/").map(decodeURIComponent).join("/")}`;
}

function requestCounts(cwd) {
  let fileList = 0;
  let gitStatus = 0;
  for (const request of requests) {
    const url = requestUrl(request);
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/api/files/") &&
      url.searchParams.get("type") === "list" &&
      listRequestCwd(url) === cwd
    ) {
      fileList += 1;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/git/status" &&
      url.searchParams.get("cwd") === cwd
    ) {
      gitStatus += 1;
    }
  }
  return { fileList, gitStatus };
}

function reachedCounts(actual, expected) {
  return actual.fileList >= expected.fileList && actual.gitStatus >= expected.gitStatus;
}

async function waitForQuietCounts(cwd, expectedMinimum, label) {
  const deadline = Date.now() + requestTimeoutMs;
  let previous = null;
  let unchangedSince = 0;
  while (Date.now() < deadline) {
    const current = requestCounts(cwd);
    if (!reachedCounts(current, expectedMinimum)) {
      previous = null;
      unchangedSince = 0;
    } else {
      const key = JSON.stringify(current);
      if (key !== previous) {
        previous = key;
        unchangedSince = Date.now();
      } else if (Date.now() - unchangedSince >= quietWindowMs) {
        return current;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(requestCounts(cwd))}`);
}

function requestDelta(after, before) {
  return {
    fileList: after.fileList - before.fileList,
    gitStatus: after.gitStatus - before.gitStatus,
  };
}

function assertOneRefresh(delta, label) {
  assert.deepEqual(delta, { fileList: 1, gitStatus: 1 }, `${label} should refresh each endpoint once`);
}

const server = http.createServer((request, response) => {
  const url = requestUrl(request);
  requests.push({ method: request.method ?? "GET", url: request.url ?? "/" });

  if (url.pathname === "/bundle.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(bundle.outputFiles[0].text);
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><html><body><div id=\"root\"></div><script src=\"/bundle.js\"></script></body></html>");
    return;
  }

  if (url.pathname.startsWith("/api/files/")) {
    if (request.method !== "GET") {
      sendJson(response, { error: "This fixture does not accept file writes" }, 405);
      return;
    }
    sendJson(response, { entries: [], path: listRequestCwd(url) });
    return;
  }
  if (url.pathname === "/api/git/status") {
    sendJson(response, {
      isGitRepository: true,
      repositoryRoot: url.searchParams.get("cwd"),
      files: [],
      additions: 0,
      deletions: 0,
    });
    return;
  }
  if (url.pathname === "/api/worktrees") {
    const cwd = url.searchParams.get("cwd") ?? initialCwd;
    sendJson(response, {
      projectRoot: cwd,
      projectKey: cwd,
      isGit: false,
      isTopLevel: false,
      currentWorktreePath: null,
      worktrees: [],
    });
    return;
  }
  if (url.pathname === "/api/sessions") {
    sendJson(response, bootstrap);
    return;
  }
  if (url.pathname === "/api/agent/running") {
    sendJson(response, {
      sessionListVersion: bootstrap.sessionListVersion,
      runningSessionIds: [],
      completionNotificationSuppressedSessionIds: [],
    });
    return;
  }
  if (url.pathname === "/api/home") {
    sendJson(response, { home: "/fixture" });
    return;
  }
  if (url.pathname === "/api/open-in-explorer") {
    sendJson(response, { supported: false, reason: "remote" });
    return;
  }
  sendJson(response, {});
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
  await page.route("**/*", (route) => (
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  ));
  await page.goto(origin);
  await page.waitForFunction(() => (
    typeof window.fixture?.bumpRefreshKey === "function" &&
    typeof window.fixture?.setCwd === "function"
  ));

  const initial = await waitForQuietCounts(initialCwd, { fileList: 1, gitStatus: 1 }, "initial file explorer load");
  if (baseline) {
    assert.ok(initial.fileList >= 1 && initial.gitStatus >= 1, "baseline fixture must issue both initial requests");
  } else {
    assert.deepEqual(initial, { fileList: 1, gitStatus: 1 }, "candidate mount should load each endpoint once");
  }

  const beforeParentRefresh = requestCounts(initialCwd);
  await page.evaluate(() => window.fixture.bumpRefreshKey());
  const afterParentRefresh = await waitForQuietCounts(initialCwd, {
    fileList: beforeParentRefresh.fileList + 1,
    gitStatus: beforeParentRefresh.gitStatus + 1,
  }, "parent refreshKey increment");
  const parentRefreshDelta = requestDelta(afterParentRefresh, beforeParentRefresh);
  assertOneRefresh(parentRefreshDelta, "parent refreshKey increment");

  await page.evaluate((cwd) => window.fixture.setCwd(cwd), nextCwd);
  await page.waitForFunction((cwd) => (
    document.querySelector("[data-current-cwd]")?.getAttribute("data-current-cwd") === cwd
  ), nextCwd);
  const nextCwdInitial = await waitForQuietCounts(nextCwd, { fileList: 1, gitStatus: 1 }, "cwd change");
  assert.deepEqual(nextCwdInitial, { fileList: 1, gitStatus: 1 }, "cwd change should load each endpoint once");

  const beforeManualRefresh = requestCounts(nextCwd);
  await page.locator('button[title="刷新文件浏览器"]').click();
  const afterManualRefresh = await waitForQuietCounts(nextCwd, {
    fileList: beforeManualRefresh.fileList + 1,
    gitStatus: beforeManualRefresh.gitStatus + 1,
  }, "manual explorer refresh");
  const manualRefreshDelta = requestDelta(afterManualRefresh, beforeManualRefresh);
  assertOneRefresh(manualRefreshDelta, "manual explorer refresh");

  const apiWrites = requests.filter((request) => {
    const url = requestUrl(request);
    return url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method);
  });
  assert.deepEqual(pageErrors, [], "fixture browser should have no uncaught errors");
  assert.deepEqual(apiWrites, [], "the request fixture should not receive writes or uploads");

  const result = {
    status: "passed",
    mode: baseline ? "baseline" : "candidate",
    initial: {
      cwd: initialCwd,
      fileListRequests: initial.fileList,
      gitStatusRequests: initial.gitStatus,
      duplicateObserved: initial.fileList > 1 || initial.gitStatus > 1,
      onePerEndpointAsserted: !baseline,
    },
    parentRefreshKeyIncrement: { cwd: initialCwd, delta: parentRefreshDelta },
    cwdChange: { from: initialCwd, to: nextCwd, requests: nextCwdInitial },
    manualRefresh: { cwd: nextCwd, delta: manualRefreshDelta },
    apiWrites: apiWrites.length,
    uploadsExercised: false,
    pageErrors,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = process.env.PI_PERF_RESULT_PATH;
  if (outputPath) {
    const resolvedOutputPath = path.resolve(outputPath);
    mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, json);
  }
  process.stdout.write(json);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
