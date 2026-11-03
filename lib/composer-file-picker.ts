/**
 * Composer file picker helpers.
 * Pure functions for routing file inputs and resolving platform-specific accept attributes.
 */

export function isAndroidChromium(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  if (!ua) return false;
  return /Android/i.test(ua) && /Chrome\/|Chromium\//i.test(ua);
}

export function getDocumentPickerAccept(userAgent?: string): string | undefined {
  return isAndroidChromium(userAgent) ? "application/octet-stream" : undefined;
}

export interface MediaPickerFilesRouting {
  imageFiles: File[];
  videoFiles: File[];
  rejectedFiles: File[];
}

export const DOCUMENT_PICKER_OPTIONS = {
  id: "pi-web-attachments",
  multiple: true,
  excludeAcceptAllOption: false,
  startIn: "downloads" as const,
};

export const DOCUMENT_PICKER_ERROR_NOTICE = "文件选择未完成，请重试或使用浏览器的文件上传入口";

export function canUseOpenFilePicker(win?: any): boolean {
  const target = win ?? (typeof window !== "undefined" ? window : undefined);
  if (!target) return false;
  return Boolean(target.isSecureContext && typeof target.showOpenFilePicker === "function");
}

export function isDocumentPickerImageFile(file: { name?: string; type?: string }): boolean {
  const type = file.type || "";
  const name = file.name || "";
  if (!type.startsWith("image/")) return false;
  if (type.startsWith("video/")) return false;
  return !/\.(mp4|webm|mkv|mov|avi|wmv|flv|m4v)$/i.test(name);
}

export interface DocumentPickerFilesRouting {
  imageFiles: File[];
  attachmentFiles: File[];
}

export function routeDocumentPickerFiles(files: File[] | Iterable<File>): DocumentPickerFilesRouting {
  const imageFiles: File[] = [];
  const attachmentFiles: File[] = [];

  for (const file of files) {
    if (isDocumentPickerImageFile(file)) {
      imageFiles.push(file);
    } else {
      attachmentFiles.push(file);
    }
  }

  return { imageFiles, attachmentFiles };
}

export function routeMediaPickerFiles(files: File[] | Iterable<File>): MediaPickerFilesRouting {
  const imageFiles: File[] = [];
  const videoFiles: File[] = [];
  const rejectedFiles: File[] = [];

  for (const file of files) {
    const type = file.type || "";
    if (type.startsWith("image/")) {
      imageFiles.push(file);
    } else if (type.startsWith("video/")) {
      videoFiles.push(file);
    } else {
      rejectedFiles.push(file);
    }
  }

  return { imageFiles, videoFiles, rejectedFiles };
}
