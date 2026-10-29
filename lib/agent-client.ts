import { readNoticeRecovery, type NoticeRecovery } from "./notice-recovery";
// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import type { PendingPromptSubmission } from "./prompt-submissions";
import type { ExtensionUiRequest, ExtensionUiDeliveryResult } from "./types";
import { retainPromptSubmission, markPromptSubmissionUncertain, reconcilePromptSubmission, releasePromptSubmission } from "./prompt-submissions";
import { markPromptSubmissionsRecalled } from "./prompt-submissions";
import { persistDraftNow } from "./draft-store";

// Network ownership is tab-local; restored backups have no active POST.
const dispatchingPrompts = new Set<string>();
export const isPromptSubmissionDispatching = (requestId: string) => dispatchingPrompts.has(requestId);

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
    public readonly recovery?: NoticeRecovery,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options?: { onPromptIdentified?: (identity: { requestId: string; sessionId: string }) => void; onPromptRegistered?: (identity: { requestId: string; sessionId: string }) => void; beforeDispatch?: () => Promise<void>; submission?: PendingPromptSubmission },
): Promise<T> {
  const requestId = command.type === "prompt"
    ? options?.submission?.requestId ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")
    : null;
  if (requestId) {
    dispatchingPrompts.add(requestId);
    // Bind presentation identity before the durable store publishes its row.
    // This does not authorize clearing the draft; registration still waits for IO.
    try { options?.onPromptIdentified?.({ requestId, sessionId }); } catch { /* UI-only observer. */ }
    try {
      if (!options?.submission) await retainPromptSubmission({ requestId, sessionId, message: String(command.message ?? ""),
        images: command.images as Array<{ data: string; mimeType: string }> | undefined,
        status: "sending", createdAt: Date.now(), deliveryProtocol: 2,
        ...(command.streamingBehavior === "steer" || command.streamingBehavior === "followUp" ? { streamingBehavior: command.streamingBehavior } : {}),
      });
    } catch {
      dispatchingPrompts.delete(requestId);
      throw new AgentCommandError("无法保留待确认消息，内容已退回输入框，本次未发送。", 0, "prompt_rejected", false);
    }
  }
  // UI observes the same generated identity as the durable record, never text.
  // A presentation callback must not alter delivery or cause a replay.
  if (requestId) { try { options?.onPromptRegistered?.({ requestId, sessionId }); } catch { /* UI-only observer. */ } }
  let dispatched = false;
  try {
  // Admission to the local outbox precedes network preparation (including SSE).
  await options?.beforeDispatch?.();
  dispatched = true;
  const isPrompt = command.type === "prompt";
  const isExtensionUi = command.type === "extension_ui_input" || command.type === "extension_ui_response";
  const timeoutSignal = isPrompt ? AbortSignal.timeout(30000) : isExtensionUi ? AbortSignal.timeout(12000) : undefined;
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...command, ...(requestId ? { requestId } : {}) }),
    ...(timeoutSignal ? { signal: timeoutSignal } : {}),
  });
  let body: {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
    recovery?: unknown;
    receipt?: { status: string; inFlight?: boolean };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
      readNoticeRecovery(body.recovery),
    );
  }
  if (isPrompt && body.success !== true) throw new Error("发送响应未确认");
  if (isExtensionUi && body.success !== true) {
    throw new AgentCommandError("回答响应未确认", res.status);
  }
  if (requestId) {
    reconcilePromptSubmission(requestId, body.receipt ?? { status: "accepted" });
  }
  const recalled = (body.data as { recalledPromptRequestIds?: unknown } | undefined)?.recalledPromptRequestIds;
  const recalledIds = new Set(Array.isArray(recalled) ? recalled.filter((id): id is string => typeof id === "string") : []);
  const cancelled = (body.data as { cancelledPromptRequestIds?: unknown } | undefined)?.cancelledPromptRequestIds;
  if (Array.isArray(cancelled)) for (const id of cancelled) {
    // Codex v2 also lists recalls as removed-from-queue. Only a saved draft's
    // later acknowledgement may retire their retained original.
    if (typeof id === "string" && !recalledIds.has(id)) releasePromptSubmission(id);
  }
  if (recalledIds.size) markPromptSubmissionsRecalled([...recalledIds]);
  return body.data as T;
  } catch (error) {
    if (requestId) {
      if (!dispatched) { markPromptSubmissionUncertain(requestId); throw error; }
      if (isPromptRejectedError(error)) releasePromptSubmission(requestId);
      else {
        // Read-only recovery: never replay a prompt whose response was lost.
        try {
          const receipt = await readPromptReceipt(sessionId, requestId);
          if (receipt.status === "committed" || receipt.status === "accepted" || receipt.status === "unconfirmed" || receipt.status === "cancelled") {
            reconcilePromptSubmission(requestId, receipt);
            return undefined as T;
          }
          if (receipt.status === "rejected") {
            releasePromptSubmission(requestId);
            throw new AgentCommandError(receipt.error ?? "消息未发送", 500, "prompt_rejected", false);
          }
        } catch (recoveryError) {
          if (isPromptRejectedError(recoveryError)) throw recoveryError;
        }
        markPromptSubmissionUncertain(requestId);
      }
    }
    throw error;
  } finally {
    if (requestId) dispatchingPrompts.delete(requestId);
  }
}

