'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const activeHandleByAgentDir = new Map();

function getProcessStartTicks(pid) {
  if (process.platform !== 'linux' || typeof pid !== 'number' || pid <= 0) {
    return null;
  }
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rParen = raw.lastIndexOf(')');
    if (rParen === -1) return null;
    const fields = raw.slice(rParen + 2).trim().split(/\s+/);
    // fields[0] is state (3rd field in stat), starttime is field 22 -> index 19
    return fields[19] || null;
  } catch (_) {
    return null;
  }
}

function getBootId() {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function getPidNamespace() {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch (_) {
    return null;
  }
}

function getLockDir(agentDir) {
  const resolved = path.resolve(agentDir);
  return path.join(resolved, '.agent-state-mutex');
}

function checkOwnerReclaimable(lockDir) {
  const ownerFile = path.join(lockDir, 'owner.json');
  let content;
  try {
    content = fs.readFileSync(ownerFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        const st = fs.statSync(lockDir);
        const ageMs = Date.now() - st.mtimeMs;
        // 目录刚创建（< 1000ms），正在写入 owner.json，绝不强抢
        if (ageMs < 1000) {
          return { reclaimable: false, isDead: false, reason: 'LOCK_INITIALIZING' };
        }
        // 超过1秒仍无 owner.json，禁止自动抢占未知 owner
        return { reclaimable: false, isDead: false, reason: 'UNKNOWN_OWNER' };
      } catch (_) {
        return { reclaimable: false, isDead: false, reason: 'STAT_FAILED' };
      }
    }
    return { reclaimable: false, isDead: false, reason: 'READ_FAILED' };
  }

  let owner;
  try {
    owner = JSON.parse(content);
  } catch (_) {
    return { reclaimable: false, isDead: false, reason: 'INVALID_OWNER_METADATA' };
  }

  if (!owner || typeof owner !== 'object' || typeof owner.pid !== 'number') {
    return { reclaimable: false, isDead: false, reason: 'INVALID_OWNER_FORMAT' };
  }

  // 跨 namespace / 跨 host / 跨 boot 身份验证
  // 铁律：跨 namespace 视 UNKNOWN_OWNER 不可 deadclaim
  const currentHostname = os.hostname();
  const currentBootId = getBootId();
  const currentPidNs = getPidNamespace();

  const isSameHost = (owner.hostname === currentHostname);
  const isSameBoot = (!currentBootId || !owner.bootId || currentBootId === owner.bootId);

  let isSamePidNs = true;
  if (process.platform === 'linux') {
    if (!owner.pidNamespace || !currentPidNs || owner.pidNamespace !== currentPidNs) {
      isSamePidNs = false;
    }
  }

  if (!isSameHost || !isSameBoot || !isSamePidNs) {
    return {
      reclaimable: false,
      isDead: false,
      reason: 'UNKNOWN_OWNER',
      owner
    };
  }

  let isDead = false;
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') {
      isDead = true;
    } else if (err.code === 'EPERM') {
      isDead = false;
    }
  }

  if (isDead) {
    return { reclaimable: false, isDead: true, reason: 'PROCESS_DEAD', owner };
  }

  // 进程存在，检查 Linux startTicks 防 PID 复用
  if (owner.startTicks && process.platform === 'linux') {
    const currentTicks = getProcessStartTicks(owner.pid);
    if (currentTicks !== null && String(currentTicks) !== String(owner.startTicks)) {
      return { reclaimable: false, isDead: true, reason: 'START_TICKS_MISMATCH', owner };
    }
  }

  return { reclaimable: false, isDead: false, reason: 'PROCESS_ALIVE', owner };
}

