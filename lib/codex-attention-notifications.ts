import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

export type CodexAttentionKind = "question" | "manual-action";

export interface CodexAttentionInput {
  sessionId: string;
  requestId: string;
  kind: CodexAttentionKind;
}

export type CodexAttentionEnqueueResult = "queued" | "queue-full" | "invalid";

type DeliveryStatus = "attempting" | "sent" | "rejected" | "unknown";
type DeliveryRecord = {
  kind: CodexAttentionKind;
  status: DeliveryStatus;
  attemptedAt: string;
  updatedAt: string;
  reason?: string;
};
type DeliveryLedger = { version: 1; entries: Record<string, DeliveryRecord> };
type FeishuRuntime = {
  readConfig(path?: string): {
    valid: boolean;
    enabled: boolean;
    webhookUrl?: string;
    secret?: string;
    baseUrl?: string;
  };
  sanitizeBaseUrl(rawUrl: string | undefined, sessionId: string): string;
  generateSign(secret: string, timestamp: string): string;
  sendFeishuNotification(options: {
    webhookUrl: string;
    payload: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown>;
};

const LEDGER_VERSION = 1;
const MAX_QUEUED_NOTIFICATIONS = 32;
const NOTIFICATION_TIMEOUT_MS = 5_000;
const QUEUE_KEY = Symbol.for("pi-web:codex-attention-feishu-queue");
const globals = globalThis as unknown as Record<symbol, QueueState | undefined>;

type QueueState = { tail: Promise<void>; queued: number };

function queueState(): QueueState {
  return (globals[QUEUE_KEY] ||= { tail: Promise.resolve(), queued: 0 });
}

function formatNotification(input: CodexAttentionInput, sessionUrl: string): string {
  const heading = input.kind === "question" ? "Codex 有问题需要确认" : "Codex 有操作需要你处理";
  // Match the existing notification privacy contract: no model/tool arguments,
  // conversation titles, question text or answers leave the server.
  return `${heading}\n${sessionUrl}`;
}

function ledgerPath(agentDir: string): string {
  return join(agentDir, "state", "codex-attention-notifications.json");
}

function parseLedger(raw: string): DeliveryLedger {
  const value = JSON.parse(raw) as Partial<DeliveryLedger>;
  if (!value || value.version !== LEDGER_VERSION || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
    throw new Error("Invalid Codex attention notification ledger");
  }
  return value as DeliveryLedger;
}

async function withLedger<T>(agentDir: string, work: (ledger: DeliveryLedger, save: () => Promise<void>) => Promise<T>): Promise<T> {
  const file = ledgerPath(agentDir);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, JSON.stringify({ version: LEDGER_VERSION, entries: {} }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const release = await lockfile.lock(file, { realpath: false,
    retries: { retries: 2, minTimeout: 50, maxTimeout: 200 } });
  try {
    const ledger = parseLedger(await readFile(file, "utf8"));
    const save = async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(ledger), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    };
    return await work(ledger, save);
  } finally {
    await release();
  }
}

function requestKey(input: CodexAttentionInput): string {
  return createHash("sha256").update(`${input.sessionId}\0${input.requestId}`).digest("hex");
}

async function loadFeishuRuntime(agentDir: string): Promise<FeishuRuntime> {
  const helperPath = join(agentDir, "extensions", "ask-user-feishu-notify", "notify.mjs");
  return import(/* webpackIgnore: true */ pathToFileURL(helperPath).href) as Promise<FeishuRuntime>;
}

function failureStatus(error: unknown): Pick<DeliveryRecord, "status" | "reason"> {
  const message = error instanceof Error ? error.message : "";
  const httpStatus = /^HTTP error (\d{3})$/.exec(message)?.[1];
  if (httpStatus) return { status: Number(httpStatus) >= 500 ? "unknown" : "rejected", reason: `http_${httpStatus}` };
  const feishuCode = /^Feishu rejected notification \((\d+|invalid response)\)$/.exec(message)?.[1];
  if (feishuCode) return { status: "rejected", reason: `feishu_${feishuCode.replace(/\s+/g, "_")}` };
  return { status: "unknown", reason: "network_or_timeout" };
}

async function sendOne(input: CodexAttentionInput): Promise<void> {
  const agentDir = getAgentDir();
  const runtime = await loadFeishuRuntime(agentDir);
  const config = runtime.readConfig(join(agentDir, "ask-user-feishu-notify.json"));
  if (!config.valid || !config.enabled || !config.webhookUrl) return;

  const sessionUrl = runtime.sanitizeBaseUrl(config.baseUrl, input.sessionId);
  if (!sessionUrl) return;

  const key = requestKey(input);
  const reserved = await withLedger(agentDir, async (ledger, save) => {
    if (ledger.entries[key]) return false;
    const now = new Date().toISOString();
    ledger.entries[key] = { kind: input.kind, status: "attempting", attemptedAt: now, updatedAt: now };
    await save();
    return true;
  });
  if (!reserved) return;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload: Record<string, unknown> = {
    msg_type: "text",
    content: { text: formatNotification(input, sessionUrl) },
  };
  if (config.secret?.trim()) {
    payload.timestamp = timestamp;
    payload.sign = runtime.generateSign(config.secret.trim(), timestamp);
  }

  let outcome: Pick<DeliveryRecord, "status" | "reason"> = { status: "sent" };
  try {
    await runtime.sendFeishuNotification({ webhookUrl: config.webhookUrl, payload, timeoutMs: NOTIFICATION_TIMEOUT_MS });
  } catch (error) {
    outcome = failureStatus(error);
  }

  await withLedger(agentDir, async (ledger, save) => {
    const record = ledger.entries[key];
    if (!record) return;
    record.status = outcome.status;
    record.updatedAt = new Date().toISOString();
    if (outcome.reason) record.reason = outcome.reason;
    await save();
  });
}

/**
 * Queue a Codex attention notice without awaiting Feishu I/O. Invoke only when a
 * pending request is observed; persisted request/session hashes prevent repeats
 * across refreshes and process restarts. One POST is attempted per request ID.
 */
export function notifyCodexAttention(input: CodexAttentionInput): CodexAttentionEnqueueResult {
  if (!input || typeof input.sessionId !== "string" || !input.sessionId.trim()
    || typeof input.requestId !== "string" || !input.requestId.trim()
    || (input.kind !== "question" && input.kind !== "manual-action")) return "invalid";

  const queue = queueState();
  if (queue.queued >= MAX_QUEUED_NOTIFICATIONS) return "queue-full";
  const item: CodexAttentionInput = {
    sessionId: input.sessionId.trim(),
    requestId: input.requestId.trim(),
    kind: input.kind,
  };
  queue.queued++;
  queue.tail = queue.tail.then(() => sendOne(item)).catch(() => {}).finally(() => { queue.queued--; });
  return "queued";
}

export async function codexAttentionNotificationsEnabled(): Promise<boolean> {
  try {
    const directory = getAgentDir();
    const runtime = await loadFeishuRuntime(directory);
    const config = runtime.readConfig(join(directory, "ask-user-feishu-notify.json"));
    return config.valid && config.enabled && Boolean(config.webhookUrl);
  } catch { return false; }
}

/** Allows shutdown and focused acceptance to await only this module's queued work. */
export async function flushCodexAttentionNotifications(): Promise<void> {
  await queueState().tail;
}
