import { isCodexSessionId } from "@/lib/execution-engine-settings";
import { handleSessionContextRequest } from "@/lib/session-context-service";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (isCodexSessionId(id)) {
    const engine = await import("@/lib/execution-engines/codex-engine");
    const query = new URL(req.url).searchParams;
    const before = query.get("before") || undefined;
    try {
    const rawTail = Number(query.get("tail"));
    const limit = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(1000, rawTail) : 50;
    const page = await engine.codexSessionPage(id, { before, limit, signal: req.signal });
    const projected = (await import("@/lib/execution-engines/codex-projection")).projectCodexPage(page, id);
    // Ancestors are read-only snapshots, not live tool-result bubbles. They
    // must satisfy the native history-page contract, even during a long turn.
    for (const message of projected.context.messages) if (message.role === "toolResult") delete message.inProgress;
    return Response.json({ context: projected.context, before: before || null }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 502;
      return Response.json({ error: error instanceof Error ? error.message : "历史记录暂时无法读取" },
        { status: status >= 400 && status <= 599 ? status : 502, headers: { "Cache-Control": "no-store" } });
    }
  }
  return handleSessionContextRequest(req, { id });
}

export async function HEAD(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (isCodexSessionId(id)) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  return handleSessionContextRequest(req, { id });
}
