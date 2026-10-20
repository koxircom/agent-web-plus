import { isCodexSessionId } from "@/lib/execution-engine-settings";
import { handleToolResultRequest } from "@/lib/session-tool-result-service";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; entryId: string }> }): Promise<Response> {
  const { id, entryId } = await params;
  if (isCodexSessionId(id)) {
    const revision = new URL(req.url).searchParams.get("revision") || "";
    if (!/^[0-9a-f]{32}\.[0-9a-f]{24}-[0-9]+$/.test(entryId) || !/^[0-9a-f]{24}$/.test(revision)) return Response.json({ error: "工具详情标识不正确" }, { status: 400 });
    const [epoch, key] = entryId.split(".");
    try {
      const { codexBridgeJson } = await import("@/lib/execution-engines/codex-bridge-client");
      const { rowText } = await import("@/lib/execution-engines/codex-engine");
      const detail = await codexBridgeJson(`/api/sessions/${id.slice(6)}/detail?${new URLSearchParams({ key: entryId, offset: "0", version: revision })}`);
      if (detail.version !== revision) return Response.json({ error: "工具结果已更新，请刷新会话" }, { status: 409 });
      const text = await rowText(id, epoch, { key, turnId: "", order: 0, version: revision, role: "activity", text: detail.text, truncated: detail.next !== null });
      return Response.json({ entryId, revision, result: { role: "toolResult", toolCallId: key, content: [{ type: "text", text }] } }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: 502 }); }
  }
  return handleToolResultRequest(req, { id, entryId });
}
