import "server-only";
import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { readExecutionEngineSettings } from "../execution-engine-settings";
import { resolveExecutionEngine } from "../execution-engine-context";
import { codexBridgeJson, codexBridgeRequest, CodexBridgeError } from "./codex-bridge-client";
import { codexProjects } from "./codex-engine";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
  getVideoMime,
} from "../file-types";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "../bounded-form-data";
import { parseUploadConflictStrategy, validateUploadFileNames } from "../file-upload";

const MAX_CODEX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CODEX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_CODEX_UPLOAD_REQUEST_BYTES = MAX_CODEX_UPLOAD_TOTAL_BYTES + 1024 * 1024;
const TEXT_CHUNK_BYTES = 256 * 1024;
const CODEX_DIRECTORY_ENTRY_CAP = 50_000;
const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);
const IGNORED_SUFFIXES = [".pyc"];

type CodexProject = { key: string; name: string; cwd: string };
export type CodexWorkspaceOperation = "list" | "info" | "preview" | "download" | "upload" | "git-status" | "git-diff";

export interface CodexWorkspaceTarget {
  project: CodexProject;
  /** Workspace-relative path accepted by Workspace.parts(). */
  relativePath: string;
  /** Lexical remote path used by the native Pi UI and @ references. */
  fullPath: string;
}

class CodexWorkspacePathError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

