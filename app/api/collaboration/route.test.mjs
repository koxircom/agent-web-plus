import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { CollaborationStore } = await import("../../../lib/collaboration-store.ts");

test("GET /api/collaboration: returns UI contract without internal tokens or UUIDs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-api-test-"));
  const origAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;

  try {
    const store = new CollaborationStore({ agentDir: tmpDir });
    await store.acquire({
      sessionId: "session-secret-999",
      sessionName: "Odoo 模块升级",
      ownerPid: process.pid,
      scope: "project",
      cwd: "/workspace/odoo",
      resources: ["odoo_pos"],
    });

    await store.acquire({
      sessionId: "session-waiter-888",
      ownerPid: process.pid,
      scope: "project",
      cwd: "/workspace/odoo",
      resources: ["odoo_pos"],
      reason: "等待前序测试完成",
      resumeTask: "继续自动化单测验收",
    });

    const response = await GET();
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.deepEqual(body.capabilities, {
      piAutoResume: true,
      codexAutoResume: false,
      scope: "instance",
      enforcement: "cooperative",
    });
    assert.ok(body.updatedAt);
    assert.ok(body.instanceLabel);

    assert.equal(body.resources.length, 1);
    const r = body.resources[0];
    assert.equal(r.label, "odoo_pos");
    assert.equal(r.status, "held");
    assert.equal(r.owner.title, "Odoo 模块升级");
    assert.equal(r.owner.token, undefined);
    assert.equal(r.owner.sessionId, undefined);

    assert.equal(r.queue.length, 1);
    const q = r.queue[0];
    assert.equal(q.title, "未命名会话（标题尚未生成）");
    assert.equal(q.reason, "等待前序测试完成");
    assert.equal(q.resumeTask, "继续自动化单测验收");
    assert.equal(q.sessionId, undefined);
  } finally {
    if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/collaboration: fail-closed HTTP 503 on corrupt store state", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-api-corrupt-"));
  const origAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;

  try {
    const stateFile = path.join(tmpDir, "state", "collaboration-locks.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{ broken json content");

    const response = await GET();
    assert.equal(response.status, 503);

    const body = await response.json();
    assert.match(body.error, /损坏或不可用/);
    assert.equal(body.stack, undefined, "Must not leak error stack");
  } finally {
    if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/collaboration: sanitizes UUID and S-number titles into fallback and does not leak internal tokens or sessions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-api-sanitize-"));
  const origAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;

  try {
    const store = new CollaborationStore({ agentDir: tmpDir });
    // UUID title
    await store.acquire({
      sessionId: "c18f92bd-1234-4567-8901-abcdefabcdef",
      sessionName: "c18f92bd-1234-4567-8901-abcdefabcdef",
      ownerPid: process.pid,
      scope: "instance",
      resources: ["sanitize_res"],
    });

    // S-number title in queue
    await store.acquire({
      sessionId: "session-s865",
      sessionName: "S865",
      ownerPid: process.pid,
      scope: "instance",
      resources: ["sanitize_res"],
      reason: "排队中",
    });

    const response = await GET();
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.resources.length, 1);
    const r = body.resources[0];

    // Verify UUID title sanitized
    assert.equal(r.owner.title, "未命名会话（标题尚未生成）");
    assert.equal(r.owner.token, undefined);
    assert.equal(r.owner.generation, undefined);
    assert.equal(r.owner.sessionId, undefined);

    // Verify S865 sanitized
    assert.equal(r.queue.length, 1);
    assert.equal(r.queue[0].title, "未命名会话（标题尚未生成）");
    assert.equal(r.queue[0].sessionId, undefined);
  } finally {
    if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
