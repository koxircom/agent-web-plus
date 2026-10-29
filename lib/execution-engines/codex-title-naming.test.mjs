import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

test("title failures flow through the existing catalog and change its version on failure and recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "title-naming-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = directory;
  const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });
  const { listCodexSessions } = await jiti.import("./codex-engine.ts");
  const { saveExecutionEngineSettings } = await jiti.import("../execution-engine-settings.ts");
  const id = "12345678-1234-1234-1234-123456789abc";
  const failure = { status: "failed", message: "自动命名失败，稍后将自动重试" };
  let titleNaming = null;
  const response = body => ({ ok: true, status: 200, headers: { getSetCookie: () => ["sid=test"] }, json: async () => body });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/login") return response({});
    if (path === "/api/auth") return response({ authenticated: true, csrf: "fixture" });
    if (path === "/api/sessions") return response({ sessions: [{ id, title: "新聊天", cwd: "/fixture", recency: 1, titleNaming }] });
    if (path === "/api/activity") return response({ sessions: [{ id, status: "idle" }] });
    throw new Error("Unexpected path " + path);
  };
  try {
    await saveExecutionEngineSettings({ defaultEngine: "codex", codex: { enabled: true, url: "http://127.0.0.1:19097", username: "fixture", password: "fixture" } });
    const healthy = await listCodexSessions();
    titleNaming = failure;
    const failed = await listCodexSessions();
    assert.deepEqual(failed.sessions[0].titleNaming, failure);
    assert.notEqual(failed.sessionListVersion, healthy.sessionListVersion);
    titleNaming = null;
    const recovered = await listCodexSessions();
    assert.equal(recovered.sessions[0].titleNaming, null);
    assert.equal(recovered.sessionListVersion, healthy.sessionListVersion);
    assert.notEqual(recovered.sessionListVersion, failed.sessionListVersion);
    assert.equal(recovered.sessions[0].name, failed.sessions[0].name);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
