import { codexProjectKey } from "@/lib/execution-engines/codex-projection";
import { readExecutionEngineSettings } from "@/lib/execution-engine-settings";
import { NextResponse } from "next/server";
import { statSync, type Stats } from "fs";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { allowFileRoot } from "@/lib/file-access";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; engine?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const engine = body.engine === "pi" || body.engine === "codex" ? body.engine : (await readExecutionEngineSettings()).defaultEngine;
    if (engine === "codex") {
      const projects = await (await import("@/lib/execution-engines/codex-engine")).codexProjects();
      const project = projects.find(p => p.cwd === cwd || cwd.startsWith(p.cwd.replace(/\/$/, "") + "/"));
      if (project) {
        return Response.json({ success: true, cwd, projectRoot: project.cwd, projectKey: codexProjectKey(project.cwd) });
      }
      try {
        const { validateCodexCwd } = await import("@/lib/execution-engines/codex-workspaces");
        const validated = await validateCodexCwd(cwd);
        return Response.json({ success: true, cwd: validated.cwd, projectRoot: validated.projectRoot, projectKey: codexProjectKey(validated.projectRoot) });
      } catch {
        return Response.json({ error: "请选择 Codex 服务配置的工作区" }, { status: 400 });
      }
    }

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const normalizedCwd = normalizeCwd(cwd);
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    allowFileRoot(normalizedCwd);
    const project = await resolveProject(normalizedCwd);
    return NextResponse.json({
      success: true,
      cwd: normalizedCwd,
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
