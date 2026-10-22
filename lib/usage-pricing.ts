import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createModelRuntimeWithExtensions } from "@/lib/model-runtime";
import {
  shareModelCatalogRefresh,
  isModelNetworkDisabled,
  type CatalogRefreshResult,
} from "@/lib/model-catalog-refresh";

export type PricingSource = "pi-sdk" | "manual" | "fallback";

export interface ModelPricingRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  source: PricingSource;
  provider: "openai-codex";
  modelId: string;
  tiered: boolean;
}

export type PricingRefreshState = "current" | "cached" | "refreshing" | "error" | "offline";

export interface UsagePricingRefreshStatus {
  state: PricingRefreshState;
  attemptedAt?: string;
  message?: string;
}

export interface UsagePricingSnapshot {
  version: 1;
  currency: "USD";
  unit: "per_1m_tokens";
  updatedAt: string | null;
  refresh: UsagePricingRefreshStatus;
  models: Record<string, ModelPricingRate>;
}

export const PRICING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PRICING_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export interface ValidatedCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiered: boolean;
}

export function isValidPricingRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateAndExtractCost(cost: unknown): ValidatedCost | null {
  if (!cost || typeof cost !== "object") return null;
  const c = cost as Record<string, unknown>;
  if (
    !isValidPricingRate(c.input) ||
    !isValidPricingRate(c.output) ||
    !isValidPricingRate(c.cacheRead) ||
    !isValidPricingRate(c.cacheWrite)
  ) {
    return null;
  }
  const tiered = Array.isArray(c.tiers) && c.tiers.length > 0;
  return {
    input: c.input,
    output: c.output,
    cacheRead: c.cacheRead,
    cacheWrite: c.cacheWrite,
    tiered,
  };
}

export function areValidModelsPricing(
  models: Record<string, ModelPricingRate> | null | undefined,
): models is Record<string, ModelPricingRate> {
  if (!models || typeof models !== "object") return false;
  const entries = Object.entries(models);
  if (entries.length === 0) return false;
  for (const [modelId, rate] of entries) {
    if (!rate || typeof rate !== "object") return false;
    if (rate.modelId !== modelId || rate.provider !== "openai-codex") return false;
    if (
      !isValidPricingRate(rate.input) ||
      !isValidPricingRate(rate.output) ||
      !isValidPricingRate(rate.cacheRead) ||
      !isValidPricingRate(rate.cacheWrite)
    ) {
      return false;
    }
  }
  return true;
}

function hasExplicitCostField(cost: unknown): boolean {
  if (!cost || typeof cost !== "object") return false;
  const c = cost as Record<string, unknown>;
  return (
    isValidPricingRate(c.input) ||
    isValidPricingRate(c.output) ||
    isValidPricingRate(c.cacheRead) ||
    isValidPricingRate(c.cacheWrite) ||
    (Array.isArray(c.tiers) && c.tiers.length > 0)
  );
}

export function readManualCostModelIds(modelsJsonPath?: string): Set<string> {
  const manualIds = new Set<string>();
  try {
    const p = modelsJsonPath ?? path.join(getAgentDir(), "models.json");
    if (!fs.existsSync(p)) return manualIds;
    const content = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(content);
    const providerConfig = data?.providers?.["openai-codex"];
    if (!providerConfig || typeof providerConfig !== "object") return manualIds;

    // 1. modelOverrides
    const modelOverrides = providerConfig.modelOverrides;
    if (modelOverrides && typeof modelOverrides === "object") {
      for (const [modelId, override] of Object.entries(modelOverrides)) {
        if (
          override &&
          typeof override === "object" &&
          "cost" in override &&
          hasExplicitCostField((override as { cost?: unknown }).cost)
        ) {
          manualIds.add(modelId);
        }
      }
    }

    // 2. models array
    const modelsArr = providerConfig.models;
    if (Array.isArray(modelsArr)) {
      for (const m of modelsArr) {
        if (
          m &&
          typeof m === "object" &&
          typeof m.id === "string" &&
          "cost" in m &&
          hasExplicitCostField(m.cost)
        ) {
          manualIds.add(m.id);
        }
      }
    }
  } catch {
    // 忽略异常，私有配置不泄露
  }
  return manualIds;
}

export function readManualOverrides(modelsJsonPath?: string): Map<string, ValidatedCost> {
  const overrides = new Map<string, ValidatedCost>();
  try {
    const p = modelsJsonPath ?? path.join(getAgentDir(), "models.json");
    if (!fs.existsSync(p)) return overrides;
    const content = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(content);
    const providerConfig = data?.providers?.["openai-codex"];
    const modelOverrides = providerConfig?.modelOverrides;
    if (modelOverrides && typeof modelOverrides === "object") {
      for (const [modelId, override] of Object.entries(modelOverrides)) {
        if (override && typeof override === "object" && "cost" in override) {
          const valid = validateAndExtractCost((override as { cost?: unknown }).cost);
          if (valid) {
            overrides.set(modelId, valid);
          }
        }
      }
    }
  } catch {
    // 忽略异常，私有配置不泄露
  }
  return overrides;
}

