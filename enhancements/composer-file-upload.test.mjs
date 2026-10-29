import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('./modules/05-composer-and-input-workflow.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const workflow = extract('  async function uploadComposerFile', '  const INLINE_VIDEO_EXTENSIONS')
  + extract('  function encodePathForApi', '  function getEffectiveComposerCwdSyncOrEmpty')
  + extract('  async function prepareComposerUploadDirectory', '  async function cleanupSessionUploadedFiles')
  + extract('  let composerFileProcessingGeneration', '  activeComposerPasteTextarea = null;')
  + extract('  function appendComposerAttachmentsToSubmission', '  // Decode the existing submission')
  + extract('  function resolveAttachmentApiUrl', '  let activeVideoPreviewBackdrop')
  + extract('  function openAttachmentPreview', '  function downloadAttachmentFile');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('historical file cards belong to the message, never the session upload cleanup inventory', () => {
  const session = 'attachment-ownership-fixture';
  const inventory = JSON.stringify({ [session]: ['/workspace/.pi-upload-12345678-old-one.txt', '/workspace/.pi-upload-87654321-old-two.txt'] });
  let first;
  const context = vm.createContext({
    localStorage: { getItem: () => inventory, setItem: () => assert.fail('Rendering must not change cleanup records') },
    SESSION_UPLOADS_KEY: 'pi-enh-session-uploads',
    document: { querySelectorAll: () => [first] },
    getMimeTypeFromExt: () => 'text/plain',
  });
  vm.runInContext(extract('  function extractOriginalFilename', '  function hideAttachmentSyntaxInMessage'), context);
  for (const text of ['下一轮纯文字', 'old-one.txt 只是提到文件名', '历史窗口移动后新挂载的一轮']) {
    first = { textContent: text };
    assert.equal(context.extractAttachmentsFromUserMessage(first, session).length, 0, text);
  }
  for (const marker of ['[附件: @.pi-upload-12345678-owned.txt]', '[附件: owned.txt (@.pi-upload-12345678-owned.txt) - 12 B]']) {
    first = { textContent: '请查看\n\n' + marker };
    const cards = context.extractAttachmentsFromUserMessage(first, session);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].name, 'owned.txt');
    assert.equal(cards[0].serverRelativePath, '.pi-upload-12345678-owned.txt');
  }
  assert.equal(context.localStorage.getItem('pi-enh-session-uploads'), inventory);
});