function recoverStaleLock(agentDirOrLockDir, options = {}) {
  const lockDir = path.basename(agentDirOrLockDir) === '.agent-state-mutex'
    ? path.resolve(agentDirOrLockDir)
    : getLockDir(agentDirOrLockDir);

  if (!fs.existsSync(lockDir)) {
    return { ok: true, recovered: false, reason: 'LOCK_NOT_FOUND' };
  }

  const check = checkOwnerReclaimable(lockDir);
  // Recovery is an explicit offline maintenance operation, never a force-unlock.
  if (options.offlineMaintenance !== true || !check.isDead) {
    return {
      ok: false,
      recovered: false,
      reason: check.reason,
      owner: check.owner || null
    };
  }

  const expectedToken = options.expectedToken;
  if (!expectedToken || expectedToken !== check.owner?.token) {
    return { ok: false, recovered: false, reason: 'OWNER_TOKEN_REQUIRED' };
  }
  const parent = path.dirname(lockDir);
  activeHandleByAgentDir.delete(path.resolve(parent));
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const staleDir = path.join(parent, `.stale_mutex_${Date.now()}_${process.pid}_${randomSuffix}`);

  try {
    fs.renameSync(lockDir, staleDir);
  } catch (err) {
    return { ok: false, recovered: false, reason: 'RENAME_FAILED', error: err.message };
  }

  try {
    fs.rmSync(staleDir, { recursive: true, force: true });
  } catch (err) {
    return { ok: true, recovered: true, warning: 'RM_FAILED', error: err.message };
  }

  return { ok: true, recovered: true, previousOwner: check.owner || null };
}

function tryReclaimStaleLock(lockDir) {
  const res = recoverStaleLock(lockDir);
  return res.recovered;
}

function tryAcquireLockSync(agentDir) {
  const lockDir = getLockDir(agentDir);
  const parentDir = path.dirname(lockDir);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }

  let createdDir = false;
  let createdInode = null;
  let createdDev = null;
  let uncommittedToken = null;

  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
    createdDir = true;
    const st = fs.statSync(lockDir);
    createdInode = st.ino;
    createdDev = st.dev;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }

    // EEXIST: 锁已存在，检查诊断信息
    const check = checkOwnerReclaimable(lockDir);
    if (check.isDead) {
      // 契约：acquire dead metadata 也返回 LOCK_STALE_REQUIRES_RECOVERY failclosed（不自动回收）
      // 保留 process info 仅诊断，不据 TTL/host pid 强抢
      const staleErr = new Error(`LOCK_STALE_REQUIRES_RECOVERY: Agent state lock owner is dead (${check.reason}) and requires recovery`);
      staleErr.code = 'LOCK_STALE_REQUIRES_RECOVERY';
      staleErr.owner = check.owner || null;
      staleErr.reason = check.reason;
      staleErr.lockDir = lockDir;
      throw staleErr;
    }
    return null;
  }

  // mkdir 成功后写入 owner.json
  const ownerFile = path.join(lockDir, 'owner.json');
  try {
    const token = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    uncommittedToken = token;

    const startTicks = getProcessStartTicks(process.pid);
    const bootId = getBootId();
    const pidNs = getPidNamespace();

    const metadata = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      bootId: bootId || null,
      pidNamespace: pidNs || null,
      startTicks: startTicks ? String(startTicks) : null,
      createdAt: Date.now()
    };

    fs.writeFileSync(ownerFile, JSON.stringify(metadata, null, 2), { mode: 0o600 });
    const handle = {
      lockDir,
      token,
      agentDir: path.resolve(agentDir),
      released: false
    };
    activeHandleByAgentDir.set(path.resolve(agentDir), handle);
    return handle;
  } catch (initErr) {
    // 契约：init owner 写失败安全清理只自己刚 mkdir 且 inode 仍同未发布可 token 检查
    if (createdDir && createdInode !== null) {
      try {
        const curStat = fs.statSync(lockDir);
        if (curStat.ino === createdInode && curStat.dev === createdDev) {
          let canClean = true;
          if (fs.existsSync(ownerFile)) {
            try {
              const fileContent = fs.readFileSync(ownerFile, 'utf8');
              const parsed = JSON.parse(fileContent);
              if (parsed && parsed.token && parsed.token !== uncommittedToken) {
                canClean = false;
              }
            } catch (_) {
              // 损坏的不完整写入可清理
            }
            if (canClean) {
              try { fs.unlinkSync(ownerFile); } catch (_) {}
            }
          }
          if (canClean) {
            try { fs.rmdirSync(lockDir); } catch (_) {}
          }
        }
      } catch (_) {}
    }
    throw initErr;
  }
}

