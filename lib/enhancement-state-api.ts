import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isApiRequestAllowed,
  isApiRequestOriginAllowed,
  shouldCheckApiRequestOrigin,
} from "./request-security";
import {
  createStateStore,
  type EnhancementStateCommitResult,
  type EnhancementStateReadResult,
  type EnhancementStateStoreInstance,
} from "./enhancement-state-store.cjs";

export const MAX_ENHANCEMENT_STATE_BODY_BYTES = 1024 * 1024;
export const MAX_ENHANCEMENT_STATE_OPERATIONS = 100;
export const ENHANCEMENT_STATE_HEADER = "X-Pi-Enhancement-State";
export type EnhancementStatePresence = "present" | "absent";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const OP_ALLOWED_KEYS: Record<string, ReadonlySet<string>> = {
  tag_create: new Set(["opId", "type", "timestamp", "tag"]),
  tag_update: new Set(["opId", "type", "timestamp", "tagId", "updates"]),
  tag_delete: new Set(["opId", "type", "timestamp", "tagId"]),
  session_tag_add: new Set(["opId", "type", "timestamp", "sessionId", "tagId"]),
  session_tag_remove: new Set(["opId", "type", "timestamp", "sessionId", "tagId"]),
  session_tag_clear: new Set(["opId", "type", "timestamp", "sessionId"]),
  session_color_set: new Set(["opId", "type", "timestamp", "sessionId", "color"]),
  session_color_clear: new Set(["opId", "type", "timestamp", "sessionId"]),
  preferences_snapshot: new Set(["opId", "type", "timestamp", "clientId", "values"]),
};

const TAG_CREATE_ALLOWED_KEYS = new Set(["id", "name", "color", "createdAt", "updatedAt"]);
const TAG_UPDATE_ALLOWED_KEYS = new Set(["name", "color"]);

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
} as const;

class PayloadTooLargeError extends Error {
  constructor(message = "Request payload exceeds 1MiB limit") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

class BadRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestBodyError";
  }
}

function jsonResponseWithNoStore(
  payload: Record<string, unknown>,
  status: number,
  extraHeaders?: Record<string, string>,
): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}

function sanitizeErrorMessage(message: string): string {
  try {
    const agentDir = getAgentDir();
    if (agentDir) {
      message = message.split(agentDir).join(".");
    }
  } catch {}
  return message
    .replace(/(?:[a-zA-Z]:\\|\/)(?:[^\s:,'"()]+\/|\\)*([^\s:,'"()]+)/g, "$1");
}

function isDangerousId(val: unknown): boolean {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  return DANGEROUS_KEYS.has(val) || DANGEROUS_KEYS.has(trimmed);
}

function isSafeIdString(val: unknown, maxLen = 128): val is string {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  if (!trimmed || trimmed.length > maxLen) return false;
  if (isDangerousId(val)) return false;
  return true;
}

export function hasPrototypePollution(value: unknown, visited = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (visited.has(value)) return false;
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasPrototypePollution(item, visited)) return true;
    }
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return true;
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object" && hasPrototypePollution(child, visited)) {
      return true;
    }
  }
  return false;
}

