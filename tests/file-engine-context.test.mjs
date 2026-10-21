import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server.js";
import { openFileTab } from "../components/file-tab-state.ts";

const sandbox = mkdtempSync(join(tmpdir(), "file-engine-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

// Mock settings with codex enabled
const settingsDir = sandbox;
writeFileSync(
  join(settingsDir, "execution-engines.json"),
  JSON.stringify({
    defaultEngine: "pi",
    codex: { enabled: true, url: "http://127.0.0.1:30149" },
  }),
);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, _options = {}) => {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/login") {
    return Response.json({}, { headers: { "Set-Cookie": "fixture=1" } });
  }
  if (parsed.pathname === "/api/auth") {
    return Response.json({ authenticated: true, csrf: "fixture" });
  }
  if (parsed.pathname === "/api/projects") {
    return Response.json({
      projects: [{ key: "fixture", cwd: "/configured/workspace", name: "隔离工作区" }],
    });
  }
  if (parsed.pathname === "/api/projects/workspace") {
    const op = parsed.searchParams.get("operation");
    if (op === "list") {
      return Response.json({
        entries: [
          { name: "codex-only-native-entry.ts", kind: "file", size: 1024, modifiedUnix: 1770000000 },
        ],
        path: "/configured/workspace",
      });
    }
  }
  return Response.json({ error: "fixture fallback" }, { status: 404 });
};

const sourceRoot = process.env.FILE_CONTEXT_SOURCE_ROOT || new URL("..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": sourceRoot.replace(/\/$/, ""),
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
  interopDefault: true,
});

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(sandbox, { recursive: true, force: true });
});

const {
  shouldUseCodexWorkspace,
  resolveCodexWorkspaceTarget,
} = await jiti.import(join(sourceRoot, "lib/execution-engines/codex-files.ts"));

const { allowFileRoot } = await jiti.import(join(sourceRoot, "lib/file-access.ts"));
const { GET: filesGET, POST: filesPOST } = await jiti.import(join(sourceRoot, "app/api/files/[...path]/route.ts"));
const { GET: fileIndexGET } = await jiti.import("../app/api/file-index/route.ts");
const { GET: gitStatusGET } = await jiti.import("../app/api/git/status/route.ts");
const { GET: gitDiffGET } = await jiti.import("../app/api/git/diff/route.ts");

test("反例1: defaultPi + sessionless engineCodex: 显式访问Codex工作区，不走Pi鉴权并返回Codex原生特有条目", async () => {
  const result = await shouldUseCodexWorkspace(null, "codex");
  assert.equal(result, true, "defaultPi下显式engine=codex应解析为Codex空间");

  // 使用真实 NextRequest 访问 Codex 配置内远端路径
  const req = new NextRequest("http://localhost/api/files/configured/workspace?type=list&engine=codex");
  const res = await filesGET(req, { params: Promise.resolve({ path: ["configured", "workspace"] }) });
  assert.equal(res.status, 200, "Codex配置内远端路径应返回200");
  const data = await res.json();
  assert.equal(data.entries?.length, 1);
  assert.equal(data.entries?.[0]?.name, "codex-only-native-entry.ts", "确认返回Codex特有原生entry，证明未走Pi");
});

test("反例2: defaultCodex + explicitPi: 真实切换配置后显式访问Pi，不走Codex工作区，随后恢复状态", async () => {
  // 在隔离 settings 中真实切换为 defaultCodex
  writeFileSync(
    join(settingsDir, "execution-engines.json"),
    JSON.stringify({
      defaultEngine: "codex",
      codex: { enabled: true, url: "http://127.0.0.1:30149" },
    }),
  );
  try {
    assert.equal(await shouldUseCodexWorkspace(null), true, "默认应为Codex");
    const result = await shouldUseCodexWorkspace(null, "pi");
    assert.equal(result, false, "defaultCodex下显式engine=pi应解析为Pi本地空间");
    const localRoot = join(sandbox, "local-workspace");
    mkdirSync(localRoot);
    writeFileSync(join(localRoot, "pi-only-local-entry.txt"), "fixture");
    allowFileRoot(localRoot);
    const response = await filesGET(new NextRequest(`http://localhost/api/files${localRoot}?type=list&engine=pi`), {
      params: Promise.resolve({ path: localRoot.slice(1).split("/") }),
    });
    assert.equal(response.status, 200);
    const local = await response.json();
    assert(local.entries.some((entry) => entry.name === "pi-only-local-entry.txt"));
    assert(!local.entries.some((entry) => entry.name === "codex-only-native-entry.ts"));
  } finally {
    // 恢复测试状态
    writeFileSync(
      join(settingsDir, "execution-engines.json"),
      JSON.stringify({
        defaultEngine: "pi",
        codex: { enabled: true, url: "http://127.0.0.1:30149" },
      }),
    );
  }
});

test("反例3: 真实session优先: sessionId严格覆盖显式engine", async () => {
  // sessionId 为真实 pi session，即使传入 engine=codex 也必须解析为 pi
  assert.equal(await shouldUseCodexWorkspace("pi-sess-1", "codex"), false);
  // sessionId 为真实 codex session，即使传入 engine=pi 也必须解析为 codex
  assert.equal(await shouldUseCodexWorkspace("codex:sess-1", "pi"), true);
});

