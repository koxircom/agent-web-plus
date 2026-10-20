import { isCodexSessionId } from "@/lib/execution-engine-settings";

/** Optional read-only capability; unsupported engines retain native pagination. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCodexSessionId(id)) return new Response(null, { status: 204 });
  try {
    const { codexNavigationIndex } = await import("@/lib/execution-engines/codex-engine");
    const result = await codexNavigationIndex(id, req.signal);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 502;
    return Response.json({ error: "轮次索引暂时无法读取，请重试" },
      { status: status >= 400 && status <= 599 ? status : 502 });
  }
}