export function validateEnhancementOperation(op: unknown): string | null {
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    return "Operation must be an object";
  }
  if (hasPrototypePollution(op)) {
    return "Dangerous prototype pollution key detected in operation";
  }

  const record = op as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const allowedKeys = Object.hasOwn(OP_ALLOWED_KEYS, type) ? OP_ALLOWED_KEYS[type] : undefined;
  if (!allowedKeys) {
    return `Unsupported operation type: ${String(record.type)}`;
  }

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return `Unknown field in operation: ${key}`;
    }
  }

  if (!isSafeIdString(record.opId, 128)) {
    return "Invalid or dangerous opId in operation";
  }

  if (
    record.timestamp !== undefined
    && typeof record.timestamp !== "number"
    && typeof record.timestamp !== "string"
  ) {
    return "Invalid timestamp in operation";
  }

  switch (type) {
    case "tag_create": {
      const tag = record.tag;
      if (!tag || typeof tag !== "object" || Array.isArray(tag)) {
        return "tag_create requires a tag object";
      }
      const tagRecord = tag as Record<string, unknown>;
      for (const k of Object.keys(tagRecord)) {
        if (!TAG_CREATE_ALLOWED_KEYS.has(k)) {
          return `Unknown field in tag object: ${k}`;
        }
      }
      if (!isSafeIdString(tagRecord.id, 128)) {
        return "Invalid or dangerous tag.id in tag_create";
      }
      if (
        typeof tagRecord.name !== "string"
        || !tagRecord.name.trim()
        || tagRecord.name.trim().length > 100
      ) {
        return "tag.name must be a non-empty string <= 100 chars";
      }
      if (
        tagRecord.color !== undefined
        && (typeof tagRecord.color !== "string" || tagRecord.color.length > 50)
      ) {
        return "tag.color must be a string <= 50 chars";
      }
      if (
        tagRecord.createdAt !== undefined
        && typeof tagRecord.createdAt !== "string"
        && typeof tagRecord.createdAt !== "number"
      ) {
        return "tag.createdAt must be string or number";
      }
      if (
        tagRecord.updatedAt !== undefined
        && typeof tagRecord.updatedAt !== "string"
        && typeof tagRecord.updatedAt !== "number"
      ) {
        return "tag.updatedAt must be string or number";
      }
      break;
    }

    case "tag_update": {
      if (!isSafeIdString(record.tagId, 128)) {
        return "Invalid or dangerous tagId in tag_update";
      }
      const updates = record.updates;
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        return "tag_update requires updates object";
      }
      const updatesRecord = updates as Record<string, unknown>;
      for (const k of Object.keys(updatesRecord)) {
        if (!TAG_UPDATE_ALLOWED_KEYS.has(k)) {
          return `Unknown field in tag_update updates: ${k}`;
        }
      }
      let hasUpdate = false;
      if (updatesRecord.name !== undefined) {
        if (
          typeof updatesRecord.name !== "string"
          || !updatesRecord.name.trim()
          || updatesRecord.name.trim().length > 100
        ) {
          return "updates.name must be a non-empty string <= 100 chars";
        }
        hasUpdate = true;
      }
      if (updatesRecord.color !== undefined) {
        if (
          typeof updatesRecord.color !== "string"
          || !updatesRecord.color.trim()
          || updatesRecord.color.length > 50
        ) {
          return "updates.color must be a non-empty string <= 50 chars";
        }
        hasUpdate = true;
      }
      if (!hasUpdate) {
        return "tag_update requires at least name or color";
      }
      break;
    }

    case "tag_delete": {
      if (!isSafeIdString(record.tagId, 128)) {
        return "Invalid or dangerous tagId in tag_delete";
      }
      break;
    }

    case "session_tag_add":
    case "session_tag_remove": {
      if (!isSafeIdString(record.sessionId, 256)) {
        return `Invalid or dangerous sessionId in ${type}`;
      }
      if (!isSafeIdString(record.tagId, 128)) {
        return `Invalid or dangerous tagId in ${type}`;
      }
      break;
    }

    case "session_tag_clear":
    case "session_color_clear": {
      if (!isSafeIdString(record.sessionId, 256)) {
        return `Invalid or dangerous sessionId in ${type}`;
      }
      break;
    }

    case "session_color_set": {
      if (!isSafeIdString(record.sessionId, 256)) {
        return "Invalid or dangerous sessionId in session_color_set";
      }
      if (
        typeof record.color !== "string"
        || !record.color.trim()
        || record.color.length > 50
      ) {
        return "color must be a non-empty string <= 50 chars in session_color_set";
      }
      break;
    }

    case "preferences_snapshot": {
      if (!isSafeIdString(record.clientId, 128)) {
        return "Invalid or dangerous clientId in preferences_snapshot";
      }
      const values = record.values;
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        return "values must be an object in preferences_snapshot";
      }
      for (const [key, val] of Object.entries(values as Record<string, unknown>)) {
        if (isDangerousId(key)) {
          return `Dangerous preference key detected: ${key}`;
        }
        const isValidKey = key === "pi-enh-settings-v1" || key.startsWith("pi-enh-plugin-");
        if (!isValidKey) {
          return `Illegal preference key: ${key}`;
        }
        if (typeof val !== "string") {
          return `Preference value for key ${key} must be a string`;
        }
        if (val.length > 256 * 1024) {
          return `Preference value for key ${key} exceeds size limit`;
        }
      }
      break;
    }
  }

  return null;
}

