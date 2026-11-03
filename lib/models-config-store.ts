import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";

const require = createRequire(import.meta.url);
const {
  createStateStore,
  withAgentStateLockSync,
} = require("./enhancement-state-store.cjs") as {
  createStateStore: (opts: { agentDir: string }) => {
    ensureInitializedFromLegacyLocked: (opts?: { modelsConfigPath?: string }) => {
      ok: boolean;
      revision: number;
      state: Record<string, unknown>;
      storageVersion: number;
      alreadyInitialized?: boolean;
    };
    read: () => {
      ok: boolean;
      revision: number;
      state: Record<string, unknown>;
      storageVersion: number;
    };
  };
  withAgentStateLockSync: <T>(agentDir: string, fn: () => T) => T;
};

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelCost(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const providedKeys = MODEL_COST_KEYS.filter((key) => value[key] !== undefined);
  if (providedKeys.length === 0) return undefined;
  if (providedKeys.some((key) => (
    typeof value[key] !== "number" || !Number.isFinite(value[key])
  ))) return undefined;

  return Object.fromEntries([
    ...Object.entries(value),
    ...MODEL_COST_KEYS.map((key) => [key, value[key] ?? 0]),
  ]);
}

/** Complete partial cost groups with zero; omit a cost group only when it is empty. */
export function normalizeModelsConfigCosts(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;

  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = normalizeModelCost(model.cost);
      if (cost) model.cost = cost;
      else delete model.cost;
    }
  }
  return normalized;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/** models.json exists but its contents cannot be used, so it must not be replaced. */
export class ModelsConfigReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsConfigReadError";
  }
}

/** A submitted config cannot satisfy the models.json root schema. */
export class ModelsConfigWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsConfigWriteError";
  }
}

/** Stale decorator submission conflicts with authoritative canonical enhancement state. */
export class ModelsConfigConflictError extends Error {
  constructor(
    message = "Session tags or decorations have been modified. Please refresh the page or use the tag operations API to update tags.",
  ) {
    super(message);
    this.name = "ModelsConfigConflictError";
  }
}

/**
 * Mirrors pi's `stripJsonComments` (utils/json.js, not exported by the SDK):
 * drops `//` line comments and trailing commas, leaving string literals alone.
 */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail?: string) => tail ?? (match[0] === '"' ? match : ""));
}

/**
 * Reads models.json from disk with SDK leniency.
 */
