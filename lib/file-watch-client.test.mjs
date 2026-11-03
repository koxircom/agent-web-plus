import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, realpath, rm, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const sourceRoot = new URL("..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": sourceRoot.replace(/\/$/, ""),
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
  interopDefault: true,
});

const { FileWatchClient, buildWatchMetaUrl } = await jiti.import(join(sourceRoot, "lib/file-watch-client.ts"));
const { allowFileRoot } = await jiti.import(join(sourceRoot, "lib/file-access.ts"));
const { GET } = await jiti.import(join(sourceRoot, "app/api/files/[...path]/route.ts"));

const testDir = await realpath(await mkdtemp(join(tmpdir(), "file-watch-client-test-")));
allowFileRoot(testDir);

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function segmentsOf(p) {
  return p.split("/").filter(Boolean);
}

describe("FileWatchClient unit tests", () => {
  test("detects same-size edits via mtimeMs/ctimeMs fingerprints without missing updates", async () => {
    let callCount = 0;
    const history = [];

    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        // 初始读
        return {
          ok: true,
          status: 200,
          json: async () => ({
            exists: true,
            size: 10,
            mtimeMs: 1000,
            ctimeMs: 1000,
            ino: 101,
          }),
        };
      }
      if (callCount === 2) {
        // 同大小内容修改：size 依旧是 10，但 mtimeMs 变为 2000
        return {
          ok: true,
          status: 200,
          json: async () => ({
            exists: true,
            size: 10,
            mtimeMs: 2000,
            ctimeMs: 2000,
            ino: 101,
          }),
        };
      }
      // 无变化
      return {
        ok: true,
        status: 200,
        json: async () => ({
          exists: true,
          size: 10,
          mtimeMs: 2000,
          ctimeMs: 2000,
          ino: 101,
        }),
      };
    };

    let connectedCalled = 0;
    const client = new FileWatchClient({
      filePath: "/workspace/sample.txt",
      executionEngine: "pi",
      fetchFn: mockFetch,
      pollIntervalMs: 1000,
      onConnected: () => {
        connectedCalled++;
      },
      onChange: (fp, reason) => {
        history.push({ fp, reason });
      },
    });

    // 1. 首次 tick：connected + refresh
    await client.tick();
    assert.equal(connectedCalled, 1);
    assert.equal(history.length, 1);
    assert.equal(history[0].reason, "connected");
    assert.equal(history[0].fp.mtimeMs, 1000);

    // 2. 第二次 tick：同大小编辑被正确捕获为 modified
    await client.tick();
    assert.equal(history.length, 2);
    assert.equal(history[1].reason, "modified");
    assert.equal(history[1].fp.mtimeMs, 2000);
    assert.equal(history[1].fp.size, 10);

    // 3. 第三次 tick：指纹未改变，不产生多余的 onChange
    await client.tick();
    assert.equal(history.length, 2, "Unchanged fingerprint must not trigger onChange");

    client.close();
  });

  test("uses the exact remote version token when numeric timestamp fields are unchanged", async () => {
    const changes = [];
    const fingerprints = ["0:501:10:1000000001:1000000001", "0:501:10:1000000002:1000000002"];
    const client = new FileWatchClient({
      filePath: "/workspace/sample.txt",
      executionEngine: "codex",
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          exists: true, size: 10, mtimeMs: 1000, ctimeMs: 1000, ino: 501,
          version: fingerprints.shift(),
        }),
      }),
      onChange: (_fingerprint, reason) => changes.push(reason),
    });

    await client.tick();
    await client.tick();
    assert.deepEqual(changes, ["connected", "modified"]);
    client.close();
  });

  test("handles file deletion and subsequent recreation with inode/mtime changes", async () => {
    let step = 0;
    const history = [];

    const mockFetch = async () => {
      step++;
      if (step === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            exists: true,
            size: 15,
            mtimeMs: 1000,
            ctimeMs: 1000,
            ino: 501,
          }),
        };
      }
      if (step === 2) {
        // 文件被删除：404
        return {
          ok: false,
          status: 404,
          json: async () => ({
            exists: false,
            size: 0,
            mtimeMs: 0,
            ctimeMs: 0,
            ino: 0,
          }),
        };
      }
      if (step === 3) {
        // 文件被重建：相同大小但新 inode 和新时间
        return {
          ok: true,
          status: 200,
          json: async () => ({
            exists: true,
            size: 15,
            mtimeMs: 3000,
            ctimeMs: 3000,
            ino: 999,
          }),
        };
      }
    };

    const client = new FileWatchClient({
      filePath: "/workspace/doc.md",
      fetchFn: mockFetch,
      onChange: (fp, reason) => {
        history.push({ fp, reason });
      },
    });

    await client.tick();
    assert.equal(history.length, 1);
    assert.equal(history[0].reason, "connected");

    await client.tick();
    assert.equal(history.length, 2);
    assert.equal(history[1].reason, "deleted");
    assert.equal(history[1].fp.exists, false);

    await client.tick();
    assert.equal(history.length, 3);
    assert.equal(history[2].reason, "recreated");
    assert.equal(history[2].fp.exists, true);
    assert.equal(history[2].fp.ino, 999);

    client.close();
  });

  test("discards stale responses when session identity changes", async () => {
    let slowResolve;
    const slowPromise = new Promise((resolve) => {
      slowResolve = resolve;
    });

    let fetchCount = 0;
    const mockFetch = async (url) => {
      fetchCount++;
      if (url.includes("sessionId=session-A")) {
        await slowPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            exists: true,
            size: 100,
            mtimeMs: 100,
            ctimeMs: 100,
            ino: 1,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          exists: true,
          size: 200,
          mtimeMs: 200,
          ctimeMs: 200,
          ino: 2,
        }),
      };
    };

    const history = [];
    const client = new FileWatchClient({
      filePath: "/workspace/code.ts",
      sourceSessionId: "session-A",
      fetchFn: mockFetch,
      onChange: (fp, reason) => {
        history.push({ fp, reason });
      },
    });

    // 触发 session-A 的慢请求
    const tick1 = client.tick();

    // 切换到 session-B
    client.updateOptions({ sourceSessionId: "session-B" });

    // 让 session-A 的慢请求返回
    slowResolve();
    await tick1;

    // session-A 的响应必须被丢弃！
    assert.equal(history.length, 0, "Stale session-A response must be discarded");

    // 现在对 session-B 触发 tick
    await client.tick();
    assert.equal(history.length, 1);
    assert.equal(history[0].fp.size, 200);

    client.close();
  });

  test("closing or aborting eliminates late effects and cancels in-flight fetch", async () => {
    let aborted = false;
    let slowResolve;
    const slowPromise = new Promise((resolve) => {
      slowResolve = resolve;
    });

    const mockFetch = async (_url, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await slowPromise;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          exists: true,
          size: 50,
          mtimeMs: 500,
          ctimeMs: 500,
          ino: 10,
        }),
      };
    };

    let calledAfterClose = false;
    const client = new FileWatchClient({
      filePath: "/workspace/abort.txt",
      fetchFn: mockFetch,
      onChange: () => {
        calledAfterClose = true;
      },
      onConnected: () => {
        calledAfterClose = true;
      },
    });

    const pendingTick = client.tick();
    assert.equal(aborted, false);

    // 立即关闭
    client.close();
    assert.equal(aborted, true, "Active fetch signal must be aborted on close");

    slowResolve();
    await pendingTick;

    assert.equal(calledAfterClose, false, "No late effects should fire after close");
  });

  test("network failures do not falsely report file deletion", async () => {
    let shouldFail = false;
    const mockFetch = async () => {
      if (shouldFail) {
        throw new TypeError("Failed to fetch (network disconnected)");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          exists: true,
          size: 42,
          mtimeMs: 1234,
          ctimeMs: 1234,
          ino: 55,
        }),
      };
    };

    let disconnectedCount = 0;
    const history = [];

    const client = new FileWatchClient({
      filePath: "/workspace/network.txt",
      fetchFn: mockFetch,
      onDisconnected: () => {
        disconnectedCount++;
      },
      onChange: (fp, reason) => {
        history.push({ fp, reason });
      },
    });

    await client.tick();
    assert.equal(history.length, 1);
    assert.equal(history[0].fp.exists, true);

    // 模拟网络故障
    shouldFail = true;
    await client.tick();

    assert.equal(disconnectedCount, 1);
    // 关键断言：绝不假报 deleted！onChange 数量依然是 1
    assert.equal(history.length, 1, "Network failure must not emit a deleted change event");
    assert.equal(client.currentFingerprint?.exists, true, "Fingerprint must retain previous state");

    client.close();
  });

  test("an authorization or routing 404 is not treated as a deleted file", async () => {
    const changes = [];
    const errors = [];
    let calls = 0;
    const client = new FileWatchClient({
      filePath: "/workspace/private.txt",
      executionEngine: "codex",
      fetchFn: async () => ++calls === 1
        ? { ok: true, status: 200, json: async () => ({ exists: true, size: 4, mtimeMs: 1, ctimeMs: 1, ino: 2 }) }
        : { ok: false, status: 404, json: async () => ({ error: "Path is not authorized" }) },
      onChange: (_fingerprint, reason) => changes.push(reason),
      onError: error => errors.push(error.message),
    });

    await client.tick();
    await client.tick();
    assert.deepEqual(changes, ["connected"]);
    assert.deepEqual(errors, ["File watch failed: HTTP 404"]);
    assert.equal(client.currentFingerprint?.exists, true);
    client.close();
  });
});

