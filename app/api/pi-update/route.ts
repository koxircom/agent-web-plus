import { NextResponse } from "next/server";
import { getLatestPiAgentRelease } from "@/lib/pi-update";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cachedOnly = searchParams.get("cachedOnly") === "1" || searchParams.get("cachedOnly") === "true";
  const force = searchParams.get("force") === "1" || searchParams.get("force") === "true";

  return NextResponse.json({
    installedVersion: process.env.NEXT_PUBLIC_PI_VERSION ?? null,
    ...await getLatestPiAgentRelease({ cachedOnly, force }),
  });
}
