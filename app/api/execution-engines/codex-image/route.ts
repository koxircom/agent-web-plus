import { codexBridgeRequest } from "@/lib/execution-engines/codex-bridge-client";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const thread = url.searchParams.get("thread"), upload = url.searchParams.get("upload");
  if (![thread, upload].every(v => v && /^[0-9a-f-]{36}$/.test(v))) return Response.json({ error: "图片标识不正确" }, { status: 400 });
  try {
    const result = await codexBridgeRequest(`/api/sessions/${thread}/uploads/${upload}/preview?variant=original`);
    return new Response(result.body, { headers: {
      "Content-Type": result.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 502 }); }
}
