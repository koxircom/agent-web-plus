import { getUsagePricing } from "@/lib/usage-pricing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const pricing = await getUsagePricing();
    return Response.json(pricing, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[usage-pricing] Failed to fetch pricing snapshot:", error);
    return Response.json(
      { error: "未能获取到有效的价格目录数据" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
