import { NextResponse } from "next/server";
import { DeleteJobError, deleteJobErrorStatus, getSessionDeleteJobs } from "@/lib/session-delete-jobs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const cursor = new URL(req.url).searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(cursor)) throw new DeleteJobError("删除进度游标无效");
    return NextResponse.json(getSessionDeleteJobs().events((await context.params).id, Number(cursor)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "删除进度暂时无法核对" }, { status: deleteJobErrorStatus(error, 503) }); }
}
