import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createSubagentExtension } = await createJiti(import.meta.url).import("./subagent-extension.ts");

function run(status) {
  return { sessionId: "child", profile: "explore", description: "inspect", status,
    runInBackground: true, createdAt: "2026-01-01T00:00:00Z", result: status === "completed" ? "done" : undefined };
}

async function resultTool(get, consumed = []) {
  const tools = new Map();
  await createSubagentExtension({ get, markResultConsumed(id) { consumed.push(id); } }, () => []).factory({
    registerTool(tool) { tools.set(tool.name, tool); },
  });
  return tools.get("get_subagent_result");
}

test("queued child reports queued without consuming a result", async () => {
  const consumed = [];
  const tool = await resultTool(async () => run("queued"), consumed);
  const result = await tool.execute("call", { agent_id: "child" });
  assert.equal(result.content[0].text, "Subagent child is queued.");
  assert.equal(result.details.status, "queued");
  assert.deepEqual(consumed, []);
});

test("wait follows queued through running to terminal completion", async () => {
  const consumed = [];
  const states = ["queued", "running", "completed"];
  const tool = await resultTool(async () => run(states.shift() || "completed"), consumed);
  const result = await tool.execute("call", { agent_id: "child", wait: true });
  assert.equal(result.details.status, "completed");
  assert.match(result.content[0].text, /completed.*\n\ndone/);
  assert.deepEqual(consumed, ["child"]);
});

test("waiting on a queued child honors cancellation", async () => {
  const tool = await resultTool(async () => run("queued"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute("call", { agent_id: "child", wait: true }, controller.signal), /Result wait aborted/);
});
