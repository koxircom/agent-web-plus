import test from "node:test";
import assert from "node:assert/strict";
import { startNativeInputServer, runBrowserTest } from "./fixtures/native-input-browser.mjs";

test("composer filepaste: 207失败判定、重复事件单次上传、失败retry不丢、换session晚返回不串 (移动 390 与 桌面 1124)", async () => {
  let uploadStatus = 207;
  let uploadCalls = 0;
  let slowUploadDelay = 0;
  const recordedUploads = [];

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
        recordedUploads.push({
          sessionId: url.searchParams.get("sessionId"),
          time: Date.now(),
        });

        let rawBody = "";
        for await (const chunk of req) {
          rawBody += chunk.toString("binary");
        }

        if (slowUploadDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, slowUploadDelay));
        }

        res.statusCode = uploadStatus;
        res.setHeader("Content-Type", "application/json");
        if (uploadStatus === 207) {
          res.end(JSON.stringify({ uploaded: [], errors: [{ error: "上传失败 (HTTP 207)" }] }));
        } else {
          // 精准提取 multipart 中的 safeUploadName，满足 includes(safeUploadName) 校验
          const match = rawBody.match(/filename="([^"]+)"/);
          const uploadedName = match ? match[1] : "upload.bin";
          res.end(JSON.stringify({ uploaded: [uploadedName], errors: [] }));
        }
        return true;
      }
    }
    if (url.pathname.startsWith("/api/cwd/browse")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  });

  try {
    // 1. 移动端 (390x844): HTTP 207判定失败、防重复单次上传、以及失败后retry不丢
    await runBrowserTest({
      baseUrl,
      viewport: { width: 390, height: 844 },
      testFn: async (page) => {
        uploadStatus = 207;
        uploadCalls = 0;

        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearSentEvents();
          api.setMode("composer");
          api.setDraftKey("session-paste-mobile");
          api.setCwd("/workspace/test");
        });

        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 模拟粘贴一个文件
        await page.evaluate(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          const file = new File(["specification-content"], "spec.txt", { type: "text/plain" });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        });

        // 验证卡片呈现，且 HTTP 207 判定为失败
        const card = page.locator('[data-testid="composer-file-card"]').first();
        await card.waitFor();

        await page.waitForFunction(() => {
          const c = document.querySelector('[data-testid="composer-file-card"]');
          return Boolean(c && c.textContent && c.textContent.includes("HTTP 207"));
        });

        const cardText = await card.innerText();
        assert.match(cardText, /spec\.txt/);
        assert.match(cardText, /HTTP 207/);
        assert.equal(uploadCalls, 1, "初次粘贴必须单次上传，upload 接口只调用 1 次");

        // 验证失败重试 (retry 不丢)
        uploadStatus = 200; // 切换为正常成功

        const retryBtn = card.locator('button[title="重试上传"]');
        await retryBtn.waitFor();
        await retryBtn.click();

        // 等待重试完成 (接口被调用且卡片转为正常已上传)
        await page.waitForFunction(() => {
          const c = document.querySelector('[data-testid="composer-file-card"]');
          const btn = document.querySelector('button[title="重试上传"]');
          return Boolean(c && !btn && !c.textContent.includes("上传中...") && !c.textContent.includes("HTTP 207"));
        });

        // 验证原文件名依然保留且调用了第 2 次上传
        const recoveredText = await card.innerText();
        assert.match(recoveredText, /spec\.txt/);
        assert.equal(uploadCalls, 2, "重试时直接复用原文件发起第 2 次上传");
      },
    });

    // 2. 桌面端 (1124x768): 换 session 晚返回不串
    await runBrowserTest({
      baseUrl,
      viewport: { width: 1124, height: 768 },
      testFn: async (page) => {
        uploadStatus = 200;
        slowUploadDelay = 400; // 模拟 400ms 慢速上传
        uploadCalls = 0;

        // 设置当前会话为 Session A
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.setMode("composer");
          api.setDraftKey("session-flow-A");
          api.setCwd("/workspace/test");
        });

        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 在 Session A 中触发粘贴上传
        await page.evaluate(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          const file = new File(["session-A-data"], "sessionA-report.pdf", { type: "application/pdf" });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        });

        // 上传还在慢速进行中时，用户快速切换会话到 Session B
        await page.waitForTimeout(50);
        await page.evaluate(() => {
          window.__NATIVE_INPUT_API__.setDraftKey("session-flow-B");
        });

        // 等待慢速上传在服务端完成
        await page.waitForTimeout(500);

        // 核心断言: Session B 的当前输入区附件卡片必须为 0，绝对不能串入 Session A 的晚返回文件！
        const sessionBCardCount = await page.locator('[data-testid="composer-file-card"]').count();
        assert.equal(sessionBCardCount, 0, "会话 B 严禁受到会话 A 晚返回文件的污染，附件数必须为 0");

        // 恢复正常延迟
        slowUploadDelay = 0;
      },
    });
  } finally {
    await close();
  }
});
