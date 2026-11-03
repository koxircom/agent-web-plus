import test from "node:test";
import assert from "node:assert/strict";
import { startNativeInputServer, runBrowserTest } from "./fixtures/native-input-browser.mjs";

test("suggestion 真实接受并提交一次，流中 steer vs followup 正确 (移动 390 与 桌面 1124)", async () => {
  const { baseUrl, close } = await startNativeInputServer();

  try {
    // 1. 移动端 (390x844): suggestion 真实展示、Tab/采纳及单次提交
    await runBrowserTest({
      baseUrl,
      viewport: { width: 390, height: 844 },
      testFn: async (page) => {
        const suggestionText = "帮我检查当前所有改动的测试覆盖率";

        // 设置 inlineSuggestion 与 draftKey
        await page.evaluate((text) => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearSentEvents();
          api.setIsStreaming(false);
          api.setDraftKey("session-mobile-1");
          api.setInlineSuggestion({
            id: "sug-entry-1",
            sessionId: "session-mobile-1",
            text,
          });
        }, suggestionText);

        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 验证 suggestion 属性已附着
        await page.waitForFunction(() => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          return Boolean(ta && ta.getAttribute("data-pi-inline-suggestion"));
        });

        // 采纳建议 (按下 Tab 键)
        await textarea.focus();
        await page.keyboard.press("Tab");

        // 验证输入框填入建议内容，且 suggestion 标记已消费
        await page.waitForFunction((text) => {
          const ta = document.querySelector("textarea.chat-input-textarea");
          return ta && ta.value === text && !ta.getAttribute("data-pi-inline-suggestion");
        }, suggestionText);

        const currentVal = await textarea.inputValue();
        assert.equal(currentVal, suggestionText);

        // 点击发送按钮
        const sendBtn = page.locator("button.pi-enh-cursor-send, button.chat-input-send-button");
        await sendBtn.first().click();

        // 验证提交记录：恰好 1 次提交，绝不双发
        await page.waitForFunction(() => {
          return window.__NATIVE_INPUT_API__.getSentEvents().length === 1;
        });

        const events = await page.evaluate(() => window.__NATIVE_INPUT_API__.getSentEvents());
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "send");
        assert.equal(events[0].message, suggestionText);
      },
    });

    // 2. 桌面端 (1124x768): 流式中 (isStreaming: true) steer 与 followup 队列分流
    await runBrowserTest({
      baseUrl,
      viewport: { width: 1124, height: 768 },
      testFn: async (page) => {
        const textarea = page.locator("textarea.chat-input-textarea");
        await textarea.waitFor();

        // 开启流式状态
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearSentEvents();
          api.setInlineSuggestion(null);
          api.setDraftKey("session-desktop-1");
          api.setIsStreaming(true);
        });

        // 测试 steer 引导流
        const steerMsg = "优先处理高优先级错误";
        await textarea.fill(steerMsg);

        const steerBtn = page.locator('button[aria-label="将消息加入引导队列"]');
        await steerBtn.waitFor();
        await steerBtn.click();

        await page.waitForFunction(() => {
          const evts = window.__NATIVE_INPUT_API__.getSentEvents();
          return evts.some((e) => e.type === "steer");
        });

        let events = await page.evaluate(() => window.__NATIVE_INPUT_API__.getSentEvents());
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "steer");
        assert.equal(events[0].message, steerMsg);

        // 测试 followup 后续流
        const followupMsg = "在当前阶段完成后再执行补充回归";
        await textarea.fill(followupMsg);

        const followupBtn = page.locator("button.pi-enh-cursor-followup");
        await followupBtn.waitFor();
        await followupBtn.click();

        await page.waitForFunction(() => {
          const evts = window.__NATIVE_INPUT_API__.getSentEvents();
          return evts.some((e) => e.type === "followup");
        });

        events = await page.evaluate(() => window.__NATIVE_INPUT_API__.getSentEvents());
        assert.equal(events.length, 2);
        assert.equal(events[1].type, "followup");
        assert.equal(events[1].message, followupMsg);
      },
    });
  } finally {
    await close();
  }
});
