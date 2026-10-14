import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { adoptLearningSkill, dismissLearningLesson, learningProject, learningStatus, setLearningEnabled } from "@/lib/learning-store";
import { cancelLearningReviews } from "@/lib/learning-runtime";
export const dynamic = "force-dynamic";
async function project(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("项目目录无效");
  const cwd = learningProject(value);
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("不允许访问此项目目录");
  return cwd;
}
function failure(error: unknown, status = 400) { return NextResponse.json({ error: error instanceof Error ? error.message : "操作失败" }, { status }); }
export async function GET(req: Request) {
  try { return NextResponse.json(learningStatus(await project(new URL(req.url).searchParams.get("cwd")))); }
  catch (error) { return failure(error); }
}
function denied(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "不允许的请求来源" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "请求内容需为 JSON" }, { status: 415 });
}
export async function PUT(req: Request) {
  const rejection = denied(req); if (rejection) return rejection;
  try { const body = await req.json(); if (typeof body.enabled !== "boolean") throw new Error("请指定自动复盘开关");
    setLearningEnabled(body.enabled); if (!body.enabled) cancelLearningReviews(); return NextResponse.json({ enabled: body.enabled });
  } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  const rejection = denied(req); if (rejection) return rejection;
  try { const body = await req.json(); const cwd = await project(body.cwd);
    if (!cwd || typeof body.lessonId !== "string") throw new Error("请选择项目及经验记录");
    if (body.action === "dismiss") dismissLearningLesson(cwd, body.lessonId);
    else if (body.action === "adoptSkill") adoptLearningSkill(cwd, body.lessonId);
    else throw new Error("未知的经验操作");
    return NextResponse.json(learningStatus(cwd));
  } catch (error) { return failure(error); }
}
