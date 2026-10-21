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
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...command, ...(requestId ? { requestId } : {}) }),
    ...(requestId ? { signal: AbortSignal.timeout(30000) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
    recovery?: unknown;
    receipt?: { status: string; inFlight?: boolean };
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
      readNoticeRecovery(body.recovery),
    );
  }
  if (requestId && body.success !== true) throw new Error("发送响应未确认");
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

export async function acknowledgeRecalledPrompts(sessionId: string, requestIds: string[], draftKey = sessionId): Promise<void> {
  if (!requestIds.length || !persistDraftNow(draftKey)) return; // Original stays available when draft caching is disabled/full.
  markPromptSubmissionsRecalled(requestIds, true);
  try { await sendAgentCommand(sessionId, { type: "acknowledge_recalled_prompts", requestIds }); }
  catch { /* A lost acknowledgement leaves the backup available for a later read. */ }
}