/** Retry only the HTTP handoff with its original ID. The durable server inbox
 * acknowledges repeats without executing them. Legacy copies older than the
 * previous receipt retention window cannot prove absence; leave them intact. */
export async function handoffUnsubmittedPrompt(row: PendingPromptSubmission): Promise<void> {
  if (dispatchingPrompts.has(row.requestId) || row.status === "recalled"
    || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  if (row.deliveryProtocol !== 2 && Date.now() - row.createdAt >= 24 * 60 * 60 * 1000) return;
  await sendAgentCommand(row.sessionId, { type: "prompt", message: row.message,
    ...(row.images?.length ? { images: row.images } : {}),
    ...(row.streamingBehavior ? { streamingBehavior: row.streamingBehavior } : {}),
  }, { submission: row });
}

export async function readPromptReceipt(sessionId: string, requestId: string): Promise<{ status: "committed" | "accepted" | "unconfirmed" | "pending" | "unknown" | "rejected" | "cancelled" | "recalled"; error?: string; inFlight?: boolean; reason?: "runtime_exit" }> {
  const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}?requestId=${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const receipt = await response.json();
  if (!["committed", "accepted", "unconfirmed", "pending", "unknown", "rejected", "cancelled", "recalled"].includes(receipt.status)) throw new Error("Invalid prompt receipt");
  return receipt;
}

// Transport admission lock, not another UI queue: an uncertain write survives
// component/session remounts in this tab and cannot be replayed without proof.
const extensionUiWrites = new Map<string, {sessionId: string; id: string; state: "inFlight" | "uncertain"}>();
const extensionUiWriteKey = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);

export function validateExtensionUiSnapshot(data: unknown): ExtensionUiRequest[] {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid extension UI state snapshot: body must be an object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.runtimeAlive !== "boolean") {
    throw new Error("Invalid extension UI state snapshot: missing runtimeAlive declaration");
  }
  if (!Array.isArray(obj.pendingExtensionUiRequests)) {
    throw new Error("Invalid extension UI state snapshot: pendingExtensionUiRequests must be an array");
  }
  for (const item of obj.pendingExtensionUiRequests) {
    if (!item || typeof item !== "object") {
      throw new Error("Invalid extension UI state snapshot: request item must be an object");
    }
    const req = item as Record<string, unknown>;
    if (typeof req.id !== "string" || !req.id) {
      throw new Error("Invalid extension UI state snapshot: request missing id");
    }
    if (req.type !== "extension_ui_request") {
      throw new Error("Invalid extension UI state snapshot: request missing type");
    }
    if (!["select", "confirm", "input", "editor", "custom"].includes(String(req.method))) {
      throw new Error("Invalid extension UI state snapshot: request missing method");
    }
    if (req.method === "custom") {
      if (!Array.isArray(req.lines) || req.lines.some(line => typeof line !== "string")) {
        throw new Error("Invalid extension UI state snapshot: custom request missing lines");
      }
      if (req.askUser !== undefined) {
        const question = req.askUser as Record<string, unknown> | null;
        if (!question || typeof question !== "object" || typeof question.question !== "string" || typeof question.toolCallId !== "string"
          || !Array.isArray(question.options) || question.options.some(option => !option || typeof option !== "object" || typeof (option as Record<string, unknown>).title !== "string")) {
          throw new Error("Invalid extension UI state snapshot: corrupt question");
        }
      }
    }
  }
  if (obj.runtimeAlive === false && obj.pendingExtensionUiRequests.length) {
    throw new Error("Invalid extension UI state snapshot: dead runtime has pending requests");
  }
  return obj.pendingExtensionUiRequests as ExtensionUiRequest[];
}

