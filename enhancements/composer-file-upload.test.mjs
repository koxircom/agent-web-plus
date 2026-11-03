import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseUserMessageAttachments,
  appendFileAttachmentsToText,
  uploadSingleComposerFile,
  ensureUploadDirectory,
  generateSafeUploadName,
  MAX_UPLOAD_FILE_BYTES,
  startNativeInputServer,
  runBrowserTest,
} from "./native-file-test-harness.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("historical file cards belong to the message, never the session upload cleanup inventory", () => {
  const session = "attachment-ownership-fixture";
  const inventory = JSON.stringify({ [session]: ["/workspace/.pi-upload-12345678-old-one.txt"] });

  // 模拟 localStorage，确保解析消息附件绝不侵入上传清理记录
  let storageChanged = false;
  const originalGet = globalThis.localStorage?.getItem;
  const originalSet = globalThis.localStorage?.setItem;
  globalThis.localStorage = {
    getItem: () => inventory,
    setItem: () => { storageChanged = true; },
  };

  try {
    for (const text of ["下一轮纯文字", "old-one.txt 只是提到文件名", "历史窗口移动后新挂载的一轮"]) {
      const res = parseUserMessageAttachments(text);
      assert.equal(res.attachments.length, 0, text);
      assert.equal(res.cleanText, text);
    }

    for (const marker of [
      "[附件: @.pi-upload-12345678-owned.txt]",
      "[附件: owned.txt (@.pi-upload-12345678-owned.txt) - 12 B]",
    ]) {
      const res = parseUserMessageAttachments("请查看\n\n" + marker);
      assert.equal(res.attachments.length, 1);
      assert.equal(res.attachments[0].name, "owned.txt");
      assert.equal(res.attachments[0].serverRelativePath, ".pi-upload-12345678-owned.txt");
      assert.equal(res.cleanText, "请查看");
    }

    assert.equal(storageChanged, false, "Rendering must not change cleanup records");
  } finally {
    if (originalGet) globalThis.localStorage.getItem = originalGet;
    if (originalSet) globalThis.localStorage.setItem = originalSet;
  }
});

test("committing an attachment submission leaves subsequent rounds clean without deleting uploaded files", async () => {
  const uploadedServerFiles = [];
  const { baseUrl, close } = await startNativeInputServer(async (req, res, url) => {
    if (url.pathname.startsWith("/api/files/")) {
      const type = url.searchParams.get("type");
      if (type === "upload-check") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ conflicts: [], nonReplaceable: [] }));
        return true;
      }
      if (type === "upload") {
        let rawBody = "";
        for await (const chunk of req) rawBody += chunk.toString("binary");
        const match = rawBody.match(/filename="([^"]+)"/);
        const name = match ? match[1] : "upload.bin";
        uploadedServerFiles.push(name);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ uploaded: [name], errors: [] }));
        return true;
      }
    }
    return false;
  });

  try {
    await runBrowserTest({
      baseUrl,
      viewport: { width: 1024, height: 768 },
      testFn: async (page) => {
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearSentEvents();
          api.setMode("composer");
          api.setDraftKey("session-commit-test");
          api.setCwd("/workspace/test");
        });

        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 粘贴一个文件
        await textarea.fill("第一轮有附件");
        await page.evaluate(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          const file = new File(["fixture-data"], "owned.txt", { type: "text/plain" });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        });

        // 等待附件上传完成
        const card = page.locator('[data-testid="composer-file-card"]').first();
        await card.waitFor();
        await page.waitForFunction(() => {
          const c = document.querySelector('[data-testid="composer-file-card"]');
          return c && !c.textContent.includes("上传中...");
        });

        // 提交发送
        await textarea.press("Enter");

        // 等待第 1 轮消息发出
        await page.waitForFunction(() => window.__NATIVE_INPUT_API__.getSentEvents().length === 1);
        const events = await page.evaluate(() => window.__NATIVE_INPUT_API__.getSentEvents());
        assert.match(events[0].message, /第一轮有附件/);
        assert.match(events[0].message, /\[附件: owned\.txt \(@\.pi-uploads\/\.pi-upload-/);

        // 验证当前轮提交后，输入框卡片已清空
        const remainingCards = await page.locator('[data-testid="composer-file-card"]').count();
        assert.equal(remainingCards, 0, "提交后输入区附件卡片必须清空");

        // 下一轮输入纯文字发送，验证无历史附件残留
        await textarea.fill("第二轮纯正文");
        await textarea.press("Enter");
        await page.waitForFunction(() => window.__NATIVE_INPUT_API__.getSentEvents().length === 2);
        const eventsRound2 = await page.evaluate(() => window.__NATIVE_INPUT_API__.getSentEvents());
        assert.equal(eventsRound2[1].message, "第二轮纯正文", "后续轮次必须干净，严禁串入上一轮附件");

        // 服务端上传文件独立保留，严禁误删
        assert.equal(uploadedServerFiles.length, 1, "Sending must not delete uploaded files on server");
      },
    });
  } finally {
    await close();
  }
});

