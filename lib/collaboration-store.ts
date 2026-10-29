import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { toSlashPath } from "./paths.ts";

export type CollaborationScope = "project" | "instance";

export const MAX_STATE_FILE_SIZE = 2 * 1024 * 1024; // 2 MiB
export const MAX_TOTAL_RESOURCES = 256;
export const MAX_UNIQUE_QUEUES = 128;
export const MAX_RESOURCES_PER_ACQUIRE = 8;
export const MAX_LABEL_LENGTH = 64;
export const MAX_RESUME_TASK_LENGTH = 1200;
export const MAX_REASON_LENGTH = 500;
export const MAX_CONSUMED_HANDOFFS = 1000;
export const LABEL_REGEX = /^[a-zA-Z0-9_\-\.:]+$/;

export interface LockOwner {
  sessionId: string;
  sessionName?: string;
  token: string;
  generation: number;
  acquiredAt: string;
  ownerPid: number;
}

export interface LockQueueEntry {
  id: string;
  sequence: number;
  sessionId: string;
  sessionName?: string;
  resources: string[]; // normalized resource keys
  reason?: string;
  resumeTask?: string; // <= 1200 chars
  enqueuedAt: string;
  ownerPid: number;
}

export interface LockHandoff {
  handoffId: string;
  targetSessionId: string;
  targetSessionName?: string;
  token: string;
  generation: number;
  resumeTask?: string;
  createdAt: string;
  ownerPid: number;
  resources: string[];
}

export interface LockResourceState {
  key: string;
  label: string;
  scope: CollaborationScope;
  cwd?: string;
  status?: "held" | "handoff";
  owner?: LockOwner;
  handoff?: LockHandoff;
  queue: LockQueueEntry[];
}

export interface CollaborationStoreState {
  version: 1;
  generation: number;
  nextSequence: number;
  resources: Record<string, LockResourceState>;
  consumedHandoffIds: string[];
  updatedAt: string;
}

export interface AcquireParams {
  sessionId: string;
  sessionName?: string;
  ownerPid: number;
  scope?: CollaborationScope;
  resources: string[];
  cwd?: string;
  reason?: string;
  resumeTask?: string;
}

export interface AcquireResult {
  status: "acquired" | "queued";
  token?: string;
  generation?: number;
  queueId?: string;
  position?: number;
  resources: string[];
}

export interface ReleaseParams {
  sessionId: string;
  token: string;
  generation: number;
  resources?: string[];
}

export interface ReleaseResult {
  status: "released";
  freedResources: string[];
  handoff?: LockHandoff;
  handoffs?: LockHandoff[];
}

export interface CancelParams {
  sessionId: string;
  queueId?: string;
  resources?: string[];
}

export interface CancelResult {
  status: "cancelled";
  cancelledCount: number;
  rescheduledHandoff?: LockHandoff;
  rescheduledHandoffs?: LockHandoff[];
}

export interface AckHandoffParams {
  sessionId: string;
  handoffId: string;
  token: string;
}

export interface PublicResourceItem {
  key: string;
  label: string;
  status: "held" | "handoff";
  owner: { title: string };
  queue: Array<{
    title: string;
    reason?: string;
    resumeTask?: string;
  }>;
}

export interface CollaborationPublicStatus {
  capabilities: {
    piAutoResume: boolean;
    codexAutoResume: boolean;
    scope: "instance";
    enforcement: "cooperative";
  };
  resources: PublicResourceItem[];
  updatedAt: string;
  instanceLabel: string;
}

export function canonicalizeCwd(cwd: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(cwd);
  } catch {
    resolved = path.resolve(cwd);
  }
  resolved = toSlashPath(resolved);
  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

export function normalizeResourceKey(
  label: string,
  scope: CollaborationScope = "project",
  cwd?: string,
): string {
  if (typeof label !== "string") {
    throw new Error("资源标签必须为字符串");
  }
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new Error(`资源标签长度必须在 1 到 ${MAX_LABEL_LENGTH} 字符之间`);
  }
  if (
    trimmed.includes("..") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith(":") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new Error(`资源标签不允许路径穿越或非法前缀: "${trimmed}"`);
  }
  if (!LABEL_REGEX.test(trimmed)) {
    throw new Error(`资源标签包含非法字符: "${trimmed}"`);
  }

  if (scope === "project") {
    if (!cwd || typeof cwd !== "string") {
      throw new Error("项目作用域资源锁必须提供有效的工作目录 (cwd)");
    }
    const normalizedCwd = canonicalizeCwd(cwd);
    return `proj:${normalizedCwd}#${trimmed}`;
  } else if (scope === "instance") {
    return `inst:#${trimmed}`;
  } else {
    throw new Error(`不支持的协作锁作用域: ${String(scope)}`);
  }
}