function releaseLockSync(lockHandle) {
  if (!lockHandle || lockHandle.released) return;
  const { lockDir, token } = lockHandle;
  const resolvedAgentDir = lockHandle.agentDir ? path.resolve(lockHandle.agentDir) : path.dirname(lockDir);
  const ownerFile = path.join(lockDir, 'owner.json');

  if (!fs.existsSync(ownerFile)) {
    activeHandleByAgentDir.delete(resolvedAgentDir);
    const err = new Error('LOCK_OWNERSHIP_LOST: owner.json does not exist');
    err.code = 'LOCK_OWNERSHIP_LOST';
    err.lockDir = lockDir;
    throw err;
  }

  let content;
  try {
    content = fs.readFileSync(ownerFile, 'utf8');
  } catch (readErr) {
    activeHandleByAgentDir.delete(resolvedAgentDir);
    const err = new Error(`LOCK_OWNERSHIP_LOST: failed to read owner.json: ${readErr.message}`);
    err.code = 'LOCK_OWNERSHIP_LOST';
    err.cause = readErr;
    throw err;
  }

  let meta;
  try {
    meta = JSON.parse(content);
  } catch (parseErr) {
    activeHandleByAgentDir.delete(resolvedAgentDir);
    const err = new Error(`LOCK_OWNERSHIP_LOST: corrupted owner metadata: ${parseErr.message}`);
    err.code = 'LOCK_OWNERSHIP_LOST';
    err.cause = parseErr;
    throw err;
  }

  if (!meta || meta.token !== token) {
    activeHandleByAgentDir.delete(resolvedAgentDir);
    const err = new Error(`LOCK_OWNERSHIP_LOST: token mismatch (expected ${token}, found ${meta ? meta.token : 'null'})`);
    err.code = 'LOCK_OWNERSHIP_LOST';
    err.expectedToken = token;
    err.foundToken = meta ? meta.token : null;
    throw err;
  }

  // 文件删除与 rmdir 失败保守上抛，绝不 silent 吞错
  try {
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(lockDir);
  } finally {
    lockHandle.released = true;
    activeHandleByAgentDir.delete(resolvedAgentDir);
  }
}

function withAgentStateLockSync(agentDir, fn, options = {}) {
  if (typeof fn === 'function' && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    const asyncErr = new TypeError('ASYNC_TRANSACTION_PROHIBITED: withAgentStateLockSync does not accept AsyncFunction. Use withAgentStateLock for async operations to prevent premature lock release.');
    asyncErr.code = 'ASYNC_TRANSACTION_PROHIBITED';
    throw asyncErr;
  }

  const lockHandle = tryAcquireLockSync(agentDir);
  if (!lockHandle) {
    const err = new Error('LOCK_BUSY: Agent state lock is held by another process');
    err.code = 'LOCK_BUSY';
    throw err;
  }

  let businessErr = null;
  let result;
  try {
    result = fn();
    // 契约：新增 sync transaction 拒 async fn 返回 promise 防锁提前释放
    if (result && typeof result.then === 'function') {
      const asyncErr = new TypeError('ASYNC_TRANSACTION_PROHIBITED: withAgentStateLockSync callback returned a Promise. Use withAgentStateLock for async operations to prevent premature lock release.');
      asyncErr.code = 'ASYNC_TRANSACTION_PROHIBITED';
      businessErr = asyncErr;
    }
  } catch (err) {
    businessErr = err;
  }

  let releaseErr = null;
  try {
    releaseLockSync(lockHandle);
  } catch (err) {
    releaseErr = err;
  }

  if (businessErr && releaseErr) {
    if (typeof AggregateError === 'function') {
      throw new AggregateError([businessErr, releaseErr], `${businessErr.message}; Lock release failed: ${releaseErr.message}`);
    } else {
      businessErr.releaseError = releaseErr;
      throw businessErr;
    }
  }

  if (businessErr) throw businessErr;
  if (releaseErr) throw releaseErr;
  return result;
}

