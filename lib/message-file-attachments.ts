/**
 * 消息附件 Marker 序列化与解析器 (统一契约)
 *
 * 规范：
 * 1. 序列化格式：
 *    - 推荐标准格式: `[附件: @${serverRelativePath}]`
 *    - 或扩展格式: `[附件: ${name} (@${serverRelativePath}) - ${sizeStr}]`
 * 2. 提取原文件名：
 *    - 剥离 `.pi-upload-${timestamp}-${randomId}-` 前缀
 *    - 严格保留原始文件名中的全部连字符 (hyphen)，严禁误吞！
 * 3. 解析与无双份正文：
 *    - 从用户消息正文中解析出附件卡片模型
 *    - 从渲染正文 (cleanText) 中剥离附件 Marker，避免 Markdown 内出现重复正文
 * 4. 同名不同路径支持：
 *    - 同名但相对路径不同的文件独立保留
 */

export interface MessageFileAttachment {
  id: string;
  name: string;
  serverRelativePath: string;
  serverAbsPath?: string;
  size?: number;
  sizeStr?: string;
  type?: string;
}

export interface ParsedUserMessageAttachments {
  cleanText: string;
  attachments: MessageFileAttachment[];
}

/**
 * 格式化文件大小展示字符串
 */
export function formatAttachmentSize(bytes?: number): string {
  if (typeof bytes !== "number" || isNaN(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 根据文件名后缀获取常用 MIME 类型
 */
export function getMimeTypeFromFilename(filename: string): string {
  const clean = String(filename || "").split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || clean;
  const dotIndex = base.lastIndexOf(".");
  const ext = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : "";

  const map: Record<string, string> = {
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    py: "text/x-python",
    ts: "text/typescript",
    tsx: "text/typescript",
    js: "text/javascript",
    jsx: "text/javascript",
    sh: "text/x-shellscript",
    log: "text/plain",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * 从上传存储名中还原原始文件名
 * 格式通常为: `.pi-upload-${uniqueId}-${originalName}`
 * 其中 uniqueId 可以由一个或两个以 '-' 分隔的字母数字标记组成 (例如 m2abc-x9z 或 12345678)
 * 关键铁律：原始文件名中的连字符 (如 my-report-2026.pdf)、空格、括号、方括号等必须原样完整保留！
 */
export function extractOriginalFilename(rawPathOrName: string): string {
  const base = String(rawPathOrName || "").split(/[\\/]/).pop() || "";
  if (!base.startsWith(".pi-upload-")) return base;

  const rest = base.slice(".pi-upload-".length);

  // 严格匹配两段时间戳/随机标记前缀：^([a-z0-9]+)-([a-z0-9]+)-(.+)$
  // 关键：命中后直接提取第三段 (.+) 作为完整原文件名，绝不继续在原文件名内部截断连字符
  const twoPartMatch = rest.match(/^([a-z0-9]{4,16})-([a-z0-9]{4,16})-(.+)$/);
  if (twoPartMatch) {
    return twoPartMatch[3];
  }

  // 匹配单段标记前缀：^([a-z0-9]+)-(.+)$
  const onePartMatch = rest.match(/^([a-z0-9]{6,20})-(.+)$/);
  if (onePartMatch) {
    return onePartMatch[2];
  }

  return rest;
}

/**
 * 单个附件序列化为标准 Marker (支持完整安全编码与原生格式)
 */
export function serializeFileAttachmentMarker(serverRelativePath: string, name?: string): string {
  const cleanPath = serverRelativePath.replace(/^@/, "").trim();
  const encodedPath = cleanPath.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  if (name) {
    // 使用完整 name/path 编码安全格式，确保文件名中的括号、方括号、空格、@ 等绝不破坏 Markdown 结构
    return `[附件: ${encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)} (@${encodedPath})]`;
  }
  return `[附件: @${encodedPath}]`;
}

/**
 * 完整序列化附件列表到消息末尾
 */
export function appendFileAttachmentsToText(
  body: string,
  attachments: Array<{ serverRelativePath?: string; name?: string }>
): string {
  let extraText = "";
  for (const att of attachments) {
    if (att && typeof att.serverRelativePath === "string" && att.serverRelativePath.trim()) {
      extraText += `\n\n${serializeFileAttachmentMarker(att.serverRelativePath, att.name)}`;
    }
  }
  const text = String(body || "");
  return text.trim() ? `${text}${extraText}` : extraText.trim();
}

/**
 * 从用户消息中解析全部附件 Marker，并返回清洗后的消息正文 (无双份正文)
 */
export function parseUserMessageAttachments(rawText: string): ParsedUserMessageAttachments {
  const text = String(rawText || "");
  if (!text.includes("[附件:")) {
    return { cleanText: text, attachments: [] };
  }

  const attachments: MessageFileAttachment[] = [];
  const seenPaths = new Set<string>();
  const recognizedSpans: Array<{ start: number; end: number }> = [];

  // 正则 1: 完整格式 [附件: name (@path)] 或 [附件: name (@path) - 150 KB]
  // 支持路径中包含空格与特殊字符，同时 name 支持 URI 安全解码
  const fullFormatRegex = /\[附件:\s*([^\]\(@\n]+?)\s*\(@([^\]\n]+)\)(?:\s*-\s*([^\]\n]+))?\]/g;

  // 正则 2: 简洁标准格式 [附件: @path] (支持路径中含空格)
  const simpleFormatRegex = /\[附件:\s*@([^\]\n]+)\]/g;

  let match: RegExpExecArray | null;

  // 1. 扫描完整格式
  while ((match = fullFormatRegex.exec(text)) !== null) {
    const rawNamePart = (match[1] || "").trim();
    let relPath = (match[2] || "").trim().replace(/^@/, "").trim();
    try { relPath = decodeURIComponent(relPath); } catch { /* Preserve legacy literal paths. */ }
    const sizeStr = (match[3] || "").trim();
    const key = relPath || rawNamePart;

    if (relPath && !seenPaths.has(key)) {
      seenPaths.add(key);
      let name = rawNamePart;
      try {
        name = decodeURIComponent(rawNamePart);
      } catch {}
      if (!name) name = extractOriginalFilename(relPath);

      recognizedSpans.push({ start: match.index, end: match.index + match[0].length });
      attachments.push({
        id: `att-${attachments.length}-${relPath}`,
        name,
        serverRelativePath: relPath,
        sizeStr,
        type: getMimeTypeFromFilename(name),
      });
    }
  }

  // 2. 扫描简洁格式与历史旧 marker
  while ((match = simpleFormatRegex.exec(text)) !== null) {
    let relPath = (match[1] || "").trim().replace(/^@/, "").trim();
    try { relPath = decodeURIComponent(relPath); } catch { /* Preserve legacy literal paths. */ }
    // 检查此匹配是否已经被完整格式所覆盖
    const isOverlapped = recognizedSpans.some((span) => match!.index >= span.start && match!.index < span.end);
    if (isOverlapped) continue;

    if (relPath && !seenPaths.has(relPath)) {
      seenPaths.add(relPath);
      const name = extractOriginalFilename(relPath);
      recognizedSpans.push({ start: match.index, end: match.index + match[0].length });
      attachments.push({
        id: `att-${attachments.length}-${relPath}`,
        name,
        serverRelativePath: relPath,
        type: getMimeTypeFromFilename(name),
      });
    }
  }

  // 3. 严格仅移除确认识别成功的匹配跨度，保留其余所有正文 (绝不使用粗暴 regex 盲删所有 marker)
  if (recognizedSpans.length === 0) {
    return { cleanText: text, attachments: [] };
  }

  // 按起始位置排序
  recognizedSpans.sort((a, b) => a.start - b.start);

  let cleanText = "";
  let lastIndex = 0;
  for (const span of recognizedSpans) {
    cleanText += text.slice(lastIndex, span.start);
    lastIndex = span.end;
  }
  cleanText += text.slice(lastIndex);

  // 清洗因剥离 marker 产生的多余首尾与连续换行
  cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim();

  return {
    cleanText,
    attachments,
  };
}
