"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scanSession, readState, buildLedger, atomicWrite } = require("./generate-usage-ledger.js");
const {
  resolveAgentDir,
  resolveDefaultScriptsDir,
  resolveUsagePathsForLedger,
  acquireUsageLock,
  releaseUsageLock,
} = require("./usage-storage-paths.cjs");

const GUARD_VERSION = 1;

function getHash(filePath) {
  const hash = crypto.createHash("sha256");
  const content = fs.readFileSync(filePath);
  hash.update(content);
  return hash.digest("hex");
}

function acquireLock(lockFile, timeoutMs = 8000, extraData = {}) {
  return acquireUsageLock(lockFile, { timeoutMs, extraData });
}

function releaseLock(lockFile, fd = null) {
  releaseUsageLock(lockFile, fd);
}

function parseFirstLineJson(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
    const str = buf.toString("utf8", 0, bytesRead);
    const newlineIdx = str.indexOf("\n");
    const firstLine = newlineIdx !== -1 ? str.slice(0, newlineIdx) : str;
    return JSON.parse(firstLine.trim());
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  let rawInput = "";
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    rawInput = Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    console.error("[pi-usage-seal-worker] Failed to read from stdin:", err.message);
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch (err) {
    console.error("[pi-usage-seal-worker] Invalid JSON input:", err.message);
    process.exit(1);
  }

  const agentDir = resolveAgentDir();
  const scriptsDir = resolveDefaultScriptsDir();
  const resolvedPaths = resolveUsagePathsForLedger(payload, scriptsDir);
  const source = resolvedPaths.source;
  const stateFile = resolvedPaths.stateFile;
  const outputFile = resolvedPaths.outputFile;
  const lockFile = resolvedPaths.lockFile;
  const defaultSessionsRoot = process.env.PI_SESSIONS_DIR || path.join(agentDir, "sessions");
  const sessionsRoot = path.resolve(payload.sessionsRoot || defaultSessionsRoot);

  if (!fs.existsSync(sessionsRoot)) {
    console.error(`[pi-usage-seal-worker] sessionsRoot not found: ${sessionsRoot}`);
    process.exit(1);
  }
  const realSessionsRoot = fs.realpathSync(sessionsRoot);

  let rawTargets = payload.targets;
  if (!rawTargets) rawTargets = [];
  if (!Array.isArray(rawTargets)) {
    if (typeof rawTargets === "object" && rawTargets !== null) {
      rawTargets = Object.entries(rawTargets).map(([sessionId, p]) => ({ sessionId, path: p }));
    } else {
      console.error("[pi-usage-seal-worker] Invalid targets format");
      process.exit(1);
    }
  }

  if (rawTargets.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, version: GUARD_VERSION, targets: {} }));
    process.exit(0);
  }

  // 1. 严格校验所有待封存文件的路径合法性、符号链接及首行 session id
  for (const t of rawTargets) {
    if (!t.sessionId || typeof t.sessionId !== "string") {
      console.error("[pi-usage-seal-worker] Missing or invalid target sessionId");
      process.exit(1);
    }
    if (!t.path || typeof t.path !== "string") {
      console.error(`[pi-usage-seal-worker] Missing or invalid target path for session ${t.sessionId}`);
      process.exit(1);
    }

    const resolvedPath = path.resolve(t.path);

    // 拒绝叶子符号链接
    let lstat;
    try {
      lstat = fs.lstatSync(resolvedPath);
    } catch (e) {
      console.error(`[pi-usage-seal-worker] Cannot lstat target ${resolvedPath}: ${e.message}`);
      process.exit(1);
    }
    if (lstat.isSymbolicLink()) {
      console.error(`[pi-usage-seal-worker] Leaf symbolic link rejected: ${resolvedPath}`);
      process.exit(1);
    }
    if (!lstat.isFile()) {
      console.error(`[pi-usage-seal-worker] Target is not a regular file: ${resolvedPath}`);
      process.exit(1);
    }

    // 校验必须在受控 sessionsRoot 内，严禁路径穿越
    let realPath;
    try {
      realPath = fs.realpathSync(resolvedPath);
    } catch (e) {
      console.error(`[pi-usage-seal-worker] Cannot resolve realpath of ${resolvedPath}: ${e.message}`);
      process.exit(1);
    }
    const relative = path.relative(realSessionsRoot, realPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      console.error(`[pi-usage-seal-worker] Target outside sessionsRoot: ${resolvedPath} (not in ${realSessionsRoot})`);
      process.exit(1);
    }

    // 校验首行 session header ID
    let header;
    try {
      header = parseFirstLineJson(resolvedPath);
    } catch (e) {
      console.error(`[pi-usage-seal-worker] Failed to parse session header of ${resolvedPath}: ${e.message}`);
      process.exit(1);
    }
    if (header.type !== "session" || header.id !== t.sessionId) {
      console.error(`[pi-usage-seal-worker] Session header mismatch for ${resolvedPath}: expected ${t.sessionId}, got ${header?.id}`);
      process.exit(1);
    }
  }

  // 2. 独占锁竞争
  const ownerRequestToken =
    typeof payload.lockOwnerToken === "string" && payload.lockOwnerToken.trim()
      ? payload.lockOwnerToken.trim()
      : typeof payload.ownerRequestToken === "string" && payload.ownerRequestToken.trim()
        ? payload.ownerRequestToken.trim()
        : null;
  const lockTimeoutMs = typeof payload.lockTimeoutMs === "number" ? payload.lockTimeoutMs : 8000;
  let lockFd = null;
  try {
    const extraData = ownerRequestToken ? { ownerRequestToken } : {};
    lockFd = acquireLock(lockFile, lockTimeoutMs, extraData);
  } catch (err) {
    console.error(`[pi-usage-seal-worker] Failed to acquire lock ${lockFile}: ${err.message}`);
    process.exit(1);
  }

  let locked = true;
  const sealForDelete = payload.sealForDelete !== undefined ? Boolean(payload.sealForDelete) : true;
  try {
    const state = readState(stateFile);
    const fingerprints = {};

    for (const t of rawTargets) {
      const resolvedPath = path.resolve(t.path);
      const statBefore = fs.statSync(resolvedPath);
      const shaBefore = getHash(resolvedPath);

      const audit = { assistant: 0, subagentResults: 0, system: 0, partialLines: 0, aggregateOnlyTasks: 0 };
      await scanSession(resolvedPath, state, source, audit, { sealForDelete });

      const statAfter = fs.statSync(resolvedPath);
      const shaAfter = getHash(resolvedPath);

      // 核验前后 sha256 与 stat 指纹
      if (shaBefore !== shaAfter) {
        throw new Error(`File hash changed during seal scan: ${resolvedPath}`);
      }
      if (
        statBefore.dev !== statAfter.dev ||
        statBefore.ino !== statAfter.ino ||
        statBefore.size !== statAfter.size ||
        statBefore.mtimeMs !== statAfter.mtimeMs
      ) {
        throw new Error(`File stat changed during seal scan: ${resolvedPath}`);
      }

      // 要求 ingestion.complete === true（无挂起 toolCalls，无未结算嵌套使用，无截断行）
      const sessionRec = state.sessions[t.sessionId];
      if (!sessionRec || !sessionRec.ingestion || sessionRec.ingestion.complete !== true) {
        throw new Error(`Session ingestion incomplete or pending tool calls: ${t.sessionId} in ${resolvedPath}`);
      }

      fingerprints[t.sessionId] = {
        path: resolvedPath,
        sha256: shaBefore,
        dev: statBefore.dev,
        ino: statBefore.ino,
        size: statBefore.size,
        mtimeMs: statBefore.mtimeMs,
      };
    }

    // 构建账本并原子持久化
    const ledger = buildLedger(state);
    atomicWrite(stateFile, state);
    atomicWrite(outputFile, ledger);

    releaseLock(lockFile, lockFd);
    locked = false;
    lockFd = null;

    process.stdout.write(JSON.stringify({ ok: true, version: GUARD_VERSION, targets: fingerprints }));
    process.exit(0);
  } catch (err) {
    if (locked) {
      releaseLock(lockFile, lockFd);
      locked = false;
      lockFd = null;
    }
    console.error(`[pi-usage-seal-worker] Seal failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[pi-usage-seal-worker] Unexpected error:", err);
  process.exit(1);
});