function canonicalAbsolutePath(value: string): string | null {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
  const normalized = value.replace(/\\/g, "/");
  const isPosix = normalized.startsWith("/");
  const isDrive = /^[A-Za-z]:\//.test(normalized);
  if (!isPosix && !isDrive) return null;
  const prefixLength = isDrive ? 3 : 1;
  const rest = normalized.slice(prefixLength);
  if (rest && rest.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  if (isDrive && rest.includes(":")) return null;
  if (!isDrive && normalized.slice(1).includes(":")) return null;
  if (isDrive && rest.length === 0) return normalized.slice(0, 3);
  const trimmed = normalized.replace(/\/+$/, "");
  return trimmed || "/";
}

function absolutePathContains(root: string, candidate: string): boolean {
  const windows = /^[A-Za-z]:\//.test(root);
  const lhs = windows ? root.toLowerCase() : root;
  const rhs = windows ? candidate.toLowerCase() : candidate;
  if (rhs === lhs) return true;
  const prefix = lhs.endsWith("/") ? lhs : lhs + "/";
  return rhs.startsWith(prefix);
}

function relativePathFromAbsolute(root: string, candidate: string): string {
  if (candidate === root) return "";
  return candidate.slice(root.endsWith("/") ? root.length : root.length + 1);
}

function validateWorkspaceRelativePath(value: string, allowEmpty = true): string | null {
  if (value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith("/")) {
    return "文件路径无效";
  }
  if (!value) return allowEmpty ? null : "请选择文件";
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "只能访问当前项目内的文件";
  return null;
}

export async function shouldUseCodexWorkspace(
  sessionId?: string | null,
  requestedEngine?: unknown,
): Promise<boolean> {
  const fallback = (await readExecutionEngineSettings()).defaultEngine;
  const engine = resolveExecutionEngine(requestedEngine, fallback, sessionId);
  return engine === "codex";
}

export async function resolveCodexWorkspaceTarget(absolutePath: string): Promise<CodexWorkspaceTarget> {
  const candidate = canonicalAbsolutePath(absolutePath);
  if (!candidate) throw new CodexWorkspacePathError("工作区路径无效", 400);
  const projects = await codexProjects();
  const matches = projects.flatMap((project) => {
    const root = canonicalAbsolutePath(project.cwd);
    return root && absolutePathContains(root, candidate) ? [{ project, root }] : [];
  }).sort((a, b) => b.root.length - a.root.length);
  const match = matches[0];
  if (!match) throw new CodexWorkspacePathError("该路径不属于已配置的 Codex 工作区", 404);
  const relativePath = relativePathFromAbsolute(match.root, candidate);
  const invalid = validateWorkspaceRelativePath(relativePath);
  if (invalid) throw new CodexWorkspacePathError(invalid, 403);
  const fullPath = relativePath
    ? `${match.root.endsWith("/") ? match.root : match.root + "/"}${relativePath}`
    : match.root;
  return { project: match.project, relativePath, fullPath };
}

function workspaceRoute(
  target: CodexWorkspaceTarget,
  operation: CodexWorkspaceOperation,
  workspacePath: string,
  extraQuery?: Record<string, string>,
): string {
  const normalizedPath = operation === "git-status" ? "" : workspacePath;
  const invalid = validateWorkspaceRelativePath(normalizedPath, operation === "list" || operation === "git-status");
  if (invalid) throw new CodexWorkspacePathError(invalid, 403);
  const query = new URLSearchParams({ project: target.project.key, operation, path: normalizedPath });
  for (const [key, value] of Object.entries(extraQuery ?? {})) query.set(key, value);
  return `/api/projects/workspace?${query.toString()}`;
}

export async function codexWorkspaceJson(
  target: CodexWorkspaceTarget,
  operation: CodexWorkspaceOperation,
  workspacePath = target.relativePath,
  extraQuery?: Record<string, string>,
): Promise<any> {
  return codexBridgeJson(workspaceRoute(target, operation, workspacePath, extraQuery));
}

async function codexWorkspaceBytes(target: CodexWorkspaceTarget, operation: "download", workspacePath: string): Promise<Buffer> {
  const result = await codexWorkspaceJson(target, operation, workspacePath) as { data?: unknown; size?: unknown };
  if (typeof result.data !== "string") throw new CodexBridgeError("Codex 服务未返回文件内容", 502);
  if (typeof result.size === "number" && result.size > MAX_CODEX_FILE_BYTES) {
    throw new CodexWorkspacePathError("Codex 工作区文件超过 20 MB 传输限制", 413);
  }
  const bytes = Buffer.from(result.data, "base64");
  if (bytes.length > MAX_CODEX_FILE_BYTES || (typeof result.size === "number" && bytes.length !== result.size)) {
    throw new CodexBridgeError("Codex 服务返回的文件长度不匹配", 502);
  }
  return bytes;
}

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof CodexWorkspacePathError
    ? error.status
    : error instanceof CodexBridgeError
      ? error.status
      : 502;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

function basename(remotePath: string): string {
  return path.posix.basename(remotePath.replace(/\\/g, "/"));
}

function getLanguage(remotePath: string): string {
  const base = basename(remotePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  const languages: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    cs: "csharp", html: "html", htm: "html", css: "css", scss: "css", less: "css",
    json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
    md: "markdown", mdx: "markdown", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
    sql: "sql", graphql: "graphql", gql: "graphql", tf: "hcl", hcl: "hcl", env: "bash",
    gitignore: "bash", txt: "text", pdf: "pdf", docx: "word",
  };
  return languages[ext] ?? "text";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light}html,body{margin:0;min-height:100%;background:#eef1f5;color:#171717}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:28px}main{box-sizing:border-box;max-width:840px;min-height:calc(100vh - 56px);margin:0 auto;padding:56px 64px;background:#fff;box-shadow:0 8px 28px rgba(15,23,42,.14)}.file-title{margin:0 0 28px;padding-bottom:10px;border-bottom:1px solid #e5e7eb;color:#6b7280;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-word}h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.1em 0 .45em;color:#111827}p{margin:.65em 0;line-height:1.7}table{border-collapse:collapse;max-width:100%;margin:1em 0}th,td{border:1px solid #d1d5db;padding:6px 9px;vertical-align:top}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#2563eb}@media(max-width:720px){body{padding:0;background:#fff}main{min-height:100vh;padding:28px 22px;box-shadow:none}}</style>
</head><body><main><div class="file-title">${escapeHtml(fileName)}</div>${bodyHtml}</main></body></html>`;
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDisposition(remotePath: string, asDownload: boolean): string {
  const fileName = basename(remotePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${asDownload ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function bytesResponse(remotePath: string, bytes: Buffer, mime: string, rangeHeader: string | null, asDownload = false): Response {
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition(remotePath, asDownload),
    "X-Content-Type-Options": "nosniff",
  };
  if (mime === "image/svg+xml") {
    headers["Content-Security-Policy"] = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
    headers["Referrer-Policy"] = "no-referrer";
  }
  if (!rangeHeader) {
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } });
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : bytes.length - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(bytes.length - suffixLength, 0);
    end = bytes.length - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= bytes.length) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } });
  }
  end = Math.min(end, bytes.length - 1);
  const chunk = bytes.subarray(start, end + 1);
  return new Response(new Uint8Array(chunk), {
    status: 206,
    headers: { ...headers, "Content-Length": String(chunk.length), "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
  });
}

function textChunkResponse(text: string, fileSize: number, remotePath: string, rawOffset: string | null): NextResponse {
  if (rawOffset !== null && !/^\d+$/.test(rawOffset)) {
    return NextResponse.json({ error: "文本预览位置无效" }, { status: 400 });
  }
  const offset = Number(rawOffset ?? 0);
  if (!Number.isSafeInteger(offset) || offset > fileSize) {
    return NextResponse.json({ error: "文本预览位置无效" }, { status: 400 });
  }
  const data = Buffer.from(text, "utf8");
  if (data.length !== fileSize) {
    return NextResponse.json({ error: "Codex 服务返回的文本长度不匹配" }, { status: 502 });
  }
  let chunkEnd = Math.min(offset + TEXT_CHUNK_BYTES, data.length);
  if (chunkEnd < data.length) {
    let sequenceStart = chunkEnd;
    while (sequenceStart > Math.max(offset, chunkEnd - 3) && (data[sequenceStart] & 0xc0) === 0x80) sequenceStart--;
    const first = data[sequenceStart];
    const sequenceLength = (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : (first & 0xf8) === 0xf0 ? 4 : 1;
    if (sequenceLength > chunkEnd - sequenceStart) chunkEnd = sequenceStart;
  }
  const nextOffset = chunkEnd;
  return NextResponse.json({
    content: data.toString("utf8", offset, chunkEnd),
    language: getLanguage(remotePath),
    size: fileSize,
    nextOffset,
    truncated: nextOffset < fileSize,
  });
}

async function readTextBytes(target: CodexWorkspaceTarget, workspacePath: string, preview: { size?: unknown; text?: unknown }): Promise<Buffer> {
  if (typeof preview.size === "number" && preview.size > MAX_CODEX_FILE_BYTES) {
    throw new CodexWorkspacePathError("Codex 文本文件超过 20 MB 读取限制", 413);
  }
  if (typeof preview.text === "string") {
    const bytes = Buffer.from(preview.text, "utf8");
    // Bridge previews decode UTF-8 with BOM stripping; retain the original byte offsets expected by FileViewer.
    if (preview.size === bytes.length + 3) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
    return bytes;
  }
  return codexWorkspaceBytes(target, "download", workspacePath);
}

export async function handleCodexFileGET(
  request: NextRequest,
  type: "list" | "read" | "download" | "meta" | "preview" | "watch",
  absolutePath: string,
): Promise<Response> {
  try {
    if (type === "watch") {
      return NextResponse.json({ error: "Codex Bridge 工作区接口不支持文件变更订阅" }, { status: 501 });
    }
    const target = await resolveCodexWorkspaceTarget(absolutePath);
    const workspacePath = target.relativePath;
    const fileName = basename(target.fullPath);
    if (type === "list") {
      const entries: Array<{ name: string; isDir: boolean; size: number; modified: string }> = [];
      let truncated = false;
      let offset = 0;
      let pageCount = 0;
      while (true) {
        if (++pageCount > Math.ceil(CODEX_DIRECTORY_ENTRY_CAP / 200) + 1) {
          truncated = true;
          break;
        }
        const page = await codexWorkspaceJson(target, "list", workspacePath, { offset: String(offset) }) as {
          entries?: Array<{ name?: unknown; path?: unknown; kind?: unknown; size?: unknown; modified?: unknown; modifiedUnix?: unknown }>;
          nextOffset?: unknown;
        };
        for (const entry of page.entries ?? []) {
          if (typeof entry.name !== "string" || (entry.kind !== "directory" && entry.kind !== "file")) continue;
          if (IGNORED_NAMES.has(entry.name) || IGNORED_SUFFIXES.some((suffix) => String(entry.name).endsWith(suffix))) continue;
          const modifiedValue = typeof entry.modifiedUnix === "number" ? entry.modifiedUnix : entry.modified;
          let modified = "";
          if (typeof modifiedValue === "number" && Number.isFinite(modifiedValue)) {
            try { modified = new Date(modifiedValue * 1000).toISOString(); } catch { /* invalid remote timestamp */ }
          }
          entries.push({
            name: entry.name,
            isDir: entry.kind === "directory",
            size: typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : 0,
            modified,
          });
          if (entries.length >= CODEX_DIRECTORY_ENTRY_CAP) {
            truncated = typeof page.nextOffset === "number";
            break;
          }
        }
        if (truncated || typeof page.nextOffset !== "number" || !Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) break;
        offset = page.nextOffset;
      }
      entries.sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
      return NextResponse.json({ entries, path: target.fullPath, truncated });
    }

    if (type === "meta") {
      const info = await codexWorkspaceJson(target, "info", workspacePath) as { kind?: string; size?: number };
      if (info.kind !== "file") return NextResponse.json({ error: "请选择普通文件" }, { status: 400 });
      const imageMime = getImageMime(target.fullPath);
      const audioMime = getAudioMime(target.fullPath);
      const videoMime = getVideoMime(target.fullPath);
      const documentMime = getDocumentMime(target.fullPath);
      return NextResponse.json({
        size: info.size ?? 0,
        language: getLanguage(target.fullPath),
        mime: imageMime || audioMime || videoMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(target.fullPath),
      });
    }

    if (type === "preview") {
      const info = await codexWorkspaceJson(target, "info", workspacePath) as { kind?: string; size?: number };
      if (info.kind !== "file") return NextResponse.json({ error: "请选择普通文件" }, { status: 400 });
      if (getFileExt(target.fullPath) !== "docx") {
        return NextResponse.json({ error: "该文件类型暂不支持预览" }, { status: 400 });
      }
      if ((info.size ?? 0) > DOCX_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "文档超过 10 MB 预览限制" }, { status: 413 });
      }
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml({ buffer: await codexWorkspaceBytes(target, "download", workspacePath) }, {
        externalFileAccess: false,
        convertImage: mammoth.images.dataUri,
      });
      return new Response(wrapDocxPreviewHtml(result.value, fileName), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (type === "download") {
      const info = await codexWorkspaceJson(target, "info", workspacePath) as { kind?: string };
      if (info.kind !== "file") return NextResponse.json({ error: "请选择普通文件" }, { status: 400 });
      const mime = getImageMime(target.fullPath) || getAudioMime(target.fullPath) || getVideoMime(target.fullPath) || getDocumentMime(target.fullPath) || "application/octet-stream";
      return bytesResponse(target.fullPath, await codexWorkspaceBytes(target, "download", workspacePath), mime, request.headers.get("range"), true);
    }

    // Native FileViewer consumes raw media bytes and paged JSON for text.
    const preview = await codexWorkspaceJson(target, "preview", workspacePath) as { kind?: string; text?: unknown; data?: unknown; mime?: unknown; size?: unknown };
    const ext = getFileExt(target.fullPath);
    const imageMime = getImageMime(target.fullPath);
    if (imageMime && ext !== "svg") {
      const size = typeof preview.size === "number" ? preview.size : 0;
      if (size > IMAGE_PREVIEW_MAX_BYTES) return NextResponse.json({ error: "图片超过 10 MB 预览限制" }, { status: 413 });
      if (preview.kind === "image" && typeof preview.data === "string") {
        const bytes = Buffer.from(preview.data, "base64");
        if (bytes.length > IMAGE_PREVIEW_MAX_BYTES || (typeof preview.size === "number" && bytes.length !== preview.size)) {
          return NextResponse.json({ error: "Codex 服务返回的图片长度不匹配" }, { status: 502 });
        }
        return bytesResponse(target.fullPath, bytes, typeof preview.mime === "string" ? preview.mime : imageMime, request.headers.get("range"));
      }
    }

    const rawMime = getAudioMime(target.fullPath) || getVideoMime(target.fullPath) || getDocumentMime(target.fullPath) || imageMime;
    if (rawMime) {
      const bytes = await codexWorkspaceBytes(target, "download", workspacePath);
      return bytesResponse(target.fullPath, bytes, rawMime, request.headers.get("range"));
    }

    const bytes = await readTextBytes(target, workspacePath, preview);
    if (bytes.includes(0)) return NextResponse.json({ error: "该文件不是 UTF-8 文本，无法在原生文本查看器中预览" }, { status: 415 });
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return NextResponse.json({ error: "该文件不是 UTF-8 文本，无法在原生文本查看器中预览" }, { status: 415 }); }
    return textChunkResponse(text, bytes.length, target.fullPath, request.nextUrl.searchParams.get("offset"));
  } catch (error) {
    return errorResponse(error);
  }
}

async function inspectRemoteUploadTargets(target: CodexWorkspaceTarget, fileNames: string[]): Promise<{ conflicts: string[]; nonReplaceable: string[] }> {
  const existing = new Set<string>();
  let offset = 0;
  let scanned = 0;
  let pageCount = 0;
  while (true) {
    if (++pageCount > Math.ceil(CODEX_DIRECTORY_ENTRY_CAP / 200) + 1) {
      throw new CodexWorkspacePathError("目标目录过大，无法安全核对上传冲突", 413);
    }
    const page = await codexWorkspaceJson(target, "list", target.relativePath, {
      hidden: "true",
      offset: String(offset),
    }) as { entries?: Array<{ name?: unknown }>; nextOffset?: unknown };
    for (const entry of page.entries ?? []) {
      if (typeof entry.name === "string") existing.add(entry.name);
      scanned++;
      if (scanned >= CODEX_DIRECTORY_ENTRY_CAP && typeof page.nextOffset === "number") {
        throw new CodexWorkspacePathError("目标目录过大，无法安全核对上传冲突", 413);
      }
    }
    if (typeof page.nextOffset !== "number" || !Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  const conflicts = fileNames.filter((fileName) => existing.has(fileName));
  // The Bridge upload endpoint only accepts a new path or identical bytes.
  // Since listings do not expose a content hash, every existing target is truthfully non-replaceable.
  return { conflicts, nonReplaceable: [...conflicts] };
}

export async function handleCodexFilePOST(
  request: NextRequest,
  absoluteDirectory: string,
): Promise<Response> {
  try {
    const target = await resolveCodexWorkspaceTarget(absoluteDirectory);
    const type = request.nextUrl.searchParams.get("type") ?? "upload";
    if (type !== "upload" && type !== "upload-check") {
      return NextResponse.json({ error: "上传请求类型无效" }, { status: 400 });
    }
    if (type === "upload-check") {
      const body = await request.json().catch(() => null) as { fileNames?: unknown } | null;
      if (!Array.isArray(body?.fileNames) || !body.fileNames.every((entry) => typeof entry === "string")) {
        return NextResponse.json({ error: "文件名列表格式无效" }, { status: 400 });
      }
      const fileNames = body.fileNames as string[];
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) return NextResponse.json({ error: "请选择文件；文件名不能重复或包含路径" }, { status: 400 });
      for (const name of fileNames) {
        const invalid = validateWorkspaceRelativePath(target.relativePath ? `${target.relativePath}/${name}` : name, false);
        if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      }
      return NextResponse.json(await inspectRemoteUploadTargets(target, fileNames));
    }

    const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
    if (!strategy) return NextResponse.json({ error: "上传冲突处理方式无效" }, { status: 400 });
    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_CODEX_UPLOAD_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "上传文件总量不能超过 100 MB" }, { status: 413 });
      throw error;
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.some((file) => file.size > MAX_CODEX_FILE_BYTES)) {
      return NextResponse.json({ error: "每个上传文件不能超过 20 MB" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_CODEX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "上传文件总量不能超过 100 MB" }, { status: 413 });
    }
    const fileNames = files.map((file) => file.name);
    const validationError = validateUploadFileNames(fileNames);
    if (validationError) return NextResponse.json({ error: "请选择文件；文件名不能重复或包含路径" }, { status: 400 });
    for (const name of fileNames) {
      const invalid = validateWorkspaceRelativePath(target.relativePath ? `${target.relativePath}/${name}` : name, false);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    }

    const inspection = await inspectRemoteUploadTargets(target, fileNames);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return NextResponse.json({
        error: "存在同名文件，请选择跳过或更名",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }
    const conflicts = new Set(inspection.conflicts);
    const uploaded: string[] = [];
    const paths: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    for (const file of files) {
      if (conflicts.has(file.name) && strategy === "skip") {
        skipped.push(file.name);
        continue;
      }
      const relative = target.relativePath ? `${target.relativePath}/${file.name}` : file.name;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const route = workspaceRoute(target, "upload", relative);
        const response = await codexBridgeRequest(route, undefined, {
          bytes,
          contentType: file.type || "application/octet-stream",
        });
        const result = await response.json().catch(() => ({})) as { existing?: unknown };
        if (result.existing === true) {
          skipped.push(file.name);
          continue;
        }
        uploaded.push(file.name);
        paths.push(`${target.fullPath.endsWith("/") ? target.fullPath : target.fullPath + "/"}${file.name}`);
      } catch (error) {
        if (strategy === "skip") {
          try {
            const current = await inspectRemoteUploadTargets(target, [file.name]);
            if (current.conflicts.includes(file.name)) {
              skipped.push(file.name);
              continue;
            }
          } catch {
            // Preserve the original upload error if a follow-up conflict read also fails.
          }
        }
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return NextResponse.json({ uploaded, paths, skipped, errors }, { status: errors.length > 0 ? 207 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}


export async function codexGitStatus(cwd: string) {
  const target = await resolveCodexWorkspaceTarget(cwd);
  const state = await codexWorkspaceJson(target, "git-status", "", { cwd: target.fullPath });
  const files = (state.entries || []).map((entry: { path: string; index: string; worktree: string; conflict: boolean; untracked: boolean }) => {
    const code = entry.conflict ? "U" : entry.untracked ? "U" : [entry.index, entry.worktree].find(c => ["A", "D", "R", "C", "M"].includes(c)) || "M";
    const status = entry.conflict ? "conflict" : entry.untracked ? "untracked" : ({ A: "added", D: "deleted", R: "renamed", C: "renamed", M: "modified" } as Record<string, string>)[code];
    return { filePath: target.fullPath.replace(/\/$/, "") + "/" + entry.path, code, status, indexStatus: entry.index, worktreeStatus: entry.worktree };
  });
  return { isGitRepository: Boolean(state.available), repositoryRoot: state.available ? (state.repositoryRoot || target.fullPath) : null, files,
    additions: state.additions ?? 0, deletions: state.deletions ?? 0 };
}
export async function codexGitDiff(cwd: string, filePath: string) {
  const target = await resolveCodexWorkspaceTarget(filePath);
  const scope = await resolveCodexWorkspaceTarget(cwd);
  if (scope.project.key !== target.project.key || !absolutePathContains(scope.fullPath, target.fullPath)) throw new CodexWorkspacePathError("文件不属于当前工作区", 403);
  const relativeFile = relativePathFromAbsolute(scope.fullPath, target.fullPath);
  const state = await codexWorkspaceJson(scope, "git-status", "", { cwd: scope.fullPath });
  const entry = state.entries?.find((row: { path: string }) => row.path === relativeFile);
  if (!entry) return { supported: false };
  const sections = entry.conflict ? ["conflict"] : entry.untracked ? ["untracked"] : [...(entry.index !== "." ? ["staged"] : []), ...(entry.worktree !== "." ? ["unstaged"] : [])];
  const parts: string[] = [];
  for (const section of sections) {
    const result = await codexWorkspaceJson(scope, "git-diff", relativeFile, { section, cwd: scope.fullPath });
    if (result.kind !== "diff" && result.kind !== "conflict") return { supported: false };
    if (result.text) parts.push(result.text);
  }
  return { supported: true, patch: parts.join("\n"), status: entry.untracked ? "untracked" : entry.conflict ? "conflict" : "modified" };
}
