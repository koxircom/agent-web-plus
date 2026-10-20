import { NextResponse } from "next/server";
import { deleteSessions } from "@/lib/session-delete";

export async function POST(req: Request) {
  let ids: unknown;
  try { ids = (await req.json()).ids; } catch { return NextResponse.json({ error: "无效的删除请求" }, { status: 400 }); }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) =>
    typeof id !== "string" || id.length === 0 || id.length > 200 || /[\/\\\0]/.test(id))) {
    return NextResponse.json({ error: "每批需提供 1 至 100 个有效会话 ID" }, { status: 400 });
  }
  try { return NextResponse.json(await deleteSessions(ids, { origin: "api-batch" })); }
  catch (error) { return NextResponse.json({ error: String(error) }, { status: 500 }); }
}
