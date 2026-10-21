import { getCodexCliReleaseStatus } from "@/lib/codex-update";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const localOnlyParam = searchParams.get("localOnly");
  const localOnly = localOnlyParam === "1" || localOnlyParam === "true";
  return Response.json(await getCodexCliReleaseStatus({ localOnly }), {
    headers: { "Cache-Control": "no-store" },
  });
}