test("TXT, logs and code upload as complete files and only references enter Pi/Codex messages", async () => {
  const examples = [
    ["small.txt", "说明内容", "text/plain"],
    ["over-20000.txt", "FILE-CONTENT-".repeat(2001), "text/plain"],
    ["长 日志.log", "中文日志内容\n".repeat(2500), "text/plain"],
    ["script.py", 'print("FILE-CONTENT")\n'.repeat(1200), "text/x-python"],
    ["table.csv", "FILE-CONTENT,123\n".repeat(200), "text/csv"],
  ];

  for (const sid of ["pi-session", "codex:session"]) {
    const isCodex = sid.startsWith("codex:");
    const mockUploads = [];

    // 针对每个文件调用原生 uploadSingleComposerFile 服务函数
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const urlObj = new URL(url, "http://127.0.0.1");
      if (urlObj.searchParams.get("type") === "upload-check") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ conflicts: [], nonReplaceable: [] }),
        };
      }
      if (urlObj.searchParams.get("type") === "upload") {
        const formData = options.body;
        const file = formData.get("files");
        const bytes = Buffer.from(await file.arrayBuffer());
        mockUploads.push({ url: urlObj, file, bytes });
        return {
          ok: true,
          status: 200,
          json: async () => ({ uploaded: [file.name], errors: [] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    try {
      const results = [];
      for (const [name, content, type] of examples) {
        const file = new File([content], name, { type });
        const result = await uploadSingleComposerFile({
          file,
          name,
          cwd: "/workspace",
          sessionId: sid,
          executionEngine: isCodex ? "codex" : "pi",
        });
        results.push(result);
      }

      assert.equal(mockUploads.length, examples.length);

      for (let i = 0; i < examples.length; i++) {
        const res = results[i];
        const [name, content] = examples[i];
        assert.equal(res.name, name);
        assert.equal(res.size, Buffer.byteLength(content));
        assert.equal(mockUploads[i].url.searchParams.get("sessionId"), sid);
        assert.equal(hash(mockUploads[i].bytes), hash(Buffer.from(content)));
        if (isCodex) {
          assert.match(res.serverRelativePath, /^\.pi-upload-/);
        } else {
          assert.match(res.serverRelativePath, /^\.pi-uploads\/\.pi-upload-/);
        }
      }

      // 序列化到消息体中：只包含引用，绝对不将大文件内容内联展开
      const message = appendFileAttachmentsToText("请读取附件", results);
      assert.ok(message.length < 1500, "消息长度必须简短，只包含引用 Marker");
      assert.equal(message.includes("FILE-CONTENT"), false, "大文件内容绝不内联展开进正文");
      assert.equal(message.includes("```"), false, "附件绝不展开为 Markdown 代码块");
      const markers = message.match(/\[附件: /g) || [];
      assert.equal(markers.length, examples.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("an upload error inside HTTP 207 never becomes a successful attachment or inline text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlObj = new URL(url, "http://127.0.0.1");
    if (urlObj.searchParams.get("type") === "upload-check") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ conflicts: [], nonReplaceable: [] }),
      };
    }
    return {
      ok: false,
      status: 207,
      json: async () => ({ uploaded: [], errors: [{ error: "工作区不可写 (HTTP 207)" }] }),
    };
  };

  try {
    const file = new File(["FILE-CONTENT".repeat(100)], "file.txt", { type: "text/plain" });
    await assert.rejects(
      async () => {
        await uploadSingleComposerFile({
          file,
          cwd: "/workspace",
          sessionId: "codex:session",
          executionEngine: "codex",
        });
      },
      /HTTP 207|工作区不可写/,
      "HTTP 207 必须严格拒绝并抛出异常，绝不允许假成功"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a new draft omits the fake draft id from engine routing and a disabled feature does no upload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = null;
  globalThis.fetch = async (url, options = {}) => {
    capturedUrl = new URL(url, "http://127.0.0.1");
    if (capturedUrl.searchParams.get("type") === "upload-check") {
      return { ok: true, status: 200, json: async () => ({ conflicts: [], nonReplaceable: [] }) };
    }
    const formData = options?.body;
    const uploadedName = formData?.get?.("files")?.name || "upload.bin";
    return {
      ok: true,
      status: 200,
      json: async () => ({ uploaded: [uploadedName], errors: [] }),
    };
  };

  try {
    const file = new File(["原始文件内容"], "new.txt", { type: "text/plain" });
    // 当未传入真实 sessionId 时，URL 参数中严禁携带伪造 sessionId
    await uploadSingleComposerFile({
      file,
      cwd: "/workspace",
      sessionId: undefined,
      executionEngine: "codex",
    });

    assert.ok(capturedUrl);
    assert.equal(capturedUrl.searchParams.has("sessionId"), false, "新草稿未确定 session 时不得传递假 sessionId");

    // 验证超限文件（超过 25MB）在客户端直接被拦截拒绝
    const oversizedFile = {
      name: "huge.bin",
      size: MAX_UPLOAD_FILE_BYTES + 1024,
      type: "application/octet-stream",
    };
    await assert.rejects(
      async () => {
        await uploadSingleComposerFile({
          file: oversizedFile,
          cwd: "/workspace",
        });
      },
      /超过单次上传上限/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex uses its existing workspace upload root without raw session IDs or a browser-local bridge", async () => {
  const prepared = await ensureUploadDirectory("/workspace", "codex:01901234-5678-7000-8000-000000000001", "codex");
  assert.equal(prepared.targetDir, "/workspace");
  assert.equal(prepared.relativeDir, "");

  const safeName = generateSafeUploadName("文档.txt");
  assert.match(safeName, /^\.pi-upload-/);
  assert.match(safeName, /文档\.txt$/);
});

test("a new Codex composer uses its engine hint before a session exists", async () => {
  const prepared = await ensureUploadDirectory("/workspace", undefined, "codex");
  assert.equal(prepared.targetDir, "/workspace");
  assert.equal(prepared.relativeDir, "");
});

test("browser E2E: pdf/docx/xlsx/zip/txt/mp3 paste uploads and renders card once", async () => {
  const formats = [
    { name: "clip.mp4", type: "video/mp4", content: "mp4-stream" },
    { name: "report.pdf", type: "application/pdf", content: "%PDF-data" },
    { name: "contract.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: "docx-data" },
    { name: "sheet.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: "xlsx-data" },
    { name: "archive.zip", type: "application/zip", content: "zip-data" },
    { name: "notes.txt", type: "text/plain", content: "notes-data" },
    { name: "audio.mp3", type: "audio/mpeg", content: "mp3-data" },
  ];

  let uploadCalls = 0;
  const { baseUrl, close } = await startNativeInputServer(async (req, res, url) => {
    if (url.pathname.startsWith("/api/files/")) {
      const type = url.searchParams.get("type");
      if (type === "upload-check") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ conflicts: [], nonReplaceable: [] }));
        return true;
      }
      if (type === "upload") {
        uploadCalls++;
        let rawBody = "";
        for await (const chunk of req) rawBody += chunk.toString("binary");
        const match = rawBody.match(/filename="([^"]+)"/);
        const name = match ? match[1] : "upload.bin";
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ uploaded: [name], errors: [] }));
        return true;
      }
    }
    return false;
  });

  try {
    await runBrowserTest({
      baseUrl,
      viewport: { width: 1024, height: 768 },
      testFn: async (page) => {
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearSentEvents();
          api.setMode("composer");
          api.setDraftKey("session-formats-test");
          api.setCwd("/workspace/test");
        });

        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 依次粘贴各格式文件，验证每个文件均成功触发上传并生成卡片
        for (let i = 0; i < formats.length; i++) {
          const item = formats[i];
          const prevUploadCount = uploadCalls;

          await page.evaluate((fmt) => {
            const ta = document.querySelector("textarea.chat-input-textarea");
            const file = new File([fmt.content], fmt.name, { type: fmt.type });
            const dt = new DataTransfer();
            dt.items.add(file);
            const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
            ta.dispatchEvent(ev);
          }, item);

          // 等待卡片数量增加为 i + 1
          await page.waitForFunction(
            (expectedCount) => document.querySelectorAll('[data-testid="composer-file-card"]').length === expectedCount,
            i + 1
          );

          // 等待最新卡片上传完成
          await page.waitForFunction(() => {
            const cards = document.querySelectorAll('[data-testid="composer-file-card"]');
            const last = cards[cards.length - 1];
            return last && !last.textContent.includes("上传中...");
          });

          assert.equal(uploadCalls, prevUploadCount + 1, `${item.name} 粘贴必须且仅调用 1 次 upload 接口`);
        }

        const finalCardCount = await page.locator('[data-testid="composer-file-card"]').count();
        assert.equal(finalCardCount, formats.length);
      },
    });
  } finally {
    await close();
  }
});

