import type { AgentMessage } from "@/lib/types";

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

export function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

interface UserMessageIdentity { requestId?: string; entryId?: string }
// Identity follows the message object through React updates without entering
// the certified wire payload or retaining a second transcript/cache.
const identities = new WeakMap<AgentMessage, UserMessageIdentity>();
export function bindUserMessageIdentity(message: AgentMessage, identity: UserMessageIdentity): void {
  if (message.role !== "user") return;
  const current = identities.get(message) ?? {};
  identities.set(message, { ...current,
    ...(identity.requestId ? { requestId: identity.requestId } : {}),
    ...(identity.entryId ? { entryId: identity.entryId } : {}),
  });
}
export function bindUserHistoryIdentities(messages: AgentMessage[], entryIds: string[], promptEntryIds: Record<string, string> = {}): void {
  const requests = new Map(Object.entries(promptEntryIds).map(([requestId, entryId]) => [entryId, requestId]));
  messages.forEach((message, index) => bindUserMessageIdentity(message, {
    entryId: entryIds[index], requestId: requests.get(entryIds[index]),
  }));
}
function sameIdentity(a: AgentMessage, b: AgentMessage): boolean {
  const x = identities.get(a), y = identities.get(b);
  return Boolean(x && y && ((x.entryId && x.entryId === y.entryId) || (x.requestId && x.requestId === y.requestId)));
}
function uniqueUserEntries(messages: AgentMessage[]): AgentMessage[] {
  const entries = new Set<string>(), requests = new Set<string>();
  return messages.filter((message) => {
    const identity = identities.get(message);
    if (!identity) return true;
    const duplicate = Boolean((identity.entryId && entries.has(identity.entryId)) || (identity.requestId && requests.has(identity.requestId)));
    if (identity.entryId) entries.add(identity.entryId);
    if (identity.requestId) requests.add(identity.requestId);
    return !duplicate;
  });
}
export function reconcileUserReceipt(messages: AgentMessage[], requestId: string, entryId: string): AgentMessage[] {
  for (const message of messages) if (identities.get(message)?.requestId === requestId) {
    bindUserMessageIdentity(message, { entryId });
  }
  const result = uniqueUserEntries(messages);
  return result.length === messages.length ? messages : result;
}
export function reconcileDeliveredUserEntry(messages: AgentMessage[], delivered: AgentMessage, pending: OptimisticUserMessage | null): AgentMessage[] {
  const identity = identities.get(delivered);
  const ownsEcho = pending && (identity?.requestId
    ? identity.requestId === pending.requestId
    : !pending.requestId && userMessageKey(delivered) === userMessageKey(pending.message));
  const echo = ownsEcho ? messages.indexOf(pending.message) : -1;
  const existing = messages.findIndex((message, index) => index !== echo && sameIdentity(message, delivered));
  if (existing !== -1) return echo === -1 ? messages : messages.filter((_, index) => index !== echo);
  if (echo !== -1) return messages.map((message, index) => index === echo ? delivered : message);
  return [...messages, delivered];
}

/** One local submission, owned by the session hook until confirmation/rejection.
 * History reads stay authoritative; this echo is only part of the display view.
 */
export interface OptimisticUserMessage {
  sessionId: string | null;
  message: AgentMessage;
  precedingEntryIds: readonly string[];
  requestId?: string;
}

export function preservePendingUserMessage(
  history: AgentMessage[], entryIds: string[], sessionId: string,
  pending: OptimisticUserMessage | null,
): AgentMessage[] {
  if (!pending || pending.sessionId !== sessionId) return history;
  const previousIds = new Set(pending.precedingEntryIds);
  const key = userMessageKey(pending.message);
  const confirmed = history.some((message, i) => message.role === "user" && (pending.requestId
    ? identities.get(message)?.requestId === pending.requestId
    : entryIds[i] && !previousIds.has(entryIds[i]) && userMessageKey(message) === key));
  return confirmed ? history : [...history, pending.message];
}
