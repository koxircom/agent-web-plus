import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('./modules/05-composer-and-input-workflow.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const workflow = extract('  async function uploadComposerFile', '  const INLINE_VIDEO_EXTENSIONS')
  + extract('  function encodePathForApi', '  function getEffectiveComposerCwdSyncOrEmpty')
  + extract('  let composerFileProcessingGeneration', '  activeComposerPasteTextarea = null;')
  + extract('  function appendComposerAttachmentsToSubmission', '  // Decode the existing submission')
  + extract('  function resolveAttachmentApiUrl', '  let activeVideoPreviewBackdrop')
  + extract('  function openAttachmentPreview', '  function downloadAttachmentFile');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function harness(sessionId, response = {}) {
  const uploads = [], notices = [], files = [], cleaned = [], previews = [];
  const context = vm.createContext({
    window: { open: url => previews.push(url) },
    Blob, FormData, URLSearchParams, console: { error() {} },
    activeComposerPasteTextarea: null, pendingComposerAttachments: [],
    isPluginEnabled: () => true, getCurrentSessionId: () => sessionId,
    getEffectiveComposerCwd: async () => '/workspace',
    prepareComposerUploadDirectory: async (_cwd, sid) => ({ uploadDir: '/workspace/.pi-uploads/' + sid, relativeDir: '.pi-uploads/' + sid }),
    fetch: async (url, request) => {
      const file = request.body.get('files');
      uploads.push({ url: new URL(url, 'http://localhost'), file, bytes: Buffer.from(await file.arrayBuffer()) });
      return { ok: true, status: response.status ?? 200, json: async () => response.body ?? { uploaded: [file.name], errors: [] } };
    },
    isVideoFile: () => false, getMimeTypeFromExt: () => 'application/octet-stream',
    recordSessionUploadedFile: (sid, path) => files.push({ sid, path }),
    notifyComposerSubmissionStateChange() {}, syncComposerAttachmentBar() {},
    deleteLocalTempFiles: async paths => cleaned.push(...paths),
    showToast: message => notices.push(message), getLanguageForFilename: () => 'text',
  });
  vm.runInContext(workflow, context);
  return { context, uploads, notices, files, cleaned, previews };
}

test('TXT, logs and code upload as complete files and only references enter Pi/Codex messages', async () => {
  for (const sid of ['pi-session', 'codex:session']) {
    const h = harness(sid);
    const examples = [
      ['small.txt', '说明内容', 'text/plain'],
      ['over-20000.txt', 'FILE-CONTENT-'.repeat(2001), 'text/plain'],
      ['长 日志.log', '中文日志内容\n'.repeat(25000), 'text/plain'],
      ['script.py', 'print("FILE-CONTENT")\n'.repeat(12000), 'text/x-python'],
      ['table.csv', 'FILE-CONTENT,123\n'.repeat(2000), 'text/csv'],
    ];
    const files = examples.map(([name, content, type]) => {
      const file = new File([content], name, { type });
      Object.defineProperty(file, 'text', { value() { throw Error('uploaded files must never expand into message text'); } });
      return file;
    });
    await h.context.processComposerFiles(files, {});
    assert.equal(h.uploads.length, files.length);
    for (let i = 0; i < files.length; i++) {
      const att = h.context.pendingComposerAttachments[i];
      assert.equal(att.name, files[i].name);
      assert.equal(att.isText, false); assert.equal(att.uploaded, true);
      assert.equal('textContent' in att, false);
      assert.equal(h.uploads[i].url.searchParams.get('sessionId'), sid);
      assert.equal(hash(h.uploads[i].bytes), hash(Buffer.from(examples[i][1])));
      assert.equal(att.size, h.uploads[i].bytes.length);
    }
    const message = h.context.appendComposerAttachmentsToSubmission('请读取附件', h.context.pendingComposerAttachments);
    assert.ok(message.length < 1500); assert.equal(message.includes('FILE-CONTENT'), false);
    assert.equal((message.match(/\[附件: @/g) || []).length, files.length);
    assert.equal(message.includes('```'), false);
    assert.equal(h.files.length, files.length);
    const before = JSON.stringify(h.context.pendingComposerAttachments);
    h.context.openAttachmentPreview(h.context.pendingComposerAttachments[1], '/workspace');
    assert.equal(new URL(h.previews[0], 'http://localhost').searchParams.get('sessionId'), sid);
    assert.equal(JSON.stringify(h.context.pendingComposerAttachments), before);
    assert.equal(h.context.appendComposerAttachmentsToSubmission('请读取附件', h.context.pendingComposerAttachments), message);
  }
});

test('an upload error inside HTTP 207 never becomes a successful attachment or inline text', async () => {
  const h = harness('codex:session', { status: 207, body: { uploaded: [], errors: [{ name: 'file.txt', error: '工作区不可写' }] } });
  await h.context.processComposerFiles([new File(['FILE-CONTENT'.repeat(3000)], 'file.txt')], {});
  assert.equal(h.context.pendingComposerAttachments.length, 0);
  assert.equal(h.files.length, 0);
  assert.ok(h.notices.some(message => message.includes('上传失败') && message.includes('工作区不可写')));
  assert.equal(h.context.appendComposerAttachmentsToSubmission('正文', h.context.pendingComposerAttachments), '正文');
});

test('a new draft omits the fake draft id from engine routing and a disabled feature does no upload', async () => {
  const h = harness(null);
  await h.context.processComposerFiles([new File(['原始文件'], 'new.txt')], {});
  assert.equal(h.uploads[0].url.searchParams.has('sessionId'), false);
  assert.match(h.context.pendingComposerAttachments[0].sessionId, /^draft-/);
  h.context.isPluginEnabled = () => false;
  await h.context.processComposerFiles([new File(['原始文件'], 'disabled.txt')], {});
  assert.equal(h.uploads.length, 1);
});
