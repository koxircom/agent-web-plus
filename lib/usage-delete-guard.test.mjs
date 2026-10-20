import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const pkgRoot = process.cwd();
const binGuardDir = path.join(pkgRoot, "bin", "usage-guard");

const cjsGuard = require(path.join(binGuardDir, "pi-usage-delete-guard.cjs"));
const { readState, buildLedger } = require(path.join(binGuardDir, "generate-usage-ledger.js"));
const storagePaths = require(path.join(binGuardDir, "usage-storage-paths.cjs"));

const jiti = createJiti(import.meta.url, {
  alias: { "@": pkgRoot, "server-only": "next/dist/compiled/server-only/empty.js" },
  interopDefault: true,
  moduleCache: false,
});

const tsGuard = await jiti.import("./usage-delete-guard.ts");
const { DELETE: deleteSessionRoute, GET: getSessionRoute } = await jiti.import("../app/api/sessions/[id]/route.ts");
const {
  cacheSessionPath,
  openSessionManager,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
} = await jiti.import("./session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

function createSandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-guard-test-"));
  const sessionsDir = path.join(base, "sessions");
  const dataDir = path.join(base, "data");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, "pi-usage-events-test.json");
  const outputFile = path.join(dataDir, "pi-usage-ledger-test.json");

  const prevUsageDataDir = process.env.PI_USAGE_DATA_DIR;
  delete process.env.PI_USAGE_DATA_DIR;

  t.after(() => {
    if (prevUsageDataDir === undefined) {
      delete process.env.PI_USAGE_DATA_DIR;
    } else {
      process.env.PI_USAGE_DATA_DIR = prevUsageDataDir;
    }
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  return { base, sessionsDir, dataDir, stateFile, outputFile };
}

function makeSessionFile(filePath, sessionId, entries = [], headerExtra = {}) {
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-09-20T12:00:00.000Z",
    cwd: path.dirname(filePath),
    name: `Session ${sessionId}`,
    ...headerExtra,
  };
  const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

test("package layout and bin/usage-guard portability invariants", () => {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkgJson.files) && pkgJson.files.includes("bin"), "package.json files must include bin");
  assert.ok(
    pkgJson.dependencies && pkgJson.dependencies["@earendil-works/pi-coding-agent"],
    "@earendil-works/pi-coding-agent must be a declared dependency",
  );

  const resolvedBin = tsGuard.resolveUsageGuardBinDir();
  assert.equal(path.resolve(resolvedBin), path.resolve(binGuardDir));

  const requiredFiles = [
    "pi-usage-delete-guard.cjs",
    "pi-usage-seal-worker.cjs",
    "usage-storage-paths.cjs",
    "generate-usage-ledger.js",
    "usage-ledger-core.js",
  ];
  for (const name of requiredFiles) {
    const fullPath = path.join(resolvedBin, name);
    assert.equal(fs.existsSync(fullPath), true, `Missing required file in bin/usage-guard: ${name}`);
    const check = spawnSync(process.execPath, ["--check", fullPath], { encoding: "utf8" });
    assert.equal(check.status, 0, `Syntax check failed for ${name}: ${check.stderr}`);
  }

  // Missing or incomplete custom root must fail closed
  assert.throws(
    () => tsGuard.resolveUsageGuardBinDir(path.join(os.tmpdir(), "non-existent-pi-web-root")),
    /Incomplete or missing usage-guard bin directory/,
  );

  // Missing any single required script in bin/usage-guard must fail closed
  const tempPkg = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-incomplete-pkg-"));
  try {
    const tempGuardBin = path.join(tempPkg, "bin", "usage-guard");
    fs.mkdirSync(tempGuardBin, { recursive: true });
    for (const name of requiredFiles) {
      fs.copyFileSync(path.join(binGuardDir, name), path.join(tempGuardBin, name));
    }
    for (const missingName of requiredFiles) {
      const targetFile = path.join(tempGuardBin, missingName);
      const backupContent = fs.readFileSync(targetFile);
      fs.unlinkSync(targetFile);
      assert.throws(
        () => tsGuard.resolveUsageGuardBinDir(tempPkg),
        /Incomplete or missing usage-guard bin directory/,
        `Must fail closed when ${missingName} is missing`,
      );
      assert.throws(
        () => tsGuard.loadUsageDeleteGuard(tempPkg),
        /Incomplete or missing usage-guard bin directory/,
        `loadUsageDeleteGuard must fail closed when ${missingName} is missing`,
      );
      fs.writeFileSync(targetFile, backupContent);
    }

    // Verify cwd-independent resolution when process.cwd() is an arbitrary empty directory
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-empty-cwd-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(emptyCwd);
      assert.equal(path.resolve(tsGuard.resolveUsageGuardBinDir()), path.resolve(binGuardDir));
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempPkg, { recursive: true, force: true });
  }
});

