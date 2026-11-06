import { withConnectionDiagnostics } from "@/lib/connection-diagnostics-server";
import { isCodexSessionId } from "@/lib/execution-engine-settings";
import { createAgentEventStream } from "@/lib/agent-event-stream";
import { handleAgentEventBatchRequest } from "@/lib/native-event-batch";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events, or short-batch poll with ?format=batch
async function handleGet(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });
  const isBatch = new URL(req.url).searchParams.get("format") === "batch";

  if (isCodexSessionId(id)) {
    const sessionPromise = import("@/lib/execution-engines/codex-engine").then(m => m.getCodexRuntime(id));
    if (isBatch) {
      return handleAgentEventBatchRequest(req, id, () => sessionPromise);
    }
    return new Response(createAgentEventStream(req, id, sessionPromise), { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive", "X-Accel-Buffering": "no",
    } });
  }

  // Fast path: already-running session
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }

  if (isBatch) {
    return handleAgentEventBatchRequest(req, id, () => sessionPromise);
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withConnectionDiagnostics(request, () => handleGet(request, context));
}
