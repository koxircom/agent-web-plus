/**
 * Safe, atomic in-memory queue operations for Agent Web Plus v2.
 * Supports image attachment metadata, single-item recall/delete, promote, and all-item recall.
 *
 * Micro-contract v2:
 * - snapshot(session): { version: 2, steering: [{ token, text, imageCount }], followUp: [{ token, text, imageCount }] }
 * - getQueuedMessage(session, token): { text, kind, token, images: [{ data, mimeType }] }
 * - promote(session, token): { version: 2, queuedMessages: { steering: [text], followUp: [text] } }
 * - recall(session, token): { version: 2, text, kind, token, images: [{ data, mimeType }] }
 * - deleteQueued(session, token): { version: 2, success: true }
 * - recallAll(session, expectedTokens): { version: 2, entries: [{ text, kind, token, images }] }
 */

import { randomUUID } from "node:crypto";
import { isBase64ImageWithinLimits } from "./image-attachments.ts";

export interface QueuedImageAttachment {
  data: string;
  mimeType: string;
}

export interface QueueActionSnapshotItem {
  token: string;
  text: string;
  imageCount: number;
}

export interface QueueActionsSnapshot {
  version: 2;
  reorder?: true;
  steering: QueueActionSnapshotItem[];
  followUp: QueueActionSnapshotItem[];
}

export interface QueuedMessageInfo {
  text: string;
  kind: "steering" | "followUp";
  token: string;
  images: QueuedImageAttachment[];
}

export interface PromoteQueuedMessageResult {
  version: 2;
  queuedMessages: {
    steering: string[];
    followUp: string[];
  };
}

export interface RecallQueuedMessageResult extends QueuedMessageInfo {
  version: 2;
}

export interface DeleteQueuedMessageResult {
  version: 2;
  success: true;
}

export interface RecallAllQueuedMessagesResult {
  version: 2;
  entries: QueuedMessageInfo[];
}

type RawMessagePart = {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
};

type RawQueuedMessage = {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

interface InternalQueueSession {
  isStreaming?: boolean;
  isCompacting?: boolean;
  _steeringMessages: string[];
  _followUpMessages: string[];
  _emitQueueUpdate: () => void;
  agent: {
    state?: {
      isStreaming?: boolean;
    };
    steeringQueue: {
      messages: RawQueuedMessage[];
    };
    followUpQueue: {
      messages: RawQueuedMessage[];
    };
  };
}

// Session-scoped token state storage.
// Guarantees:
// 1. In-process stable UUID per raw message object within a session.
// 2. Session isolation (tokens from session A cannot be resolved in session B).
// 3. Stale token rejection (tokens not present in the current active queues are rejected).
// 4. Zero memory leaks (weakly holds session reference).
const sessionTokenRegistries = new WeakMap<object, SessionTokenRegistry>();

export class SessionTokenRegistry {
  msgToToken = new WeakMap<object, string>();
  tokenToMsg = new Map<string, RawQueuedMessage>();

  getOrCreateToken(msg: RawQueuedMessage): string {
    let token = this.msgToToken.get(msg);
    if (!token) {
      token = randomUUID();
      this.msgToToken.set(msg, token);
      this.tokenToMsg.set(token, msg);
    } else if (!this.tokenToMsg.has(token)) {
      this.tokenToMsg.set(token, msg);
    }
    return token;
  }

  prune(activeMessages: readonly RawQueuedMessage[]): void {
    const activeSet = new Set(activeMessages);
    for (const [tok, msg] of this.tokenToMsg.entries()) {
      if (!activeSet.has(msg)) {
        this.tokenToMsg.delete(tok);
      }
    }
  }

  findMessage(token: unknown, activeMessages: readonly RawQueuedMessage[]): RawQueuedMessage | null {
    if (typeof token !== "string" || !token.trim()) return null;
    const msg = this.tokenToMsg.get(token);
    if (!msg) return null;
    if (!activeMessages.includes(msg)) {
      this.tokenToMsg.delete(token);
      return null;
    }
    return msg;
  }

  removeToken(token: string): void {
    this.tokenToMsg.delete(token);
  }
}

/**
 * Get or create the SessionTokenRegistry for a session.
 */
export function getSessionRegistry(session: object): SessionTokenRegistry {
  let reg = sessionTokenRegistries.get(session);
  if (!reg) {
    reg = new SessionTokenRegistry();
    sessionTokenRegistries.set(session, reg);
  }
  return reg;
}

/**
 * Extract plain text content from an AgentMessage.
 * Preserves text ordering and ignores non-text parts (e.g. image attachments).
 */
export function extractMessageText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as RawQueuedMessage).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => (
        Boolean(part) &&
        typeof part === "object" &&
        (part as RawMessagePart).type === "text" &&
        typeof (part as RawMessagePart).text === "string"
      ))
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/**
 * Fast count of image attachments without building base64 string copies.
 */