test("multi-target seal and delete transaction + idempotent re-scan", (t) => {
  const { sessionsDir, stateFile, outputFile } = createSandbox(t);

  const s1Id = "session-main-1";
  const s1Path = path.join(sessionsDir, `${s1Id}.jsonl`);
  makeSessionFile(s1Path, s1Id, [
    { type: "model_change", provider: "openai", modelId: "gpt-5.6-sol" },
    {
      type: "message",
      id: "msg-1",
      timestamp: 1789900000000,
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.6-sol",
        content: "Hello from main",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: 0.005 },
      },
    },
  ]);

  const s2Id = "session-subagent-2";
  const s2Path = path.join(sessionsDir, `${s2Id}.jsonl`);
  makeSessionFile(s2Path, s2Id, [
    { type: "model_change", provider: "openai", modelId: "gpt-5.6-sol" },
    {
      type: "message",
      id: "msg-ctrl",
      timestamp: 1789900000010,
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.6-sol",
        content: [{ type: "toolCall", id: "call-1", name: "subagent" }],
      },
    },
    {
      type: "message",
      id: "msg-result",
      timestamp: 1789900000020,
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "subagent",
        details: {
          results: [
            {
              agent: "gemini-flash-worker",
              model: "cliproxyapi/gemini-3.8-flash-high",
              usage: { input: 200, output: 80, cacheRead: 20, cacheWrite: 0, cost: 0.002, turns: 1 },
              messages: [
                {
                  role: "assistant",
                  timestamp: 1789900000015,
                  usage: { input: 200, output: 80, cacheRead: 20, cacheWrite: 0, cost: 0.002 },
                },
              ],
            },
          ],
        },
      },
    },
  ]);

  const s1Bytes = fs.readFileSync(s1Path);
  const s2Bytes = fs.readFileSync(s2Path);

  const targets = new Map([
    [s1Id, s1Path],
    [s2Id, s2Path],
  ]);

  const callbacks = [];
  const res = tsGuard.sealAndDeleteSync(
    targets,
    (id, filePath) => callbacks.push({ id, filePath }),
    {
      sessionsRoot: sessionsDir,
      stateFile,
      outputFile,
      source: "test-source",
    },
  );

  t.after(() => {
    tsGuard.deletedPaths.delete(path.resolve(s1Path));
    tsGuard.deletedPaths.delete(path.resolve(s2Path));
  });

  assert.equal(res.ok, true);
  assert.equal(res.deletedCount, 2);
  assert.deepEqual(
    callbacks.map((c) => c.id),
    [s1Id, s2Id],
  );
  assert.equal(fs.existsSync(s1Path), false);
  assert.equal(fs.existsSync(s2Path), false);
  assert.equal(tsGuard.isPathDeleted(s1Path), true);
  assert.equal(tsGuard.isPathDeleted(s2Path), true);

  const state = readState(stateFile);
  assert.equal(state.sessions[s1Id].ingestion.complete, true);
  assert.equal(state.sessions[s2Id].ingestion.complete, true);

  const ledger = buildLedger(state);
  assert.equal(ledger.totals.totalTokens, 460);
  assert.equal(ledger.totals.inputTokens, 300);
  assert.equal(ledger.totals.outputTokens, 130);
  assert.equal(ledger.totals.calls, 1);

  // Restore files and re-run to verify idempotent deduplication
  fs.writeFileSync(s1Path, s1Bytes);
  fs.writeFileSync(s2Path, s2Bytes);
  const resSecond = tsGuard.sealAndDeleteSync(targets, null, {
    sessionsRoot: sessionsDir,
    stateFile,
    outputFile,
    source: "test-source",
  });
  assert.equal(resSecond.ok, true);
  assert.equal(resSecond.deletedCount, 2);

  const ledgerSecond = buildLedger(readState(stateFile));
  assert.equal(ledgerSecond.totals.totalTokens, 460);
  assert.equal(ledgerSecond.totals.calls, 1);
});