/**
 * Always creates a fresh store bound exclusively to `getAgentDir()`.
 * Any client-supplied instance/path selector is ignored so instances never cross-contaminate
 * and every GET reads the latest committed journal state from disk without writing.
 */
export function createEnhancementStateStore(): EnhancementStateStoreInstance {
  return createStateStore({ agentDir: getAgentDir() });
}

export function getEnhancementStatePresence(agentDir = getAgentDir()): EnhancementStatePresence {
  const stateDir = join(agentDir, "state", "enhancement-state");
  const hasJournal = existsSync(join(stateDir, "journal.jsonl"));
  const hasCurrent = existsSync(join(stateDir, "current.json"));
  return hasJournal || hasCurrent ? "present" : "absent";
}

export function readEnhancementState(): EnhancementStateReadResult {
  return createEnhancementStateStore().read();
}

export async function commitEnhancementOperations(
  operations: unknown[],
): Promise<EnhancementStateCommitResult> {
  const store = createEnhancementStateStore();
  return store.withLock(async () => {
    store.ensureInitializedFromLegacyLocked();
    return store.commitLocked(operations);
  });
}

function isRequestTrusted(request: Request): boolean {
  if (request.headers.has("host")) {
    return isApiRequestAllowed(request);
  }
  if (!shouldCheckApiRequestOrigin(request)) {
    return true;
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return isApiRequestOriginAllowed(request);
  }
}

async function readBodyTextWithinLimit(
  request: Request,
  maxBytes = MAX_ENHANCEMENT_STATE_BODY_BYTES,
): Promise<string> {
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null && declaredHeader.trim() !== "") {
    if (!/^\d+$/.test(declaredHeader.trim())) {
      throw new BadRequestBodyError("Invalid Content-Length header");
    }
    const declaredLength = Number(declaredHeader.trim());
    if (!Number.isSafeInteger(declaredLength)) {
      throw new BadRequestBodyError("Invalid Content-Length header");
    }
    if (declaredLength > maxBytes) {
      await request.body?.cancel().catch(() => {});
      throw new PayloadTooLargeError();
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new BadRequestBodyError("Malformed JSON payload");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        throw new BadRequestBodyError("Error reading request body");
      }
      const { done, value } = readResult;
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

function extractErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim();
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message);
  return match ? match[1] : fallback;
}

function isNotInitializedError(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "NOT_INITIALIZED") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("NOT_INITIALIZED");
}

function isCorruptedStoreError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("CORRUPTED_JOURNAL") || message.startsWith("CORRUPTED_CURRENT");
}

export async function handleEnhancementStateHead(request?: Request): Promise<NextResponse> {
  if (request && !isRequestTrusted(request)) {
    return new NextResponse(null, {
      status: 403,
      headers: NO_STORE_HEADERS,
    });
  }

  const presence = getEnhancementStatePresence();
  return new NextResponse(null, {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      [ENHANCEMENT_STATE_HEADER]: presence,
    },
  });
}

export async function handleEnhancementStateGet(request?: Request): Promise<NextResponse> {
  if (request && !isRequestTrusted(request)) {
    return jsonResponseWithNoStore(
      { ok: false, error: "FORBIDDEN", message: "Untrusted API request" },
      403,
    );
  }

  try {
    const result = readEnhancementState();
    return jsonResponseWithNoStore(
      {
        ok: true,
        revision: result.revision,
        state: result.state,
        storageVersion: result.storageVersion,
      },
      200,
    );
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = sanitizeErrorMessage(rawMessage);
    if (isNotInitializedError(error)) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "NOT_INITIALIZED",
          message,
        },
        409,
      );
    }
    const errCode = extractErrorCode(error, "");
    if (errCode === "LOCK_BUSY" || rawMessage.includes("LOCK_BUSY")) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "LOCK_BUSY",
          message: "Service temporarily busy, please retry",
        },
        503,
        { "Retry-After": "1" },
      );
    }
    if (
      errCode === "LOCK_STALE_REQUIRES_RECOVERY" ||
      rawMessage.includes("LOCK_STALE_REQUIRES_RECOVERY")
    ) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "LOCK_STALE_REQUIRES_RECOVERY",
          message: "Agent state lock is stale and requires recovery",
        },
        503,
      );
    }
    return jsonResponseWithNoStore(
      {
        ok: false,
        error: extractErrorCode(error, "STATE_CORRUPTED"),
        message,
      },
      503,
    );
  }
}

