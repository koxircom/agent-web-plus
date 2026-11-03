import { clampModelThinkingLevel, type ModelThinkingLevel } from "../model-thinking-level";

/**
 * Codex Web 协议适配层在后端未声明 reasoning efforts 能力（如 catalog 返回空数组、null 或 undefined）时
 * 采用的原适配器既定思考深度候选列表。
 * 明确来源：早期 codexModels 既定适配器回落列表 `["low", "medium", "high"]`。
 */
export const CODEX_UNKNOWN_CAPABILITY_EFFORTS = ["low", "medium", "high"] as const;

/**
 * Codex 适配器既定的默认思考深度策略。
 */
export const CODEX_DEFAULT_THINKING_LEVEL = "high" as const;

export type CodexRawCatalogModel = {
  id: string;
  name?: string;
  efforts?: string[] | null;
  defaultEffort?: string | null;
  isDefault?: boolean;
};

export type CodexModelThinkingCapability = {
  thinkingLevels: string[];
  defaultThinkingLevel: string;
  isUnknownCapability: boolean;
};

export type CodexCatalogThinkingSummary = {
  thinkingLevels: Record<string, string[]>;
  defaultThinkingLevel: string;
  defaultModelId: string | null;
};

/**
 * 原生 Codex reasoning effort 与 Web thinkingLevel 转换。
 * 显式保留 none -> off 映射。
 */
export function effortToThinkingLevel(effort: string): string {
  return effort === "none" ? "off" : effort;
}

/**
 * Web thinkingLevel 转换为原生 Codex reasoning effort。
 * 显式保留 off -> none 映射。
 */
export function thinkingLevelToEffort(level: string): string {
  return level === "off" ? "none" : level;
}

/**
 * 解析单个模型的思维深度能力：
 * 1. 区分未知/空能力与显式已知能力：空数组 []、null、undefined 统一识别为未知 capability；
 * 2. 对未知 capability 使用原适配器既定 `["low", "medium", "high"]`，不凭模型名称猜测伪造；
 * 3. 显式已知列表保留并转换（如 none -> off，保留 xhigh 等）；
 * 4. 默认 thinking level 优先遵循模型 defaultEffort / 目录 currentEffort，未提供时保留已有默认 high 策略。
 */
export function resolveCodexModelThinking(
  model: CodexRawCatalogModel,
  catalogCurrentEffort?: string | null
): CodexModelThinkingCapability {
  const rawEfforts = model.efforts;
  const isUnknown = !rawEfforts || !Array.isArray(rawEfforts) || rawEfforts.length === 0;

  const thinkingLevels: string[] = isUnknown
    ? CODEX_UNKNOWN_CAPABILITY_EFFORTS.map(effortToThinkingLevel)
    : rawEfforts.map(effortToThinkingLevel);

  const candidateDefaultEffort = (typeof model.defaultEffort === "string" && model.defaultEffort.trim())
    ? model.defaultEffort.trim()
    : (typeof catalogCurrentEffort === "string" && catalogCurrentEffort.trim())
      ? catalogCurrentEffort.trim()
      : null;

  let defaultThinkingLevel: string;
  if (candidateDefaultEffort) {
    const mapped = effortToThinkingLevel(candidateDefaultEffort);
    if (thinkingLevels.includes(mapped)) {
      defaultThinkingLevel = mapped;
    } else {
      defaultThinkingLevel = clampModelThinkingLevel(mapped as ModelThinkingLevel, thinkingLevels)
        ?? (thinkingLevels.includes(CODEX_DEFAULT_THINKING_LEVEL) ? CODEX_DEFAULT_THINKING_LEVEL : (thinkingLevels[0] ?? "off"));
    }
  } else if (thinkingLevels.includes(CODEX_DEFAULT_THINKING_LEVEL)) {
    defaultThinkingLevel = CODEX_DEFAULT_THINKING_LEVEL;
  } else {
    defaultThinkingLevel = clampModelThinkingLevel(CODEX_DEFAULT_THINKING_LEVEL, thinkingLevels)
      ?? (thinkingLevels[0] ?? "off");
  }

  return {
    thinkingLevels,
    defaultThinkingLevel,
    isUnknownCapability: isUnknown,
  };
}

/**
 * 解析完整 Codex 目录的思维深度摘要。
 */
export function resolveCodexCatalogThinking(catalog: {
  models?: CodexRawCatalogModel[] | null;
  currentEffort?: string | null;
}): CodexCatalogThinkingSummary {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const defaultModel = models.find(m => m.isDefault) || models[0] || null;

  const thinkingLevels: Record<string, string[]> = {};
  for (const m of models) {
    const resolved = resolveCodexModelThinking(m, catalog.currentEffort);
    thinkingLevels["codex:" + m.id] = resolved.thinkingLevels;
  }

  let defaultThinkingLevel: string = CODEX_DEFAULT_THINKING_LEVEL;
  if (defaultModel) {
    const resolvedDefault = resolveCodexModelThinking(defaultModel, catalog.currentEffort);
    defaultThinkingLevel = resolvedDefault.defaultThinkingLevel;
  }

  return {
    thinkingLevels,
    defaultThinkingLevel,
    defaultModelId: defaultModel?.id ?? null,
  };
}
