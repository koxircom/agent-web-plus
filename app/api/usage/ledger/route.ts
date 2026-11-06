import type { UsageLedgerMode } from "@/lib/usage-ledger-service";
import { readUsageLedgerResponse } from "@/lib/usage-ledger-worker";

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
    "Vary": "Accept-Encoding",
  };
}

function acceptsUsageGzip(value: string | null) {
  return (value ?? "").split(",").some(part => {
    const [encoding, ...parameters] = part.trim().split(";");
    if (encoding.toLowerCase() !== "gzip") return false;
    const quality = parameters.map(v => v.trim()).find(v => /^q\s*=/i.test(v));
    return quality === undefined || Number(quality.split("=")[1]) > 0;
  });
}

async function respond(refresh = false, request?: Request) {
  try {
    const { body, compressed, mode, status } = await readUsageLedgerResponse(refresh);
    const encoded = acceptsUsageGzip(request?.headers.get("Accept-Encoding") ?? null) ? compressed : undefined;
    return new Response(encoded ?? body, { status, headers: { ...responseHeaders(mode), "Content-Type": "application/json", ...(encoded ? { "Content-Encoding": "gzip" } : {}) } });
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
export async function GET(request: Request) {
  return respond(false, request);
}

/** Native mode explicitly regenerates; central mode leaves its existing aggregator untouched. */
export async function POST(request: Request) {
  return respond(true, request);
}
