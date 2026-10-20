import { publicExecutionEngineSettings, readExecutionEngineSettings, saveExecutionEngineSettings } from "@/lib/execution-engine-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(publicExecutionEngineSettings(await readExecutionEngineSettings()), { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "请求来源不受信任" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "请使用 JSON 配置" }, { status: 415 });
  try { return Response.json(await saveExecutionEngineSettings(await request.json())); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