test("browser E2E: item-only clipboard, multiple files and intentional second paste preserve multiplicity", async () => {
  let uploadCalls = 0;
  const { baseUrl, close } = await startNativeInputServer(async (req, res, url) => {
    if (url.pathname.startsWith("/api/files/")) {
      const type = url.searchParams.get("type");
      if (type === "upload-check") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ conflicts: [], nonReplaceable: [] }));
        return true;
      }
      if (type === "upload") {
        uploadCalls++;
        let rawBody = "";
        for await (const chunk of req) rawBody += chunk.toString("binary");
        const match = rawBody.match(/filename="([^"]+)"/);
        const name = match ? match[1] : "upload.bin";
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ uploaded: [name], errors: [] }));
        return true;
      }
    }
    return false;
  });

  try {
    await runBrowserTest({
      baseUrl,
      viewport: { width: 1024, height: 768 },
      testFn: async (page) => {
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearSentEvents();
          api.setMode("composer");
          api.setDraftKey("session-multiplicity-test");
          api.setCwd("/workspace/test");
        });

        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 1. item-only clipboard: 剪贴板中只有 items 没有 files，单次粘贴 2 个文件
        await page.evaluate(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          const f1 = new File(["clip-data"], "clip.mp4", { type: "video/mp4" });
          const f2 = new File(["report-data"], "report.pdf", { type: "application/pdf" });

          const dt = new DataTransfer();
          dt.items.add(f1);
          dt.items.add(f2);
          // 模拟某些宿主环境下 dt.files 为只读空数组，仅保留 items
          Object.defineProperty(dt, "files", { value: [] });

          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        });

        // 等待 2 个卡片呈现并完成上传
        await page.waitForFunction(() => {
          const cards = document.querySelectorAll('[data-testid="composer-file-card"]');
          return cards.length === 2 && Array.from(cards).every((c) => !c.textContent.includes("上传中..."));
        });
        assert.equal(uploadCalls, 2, "item-only 多文件初次粘贴上传 2 个文件");

        // 2. intentional second paste: 故意再次粘贴相同文件 clip.mp4
        await page.evaluate(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          const f1 = new File(["clip-data"], "clip.mp4", { type: "video/mp4" });
          const dt = new DataTransfer();
          dt.items.add(f1);
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        });

        // 等待第 3 个卡片上传完成
        await page.waitForFunction(() => {
          const cards = document.querySelectorAll('[data-testid="composer-file-card"]');
          return cards.length === 3 && Array.from(cards).every((c) => !c.textContent.includes("上传中..."));
        });

        assert.equal(uploadCalls, 3, "二次故意粘贴相同文件发起第 3 次独立上传");
        const finalCardCount = await page.locator('[data-testid="composer-file-card"]').count();
        assert.equal(finalCardCount, 3, "multiplicity 严格保持，附件总数精确为 3");
      },
    });
  } finally {
    await close();
  }
});