export function countMessageImages(msg: unknown): number {
  if (!msg || typeof msg !== "object") return 0;
  const content = (msg as RawQueuedMessage).content;
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    if (part && typeof part === "object" && (part as RawMessagePart).type === "image") {
      count++;
    }
  }
  return count;
}

/**
 * Validate message attachment schema strictly before any mutation or read.
 * Incompatible schema (e.g. missing data, non-image mimeType, or corrupt content) must fail closed.
 */
export function validateMessageAttachmentSchema(msg: unknown): void {
  if (!msg || typeof msg !== "object") {
    throw new Error("Incompatible message attachment schema: message must be an object");
  }
  const content = (msg as RawQueuedMessage).content;
  if (typeof content === "string") return;
  if (!Array.isArray(content)) {
    throw new Error("Incompatible message attachment schema: content must be a string or array");
  }
  for (const part of content) {
    if (!part || typeof part !== "object") {
      throw new Error("Incompatible message attachment schema: invalid content part");
    }
    const typedPart = part as RawMessagePart;
    if (typedPart.type === "image") {
      if (
        typeof typedPart.data !== "string" ||
        typedPart.data.length === 0 ||
        typeof typedPart.mimeType !== "string" ||
        !typedPart.mimeType.startsWith("image/")
        // Validate the destination composer's limits before destructive recall.
        || !isBase64ImageWithinLimits(typedPart)
      ) {
        throw new Error("Incompatible message attachment schema: invalid image part");
      }
    } else if (typedPart.type === "text") {
      if (typeof typedPart.text !== "string") {
        throw new Error("Incompatible message attachment schema: invalid text part");
      }
    } else {
      throw new Error("Incompatible message attachment schema: unsupported content part");
    }
  }
}

/**
 * Extract image attachments from an AgentMessage.
 * Preserves full data and mimeType, failing closed if schema or image count is inconsistent.
 */
export function extractMessageImages(msg: unknown): QueuedImageAttachment[] {
  if (!msg || typeof msg !== "object") return [];
  const content = (msg as RawQueuedMessage).content;
  if (!Array.isArray(content)) return [];

  validateMessageAttachmentSchema(msg);
  const expectedCount = countMessageImages(msg);
  const images: QueuedImageAttachment[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as RawMessagePart).type === "image") {
      const typedPart = part as { data: string; mimeType: string };
      images.push({ data: typedPart.data, mimeType: typedPart.mimeType });
    }
  }
  if (images.length !== expectedCount) {
    throw new Error("Incompatible message attachment schema: image count mismatch");
  }
  return images;
}

/**
 * Strict validation of two-layer queue consistency between AgentSession and Agent.
 * Rejects with an Error if desynchronization or incompatible version is detected.
 * Does not mutate any state.
 */
