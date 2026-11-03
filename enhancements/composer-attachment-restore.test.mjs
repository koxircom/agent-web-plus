import test from "node:test";
import assert from "node:assert/strict";
import {
  parseUserMessageAttachments,
  appendFileAttachmentsToText,
  extractOriginalFilename,
  getMimeTypeFromFilename,
  formatAttachmentSize,
  mergeRestoredSubmissionDraft,
} from "./native-file-test-harness.mjs";

test("historical mixed text and uploaded files restore cards with unchanged payload", () => {
  const payload = "请修改\n\n### `说明.txt`\n```text\n文件内容\n```\n\n[附件: report.pdf (@.pi-uploads/report.pdf)]";
  const result = parseUserMessageAttachments(payload);

  assert.equal(result.cleanText, "请修改\n\n### `说明.txt`\n```text\n文件内容\n```");
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].name, "report.pdf");
  assert.equal(result.attachments[0].serverRelativePath, ".pi-uploads/report.pdf");
  assert.equal(result.attachments[0].type, "application/pdf");

  // 幂等序列化还原
  const reconstructed = appendFileAttachmentsToText(result.cleanText, result.attachments);
  assert.equal(reconstructed, payload);

  // 扩展格式测试：带大小与带单段/两段 uniqueId 前缀的文件名
  const extendedPayload = "查看结果\n\n[附件: owned.txt (@.pi-upload-12345678-owned.txt) - 12 B]";
  const extendedResult = parseUserMessageAttachments(extendedPayload);
  assert.equal(extendedResult.cleanText, "查看结果");
  assert.equal(extendedResult.attachments.length, 1);
  assert.equal(extendedResult.attachments[0].name, "owned.txt");
  assert.equal(extendedResult.attachments[0].serverRelativePath, ".pi-upload-12345678-owned.txt");
  assert.equal(extendedResult.attachments[0].sizeStr, "12 B");

  // 保留带连字符的文件名
  const hyphenName = extractOriginalFilename(".pi-upload-m8x123ab-abc1234-my-custom-report-2026.pdf");
  assert.equal(hyphenName, "my-custom-report-2026.pdf");
});

test("ordinary code and non-suffix file mentions remain message text", () => {
  // 普通代码块和非 marker 文件提及，cleanText 保持不变，不产生伪附件
  for (const body of [
    "### `例子.txt`\n```text\n例子\n```\n这是正文",
    "文件名 old-one.txt 只是在普通正文中被提及，不应变成附件",
  ]) {
    const result = parseUserMessageAttachments(body);
    assert.equal(result.cleanText, body);
    assert.equal(result.attachments.length, 0);
  }

  // 正文中包含合法 marker 时，前后正文合并为 cleanText，marker 提取为附件
  const splitBody = "正文\n\n[附件: @a.pdf]\n下一段";
  const splitResult = parseUserMessageAttachments(splitBody);
  assert.equal(splitResult.cleanText, "正文\n\n下一段");
  assert.equal(splitResult.attachments.length, 1);
  assert.equal(splitResult.attachments[0].name, "a.pdf");
  assert.equal(splitResult.attachments[0].serverRelativePath, "a.pdf");
});

test("restore attachment metadata with draft-store and multiple formats", () => {
  const formats = [
    { name: "test-doc.pdf", path: ".pi-uploads/test-doc.pdf", expectedType: "application/pdf" },
    { name: "sheet.xlsx", path: ".pi-uploads/sheet.xlsx", expectedType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { name: "word.docx", path: ".pi-uploads/word.docx", expectedType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { name: "bundle.zip", path: ".pi-uploads/bundle.zip", expectedType: "application/zip" },
    { name: "readme.txt", path: ".pi-uploads/readme.txt", expectedType: "text/plain" },
    { name: "voice.mp3", path: ".pi-uploads/voice.mp3", expectedType: "application/octet-stream" },
  ];

  for (const item of formats) {
    assert.equal(getMimeTypeFromFilename(item.name), item.expectedType);
  }

  // 验证尺寸格式化
  assert.equal(formatAttachmentSize(0), "0 B");
  assert.equal(formatAttachmentSize(512), "512 B");
  assert.equal(formatAttachmentSize(5 * 1024), "5.0 KB");
  assert.equal(formatAttachmentSize(15 * 1024), "15 KB");
  assert.equal(formatAttachmentSize(2 * 1024 * 1024), "2.0 MB");

  // 模拟从消息解析还原草稿
  const restoredDraftFiles = formats.map((item, idx) => ({
    id: `restored-file-${idx}`,
    name: item.name,
    size: (idx + 1) * 1024,
    type: item.expectedType,
    serverRelativePath: item.path,
    status: "uploaded",
  }));

  const draft = mergeRestoredSubmissionDraft(
    "已恢复历史正文",
    undefined,
    "当前草稿文本",
    [],
    restoredDraftFiles,
    [],
  );

  assert.equal(draft.value, "已恢复历史正文\n\n当前草稿文本");
  assert.equal(draft.files?.length, formats.length);
  assert.equal(draft.files?.[0].name, "test-doc.pdf");
  assert.equal(draft.files?.[0].type, "application/pdf");
  assert.equal(draft.files?.[0].serverRelativePath, ".pi-uploads/test-doc.pdf");

  // 同名不同路径独立保留验证
  const duplicateNameFiles = [
    { id: "f1", name: "report.pdf", size: 100, type: "application/pdf", serverRelativePath: ".pi-uploads/report.pdf", status: "uploaded" },
    { id: "f2", name: "report.pdf", size: 200, type: "application/pdf", serverRelativePath: "nested/report.pdf", status: "uploaded" },
  ];
  const mergedDup = mergeRestoredSubmissionDraft("文本", undefined, "", [], duplicateNameFiles, []);
  assert.equal(mergedDup.files?.length, 2, "同名但不同相对路径的文件各自拥有独立条目，不被误去重");
});