test("failure scenarios guarantee zero unlinks and fail closed", async (t) => {
  await t.test("lock busy by live process fails closed with 0 unlinks", (subT) => {
    const { sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sId = "session-lock-busy";
    const sPath = path.join(sessionsDir, `${sId}.jsonl`);
    makeSessionFile(sPath, sId, []);

    const lockFile = `${stateFile}.lock`;
    // Use current live process.pid so lock is recognized as held by an active process
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: Date.now() }), "utf8");

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([[sId, sPath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
          lockTimeoutMs: 250,
        }),
      /Seal worker execution failed/,
    );

    assert.equal(fs.existsSync(sPath), true, "Source file must remain when lock acquisition fails");
    assert.equal(tsGuard.isPathDeleted(sPath), false);
    assert.equal(fs.existsSync(lockFile), true, "Active foreign lock must not be removed");
  });

  await t.test("truncated partial JSONL line fails closed with 0 unlinks", (subT) => {
    const { sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const s1Id = "session-valid";
    const s1Path = path.join(sessionsDir, `${s1Id}.jsonl`);
    makeSessionFile(s1Path, s1Id, []);

    const s2Id = "session-truncated";
    const s2Path = path.join(sessionsDir, `${s2Id}.jsonl`);
    fs.writeFileSync(
      s2Path,
      `${JSON.stringify({ type: "session", id: s2Id, timestamp: "2026-09-20T12:00:00.000Z" })}\n{"type":"message","incomplete":`,
      "utf8",
    );

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(
          new Map([
            [s1Id, s1Path],
            [s2Id, s2Path],
          ]),
          null,
          {
            sessionsRoot: sessionsDir,
            stateFile,
            outputFile,
            source: "test-source",
          },
        ),
      /Session ingestion incomplete/,
    );

    // Multi-target guarantee: neither s1 nor s2 may be unlinked if any target fails seal
    assert.equal(fs.existsSync(s1Path), true);
    assert.equal(fs.existsSync(s2Path), true);
    assert.equal(tsGuard.isPathDeleted(s1Path), false);
    assert.equal(tsGuard.isPathDeleted(s2Path), false);
  });

  await t.test("pending toolCalls when sealForDelete=false fails closed with 0 unlinks", (subT) => {
    const { sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sId = "session-pending-tool";
    const sPath = path.join(sessionsDir, `${sId}.jsonl`);
    makeSessionFile(sPath, sId, [
      {
        type: "message",
        id: "m1",
        timestamp: Date.now(),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-pending", name: "bash" }],
        },
      },
    ]);

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([[sId, sPath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
          sealForDelete: false,
        }),
      /Session ingestion incomplete/,
    );

    assert.equal(fs.existsSync(sPath), true);
  });

  await t.test("target outside sessionsRoot is rejected with 0 unlinks", (subT) => {
    const { base, sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sId = "session-outside";
    const outsidePath = path.join(base, "outside.jsonl");
    makeSessionFile(outsidePath, sId, []);

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([[sId, outsidePath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
        }),
      /Target outside sessionsRoot/,
    );

    assert.equal(fs.existsSync(outsidePath), true);
  });

  await t.test("leaf symbolic link target is rejected with 0 unlinks", (subT) => {
    const { sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sId = "session-symlink";
    const realPath = path.join(sessionsDir, `${sId}-real.jsonl`);
    const linkPath = path.join(sessionsDir, `${sId}.jsonl`);
    makeSessionFile(realPath, sId, []);
    fs.symlinkSync(realPath, linkPath);

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([[sId, linkPath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
        }),
      /Leaf symbolic link rejected/,
    );

    assert.equal(fs.existsSync(linkPath), true);
    assert.equal(fs.existsSync(realPath), true);
  });

  await t.test("session header ID mismatch is rejected with 0 unlinks", (subT) => {
    const { sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sPath = path.join(sessionsDir, "mismatch.jsonl");
    makeSessionFile(sPath, "actual-header-id", []);

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([["requested-id", sPath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
        }),
      /Session header mismatch/,
    );

    assert.equal(fs.existsSync(sPath), true);
  });

  await t.test("parent process fingerprint re-verification blocks tampered sha256/stat before unlink", (subT) => {
    const { base, sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sId = "session-tamper";
    const sPath = path.join(sessionsDir, `${sId}.jsonl`);
    makeSessionFile(sPath, sId, []);

    const mockWorkerPath = path.join(base, "mock-worker.cjs");
    fs.writeFileSync(
      mockWorkerPath,
      `"use strict";
      const fs = require("node:fs");
      const raw = JSON.parse(fs.readFileSync(0, "utf8"));
      const t = raw.targets[0];
      const stat = fs.statSync(t.path);
      process.stdout.write(JSON.stringify({
        ok: true,
        version: 1,
        targets: {
          [t.sessionId]: {
            path: t.path,
            sha256: "0".repeat(64),
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs
          }
        }
      }));
      `,
      "utf8",
    );

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([[sId, sPath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
          workerScript: mockWorkerPath,
        }),
      /Source file hash changed before unlink/,
    );

    assert.equal(fs.existsSync(sPath), true);
    assert.equal(tsGuard.isPathDeleted(sPath), false);
  });

  await t.test("worker timeout cleans up worker's own lock without touching foreign locks", (subT) => {
    const { base, sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sId = "session-timeout";
    const sPath = path.join(sessionsDir, `${sId}.jsonl`);
    makeSessionFile(sPath, sId, []);

    const mockTimeoutWorker = path.join(base, "mock-timeout-worker.cjs");
    fs.writeFileSync(
      mockTimeoutWorker,
      `"use strict";
      const fs = require("node:fs");
      const raw = JSON.parse(fs.readFileSync(0, "utf8"));
      fs.writeFileSync(raw.stateFile + ".lock", JSON.stringify({ pid: process.pid, time: Date.now() }));
      setTimeout(() => {}, 10000);
      `,
      "utf8",
    );

    const lockFile = `${stateFile}.lock`;
    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([[sId, sPath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
          workerScript: mockTimeoutWorker,
          timeout: 120,
        }),
      /Seal worker execution failed/,
    );

    assert.equal(fs.existsSync(lockFile), false, "Worker's own lock must be cleaned up after timeout");
    assert.equal(fs.existsSync(sPath), true);
  });

  await t.test("missing worker script fails closed and never degrades to unguarded unlink", (subT) => {
    const { base, sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const sId = "session-no-worker";
    const sPath = path.join(sessionsDir, `${sId}.jsonl`);
    makeSessionFile(sPath, sId, []);

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(new Map([[sId, sPath]]), null, {
          sessionsRoot: sessionsDir,
          stateFile,
          outputFile,
          source: "test-source",
          workerScript: path.join(base, "missing-worker.cjs"),
        }),
      /Seal worker script not found/,
    );

    assert.equal(fs.existsSync(sPath), true);
  });

  await t.test("partial unlink failure keeps deleted files in tombstone and releases remaining targets", (subT) => {
    const { sessionsDir, stateFile, outputFile } = createSandbox(subT);
    const s1 = "session-tomb-1";
    const s2 = "session-tomb-2";
    const s3 = "session-tomb-3";
    const p1 = path.join(sessionsDir, `${s1}.jsonl`);
    const p2 = path.join(sessionsDir, `${s2}.jsonl`);
    const p3 = path.join(sessionsDir, `${s3}.jsonl`);
    makeSessionFile(p1, s1, []);
    makeSessionFile(p2, s2, []);
    makeSessionFile(p3, s3, []);

    const origUnlinkSync = fs.unlinkSync;
    subT.after(() => {
      fs.unlinkSync = origUnlinkSync;
      cjsGuard.deletedPaths.delete(path.resolve(p1));
      cjsGuard.deletedPaths.delete(path.resolve(p2));
      cjsGuard.deletedPaths.delete(path.resolve(p3));
    });

    fs.unlinkSync = function patchedUnlink(targetPath) {
      if (path.resolve(targetPath) === path.resolve(p2)) {
        const err = new Error("Simulated EPERM on p2");
        err.code = "EPERM";
        throw err;
      }
      return origUnlinkSync.call(this, targetPath);
    };

    assert.throws(
      () =>
        tsGuard.sealAndDeleteSync(
          new Map([
            [s1, p1],
            [s2, p2],
            [s3, p3],
          ]),
          null,
          {
            sessionsRoot: sessionsDir,
            stateFile,
            outputFile,
            source: "test-source",
          },
        ),
      /File deletion failed/,
    );

    fs.unlinkSync = origUnlinkSync;
    assert.equal(fs.existsSync(p1), false);
    assert.equal(tsGuard.isPathDeleted(p1), true);
    assert.equal(fs.existsSync(p2), true);
    assert.equal(fs.existsSync(p3), true);
    assert.equal(tsGuard.isPathDeleted(p2), false);
    assert.equal(tsGuard.isPathDeleted(p3), false);
  });
});

test("SDK SessionManager _persist and _rewriteFile never resurrect deleted session files", (t) => {
  const { sessionsDir, stateFile, outputFile } = createSandbox(t);
  const deletedFile = path.join(sessionsDir, "deleted-sm.jsonl");
  const normalFile = path.join(sessionsDir, "normal-sm.jsonl");
  makeSessionFile(deletedFile, "deleted-sm", []);
  makeSessionFile(normalFile, "normal-sm", []);

  const deletedSm = SessionManager.open(deletedFile);
  const normalSm = SessionManager.open(normalFile);

  const res = tsGuard.sealAndDeleteSync(new Map([["deleted-sm", deletedFile]]), null, {
    sessionsRoot: sessionsDir,
    stateFile,
    outputFile,
    source: "test-source",
  });
  t.after(() => {
    tsGuard.deletedPaths.delete(path.resolve(deletedFile));
  });

  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(deletedFile), false);

  assert.throws(() => {
    deletedSm._persist({ type: "message", id: "m1", message: { role: "user", content: "late write" } });
  }, /cannot persist to deleted session file/i);

  assert.throws(() => {
    deletedSm._rewriteFile();
  }, /cannot rewrite deleted session file/i);

  assert.equal(fs.existsSync(deletedFile), false, "Deleted session JSONL must never be resurrected on disk");

  assert.doesNotThrow(() => {
    normalSm._persist({ type: "message", id: "m2", message: { role: "user", content: "normal write" } });
  });
  assert.doesNotThrow(() => {
    normalSm._rewriteFile();
  });
});

test("cross-platform environment portability without /root/.pi/agent/scripts existing", (t) => {
  const { base } = createSandbox(t);
  const isolatedHome = path.join(base, "isolated-home");
  const isolatedAgentDir = path.join(isolatedHome, ".pi", "agent");
  const isolatedSessionsDir = path.join(isolatedAgentDir, "sessions");
  fs.mkdirSync(isolatedSessionsDir, { recursive: true });

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevSessionsDir = process.env.PI_SESSIONS_DIR;

  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  delete process.env.PI_SESSIONS_DIR;

  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = prevSessionsDir;
  });

  // Verify scripts dir does NOT exist beforehand
  const expectedLedgerDir = path.join(isolatedAgentDir, "scripts");
  assert.equal(fs.existsSync(expectedLedgerDir), false);

  const sId = "portable-session-1";
  const sPath = path.join(isolatedSessionsDir, `${sId}.jsonl`);
  makeSessionFile(sPath, sId, [
    {
      type: "message",
      id: "m1",
      timestamp: 1789900000000,
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-6-astra",
        content: "portable check",
        usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
      },
    },
  ]);

  t.after(() => {
    tsGuard.deletedPaths.delete(path.resolve(sPath));
  });

  const res = tsGuard.sealAndDeleteSync(new Map([[sId, sPath]]));
  assert.equal(res.ok, true);
  assert.equal(res.deletedCount, 1);
  assert.equal(fs.existsSync(sPath), false);

  const expectedSource = process.platform === "win32" ? "windows" : "nas";
  const expectedStateFile = path.join(expectedLedgerDir, `pi-usage-events-${expectedSource}.json`);
  const expectedOutputFile = path.join(expectedLedgerDir, `pi-usage-ledger-${expectedSource}.json`);
  assert.equal(fs.existsSync(expectedStateFile), true);
  assert.equal(fs.existsSync(expectedOutputFile), true);
  assert.equal(buildLedger(readState(expectedStateFile)).totals.totalTokens, 50);
  assert.equal(storagePaths.resolveAgentDir(), path.resolve(isolatedAgentDir));
});

