import { readExecutionEngineSettings } from "@/lib/execution-engine-settings";
import { NextResponse } from "next/server";
import { homedir } from "os";

export async function GET(req: Request) {
  const requested = new URL(req.url).searchParams.get("engine");
  const engine = requested === "pi" || requested === "codex" ? requested : (await readExecutionEngineSettings()).defaultEngine;
  if (engine === "codex") {
    const projects = await (await import("@/lib/execution-engines/codex-engine")).codexProjects();
    return Response.json({ home: projects[0]?.cwd || "" });
  }
  return NextResponse.json({ home: homedir() });
}
