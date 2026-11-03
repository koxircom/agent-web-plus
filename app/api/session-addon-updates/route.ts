import { NextResponse } from "next/server";
import { readSessionAddonUpdates } from "@/lib/session-addon-updates";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await readSessionAddonUpdates();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "获取插件更新状态失败 / Failed to read session addon updates" },
      { status: 500 }
    );
  }
}