function readDiskModelsConfig(modelsPath: string): Record<string, unknown> {
  if (!existsSync(modelsPath)) return { providers: {} };
  let parsed: unknown;
  try {
    const content = readFileSync(modelsPath, "utf8").replace(/^\uFEFF/, "");
    if (!content.trim()) return { providers: {} };
    parsed = JSON.parse(stripJsonComments(content));
  } catch (error) {
    throw new ModelsConfigReadError(
      `Failed to read ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ModelsConfigReadError(`Failed to read ${modelsPath}: expected a JSON object`);
  }
  if (!isRecord(parsed.providers)) {
    throw new ModelsConfigReadError(
      `Invalid models.json schema: providers must be present and be an object\n\nFile: ${modelsPath}`,
    );
  }
  return parsed;
}

/**
 * Reads models.json with the same leniency as pi's loader (BOM, `//` comments,
 * trailing commas). A file pi accepts must never read as empty here: the panel
 * saves its whole draft, so an empty read would delete every provider on the
 * next save. Unusable contents throw instead.
 *
 * If canonical enhancement state exists, overlays authoritative tags, mappings, colors,
 * sessionTagsRevision, and adds explicit enhancementStateRevision.
 * Does not initialize state if it does not exist (legacy uninitialized reads raw disk).
 */
export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  const diskConfig = readDiskModelsConfig(modelsPath);
  const result: Record<string, unknown> = { ...diskConfig };

  const agentDir = dirname(modelsPath);
  try {
    const store = createStateStore({ agentDir });
    const canonical = store.read();
    if (canonical && canonical.ok && canonical.state) {
      result.sessionTagsDefinitions = structuredClone(canonical.state.sessionTagsDefinitions ?? []);
      result.sessionTagMappings = structuredClone(canonical.state.sessionTagMappings ?? {});
      result.sessionColors = structuredClone(canonical.state.sessionColors ?? {});
      result.sessionTagsRevision = canonical.revision;
      result.enhancementStateRevision = canonical.revision;
    }
  } catch {
    // Uninitialized or missing canonical state: keep raw legacy disk contents, do not init
  }

  return result;
}

/** Compare JSON content without changing business arrays or nested revision fields. */
function stableConfigJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (isRecord(input)) {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

function sameStoredConfig(current: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (stableConfigJson(current) === stableConfigJson(next)) return true;
  // Old clients may keep incrementing the archive synchronization revision.
  // Both sides must already have a valid revision before ignoring only this root key.
  if (typeof current.archivedRevision !== "number" || !Number.isFinite(current.archivedRevision) || current.archivedRevision <= 0 ||
      typeof next.archivedRevision !== "number" || !Number.isFinite(next.archivedRevision) || next.archivedRevision <= 0 ||
      !Array.isArray(current.archivedSessions) || !Array.isArray(next.archivedSessions)) return false;
  const before = { ...current };
  const after = { ...next };
  delete before.archivedRevision;
  delete after.archivedRevision;
  return stableConfigJson(before) === stableConfigJson(after);
}

function hasDecoratorDifferences(
  data: Record<string, unknown>,
  canonicalState: Record<string, unknown>,
): boolean {
  if ("sessionTagsDefinitions" in data && data.sessionTagsDefinitions !== undefined) {
    const fromBody = data.sessionTagsDefinitions;
    const fromCanonical = canonicalState.sessionTagsDefinitions ?? [];
    if (stableConfigJson(fromBody) !== stableConfigJson(fromCanonical)) {
      return true;
    }
  }

  if ("sessionTagMappings" in data && data.sessionTagMappings !== undefined) {
    const fromBody = data.sessionTagMappings;
    const fromCanonical = canonicalState.sessionTagMappings ?? {};
    if (stableConfigJson(fromBody) !== stableConfigJson(fromCanonical)) {
      return true;
    }
  }

  if ("sessionColors" in data && data.sessionColors !== undefined) {
    const fromBody = data.sessionColors;
    const fromCanonical = canonicalState.sessionColors ?? {};
    if (stableConfigJson(fromBody) !== stableConfigJson(fromCanonical)) {
      return true;
    }
  }

  return false;
}

export function writeModelsConfig(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): void {
  if (!isRecord(data) || !isRecord(data.providers)) {
    throw new ModelsConfigWriteError(
      'Invalid models.json config: "providers" is required and must be an object',
    );
  }

  const agentDir = dirname(modelsPath);

  withAgentStateLockSync(agentDir, () => {
    // 1. Read disk config under lock to protect unknown keys and fail fast on corrupted legacy disk
    const currentDisk = readDiskModelsConfig(modelsPath);

    // 2. Ensure canonical state initialized from original disk decorators
    const store = createStateStore({ agentDir });
    store.ensureInitializedFromLegacyLocked({ modelsConfigPath: modelsPath });
    const canonical = store.read();
    const canonicalState = canonical.state as Record<string, unknown>;

    // 3. Detect stale legacy decorator snapshot or modification conflict
    if (hasDecoratorDifferences(data, canonicalState)) {
      throw new ModelsConfigConflictError(
        "Session tags or decorations have been modified. Please refresh the page or use the tag operations API to update tags.",
      );
    }

    // 4. Prepare data to write to disk
    const dir = dirname(modelsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(data));

    // Whole-model config update preserving submitted fields and unknown disk fields
    const toWrite: Record<string, unknown> = {
      ...currentDisk,
      ...normalized,
    };

    // Preserve existing disk decorator history; never apply body's 3 decorator fields to disk
    if ("sessionTagsDefinitions" in currentDisk) {
      toWrite.sessionTagsDefinitions = currentDisk.sessionTagsDefinitions;
    } else {
      delete toWrite.sessionTagsDefinitions;
    }

    if ("sessionTagMappings" in currentDisk) {
      toWrite.sessionTagMappings = currentDisk.sessionTagMappings;
    } else {
      delete toWrite.sessionTagMappings;
    }

    if ("sessionColors" in currentDisk) {
      toWrite.sessionColors = currentDisk.sessionColors;
    } else {
      delete toWrite.sessionColors;
    }

    if ("sessionTagsRevision" in currentDisk) {
      toWrite.sessionTagsRevision = currentDisk.sessionTagsRevision;
    } else {
      delete toWrite.sessionTagsRevision;
    }

    // Never persist API-only enhancementStateRevision to disk
    delete toWrite.enhancementStateRevision;

    // 5. Check if changed before writing
    if (existsSync(modelsPath) && sameStoredConfig(currentDisk, toWrite)) {
      return;
    }

    writePrivateFileAtomicSync(modelsPath, JSON.stringify(toWrite, null, 2));
    invalidateModelsCache();
  });
}
