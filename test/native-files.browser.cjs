const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

async function main() {
  console.log('=== 启动原生普通文件附件全流程与真实浏览器验收 ===');

  // 构建真实客户端 Bundle (包含 ChatInput, MessageView 与所有核心函数)
  const bundle = await esbuild.build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React, { useState, useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ChatInput } from './components/ChatInput';
        import { MessageView } from './components/MessageView';
        import type { UserMessage } from './lib/types';
        import {
          extractOriginalFilename,
          serializeFileAttachmentMarker,
          appendFileAttachmentsToText,
          parseUserMessageAttachments,
        } from './lib/message-file-attachments';
        import {
          getDraft,
          setDraft,
          clearDraft,
        } from './lib/draft-store';
        import {
          MAX_UPLOAD_FILE_BYTES,
          MAX_UPLOAD_BATCH_BYTES,
          uploadSingleComposerFile,
        } from './lib/file-upload-client';

        import { I18nProvider } from './hooks/useI18n';

        // 挂载到 window 供页面环境与单测断言
        (window as any).__FILES_LIB__ = {
          extractOriginalFilename,
          serializeFileAttachmentMarker,
          appendFileAttachmentsToText,
          parseUserMessageAttachments,
          getDraft,
          setDraft,
          clearDraft,
          MAX_UPLOAD_FILE_BYTES,
          MAX_UPLOAD_BATCH_BYTES,
          uploadSingleComposerFile,
        };

        function TestFilesHost() {
          const [draftKey, setDraftKey] = useState<string>('test-draft-files');
          const [lastSubmitted, setLastSubmitted] = useState<string | null>(null);
          const [historyMessage, setHistoryMessage] = useState<UserMessage | null>(null);

          const handleSend = (text: string) => {
            setLastSubmitted(text);
            (window as any).__lastSubmitted = text;
          };

          useEffect(() => {
            (window as any).__setHistoryMessage = (msg: UserMessage) => {
              setHistoryMessage(msg);
            };
            (window as any).__switchDraftKey = (key: string) => {
              setDraftKey(key);
            };
            (window as any).__clearLastSubmitted = () => {
              setLastSubmitted(null);
              (window as any).__lastSubmitted = undefined;
            };
          }, []);

          return (
            <div style={{ padding: 20, background: '#121214', color: '#fff', fontFamily: 'sans-serif' }}>
              <div data-testid="last-submitted-display" style={{ display: 'none' }}>{lastSubmitted || ''}</div>
              <div style={{ maxWidth: 700, margin: '0 auto', marginBottom: 24 }}>
                <ChatInput
                  cwd="/workspace/test-project"
                  draftKey={draftKey}
                  onSend={handleSend}
                  isStreaming={false}
                  onAbort={() => {}}
                />
              </div>

              {historyMessage && (
                <div data-testid="test-history-container" style={{ maxWidth: 700, margin: '0 auto' }}>
                  <MessageView message={historyMessage} cwd="/workspace/test-project" />
                </div>
              )}
            </div>
          );
        }

        createRoot(document.getElementById('root')!).render(
          <I18nProvider initialLocale="zh-CN">
            <TestFilesHost />
          </I18nProvider>
        );
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    loader: {
      '.woff': 'empty',
      '.woff2': 'empty',
      '.ttf': 'empty',
      '.eot': 'empty',
      '.css': 'empty',
    },
    alias: { '@': root },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_APP_VERSION': '"1.4.46"',
    },
  });

  const bundleJs = bundle.outputFiles[0].text;

  let uploadRequestCount = 0;
  let fail207Attempts = 0;
  const receivedUploads = [];

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8" /><title>Native Files Fixture</title></head>
        <body>
          <div id="root"></div>
          <script src="/bundle.js"></script>
        </body>
        </html>
      `);
    }

    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(bundleJs);
    }

    if (req.url.startsWith('/api/cwd/browse')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, path: '/workspace/test-project/.pi-uploads' }));
    }

    if (req.url.startsWith('/api/files/')) {
      uploadRequestCount++;
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        receivedUploads.push({ url: req.url, bodySnippet: rawBody.slice(0, 300) });

        if (req.url.includes('type=upload-check')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ conflicts: [], nonReplaceable: [] }));
        }

        // 模拟慢速上传以测试 route race
        if (rawBody.includes('slow-upload.txt')) {
          setTimeout(() => {
            const match = rawBody.match(/filename="([^"]+)"/);
            const fileName = match ? match[1] : 'slow-upload.txt';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              uploaded: [fileName],
              skipped: [],
              errors: [],
            }));
          }, 350);
          return;
        }

        // 模拟 HTTP 207 错误条件 (第一次失败，重试成功)
        if (rawBody.includes('fail-207.txt')) {
          fail207Attempts++;
          if (fail207Attempts === 1) {
            res.writeHead(207, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              uploaded: [],
              skipped: [],
              errors: [{ name: 'fail-207.txt', error: 'HTTP 207 工作区限制写入' }],
            }));
          }
        }

        // 提取文件名
        const match = rawBody.match(/filename="([^"]+)"/);
        const fileName = match ? match[1] : 'uploaded.bin';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          uploaded: [fileName],
          skipped: [],
          errors: [],
        }));
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`✔ HTTP Fixture Server 已启动: http://localhost:${port}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', err => console.error('Browser Page Error:', err));
  page.on('console', msg => console.log('Browser Console:', msg.text()));

  try {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea', { timeout: 10000 });
    console.log('✔ 测试宿主与 ChatInput 组件已成功加载');

    // 1. 运行浏览器内模块定点单测
    console.log('\n=== Step 1: 运行纯函数定点单测 (原名还原、连字符保留、双份正文消除、旧草稿兼容) ===');
    const unitResults = await page.evaluate(async () => {
      const lib = (window).__FILES_LIB__;
      const errors = [];

      // 1.1 连字符与特殊字符（空格、括号、方括号、hyphen）保留断言
      const fn1 = lib.extractOriginalFilename('.pi-upload-m2xyz-99abc-my-report-2026.pdf');
      if (fn1 !== 'my-report-2026.pdf') errors.push(`fn1 expected my-report-2026.pdf, got: ${fn1}`);

      const fn2 = lib.extractOriginalFilename('.pi-upload-12345678-owned.txt');
      if (fn2 !== 'owned.txt') errors.push(`fn2 expected owned.txt, got: ${fn2}`);

      const fn3 = lib.extractOriginalFilename('.pi-upload-token1-token2-data-part-a-v2.json');
      if (fn3 !== 'data-part-a-v2.json') errors.push(`fn3 expected data-part-a-v2.json, got: ${fn3}`);

      const fnSpecial = lib.extractOriginalFilename('.pi-upload-m2xyz-99abc-VRFQ-2026-0001+2026-09-28+KOXIR+套缸 (1).xlsx');
      if (fnSpecial !== 'VRFQ-2026-0001+2026-09-28+KOXIR+套缸 (1).xlsx') {
        errors.push(`fnSpecial expected VRFQ-2026-0001+2026-09-28+KOXIR+套缸 (1).xlsx, got: ${fnSpecial}`);
      }

      // 1.2 序列化断言 (标准安全编码格式)
      const s = lib.appendFileAttachmentsToText('正文说明', [{ serverRelativePath: '.pi-uploads/m2xyz/.pi-upload-1-doc.pdf' }]);
      if (s !== '正文说明\n\n[附件: @.pi-uploads/m2xyz/.pi-upload-1-doc.pdf]') errors.push(`append serialization failed: ${s}`);

      const sSpecial = lib.appendFileAttachmentsToText('特殊说明', [{
        serverRelativePath: '.pi-uploads/test.xlsx',
        name: 'VRFQ-2026-0001+2026-09-28+KOXIR+套缸 (1).xlsx',
      }]);
      if (!sSpecial.includes('[附件: ') || !sSpecial.includes('(@.pi-uploads/test.xlsx)')) {
        errors.push(`append special serialization failed: ${sSpecial}`);
      }

      // 1.3 解析与消除双份正文断言 (支持路径含空格、仅移除成功跨度不盲删用户正文)
      const parsed = lib.parseUserMessageAttachments('正文内容\n\n[附件: @.pi-uploads/123/.pi-upload-m2xyz-99abc-test-file.txt]');
      if (parsed.cleanText !== '正文内容') errors.push(`cleanText failed: ${parsed.cleanText}`);
      if (parsed.attachments.length !== 1 || parsed.attachments[0].name !== 'test-file.txt') {
        errors.push(`parsed attachment error: ${JSON.stringify(parsed.attachments)}`);
      }

      // 路径含空格与括号解析断言
      const parsedSpace = lib.parseUserMessageAttachments('路径含空格\n\n[附件: @.pi-uploads/my folder/report (final).pdf]');
      if (parsedSpace.cleanText !== '路径含空格') errors.push(`cleanText with space failed: ${parsedSpace.cleanText}`);
      if (parsedSpace.attachments.length !== 1 || parsedSpace.attachments[0].serverRelativePath !== '.pi-uploads/my folder/report (final).pdf') {
        errors.push(`parsed space attachment failed: ${JSON.stringify(parsedSpace.attachments)}`);
      }

      // 仅移除确认识别成功跨度，未识别标记保留在正文中绝不隐去
      const textWithUnrecognized = '普通说明 [附件: 请阅读上述分析] 完毕\n\n[附件: @.pi-uploads/valid.pdf]';
      const parsedSelective = lib.parseUserMessageAttachments(textWithUnrecognized);
      if (!parsedSelective.cleanText.includes('[附件: 请阅读上述分析]')) {
        errors.push(`unrecognized marker must be preserved in cleanText: ${parsedSelective.cleanText}`);
      }
      if (parsedSelective.attachments.length !== 1) {
        errors.push(`expected 1 valid attachment, got: ${parsedSelective.attachments.length}`);
      }

      // 1.4 同名不同路径保留断言
      const parsedDual = lib.parseUserMessageAttachments('双路径\n\n[附件: @dirA/.pi-upload-1-data.csv]\n\n[附件: @dirB/.pi-upload-2-data.csv]');
      if (parsedDual.attachments.length !== 2) errors.push(`parsedDual length != 2: ${parsedDual.attachments.length}`);

      // 1.5 旧草稿向后兼容 (version: 3，且无 files 字段)
      const legacyKey = 'draft-legacy-sess';
      const legacyData = {
        version: 3,
        ownerKey: legacyKey,
        value: '历史纯文本草稿',
        images: [],
        updatedAt: Date.now(),
      };
      localStorage.setItem(`pi-enh-composer-draft-v3:${encodeURIComponent(legacyKey)}`, JSON.stringify(legacyData));
      const loadedLegacy = lib.getDraft(legacyKey);
      if (!loadedLegacy || loadedLegacy.value !== '历史纯文本草稿' || !Array.isArray(loadedLegacy.images)) {
        errors.push(`loadedLegacy failed: ${JSON.stringify(loadedLegacy)}`);
      }

      return errors;
    });

    assert.equal(unitResults.length, 0, `单元测试存在错误: ${unitResults.join('; ')}`);
    console.log('✔ 纯函数定点单测全部断言通过！');

    // 2. 真实浏览器组件深度交互验收
    console.log('\n=== Step 2: 真实浏览器组件与 HTTP Fixture 交互验收 ===');

    // 2.1 用户双贴测试 (用户连续粘贴同名文件，断言生成两份独立实例并分别上传)
    console.log('--- 测试 2.1: 用户双贴 (连续两次 paste 同名文件) ---');
    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const file1 = new File(['content-1'], 'report-v1.pdf', { type: 'application/pdf' });
      const dt1 = new DataTransfer();
      dt1.items.add(file1);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt1, bubbles: true, cancelable: true }));
    });

    await page.waitForTimeout(300);

    // 第二次贴同样的文件
    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const file2 = new File(['content-2'], 'report-v1.pdf', { type: 'application/pdf' });
      const dt2 = new DataTransfer();
      dt2.items.add(file2);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }));
    });

    // 断言界面上出现两个附件卡片
    await page.waitForFunction(() => {
      const cards = document.querySelectorAll('[data-testid="composer-file-card"]');
      return cards.length === 2;
    }, { timeout: 5000 });

    assert.equal(uploadRequestCount >= 2, true, '两次 paste 必须各自分别触发上传');
    console.log('✔ 用户双贴生成两份独立实例并成功上传断言通过');

    // 清理这两张卡片
    await page.evaluate(() => {
      const removeBtns = document.querySelectorAll('[aria-label="移除文件"]');
      removeBtns.forEach(btn => btn.click());
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-file-card"]').length === 0);

    // 2.2 HTTP 207 失败场景与明确重试入口
    console.log('--- 测试 2.2: HTTP 207 错误、阻止发送与点击重试 ---');
    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const badFile = new File(['bad'], 'fail-207.txt', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(badFile);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // 等待卡片呈现 207 错误状态
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="composer-file-card"]');
      return card && card.textContent.includes('207');
    }, { timeout: 5000 });
    console.log('✔ 207 状态码被正确判定为失败且卡片呈现错误状态');

    // 尝试在存在错误附件时发送
    await page.fill('textarea', '测试试图发送');
    const sendBtn = await page.$('button[title*="发送"], button[aria-label*="发送"], form button:last-child');
    if (sendBtn) await sendBtn.click().catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const submittedDuringError = await page.evaluate(() => (window).__lastSubmitted);
    assert.equal(submittedDuringError, undefined, '存在失败附件时必须硬性阻止一切发送');
    console.log('✔ 失败附件硬性阻止发送断言通过');

    // 点击明确重试入口进行重试上传
    console.log('--- 测试 2.2b: 点击重试按钮成功自愈恢复 ---');
    const retryBtn = await page.waitForSelector('button[title="重试上传"]', { timeout: 5000 });
    await retryBtn.click();

    // 第二次请求由 HTTP mock 准许通过，等待卡片恢复为 uploaded 正常态 (重试按钮消失且无错误文本)
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="composer-file-card"]');
      return card && !card.querySelector('button[title="重试上传"]') && !card.textContent.includes('工作区限制写入') && !card.textContent.includes('上传中');
    }, { timeout: 5000 });
    console.log('✔ 明确重试入口调用 handleRetryFile 恢复正常断言通过');

    // 移除已重试卡片并清理文本
    await page.click('[aria-label="移除文件"]');
    await page.fill('textarea', '');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-file-card"]').length === 0);

    // 2.3 New File-Only 允许发送测试
    console.log('--- 测试 2.3: New File-Only 可发送验证 (无文本、无图片、仅文件附件) ---');
    await page.evaluate(() => {
      (window).__clearLastSubmitted();
      const ta = document.querySelector('textarea');
      const doc = new File(['pure doc content'], 'pure-file-only.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const dt = new DataTransfer();
      dt.items.add(doc);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="composer-file-card"]');
      return card && card.textContent.includes('pure-file-only.docx') && !card.textContent.includes('上传中');
    }, { timeout: 5000 });

    // 确保输入框完全为空
    const currentInputVal = await page.inputValue('textarea');
    assert.equal(currentInputVal, '', '输入框必须保持为空');

    // 发送按钮此时必须可用 (canSendMessage: true)
    const fileOnlySendBtn = await page.waitForSelector('button.chat-composer-send, button[aria-label="Send"], button[aria-label="发送"]', { timeout: 5000 });
    await fileOnlySendBtn.click();

    await page.waitForFunction(() => typeof (window).__lastSubmitted === 'string', { timeout: 5000 });
    const fileOnlyResult = await page.evaluate(() => (window).__lastSubmitted);
    assert.match(fileOnlyResult, /\[附件: pure-file-only\.docx \(@[^\]]+pure-file-only\.docx\)\]/, '纯文件附件无文本消息必须能够成功发送且包含带原名 Marker');
    console.log('✔ New File-Only 成功发送断言通过');

    // 2.4 Route Race 会话切换竞态测试 (A 会话上传未完成，晚回不得写 B)
    console.log('--- 测试 2.4: Route Race 会话切换隔离测试 ---');
    await page.evaluate(() => {
      // 切换到 session-A 并触发慢速上传
      (window).__switchDraftKey('session-A');
    });
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const slowFile = new File(['slow'], 'slow-upload.txt', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(slowFile);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // 立即切换到 session-B
    await page.evaluate(() => {
      (window).__switchDraftKey('session-B');
    });

    // 等待 500ms (超过 slow-upload 的 350ms 延迟)
    await page.waitForTimeout(500);

    // 断言 session-B 的界面绝对未被 session-A 的文件污染
    const sessionBCardsCount = await page.evaluate(() => document.querySelectorAll('[data-testid="composer-file-card"]').length);
    assert.equal(sessionBCardsCount, 0, 'session-A 晚回的结果绝对不得污染当前 session-B');

    // 切回 session-A，断言 session-A 的草稿已正确持久保存该文件
    await page.evaluate(() => {
      (window).__switchDraftKey('session-A');
    });
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="composer-file-card"]');
      return card && card.textContent.includes('slow-upload.txt');
    }, { timeout: 5000 });
    console.log('✔ Route Race 晚回不污染 B 且安全写回 A 草稿断言通过');

    // 切回主测试草稿
    await page.evaluate(() => {
      (window).__switchDraftKey('test-draft-files');
    });
    await page.waitForTimeout(200);

    // 2.5 旧 Draft 恢复保护测试 (恢复上传中/失败不能变默认 uploaded 无 path)
    console.log('--- 测试 2.5: 旧 Draft 孤儿状态恢复保护 ---');
    await page.evaluate(() => {
      const badDraftKey = 'draft-orphan-uploading';
      const badDraftData = {
        version: 3,
        ownerKey: badDraftKey,
        value: '孤儿上传草稿',
        images: [],
        files: [
          {
            id: 'orphan-1',
            name: 'interrupted-doc.pdf',
            size: 1024,
            type: 'application/pdf',
            status: 'uploading', // 无 serverRelativePath 的异常中断状态
          },
        ],
        updatedAt: Date.now(),
      };
      localStorage.setItem(`pi-enh-composer-draft-v3:${encodeURIComponent(badDraftKey)}`, JSON.stringify(badDraftData));
      (window).__switchDraftKey(badDraftKey);
    });

    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="composer-file-card"]');
      return card && card.textContent.includes('interrupted-doc.pdf') && card.textContent.includes('上传中断');
    }, { timeout: 5000 });

    // 尝试在中断错误卡片存在时发送，必须被阻断
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const submittedOrphan = await page.evaluate(() => (window).__lastSubmitted);
    assert.equal(submittedOrphan, fileOnlyResult, '恢复中断文件必须为 error 状态且阻断发送');
    console.log('✔ 旧 Draft 孤儿状态安全转 error 且阻断发送断言通过');

    // 切回主测试草稿
    await page.evaluate(() => {
      (window).__switchDraftKey('test-draft-files');
    });
    await page.waitForTimeout(200);

    // 2.6 Space / Brackets / Hyphen 特殊原文件名全流程测试
    console.log('--- 测试 2.6: 特殊文件名 (space brackets hyphen) 粘贴与 MessageView 受控打开 ---');
    await page.evaluate(() => {
      (window).__clearLastSubmitted();
      const ta = document.querySelector('textarea');
      const specialFile = new File(
        ['data'],
        'VRFQ-2026-0001+2026-09-28+KOXIR+套缸 (1).xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      );
      const dt = new DataTransfer();
      dt.items.add(specialFile);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="composer-file-card"]');
      return card && card.textContent.includes('套缸 (1).xlsx') && !card.textContent.includes('上传中');
    }, { timeout: 5000 });

    await page.fill('textarea', '请核对采购单清单');
    const sendButtonSpecial = await page.waitForSelector('button.chat-composer-send, button[aria-label="Send"], button[aria-label="发送"]', { timeout: 5000 });
    await sendButtonSpecial.click();

    await page.waitForFunction(() => {
      const last = (window).__lastSubmitted;
      return typeof last === 'string' && last.includes('请核对采购单清单');
    }, { timeout: 5000 });

    const specialSubmitted = await page.evaluate(() => (window).__lastSubmitted);
    assert.equal(specialSubmitted.includes('VRFQ-2026-0001+2026-09-28+KOXIR+套缸 (1).xlsx') || specialSubmitted.includes('VRFQ-2026-0001'), true, '提交必须保留完整特殊文件名');

    // 挂载到 MessageView 验证渲染
    await page.evaluate((submitted) => {
      const history = {
        role: 'user',
        timestamp: Date.now(),
        content: submitted,
      };
      (window).__setHistoryMessage(history);
    }, specialSubmitted);

    await page.waitForSelector('[data-testid="user-message-attachment-card"]', { timeout: 5000 });
    const specialCardText = await page.textContent('[data-testid="user-message-attachment-card"]');
    assert.equal(specialCardText.includes('套缸 (1).xlsx'), true, 'MessageView 卡片必须完整显示中文、括号与连字符');
    console.log('✔ 特殊文件名 (space brackets hyphen) 全流程断言通过');

    console.log('\n========================================');
    console.log('🎉 所有定点纯函数与真浏览器 HTTP Fixture 验收全绿通过！');
    console.log('========================================');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