export function validateQueueConsistency(session: unknown): asserts session is InternalQueueSession {
  if (!session || typeof session !== "object") {
    throw new Error("Invalid session: session must be an object");
  }

  const candidate = session as Record<string, unknown>;
  if (typeof candidate._emitQueueUpdate !== "function") {
    throw new Error("Incompatible session: queue update emitter is required");
  }
  const agent = candidate.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent !== "object") {
    throw new Error("Incompatible session: session.agent is required");
  }

  const followUpQueue = agent.followUpQueue as { messages?: unknown } | undefined;
  if (!followUpQueue || !Array.isArray(followUpQueue.messages)) {
    throw new Error("Incompatible agent: followUpQueue.messages must be an array");
  }

  const steeringQueue = agent.steeringQueue as { messages?: unknown } | undefined;
  if (!steeringQueue || !Array.isArray(steeringQueue.messages)) {
    throw new Error("Incompatible agent: steeringQueue.messages must be an array");
  }

  if (!Array.isArray(candidate._followUpMessages)) {
    throw new Error("Incompatible session: _followUpMessages must be an array");
  }

  if (!Array.isArray(candidate._steeringMessages)) {
    throw new Error("Incompatible session: _steeringMessages must be an array");
  }

  const followUpMessages = candidate._followUpMessages;
  const steeringMessages = candidate._steeringMessages;
  const rawFollowUps = followUpQueue.messages;
  const rawSteerings = steeringQueue.messages;

  // Length checks
  if (followUpMessages.length !== rawFollowUps.length) {
    throw new Error(
      `Queue desynchronized: followUp queue length mismatch (_followUpMessages=${followUpMessages.length}, agent=${rawFollowUps.length})`,
    );
  }

  if (steeringMessages.length !== rawSteerings.length) {
    throw new Error(
      `Queue desynchronized: steering queue length mismatch (_steeringMessages=${steeringMessages.length}, agent=${rawSteerings.length})`,
    );
  }

  // Content 1-to-1 correspondence checks & image schema checks
  for (let i = 0; i < followUpMessages.length; i++) {
    const textInSession = followUpMessages[i];
    const msg = rawFollowUps[i];
    validateMessageAttachmentSchema(msg);
    const textInMsg = extractMessageText(msg);
    if (typeof textInSession !== "string" || textInSession !== textInMsg) {
      throw new Error(`Queue desynchronized: followUp message mismatch at index ${i}`);
    }
  }

  for (let i = 0; i < steeringMessages.length; i++) {
    const textInSession = steeringMessages[i];
    const msg = rawSteerings[i];
    validateMessageAttachmentSchema(msg);
    const textInMsg = extractMessageText(msg);
    if (typeof textInSession !== "string" || textInSession !== textInMsg) {
      throw new Error(`Queue desynchronized: steering message mismatch at index ${i}`);
    }
  }
}

/**
 * Safely emit queue update without letting subscriber errors mask committed state mutations.
 */
