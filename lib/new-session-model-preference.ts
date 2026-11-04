import { clampModelThinkingLevel, type ModelThinkingLevel } from "./model-thinking-level";

type Engine = "pi" | "codex";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
type Preference = { provider: string; modelId: string; thinkingLevel: ModelThinkingLevel | null };
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const key = (engine: Engine) => `pi-new-session-model-${engine}-v1`;

function browserStorage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function readPreference(engine: Engine, storage: StorageLike | null): Preference | null {
  try {
    const value = JSON.parse(storage?.getItem(key(engine)) || "null");
    if (!value || typeof value.provider !== "string" || typeof value.modelId !== "string"
      || !value.provider || !value.modelId
      || (value.thinkingLevel !== null && !levels.has(value.thinkingLevel))) return null;
    return { provider: value.provider, modelId: value.modelId, thinkingLevel: value.thinkingLevel };
  } catch { return null; }
}

export function hasNewSessionModelPreference(engine: Engine, storage: StorageLike | null = browserStorage()): boolean {
  return readPreference(engine, storage) !== null;
}

export function getNewSessionModelPreference(
  engine: Engine,
  models: readonly { provider: string; id: string }[],
  thinkingLevels: Record<string, string[]>,
  storage: StorageLike | null = browserStorage(),
): Preference | null {
  const value = readPreference(engine, storage);
  if (!value || !models.some(model => model.provider === value.provider && model.id === value.modelId)) return null;
  return { ...value, thinkingLevel: clampModelThinkingLevel(value.thinkingLevel, thinkingLevels[`${value.provider}:${value.modelId}`]) };
}

export function setNewSessionModelPreference(
  engine: Engine, preference: Preference, storage: StorageLike | null = browserStorage(),
): void {
  try { storage?.setItem(key(engine), JSON.stringify(preference)); } catch { /* Storage can be disabled. */ }
}