export function parseResourceKey(key: string): {
  scope: CollaborationScope;
  cwd?: string;
  label: string;
} {
  if (key.startsWith("proj:")) {
    const hashIndex = key.lastIndexOf("#");
    if (hashIndex === -1) {
      throw new Error(`非法项目资源 key: "${key}"`);
    }
    const cwd = key.slice("proj:".length, hashIndex);
    const label = key.slice(hashIndex + 1);
    return { scope: "project", cwd, label };
  } else if (key.startsWith("inst:#")) {
    const label = key.slice("inst:#".length);
    return { scope: "instance", label };
  }
  throw new Error(`未知的资源 key 格式: "${key}"`);
}

export function sanitizeSessionTitle(title?: string): string {
  if (!title || typeof title !== "string") return "未命名会话（标题尚未生成）";
  const clean = title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "未命名会话（标题尚未生成）";
  // Filter bare UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
    return "未命名会话（标题尚未生成）";
  }
  // Filter S-number format like S865, S1234
  if (/^S\d+$/i.test(clean)) {
    return "未命名会话（标题尚未生成）";
  }
  return clean;
}

function getLinuxStartTicks(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) return null;
    const rest = stat.slice(lastParen + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch {
    return null;
  }
}

interface MutexOwnerMeta {
  nonce: string;
  host: string;
  pid: number;
  startticks: string | null;
  createdAt: number;
}

export class CollaborationStore {
  readonly stateFile: string;
  readonly lockDir: string;

  constructor(options?: { agentDir?: string; stateFile?: string }) {
    const agentDir =
      options?.agentDir ||
      process.env.PI_CODING_AGENT_DIR ||
      process.env.PI_AGENT_DIR ||
      path.join(os.homedir(), ".pi", "agent");
    this.stateFile =
      options?.stateFile ? path.resolve(options.stateFile) : path.join(agentDir, "state", "collaboration-locks.json");
    this.lockDir = this.stateFile + ".lock";
  }

