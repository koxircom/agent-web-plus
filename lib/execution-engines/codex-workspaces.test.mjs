import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "codex-workspace-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (path === "/api/login") return Response.json({}, { headers: { "Set-Cookie": "fixture=1" } });
  if (path === "/api/auth") return Response.json({ authenticated: true, csrf: "fixture" });
  if (path === "/api/projects") return Response.json({ projects: [{ key: "fixture", cwd: "/home/wsl", name: "隔离工作区" }] });
  if (path === "/api/projects/worktrees") return Response.json({ projectRoot: "/home/wsl/remote/my-repo", isGit: true, worktrees: [] });
  if (path === "/api/projects/resolve") return Response.json({ error: "未授权目录" }, { status: 400 });
  if (path === "/api/projects/browse") return Response.json({ error: "未授权目录" }, { status: 400 });
  throw Error("Unexpected fixture request: " + path);
};
test.after(() => { globalThis.fetch = originalFetch; rmSync(sandbox, { recursive: true, force: true }); });

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd(), "server-only": "next/dist/compiled/server-only/empty.js" },
  interopDefault: true,
  moduleCache: false,
});

const settings = await jiti.import("@/lib/execution-engine-settings.ts");
await settings.saveExecutionEngineSettings({ codex: { enabled: true, url: "http://isolated.invalid" } });
const { GET: worktreesGET, POST: worktreesPOST, DELETE: worktreesDELETE } = await jiti.import("@/app/api/worktrees/route.ts");
const { GET: browseGET } = await jiti.import("@/app/api/cwd/browse/route.ts");
const { POST: validatePOST } = await jiti.import("@/app/api/cwd/validate/route.ts");
const { projectCodexSession } = await jiti.import("@/lib/execution-engines/codex-projection.ts");

test("worktrees GET routes engine=codex without consulting NAS local git or checkCwdAllowed", async () => {
  const fakeRemoteCwd = "/home/wsl/remote/my-repo";
  const req = new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(fakeRemoteCwd)}&engine=codex`);
  const res = await worktreesGET(req);
  assert.notEqual(res.status, 403, "Should not hit NAS allowlist 403");
});

test("worktrees POST routes engine=codex directly without NAS allowlist", async () => {
  const req = new Request("http://localhost/api/worktrees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: "/home/wsl/remote/my-repo",
      branch: "feat-test",
      engine: "codex",
    }),
  });
  const res = await worktreesPOST(req);
  assert.notEqual(res.status, 403, "Should not hit NAS allowlist 403");
});

test("worktrees DELETE fails closed with 405 for engine=codex", async () => {
  const req = new Request("http://localhost/api/worktrees", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: "/home/wsl/remote/my-repo",
      path: "/home/wsl/remote/my-repo-worktrees/feat-test",
      engine: "codex",
    }),
  });
  const res = await worktreesDELETE(req);
  assert.equal(res.status, 405);
  const data = await res.json();
  assert.match(data.error, /不支持通过网页删除工作树/);
});

test("codex projection session preserves custom worktree cwd and groups by projectRoot", () => {
  const session = projectCodexSession({
    id: "session-1",
    title: "Worktree 聊天",
    cwd: "/home/wsl/project/worktrees/feature-x",
    projectRoot: "/home/wsl/project",
    projectKey: "local|project",
  });
  assert.equal(session.cwd, "/home/wsl/project/worktrees/feature-x");
  assert.equal(session.projectRoot, "/home/wsl/project");
  assert.equal(session.projectKey, "codex:/home/wsl/project");
});

test("codex projection directories returns root list when path is empty or slash", async () => {
  const req = new Request("http://localhost/api/cwd/browse?engine=codex&path=/");
  const res = await browseGET(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.parentPath, null);
  assert.ok(Array.isArray(data.directories));
});

test("codex cwd validate rejects non-configured path", async () => {
  const req = new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: "/etc/forbidden-directory-that-does-not-exist",
      engine: "codex",
    }),
  });
  const res = await validatePOST(req);
  assert.equal(res.status, 400);
});

test("codex cwd browse transmits real error instead of silent fallback", async () => {
  const req = new Request("http://localhost/api/cwd/browse?engine=codex&path=/nonexistent/forbidden/path");
  const res = await browseGET(req);
  // Must NOT succeed with a fake directory list
  assert.notEqual(res.status, 200, "Browse error must not be silenced into 200");
  const data = await res.json();
  assert.ok(data.error, "Browse failure must return explicit error");
});
