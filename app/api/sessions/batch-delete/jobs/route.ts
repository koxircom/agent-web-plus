import { NextResponse } from "next/server";
import { DeleteJobError, deleteJobErrorStatus, getSessionDeleteJobs, validateDeleteJob } from "@/lib/session-delete-jobs";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "无效的删除任务请求", accepted: false }, { status: 400 }); }
  try {
    if (!body || typeof body !== "object") throw new DeleteJobError("无效的删除任务请求");
    validateDeleteJob(body.id, body.ids);
    const data = getSessionDeleteJobs().create(body.id as string, body.ids);
    return NextResponse.json(data, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = deleteJobErrorStatus(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除任务创建结果待核对",
      ...([400, 409].includes(status) ? { accepted: false } : {}) }, { status });
  }
}
export async function GET() {
  try { return NextResponse.json({ jobs: getSessionDeleteJobs().list() }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "删除任务状态暂时无法核对" }, { status: 503 }); }
}
