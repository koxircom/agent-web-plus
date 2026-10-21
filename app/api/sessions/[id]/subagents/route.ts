import { isCodexSessionId } from "@/lib/execution-engine-settings";
import { fetchCodexSubagents } from "@/lib/execution-engines/codex-subagents";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isCodexSessionId(id)) {
    return Response.json(
      { error: "当前会话不支持 Codex 原生子智能体" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  const url = new URL(req.url);
  const agentId = url.searchParams.get("id");

  try {
    const result = await fetchCodexSubagents(id, agentId, req.signal);
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number(error.status)
        : 502;
    const message =
      error instanceof Error ? error.message : "子智能体记录暂时无法读取，请稍后重试";
    return Response.json(
      { error: message },
      {
        status: status >= 400 && status <= 599 ? status : 502,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}

export async function POST() {
  return Response.json(
    { error: "子智能体面板仅支持只读查看" },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } }
  );
}

export async function PUT() {
  return Response.json(
    { error: "子智能体面板仅支持只读查看" },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } }
  );
}

export async function DELETE() {
  return Response.json(
    { error: "子智能体面板仅支持只读查看" },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } }
  );
}