test("native route.ts integration: cascade delete, reparent, cache invalidation, and seal failure atomicity", async (t) => {
  const { base } = createSandbox(t);
  const agentDir = path.join(base, "agent");
  const sessionsRoot = path.join(agentDir, "sessions");
  const projectSessionsDir = path.join(sessionsRoot, "project-a");
  fs.mkdirSync(projectSessionsDir, { recursive: true });

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevSessionsDir = process.env.PI_SESSIONS_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SESSIONS_DIR = sessionsRoot;
  invalidateSessionListCache();

  t.after(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = prevSessionsDir;
    invalidateSessionListCache();
  });

  // 1. Setup grandparent, parent, subagent child, and forked sibling child
  const grandparentId = "gp-session-100";
  const parentId = "parent-session-200";
  const subChildId = "subchild-session-300";
  const forkChildId = "forkchild-session-400";

  const grandparentPath = path.join(projectSessionsDir, `20260920_${grandparentId}.jsonl`);
  const parentPath = path.join(projectSessionsDir, `20260920_${parentId}.jsonl`);
  const subChildPath = path.join(projectSessionsDir, `20260920_${subChildId}.jsonl`);
  const forkChildPath = path.join(projectSessionsDir, `20260920_${forkChildId}.jsonl`);

  makeSessionFile(grandparentPath, grandparentId, []);
  makeSessionFile(
    parentPath,
    parentId,
    [
      {
        type: "message",
        id: "p-msg-1",
        parentId: null,
        timestamp: "2026-09-20T12:00:01.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-6-astra",
          timestamp: 1789905601000,
          content: [{ type: "text", text: "parent response" }],
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } },
        },
      },
    ],
    { parentSession: grandparentPath },
  );
  makeSessionFile(
    subChildPath,
    subChildId,
    [
      {
        type: "custom",
        customType: "pi-web:subagent",
        id: "sub-meta",
        parentId: null,
        timestamp: "2026-09-20T12:00:02.000Z",
        data: {
          version: 1,
          parentSessionId: parentId,
          parentSessionPath: parentPath,
          profile: "Explore",
          description: "Subagent task",
        },
      },
      {
        type: "message",
        id: "sub-msg-1",
        parentId: "sub-meta",
        timestamp: "2026-09-20T12:00:03.000Z",
        message: {
          role: "assistant",
          provider: "cliproxyapi",
          model: "gemini-3.8-flash-high",
          timestamp: 1789905603000,
          content: [{ type: "text", text: "subagent reply" }],
          usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0005 } },
        },
      },
    ],
    { parentSession: parentPath },
  );
  makeSessionFile(forkChildPath, forkChildId, [], { parentSession: parentPath });

  cacheSessionPath(grandparentId, grandparentPath);
  cacheSessionPath(parentId, parentPath);
  cacheSessionPath(subChildId, subChildPath);
  cacheSessionPath(forkChildId, forkChildPath);

  // Populate SessionManager read-only cache for parent and subChild
  openSessionManager(parentPath);
  openSessionManager(subChildPath);
  assert.equal(globalThis.__piSessionPathCache?.has(parentId), true);
  assert.equal(globalThis.__piSessionPathCache?.has(subChildId), true);
  assert.ok((globalThis.__piSmCache?.size ?? 0) >= 2);

  // Verify GET includes usageDeleteGuard version
  const getRes = await getSessionRoute(
    new Request(`http://localhost/api/sessions/${parentId}`),
    { params: Promise.resolve({ id: parentId }) },
  );
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  assert.equal(getBody.usageDeleteGuard, 1);

  // 2. First simulate a broken subagent child (truncated line) and verify 0 files are unlinked
  const validSubChildContent = fs.readFileSync(subChildPath, "utf8");
  fs.appendFileSync(subChildPath, '{"type":"message","broken":');

  const failedDeleteRes = await deleteSessionRoute(
    new Request(`http://localhost/api/sessions/${parentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parentId }) },
  );
  assert.equal(failedDeleteRes.status, 500);
  const failedBody = await failedDeleteRes.json();
  assert.match(failedBody.error, /ingestion incomplete/);
  assert.equal(fs.existsSync(parentPath), true, "Parent must NOT be unlinked when child seal fails");
  assert.equal(fs.existsSync(subChildPath), true, "Child must NOT be unlinked when child seal fails");
  assert.equal(globalThis.__piSessionPathCache?.has(parentId), true, "Cache must remain intact on failed delete");

  // 3. Restore valid subChild and perform successful native DELETE
  fs.writeFileSync(subChildPath, validSubChildContent, "utf8");
  t.after(() => {
    tsGuard.deletedPaths.delete(path.resolve(parentPath));
    tsGuard.deletedPaths.delete(path.resolve(subChildPath));
    invalidateSessionPathCache(grandparentId);
    invalidateSessionPathCache(parentId);
    invalidateSessionPathCache(subChildId);
    invalidateSessionPathCache(forkChildId);
    invalidateSessionManagerCache();
  });

  const okDeleteRes = await deleteSessionRoute(
    new Request(`http://localhost/api/sessions/${parentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parentId }) },
  );
  assert.equal(okDeleteRes.status, 200);
  assert.deepEqual(await okDeleteRes.json(), { ok: true });

  // Both parent and subChild are unlinked
  assert.equal(fs.existsSync(parentPath), false);
  assert.equal(fs.existsSync(subChildPath), false);
  // Grandparent and forkChild remain; forkChild is reparented to grandparent
  assert.equal(fs.existsSync(grandparentPath), true);
  assert.equal(fs.existsSync(forkChildPath), true);
  const reparentedHeader = JSON.parse(fs.readFileSync(forkChildPath, "utf8").split("\n")[0]);
  assert.equal(reparentedHeader.parentSession, grandparentPath);

  // Both invalidateSessionPathCache and invalidateSessionManagerCache were executed
  assert.equal(globalThis.__piSessionPathCache?.has(parentId), false);
  assert.equal(globalThis.__piSessionPathCache?.has(subChildId), false);
  assert.equal(globalThis.__piSmCache?.size ?? 0, 0);

  // Usage ledger recorded both parent (120 tokens) and subagent child (80 tokens) = 200 tokens
  const expectedSource = process.platform === "win32" ? "windows" : "nas";
  const stateFile = path.join(agentDir, "scripts", `pi-usage-events-${expectedSource}.json`);
  const ledger = buildLedger(readState(stateFile));
  assert.equal(ledger.totals.totalTokens, 200);
});

