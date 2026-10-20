import { codexBridgeJson } from "@/lib/execution-engines/codex-bridge-client";
import { codexConnectionIdentity } from "@/lib/execution-engine-settings";
import { inspectCodexCompatibility, CodexCompatibilityError } from "@/lib/execution-engines/codex-compatibility";
import { isApiRequestAllowed } from "@/lib/request-security";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "请求来源不受信任" }, { status: 403 });
  try {
    const connectionIdentity = await codexConnectionIdentity();
    const read = async (path: string) => {
      try { return await codexBridgeJson(path, undefined, { connectionIdentity }); }
      catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 404) {
          throw new CodexCompatibilityError("此地址没有提供 Agent Web Plus 所需的项目级接口。请使用本项目附带的独立连接器，旧版桌面 Bridge 不能直接替代。");
        }
        throw error;
      }
    };
    const result = await read("/api/projects");
    if (!Array.isArray(result.projects) || !result.projects.length) throw new Error("Codex 服务没有配置可用的工作区");
    const compatibility = inspectCodexCompatibility(result.compatibility,
      result.compatibility === undefined ? await read("/api/runtime") : undefined);
    if (new URL(request.url).searchParams.get("catalog") !== "0") {
      const project = result.projects[0];
      const catalog = await read(`/api/projects/catalog?${new URLSearchParams({ project: project.key, kind: "models" })}`);
      if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error("Codex 执行端未返回可用模型");
    }
    return Response.json({ connected: true, projects: result.projects, compatibility });
  } catch (error) {
    return Response.json({ connected: false, projects: [], error: (error as Error).message,
      ...(error instanceof CodexCompatibilityError ? { code: error.code } : {}) },
      { status: error instanceof CodexCompatibilityError ? 409 : 502 });
  }
}