test("browser E2E: markdown and file paste retain their own ownership", async () => {
  let fileUploadCalls = 0;
  const { baseUrl, close } = await startNativeInputServer(async (req, res, url) => {
    if (url.pathname.startsWith("/api/files/")) {
      const type = url.searchParams.get("type");
      if (type === "upload-check") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ conflicts: [], nonReplaceable: [] }));
        return true;
      }
      if (type === "upload") {
        fileUploadCalls++;
        let rawBody = "";
        for await (const chunk of req) rawBody += chunk.toString("binary");
        const match = rawBody.match(/filename="([^"]+)"/);
        const name = match ? match[1] : "upload.bin";
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ uploaded: [name], errors: [] }));
        return true;
      }
    }
    return false;
  });

  try {
    await runBrowserTest({
      baseUrl,
      viewport: { width: 1024, height: 768 },
      testFn: async (page) => {
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearSentEvents();
          api.setMode("composer");
          api.setDraftKey("session-markdown-isolation");
          api.setCwd("/workspace/test");
        });

        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 1. 粘贴富文本带链接：验证转换为 Markdown 格式，绝不调用文件 upload
        await page.evaluate(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          const dt = new DataTransfer();
          dt.setData("text/html", '<a href="https://example.com/docs">帮助文档</a>');
          dt.setData("text/plain", "帮助文档");
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        });

        // 验证输入框内被填充了 Markdown 链接
        await page.waitForFunction(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          return ta && ta.value.includes("[帮助文档](https://example.com/docs)");
        });
        assert.equal(fileUploadCalls, 0, "纯链接粘贴绝不调用文件 upload 接口");

        // 2. 粘贴文件：验证进入文件上传通道
        await page.evaluate(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          const f = new File(["content"], "readme.txt", { type: "text/plain" });
          const dt = new DataTransfer();
          dt.items.add(f);
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        });

        // 等待卡片生成并完成上传
        await page.waitForFunction(() => {
          const card = document.querySelector('[data-testid="composer-file-card"]');
          return card && !card.textContent.includes("上传中...");
        });
        assert.equal(fileUploadCalls, 1, "文件粘贴必须正常进入文件上传通道");
      },
    });
  } finally {
    await close();
  }
});