  private withMutex<T>(fn: () => T): T {
    const lockDir = this.lockDir;
    const parentDir = path.dirname(lockDir);
    fs.mkdirSync(parentDir, { recursive: true });

    const metaFile = path.join(lockDir, "owner.json");
    const myNonce = crypto.randomUUID();
    const myHost = os.hostname();
    const myPid = process.pid;
    const myStartTicks = getLinuxStartTicks(myPid);

    // Never spin on the server event loop or reclaim a lock by age. Even a
    // proven-dead mutex owner cannot safely be unlinked here: two recoverers
    // could otherwise delete a newly acquired mutex (an ABA race). An orphaned
    // transaction requires explicit operator recovery, not automatic stealing.
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("协作锁事务正忙或需要异常恢复；未抢占，请稍后重试");
      }
      throw error;
    }
    const meta: MutexOwnerMeta = {
      nonce: myNonce,
      host: myHost,
      pid: myPid,
      startticks: myStartTicks,
      createdAt: Date.now(),
    };
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      // We alone created this directory. Preserve an unexpected owner file.
      try { fs.rmdirSync(lockDir); } catch {}
      throw error;
    }

    try {
      return fn();
    } finally {
      // Delete lock only if myNonce matches!
      try {
        let metaMatch = false;
        try {
          const raw = fs.readFileSync(metaFile, "utf8");
          const m = JSON.parse(raw);
          if (m?.nonce === myNonce) {
            metaMatch = true;
          }
        } catch {}
        if (metaMatch) {
          try { fs.unlinkSync(metaFile); } catch {}
          try { fs.rmdirSync(lockDir); } catch {}
        }
      } catch {}
    }
  }

  readState(): CollaborationStoreState {
    if (!fs.existsSync(this.stateFile)) {
      return {
        version: 1,
        generation: 1,
        nextSequence: 1,
        resources: {},
        consumedHandoffIds: [],
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      const stat = fs.statSync(this.stateFile);
      if (stat.size > MAX_STATE_FILE_SIZE) {
        throw new Error("协作锁状态存储文件大小超过2MiB上限，拒绝操作(fail-closed)");
      }
    } catch (err) {
      throw new Error(`无法读取协作锁状态文件: ${err instanceof Error ? err.message : String(err)}`);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.stateFile, "utf8");
    } catch (err) {
      throw new Error(`无法读取协作锁状态文件: ${err instanceof Error ? err.message : String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("协作锁状态存储损坏，拒绝操作(fail-closed)");
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== 1
    ) {
      throw new Error("协作锁状态存储损坏或版本不匹配，拒绝操作(fail-closed)");
    }

    validatePersistedState(parsed);
    const state = parsed as unknown as Record<string, unknown>;

    if (
      typeof state.generation !== "number" ||
      !Number.isInteger(state.generation) ||
      state.generation < 1
    ) {
      throw new Error("协作锁状态代际非法，拒绝操作(fail-closed)");
    }

    if (
      typeof state.updatedAt !== "string" ||
      !Array.isArray(state.consumedHandoffIds) ||
      state.consumedHandoffIds.length > MAX_CONSUMED_HANDOFFS ||
      typeof state.resources !== "object" ||
      state.resources === null ||
      Array.isArray(state.resources)
    ) {
      throw new Error("协作锁状态结构损坏，拒绝操作(fail-closed)");
    }

    const resources = state.resources as Record<string, unknown>;
    const resKeys = Object.keys(resources);
    if (resKeys.length > MAX_TOTAL_RESOURCES) {
      throw new Error(`协作锁总资源数超过 ${MAX_TOTAL_RESOURCES} 限制，拒绝操作(fail-closed)`);
    }

    const seenQueueIds = new Set<string>();

    for (const key of resKeys) {
      const r = resources[key] as Record<string, unknown>;
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        throw new Error(`协作锁资源项 [${key}] 损坏，拒绝操作(fail-closed)`);
      }

      // Check key parsing and consistency
      let parsedKey;
      try {
        parsedKey = parseResourceKey(key);
      } catch {
        throw new Error(`资源 key 格式非法 [${key}]，拒绝操作(fail-closed)`);
      }

      if (r.key !== key || r.label !== parsedKey.label || r.scope !== parsedKey.scope) {
        throw new Error(`资源项内部元数据与 key 不一致 [${key}]，拒绝操作(fail-closed)`);
      }

      if (r.scope === "project") {
        if (!r.cwd || typeof r.cwd !== "string" || r.cwd !== parsedKey.cwd || !path.isAbsolute(r.cwd)) {
          throw new Error(`项目资源 cwd 校验失败 [${key}]，拒绝操作(fail-closed)`);
        }
      }

      if (!Array.isArray(r.queue)) {
        throw new Error(`资源队列损坏 [${key}]，拒绝操作(fail-closed)`);
      }

      for (const q of r.queue as unknown[]) {
        if (!q || typeof q !== "object" || Array.isArray(q)) {
          throw new Error(`队列条目损坏 [${key}]，拒绝操作(fail-closed)`);
        }
        const qEntry = q as Record<string, unknown>;
        if (
          typeof qEntry.id !== "string" ||
          !qEntry.id ||
          typeof qEntry.sessionId !== "string" ||
          !qEntry.sessionId ||
          !Array.isArray(qEntry.resources) ||
          qEntry.resources.length === 0 ||
          qEntry.resources.length > MAX_RESOURCES_PER_ACQUIRE
        ) {
          throw new Error(`队列条目数据非法 [${key}]，拒绝操作(fail-closed)`);
        }
        seenQueueIds.add(qEntry.id);
      }

      // Validate status vs owner vs handoff
      if (r.status === "held") {
        if (!r.owner || typeof r.owner !== "object" || r.handoff) {
          throw new Error(`资源状态 [${key}] 为 held 但持有者或交接态异常，拒绝操作(fail-closed)`);
        }
        const o = r.owner as Record<string, unknown>;
        if (!o.sessionId || !o.token || typeof o.generation !== "number") {
          throw new Error(`资源持有者凭据非法 [${key}]，拒绝操作(fail-closed)`);
        }
      } else if (r.status === "handoff") {
        if (!r.handoff || typeof r.handoff !== "object" || r.owner) {
          throw new Error(`资源状态 [${key}] 为 handoff 但交接凭据异常，拒绝操作(fail-closed)`);
        }
        const h = r.handoff as Record<string, unknown>;
        if (!h.handoffId || !h.targetSessionId || !h.token || typeof h.generation !== "number") {
          throw new Error(`资源交接凭据非法 [${key}]，拒绝操作(fail-closed)`);
        }
      } else if (r.status === undefined) {
        if (r.owner !== undefined || r.handoff !== undefined) {
          throw new Error(`资源状态未标记但挂有持有者 [${key}]，拒绝操作(fail-closed)`);
        }
      } else {
        throw new Error(`未知的资源状态 [${String(r.status)}]，拒绝操作(fail-closed)`);
      }
    }

    if (seenQueueIds.size > MAX_UNIQUE_QUEUES) {
      throw new Error(`唯一排队请求数超过 ${MAX_UNIQUE_QUEUES} 限制，拒绝操作(fail-closed)`);
    }

    if (
      typeof state.nextSequence !== "number" ||
      !Number.isInteger(state.nextSequence) ||
      state.nextSequence < 1
    ) {
      (state as Record<string, unknown>).nextSequence = 1;
    }

    return parsed as CollaborationStoreState;
  }

  private writeState(state: CollaborationStoreState): void {
    // Reject an oversized or inconsistent mutation before replacing good state.
    validatePersistedState(state);
    state.updatedAt = new Date().toISOString();
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_FILE_SIZE) {
      throw new Error("协作状态容量已满，未写入无效状态");
    }
    const parentDir = path.dirname(this.stateFile);
    fs.mkdirSync(parentDir, { recursive: true });
    const tmpFile = `${this.stateFile}.tmp.${crypto.randomUUID()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      fs.renameSync(tmpFile, this.stateFile);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }

  async acquire(params: AcquireParams): Promise<AcquireResult> {
    return this.acquireSync(params);
  }

  acquireSync(params: AcquireParams): AcquireResult {
    if (!params.sessionId || typeof params.sessionId !== "string" || !params.sessionId.trim()) {
      throw new Error("无效的会话标识 (sessionId)");
    }
    const sessionId = params.sessionId.trim();
    if (!Array.isArray(params.resources) || params.resources.length === 0) {
      throw new Error("必须提供至少一个资源标签");
    }
    if (params.resources.length > MAX_RESOURCES_PER_ACQUIRE) {
      throw new Error(`单次最多申请 ${MAX_RESOURCES_PER_ACQUIRE} 个资源`);
    }
    if (params.resumeTask !== undefined) {
      if (typeof params.resumeTask !== "string") {
        throw new Error("续做任务说明 (resumeTask) 必须为字符串");
      }
      if (params.resumeTask.length > MAX_RESUME_TASK_LENGTH) {
        throw new Error(`续做任务说明过长，最多允许 ${MAX_RESUME_TASK_LENGTH} 字符`);
      }
    }
    if (params.reason !== undefined && typeof params.reason === "string" && params.reason.length > MAX_REASON_LENGTH) {
      throw new Error(`申请原因过长，最多允许 ${MAX_REASON_LENGTH} 字符`);
    }

    const scope = params.scope || "project";
    const normalizedKeys = params.resources.map((lbl) => normalizeResourceKey(lbl, scope, params.cwd));
    const uniqueKeys = Array.from(new Set(normalizedKeys)).sort();

    return this.withMutex(() => {
      const state = this.readState();

      // Find all resources currently held or in handoff for this session
      const heldKeys: string[] = [];
      const handoffKeys: string[] = [];
      for (const [k, r] of Object.entries(state.resources)) {
        if (r.status === "held" && r.owner?.sessionId === sessionId) {
          heldKeys.push(k);
        } else if (r.status === "handoff" && r.handoff?.targetSessionId === sessionId) {
          handoffKeys.push(k);
        }
      }
      heldKeys.sort();
      handoffKeys.sort();

      // Check held state of this session
      if (heldKeys.length > 0) {
        // Does requested keys match exactly the held group?
        const sameGroup =
          heldKeys.length === uniqueKeys.length &&
          heldKeys.every((k, idx) => k === uniqueKeys[idx]);

        if (sameGroup) {
          // Idempotent return of currently held lock
          const first = state.resources[uniqueKeys[0]];
          const token = first?.owner?.token;
          const gen = first?.owner?.generation;
          if (token && gen !== undefined) {
            return {
              status: "acquired",
              token,
              generation: gen,
              resources: uniqueKeys,
            };
          }
        }

        // Conservative rejection of expansion, reduction, or disjoint holding
        throw new Error(
          "拒绝保持并等待(hold-and-wait)或扩组：当前会话已持有其他资源锁，严禁扩组或同时持有多个原子组，请先 release 原资源锁",
        );
      }

      // Check if session already has pending queued entries
      let existingQueueEntry: LockQueueEntry | undefined;
      for (const res of Object.values(state.resources)) {
        if (!res.queue) continue;
        const match = res.queue.find((q) => q.sessionId === sessionId);
        if (match) {
          existingQueueEntry = match;
          break;
        }
      }

      if (existingQueueEntry) {
        const existingKeys = [...existingQueueEntry.resources].sort();
        const sameGroup =
          existingKeys.length === uniqueKeys.length &&
          existingKeys.every((k, idx) => k === uniqueKeys[idx]);

        if (sameGroup) {
          // Idempotent queued result
          const pos = this.computeQueuePosition(state, uniqueKeys, existingQueueEntry.id);
          return {
            status: "queued",
            queueId: existingQueueEntry.id,
            position: pos,
            resources: uniqueKeys,
          };
        }

        throw new Error(
          "拒绝多个未决排队组：当前会话已有未决排队项，换组请先明确调用 cancel 取消旧排队项",
        );
      }

      if (handoffKeys.length > 0) {
        if (handoffKeys.length !== uniqueKeys.length || handoffKeys.some((key, index) => key !== uniqueKeys[index])) {
          throw new Error("当前会话已有交接资源组；请接受原组或显式取消，不能换组");
        }
        // A waiter without resumeTask is intentionally manual. Its next
        // acquire accepts the durable grant instead of stranding the resource.
        const handoff = state.resources[handoffKeys[0]].handoff!;
        for (const key of handoffKeys) {
          const resource = state.resources[key];
          resource.status = "held";
          resource.owner = {
            sessionId,
            sessionName: params.sessionName,
            token: handoff.token,
            generation: handoff.generation,
            acquiredAt: new Date().toISOString(),
            ownerPid: params.ownerPid,
          };
          delete resource.handoff;
        }
        state.consumedHandoffIds = [...state.consumedHandoffIds, handoff.handoffId].slice(-MAX_CONSUMED_HANDOFFS);
        this.writeState(state);
        return { status: "acquired", token: handoff.token, generation: handoff.generation, resources: uniqueKeys };
      }

      // Check conflict:
      // 1. Any requested key currently held or handoff by another session
      // 2. Any earlier queue entry in any queue that intersects with requested keys
      let hasConflict = false;
      for (const key of uniqueKeys) {
        const res = state.resources[key];
        if (!res) continue;
        if (res.status === "held" && res.owner?.sessionId !== sessionId) {
          hasConflict = true;
          break;
        }
        if (res.status === "handoff" && res.handoff?.targetSessionId !== sessionId) {
          hasConflict = true;
          break;
        }
        if (res.queue && res.queue.length > 0) {
          hasConflict = true;
          break;
        }
      }

      // Check intersection with any existing queue entry across the whole store
      if (!hasConflict) {
        for (const res of Object.values(state.resources)) {
          if (!res.queue || res.queue.length === 0) continue;
          for (const q of res.queue) {
            if (q.resources.some((rk) => uniqueKeys.includes(rk))) {
              hasConflict = true;
              break;
            }
          }
          if (hasConflict) break;
        }
      }

      if (hasConflict) {
        // Enqueue atomically with monotonic sequence
        const sequence = state.nextSequence++;
        const queueEntry: LockQueueEntry = {
          id: crypto.randomUUID(),
          sequence,
          sessionId,
          sessionName: params.sessionName,
          resources: uniqueKeys,
          reason: params.reason,
          resumeTask: params.resumeTask,
          enqueuedAt: new Date().toISOString(),
          ownerPid: params.ownerPid,
        };

        for (const key of uniqueKeys) {
          const parsed = parseResourceKey(key);
          const res = state.resources[key] || {
            key,
            label: parsed.label,
            scope: parsed.scope,
            cwd: parsed.cwd,
            queue: [],
          };
          if (!res.queue) res.queue = [];
          res.queue.push(queueEntry);
          state.resources[key] = res;
        }

        this.writeState(state);
        const pos = this.computeQueuePosition(state, uniqueKeys, queueEntry.id);
        return {
          status: "queued",
          queueId: queueEntry.id,
          position: pos,
          resources: uniqueKeys,
        };
      }

      // No conflict: grant all resources atomically!
      const grantToken = crypto.randomUUID();
      state.generation += 1;
      const now = new Date().toISOString();

      for (const key of uniqueKeys) {
        const parsed = parseResourceKey(key);
        const res = state.resources[key] || {
          key,
          label: parsed.label,
          scope: parsed.scope,
          cwd: parsed.cwd,
          queue: [],
        };
        if (res.queue) {
          res.queue = res.queue.filter((q) => q.sessionId !== sessionId);
        } else {
          res.queue = [];
        }
        res.status = "held";
        res.owner = {
          sessionId,
          sessionName: params.sessionName,
          token: grantToken,
          generation: state.generation,
          acquiredAt: now,
          ownerPid: params.ownerPid,
        };
        delete res.handoff;
        state.resources[key] = res;
      }

      this.writeState(state);
      return {
        status: "acquired",
        token: grantToken,
        generation: state.generation,
        resources: uniqueKeys,
      };
    });
  }

  async release(params: ReleaseParams): Promise<ReleaseResult> {
    return this.releaseSync(params);
  }

  releaseSync(params: ReleaseParams): ReleaseResult {
    if (!params.sessionId || typeof params.sessionId !== "string") {
      throw new Error("无效的会话标识 (sessionId)");
    }
    if (!params.token || typeof params.token !== "string") {
      throw new Error("释放资源锁必须提供有效的 grant token");
    }
    if (typeof params.generation !== "number" || params.generation <= 0) {
      throw new Error("释放资源锁必须提供有效的 generation");
    }

    return this.withMutex(() => {
      const state = this.readState();
      const sessionId = params.sessionId.trim();
      const heldKeys: string[] = [];

      for (const [k, r] of Object.entries(state.resources)) {
        if (r.status === "held" && r.owner?.sessionId === sessionId) {
          if (r.owner.token === params.token && r.owner.generation === params.generation) {
            heldKeys.push(k);
          }
        }
      }

      if (heldKeys.length === 0) {
        throw new Error("无效的释放凭证或已过期的代际 (token/generation mismatch)");
      }

      // Strict validation if params.resources is provided: must match entire held group
      if (params.resources && Array.isArray(params.resources)) {
        const scope = parseResourceKey(heldKeys[0]).scope;
        const cwd = parseResourceKey(heldKeys[0]).cwd;
        const providedKeys = params.resources.map((lbl) => {
          if (lbl.startsWith("proj:") || lbl.startsWith("inst:#")) return lbl;
          return normalizeResourceKey(lbl, scope, cwd);
        });
        const sortedHeld = [...heldKeys].sort();
        const sortedProvided = Array.from(new Set(providedKeys)).sort();

        const match =
          sortedHeld.length === sortedProvided.length &&
          sortedHeld.every((k, i) => k === sortedProvided[i]);

        if (!match) {
          throw new Error("释放资源列表与获授资源组不一致，严禁部分释放或跨组释放");
        }
      }

      // Release matching resources
      for (const key of heldKeys) {
        const res = state.resources[key];
        if (res) {
          delete res.status;
          delete res.owner;
          delete res.handoff;
        }
      }

      // Schedule all eligible waiting groups
      const handoffs = this.scheduleQueue(state);

      this.writeState(state);
      return {
        status: "released",
        freedResources: heldKeys,
        handoffs,
        handoff: handoffs[0],
      };
    });
  }

  async cancel(params: CancelParams): Promise<CancelResult> {
    return this.cancelSync(params);
  }

  cancelSync(params: CancelParams): CancelResult {
    if (!params.sessionId || typeof params.sessionId !== "string") {
      throw new Error("无效的会话标识 (sessionId)");
    }
    const sessionId = params.sessionId.trim();

    return this.withMutex(() => {
      const state = this.readState();
      const cancelledQueueIds = new Set<string>();

      // 1. Remove queue entries matching sessionId
      for (const res of Object.values(state.resources)) {
        if (res.queue && res.queue.length > 0) {
          res.queue = res.queue.filter((q) => {
            if (q.sessionId !== sessionId) return true;
            if (params.queueId && q.id !== params.queueId) return true;
            cancelledQueueIds.add(q.id);
            return false;
          });
        }

        // 2. Check if resource is currently in handoff for this session
        if (res.status === "handoff" && res.handoff?.targetSessionId === sessionId) {
          cancelledQueueIds.add(res.handoff.handoffId);
          delete res.status;
          delete res.handoff;
        }
      }

      const cancelledCount = cancelledQueueIds.size;

      // Reschedule whenever any queue entry or handoff is cancelled
      let rescheduledHandoffs: LockHandoff[] = [];
      if (cancelledCount > 0) {
        rescheduledHandoffs = this.scheduleQueue(state);
      }

      this.writeState(state);
      return {
        status: "cancelled",
        cancelledCount,
        rescheduledHandoffs,
        rescheduledHandoff: rescheduledHandoffs[0],
      };
    });
  }

  async ackHandoff(params: AckHandoffParams): Promise<boolean> {
    return this.ackHandoffSync(params);
  }

  ackHandoffSync(params: AckHandoffParams): boolean {
    if (!params.sessionId || !params.handoffId || !params.token) {
      return false;
    }
    const sessionId = params.sessionId.trim();

    return this.withMutex(() => {
      const state = this.readState();
      const matchingKeys: string[] = [];

      for (const [k, r] of Object.entries(state.resources)) {
        if (
          r.status === "handoff" &&
          r.handoff?.handoffId === params.handoffId &&
          r.handoff.targetSessionId === sessionId &&
          r.handoff.token === params.token
        ) {
          matchingKeys.push(k);
        }
      }

      if (matchingKeys.length === 0) {
        return false;
      }

      const first = state.resources[matchingKeys[0]]!.handoff!;
      // CRITICAL: keep generation constant! Do NOT bump generation on ack!
      const now = new Date().toISOString();

      for (const key of matchingKeys) {
        const res = state.resources[key]!;
        res.status = "held";
        res.owner = {
          sessionId,
          sessionName: first.targetSessionName,
          token: first.token,
          generation: first.generation, // Preserves the exact generation delivered in handoff!
          acquiredAt: now,
          ownerPid: first.ownerPid,
        };
        delete res.handoff;
      }

      if (!state.consumedHandoffIds.includes(params.handoffId)) {
        state.consumedHandoffIds.push(params.handoffId);
        if (state.consumedHandoffIds.length > MAX_CONSUMED_HANDOFFS) {
          state.consumedHandoffIds = state.consumedHandoffIds.slice(-MAX_CONSUMED_HANDOFFS);
        }
      }

      this.writeState(state);
      return true;
    });
  }

  private scheduleQueue(state: CollaborationStoreState): LockHandoff[] {
    const entryMap = new Map<string, LockQueueEntry>();
    for (const res of Object.values(state.resources)) {
      if (!res.queue) continue;
      for (const q of res.queue) {
        if (!entryMap.has(q.id)) {
          entryMap.set(q.id, q);
        }
      }
    }

    if (entryMap.size === 0) return [];

    // Sort strictly by monotonic sequence
    const sortedEntries = Array.from(entryMap.values()).sort((a, b) => a.sequence - b.sequence);

    // Track keys that are currently busy (held or already handoff)
    const unavailableKeys = new Set<string>();
    for (const [k, r] of Object.entries(state.resources)) {
      if (r.status === "held" || r.status === "handoff") {
        unavailableKeys.add(k);
      }
    }

    // Keys that must not be barged into because an earlier request is waiting for them
    const blockedKeys = new Set<string>();
    const scheduledHandoffs: LockHandoff[] = [];

    for (const entry of sortedEntries) {
      // 1. Does this entry intersect with any keys blocked by earlier requests?
      const intersectsBlocked = entry.resources.some((k) => blockedKeys.has(k));
      if (intersectsBlocked) {
        // Earlier waiter has priority on an intersecting resource. Entry cannot barge in!
        for (const k of entry.resources) blockedKeys.add(k);
        continue;
      }

      // 2. Are all requested resources currently available?
      const allAvailable = entry.resources.every((k) => !unavailableKeys.has(k));
      if (!allAvailable) {
        // Some requested resources are currently held/handoff. Entry must wait.
        // Block all its requested keys so later intersecting requests cannot jump the queue!
        for (const k of entry.resources) blockedKeys.add(k);
        continue;
      }

      // 3. All resources available and no earlier intersecting request -> GRANT HANDOFF!
      const handoffId = crypto.randomUUID();
      const newToken = crypto.randomUUID();
      state.generation += 1;
      const now = new Date().toISOString();

      const handoff: LockHandoff = {
        handoffId,
        targetSessionId: entry.sessionId,
        targetSessionName: entry.sessionName,
        token: newToken,
        generation: state.generation,
        resumeTask: entry.resumeTask,
        createdAt: now,
        ownerPid: entry.ownerPid,
        resources: entry.resources,
      };

      for (const key of entry.resources) {
        const parsed = parseResourceKey(key);
        const res = state.resources[key] || {
          key,
          label: parsed.label,
          scope: parsed.scope,
          cwd: parsed.cwd,
          queue: [],
        };

        if (res.queue) {
          res.queue = res.queue.filter((q) => q.id !== entry.id);
        } else {
          res.queue = [];
        }
        res.status = "handoff";
        res.handoff = handoff;
        state.resources[key] = res;
        unavailableKeys.add(key);
      }

      scheduledHandoffs.push(handoff);
    }

    return scheduledHandoffs;
  }

  private computeQueuePosition(state: CollaborationStoreState, keys: string[], queueId: string): number {
    let maxPos = 1;
    for (const key of keys) {
      const res = state.resources[key];
      if (!res?.queue) continue;
      const idx = res.queue.findIndex((q) => q.id === queueId);
      if (idx !== -1) {
        maxPos = Math.max(maxPos, idx + 1);
      }
    }
    return maxPos;
  }

  getPublicStatus(instanceLabel: string): CollaborationPublicStatus {
    const state = this.readState();
    const resources: PublicResourceItem[] = [];

    for (const [key, res] of Object.entries(state.resources)) {
      if (res.status === "held" || res.status === "handoff") {
        const ownerTitle =
          res.status === "held"
            ? sanitizeSessionTitle(res.owner?.sessionName)
            : sanitizeSessionTitle(res.handoff?.targetSessionName);

        const queue = (res.queue || []).map((q) => ({
          title: sanitizeSessionTitle(q.sessionName),
          reason: q.reason,
          resumeTask: q.resumeTask,
        }));

        resources.push({
          key,
          label: res.label,
          status: res.status,
          owner: { title: ownerTitle },
          queue,
        });
      }
    }

    resources.sort((a, b) => a.key.localeCompare(b.key));

    return {
      capabilities: {
        piAutoResume: true,
        codexAutoResume: false,
        scope: "instance",
        enforcement: "cooperative",
      },
      resources,
      updatedAt: state.updatedAt,
      instanceLabel: instanceLabel || "Pi Web Plus",
    };
  }
}

function validatePersistedState(value: unknown): asserts value is CollaborationStoreState {
  const invalid = (): never => { throw new Error("协作状态结构或关联凭据损坏，拒绝操作(fail-closed)"); };
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max: number, optional = false): void => {
    if (optional && v === undefined) return;
    if (typeof v !== "string" || (!optional && !v) || v.length > max) invalid();
  };
  const integer = (v: unknown): void => { if (!Number.isSafeInteger(v) || (v as number) < 1) invalid(); };
  const date = (v: unknown): void => { text(v, 40); if (!Number.isFinite(Date.parse(v as string))) invalid(); };
  const keys = (v: unknown): string[] => {
    if (!Array.isArray(v) || !v.length || v.length > MAX_RESOURCES_PER_ACQUIRE || new Set(v).size !== v.length) return invalid();
    for (const k of v) text(k, 8192);
    return v as string[];
  };
  const state = record(value);
  if (state.version !== 1) invalid();
  integer(state.generation); integer(state.nextSequence); date(state.updatedAt);
  const resources = record(state.resources);
  if (Object.keys(resources).length > MAX_TOTAL_RESOURCES) invalid();
  if (!Array.isArray(state.consumedHandoffIds) || state.consumedHandoffIds.length > MAX_CONSUMED_HANDOFFS) invalid();
  for (const id of state.consumedHandoffIds as unknown[]) text(id, 128);
  const queues = new Map<string, Record<string, unknown>>();
  const leaseBySession = new Map<string, string>();
  for (const [key, raw] of Object.entries(resources)) {
    const r = record(raw), parsed = parseResourceKey(key);
    text(parsed.label, MAX_LABEL_LENGTH);
    if (!LABEL_REGEX.test(parsed.label) || parsed.label.includes("..") || parsed.label.startsWith(".") || parsed.label.startsWith(":")) invalid();
    if (r.key !== key || r.label !== parsed.label || r.scope !== parsed.scope) invalid();
    if (parsed.scope === "project" && (r.cwd !== parsed.cwd || !parsed.cwd || !path.isAbsolute(parsed.cwd))) invalid();
    if (!Array.isArray(r.queue) || r.queue.length > MAX_UNIQUE_QUEUES) invalid();
    for (const rawQueue of r.queue as unknown[]) {
      const q = record(rawQueue);
      text(q.id, 128); text(q.sessionId, 200); text(q.sessionName, 120, true);
      text(q.reason, MAX_REASON_LENGTH, true); text(q.resumeTask, MAX_RESUME_TASK_LENGTH, true);
      integer(q.sequence); integer(q.ownerPid); date(q.enqueuedAt);
      if ((q.sequence as number) >= (state.nextSequence as number) || !keys(q.resources).includes(key)) invalid();
      const previous = queues.get(q.id as string);
      if (previous && JSON.stringify(previous) !== JSON.stringify(q)) invalid();
      queues.set(q.id as string, q);
    }
    if (r.status === undefined) { if (r.owner !== undefined || r.handoff !== undefined) invalid(); continue; }
    if (r.status !== "held" && r.status !== "handoff") invalid();
    if (r.status === "held" ? r.handoff !== undefined : r.owner !== undefined) invalid();
    const lease = record(r.status === "held" ? r.owner : r.handoff);
    const session = r.status === "held" ? lease.sessionId : lease.targetSessionId;
    text(session, 200); text(lease.token, 128); integer(lease.generation); integer(lease.ownerPid);
    if ((lease.generation as number) > (state.generation as number)) invalid();
    text(r.status === "held" ? lease.sessionName : lease.targetSessionName, 120, true);
    date(r.status === "held" ? lease.acquiredAt : lease.createdAt);
    const identity = `${lease.token}:${lease.generation}`;
    if (leaseBySession.has(session as string) && leaseBySession.get(session as string) !== identity) invalid();
    leaseBySession.set(session as string, identity);
    if (r.status === "handoff") {
      text(lease.handoffId, 128); text(lease.resumeTask, MAX_RESUME_TASK_LENGTH, true);
      if ((state.consumedHandoffIds as string[]).includes(lease.handoffId as string)) invalid();
      const group = keys(lease.resources);
      if (!group.includes(key)) invalid();
      for (const member of group) {
        const peer = record(resources[member]);
        if (peer.status !== "handoff" || JSON.stringify(peer.handoff) !== JSON.stringify(lease)) invalid();
      }
    }
  }
  if (queues.size > MAX_UNIQUE_QUEUES) invalid();
  const waitingSessions = new Set<string>();
  for (const q of queues.values()) {
    if (waitingSessions.has(q.sessionId as string) || leaseBySession.has(q.sessionId as string)) invalid();
    waitingSessions.add(q.sessionId as string);
    for (const key of keys(q.resources)) {
      const resource = record(resources[key]);
      if (!Array.isArray(resource.queue) || !resource.queue.some((item) => record(item).id === q.id)) invalid();
    }
  }
}

let storeSingleton: CollaborationStore | undefined;
let storeSingletonAgentDir: string | undefined;

export function getCollaborationStore(options?: { agentDir?: string; stateFile?: string }): CollaborationStore {
  if (options?.stateFile || options?.agentDir) {
    return new CollaborationStore(options);
  }
  const currentAgentDir =
    process.env.PI_CODING_AGENT_DIR ||
    process.env.PI_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent");
  if (!storeSingleton || storeSingletonAgentDir !== currentAgentDir) {
    storeSingleton = new CollaborationStore({ agentDir: currentAgentDir });
    storeSingletonAgentDir = currentAgentDir;
  }
  return storeSingleton;
}
