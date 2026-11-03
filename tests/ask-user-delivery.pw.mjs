import test from "node:test";
import assert from "node:assert/strict";
import { startNativeInputServer, runBrowserTest } from "./fixtures/native-input-browser.mjs";

test("AskUser 确认 delivery 失败保留 + session 切换隔离 / 重复确认不双发 (移动 390 与 桌面 1124)", async () => {
  const { baseUrl, close } = await startNativeInputServer();

  try {
    // 1. 移动端 (390x844): delivery 失败回答保留，以及重复确认防抖不双发
    await runBrowserTest({
      baseUrl,
      viewport: { width: 390, height: 844 },
      testFn: async (page) => {
        // 设置模式为 ask-user
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearAskUserEvents();
          api.setMode("ask-user");
          api.setDraftKey("session-mobile-ask");
          api.setAskUserProps({
            request: {
              type: "extension_ui_request",
              id: "ask-req-1",
              method: "custom",
              lines: [],
            },
            question: {
              toolCallId: "ask-req-1",
              question: "请选择发布确认方式",
              options: [{ title: "全量上线" }, { title: "灰度发布" }],
              allowFreeform: true,
            },
            respondResult: "throw", // 模拟 delivery 异常
          });
        });

        const card = page.locator("section.pi-native-ask-card");
        await card.waitFor();

        // 验证自定义回答输入框
        const notesInput = page.locator("input.pi-native-ask-input, input[aria-label='自定义回答']").first();
        await notesInput.waitFor();
        const customAnswer = "因依赖未完全冻结，先保持灰度部署，待明日复查";
        await notesInput.fill(customAnswer);

        // 点击发送按钮
        const submitBtn = page.locator("button.pi-native-ask-submit");
        await submitBtn.waitFor();
        await submitBtn.click();

        // 等待错误提示出现
        await page.waitForFunction(() => {
          const hint = document.querySelector(".pi-native-ask-hint");
          return Boolean(hint && hint.textContent && (hint.textContent.includes("未确认送达") || hint.textContent.includes("失败")));
        });

        // 核心断言 1: delivery 失败后，用户输入的内容依然保留在组件中，未被清空
        const retainedValue = await notesInput.inputValue();
        assert.equal(retainedValue, customAnswer);

        // 核心断言 2: 重复确认防抖不双发
        // 设置慢响应模式
        await page.evaluate(() => {
          window.__NATIVE_INPUT_API__.clearAskUserEvents();
          window.__NATIVE_INPUT_API__.setAskUserProps({
            respondResult: "slow",
          });
        });

        // 第一次点击发送
        await submitBtn.click();

        // 紧接着连续快速点击 2 次
        try {
          await submitBtn.click({ timeout: 500, force: true });
          await submitBtn.click({ timeout: 500, force: true });
        } catch {
          // 按钮因 busy/disabled 可能拒绝点击或被捕获
        }

        // 验证在慢速等待中只发出了 1 次提交请求
        const inFlightEvents = await page.evaluate(() => window.__NATIVE_INPUT_API__.getAskUserEvents());
        assert.equal(inFlightEvents.length, 1, "重复快速点击必须被防抖拦截，只发出 1 次网络 delivery");

        // 解决慢速等待
        await page.evaluate(() => {
          window.__NATIVE_INPUT_API__.resolveSlowDelivery();
        });
      },
    });

    // 2. 桌面端 (1124x768): session 切换隔离
    await runBrowserTest({
      baseUrl,
      viewport: { width: 1124, height: 768 },
      testFn: async (page) => {
        // 配置 Session A 的提问
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.clearAskUserEvents();
          api.setMode("ask-user");
          api.setDraftKey("session-desktop-A");
          api.setAskUserProps({
            request: {
              type: "extension_ui_request",
              id: "req-session-A",
              method: "custom",
              lines: [],
            },
            question: {
              toolCallId: "req-session-A",
              question: "会话 A 专有提问：是否回滚数据库？",
              options: [{ title: "是" }, { title: "否" }],
              allowFreeform: true,
            },
            respondResult: true,
          });
        });

        const card = page.locator("section.pi-native-ask-card");
        await card.waitFor();
        await page.getByRole("heading", { name: "会话 A 专有提问：是否回滚数据库？" }).waitFor();

        // 切换到 Session B
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.setDraftKey("session-desktop-B");
          api.setAskUserProps({
            request: {
              type: "extension_ui_request",
              id: "req-session-B",
              method: "custom",
              lines: [],
            },
            question: {
              toolCallId: "req-session-B",
              question: "会话 B 专有提问：是否执行批量清理？",
              options: [{ title: "确认清理" }, { title: "取消" }],
              allowFreeform: false,
            },
            respondResult: true,
          });
        });

        // 断言 Session B 呈现自己的独立问题
        await page.getByRole("heading", { name: "会话 B 专有提问：是否执行批量清理？" }).waitFor();
        assert.equal(await page.getByRole("heading", { name: "会话 A 专有提问：是否回滚数据库？" }).count(), 0);

        // 再次切回 Session A
        await page.evaluate(() => {
          const api = window.__NATIVE_INPUT_API__;
          api.setDraftKey("session-desktop-A");
          api.setAskUserProps({
            request: {
              type: "extension_ui_request",
              id: "req-session-A",
              method: "custom",
              lines: [],
            },
            question: {
              toolCallId: "req-session-A",
              question: "会话 A 专有提问：是否回滚数据库？",
              options: [{ title: "是" }, { title: "否" }],
              allowFreeform: true,
            },
            respondResult: true,
          });
        });

        // 断言 Session A 提问正确呈现，完全隔离
        await page.getByRole("heading", { name: "会话 A 专有提问：是否回滚数据库？" }).waitFor();
        assert.equal(await page.getByRole("heading", { name: "会话 B 专有提问：是否执行批量清理？" }).count(), 0);
      },
    });
  } finally {
    await close();
  }
});
