import { createJiti } from "jiti";
import { startNativeInputServer as baseStartServer, runBrowserTest as baseRunBrowser } from "../tests/fixtures/native-input-browser.mjs";

const jiti = createJiti(new URL(".", import.meta.url).href, { tsconfigPaths: true });

export const messageFileAttachments = await jiti.import("../lib/message-file-attachments.ts");
export const fileUploadClient = await jiti.import("../lib/file-upload-client.ts");
export const draftStore = await jiti.import("../lib/draft-store.ts");

export const {
  parseUserMessageAttachments,
  appendFileAttachmentsToText,
  serializeFileAttachmentMarker,
  extractOriginalFilename,
  getMimeTypeFromFilename,
  formatAttachmentSize,
} = messageFileAttachments;

export const {
  uploadSingleComposerFile,
  ensureUploadDirectory,
  generateSafeUploadName,
  encodePathForApi,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_BATCH_BYTES,
} = fileUploadClient;

export const {
  getDraft,
  setDraft,
  clearDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  restoreDraftSubmission,
  rekeyDraft,
} = draftStore;

export const startNativeInputServer = baseStartServer;
export const runBrowserTest = baseRunBrowser;

/**
 * 构造用于测试的多类型文件集
 */
export function createSampleFiles() {
  return [
    { name: "test-document.pdf", type: "application/pdf", content: "%PDF-1.4 sample pdf content" },
    { name: "data-sheet.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: "xlsx-binary-payload" },
    { name: "contract.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: "docx-binary-payload" },
    { name: "archive.zip", type: "application/zip", content: "PK\x03\x04zip-content" },
    { name: "notes.txt", type: "text/plain", content: "普通纯文本笔记内容" },
    { name: "audio.mp3", type: "audio/mpeg", content: "ID3\x03mp3-audio-data" },
  ];
}