export function validateExtensionUiAck(
  ack: unknown,
  expectedId: string,
  expectedMethod: string,
): ExtensionUiDeliveryResult | null {
  if (!ack || typeof ack !== "object") return null;
  const obj = ack as Record<string, unknown>;
  if (obj.id !== expectedId) return null;
  if (obj.status === "closed") {
    return { status: "closed" };
  }
  if (obj.status === "pending") {
    const req = obj.request as ExtensionUiRequest | undefined;
    if (!req || typeof req !== "object") return null;
    if (req.type !== "extension_ui_request" || req.id !== expectedId || req.method !== expectedMethod) return null;
    try { validateExtensionUiSnapshot({runtimeAlive: true, pendingExtensionUiRequests: [req]}); }
    catch { return null; }
    return { status: "pending", request: req };
  }
  return null;
}

export async function checkExtensionUiState(sessionId: string): Promise<ExtensionUiRequest[]> {
  const timeoutMs = 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/state?extensionUi=1`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    const pending = validateExtensionUiSnapshot(data);
    const ids = new Set(pending.map(request => request.id));
    for (const [key, write] of extensionUiWrites) {
      if (write.sessionId === sessionId && write.state === "uncertain" && !ids.has(write.id)) extensionUiWrites.delete(key);
    }
    return pending;
  } finally {
    clearTimeout(timer);
  }
}

export type ExtensionUiCommandPayload =
  | { type: "extension_ui_response"; id: string; method: string; [key: string]: unknown }
  | { type: "extension_ui_input"; id: string; method: "custom"; data: string | string[] };

export async function deliverExtensionUiInput(
  sessionId: string,
  payload: ExtensionUiCommandPayload,
): Promise<ExtensionUiDeliveryResult> {
  const { id, method } = payload;
  const key = extensionUiWriteKey(sessionId, id);
  const existing = extensionUiWrites.get(key);
  if (existing) {
    if (existing.state === "uncertain") {
      try {
        const pending = await checkExtensionUiState(sessionId);
        if (!pending.some(request => request.id === id)) return { status: "closed" };
      } catch { /* Ambiguous writes remain locked; never resend. */ }
    }
    return { status: "uncertain", message: "结果待确认，未重复发送" };
  }
  // Fail closed rather than evicting an unresolved write to make room.
  if (extensionUiWrites.size >= 1024) return { status: "uncertain", message: "待确认请求过多，请先检查状态" };
  const admission = {sessionId, id, state: "inFlight" as const};
  // A terminal can legitimately send distinct keystrokes before the previous
  // ACK arrives. Only discrete answer batches/dialog responses take admission;
  // uncertain writes still block every subsequent input until read-only proof.
  if (payload.type === "extension_ui_response" || Array.isArray(payload.data)) extensionUiWrites.set(key, admission);
  try {
    const rawAck = await sendAgentCommand<unknown>(sessionId, payload);
    const validated = validateExtensionUiAck(rawAck, id, method);
    if (validated) {
      if (validated.status === "closed" || extensionUiWrites.get(key) === admission) extensionUiWrites.delete(key);
      return validated;
    }
    extensionUiWrites.set(key, {sessionId, id, state: "uncertain"});
    // Unacknowledged / corrupt / legacy ACK: read-only check
    try {
      const pending = await checkExtensionUiState(sessionId);
      const stillPending = pending.find((r) => r.id === id);
      if (!stillPending) return { status: "closed" };
      return { status: "uncertain", message: "结果待确认，未重复发送" };
    } catch {
      return { status: "uncertain", message: "结果待确认，未重复发送" };
    }
  } catch {
    // Network failure / timeout / 5xx on POST: read-only check to see if server actually processed & closed
    extensionUiWrites.set(key, {sessionId, id, state: "uncertain"});
    try {
      const pending = await checkExtensionUiState(sessionId);
      const stillPending = pending.find((r) => r.id === id);
      if (!stillPending) return { status: "closed" };
      return { status: "uncertain", message: "结果待确认，未重复发送" };
    } catch {
      return { status: "uncertain", message: "结果待确认，未重复发送" };
    }
  }
}

export async function acknowledgeRecalledPrompts(sessionId: string, requestIds: string[], draftKey = sessionId): Promise<void> {
  if (!requestIds.length || !persistDraftNow(draftKey)) return; // Original stays available when draft caching is disabled/full.
  markPromptSubmissionsRecalled(requestIds, true);
  try { await sendAgentCommand(sessionId, { type: "acknowledge_recalled_prompts", requestIds }); }
  catch { /* A lost acknowledgement leaves the backup available for a later read. */ }
}
