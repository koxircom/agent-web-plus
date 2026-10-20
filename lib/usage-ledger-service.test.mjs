import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createUsageLedgerService } = await jiti.import("./usage-ledger-service.ts");
const ledger = { version: 2, generatedAt: "2026-10-01T00:00:00.000Z", snapshotId: "fixture", buckets: [] };
const envKeys = ["PI_USAGE_DATA_DIR", "PI_CODING_AGENT_DIR", "PI_SESSIONS_DIR"];

async function tempRoot(prefix) {
  return realpathSync(await mkdtemp(join(tmpdir(), prefix)));
}

function clearUsageEnv(t) {
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  t.after(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

async function createCentralStorage(dir, snapshot = ledger) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".pi-usage-storage.json"), JSON.stringify({ version: 1, instance: "nas" }));
  for (const name of [
    "pi-usage-events-nas.json",
    "pi-usage-ledger-nas.json",
    "pi-usage-ledger.json",
    "pi-usage-frozen-history.json",
  ]) {
    await writeFile(join(dir, name), name === "pi-usage-ledger.json" ? JSON.stringify(snapshot) : "{}");
  }
}

test("parallel missing-snapshot GETs generate one native ledger and reject a missing/invalid output", async (t) => {
  clearUsageEnv(t);
  const root = await tempRoot("pi-usage-service-singleflight-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "native-ledger.json");
  let calls = 0;
  const service = createUsageLedgerService({
    cwd: root,
    platform: "win32",
    resolveNativeLedgerPath: () => output,
    generate: async (source) => {
      calls += 1;
      assert.equal(source, "windows");
      await new Promise((resolve) => setTimeout(resolve, 15));
      await writeFile(output, JSON.stringify(ledger));
    },
  });

  const [first, second] = await Promise.all([service.get(), service.get()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, { ledger, mode: "native-local" });
  assert.deepEqual(second, first);
  assert.deepEqual(await service.post(), first, "an explicit native refresh calls the existing generator");
  assert.equal(calls, 2);

  await rm(output);
  const invalidService = createUsageLedgerService({
    cwd: root,
    platform: "win32",
    resolveNativeLedgerPath: () => output,
    generate: async () => { await writeFile(output, JSON.stringify({ version: 2, buckets: [{ role: "broken" }] })); },
  });
  await assert.rejects(invalidService.get(), /produced no valid snapshot/);
});

test("valid public or configured global snapshots preserve legacy-central mode and never trigger native generation", async (t) => {
  clearUsageEnv(t);
  const root = await tempRoot("pi-usage-service-central-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, "public");
  await mkdir(publicDir);
  await writeFile(join(publicDir, "pi-usage-ledger.json"), JSON.stringify(ledger));
  let calls = 0;
  const service = createUsageLedgerService({
    cwd: root,
    platform: "win32",
    resolveNativeLedgerPath: () => join(root, "native.json"),
    generate: async () => { calls += 1; },
  });
  assert.deepEqual(await service.get(), { ledger, mode: "legacy-central" });
  assert.deepEqual(await service.post(), { ledger, mode: "legacy-central" });
  assert.equal(calls, 0);

  const dataDir = join(root, "shared-storage");
  await createCentralStorage(dataDir);
  process.env.PI_USAGE_DATA_DIR = dataDir;
  assert.deepEqual(await service.get(), { ledger, mode: "legacy-central" });
  assert.equal(calls, 0);
});

test("configured invalid central storage fails closed without local generation", async (t) => {
  clearUsageEnv(t);
  const root = await tempRoot("pi-usage-service-invalid-central-");
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.PI_USAGE_DATA_DIR = join(root, "missing-storage");
  let calls = 0;
  const service = createUsageLedgerService({
    cwd: root,
    platform: "win32",
    resolveNativeLedgerPath: () => join(root, "native.json"),
    generate: async () => { calls += 1; },
  });
  await assert.rejects(service.get(), /PI_USAGE_DATA_DIR directory does not exist/);
  assert.equal(calls, 0);
});

test("the existing CLI generates and persists the Windows-native ledger once", async (t) => {
  clearUsageEnv(t);
  const root = await tempRoot("pi-usage-service-generator-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const scriptsDir = join(agentDir, "scripts");
  const sessionsDir = join(root, "sessions");
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SESSIONS_DIR = sessionsDir;

  const nativeLedger = join(scriptsDir, "pi-usage-ledger-windows.json");
  assert.equal(existsSync(join(process.cwd(), "public", "pi-usage-ledger.json")), false,
    "the test candidate has no static ledger that could mask the native CLI path");
  const service = createUsageLedgerService({
    cwd: process.cwd(),
    platform: "win32",
    resolveNativeLedgerPath: () => nativeLedger,
  });
  const first = await service.get();
  assert.equal(first.mode, "native-local");
  assert.equal(first.ledger.version, 2);
  assert.deepEqual(first.ledger.buckets, []);
  assert.ok((await readFile(join(scriptsDir, "pi-usage-events-windows.json"), "utf8")).length > 0,
    "the generator retains its existing per-source event state");
  const original = await readFile(nativeLedger, "utf8");
  const before = await stat(nativeLedger);
  assert.deepEqual(await service.get(), first);
  assert.equal(await readFile(nativeLedger, "utf8"), original, "a valid snapshot is reused without rescanning");
  assert.equal((await stat(nativeLedger)).mtimeMs, before.mtimeMs);
});
