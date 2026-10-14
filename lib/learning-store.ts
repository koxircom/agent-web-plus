import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { readRegularFileText } from "./regular-file";
import type { LearningLesson, LearningReview, LearningStatus } from "./learning-types";

export const LEARNING_MAX_LESSONS = 100;
export const LEARNING_MAX_CONTENT = 1200;
interface ProjectData { lessons: LearningLesson[]; reviews: LearningReview[] }
function root(agentDir = getAgentDir()): string { return join(agentDir, "learning"); }
function regular(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("学习存储不能是符号链接");
}
function directory(path: string): void { regular(path); mkdirSync(path, { recursive: true, mode: 0o700 }); }
function read<T>(path: string, fallback: T): T {
  regular(path); const text = readRegularFileText(path, 512 * 1024); return text === undefined ? fallback : JSON.parse(text) as T;
}
function atomic(path: string, data: unknown): void {
  regular(path); const temp = path + "." + randomUUID() + ".tmp";
  try { writeFileSync(temp, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function learningEnabled(agentDir = getAgentDir()): boolean {
  const data = read<{ enabled?: unknown }>(join(root(agentDir), "settings.json"), {});
  return data.enabled === true;
}
export function setLearningEnabled(enabled: boolean, agentDir = getAgentDir()): void {
  directory(root(agentDir)); const release = lockfile.lockSync(root(agentDir), { realpath: false });
  try { atomic(join(root(agentDir), "settings.json"), { enabled }); } finally { release(); }
}
export function learningProject(cwd: string): string { return realpathSync(resolve(cwd)); }
function projectFile(cwd: string, agentDir = getAgentDir()): string {
  regular(root(agentDir)); regular(join(root(agentDir), "projects"));
  const id = createHash("sha256").update(learningProject(cwd)).digest("hex");
  return join(root(agentDir), "projects", id + ".json");
}
export function readLearningProject(cwd: string, agentDir = getAgentDir()): ProjectData {
  const data = read<ProjectData>(projectFile(cwd, agentDir), { lessons: [], reviews: [] });
  if (!data || !Array.isArray(data.lessons) || !Array.isArray(data.reviews)
    || data.lessons.some(l => !l || !/^[a-f0-9]{24}$/.test(l.id) || typeof l.title !== "string" || typeof l.content !== "string" || !["experience", "skill"].includes(l.kind) || !["active", "candidate", "dismissed", "published"].includes(l.status))
    || data.reviews.some(r => !r || typeof r.id !== "string" || typeof r.updatedAt !== "string" || !["queued", "running", "completed", "failed", "skipped"].includes(r.status))) throw new Error("学习记录格式无效，请检查存储文件");
  return data;
}
function update(cwd: string, apply: (data: ProjectData) => void, agentDir = getAgentDir()): void {
  directory(root(agentDir)); const projects = join(root(agentDir), "projects"); directory(projects);
  const release = lockfile.lockSync(projects, { realpath: false });
  try { const data = readLearningProject(cwd, agentDir); apply(data); atomic(projectFile(cwd, agentDir), data); }
  finally { release(); }
}
export function learningStatus(cwd: string | null, agentDir = getAgentDir()): LearningStatus {
  const data = cwd ? readLearningProject(cwd, agentDir) : { lessons: [], reviews: [] };
  return { enabled: learningEnabled(agentDir), project: cwd ? learningProject(cwd) : null,
    lessons: data.lessons.filter(l => l.status !== "dismissed").slice().reverse(), lastReview: (() => {
      const review = data.reviews.at(-1);
      if (review && ["queued", "running"].includes(review.status) && Date.now() - Date.parse(review.updatedAt) > 12 * 60000)
        return { ...review, status: "failed" as const, error: "上次后台复盘中断，请完成新任务后再次复盘" };
      return review ?? null;
    })() };
}
export function saveLearningReview(cwd: string, review: LearningReview, agentDir = getAgentDir()): void {
  update(cwd, data => {
    const index = data.reviews.findIndex(r => r.id === review.id);
    if (index >= 0) data.reviews[index] = review; else data.reviews.push(review);
    data.reviews = data.reviews.slice(-40);
  }, agentDir);
}
export function reviewAlreadySeen(cwd: string, id: string, agentDir = getAgentDir()): boolean {
  return readLearningProject(cwd, agentDir).reviews.some(r => r.id === id);
}
export function redactLearningText(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[私钥已移除]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [已移除]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[凭据已移除]")
    .replace(/((?:api[_-]?key|password|passwd|secret|token|cookie|authorization|密码|密钥)["']?\s*[:=：]\s*["']?)[^\s,"'\n}]+/gi, "$1[已移除]")
    .replace(/https?:\/\/[^\s/]+:[^\s/@]+@/g, "https://[凭据已移除]@");
}
export function normalizeLearningOutput(value: unknown): Pick<LearningLesson, "title" | "content" | "kind">[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { lessons?: unknown }).lessons)) throw new Error("复盘结果格式无效");
  return ((value as { lessons: unknown[] }).lessons).slice(0, 3).map(item => {
    if (!item || typeof item !== "object") throw new Error("复盘经验格式无效");
    const row = item as Record<string, unknown>;
    if (typeof row.title !== "string" || typeof row.content !== "string" || !["experience", "skill"].includes(String(row.kind))) throw new Error("复盘经验字段无效");
    const title = redactLearningText(row.title.trim()).slice(0, 80);
    const content = redactLearningText(row.content.trim()).slice(0, LEARNING_MAX_CONTENT);
    if (!title || !content) throw new Error("复盘经验不能为空");
    return { title, content, kind: row.kind as LearningLesson["kind"] };
  });
}
export function saveLearningLessons(cwd: string, rows: ReturnType<typeof normalizeLearningOutput>, agentDir = getAgentDir(), sourceReviewId?: string): number {
  update(cwd, data => {
    const now = new Date().toISOString();
    for (const row of rows) {
      const id = createHash("sha256").update(row.kind + "\n" + row.content).digest("hex").slice(0, 24);
      const existing = data.lessons.find(l => l.id === id);
      if (existing) { existing.occurrences++; existing.updatedAt = now; continue; }
      if (data.lessons.length >= LEARNING_MAX_LESSONS) throw new Error("项目经验已达上限，请先整理记录");
      data.lessons.push({ ...row, id, status: row.kind === "skill" ? "candidate" : "active", createdAt: now, updatedAt: now, occurrences: 1, sourceReviewId });
    }
  }, agentDir); return rows.length;
}
export function relevantLearning(cwd: string, prompt: string, agentDir = getAgentDir()): LearningLesson[] {
  const clean = redactLearningText(prompt).toLowerCase();
  const words = [...new Set([...(clean.match(/[a-z0-9_]{3,}/g) ?? []), ...[...clean.matchAll(/(?=([\u4e00-\u9fff]{2}))/g)].map(m => m[1])])];
  return readLearningProject(cwd, agentDir).lessons.filter(l => l.kind === "experience" && l.status === "active")
    .map(l => ({ l, score: words.filter(w => (l.title + l.content).toLowerCase().includes(w)).length }))
    .filter(v => v.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(v => v.l);
}
export function dismissLearningLesson(cwd: string, id: string, agentDir = getAgentDir()): void {
  update(cwd, data => { const row = data.lessons.find(l => l.id === id); if (!row) throw new Error("经验记录不存在"); row.status = "dismissed"; }, agentDir);
}
export function adoptLearningSkill(cwd: string, id: string, agentDir = getAgentDir()): void {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("技能标识无效");
  update(cwd, data => {
    const row = data.lessons.find(l => l.id === id);
    if (!row || row.kind !== "skill" || row.status === "dismissed") throw new Error("技能建议不存在");
    const project = learningProject(cwd); const pi = join(project, ".pi"); directory(pi);
    const skills = join(pi, "skills"); directory(skills); const name = "pi-web-learned-" + id;
    const target = join(skills, name); directory(target); const file = join(target, "SKILL.md"); regular(file);
    const body = `---\nname: ${name}\ndescription: ${JSON.stringify(row.title)}\n---\n\n# ${row.title}\n\n${row.content}\n`;
    if (existsSync(file)) { if (readFileSync(file, "utf8") !== body) throw new Error("目标技能已有不同内容，已保留原文件"); }
    else writeFileSync(file, body, { flag: "wx", mode: 0o600 });
    row.status = "published"; row.skillPath = file; row.updatedAt = new Date().toISOString();
  }, agentDir);
}
