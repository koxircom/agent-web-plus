import { readExecutionEngineSettings } from "@/lib/execution-engine-settings";
import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
  getRpcProjectStatusSnapshot,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET(request: Request) {
  const requestedEngine = new URL(request.url).searchParams.get("engine");
  const engine = requestedEngine === "pi" || requestedEngine === "codex" ? requestedEngine : (await readExecutionEngineSettings()).defaultEngine;
  if (engine === "codex") {
    try {
      const status = await (await import("@/lib/execution-engines/codex-engine")).codexRunningStatus(request.signal);
      return Response.json(status, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) return new Response(null, { status: 204 });
      throw error;
    }
  }
  return NextResponse.json(
    {
      ...getRpcProjectStatusSnapshot(),
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
