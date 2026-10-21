import { NextResponse } from "next/server";
import { deleteSessions } from "@/lib/session-delete";
import { isCodexSessionId } from "@/lib/execution-engine-settings";

export async function POST(req: Request) {
  let ids: unknown;
  try { ids = (await req.json()).ids; } catch { return NextResponse.json({ error: "无效的删除请求" }, { status: 400 }); }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) =>
    typeof id !== "string" || id.length === 0 || id.length > 200 || /[\/\\\0]/.test(id))) {
    return NextResponse.json({ error: "每批需提供 1 至 100 个有效会话 ID" }, { status: 400 });
  }
  try {
    const hasCodex = ids.some((id) => isCodexSessionId(id));
    if (!hasCodex) {
      return NextResponse.json(await deleteSessions(ids, { origin: "api-batch" }));
    }

    const codexIds = ids.filter((id) => isCodexSessionId(id));
    const piIds = ids.filter((id) => !isCodexSessionId(id));

    const resultsMap = new Map<string, { id: string; ok: boolean; missing?: boolean; error?: string }>();
    const deletedSet = new Set<string>();
    let auditWarning: string | undefined;

    if (codexIds.length > 0) {
      const { deleteCodexSession } = await import("@/lib/execution-engines/codex-engine");
      const uniqueCodexIds = Array.from(new Set(codexIds));
      for (const id of uniqueCodexIds) {
        try {
          await deleteCodexSession(id);
          resultsMap.set(id, { id, ok: true });
          deletedSet.add(id);
        } catch (error: unknown) {
          const status = error && typeof error === "object" && "status" in error ? Number((error as { status?: number }).status) : 500;
          if (status === 404) {
            resultsMap.set(id, { id, ok: true, missing: true });
            deletedSet.add(id);
          } else {
            resultsMap.set(id, { id, ok: false, error: error instanceof Error ? error.message : "Codex 删除失败" });
          }
        }
      }
    }

    if (piIds.length > 0) {
      try {
        const piBatchResult = await deleteSessions(piIds, { origin: "api-batch" });
        for (const res of piBatchResult.results) {
          resultsMap.set(res.id, res);
        }
        for (const delId of piBatchResult.deletedSessionIds) {
          deletedSet.add(delId);
        }
        if (piBatchResult.auditWarning) {
          auditWarning = piBatchResult.auditWarning;
        }
      } catch (piError) {
        for (const pid of piIds) {
          resultsMap.set(pid, {
            id: pid,
            ok: false,
            error: piError instanceof Error ? piError.message : "Pi 批量删除失败",
          });
        }
      }
    }

    const rows = ids.map((id) => resultsMap.get(id) || { id, ok: false, error: "未处理项" });
    return NextResponse.json({
      results: rows,
      deletedSessionIds: Array.from(deletedSet),
      ...(auditWarning ? { auditWarning } : {}),
    });
  } catch (error) {
    return NextResponse.json({
      results: ids.map((id) => ({ id, ok: false, error: String(error) })),
      deletedSessionIds: [],
    });
  }
}
