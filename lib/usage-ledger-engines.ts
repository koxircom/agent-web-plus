import { createHash } from "node:crypto";
import path from "node:path";
import { loadNativeCommonJs, resolveUsageGuardBinDir } from "./usage-delete-guard";
import type { UsageLedger, UsageLedgerMode } from "./usage-ledger-service";

type Status = { status: "ready" | "partial" | "loading" | "unavailable" | "disabled"; message?: string };
type Snapshot = UsageLedger & { sources?: Record<string, unknown>; sessions?: Record<string, unknown>; loading?: boolean; error?: string };
type PiResult = { ledger: UsageLedger; mode: UsageLedgerMode };
type Outcome<T> = { value: T } | { error: unknown };
const core = loadNativeCommonJs<{ validate: (ledger: unknown) => unknown; aggregate: (ledger: unknown) => Record<string, unknown> }>(path.join(resolveUsageGuardBinDir(), "usage-ledger-core.js"));
const settle = async <T>(work: () => Promise<T>): Promise<Outcome<T>> => {
  try { return { value: await work() }; } catch (error) { return { error }; }
};

/** A missing execution host is explicit partial coverage, never a successful zero. */
export function combineUsageLedgers(pi: Outcome<PiResult>, codex: Outcome<Snapshot | null>) {
  const piValue = "value" in pi ? pi.value : null;
  const codexValue = "value" in codex ? codex.value : null;
  if (!piValue && !codexValue) throw ("error" in pi ? pi.error : new Error("用量账本暂不可用"));
  if (codexValue) core.validate(codexValue);
  const coverage = codexValue?.sources?.codex as { complete?: boolean; counterGapCount?: number; unavailableHistoryCount?: number } | undefined;
  const engineStatus: { pi: Status; codex: Status } = {
    pi: piValue ? { status: "ready" } : { status: "unavailable", message: "Pi Agent 用量暂不可用，当前统计不完整" },
    codex: "error" in codex ? { status: "unavailable", message: "Codex 用量暂不可用，请检查执行端连接或升级连接器" }
      : !codexValue ? { status: "disabled", message: "尚未启用 Codex 执行引擎" }
      : codexValue.error ? { status: "unavailable", message: "Codex 用量同步失败，保留上次快照" }
      : codexValue.loading ? { status: "loading", message: "正在整理 Codex 历史用量，当前统计尚未完整" }
      : coverage?.unavailableHistoryCount ? { status: "partial", message: `Codex 有 ${coverage.unavailableHistoryCount} 条历史记录的文件已不可用，仅统计可核对用量` }
      : coverage?.complete === false ? coverage.counterGapCount
        ? { status: "unavailable", message: "Codex 部分历史计数缺失，当前仅展示可核对用量" }
        : { status: "loading", message: "正在等待 Codex 历史记录写入完成，当前仅展示完整记录" }
      : { status: "ready" },
  };
  const tag = (ledger: Snapshot | null, engine: "pi" | "codex") => (ledger?.buckets || []).map(bucket => ({ ...(bucket as Record<string, unknown>), engine }));
  const old = piValue?.ledger as Snapshot | undefined;
  const ledger: Snapshot = {
    ...(old || {}), version: 2,
    generatedAt: new Date().toISOString(),
    snapshotId: !codexValue && !("error" in codex) ? old?.snapshotId : createHash("sha256").update(JSON.stringify([old?.snapshotId, codexValue?.snapshotId, engineStatus])).digest("hex").slice(0, 24),
    buckets: [...tag(old || null, "pi"), ...tag(codexValue, "codex")],
    sessions: { ...old?.sessions, ...codexValue?.sessions },
    sources: { ...old?.sources, ...(codexValue?.sources || {}) },
    engineStatus,
  };
  // Totals are derived from the same physical buckets consumed by the dashboard.
  const aggregate = core.aggregate(ledger);
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "messageCount", "calls", "records", "costNano", "unpricedTokens", "missingUsage"];
  ledger.totals = Object.fromEntries(fields.map(key => [key, aggregate[key]]));
  core.validate(ledger);
  return { ledger, mode: piValue?.mode || "native-local" as UsageLedgerMode };
}

export async function readUsageByEngine(operation: () => Promise<PiResult>, readCodex?: () => Promise<Snapshot | null>, refreshCodex = false) {
  const codex = readCodex || (async () => {
    const { readExecutionEngineSettings } = await import("./execution-engine-settings");
    if (!(await readExecutionEngineSettings()).codex.enabled) return null;
    const { codexBridgeJson } = await import("./execution-engines/codex-bridge-client");
    const ledger = await codexBridgeJson(`/api/usage/ledger${refreshCodex ? "?refresh=1" : ""}`, undefined, { timeout: 10000 });
    core.validate(ledger);
    return ledger as Snapshot;
  });
  const [piResult, codexResult] = await Promise.all([settle(operation), settle(codex)]);
  return combineUsageLedgers(piResult, codexResult);
}
