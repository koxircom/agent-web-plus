import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  OdooLanClient,
  OdooLanCommand,
  OdooLanConfig,
  OdooLanResult,
  OdooLanSnapshot,
} from "./odoo-lan-types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB
const ODOO_LAN_CLIENT_REGISTRY = Symbol.for("odoo-lan:client-registry");

export function getDefaultConfigPath(): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ||
    process.env.PI_AGENT_DIR ||
    "/root/.pi/agent";
  return path.join(agentDir, "state/odoo-lan-config.json");
}

function validateSnapshot(data: any): OdooLanSnapshot {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid snapshot: expected object");
  }
  if (data.protocol !== "odoo-addon-lan-v1") {
    throw new Error(
      `Invalid snapshot: expected protocol 'odoo-addon-lan-v1', got '${data.protocol}'`
    );
  }
  if (data.version !== 1) {
    throw new Error(`Invalid snapshot: expected version 1, got ${data.version}`);
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) {
    throw new Error("Invalid snapshot: revision number is required");
  }
  if (typeof data.updatedAt !== "string") {
    throw new Error("Invalid snapshot: updatedAt string is required");
  }
  if (!Array.isArray(data.resources)) {
    throw new Error("Invalid snapshot: resources must be an array");
  }
  for (const r of data.resources) {
    if (
      !r ||
      typeof r !== "object" ||
      !r.resource ||
      typeof r.resource !== "string"
    ) {
      throw new Error("Invalid snapshot: resource entry must have a resource name");
    }
    if (
      r.status !== "held" &&
      r.status !== "handoff" &&
      r.status !== "unknown"
    ) {
      throw new Error(`Invalid snapshot: resource status '${r.status}' is invalid`);
    }
    if (!Array.isArray(r.queue)) {
      throw new Error(`Invalid snapshot: resource '${r.resource}' queue must be an array`);
    }
    const actor=(value:any)=>Boolean(value&&typeof value==='object'&&typeof value.sessionId==='string'&&value.sessionId&&typeof value.instanceId==='string'&&value.instanceId&&typeof value.instanceLabel==='string'&&typeof value.sessionName==='string');
    const credentials=(value:any)=>Boolean(typeof value.token==='string'&&value.token&&Number.isSafeInteger(value.generation)&&value.generation>0);
    if(r.status==='held'&&(!actor(r.owner)||(r.owner.legacy!==true&&!credentials(r.owner))))throw new Error('Invalid snapshot: uncertified owner');
    if(r.status==='handoff'&&(!actor(r.handoff)||!credentials(r.handoff)||typeof r.handoff.handoffId!=='string'||!r.handoff.handoffId||typeof r.handoff.resumeTask!=='string'))throw new Error('Invalid snapshot: uncertified handoff');
    for(const queue of r.queue)if(!actor(queue)||typeof queue.queueId!=='string'||!queue.queueId||!Number.isSafeInteger(queue.sequence)||queue.sequence<1||typeof queue.resumeTask!=='string')throw new Error('Invalid snapshot: corrupt queue entry');
  }
  if(new Set(data.resources.map((resource:any)=>resource.resource)).size!==data.resources.length)throw new Error('Invalid snapshot: duplicate resource identity');
  return data as OdooLanSnapshot;
}

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

class OdooLanClientImpl implements OdooLanClient {
  private configFile: string;
  private timeoutMs: number;
  private cachedConfig: OdooLanConfig | null = null;
  private child: ChildProcess | null = null;
  private currentChildGen = 0;
  private cachedSnapshot: OdooLanSnapshot | undefined = undefined;
  private subscribers: Set<() => void> = new Set();
  private pending: Map<string, PendingRequest> = new Map();
  private reqCounter = 0;
  private stderrBuffer = "";
  private isClosing = false;