export function getStoredCheckedAt(modelsStorePath?: string): number | null {
  try {
    const p = modelsStorePath ?? path.join(getAgentDir(), "models-store.json");
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(content);
    const checkedAt = data?.["openai-codex"]?.checkedAt;
    return typeof checkedAt === "number" && Number.isFinite(checkedAt) && checkedAt > 0
      ? checkedAt
      : null;
  } catch {
    return null;
  }
}

export function getFileMtime(filePath?: string): number {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function getModelsJsonMtime(modelsJsonPath?: string): number {
  return getFileMtime(modelsJsonPath ?? path.join(getAgentDir(), "models.json"));
}

export function getModelsStoreMtime(modelsStorePath?: string): number {
  return getFileMtime(modelsStorePath ?? path.join(getAgentDir(), "models-store.json"));
}

export function buildPricingModels(
  runtimeModels: readonly { provider: string; id: string; cost?: unknown }[],
  manualCostModelIds?: Set<string> | Map<string, unknown>,
): Record<string, ModelPricingRate> {
  const result: Record<string, ModelPricingRate> = {};
  const isManual = (id: string): boolean => {
    if (!manualCostModelIds) return false;
    if (manualCostModelIds instanceof Set) return manualCostModelIds.has(id);
    if (manualCostModelIds instanceof Map) return manualCostModelIds.has(id);
    return false;
  };

  for (const m of runtimeModels) {
    if (m.provider !== "openai-codex") continue;

    // 费率以 runtime 合并后为唯一数值源，不自己重复实现半套覆盖
    const sdkCost = validateAndExtractCost(m.cost);
    if (sdkCost) {
      result[m.id] = {
        input: sdkCost.input,
        output: sdkCost.output,
        cacheRead: sdkCost.cacheRead,
        cacheWrite: sdkCost.cacheWrite,
        source: isManual(m.id) ? "manual" : "pi-sdk",
        provider: "openai-codex",
        modelId: m.id,
        tiered: sdkCost.tiered,
      };
    }
  }

  return result;
}

export interface UsagePricingManagerOptions {
  now?: () => number;
  runtimeFactory?: () => Promise<{ getModels: () => readonly { provider: string; id: string; cost?: unknown }[] }>;
  refreshFn?: (options?: { providers?: readonly string[] }) => Promise<CatalogRefreshResult>;
  modelsJsonPath?: string;
  modelsStorePath?: string;
  initialCheckedAt?: number | null;
  isOffline?: () => boolean;
}

export class UsagePricingManager {
  private now: () => number;
  private runtimeFactory: () => Promise<{ getModels: () => readonly { provider: string; id: string; cost?: unknown }[] }>;
  private refreshFn: (options?: { providers?: readonly string[] }) => Promise<CatalogRefreshResult>;
  private modelsJsonPath?: string;
  private modelsStorePath?: string;
  private initialCheckedAt?: number | null;
  private isOffline: () => boolean;

  private cachedSnapshot: UsagePricingSnapshot | null = null;
  private modelsJsonMtimeMs = -1;
  private modelsStoreMtimeMs = -1;
  private modelsStoreCheckedAt: number | null = null;
  // SDK checkedAt records attempts (including failed HTTP reads), not successful updates.
  private lastRefreshedAt = 0;
  private lastVerifiedRefreshedAt = 0;
  private lastAttemptedAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshError: { attemptedAt: string; message: string } | null = null;
  private initOrSyncPromise: Promise<void> | null = null;

  constructor(options: UsagePricingManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.runtimeFactory = options.runtimeFactory ?? createModelRuntimeWithExtensions;
    this.refreshFn = options.refreshFn ?? shareModelCatalogRefresh;
    this.modelsJsonPath = options.modelsJsonPath;
    this.modelsStorePath = options.modelsStorePath;
    this.initialCheckedAt = options.initialCheckedAt;
    this.isOffline = options.isOffline ?? isModelNetworkDisabled;
  }

  public invalidate(): void {
    this.cachedSnapshot = null;
    this.modelsJsonMtimeMs = -1;
    this.modelsStoreMtimeMs = -1;
    this.modelsStoreCheckedAt = null;
    this.lastVerifiedRefreshedAt = 0;
    this.initOrSyncPromise = null;
  }

  public async getPricing(): Promise<UsagePricingSnapshot> {
    const offline = this.isOffline();
    const currentJsonMtime = getModelsJsonMtime(this.modelsJsonPath);
    const currentStoreMtime =
      this.modelsStorePath !== undefined
        ? getModelsStoreMtime(this.modelsStorePath)
        : this.initialCheckedAt !== undefined
        ? 0
        : getModelsStoreMtime();
    const currentStoredCheckedAt =
      this.modelsStorePath !== undefined
        ? getStoredCheckedAt(this.modelsStorePath)
        : this.initialCheckedAt !== undefined
        ? this.initialCheckedAt
        : getStoredCheckedAt();

    const needsInit = !this.cachedSnapshot;
    const needsJsonSync = currentJsonMtime !== this.modelsJsonMtimeMs;
    const needsStoreSync =
      currentStoreMtime !== this.modelsStoreMtimeMs ||
      (currentStoredCheckedAt !== null &&
        currentStoredCheckedAt !== this.modelsStoreCheckedAt);

    // 满足初始化或文件 mtime/checkedAt 变动时，singleflight 执行 runtime 成本同步
    if (needsInit || needsJsonSync || needsStoreSync) {
      if (!this.initOrSyncPromise) {
        this.initOrSyncPromise = this.syncRuntimeState({
          currentJsonMtime,
          currentStoreMtime,
          currentStoredCheckedAt,
          offline,
        }).finally(() => {
          this.initOrSyncPromise = null;
        });
      }
      await this.initOrSyncPromise;
    }

    // 判断是否需要触发 24h 自动后台刷新（或失败后的冷却重试）
    const needsRefresh = this.lastRefreshError
      ? this.now() - this.lastAttemptedAt >= PRICING_RETRY_COOLDOWN_MS
      : this.now() - this.lastRefreshedAt >= PRICING_REFRESH_INTERVAL_MS;

    if (!offline && needsRefresh && !this.refreshPromise) {
      this.triggerBackgroundRefresh();
    }

    // 构建对外返回的只读副本
    const refreshStatus: UsagePricingRefreshStatus = offline
      ? { state: "offline" }
      : this.refreshPromise
      ? { state: "refreshing" }
      : this.lastRefreshError
      ? {
          state: "error",
          attemptedAt: this.lastRefreshError.attemptedAt,
          message: this.lastRefreshError.message,
        }
      : {
          state:
            this.lastVerifiedRefreshedAt > 0 && this.now() - this.lastRefreshedAt < PRICING_REFRESH_INTERVAL_MS
              ? "current"
              : "cached",
        };

    const snapshot = this.cachedSnapshot ?? {
      version: 1,
      currency: "USD",
      unit: "per_1m_tokens",
      updatedAt: null,
      refresh: refreshStatus,
      models: {},
    };

    return {
      version: 1,
      currency: "USD",
      unit: "per_1m_tokens",
      updatedAt: snapshot.updatedAt,
      refresh: refreshStatus,
      models: { ...snapshot.models },
    };
  }

  private async syncRuntimeState(params: {
    currentJsonMtime: number;
    currentStoreMtime: number;
    currentStoredCheckedAt: number | null;
    offline: boolean;
  }): Promise<void> {
    const {
      currentJsonMtime,
      currentStoreMtime,
      currentStoredCheckedAt,
      offline,
    } = params;

    let freshModels: Record<string, ModelPricingRate> | null = null;
    try {
      const runtime = await this.runtimeFactory();
      const manualIds = readManualCostModelIds(this.modelsJsonPath);
      const built = buildPricingModels(runtime.getModels(), manualIds);
      if (areValidModelsPricing(built)) {
        freshModels = built;
      }
    } catch {
      freshModels = null;
    }

    if (freshModels) {
      // 成功验证非空且所有费率有限有效，才提交状态与 mtime 记录
      this.modelsJsonMtimeMs = currentJsonMtime;
      this.modelsStoreMtimeMs = currentStoreMtime;

      const isNewStoreCheckedAt =
        currentStoredCheckedAt !== null &&
        currentStoredCheckedAt !== this.modelsStoreCheckedAt;
      this.modelsStoreCheckedAt = currentStoredCheckedAt;

      if (isNewStoreCheckedAt && currentStoredCheckedAt > 0) {
        // Use the SDK check timestamp only to avoid duplicate download attempts.
        // A failed SDK refresh also persists checkedAt: never clear errors from it.
        this.lastRefreshedAt = currentStoredCheckedAt;
      }
      if (this.cachedSnapshot && JSON.stringify(this.cachedSnapshot.models) !== JSON.stringify(freshModels)) {
        this.lastVerifiedRefreshedAt = 0;
      }
      const updatedAt = this.lastVerifiedRefreshedAt > 0
        ? new Date(this.lastVerifiedRefreshedAt).toISOString() : null;

      if (this.cachedSnapshot) {
        this.cachedSnapshot.models = freshModels;
        this.cachedSnapshot.updatedAt = updatedAt;
      } else {
        const isFresh =
          this.lastVerifiedRefreshedAt > 0 &&
          this.now() - this.lastRefreshedAt < PRICING_REFRESH_INTERVAL_MS;

        this.cachedSnapshot = {
          version: 1,
          currency: "USD",
          unit: "per_1m_tokens",
          updatedAt,
          refresh: {
            state: offline ? "offline" : isFresh ? "current" : "cached",
          },
          models: freshModels,
        };
      }
    } else {
      // 重取失败或提取无效：绝对不把 mtime 标记为已同步，保留旧有效缓存，供后续 read 重试
      if (!this.cachedSnapshot) {
        if (currentStoredCheckedAt && this.lastRefreshedAt === 0) {
          this.lastRefreshedAt = currentStoredCheckedAt;
        }
        this.cachedSnapshot = {
          version: 1,
          currency: "USD",
          unit: "per_1m_tokens",
          updatedAt: null,
          refresh: {
            state: offline ? "offline" : "error",
            message: "Failed to initialize valid pricing models from runtime",
          },
          models: {},
        };
      }
    }
  }

  private triggerBackgroundRefresh(): void {
    const attemptTime = this.now();
    this.lastAttemptedAt = attemptTime;
    const attemptedAt = new Date(attemptTime).toISOString();
    const promise = (async () => {
      try {
        const result = await this.refreshFn({ providers: ["openai-codex"] });
        if (result.completed) {
          let freshModels: Record<string, ModelPricingRate> | null = null;
          try {
            const freshRuntime = await this.runtimeFactory();
            const manualIds = readManualCostModelIds(this.modelsJsonPath);
            const built = buildPricingModels(freshRuntime.getModels(), manualIds);
            if (areValidModelsPricing(built)) {
              freshModels = built;
            }
          } catch {
            freshModels = null;
          }

          if (freshModels) {
            const finishTime = this.now();
            this.lastRefreshedAt = finishTime;
            this.lastVerifiedRefreshedAt = finishTime;
            this.lastRefreshError = null;
            this.modelsJsonMtimeMs = getModelsJsonMtime(this.modelsJsonPath);
            this.modelsStoreMtimeMs = this.modelsStorePath !== undefined || this.initialCheckedAt === undefined
              ? getModelsStoreMtime(this.modelsStorePath) : 0;
            this.modelsStoreCheckedAt = this.modelsStorePath !== undefined || this.initialCheckedAt === undefined
              ? getStoredCheckedAt(this.modelsStorePath) : this.initialCheckedAt;
            if (this.cachedSnapshot) {
              this.cachedSnapshot = {
                version: 1,
                currency: "USD",
                unit: "per_1m_tokens",
                updatedAt: new Date(finishTime).toISOString(),
                refresh: {
                  state: "current",
                },
                models: freshModels,
              };
            }
          } else {
            // freshModels 为空或损坏：不能清掉有效 cached 模型，不能先把 lastRefreshedAt 设成功
            // 失败保旧且状态设为 error
            this.lastRefreshError = {
              attemptedAt,
              message: "Refreshed catalog contains empty or invalid pricing models",
            };
          }
        } else {
          const message = result.reason
            ? `Refresh skipped: ${result.reason}`
            : "Refresh failed to complete";
          this.lastRefreshError = { attemptedAt, message };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastRefreshError = { attemptedAt, message };
      } finally {
        this.refreshPromise = null;
      }
    })();
    this.refreshPromise = promise;
  }

  public async getModelPricing(modelId: string): Promise<ModelPricingRate | undefined> {
    const snapshot = await this.getPricing();
    return snapshot.models[modelId];
  }

  public getRunningRefreshPromise(): Promise<void> | null {
    return this.refreshPromise;
  }
}

declare global {
  var __piDefaultUsagePricingManager: UsagePricingManager | undefined;
}

function getDefaultManager(): UsagePricingManager {
  if (!globalThis.__piDefaultUsagePricingManager) {
    globalThis.__piDefaultUsagePricingManager = new UsagePricingManager();
  }
  return globalThis.__piDefaultUsagePricingManager;
}

export function getUsagePricing(): Promise<UsagePricingSnapshot> {
  return getDefaultManager().getPricing();
}

export function getModelPricing(modelId: string): Promise<ModelPricingRate | undefined> {
  return getDefaultManager().getModelPricing(modelId);
}

export function invalidateUsagePricingCache(): void {
  getDefaultManager().invalidate();
}
