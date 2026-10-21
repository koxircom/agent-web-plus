import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const routeSrc = readFileSync(new URL("./[id]/subagents/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": process.cwd(),
    "server-only": "next/dist/compiled/server-only/empty.js",
  },
  interopDefault: true,
  moduleCache: false,
});

const routeModule = await jiti.import("./[id]/subagents/route.ts");
const subagentsLib = await jiti.import("@/lib/execution-engines/codex-subagents");

test("subagents route validates method boundaries and disallows writes with 405", async () => {
  assert.match(routeSrc, /export async function GET/);
  assert.match(routeSrc, /export async function POST/);
  assert.match(routeSrc, /export async function PUT/);
  assert.match(routeSrc, /export async function DELETE/);
  assert.match(routeSrc, /status: 405/);
  assert.match(routeSrc, /Allow:\s*"GET"/);

  const postRes = await routeModule.POST();
  assert.equal(postRes.status, 405);
  const postBody = await postRes.json();
  assert.equal(postBody.error, "子智能体面板仅支持只读查看");

  const putRes = await routeModule.PUT();
  assert.equal(putRes.status, 405);

  const delRes = await routeModule.DELETE();
  assert.equal(delRes.status, 405);
});

test("subagents route rejects non-Codex sessions with 404", async () => {
  const req = new Request("http://localhost:30141/api/sessions/plain-pi-session-1234/subagents");
  const res = await routeModule.GET(req, {
    params: Promise.resolve({ id: "plain-pi-session-1234" }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "当前会话不支持 Codex 原生子智能体");
});

test("subagents lib rejects invalid or non-Codex identifiers before making bridge request", async () => {
  await assert.rejects(
    async () => {
      await subagentsLib.fetchCodexSubagents("not-a-codex-session");
    },
    {
      name: "Error",
      message: /非 Codex 会话不支持原生子智能体/,
    }
  );
});

test("subagents route enforces private no-store cache control headers", () => {
  assert.match(routeSrc, /Cache-Control":\s*"private,\s*no-store"/);
});