test("反例4: 非法engine应在所有文件相关API中严格返回400，不fallback更不改读NAS", async () => {
  // 1. shouldUseCodexWorkspace 抛出 RangeError
  await assert.rejects(
    () => shouldUseCodexWorkspace(null, "bad-engine"),
    RangeError,
  );

  // 2. /api/files GET
  const filesReq = new NextRequest("http://localhost/api/files/test?type=list&engine=bad-engine");
  const filesRes = await filesGET(filesReq, { params: Promise.resolve({ path: ["test"] }) });
  assert.equal(filesRes.status, 400, "files GET 非法engine必须400");

  // 3. /api/files POST
  const postReq = new NextRequest("http://localhost:30141/api/files/test?type=upload&engine=bad-engine", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  const postRes = await filesPOST(postReq, { params: Promise.resolve({ path: ["test"] }) });
  assert.equal(postRes.status, 400, "files POST 非法engine必须400");

  // 4. /api/file-index GET
  const indexReq = new NextRequest("http://localhost/api/file-index?cwd=/tmp&engine=bad-engine");
  const indexRes = await fileIndexGET(indexReq);
  assert.equal(indexRes.status, 400, "file-index GET 非法engine必须400");

  // 5. /api/git/status GET
  const gitStatusReq = new NextRequest("http://localhost/api/git/status?cwd=/tmp&engine=bad-engine");
  const gitStatusRes = await gitStatusGET(gitStatusReq);
  assert.equal(gitStatusRes.status, 400, "git status GET 非法engine必须400");

  // 6. /api/git/diff GET
  const gitDiffReq = new NextRequest("http://localhost/api/git/diff?cwd=/tmp&path=/tmp/a.ts&engine=bad-engine");
  const gitDiffRes = await gitDiffGET(gitDiffReq);
  assert.equal(gitDiffRes.status, 400, "git diff GET 非法engine必须400");
});

test("反例5: 权限边界不扩大: Codex拒绝未配置目录，Pi仍拒绝未允许目录", async () => {
  // 1. Codex 拒绝未配置目录 (返回404)
  await assert.rejects(
    () => resolveCodexWorkspaceTarget("/unconfigured/arbitrary/path"),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    },
    "Codex拒绝未配置的工作区目录",
  );

  // 2. Pi 仍拒绝未允许目录 (403 Access denied)
  const piReq = new NextRequest("http://localhost/api/files/root/secret?type=list&engine=pi");
  const piRes = await filesGET(piReq, { params: Promise.resolve({ path: ["root", "secret"] }) });
  assert.equal(piRes.status, 403, "Pi必须拒绝未在白名单中的目录");
});

test("反例6: 前端文件tab同路径不同engine隔离，且切换不会拿当前backend替换来源", () => {
  const piTab = {
    id: "file:pi:/workspace/project/file.ts",
    label: "file.ts",
    filePath: "/workspace/project/file.ts",
    executionEngine: "pi",
    cwd: "/workspace/project",
    viewerRevision: 0,
  };

  const codexInput = {
    tabId: "file:codex:/workspace/project/file.ts",
    fileName: "file.ts",
    filePath: "/workspace/project/file.ts",
    executionEngine: "codex",
    cwd: "/wsl/remote/project",
  };

  // 相同 filePath，不同 engine，应当生成两个独立 tab，互不覆盖
  const tabs = openFileTab([piTab], codexInput);
  assert.equal(tabs.length, 2, "相同filePath不同engine应共存");
  assert.equal(tabs[0].executionEngine, "pi");
  assert.equal(tabs[1].executionEngine, "codex");
  assert.equal(tabs[0].cwd, "/workspace/project");
  assert.equal(tabs[1].cwd, "/wsl/remote/project");

  // 再次打开 piTab 时，不破坏原有 codexTab
  const piReopenInput = {
    tabId: "file:pi:/workspace/project/file.ts",
    fileName: "file.ts",
    filePath: "/workspace/project/file.ts",
    executionEngine: "pi",
    cwd: "/workspace/project",
  };
  const reopened = openFileTab(tabs, piReopenInput);
  assert.equal(reopened.length, 2);
  assert.equal(reopened[0].executionEngine, "pi");
  assert.equal(reopened[1].executionEngine, "codex");
});

test("反例7: file-tab-state: 显式sourceSessionId:null清除旧sid，undefined保留，cwd变化递增revision", () => {
  const initialTab = {
    id: "file:pi:/workspace/project/file.ts",
    label: "file.ts",
    filePath: "/workspace/project/file.ts",
    executionEngine: "pi",
    cwd: "/workspace/project",
    sourceSessionId: "session-123",
    viewerRevision: 0,
  };

  // 1. undefined 保持原有 sid (兼容语义)
  const retained = openFileTab([initialTab], {
    tabId: initialTab.id,
    fileName: initialTab.label,
    filePath: initialTab.filePath,
    sourceSessionId: undefined,
  });
  assert.equal(retained[0].sourceSessionId, "session-123");

  // 2. 显式 null 清除旧 sid
  const cleared = openFileTab([initialTab], {
    tabId: initialTab.id,
    fileName: initialTab.label,
    filePath: initialTab.filePath,
    sourceSessionId: null,
  });
  assert.equal(cleared[0].sourceSessionId, null);
  assert.equal(cleared[0].viewerRevision, 1);

  // 3. cwd 变化更新 cwd 并递增 viewerRevision
  const cwdChanged = openFileTab([initialTab], {
    tabId: initialTab.id,
    fileName: initialTab.label,
    filePath: initialTab.filePath,
    cwd: "/workspace/other-project",
  });
  assert.equal(cwdChanged[0].cwd, "/workspace/other-project");
  assert.equal(cwdChanged[0].viewerRevision, 1);
});