function safeEmitQueueUpdate(session: InternalQueueSession): void {
  try {
    session._emitQueueUpdate();
  } catch (err) {
    console.warn(
      "[pi-web-queue-actions] Queue mutated; a queue_update subscriber threw an error:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Pi 1.0.2 consumes image-only user messages from the agent queue, but skips
 * its text mirror cleanup because contentText is empty. Reconcile only this
 * confirmed delivery event, never an arbitrary queue mismatch or user action.
 */
export function reconcileDeliveredImageOnlyMessage(session: unknown, message: unknown): boolean {
  if (!session || typeof session !== "object" || !message || typeof message !== "object") return false;
  const delivered = message as RawQueuedMessage;
  if (delivered.role !== "user" || extractMessageText(delivered) !== "" || countMessageImages(delivered) === 0) return false;
  const candidate = session as InternalQueueSession;
  const queues = [
    [candidate._steeringMessages, candidate.agent?.steeringQueue?.messages],
    [candidate._followUpMessages, candidate.agent?.followUpQueue?.messages],
  ] as const;
  let consumed: { texts: string[]; index: number } | undefined;
  for (const [texts, raw] of queues) {
    if (!Array.isArray(texts) || !Array.isArray(raw)) return false;
    // A still-queued image must remain editable, recallable and deletable.
    if (raw.includes(delivered)) return false;
    if (texts.length === raw.length) {
      if (texts.some((text, i) => text !== extractMessageText(raw[i]))) return false;
      continue;
    }
    if (consumed || texts.length !== raw.length + 1) return false;
    const index = texts.indexOf("");
    if (index < 0 || texts.some((text, i) => i !== index && text !== extractMessageText(raw[i < index ? i : i - 1]))) return false;
    consumed = { texts, index };
  }
  if (!consumed) return false;
  consumed.texts.splice(consumed.index, 1);
  safeEmitQueueUpdate(candidate);
  return true;
}

/**
 * Snapshot steering and follow-up queue messages with stable UUID tokens and attachment counts.
 * Strictly read-only with respect to session queue state.
 */
export function snapshot(session: unknown): QueueActionsSnapshot {
  if (!session) {
    throw new Error("Invalid session: session is required");
  }

  validateQueueConsistency(session);

  const registry = getSessionRegistry(session);
  const rawSteerings = session.agent.steeringQueue.messages;
  const rawFollowUps = session.agent.followUpQueue.messages;
  const allActive = [...rawSteerings, ...rawFollowUps];

  const steering: QueueActionSnapshotItem[] = [];
  for (let i = 0; i < rawSteerings.length; i++) {
    const msg = rawSteerings[i];
    const token = registry.getOrCreateToken(msg);
    const text = session._steeringMessages[i];
    const imageCount = countMessageImages(msg);
    steering.push({ token, text, imageCount });
  }

  const followUp: QueueActionSnapshotItem[] = [];
  for (let i = 0; i < rawFollowUps.length; i++) {
    const msg = rawFollowUps[i];
    const token = registry.getOrCreateToken(msg);
    const text = session._followUpMessages[i];
    const imageCount = countMessageImages(msg);
    followUp.push({ token, text, imageCount });
  }

  registry.prune(allActive);

  return {
    version: 2,
    reorder: true,
    steering,
    followUp,
  };
}

/**
 * Read-only fetch of a single queued message entry by its token.
 */
export function getQueuedMessage(session: unknown, token: unknown): QueuedMessageInfo {
  if (!session) {
    throw new Error("Invalid session: session is required");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Invalid token: token must be a non-empty string");
  }

  validateQueueConsistency(session);

  const registry = getSessionRegistry(session);
  const rawSteerings = session.agent.steeringQueue.messages;
  const rawFollowUps = session.agent.followUpQueue.messages;
  const allActive = [...rawSteerings, ...rawFollowUps];

  const targetMsg = registry.findMessage(token, allActive);
  if (!targetMsg) {
    throw new Error(`Token invalid or message no longer in queue: ${token}`);
  }

  const steeringIdx = rawSteerings.indexOf(targetMsg);
  if (steeringIdx !== -1) {
    return {
      text: session._steeringMessages[steeringIdx],
      kind: "steering",
      token,
      images: extractMessageImages(targetMsg),
    };
  }

  const followUpIdx = rawFollowUps.indexOf(targetMsg);
  if (followUpIdx !== -1) {
    return {
      text: session._followUpMessages[followUpIdx],
      kind: "followUp",
      token,
      images: extractMessageImages(targetMsg),
    };
  }

  throw new Error(`Token invalid or message no longer in queue: ${token}`);
}

/**
 * Synchronous atomic promotion of a queued follow-up message into the steering queue.
 */
export function promote(session: unknown, token: unknown): PromoteQueuedMessageResult {
  if (!session) {
    throw new Error("Invalid session: session is required");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Invalid token: token must be a non-empty string");
  }

  const candidate = session as Partial<InternalQueueSession>;
  const isStreaming = Boolean(candidate.isStreaming ?? candidate.agent?.state?.isStreaming);
  if (!isStreaming) {
    throw new Error("Cannot promote queued message: session is not streaming");
  }

  if (candidate.isCompacting) {
    throw new Error("Cannot promote queued message: session is currently compacting");
  }

  validateQueueConsistency(session);

  const registry = getSessionRegistry(session);
  const rawFollowUps = session.agent.followUpQueue.messages;
  const targetMsg = registry.findMessage(token, rawFollowUps);

  if (!targetMsg) {
    throw new Error(`Token invalid or message no longer in follow-up queue: ${token}`);
  }

  const targetIndex = rawFollowUps.indexOf(targetMsg);
  if (targetIndex === -1) {
    throw new Error(`Token invalid or message no longer in follow-up queue: ${token}`);
  }

  // Synchronous atomic mutation: remove from followUp queues
  const [targetAgentMessage] = session.agent.followUpQueue.messages.splice(targetIndex, 1);
  const [targetFollowUpText] = session._followUpMessages.splice(targetIndex, 1);

  // Append to steering queues tail
  session.agent.steeringQueue.messages.push(targetAgentMessage);
  session._steeringMessages.push(targetFollowUpText);

  safeEmitQueueUpdate(session);

  return {
    version: 2,
    queuedMessages: {
      steering: [...session._steeringMessages],
      followUp: [...session._followUpMessages],
    },
  };
}

/**
 * Synchronous atomic recall of a single queued message into composer.
 * Removes the exact message object from the two-layer queue while keeping remaining messages intact.
 */
export function recall(session: unknown, token: unknown): RecallQueuedMessageResult {
  if (!session) {
    throw new Error("Invalid session: session is required");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Invalid token: token must be a non-empty string");
  }

  validateQueueConsistency(session);

  const registry = getSessionRegistry(session);
  const rawSteerings = session.agent.steeringQueue.messages;
  const rawFollowUps = session.agent.followUpQueue.messages;
  const allActive = [...rawSteerings, ...rawFollowUps];

  const targetMsg = registry.findMessage(token, allActive);
  if (!targetMsg) {
    throw new Error(`Token invalid or message no longer in queue: ${token}`);
  }

  const steeringIdx = rawSteerings.indexOf(targetMsg);
  const followUpIdx = steeringIdx === -1 ? rawFollowUps.indexOf(targetMsg) : -1;
  if (steeringIdx === -1 && followUpIdx === -1) {
    throw new Error(`Token invalid or message no longer in queue: ${token}`);
  }

  // Validate and extract images before mutating queues
  const images = extractMessageImages(targetMsg);

  let kind: "steering" | "followUp";
  let rawText: string;

  if (steeringIdx !== -1) {
    kind = "steering";
    session.agent.steeringQueue.messages.splice(steeringIdx, 1);
    [rawText] = session._steeringMessages.splice(steeringIdx, 1);
  } else {
    kind = "followUp";
    session.agent.followUpQueue.messages.splice(followUpIdx, 1);
    [rawText] = session._followUpMessages.splice(followUpIdx, 1);
  }

  registry.removeToken(token);

  safeEmitQueueUpdate(session);

  return {
    version: 2,
    text: rawText,
    kind,
    token,
    images,
  };
}

/**
 * Synchronous atomic deletion of a single queued message.
 * Removes the exact message object from the two-layer queue.
 */
export function deleteQueued(session: unknown, token: unknown): DeleteQueuedMessageResult {
  if (!session) {
    throw new Error("Invalid session: session is required");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Invalid token: token must be a non-empty string");
  }

  validateQueueConsistency(session);

  const registry = getSessionRegistry(session);
  const rawSteerings = session.agent.steeringQueue.messages;
  const rawFollowUps = session.agent.followUpQueue.messages;
  const allActive = [...rawSteerings, ...rawFollowUps];

  const targetMsg = registry.findMessage(token, allActive);
  if (!targetMsg) {
    throw new Error(`Token invalid or message no longer in queue: ${token}`);
  }

  const steeringIdx = rawSteerings.indexOf(targetMsg);
  if (steeringIdx !== -1) {
    session.agent.steeringQueue.messages.splice(steeringIdx, 1);
    session._steeringMessages.splice(steeringIdx, 1);
  } else {
    const followUpIdx = rawFollowUps.indexOf(targetMsg);
    if (followUpIdx !== -1) {
      session.agent.followUpQueue.messages.splice(followUpIdx, 1);
      session._followUpMessages.splice(followUpIdx, 1);
    } else {
      throw new Error(`Token invalid or message no longer in queue: ${token}`);
    }
  }

  registry.removeToken(token);

  safeEmitQueueUpdate(session);

  return {
    version: 2,
    success: true,
  };
}

/**
 * Synchronous atomic recall of all queued messages into composer.
 * Strictly requires expectedTokens array to match active queue tokens exactly, then drains both queues.
 */
export function recallAll(session: unknown, expectedTokens: unknown): RecallAllQueuedMessagesResult {
  if (!session) {
    throw new Error("Invalid session: session is required");
  }

  if (!Array.isArray(expectedTokens)) {
    throw new Error("expectedTokens is required and must be an array of string tokens");
  }

  validateQueueConsistency(session);

  const registry = getSessionRegistry(session);
  const rawSteerings = session.agent.steeringQueue.messages;
  const rawFollowUps = session.agent.followUpQueue.messages;

  // Build current token sequence and validate/extract images before any mutation
  const currentEntries: QueuedMessageInfo[] = [];
  for (let i = 0; i < rawSteerings.length; i++) {
    const msg = rawSteerings[i];
    const tok = registry.getOrCreateToken(msg);
    currentEntries.push({
      text: session._steeringMessages[i],
      kind: "steering",
      token: tok,
      images: extractMessageImages(msg),
    });
  }
  for (let i = 0; i < rawFollowUps.length; i++) {
    const msg = rawFollowUps[i];
    const tok = registry.getOrCreateToken(msg);
    currentEntries.push({
      text: session._followUpMessages[i],
      kind: "followUp",
      token: tok,
      images: extractMessageImages(msg),
    });
  }

  const currentTokens = currentEntries.map((e) => e.token);
  if (
    currentTokens.length !== expectedTokens.length ||
    currentTokens.some((tok, idx) => tok !== expectedTokens[idx])
  ) {
    throw new Error("Queue state changed concurrently: expectedTokens mismatch");
  }

  // Atomic drain
  session.agent.steeringQueue.messages.length = 0;
  session._steeringMessages.length = 0;
  session.agent.followUpQueue.messages.length = 0;
  session._followUpMessages.length = 0;

  for (const entry of currentEntries) {
    registry.removeToken(entry.token);
  }

  safeEmitQueueUpdate(session);

  return {
    version: 2,
    entries: currentEntries,
  };
}

/** Reorder within one execution class, synchronously and against the full token
 * snapshot. Preserve raw objects, attachments and steering priority. */
export function reorderQueued(session: unknown, expectedTokens: unknown, token: unknown, beforeToken: unknown): PromoteQueuedMessageResult {
  validateQueueConsistency(session);
  const registry = getSessionRegistry(session);
  const raw = [...session.agent.steeringQueue.messages, ...session.agent.followUpQueue.messages];
  const tokens = raw.map(message => registry.getOrCreateToken(message));
  if (!Array.isArray(expectedTokens) || tokens.length !== expectedTokens.length
    || tokens.some((value, i) => value !== expectedTokens[i])) throw new Error("Queue state changed concurrently: expectedTokens mismatch");
  const from = tokens.indexOf(token as string);
  const to = tokens.indexOf(beforeToken as string);
  const split = session._steeringMessages.length;
  if (from < 0 || to < 0 || (from < split) !== (to < split)) throw new Error("Invalid reorder: messages must belong to the same queue");
  if (from !== to) {
    const messages = from < split ? session.agent.steeringQueue.messages : session.agent.followUpQueue.messages;
    const texts = from < split ? session._steeringMessages : session._followUpMessages;
    const a = from < split ? from : from - split;
    const z = to < split ? to : to - split;
    const [message] = messages.splice(a, 1);
    const [text] = texts.splice(a, 1);
    messages.splice(z, 0, message);
    texts.splice(z, 0, text);
    safeEmitQueueUpdate(session);
  }
  return {version: 2, queuedMessages: {steering: [...session._steeringMessages], followUp: [...session._followUpMessages]}};
}
