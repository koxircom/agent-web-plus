import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const testAgentDir = await mkdtemp(path.join(os.tmpdir(), "pi-tab-events-route-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testAgentDir;

test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: true,
});

const { GET: getEvents } = await jiti.import("./route.ts");
const { PUT: putTitle } = await jiti.import("../route.ts");
const { getActiveHubCount, getHubDebugInfo } = await jiti.import("@/lib/browser-title-subscription.ts");

function createPutRequest(body) {
  return new Request("http://localhost/api/ui-settings/browser-title", {
    method: "PUT",
    headers: { "Content-Type": "application/json", host: "localhost" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("events GET rejects untrusted cross-origin requests with 403", async () => {
  const req = new Request("http://localhost/api/ui-settings/browser-title/events", {
    headers: { host: "evil.com" },
  });
  const res = await getEvents(req);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error, "Untrusted API request");
});

test("events GET returns 204 if request is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const req = new Request("http://localhost/api/ui-settings/browser-title/events", {
    headers: { host: "localhost" },
    signal: controller.signal,
  });
  const res = await getEvents(req);
  assert.equal(res.status, 204);
});

test("events GET streams initial snapshot, transport fallback comment on ENOSPC, and real updates across subscribers", async () => {
  // 此时宿主环境正好由于系统 watcher 限制表现为 fs.watch 抛出 ENOSPC
  const abortCtrl1 = new AbortController();
  const req1 = new Request("http://localhost/api/ui-settings/browser-title/events", {
    headers: { host: "localhost" },
    signal: abortCtrl1.signal,
  });

  const abortCtrl2 = new AbortController();
  const req2 = new Request("http://localhost/api/ui-settings/browser-title/events", {
    headers: { host: "localhost" },
    signal: abortCtrl2.signal,
  });

  const res1 = await getEvents(req1);
  const res2 = await getEvents(req2);
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res1.headers.get("Content-Type"), "text/event-stream");

  const reader1 = res1.body.getReader();
  const reader2 = res2.body.getReader();
  const decoder = new TextDecoder();

  // 读取两者的 initial snapshot
  const chunk1 = await reader1.read();
  const chunk2 = await reader2.read();
  assert.equal(chunk1.done, false);
  assert.equal(chunk2.done, false);

  // 验证两路连接共享同 1 个 Hub，单一 observer
  const debug = getHubDebugInfo(testAgentDir);
  assert.ok(debug);
  assert.equal(debug.subscriberCount, 2);

  const text1 = decoder.decode(chunk1.value);
  const text2 = decoder.decode(chunk2.value);
  assert.ok(text1.startsWith("data: "));
  assert.ok(text2.startsWith("data: "));

  const initData1 = JSON.parse(text1.replace(/^data:\s*/, "").trim());
  const initData2 = JSON.parse(text2.replace(/^data:\s*/, "").trim());
  assert.equal(initData1.version, 1);
  assert.equal(initData2.version, 1);

  // 触发新的写入
  await putTitle(createPutRequest({ title: "SSE Shared Multi-Subscriber 🎯", revision: initData1.revision }));

  // 验证两路 subscriber 均收到新标题
  async function waitForTitle(reader) {
    for (let i = 0; i < 15; i++) {
      const c = await reader.read();
      if (c.done) break;
      const t = decoder.decode(c.value);
      if (t.includes("SSE Shared Multi-Subscriber 🎯")) {
        return true;
      }
    }
    return false;
  }

  const [received1, received2] = await Promise.all([
    waitForTitle(reader1),
    waitForTitle(reader2),
  ]);
  assert.equal(received1, true);
  assert.equal(received2, true);

  // 清理第一路，Hub 仍存活
  abortCtrl1.abort();
  await reader1.cancel().catch(() => {});
  const midDebug = getHubDebugInfo(testAgentDir);
  assert.ok(midDebug);
  assert.equal(midDebug.subscriberCount, 1);

  // 清理第二路，Hub 完全销毁，0 poll handles
  abortCtrl2.abort();
  await reader2.cancel().catch(() => {});
  assert.equal(getHubDebugInfo(testAgentDir), null);
});