function withAgentStateReadLockSync(agentDir, fn) {
  if (typeof fn === 'function' && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    const asyncErr = new TypeError('ASYNC_TRANSACTION_PROHIBITED: withAgentStateReadLockSync does not accept AsyncFunction. Use withAgentStateLock for async operations to prevent premature lock release.');
    asyncErr.code = 'ASYNC_TRANSACTION_PROHIBITED';
    throw asyncErr;
  }

  const resolved = path.resolve(agentDir);
  const existingHandle = activeHandleByAgentDir.get(resolved);

  // 如果本进程已经持有该 agentDir 的排他锁，安全复用只读（只读不发生写 IO interleave）
  if (existingHandle && !existingHandle.released) {
    const result = fn();
    if (result && typeof result.then === 'function') {
      const asyncErr = new TypeError('ASYNC_TRANSACTION_PROHIBITED: withAgentStateReadLockSync callback returned a Promise. Use withAgentStateLock for async operations to prevent premature lock release.');
      asyncErr.code = 'ASYNC_TRANSACTION_PROHIBITED';
      throw asyncErr;
    }
    return result;
  }

  // 否则与写锁一样 acquire failclosed LOCK_BUSY
  const lockHandle = tryAcquireLockSync(agentDir);
  if (!lockHandle) {
    const err = new Error('LOCK_BUSY: Agent state lock is held by another process');
    err.code = 'LOCK_BUSY';
    throw err;
  }

  let businessErr = null;
  let result;
  try {
    result = fn();
    if (result && typeof result.then === 'function') {
      const asyncErr = new TypeError('ASYNC_TRANSACTION_PROHIBITED: withAgentStateReadLockSync callback returned a Promise. Use withAgentStateLock for async operations to prevent premature lock release.');
      asyncErr.code = 'ASYNC_TRANSACTION_PROHIBITED';
      businessErr = asyncErr;
    }
  } catch (err) {
    businessErr = err;
  }

  let releaseErr = null;
  try {
    releaseLockSync(lockHandle);
  } catch (err) {
    releaseErr = err;
  }

  if (businessErr && releaseErr) {
    if (typeof AggregateError === 'function') {
      throw new AggregateError([businessErr, releaseErr], `${businessErr.message}; Lock release failed: ${releaseErr.message}`);
    } else {
      businessErr.releaseError = releaseErr;
      throw businessErr;
    }
  }

  if (businessErr) throw businessErr;
  if (releaseErr) throw releaseErr;
  return result;
}

async function withAgentStateLock(agentDir, fn, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 5000;
  const pollIntervalMs = typeof options.pollIntervalMs === 'number' ? options.pollIntervalMs : 15;
  const start = performance.now();

  while (true) {
    let lockHandle = null;
    try {
      lockHandle = tryAcquireLockSync(agentDir);
    } catch (acquireErr) {
      // 遇 LOCK_STALE_REQUIRES_RECOVERY 立即 failclosed 抛出，不盲目轮询
      throw acquireErr;
    }

    if (lockHandle) {
      let businessErr = null;
      let result;
      try {
        result = await fn();
      } catch (err) {
        businessErr = err;
      }

      let releaseErr = null;
      try {
        releaseLockSync(lockHandle);
      } catch (err) {
        releaseErr = err;
      }

      if (businessErr && releaseErr) {
        if (typeof AggregateError === 'function') {
          throw new AggregateError([businessErr, releaseErr], `${businessErr.message}; Lock release failed: ${releaseErr.message}`);
        } else {
          businessErr.releaseError = releaseErr;
          throw businessErr;
        }
      }

      if (businessErr) throw businessErr;
      if (releaseErr) throw releaseErr;
      return result;
    }

    const elapsed = performance.now() - start;
    if (elapsed >= timeoutMs) {
      const err = new Error(`LOCK_BUSY: Agent state lock acquisition timed out after ${timeoutMs}ms`);
      err.code = 'LOCK_BUSY';
      throw err;
    }

    const remaining = timeoutMs - elapsed;
    const waitTime = Math.min(pollIntervalMs, remaining);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
}

module.exports = {
  getProcessStartTicks,
  getBootId,
  getPidNamespace,
  getLockDir,
  checkOwnerReclaimable,
  recoverStaleLock,
  tryReclaimStaleLock,
  tryAcquireLockSync,
  releaseLockSync,
  withAgentStateLockSync,
  withAgentStateReadLockSync,
  withAgentStateLock
};

