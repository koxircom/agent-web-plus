import type { BrowserTabAppearance } from "@/lib/browser-tab-appearance";
import { readAgentWebSettings, normalizeBrowserTabTitle } from "@/lib/browser-tab-title";
import { readExecutionEngineSettings } from "@/lib/execution-engine-settings";
import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
  getRpcProjectStatusSnapshot,
  getRpcWaitingSessionsSnapshot,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET(request: Request) {
  const requestedEngine = new URL(request.url).searchParams.get("engine");
  const engine = requestedEngine === "pi" || requestedEngine === "codex" ? requestedEngine : (await readExecutionEngineSettings()).defaultEngine;
  // Shared transport, independent errors: malformed title settings must not
  // turn a healthy task-status response into an outage.
  let titleFields: { browserTitle?: { version: number; revision: number; title: string; customTitle: string; appearance?: BrowserTabAppearance | null }; browserTitleError?: string };
  try {
    const { settings } = await readAgentWebSettings();
    titleFields = { browserTitle: { version: settings.version, revision: settings.revision, title: settings.title, customTitle: normalizeBrowserTabTitle(settings.title), ...(settings.tabAppearance ? {appearance: settings.tabAppearance} : {}) } };
  } catch {
    titleFields = { browserTitleError: "Failed to read browser title settings" };
  }
  if (engine === "codex") {
    try {
      const status = await (await import("@/lib/execution-engines/codex-engine")).codexRunningStatus(request.signal);
      return Response.json({ ...status, ...titleFields }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) return new Response(null, { status: 204 });
      throw error;
    }
  }
  const waitingResult = await getRpcWaitingSessionsSnapshot();
  return NextResponse.json(
    {
      ...getRpcProjectStatusSnapshot(),
      ...titleFields,
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      collaborationWaitingSessions: waitingResult.sessions,
      collaborationAuthorityAvailable: waitingResult.authorityAvailable,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
