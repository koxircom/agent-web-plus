import { NextResponse } from "next/server";
import { deleteSessions } from "@/lib/session-delete";
import { isCodexSessionId } from "@/lib/execution-engine-settings";
import { createBatchDeleteStream, executeBatchDelete } from "@/lib/session-batch-delete";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "无效的删除请求" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "无效的删除请求" }, { status: 400 });
  }

  const rawObj = body as Record<string, unknown>;

  if ("stream" in rawObj && typeof rawObj.stream !== "boolean") {
    return NextResponse.json({ error: "stream 参数若存在必须为布尔值" }, { status: 400 });
  }

  const ids = rawObj.ids;
  const stream = rawObj.stream === true;

  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) =>
    typeof id !== "string" || id.length === 0 || id.length > 200 || /[\/\\\0]/.test(id))) {
    return NextResponse.json({ error: "每批需提供 1 至 100 个有效会话 ID" }, { status: 400 });
  }

  if (stream) {
    const readableStream = createBatchDeleteStream(ids, {
      signal: req.signal,
      origin: "api-batch",
    });
    return new Response(readableStream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  try {
    const hasCodex = ids.some((id) => isCodexSessionId(id));
    if (!hasCodex) {
      return NextResponse.json(await deleteSessions(ids, { origin: "api-batch" }));
    }

    const { results, deletedSessionIds, auditWarning } = await executeBatchDelete(ids, {
      signal: req.signal,
      origin: "api-batch",
    });

    const resultsMap = new Map(results.map((r) => [r.id, r]));
    const rows = ids.map((id) => resultsMap.get(id) || { id, ok: false, state: "failed", error: "未处理项" });

    return NextResponse.json({
      results: rows,
      deletedSessionIds,
      ...(auditWarning ? { auditWarning } : {}),
    });
  } catch (error) {
    return NextResponse.json({
      results: ids.map((id) => ({ id, ok: false, state: "failed", error: String(error) })),
      deletedSessionIds: [],
    });
  }
}
