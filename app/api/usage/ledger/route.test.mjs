import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const envName = "PI_USAGE_DATA_DIR";
const previousStorageDir = process.env[envName];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd(), "server-only": "next/dist/compiled/server-only/empty.js" } });
const { GET, POST } = await jiti.import("./route.ts");
const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-usage-ledger-route-")));
await mkdir(join(root, "agent"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const dataDir = join(root, "central");
await mkdir(dataDir);
await writeFile(join(dataDir, ".pi-usage-storage.json"), JSON.stringify({ version: 1, instance: "nas" }));
for (const name of [
  "pi-usage-events-nas.json",
  "pi-usage-ledger-nas.json",
  "pi-usage-ledger.json",
  "pi-usage-frozen-history.json",
]) {
  await writeFile(join(dataDir, name), name === "pi-usage-ledger.json"
    ? JSON.stringify({ version: 2, generatedAt: "2026-10-01T00:00:00.000Z", snapshotId: "route-fixture", buckets: [] })
    : "{}");
}

test("route exposes validated central ledger and mode on GET/POST", async () => {
  process.env[envName] = dataDir;
  const getResponse = await GET();
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("x-pi-usage-mode"), "legacy-central");
  assert.equal(getResponse.headers.get("cache-control"), "no-store");
  assert.equal((await getResponse.json()).snapshotId, "route-fixture");

  const postResponse = await POST();
  assert.equal(postResponse.status, 200);
  assert.equal(postResponse.headers.get("x-pi-usage-mode"), "legacy-central");
  assert.equal((await postResponse.json()).snapshotId, "route-fixture");
});

test("configured broken central storage returns an explicit error instead of fake empty data", async () => {
  process.env[envName] = join(root, "missing");
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await GET();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-pi-usage-mode"), "legacy-central");
    assert.deepEqual(await response.json(), { error: "未能获取到有效的账本快照数据" });
  } finally {
    console.error = originalError;
  }
});

test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousStorageDir === undefined) delete process.env[envName];
  else process.env[envName] = previousStorageDir;
  await rm(root, { recursive: true, force: true });
});
