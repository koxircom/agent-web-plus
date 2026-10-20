import { isCodexSessionId } from "@/lib/execution-engine-settings";
import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (isCodexSessionId(id)) {
    const runtime = await (await import("@/lib/execution-engines/codex-engine")).getCodexRuntime(id);
    const state = await runtime.send({ type: "get_state" });
    return Response.json({ running: runtime.isStreaming, runtimeAlive: runtime.isAlive(), state });
  }
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: rpc.isRunning(), runtimeAlive: true, state });
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
