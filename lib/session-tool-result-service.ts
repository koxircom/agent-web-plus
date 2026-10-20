import { resolveSessionPath } from "./session-reader";
import { getRpcSession } from "./rpc-manager";
import { getSessionHistoryPool, type SessionHistoryPool } from "./session-history-pool";
import { isSessionReadStable, selectSessionReadRuntime } from "./session-read-source";
import { entryToUiMessage } from "./session-context";
import { toolResultBodyRevision } from "./session-tool-result";
import { jsonResponse } from "./json-response";
import type { SessionEntry, SessionContext } from "./types";

export async function handleToolResultRequest(req: Request, params: { id: string; entryId: string }, deps: {
  getRpc?: typeof getRpcSession; resolvePath?: typeof resolveSessionPath; pool?: SessionHistoryPool;
} = {}): Promise<Response> {
  const revision = new URL(req.url).searchParams.get("revision");
  if (!revision || !/^[a-f0-9]{64}$/.test(revision)) return Response.json({ error: "工具结果版本无效。" }, { status: 400 });
  try {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const getRpc = deps.getRpc ?? getRpcSession;
    const initial = getRpc(params.id), live = selectSessionReadRuntime(initial);
    let message;
    if (live) {
      const entry = live.inner.sessionManager.getEntries().find(entry => entry.id === params.entryId);
      if (entry) message = entryToUiMessage(entry as unknown as SessionEntry, { deferToolResultImages: true, sessionId: params.id });
    } else {
      const filePath = await (deps.resolvePath ?? resolveSessionPath)(params.id);
      if (!filePath) return Response.json({ error: "会话不存在。" }, { status: 404 });
      const result = await (deps.pool ?? getSessionHistoryPool()).queryContextResult(filePath, {
        leafId: params.entryId, onlyEntry: true, requireCursor: true, deferToolResultImages: true,
        sessionId: params.id, signal: req.signal,
      });
      const data = JSON.parse(result.jsonString) as { context: SessionContext };
      if (data.context.entryIds.length === 1 && data.context.entryIds[0] === params.entryId) message = data.context.messages[0];
    }
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const current = getRpc(params.id);
    if (live ? current !== initial || selectSessionReadRuntime(current) !== live : !isSessionReadStable(initial, current)) return Response.json({ error: "会话写入状态已变化，请重新打开详情。" }, { status: 409 });
    if (!message || message.role !== "toolResult") return Response.json({ error: "工具结果不存在。" }, { status: 404 });
    if (toolResultBodyRevision(message) !== revision) return Response.json({ error: "工具结果已变化，请刷新会话后重新打开。" }, { status: 409 });
    return jsonResponse(req, { entryId: params.entryId, revision, result: message }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const err = error as { name?: string; statusCode?: number; code?: string };
    const status = req.signal.aborted || err.name === "HistoryAbortedError" ? 499 : err.statusCode ?? (err.code === "ENOENT" ? 404 : 500);
    return Response.json({ error: status === 404 ? "工具结果不存在。" : "读取工具结果失败，请重新打开详情重试。" }, { status, headers: status === 503 ? { "Retry-After": "1" } : undefined });
  }
}