describe("app/api/files watch-meta HTTP integration tests", () => {
  test("returns 200 with full fingerprint for existing file under allowed root", async () => {
    const file = join(testDir, "live-file.txt");
    await writeFile(file, "initial content 123");

    const url = `http://localhost/api/files/${encodeURIComponent(file.slice(1))}?type=watch-meta&engine=pi`;
    const request = new NextRequest(url);
    const response = await GET(request, { params: Promise.resolve({ path: segmentsOf(file) }) });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.exists, true);
    assert.equal(body.size, 19);
    assert.ok(typeof body.mtimeMs === "number" && body.mtimeMs > 0);
    assert.ok(typeof body.ctimeMs === "number" && body.ctimeMs > 0);
    assert.ok(typeof body.ino === "number" && body.ino > 0);
  });

  test("returns modified fingerprint when file content changes with same size", async () => {
    const file = join(testDir, "samesize.txt");
    await writeFile(file, "content AAA");
    const stat1 = await fs.promises.stat(file);

    // 等待 50ms 确保 mtimeMs 有微小变化
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(file, "content BBB");
    const stat2 = await fs.promises.stat(file);

    const url = `http://localhost/api/files/${encodeURIComponent(file.slice(1))}?type=watch-meta&engine=pi`;
    const response = await GET(new NextRequest(url), { params: Promise.resolve({ path: segmentsOf(file) }) });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.size, stat1.size);
    assert.equal(body.mtimeMs, stat2.mtimeMs);
    assert.notEqual(body.mtimeMs, stat1.mtimeMs);
  });

  test("returns 404 with exists: false when file is deleted", async () => {
    const file = join(testDir, "to-delete.txt");
    await writeFile(file, "temporary");
    await unlink(file);

    const url = `http://localhost/api/files/${encodeURIComponent(file.slice(1))}?type=watch-meta&engine=pi`;
    const response = await GET(new NextRequest(url), { params: Promise.resolve({ path: segmentsOf(file) }) });

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.deepEqual(body, {
      exists: false,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      ino: 0,
    });
  });

  test("directory watch-meta strictly fails with 400 Not a file", async () => {
    const subDir = join(testDir, "sub-directory");
    await mkdir(subDir, { recursive: true });

    const url = `http://localhost/api/files/${encodeURIComponent(subDir.slice(1))}?type=watch-meta&engine=pi`;
    const response = await GET(new NextRequest(url), { params: Promise.resolve({ path: segmentsOf(subDir) }) });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "Not a file");
  });

  test("unauthorized path is denied with 403", async () => {
    const forbidden = "/etc/shadow";
    const url = `http://localhost/api/files/${encodeURIComponent(forbidden.slice(1))}?type=watch-meta&engine=pi`;
    const response = await GET(new NextRequest(url), { params: Promise.resolve({ path: segmentsOf(forbidden) }) });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, "Access denied");
  });

  test("Codex watch-meta returns safe high-precision fingerprints, deletion and recreation", async (t) => {
    const agentDir = await mkdtemp(join(tmpdir(), "codex-watch-meta-agent-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(join(agentDir, "execution-engines.json"), JSON.stringify({
      defaultEngine: "pi",
      codex: { enabled: true, url: "http://codex-watch-meta.test", username: "fixture", password: "fixture" },
    }), { mode: 0o600 });

    const file = join(testDir, "codex-test.txt");
    await writeFile(file, "same-size-a");
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      const parsedUrl = new URL(String(url));
      requests.push(parsedUrl.pathname + parsedUrl.search);
      if (parsedUrl.pathname === "/api/login") {
        return {
          ok: true, status: 200,
          headers: { getSetCookie: () => ["session=fixture"] },
          json: async () => ({ csrf: "fixture" }),
        };
      }
      if (parsedUrl.pathname === "/api/auth") {
        return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ authenticated: true, csrf: "fixture" }) };
      }
      if (parsedUrl.pathname === "/api/projects") {
        return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ projects: [{ key: "fixture", name: "Fixture", cwd: testDir }] }) };
      }
      if (parsedUrl.pathname === "/api/projects/workspace") {
        const relativePath = parsedUrl.searchParams.get("path");
        const remotePath = join(testDir, relativePath);
        try {
          const stat = await fs.promises.stat(remotePath, { bigint: true });
          return {
            ok: true, status: 200, headers: { getSetCookie: () => [] },
            json: async () => ({
              kind: "file", size: Number(stat.size), sizeExact: String(stat.size), dev: String(stat.dev), ino: String(stat.ino),
              mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
            }),
          };
        } catch (error) {
          if (error.code === "ENOENT") {
            return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ kind: "missing" }) };
          }
          throw error;
        }
      }
      throw new Error(`Unexpected Codex bridge request: ${parsedUrl.pathname}`);
    });

    const getMeta = async (path) => GET(
      new NextRequest(`http://localhost/api/files/${encodeURIComponent(path.slice(1))}?type=watch-meta&engine=codex`),
      { params: Promise.resolve({ path: segmentsOf(path) }) },
    );
    try {
      const initialResponse = await getMeta(file);
      assert.equal(initialResponse.status, 200);
      const initial = await initialResponse.json();
      assert.equal(initial.exists, true);
      assert.equal(initial.size, 11);
      assert.match(initial.version, /^\d+:\d+:11:-?\d+:-?\d+$/);

      const before = await fs.promises.stat(file, { bigint: true });
      await writeFile(file, "same-size-b");
      await fs.promises.utimes(file, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9 + 1);
      const modifiedResponse = await getMeta(file);
      const modified = await modifiedResponse.json();
      assert.equal(modifiedResponse.status, 200);
      assert.notEqual(modified.version, initial.version);

      await unlink(file);
      const deletedResponse = await getMeta(file);
      assert.equal(deletedResponse.status, 404);
      assert.deepEqual(await deletedResponse.json(), { exists: false, size: 0, mtimeMs: 0, ctimeMs: 0, ino: 0 });

      await writeFile(file, "same-size-c");
      const recreatedResponse = await getMeta(file);
      const recreated = await recreatedResponse.json();
      assert.equal(recreatedResponse.status, 200);
      assert.notEqual(recreated.version, modified.version);

      const outsidePath = "/etc/hosts";
      const infoRequestCount = () => requests.filter((request) => new URL(`http://bridge${request}`).searchParams.get("operation") === "info").length;
      const beforeDenied = infoRequestCount();
      const denied = await getMeta(outsidePath);
      assert.equal(denied.status, 404);
      assert.equal(infoRequestCount(), beforeDenied, "an out-of-project path never reaches workspace info");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(agentDir, { recursive: true, force: true });
      await unlink(file).catch(() => {});
    }
  });
});
