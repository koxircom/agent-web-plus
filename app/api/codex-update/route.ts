import { getCodexCliReleaseStatus } from "@/lib/codex-update";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getCodexCliReleaseStatus(), { headers: { "Cache-Control": "no-store" } });
}
