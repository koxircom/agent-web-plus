"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const child_process = require("node:child_process");
const {
  resolveAgentDir,
  resolveDefaultScriptsDir,
  resolveUsagePathsForLedger,
} = require("./usage-storage-paths.cjs");

const GUARD_VERSION = 1;

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * 仅在确认 worker 已结束（isConfirmedClosed===true）、lock 内容的 pid 与 ownerRequestToken 完全匹配、
 * 读前后 inode/dev/mtimeMs 一致且未被替换时移除自己的锁，不得删除其他任务锁或 unknown legacy 锁。
 */
function cleanupWorkerLockSafely(workerPid, lockFile, isConfirmedClosed = false, expectedOwnerToken = null) {
  if (!workerPid || !lockFile || !isConfirmedClosed) return;
  if (!expectedOwnerToken || typeof expectedOwnerToken !== "string") return;

  try {
    const resolvedLockFile = path.resolve(lockFile);
    if (!fs.existsSync(resolvedLockFile)) return;

    if (!isConfirmedClosed && isProcessAlive(workerPid)) {
      return; // 存活PID可能已被复用，绝不提前终止任何进程。
    }

    const statBefore = fs.statSync(resolvedLockFile);
    if (!statBefore.isFile()) return;

    const raw = fs.readFileSync(resolvedLockFile, "utf8");
    const statAfter = fs.statSync(resolvedLockFile);

    // inode 读前后核验：防止 TOCTOU race 或锁文件在读取期间被替换
    if (
      statBefore.ino !== statAfter.ino ||
      statBefore.dev !== statAfter.dev ||
      statBefore.mtimeMs !== statAfter.mtimeMs
    ) {
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      // unknown legacy lock 不能删除
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    // 严格核验 pid
    if (parsed.pid !== workerPid) {
      return;
    }

    // unknown legacy lock (无 ownerRequestToken) 不能删除
    if (!parsed.ownerRequestToken || typeof parsed.ownerRequestToken !== "string") {
      return;
    }

    // same-pid wrong-token 锁绝对不能删除
    if (parsed.ownerRequestToken !== expectedOwnerToken) {
      return;
    }

    // 删除前再次核验 inode，确保锁仍属于该 worker 且未被替换
    const statFinal = fs.statSync(resolvedLockFile);
    if (statFinal.ino !== statBefore.ino || statFinal.dev !== statBefore.dev) {
      return;
    }

    fs.unlinkSync(resolvedLockFile);
  } catch (_) {}
}

// 进程内已封存并删除的文件墓碑（绝对规范化路径，挂载于 globalThis 保证跨模块实例一致）
const deletedPaths = globalThis.__piUsageDeletedPaths || (globalThis.__piUsageDeletedPaths = new Set());

function isPathDeleted(filePath) {
  if (!filePath) return false;
  try {
    const resolved = path.resolve(filePath);
    if (deletedPaths.has(resolved)) return true;
    if (process.platform === "win32") {
      const lower = resolved.toLowerCase();
      for (const item of deletedPaths) {
        if (typeof item === "string" && item.toLowerCase() === lower) return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * 包装 SessionManager.prototype._persist 和 _rewriteFile，
 * 防止已排队的异步操作在删除返回后重建已删文件。
 */
function installSessionWriteGuard(SessionManager) {
  if (!SessionManager || !SessionManager.prototype) {
    throw new Error("[usage-delete-guard] Invalid SessionManager class provided");
  }

  const proto = SessionManager.prototype;
  if (proto.__piUsageDeleteGuardInstalled) {
    return true;
  }

  if (typeof proto._persist !== "function" || typeof proto._rewriteFile !== "function") {
    throw new Error("[usage-delete-guard] SessionManager is missing required _persist or _rewriteFile methods");
  }

  const origPersist = proto._persist;
  proto._persist = function (entry) {
    if (this.sessionFile && isPathDeleted(this.sessionFile)) {
      throw new Error(`[usage-delete-guard] Write rejected: cannot persist to deleted session file: ${this.sessionFile}`);
    }
    return origPersist.apply(this, arguments);
  };

  const origRewriteFile = proto._rewriteFile;
  proto._rewriteFile = function () {
    if (this.sessionFile && isPathDeleted(this.sessionFile)) {
      throw new Error(`[usage-delete-guard] Write rejected: cannot rewrite deleted session file: ${this.sessionFile}`);
    }
    return origRewriteFile.apply(this, arguments);
  };

  proto.__piUsageDeleteGuardInstalled = true;
  return true;
}

function prepareWorkerExecution(targetsInput, options = {}) {
  let targetsMap;
  if (targetsInput instanceof Map) {
    targetsMap = new Map(targetsInput);
  } else if (Array.isArray(targetsInput)) {
    targetsMap = new Map(targetsInput);
  } else if (typeof targetsInput === "object" && targetsInput !== null) {
    targetsMap = new Map(Object.entries(targetsInput));
  } else {
    throw new Error("[usage-delete-guard] Invalid targets argument: Map, Array or Object required");
  }

  if (targetsMap.size === 0) {
    return null;
  }

  const workerScript = options.workerScript || path.join(__dirname, "pi-usage-seal-worker.cjs");
  if (!fs.existsSync(workerScript)) {
    throw new Error(`[usage-delete-guard] Seal worker script not found: ${workerScript}`);
  }

  const agentDir = resolveAgentDir();
  const scriptsDir = resolveDefaultScriptsDir();
  const resolvedPaths = resolveUsagePathsForLedger(options, scriptsDir);
  const source = resolvedPaths.source;
  const stateFile = resolvedPaths.stateFile;
  const outputFile = resolvedPaths.outputFile;
  const lockFile = resolvedPaths.lockFile;
  const defaultSessionsRoot = process.env.PI_SESSIONS_DIR || path.join(agentDir, "sessions");
  const sessionsRoot = path.resolve(options.sessionsRoot || defaultSessionsRoot);

  const lockOwnerToken =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");

  const payload = {
    source,
    sessionsRoot,
    stateFile,
    outputFile,
    lockOwnerToken,
    ownerRequestToken: lockOwnerToken,
    ...(typeof options.lockTimeoutMs === "number" ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options.sealForDelete !== undefined ? { sealForDelete: Boolean(options.sealForDelete) } : {}),
    targets: Array.from(targetsMap.entries()).map(([sessionId, filePath]) => ({
      sessionId,
      path: path.resolve(filePath),
    })),
  };

  return {
    targetsMap,
    workerScript,
    lockFile,
    payload,
    lockOwnerToken,
  };
}

function verifyAndUnlinkTargets(stdout, targetsMap, onDeleted) {
  // 解析 worker 返回并验证 version==GUARD_VERSION 以及目标指纹结构
  let workerRes;
  try {
    workerRes = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`[usage-delete-guard] Malformed worker output: ${stdout.slice(0, 200)}`);
  }

  if (
    !workerRes ||
    workerRes.ok !== true ||
    workerRes.version !== GUARD_VERSION ||
    typeof workerRes.targets !== "object" ||
    workerRes.targets === null ||
    Array.isArray(workerRes.targets)
  ) {
    throw new Error(
      `[usage-delete-guard] Seal worker returned unsuccessful result or incompatible version: expected ${GUARD_VERSION}, got ${workerRes?.version}`
    );
  }

  const returnedTargets = workerRes.targets;
  const returnedKeys = Object.keys(returnedTargets);
  if (returnedKeys.length !== targetsMap.size) {
    throw new Error(`[usage-delete-guard] Target count mismatch: expected ${targetsMap.size}, got ${returnedKeys.length}`);
  }

  for (const [sessionId, filePath] of targetsMap) {
    const rec = returnedTargets[sessionId];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      throw new Error(`[usage-delete-guard] Missing or invalid fingerprint object for session ${sessionId}`);
    }
    const resolvedPath = path.resolve(filePath);
    if (typeof rec.path !== "string" || path.resolve(rec.path) !== resolvedPath) {
      throw new Error(`[usage-delete-guard] Path mismatch for session ${sessionId}: expected ${resolvedPath}, got ${rec.path}`);
    }
    if (
      typeof rec.sha256 !== "string" ||
      rec.sha256.length !== 64 ||
      !Number.isFinite(rec.dev) ||
      !Number.isFinite(rec.ino) ||
      !Number.isFinite(rec.size) ||
      !Number.isFinite(rec.mtimeMs)
    ) {
      throw new Error(`[usage-delete-guard] Incomplete or invalid fingerprint structure for session ${sessionId}`);
    }
  }

  // 父进程再次同步比对源文件签名（dev/ino/size/mtime/sha256）
  for (const [sessionId, filePath] of targetsMap) {
    const rec = returnedTargets[sessionId];
    const resolvedPath = path.resolve(filePath);

    let stat;
    try {
      stat = fs.statSync(resolvedPath);
    } catch (e) {
      throw new Error(`[usage-delete-guard] Source file disappeared before unlink verification: ${resolvedPath} (${e.message})`);
    }

    if (
      stat.dev !== rec.dev ||
      stat.ino !== rec.ino ||
      stat.size !== rec.size ||
      stat.mtimeMs !== rec.mtimeMs
    ) {
      throw new Error(`[usage-delete-guard] Source file stat mismatch before unlink: ${resolvedPath}`);
    }

    const currentHash = crypto.createHash("sha256").update(fs.readFileSync(resolvedPath)).digest("hex");
    if (currentHash !== rec.sha256) {
      throw new Error(`[usage-delete-guard] Source file hash changed before unlink: ${resolvedPath}`);
    }
  }

  // 全部核验通过后，将路径加入墓碑，开始逐一 unlinkSync
  const stagedPaths = new Set();
  for (const [, filePath] of targetsMap) {
    const resolved = path.resolve(filePath);
    stagedPaths.add(resolved);
    deletedPaths.add(resolved);
  }

  const successfullyDeleted = new Set();
  let deletedCount = 0;
  try {
    for (const [sessionId, filePath] of targetsMap) {
      const resolved = path.resolve(filePath);
      try {
        fs.unlinkSync(resolved);
      } catch (err) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
      successfullyDeleted.add(resolved);
      deletedCount++;
      if (typeof onDeleted === "function") {
        try {
          onDeleted(sessionId, filePath);
        } catch (cbErr) {
          console.error(`[usage-delete-guard] onDeleted callback failed for ${sessionId}:`, cbErr);
        }
      }
    }
  } catch (err) {
    throw new Error(`[usage-delete-guard] File deletion failed: ${err.message}. Persistent state was safely saved.`);
  } finally {
    // 外层 finally 清理本次未实际成功删除的目标（报错项及后续未执行项），已删保留
    for (const p of stagedPaths) {
      if (!successfullyDeleted.has(p)) {
        deletedPaths.delete(p);
      }
    }
  }

  return { ok: true, deletedCount };
}

/**
 * 同步封存与删除事务：
 * 1. 同步执行 seal worker，对目标文件计算指纹并追加到永久账本及状态
 * 2. 父进程同步全集核验与源文件当前签名比对（dev/ino/size/mtime/sha256）
 * 3. 校验全部通过后进入 tombstone 保护阶段，逐一执行 unlinkSync
 * 4. 逐成功调用 onDeleted(sessionId, filePath) 使原生缓存失效
 * 5. 任何封存、核验或锁失败保证 0 个 unlink
 */
function sealAndDeleteSync(targetsInput, onDeleted, options = {}) {
  const prep = prepareWorkerExecution(targetsInput, options);
  if (!prep) {
    return { ok: true, deletedCount: 0 };
  }

  const { targetsMap, workerScript, lockFile, payload, lockOwnerToken } = prep;

  // 1. 同步调用 seal worker（spawnSync 取得真实 pid 与退出信息）
  const spawnRes = child_process.spawnSync(process.execPath, [workerScript], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: options.timeout || 30000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });

  const workerPid = spawnRes.pid;

  if (spawnRes.error || spawnRes.status !== 0 || spawnRes.signal) {
    cleanupWorkerLockSafely(workerPid, lockFile, true, lockOwnerToken);
    const detail = spawnRes.error
      ? spawnRes.error.message
      : spawnRes.stderr
        ? spawnRes.stderr.toString().trim()
        : `Exit code ${spawnRes.status}, signal ${spawnRes.signal}`;
    throw new Error(`[usage-delete-guard] Seal worker execution failed: ${detail}`);
  }

  return verifyAndUnlinkTargets(spawnRes.stdout || "", targetsMap, onDeleted);
}

/**
 * 异步非阻塞封存与删除事务：
 * 1. 异步 spawn seal worker，避免阻塞 Next.js 主事件循环
 * 2. 与 sync 共享统一的准备、签名比对、墓碑保护与 unlink 完成阶段
 * 3. 进程超时与异常关闭后由 owner-aware 清理验证自身 lock
 */
function sealAndDelete(targetsInput, onDeleted, options = {}) {
  return new Promise((resolve, reject) => {
    let prep;
    try {
      prep = prepareWorkerExecution(targetsInput, options);
    } catch (err) {
      return reject(err);
    }

    if (!prep) {
      return resolve({ ok: true, deletedCount: 0 });
    }

    const { targetsMap, workerScript, lockFile, payload, lockOwnerToken } = prep;
    const timeoutMs = options.timeout || 30000;
    const maxBuffer = typeof options.maxBuffer === "number" ? options.maxBuffer : 20 * 1024 * 1024;

    let child;
    try {
      child = child_process.spawn(process.execPath, [workerScript], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (spawnErr) {
      return reject(new Error(`[usage-delete-guard] Seal worker execution failed: ${spawnErr.message}`));
    }

    const workerPid = child.pid;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let maxBufferExceeded = false;
    let timedOut = false;
    let finished = false;
    let killTimer = null;
    let spawnError = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // stdin 必须监听 error 处理 EPIPE，防止未捕获流错误导致整个进程崩溃
    child.stdin.on("error", (err) => {
      if (err.code !== "EPIPE" && err.code !== "EOF" && err.code !== "ERR_STREAM_DESTROYED") {
        spawnError = spawnError || err;
      }
    });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxBuffer) {
        if (!maxBufferExceeded) {
          maxBufferExceeded = true;
          spawnError = spawnError || new Error(`Seal worker stdout exceeded maxBuffer (${maxBuffer} bytes)`);
          try {
            child.kill("SIGTERM");
          } catch (_) {}
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch (_) {}
          }, 1000);
        }
        return;
      }
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) {
        stderr += chunk;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_) {}
      }, 1000);
    }, timeoutMs);

    child.on("error", (err) => {
      spawnError = spawnError || err;
    });

    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      if (timedOut) {
        cleanupWorkerLockSafely(workerPid, lockFile, true, lockOwnerToken);
        return reject(
          new Error(`[usage-delete-guard] Seal worker execution failed: Execution timed out after ${timeoutMs}ms`)
        );
      }

      if (maxBufferExceeded) {
        cleanupWorkerLockSafely(workerPid, lockFile, true, lockOwnerToken);
        return reject(
          new Error(`[usage-delete-guard] Seal worker execution failed: Seal worker stdout exceeded maxBuffer (${maxBuffer} bytes)`)
        );
      }

      if (spawnError || code !== 0 || signal) {
        cleanupWorkerLockSafely(workerPid, lockFile, true, lockOwnerToken);
        const detail = spawnError
          ? spawnError.message
          : stderr.trim()
            ? stderr.trim()
            : `Exit code ${code}, signal ${signal}`;
        return reject(new Error(`[usage-delete-guard] Seal worker execution failed: ${detail}`));
      }

      try {
        const result = verifyAndUnlinkTargets(stdout, targetsMap, onDeleted);
        resolve(result);
      } catch (verifyErr) {
        reject(verifyErr);
      }
    });

    try {
      child.stdin.end(JSON.stringify(payload), "utf8");
    } catch (writeErr) {
      if (writeErr.code !== "EPIPE" && writeErr.code !== "EOF") {
        spawnError = spawnError || writeErr;
      }
    }
  });
}

module.exports = {
  GUARD_VERSION,
  deletedPaths,
  isPathDeleted,
  installSessionWriteGuard,
  sealAndDeleteSync,
  sealAndDelete,
  cleanupWorkerLockSafely,
};
