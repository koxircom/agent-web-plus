import { resolveExecutionEngine } from "@/lib/execution-engine-context";
import { readExecutionEngineSettings } from "@/lib/execution-engine-settings";
import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { defaultCwdPath } from "@/lib/default-cwd";

// POST /api/default-cwd
// Creates ~/pi-cwd/<YYYYMMDD> (local date) if it doesn't exist and returns the path.
// The client then selects it through /api/cwd/validate like any other directory.
export async function POST(req: Request) {
  let engine;
  try { engine = resolveExecutionEngine(new URL(req.url).searchParams.get("engine"), (await readExecutionEngineSettings()).defaultEngine); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
  if (engine === "codex") {
    const projects = await (await import("@/lib/execution-engines/codex-engine")).codexProjects();
    if (!projects[0]) return Response.json({ error: "Codex 尚未配置工作区" }, { status: 409 });
    return Response.json({ cwd: projects[0].cwd });
  }
  try {
    const dir = defaultCwdPath();
    mkdirSync(dir, { recursive: true });
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