  constructor(options?: { configFile?: string; timeoutMs?: number }) {
    this.configFile = options?.configFile || getDefaultConfigPath();
    this.timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  private loadConfig(): OdooLanConfig | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.configFile, "utf-8");
    } catch (err: any) {
      if(err?.code==='ENOENT')return null;
      throw new Error(
        `Failed to read Odoo LAN configuration in ${this.configFile}: ${err?.message || err}`
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: invalid JSON (${e?.message || e})`
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: expected object`
      );
    }

    if (typeof parsed.enabled !== "boolean") {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: missing or invalid 'enabled' boolean field`
      );
    }

    if (parsed.enabled === false) {
      return null;
    }

    if (parsed.version !== 1) {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: expected version 1, got ${parsed.version}`
      );
    }
    if (!parsed.instanceId || typeof parsed.instanceId !== "string") {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: instanceId string is required`
      );
    }
    if (!parsed.instanceLabel || typeof parsed.instanceLabel !== "string") {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: instanceLabel string is required`
      );
    }
    if (parsed.role !== "authority" && parsed.role !== "client") {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: invalid role '${parsed.role}'`
      );
    }
    if (!parsed.authorityScript || typeof parsed.authorityScript !== "string") {
      throw new Error(
        `Malformed Odoo LAN configuration in ${this.configFile}: authorityScript is required`
      );
    }
    if (parsed.role === "client") {
      const ssh = parsed.ssh;
      if (
        !ssh ||
        typeof ssh !== "object" ||
        !ssh.host ||
        typeof ssh.host !== "string" ||
        !ssh.user ||
        typeof ssh.user !== "string" ||
        !ssh.identityFile ||
        typeof ssh.identityFile !== "string" ||
        !ssh.container ||
        typeof ssh.container !== "string"
      ) {
        throw new Error(
          `Malformed Odoo LAN configuration in ${this.configFile}: client role requires complete ssh config (host, user, identityFile, container)`
        );
      }
    }
    return parsed as OdooLanConfig;
  }

  isConfigured(): boolean {
    const cfg = this.loadConfig();
    return cfg !== null && cfg.enabled === true;
  }

  get instanceId(): string {
    const cfg = this.loadConfig();
    return cfg?.instanceId || "";
  }

  get instanceLabel(): string {
    const cfg = this.loadConfig();
    return cfg?.instanceLabel || "";
  }

  getCachedSnapshot(): OdooLanSnapshot | undefined {
    return this.cachedSnapshot;
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers(): void {
    for (const sub of Array.from(this.subscribers)) {
      try {
        sub();
      } catch {
        // Ignore subscriber exceptions
      }
    }
  }

  private invalidateSnapshotAndNotify(): void {
    if (this.cachedSnapshot !== undefined) {
      this.cachedSnapshot = undefined;
      this.notifySubscribers();
    }
  }

  private processIncomingLine(line: string, childGen: number): void {
    if (this.currentChildGen !== childGen) return;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Corrupt JSON frame: invalidate snapshot to prevent stale green view
      this.invalidateSnapshotAndNotify();
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.invalidateSnapshotAndNotify();
      return;
    }

    // Notification event
    if (parsed.event === "changed") {
      try {
        const validated = validateSnapshot(parsed.snapshot);
        this.cachedSnapshot = validated;
        this.notifySubscribers();
      } catch {
        this.invalidateSnapshotAndNotify();
      }
      return;
    }

    // RPC response
    if (parsed.id) {
      const req = this.pending.get(parsed.id);
      if (req) {
        this.pending.delete(parsed.id);
        clearTimeout(req.timer);

        if (parsed.ok) {
          const res = parsed.result;
          try {
            if (res?.snapshot) {
              this.cachedSnapshot = validateSnapshot(res.snapshot);
              this.notifySubscribers();
            } else if (res?.protocol === "odoo-addon-lan-v1") {
              this.cachedSnapshot = validateSnapshot(res);
              this.notifySubscribers();
            }
            req.resolve(res);
          } catch {
            this.invalidateSnapshotAndNotify();
            req.reject(
              new Error("Malformed snapshot in response from Odoo LAN authority")
            );
          }
        } else {
          req.reject(new Error(parsed.error || "Odoo LAN command failed"));
        }
      }
      return;
    }

    // Unknown frame structure received: invalidate cachedSnapshot
    this.invalidateSnapshotAndNotify();
  }

  private ensureChild(): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }

    const config = this.loadConfig();
    if (!config || !config.enabled) {
      throw new Error("Odoo LAN client is not configured or disabled");
    }

    this.cachedConfig = config;
    const childGen = ++this.currentChildGen;
    let proc: ChildProcess;

    if (config.role === "authority") {
      const args = [
        config.authorityScript,
        "serve",
        "--instance-id",
        config.instanceId,
        "--instance-label",
        config.instanceLabel,
      ];
      if (config.stateRoot) {
        args.push("--state-root", config.stateRoot);
      }
      proc = spawn("python3", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      const ssh = config.ssh!;
      const port = ssh.port || 22;
      const args = [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        "-p",
        String(port),
        "-i",
        ssh.identityFile,
        `${ssh.user}@${ssh.host}`,
        "/usr/local/bin/docker",
        "exec",
        "-i",
        ssh.container,
        "python3",
        config.authorityScript,
        "serve",
        "--instance-id",
        config.instanceId,
        "--instance-label",
        config.instanceLabel,
      ];
      if (config.stateRoot) args.push("--state-root", config.stateRoot);
      proc = spawn("ssh", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    this.child = proc;
    this.stderrBuffer = "";

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        if (this.currentChildGen !== childGen) return;
        this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-65536);
      });
    }

    if (proc.stdout) {
      let rawBuffer = Buffer.alloc(0);

      proc.stdout.on("data", (chunk: Buffer) => {
        if (this.currentChildGen !== childGen) return;

        rawBuffer = Buffer.concat([rawBuffer, chunk]);
        if (rawBuffer.length > MAX_FRAME_BYTES * 2) {
          // Bounded stream buffer protection against infinite readline expansion
          rawBuffer = Buffer.alloc(0);
          this.invalidateSnapshotAndNotify();
          return;
        }

        while (true) {
          const newlineIdx = rawBuffer.indexOf(0x0a);
          if (newlineIdx === -1) {
            if (rawBuffer.length > MAX_FRAME_BYTES) {
              rawBuffer = Buffer.alloc(0);
              this.invalidateSnapshotAndNotify();
            }
            break;
          }

          const lineBuf = rawBuffer.subarray(0, newlineIdx);
          rawBuffer = rawBuffer.subarray(newlineIdx + 1);

          if (lineBuf.length > MAX_FRAME_BYTES) {
            this.invalidateSnapshotAndNotify();
            continue;
          }

          const line = lineBuf.toString("utf-8").trim();
          if (!line) continue;

          this.processIncomingLine(line, childGen);
        }
      });
    }

    const cleanup = () => {
      if (this.currentChildGen !== childGen) return;
      if (this.child === proc) {
        this.child = null;
        this.cachedSnapshot = undefined;
        this.notifySubscribers();

        // Reject inflight requests; fail-closed without retrying mutations
        for (const [id, req] of Array.from(this.pending.entries())) {
          this.pending.delete(id);
          clearTimeout(req.timer);
          req.reject(
            new Error(
              `Odoo LAN process disconnected: ${this.stderrBuffer.slice(-200) || "transport closed"}`
            )
          );
        }
      }
    };

    proc.on("error", () => cleanup());
    proc.on("close", () => cleanup());

    return proc;
  }

  async status(): Promise<OdooLanSnapshot> {
    const res = await this.request({ action: "status" });
    if ((res as any)?.protocol === "odoo-addon-lan-v1") {
      return res as OdooLanSnapshot;
    }
    if ((res as any)?.snapshot) {
      return (res as any).snapshot as OdooLanSnapshot;
    }
    throw new Error("Invalid status response from Odoo LAN authority");
  }

  async request(
    command: OdooLanCommand
  ): Promise<OdooLanResult | OdooLanSnapshot> {
    const child = this.ensureChild();
    const childGen = this.currentChildGen;
    const reqId = `req-${++this.reqCounter}-${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId);
          // Invalidate cachedSnapshot on timeout: do not return stale green view
          this.invalidateSnapshotAndNotify();
          reject(
            new Error(
              `Odoo LAN request '${command.action}' timed out after ${this.timeoutMs}ms`
            )
          );
        }
      }, this.timeoutMs);

      this.pending.set(reqId, { resolve, reject, timer });

      // Ensure instanceId cannot be forged by toolJSON
      const safeCommand = { ...command };
      if (safeCommand.actor) {
        const safeActor = { ...safeCommand.actor };
        delete (safeActor as any).instanceId;
        delete (safeActor as any).instanceLabel;
        safeCommand.actor = safeActor;
      }

      const payload = JSON.stringify({ id: reqId, command: safeCommand }) + "\n";
      if (!child.stdin || !child.stdin.writable) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        this.invalidateSnapshotAndNotify();
        reject(new Error("Odoo LAN child stdin is not writable"));
        return;
      }

      child.stdin.write(payload, "utf-8", (err) => {
        if (err) {
          if (this.currentChildGen === childGen) {
            this.pending.delete(reqId);
            clearTimeout(timer);
            this.invalidateSnapshotAndNotify();
            reject(
              new Error(`Failed to write to Odoo LAN stdin: ${err.message}`)
            );
          }
        }
      });
    });
  }

  async close(): Promise<void> {
    this.isClosing = true;

    if (this.child) {
      const proc = this.child;
      this.child = null;

      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.end();
        }
      } catch {}

      try {
        proc.kill("SIGTERM");
      } catch {}

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
          resolve();
        }, 500);

        proc.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.cachedSnapshot = undefined;
    for (const [id, req] of Array.from(this.pending.entries())) {
      this.pending.delete(id);
      clearTimeout(req.timer);
      req.reject(new Error("Odoo LAN client closed"));
    }
    this.notifySubscribers();
  }
}

export function getOdooLanClient(options?: {
  configFile?: string;
  timeoutMs?: number;
}): OdooLanClient {
  const globalObj = globalThis as any;
  if (!globalObj[ODOO_LAN_CLIENT_REGISTRY]) {
    globalObj[ODOO_LAN_CLIENT_REGISTRY] = new Map<string, OdooLanClient>();
  }
  const registry: Map<string, OdooLanClient> = globalObj[ODOO_LAN_CLIENT_REGISTRY];
  const resolvedConfig = options?.configFile
    ? path.resolve(options.configFile)
    : path.resolve(getDefaultConfigPath());

  const key = `${resolvedConfig}::${options?.timeoutMs || DEFAULT_TIMEOUT_MS}`;
  if (registry.has(key)) {
    return registry.get(key)!;
  }
  const client = new OdooLanClientImpl(options);
  registry.set(key, client);
  return client;
}