export async function handleEnhancementStateOperationsPost(request: Request): Promise<NextResponse> {
  if (!isRequestTrusted(request)) {
    return jsonResponseWithNoStore(
      { ok: false, error: "FORBIDDEN", message: "Untrusted API request" },
      403,
    );
  }

  let rawText: string;
  try {
    rawText = await readBodyTextWithinLimit(request, MAX_ENHANCEMENT_STATE_BODY_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "PAYLOAD_TOO_LARGE",
          message: error.message,
        },
        413,
      );
    }
    return jsonResponseWithNoStore(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Error reading request body",
      },
      400,
    );
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(rawText);
  } catch {
    return jsonResponseWithNoStore(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: "Malformed JSON payload",
      },
      400,
    );
  }

  if (hasPrototypePollution(bodyJson)) {
    return jsonResponseWithNoStore(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: "Dangerous prototype pollution keys detected",
      },
      400,
    );
  }

  if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson)) {
    return jsonResponseWithNoStore(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: "Body must be an object with an operations array",
      },
      400,
    );
  }

  const bodyRecord = bodyJson as Record<string, unknown>;
  for (const key of Object.keys(bodyRecord)) {
    if (key !== "operations") {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "BAD_REQUEST",
          message: `Unknown field in request body: ${key}`,
        },
        400,
      );
    }
  }

  if (!Array.isArray(bodyRecord.operations)) {
    return jsonResponseWithNoStore(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: "Body must be an object with an operations array",
      },
      400,
    );
  }

  if (bodyRecord.operations.length > MAX_ENHANCEMENT_STATE_OPERATIONS) {
    return jsonResponseWithNoStore(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: "Batch size exceeds 100 operations limit",
      },
      400,
    );
  }

  for (const op of bodyRecord.operations) {
    const schemaErr = validateEnhancementOperation(op);
    if (schemaErr) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "BAD_REQUEST",
          message: schemaErr,
        },
        400,
      );
    }
  }

  try {
    const commitResult = await commitEnhancementOperations(bodyRecord.operations);
    return jsonResponseWithNoStore(
      {
        ok: true,
        revision: commitResult.revision,
        state: commitResult.state,
        acknowledgedOpIds: commitResult.acknowledgedOpIds,
        tagIdRemap: commitResult.tagIdRemap,
        storageVersion: commitResult.storageVersion,
      },
      200,
    );
  } catch (error) {
    const errCode = extractErrorCode(error, "");
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = sanitizeErrorMessage(rawMessage);

    if (errCode === "LOCK_BUSY" || rawMessage.includes("LOCK_BUSY")) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "LOCK_BUSY",
          message: "Service temporarily busy, please retry",
        },
        503,
        { "Retry-After": "1" },
      );
    }

    if (
      errCode === "LOCK_STALE_REQUIRES_RECOVERY" ||
      rawMessage.includes("LOCK_STALE_REQUIRES_RECOVERY")
    ) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "LOCK_STALE_REQUIRES_RECOVERY",
          message: "Agent state lock is stale and requires recovery",
        },
        503,
      );
    }

    if (isNotInitializedError(error)) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "NOT_INITIALIZED",
          message,
        },
        409,
      );
    }

    if (
      errCode === "LEGACY_MODELS_INVALID" ||
      rawMessage.includes("LEGACY_MODELS_INVALID")
    ) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: "LEGACY_MODELS_INVALID",
          message,
        },
        422,
      );
    }

    if (isCorruptedStoreError(error)) {
      return jsonResponseWithNoStore(
        {
          ok: false,
          error: extractErrorCode(error, "STATE_CORRUPTED"),
          message,
        },
        503,
      );
    }

    return jsonResponseWithNoStore(
      {
        ok: false,
        error: extractErrorCode(error, "COMMIT_FAILED"),
        message,
      },
      400,
    );
  }
}
