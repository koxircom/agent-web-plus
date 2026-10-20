import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { readSessionList } from "@/lib/session-list";
import { startServerPerf } from "@/lib/perf";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const requestedEngine = searchParams.get("engine");
    const engine = requestedEngine === "pi" || requestedEngine === "codex" ? requestedEngine : undefined;
    const data = await readSessionList({ summary, force, engine });
    perf?.span("scan+projects");
    return perf?.attach(jsonResponse(
      req,
      data,
      { headers: { "Cache-Control": "no-store" } },
    )) ?? jsonResponse(
      req,
      data,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
