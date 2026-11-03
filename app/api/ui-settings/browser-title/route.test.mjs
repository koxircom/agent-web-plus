import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const testAgentDir = await mkdtemp(path.join(os.tmpdir(), "pi-tab-title-route-test-"));
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
  moduleCache: false,
});

const { GET: getTitle, PUT: putTitle } = await jiti.import("./route.ts");
const { GET: getEvents } = await jiti.import("./events/route.ts");

function createPutRequest(body) {
  return new Request("http://localhost/api/ui-settings/browser-title", {
    method: "PUT",
    headers: { "Content-Type": "application/json", host: "localhost" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET returns default snapshot without initializing file", async () => {
  const req = new Request("http://localhost/api/ui-settings/browser-title", {
    headers: { host: "localhost" },
  });
  const res = await getTitle(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate, proxy-revalidate");
  const data = await res.json();
  assert.deepEqual(data, {
    version: 1,
    revision: 0,
    title: "",
    customTitle: "",
    appearance: null,
  });

  // 验证磁盘文件未被初始化创建
  const settingsPath = path.join(testAgentDir, "agent-web-settings.json");
  let exists = true;
  try {
    await readFile(settingsPath);
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "GET 请求不得初始化创建磁盘文件");
});

test("PUT rejects malformed body and type errors", async () => {
  // 非对象
  const resArray = await putTitle(createPutRequest([1, 2, 3]));
  assert.equal(resArray.status, 400);

  // 缺少 revision
  const resNoRev = await putTitle(createPutRequest({ title: "My Title" }));
  assert.equal(resNoRev.status, 400);

  // revision 非整数
  const resBadRev = await putTitle(createPutRequest({ title: "My Title", revision: "0" }));
  assert.equal(resBadRev.status, 400);
});

test("PUT rejects oversized, missing title, unknown fields, unsafe revision and cross-site writes", async () => {
  for (const body of [{ revision: 0 }, { title: null, revision: 0 }, { title: "x", revision: Number.MAX_SAFE_INTEGER + 1 }, { title: "x", revision: 0, other: true }]) {
    assert.equal((await putTitle(createPutRequest(body))).status, 400);
  }
  assert.equal((await putTitle(createPutRequest({ title: "x".repeat(5000), revision: 0 }))).status, 413);
  const req = new Request("http://localhost/api/ui-settings/browser-title", {
    method: "PUT", headers: { host: "localhost", origin: "https://untrusted.example", "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({title:"x",revision:0})
  });
  assert.equal((await putTitle(req)).status, 403);
});

test("PUT writes title, bumps revision, and detects 409 conflict", async () => {
  // 1. 初始 revision 为 0，写入新标题
  const res1 = await putTitle(createPutRequest({ title: "  My Workspace Tab  \n", revision: 0 }));
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.success, true);
  assert.equal(data1.version, 1);
  assert.equal(data1.revision, 1);
  assert.equal(data1.title, "  My Workspace Tab  ");
  assert.equal(data1.customTitle, "My Workspace Tab");

  // 2. 再次以旧 revision (0) 写入 -> 必须返回 409 Conflict，严禁 silent overwrite
  const conflictRes = await putTitle(createPutRequest({ title: "Stale Overwrite", revision: 0 }));
  assert.equal(conflictRes.status, 409);
  const conflictData = await conflictRes.json();
  assert.equal(conflictData.currentRevision, 1);
  assert.equal(conflictData.requestedRevision, 0);

  // 3. 以当前 revision (1) 写入
  const res2 = await putTitle(createPutRequest({ title: "Project Omega 🚀", revision: 1 }));
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.revision, 2);
  assert.equal(data2.title, "Project Omega 🚀");
  assert.equal(data2.customTitle, "Project Omega 🚀");
});

test("appearance round-trips with the title revision, rejects unsafe values and survives legacy title writes", async () => {
  const settingsPath=path.join(testAgentDir,"agent-web-settings.json");
  const original=await readFile(settingsPath);
  try {
  const req = () => new Request("http://localhost/api/ui-settings/browser-title", {headers:{host:"localhost"}});
  const current=await (await getTitle(req())).json();
  const appearance={titleTemplate:"{project} · {agent} · {text}",logoColor:"#ff6600",themeColor:"#112233"};
  const saved=await putTitle(createPutRequest({title:"正式",revision:current.revision,appearance}));assert.equal(saved.status,200);
  const ack=await saved.json();assert.deepEqual(ack.appearance,appearance);
  const stale=await putTitle(createPutRequest({title:"stale",revision:current.revision,appearance:null}));assert.equal(stale.status,409);
  for(const patch of [{themeColor:'red'},{logoColor:'" onload="bad'},{titleTemplate:'{unknown}'}])assert.equal((await putTitle(createPutRequest({title:"正式",revision:ack.revision,appearance:{...appearance,...patch}}))).status,400);
  assert.deepEqual((await (await getTitle(req())).json()).appearance,appearance);
  const legacy=await putTitle(createPutRequest({title:"legacy",revision:ack.revision}));assert.equal(legacy.status,200);const after=await legacy.json();assert.deepEqual(after.appearance,appearance);
  const reset=await putTitle(createPutRequest({title:"",revision:after.revision,appearance:null}));assert.equal(reset.status,200);assert.equal((await reset.json()).appearance,null);
  } finally {await writeFile(settingsPath,original);}
});

test("events GET returns SSE stream with initial data and updates on file change", async () => {
  const req = new Request("http://localhost/api/ui-settings/browser-title/events", {
    headers: { host: "localhost" },
  });
  const res = await getEvents(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // 读取初始推送
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  const text = decoder.decode(firstChunk.value);
  assert.ok(text.startsWith("data: "));
  const initialData = JSON.parse(text.replace(/^data:\s*/, "").trim());
  assert.equal(initialData.version, 1);
  assert.equal(initialData.revision, 2);
  assert.equal(initialData.customTitle, "Project Omega 🚀");

  // 触发一次新的 PUT 写入
  await putTitle(createPutRequest({ title: "Realtime SSE Title", revision: 2 }));

  // 等待 SSE 推送下一条数据
  let receivedNext = false;
  for (let i = 0; i < 10; i++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const chunkText = decoder.decode(chunk.value);
    if (chunkText.includes("Realtime SSE Title")) {
      receivedNext = true;
      const parsed = JSON.parse(chunkText.replace(/^data:\s*/, "").trim());
      assert.equal(parsed.revision, 3);
      assert.equal(parsed.customTitle, "Realtime SSE Title");
      break;
    }
  }
  assert.ok(receivedNext, "SSE 必须推送文件变更后的最新配置");

  // 取消并关闭 reader
  await reader.cancel();
});

test("events GET handles client abort and reader cancel cleanly without leaking watcher or timers", async () => {
  const abortController = new AbortController();
  const req = new Request("http://localhost/api/ui-settings/browser-title/events", {
    headers: { host: "localhost" },
    signal: abortController.signal,
  });

  const res = await getEvents(req);
  assert.equal(res.status, 200);

  const reader = res.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);

  // 触发 abort
  abortController.abort();

  // reader cancel 与 abort 能够正常退出
  await reader.cancel();
});

test("route returns fixed error string on failure without exposing physical path", async () => {
  // 1. 尝试修改被破坏的配置导致 500
  const settingsPath = path.join(testAgentDir, "agent-web-settings.json");
  await writeFile(settingsPath, "{ corrupt json }");

  const putReq = createPutRequest({ title: "Any", revision: 99 });
  const putRes = await putTitle(putReq);
  assert.equal(putRes.status, 500);
  const putData = await putRes.json();

  // 严禁包含真实物理路径
  assert.equal(putData.error, "Malformed agent web settings file (fail closed)");
  assert.ok(!JSON.stringify(putData).includes("/"), "错误信息不得泄漏服务器真实物理文件路径");

  const getReq = new Request("http://localhost/api/ui-settings/browser-title", {
    headers: { host: "localhost" },
  });
  const getRes = await getTitle(getReq);
  assert.equal(getRes.status, 500);
  const getData = await getRes.json();
  assert.equal(getData.error, "Malformed agent web settings file (fail closed)");
  assert.ok(!JSON.stringify(getData).includes("/"), "GET 错误信息不得泄漏物理路径");
});
