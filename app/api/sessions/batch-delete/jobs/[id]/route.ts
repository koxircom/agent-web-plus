import { NextResponse } from "next/server";
import { deleteJobErrorStatus, getSessionDeleteJobs } from "@/lib/session-delete-jobs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(getSessionDeleteJobs().get((await context.params).id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "删除任务状态暂时无法核对" }, { status: deleteJobErrorStatus(error, 503) }); }
}
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(getSessionDeleteJobs().cancel((await context.params).id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "取消结果暂时无法核对" }, { status: deleteJobErrorStatus(error, 503) }); }
}
