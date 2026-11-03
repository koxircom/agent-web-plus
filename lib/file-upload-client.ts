/**
 * 原生文件上传客户端
 *
 * 核心契约与硬约束：
 * 1. 单文件上限 25MB，批次上限 100MB，与 /api/files/[...path] 路由硬校验对齐
 * 2. HTTP 207 Multi-Status 必须判定为失败，严禁假成功
 * 3. 保持 sessionId, executionEngine 等既有参数
 * 4. 采用 safeUploadName 独立上传，同名文件与多次粘贴各自拥有唯一实例
 */

export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_UPLOAD_BATCH_BYTES = 100 * 1024 * 1024; // 100MB

export interface UploadedFileResult {
  id: string;
  name: string;
  size: number;
  type: string;
  serverRelativePath: string;
  serverAbsPath?: string;
  sessionId?: string;
}

export function encodePathForApi(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export function generateSafeUploadName(originalName: string): string {
  const cleanName = String(originalName || "upload.bin").replace(/[\\/\u0000-\u001f\u007f\[\]()@]/g, "_");
  const uniqueId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  return `.pi-upload-${uniqueId}-${cleanName}`;
}

export async function ensureUploadDirectory(
  cwd: string,
  sessionId?: string,
  executionEngine?: string
): Promise<{ targetDir: string; relativeDir: string }> {
  const isCodex = executionEngine === "codex" || (sessionId ? sessionId.startsWith("codex:") : false);
  if (isCodex) {
    return { targetDir: cwd, relativeDir: "" };
  }

  const sep = cwd.includes("\\") ? "\\" : "/";
  const targetDir = cwd.replace(/[\\/]+$/, "") + sep + ".pi-uploads";

  // 1. 先通过真实 route upload-check 探查 .pi-uploads 是否已就绪
  try {
    const encoded = encodePathForApi(targetDir);
    const context = new URLSearchParams({ type: "upload-check", engine: executionEngine || "pi" });
    if (sessionId) context.set("sessionId", sessionId);
    const checkRes = await fetch(`/api/files/${encoded}?${context}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileNames: [".probe"] }),
    });
    if (checkRes.ok) {
      const data = await checkRes.json();
      if (!Array.isArray(data.conflicts) || !Array.isArray(data.nonReplaceable)) throw new Error("上传目录检查响应无效");
      return { targetDir, relativeDir: ".pi-uploads" };
    }
    if (checkRes.status !== 404) throw new Error(`上传目录检查失败 (HTTP ${checkRes.status})`);
  } catch (error) {
    throw error instanceof Error ? error : new Error("上传目录检查失败");
  }

  // 2. 若未就绪，通过系统既有目录创建 route 创建 .pi-uploads
  try {
    const createRes = await fetch("/api/cwd/browse?engine=pi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: cwd, name: ".pi-uploads" }),
    });
    if (createRes.ok || createRes.status === 409) {
      return { targetDir, relativeDir: ".pi-uploads" };
    }
    const errData = await createRes.json().catch(() => ({}));
    throw new Error(errData?.error || `准备上传目录失败 (HTTP ${createRes.status})`);
  } catch (err: any) {
    throw new Error(`无法准备上传目录 .pi-uploads: ${err?.message || String(err)}`);
  }
}

export async function uploadSingleComposerFile(options: {
  file: File | Blob;
  name?: string;
  cwd: string;
  sessionId?: string;
  executionEngine?: string;
}): Promise<UploadedFileResult> {
  const { file, cwd, sessionId, executionEngine } = options;
  const fileName = options.name || (file instanceof File ? file.name : "upload.bin");
  const fileSize = file.size;

  if (fileSize > MAX_UPLOAD_FILE_BYTES) {
    throw new Error(`文件超过单次上传上限 (25MB): ${fileName}`);
  }

  if (!cwd) {
    throw new Error("未检测到有效的工作区目录");
  }

  // 准备目标目录 (精准对齐既有路径策略，禁止静默掩盖 404 回退根目录)
  const { targetDir, relativeDir } = await ensureUploadDirectory(cwd, sessionId, executionEngine);

  // 精准生成唯一文件名，并通过 upload-check 验证无冲突 (overwrite: false)
  let safeUploadName = generateSafeUploadName(fileName);
  const encodedDir = encodePathForApi(targetDir);

  const checkParams = new URLSearchParams({ type: "upload-check" });
  if (sessionId) checkParams.set("sessionId", sessionId);
  if (executionEngine) {
    checkParams.set("executionEngine", executionEngine);
    checkParams.set("engine", executionEngine);
  }

  // 冲突核验：确保 safeUploadName 绝对无冲突且 overwrite 为 false
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const checkRes = await fetch(`/api/files/${encodedDir}?${checkParams.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileNames: [safeUploadName] }),
      });
      if (checkRes.ok) {
        const inspection = await checkRes.json();
        if (Array.isArray(inspection?.conflicts) && inspection.conflicts.includes(safeUploadName)) {
          safeUploadName = generateSafeUploadName(fileName);
          continue;
        }
      }
    } catch {}
    break;
  }

  const serverRelativePath = relativeDir ? `${relativeDir}/${safeUploadName}` : safeUploadName;
  const formData = new FormData();
  formData.append("files", file, safeUploadName);

  // 契约：conflict 必须为 error (拒绝覆盖，保证精准唯一实例)，禁止 conflict=overwrite
  const params = new URLSearchParams({ type: "upload", conflict: "error" });
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  if (executionEngine) {
    params.set("executionEngine", executionEngine);
    params.set("engine", executionEngine);
  }

  const res = await fetch(`/api/files/${encodedDir}?${params.toString()}`, {
    method: "POST",
    body: formData,
  });

  // 207 Multi-Status 代表部分或全部错误，硬约束：绝不能假成功
  if (res.status === 207) {
    let data: any = {};
    try { data = await res.json(); } catch {}
    const errMsg = data?.errors?.[0]?.error || "上传失败 (HTTP 207)";
    throw new Error(errMsg);
  }

  if (!res.ok) {
    let errMsg = `上传失败 (HTTP ${res.status})`;
    let data: any = {};
    try { data = await res.json(); } catch {}
    if (data?.error) errMsg = data.error;
    if (res.status === 413) {
      errMsg = `文件超过单次上传上限 (25MB): ${data?.error || ""}`.trim();
    }
    throw new Error(errMsg);
  }

  const result = await res.json();
  if (result.errors?.length || !Array.isArray(result.uploaded) || !result.uploaded.includes(safeUploadName)) {
    throw new Error(result.errors?.[0]?.error || "文件未确认上传成功，请重试");
  }

  const sep = cwd.includes("\\") ? "\\" : "/";
  const serverAbsPath = targetDir.replace(/[\\/]+$/, "") + sep + safeUploadName;

  return {
    id: "file-" + Math.random().toString(36).slice(2, 10),
    name: fileName,
    size: fileSize,
    type: file.type || "application/octet-stream",
    serverRelativePath,
    serverAbsPath,
    sessionId,
  };
}