test("production build route.js bundle: native CJS loading, cwd independence, missing-script fail-closed, and sandbox transaction", (t) => {
  const builtRouteSrc = path.join(pkgRoot, ".next", "server", "app", "api", "sessions", "[id]", "route.js");
  const builtRuntimeSrc = path.join(pkgRoot, ".next", "server", "webpack-runtime.js");
  const builtChunksDir = path.join(pkgRoot, ".next", "server", "chunks");

  assert.equal(
    fs.existsSync(builtRouteSrc),
    true,
    "Production build artifact .next/server/app/api/sessions/[id]/route.js must exist",
  );

  const routeBundleCode = fs.readFileSync(builtRouteSrc, "utf8");
  assert.equal(
    routeBundleCode.includes("(void 0)("),
    false,
    "Bundled route.js must not contain broken (void 0)(...) createRequire call",
  );
  assert.equal(
    routeBundleCode.includes("usage-delete-guard.ts"),
    false,
    "Bundled route.js must not inline build-time usage-delete-guard.ts source path",
  );

  const { base } = createSandbox(t);
  const relocatedPkg = path.join(base, "relocated-pi-web");
  const relocatedRouteDir = path.join(relocatedPkg, ".next", "server", "app", "api", "sessions", "[id]");
  const relocatedGuardBin = path.join(relocatedPkg, "bin", "usage-guard");
  const emptyCwd = path.join(base, "unrelated-cwd");
  fs.mkdirSync(relocatedRouteDir, { recursive: true });
  fs.mkdirSync(relocatedGuardBin, { recursive: true });
  fs.mkdirSync(emptyCwd, { recursive: true });

  // GET's history worker follows the native launcher's package cwd contract.
  fs.copyFileSync(path.join(pkgRoot, "bin", "session-history-worker.cjs"), path.join(relocatedPkg, "bin", "session-history-worker.cjs"));

  // Copy actual entry bundle files so V8 CallSite points physically inside relocatedPkg/.next/...
  const relocatedRouteJs = path.join(relocatedRouteDir, "route.js");
  fs.copyFileSync(builtRouteSrc, relocatedRouteJs);
  fs.copyFileSync(builtRuntimeSrc, path.join(relocatedPkg, ".next", "server", "webpack-runtime.js"));
  // Copy chunks too: V8 resolves symlinked chunk filenames to the original
  // package, which would defeat this missing-worker relocation test.
  fs.cpSync(builtChunksDir, path.join(relocatedPkg, ".next", "server", "chunks"), { recursive: true });
  fs.symlinkSync(path.join(pkgRoot, "node_modules"), path.join(relocatedPkg, "node_modules"), "dir");

  const requiredFiles = [
    "pi-usage-delete-guard.cjs",
    "pi-usage-seal-worker.cjs",
    "usage-storage-paths.cjs",
    "generate-usage-ledger.js",
    "usage-ledger-core.js",
  ];
  for (const name of requiredFiles) {
    if (name === "pi-usage-seal-worker.cjs") continue; // intentionally omit first to test fail-closed
    fs.copyFileSync(path.join(binGuardDir, name), path.join(relocatedGuardBin, name));
  }

  // 1. Even when cwd is pkgRoot (which has a complete bin/usage-guard), loading the relocated
  // production bundle with a missing worker script in its own package root MUST fail closed.
  const failClosedProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `
      (async () => {
        const mod = require(${JSON.stringify(relocatedRouteJs)});
        if (typeof mod.routeModule.ensureUserland === "function") {
          await mod.routeModule.ensureUserland();
        }
        const ul = mod.routeModule.userland;
        console.log("UNEXPECTED_SUCCESS", Object.keys(ul));
        process.exit(0);
      })().catch((err) => {
        console.error(err && err.stack ? err.stack : String(err));
        process.exit(2);
      });
      `,
    ],
    {
      cwd: pkgRoot,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(failClosedProbe.status, 2, `Expected fail-closed exit code 2, got ${failClosedProbe.status}`);
  assert.match(
    failClosedProbe.stderr,
    /Incomplete or missing usage-guard bin directory/,
    "Relocated bundle must fail closed when its own bin/usage-guard is incomplete",
  );

  // 2. Restore the missing script and run full GET + fail-closed broken DELETE + valid DELETE
  // from an unrelated empty working directory in an isolated sandbox.
  fs.copyFileSync(
    path.join(binGuardDir, "pi-usage-seal-worker.cjs"),
    path.join(relocatedGuardBin, "pi-usage-seal-worker.cjs"),
  );

  const sandboxAgentDir = path.join(base, "prod-agent");
  const sandboxSessionsDir = path.join(sandboxAgentDir, "sessions");
  const sandboxProjectDir = path.join(sandboxSessionsDir, "proj-prod");
  fs.mkdirSync(sandboxProjectDir, { recursive: true });

  const parentId = "prod-parent-500";
  const childId = "prod-subagent-600";
  const parentPath = path.join(sandboxProjectDir, `20260925_${parentId}.jsonl`);
  const childPath = path.join(sandboxProjectDir, `20260925_${childId}.jsonl`);

  makeSessionFile(parentPath, parentId, [
    {
      type: "message",
      id: "pm-1",
      parentId: null,
      timestamp: "2026-09-25T10:00:01.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-6-astra",
        timestamp: 1790330401000,
        content: [{ type: "text", text: "prod parent" }],
        usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } },
      },
    },
  ]);
  makeSessionFile(
    childPath,
    childId,
    [
      {
        type: "custom",
        customType: "pi-web:subagent",
        id: "sub-meta-prod",
        parentId: null,
        timestamp: "2026-09-25T10:00:02.000Z",
        data: {
          version: 1,
          parentSessionId: parentId,
          parentSessionPath: parentPath,
          profile: "Explore",
          description: "Prod subagent",
        },
      },
      {
        type: "message",
        id: "cm-1",
        parentId: "sub-meta-prod",
        timestamp: "2026-09-25T10:00:03.000Z",
        message: {
          role: "assistant",
          provider: "cliproxyapi",
          model: "gemini-3.8-flash-high",
          timestamp: 1790330403000,
          content: [{ type: "text", text: "prod subagent" }],
          usage: { input: 60, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        },
      },
    ],
    { parentSession: parentPath },
  );

  const prodTxProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      (async () => {
        const mod = require(${JSON.stringify(relocatedRouteJs)});
        if (typeof mod.routeModule.ensureUserland === "function") {
          await mod.routeModule.ensureUserland();
        }
        const handlers = mod.routeModule.userland;
        assert.equal(typeof handlers.GET, "function");
        assert.equal(typeof handlers.DELETE, "function");
        assert.equal(
          fs.realpathSync(globalThis.__piUsageDeleteGuardBinDir),
          fs.realpathSync(${JSON.stringify(relocatedGuardBin)}),
        );

        // Guard ownership was resolved above from unrelated cwd. For GET/DELETE,
        // match bin/pi-web.js, which launches Next with cwd set to pkgDir.
        process.chdir(${JSON.stringify(relocatedPkg)});
        const parentId = ${JSON.stringify(parentId)};
        const parentPath = ${JSON.stringify(parentPath)};
        const childPath = ${JSON.stringify(childPath)};

        const getRes = await handlers.GET(
          new Request("http://localhost/api/sessions/" + parentId),
          { params: Promise.resolve({ id: parentId }) },
        );
        assert.equal(getRes.status, 200, await getRes.clone().text());
        const getJson = await getRes.json();
        assert.equal(getJson.usageDeleteGuard, 1);

        // Corrupt child to verify fail-closed 0-unlink atomicity in production bundle
        const origChild = fs.readFileSync(childPath, "utf8");
        fs.appendFileSync(childPath, '{"type":"message","corrupt":');
        const badDelRes = await handlers.DELETE(
          new Request("http://localhost/api/sessions/" + parentId, { method: "DELETE" }),
          { params: Promise.resolve({ id: parentId }) },
        );
        assert.equal(badDelRes.status, 500);
        assert.equal(fs.existsSync(parentPath), true);
        assert.equal(fs.existsSync(childPath), true);

        // Restore child and execute valid seal+delete transaction
        fs.writeFileSync(childPath, origChild, "utf8");
        const okDelRes = await handlers.DELETE(
          new Request("http://localhost/api/sessions/" + parentId, { method: "DELETE" }),
          { params: Promise.resolve({ id: parentId }) },
        );
        assert.equal(okDelRes.status, 200);
        assert.deepEqual(await okDelRes.json(), { ok: true });
        assert.equal(fs.existsSync(parentPath), false);
        assert.equal(fs.existsSync(childPath), false);
        console.log("PROD_BUNDLE_TX_OK");
      })().catch((err) => {
        console.error(err && err.stack ? err.stack : String(err));
        process.exit(1);
      });
      `,
    ],
    {
      cwd: emptyCwd,
      env: {
        ...process.env,
        HOME: sandboxAgentDir,
        USERPROFILE: sandboxAgentDir,
        PI_CODING_AGENT_DIR: sandboxAgentDir,
        PI_SESSIONS_DIR: sandboxSessionsDir,
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );

  assert.equal(
    prodTxProbe.status,
    0,
    `Production bundle transaction probe failed: ${prodTxProbe.stderr || prodTxProbe.stdout}`,
  );
  assert.match(prodTxProbe.stdout, /PROD_BUNDLE_TX_OK/);

  const expectedSource = process.platform === "win32" ? "windows" : "nas";
  const prodStateFile = path.join(sandboxAgentDir, "scripts", `pi-usage-events-${expectedSource}.json`);
  const prodLedger = buildLedger(readState(prodStateFile));
  assert.equal(prodLedger.totals.totalTokens, 240);
});
