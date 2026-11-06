import { codexBridgeRequest } from "@/lib/execution-engines/codex-bridge-client";
import { codexImagePath } from "@/lib/execution-engines/codex-image-path";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const path = codexImagePath(url.searchParams.get("thread"), url.searchParams.get("upload"), url.searchParams.get("desktop"));
  if (!path) return Response.json({ error: "图片标识不正确" }, { status: 400 });
  try {
    const result = await codexBridgeRequest(path);
    return new Response(result.body, { headers: {
      "Content-Type": result.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 502 }); }
}
