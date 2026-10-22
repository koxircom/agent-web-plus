import { getUsageLedger, refreshUsageLedger, type UsageLedgerMode } from "@/lib/usage-ledger-service";
import { readUsageByEngine } from "@/lib/usage-ledger-engines";
import { getUsagePricing } from "@/lib/usage-pricing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function modeForError(error: unknown): UsageLedgerMode {
  const markedMode = (error as { mode?: unknown } | null)?.mode;
  if (markedMode === "legacy-central" || markedMode === "native-local") return markedMode;
  return process.env.PI_USAGE_DATA_DIR?.trim() ? "legacy-central" : "native-local";
}

function responseHeaders(mode: UsageLedgerMode) {
  return {
    "Cache-Control": "no-store",
    "X-Pi-Usage-Mode": mode,
  };
}

async function respond(operation: typeof getUsageLedger, refreshCodex = false) {
  try {
    const { ledger, mode } = await readUsageByEngine(operation, undefined, refreshCodex);
    let pricing;
    try {
      pricing = await getUsagePricing();
    } catch (pricingError) {
      console.warn("[usage-ledger] Failed to resolve pricing snapshot:", pricingError);
    }
    const responsePayload = pricing ? { ...ledger, pricing } : ledger;
    return Response.json(responsePayload, { headers: responseHeaders(mode) });
  } catch (error) {
    console.error("[usage-ledger] Snapshot request failed:", error);
    const mode = modeForError(error);
    return Response.json(
      { error: "未能获取到有效的账本快照数据" },
      { status: 503, headers: responseHeaders(mode) },
    );
  }
}

/** Read the validated central snapshot, or create the native instance snapshot once when absent. */
export async function GET() {
  return respond(getUsageLedger);
}

/** Native mode explicitly regenerates; central mode leaves its existing aggregator untouched. */
export async function POST() {
  return respond(refreshUsageLedger, true);
}