test('committing an attachment submission leaves subsequent rounds clean without deleting uploaded files', async () => {
  for (const session of ['pi-rounds', 'codex:rounds']) {
    const h = harness(session);
    Object.assign(h.context, { findComposerTextarea: () => null, revokeAttachmentPreviewUrl() {} });
    vm.runInContext(extract('  function prepareComposerSubmission', '  window.__PI_ENH_PREPARE_COMPOSER_SUBMISSION__'), h.context);
    await h.context.processComposerFiles([new File(['fixture'], 'owned.txt', { type: 'text/plain' })], {});
    const first = h.context.prepareComposerSubmission('send', '有附件');
    assert.match(first.text, /\[附件: @/);
    first.commit(); first.commit();
    assert.equal(h.context.pendingComposerAttachments.length, 0);
    for (const kind of ['send', 'steer', 'followUp']) assert.equal(h.context.prepareComposerSubmission(kind, '下一轮'), null);
    assert.equal(h.files.length, 1, 'Cleanup inventory remains independent of pending submissions');
    assert.equal(h.cleaned.length, 0, 'Sending must not delete user files');
  }
});
function harness(sessionId, response = {}, engine = sessionId?.startsWith('codex:') ? 'codex' : 'pi') {
  const uploads = [], notices = [], files = [], cleaned = [], previews = [];
  const context = vm.createContext({
    window: { open: url => previews.push(url) },
    Blob, FormData, URLSearchParams, console: { error() {} },
    activeComposerPasteTextarea: null, pendingComposerAttachments: [],
    isPluginEnabled: () => true, getCurrentSessionId: () => sessionId,
    getComposerExecutionEngineHint: () => engine,
    getEffectiveComposerCwd: async () => '/workspace',
    fetch: async (url, request) => {
      if(url.startsWith('http://127.0.0.1:30149/'))return {ok:false,status:503};
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

test('Codex uses its existing workspace upload root without raw session IDs or a browser-local bridge', async () => {
  const h=harness('codex:01901234-5678-7000-8000-000000000001');
  const prepared=await h.context.prepareComposerUploadDirectory('/workspace','codex:01901234-5678-7000-8000-000000000001');
  assert.equal(prepared.uploadDir,'/workspace');
  assert.equal(prepared.relativeDir,'');
  await h.context.processComposerFiles([new File(['原始附件'.repeat(6000)],'文档.txt')],{});
  const url=h.uploads[0].url;
  assert.equal(url.pathname,'/api/files/workspace');
  assert.equal(url.searchParams.get('sessionId'),'codex:01901234-5678-7000-8000-000000000001');
  const att=h.context.pendingComposerAttachments[0];
  assert.match(att.serverRelativePath,/^\.pi-upload-/);
  assert.equal(att.serverAbsPath,'/workspace/'+att.serverRelativePath);
  assert.equal(att.isText,false);
});

test('a new Codex composer uses its engine hint before a session exists', async () => {
  const h=harness(null,{},'codex');
  await h.context.processComposerFiles([new File(['原始文件'],'new.txt')],{});
  assert.equal(h.uploads[0].url.pathname,'/api/files/workspace');
  assert.equal(h.uploads[0].url.searchParams.has('sessionId'),false);
  assert.match(h.context.pendingComposerAttachments[0].serverRelativePath,/^\.pi-upload-/);
});

// Dispatch both real capture listeners on the same input: stopPropagation does
// not stop another listener registered on that same target.
function pasteHarness(order = 'file-first', enabled = {}) {
  const h = harness('codex:paste-fixture');
  class Textarea extends EventTarget {}
  const textarea = new Textarea();
  const pending = [], inserts = [];
  const process = h.context.processComposerFiles;
  Object.assign(h.context, {
    HTMLTextAreaElement: Textarea, textarea, composerPasteHandler: null,
    findComposerTextarea: () => textarea,
    isPluginEnabled: id => enabled[id] !== false,
    isVideoFile: name => /\.mp4$/i.test(name),
    processComposerFiles: (...args) => { const task = process(...args); pending.push(task); return task; },
    hasSubstantialRichFormatting: html => html.includes('<strong>'),
    htmlToMarkdown: () => '**formatted**',
    insertMarkdownIntoComposer: md => inserts.push(md),
  });
  vm.runInContext(extract('    composerPasteHandler = (event) => {', '    const getDropHighlightTarget')
    + extract('  function handleComposerMarkdownPaste', '  function instantlyClearComposerSurface'), h.context);
  const handlers = [h.context.composerPasteHandler, h.context.handleComposerMarkdownPaste];
  if (order === 'markdown-first') handlers.reverse();
  for (const listener of handlers) textarea.addEventListener('paste', listener, true);
  return { ...h, inserts, async paste(files, { itemOnly = false, html = '', plain = '' } = {}) {
    const event = new Event('paste', { cancelable: true, bubbles: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      files: itemOnly ? [] : files,
      items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: type => type === 'text/html' ? html : plain,
    } });
    textarea.dispatchEvent(event);await Promise.all(pending.splice(0));return event;
  } };
}

for (const order of ['file-first', 'markdown-first']) {
  for (const [name, type] of [['clip.mp4', 'video/mp4'], ['report.pdf', 'application/pdf'], ['archive.zip', 'application/zip'], ['notes.txt', 'text/plain'], ['sound.mp3', 'audio/mpeg']]) {
    test(`${order}: one ${name} paste uploads and appends exactly once`, async () => {
      const h = pasteHarness(order), file = new File(['original bytes'], name, { type });
      const event = await h.paste([file]);
      assert.equal(event.defaultPrevented, true);assert.equal(h.uploads.length, 1);assert.equal(h.context.pendingComposerAttachments.length, 1);
      assert.equal(h.context.pendingComposerAttachments[0].name, name);
    });
  }
  test(`${order}: item-only clipboard, multiple files and intentional second paste preserve multiplicity`, async () => {
    const h = pasteHarness(order), files = [new File(['a'], 'clip.mp4', { type: 'video/mp4' }), new File(['b'], 'report.pdf', { type: 'application/pdf' })];
    await h.paste(files, { itemOnly: true });assert.equal(h.uploads.length, 2);
    await h.paste([files[0]]);assert.equal(h.uploads.length, 3);assert.equal(h.context.pendingComposerAttachments.length, 3);
  });
}

test('file and Markdown switches each retain their own ownership', async () => {
  const video = new File(['a'], 'clip.mp4', { type: 'video/mp4' });
  const fileOnly = pasteHarness('markdown-first', { 'composer-markdown-format': false });
  await fileOnly.paste([video]);assert.equal(fileOnly.uploads.length, 1);
  const disabled = pasteHarness('file-first', { 'composer-file-paste': false });
  assert.equal((await disabled.paste([video])).defaultPrevented, false);assert.equal(disabled.uploads.length, 0);
  const images = pasteHarness();
  assert.equal((await images.paste([new File(['png'], 'image.png', { type: 'image/png' })])).defaultPrevented, false);assert.equal(images.uploads.length, 0);
  await images.paste([], { html: '<strong>formatted</strong>', plain: 'formatted' });assert.deepEqual(images.inserts, ['**formatted**']);assert.equal(images.uploads.length, 0);
});
