"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadPlaywrightChromium() {
  for (const modName of ["playwright", "playwright-core"]) {
    try {
      const mod = require(modName);
      if (mod && mod.chromium) {
        return mod.chromium;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("Playwright (playwright or playwright-core) is required to run browser regression tests.");
}

function resolveChromiumLaunchOptions(chromium) {
  const baseOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };

  const envCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ].filter(Boolean);

  for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) {
      return { ...baseOptions, executablePath: candidate };
    }
  }

  if (typeof chromium.executablePath === "function") {
    try {
      const pwExec = chromium.executablePath();
      if (pwExec && fs.existsSync(pwExec)) {
        return { ...baseOptions, executablePath: pwExec };
      }
    } catch {
      // fall through to system browser candidates
    }
  }

  const systemCandidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ];
  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) {
      return { ...baseOptions, executablePath: candidate };
    }
  }

  return baseOptions;
}

const MODULES_DIR = path.resolve(__dirname, "..", "modules");
const MANIFEST_PATH = path.join(MODULES_DIR, "manifest.json");

function buildInMemoryBundleFromModules() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const parts = manifest.modules.map((mod) =>
    fs.readFileSync(path.join(MODULES_DIR, mod.file), "utf8")
  );
  const icons = require("../../lib/composer-mode-icons.json");
  const markup = Object.fromEntries(Object.entries(icons).map(([mode, paths]) => [mode,
    '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths.map(d => `<path d="${d}" />`).join("") + "</g>"
  ]));
  const ledger = fs.readFileSync(path.resolve(__dirname, "../usage-ledger-core.js"), "utf8");
  return `var COMPOSER_MODE_ICON_MARKUP = ${JSON.stringify(markup)};\n${ledger}\n` + parts.join("");
}

test("live-stopwatch in real Chromium: mixed user DOM order, missing footer fallback, recovery to native footer, disable/stop cleanup, and zero historical pollution", async () => {
  const chromium = loadPlaywrightChromium();
  const bundleCode = buildInMemoryBundleFromModules();

  const browser = await chromium.launch(resolveChromiumLaunchOptions(chromium));

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    await context.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      const parsed = new URL(reqUrl);
      if (parsed.hostname === "pi-test.local" && parsed.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Pi Web Test</title>
  <style>
    :root {
      --user-bg: #1e293b;
      --bg-user: #1e293b;
      --text: #f8fafc;
      --text-dim: #94a3b8;
      --text-muted: #94a3b8;
      --border: #334155;
      --bg: #0f172a;
      --chat-content-max-width: 820px;
    }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: sans-serif; }
  </style>
</head>
<body>
  <div class="chat-content" style="display: flex; flex-direction: column; height: 100vh;">
    <div class="overflow-y-auto" style="flex: 1; overflow-y: auto; padding-top: 16px;">
      <div style="min-width: 0; padding: 0 16px;">
        <div id="chat-message-list" style="width: 100%; min-width: 0; max-width: var(--chat-content-max-width, 820px); margin: 0 auto;">
          <!-- 1. 历史用户消息 u1：仅有 var(--user-bg) 气泡，初始无 data-message-role="user" -->
          <div id="entry-u1" data-entry-id="entry-u1" data-message-role="user">
            <div style="margin-bottom: 16px; display: flex; flex-direction: column; align-items: flex-end;">
              <div style="display: flex; align-items: flex-end; gap: 6px; max-width: 85%;">
                <div style="background: var(--user-bg); border-radius: 12px; padding: 8px 12px;">历史提问 1</div>
              </div>
            </div>
          </div>

          <!-- 2. 历史已完成助手消息 a1：带原生 footer 与已完成耗时徽章 -->
          <div id="entry-a1" data-entry-id="entry-a1">
            <div id="msg-a1" data-message-role="assistant" data-entry-id="entry-a1" data-pi-enh-completed="true" style="margin-bottom: 16px;">
              <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                <span>GPT-5.6</span>
              </div>
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <div data-message-text="true">历史回答 1</div>
              </div>
              <div id="footer-a1" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                <div style="font-size: 11px; color: var(--text-dim);">1.2k tokens</div>
                <div class="pi-enh-duration-badge" title="任务执行总耗时" data-total-sec="12" data-active-sec="12" style="margin-left: auto; margin-right: 4px;">⏱️ 12s</div>
                <span data-pi-enh-timestamp="true" style="font-size: 10px; color: var(--text-dim);">11:58</span>
              </div>
            </div>
          </div>

          <!-- 3. 最新用户消息 u2：显式带 data-message-role="user"（测试混合 user DOM 顺序） -->
          <div id="entry-u2" data-entry-id="entry-u2" data-message-role="user" style="margin-bottom: 16px; display: flex; flex-direction: column; align-items: flex-end;">
            <div style="display: flex; align-items: flex-end; gap: 6px; max-width: 85%;">
              <div style="background: var(--user-bg); border-radius: 12px; padding: 8px 12px;">最新提问 2：执行 edit 修改</div>
            </div>
          </div>

          <!-- 4. 当前回合进行中的助手消息 a2：仅有 edit 工具卡与纵向 gap: 8px 块容器，无原生 footer -->
          <div id="entry-a2" data-entry-id="entry-a2">
            <div id="msg-a2" data-message-role="assistant" data-entry-id="entry-a2" style="margin-bottom: 16px;">
              <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                <span>Gemini 3.8 Flash High</span>
              </div>
              <div id="blocks-a2" style="display: flex; flex-direction: column; gap: 8px;">
                <div id="edit-card-a2" style="border-radius: 7px; overflow: hidden; font-size: 12px; border: 1px solid rgba(34,197,94,0.25); background: rgba(34,197,94,0.04);">
                  <div style="display: flex; align-items: stretch; min-width: 0;">
                    <button type="button" style="display: flex; align-items: center; gap: 7px; flex: 1; padding: 6px 10px; background: none; border: none; color: var(--text-muted);">
                      <span style="color: #16a34a; font-weight: 600;">edit</span>
                      <span>06-chat-view-and-tool-cards.js</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div id="prompt-anchor-spacer" aria-hidden="true"></div>
        </div>
      </div>
    </div>

    <!-- 底部输入区与可见的停止按钮 -->
    <div class="relative shrink-0" style="padding: 12px 16px;">
      <fieldset style="border: none; margin: 0; padding: 0;">
        <div style="max-width: 820px; margin: 0 auto; display: flex; align-items: center; gap: 8px;">
          <textarea placeholder="引导或排队消息..."></textarea>
          <button id="active-stop-btn" type="button" title="停止 Agent" aria-label="停止 Agent">停止</button>
        </div>
      </fieldset>
    </div>
  </div>
</body>
</html>`,
        });
        return;
      }

      if (parsed.pathname.startsWith("/api/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessions: [],
            runningSessionIds: ["live-stopwatch-test"],
            context: { messages: [], entryIds: [] },
          }),
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
    });

    const page = await context.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto("http://pi-test.local/?session=live-stopwatch-test", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: bundleCode });

    if(errors.length) throw Error(errors.join("; "));
    // 等待一个秒表周期（400ms）触发 tickLiveDuration
    await page.waitForTimeout(550);

    // =========================================================================
    // 1. 验证混合 user DOM 顺序 + 进行中 edit 卡无原生 footer 时的尾部可见兜底 + 无历史污染
    // =========================================================================
    const step1 = await page.evaluate(() => {
      const allTimers = Array.from(document.querySelectorAll(".pi-enh-live-timer"));
      const fallbacks = Array.from(document.querySelectorAll('[data-pi-enh-live-fallback="true"]'));
      const histMsg = document.getElementById("msg-a1");
      const histBadge = histMsg?.querySelector(".pi-enh-duration-badge");
      const activeMsg = document.getElementById("msg-a2");
      const blocksA2 = document.getElementById("blocks-a2");
      const editCard = document.getElementById("edit-card-a2");
      const u1 = document.getElementById("entry-u1");
      const u2 = document.getElementById("entry-u2");

      const timer = allTimers[0] || null;
      const timerRect = timer ? timer.getBoundingClientRect() : null;
      const editRect = editCard ? editCard.getBoundingClientRect() : null;

      return {
        isRunning: window.__PI_ENH_IS_LIVE_RUNNING__?.("live-stopwatch-test"),
        timerCount: allTimers.length,
        timerText: timer ? timer.textContent : null,
        fallbackCount: fallbacks.length,
        timerInActiveMsg: Boolean(activeMsg && timer && activeMsg.contains(timer)),
        timerInFallback: Boolean(fallbacks[0] && timer && fallbacks[0].contains(timer)),
        timerInsideBlocksColumn: Boolean(blocksA2 && timer && blocksA2 === timer.parentElement),
        histHasLiveTimer: Boolean(histMsg?.querySelector(".pi-enh-live-timer")),
        histDurationSec: histBadge?.getAttribute("data-total-sec"),
        u1MarkedUser: u1?.getAttribute("data-message-role") === "user",
        timerFollowsU2: Boolean(u2 && timer && (u2.compareDocumentPosition(timer) & Node.DOCUMENT_POSITION_FOLLOWING)),
        timerRect: timerRect ? { x: timerRect.x, y: timerRect.y, width: timerRect.width, height: timerRect.height, top: timerRect.top, bottom: timerRect.bottom } : null,
        editRect: editRect ? { x: editRect.x, y: editRect.y, width: editRect.width, height: editRect.height, top: editRect.top, bottom: editRect.bottom } : null,
      };
    });

    assert.equal(step1.isRunning, true, "Session must be detected as live running");
    assert.equal(step1.u1MarkedUser, true, "Native user message u1 must retain data-message-role='user'");
    assert.equal(step1.timerCount, 1, "Must render exactly 1 live stopwatch timer");
    assert.match(step1.timerText || "", /^⏱️ 运行中 [\d.]+s$/, "Live timer text must match '⏱️ 运行中 Xs'");
    assert.equal(step1.fallbackCount, 1, "Must mount 1 fallback footer container when active assistant message has no native footer");
    assert.equal(step1.timerInActiveMsg, true, "Live timer must be anchored inside the active assistant message");
    assert.equal(step1.timerInFallback, true, "Live timer must be inside the fallback footer container");
    assert.equal(step1.timerInsideBlocksColumn, false, "Live timer must never mis-attach to the flex-direction:column blocks container");
    assert.equal(step1.histHasLiveTimer, false, "Historical assistant message a1 must never receive a live timer");
    assert.equal(step1.histDurationSec, "12", "Historical assistant badge must remain untouched");
    assert.equal(step1.timerFollowsU2, true, "Live timer must strictly follow the latest user message u2 in DOM order");
    assert.ok(step1.timerRect && step1.timerRect.width > 0 && step1.timerRect.height > 0, "Live timer must be visibly rendered with non-zero bounding box");
    assert.ok(step1.editRect && step1.timerRect.top >= step1.editRect.bottom, `Live timer (${step1.timerRect.top}) must be positioned below edit card (${step1.editRect.bottom}) without overlap`);

    // New agent run must not inherit the preceding turn's authoritative clock.
    const turnBoundary = await page.evaluate(() => {
      const sid = "live-stopwatch-test";
      const oldStart = Date.now() - (18 * 60 + 45) * 1000;
      window.__PI_ENH_RECORD_ACTIVE_TURN_START__(sid, oldStart, "entry-u1", true);
      window.__PI_ENH_RECORD_ACTIVE_TURN_START__(sid, Date.now(), null, false);
      const rejectedBeforeStart = window.__PI_ENH_GET_ACTIVE_TURN_START__(sid);
      window.__PI_ENH_HANDLE_MODEL_SPEED_STREAM_EVENT__(sid, { type: "agent_start" });
      const newStart = window.__PI_ENH_GET_ACTIVE_TURN_START__(sid);
      window.__PI_ENH_RECORD_ACTIVE_TURN_START__(sid, Date.now() + 1000, null, false);
      const afterSteering = window.__PI_ENH_GET_ACTIVE_TURN_START__(sid);
      return { oldStart, rejectedBeforeStart, newStart, afterSteering, now: Date.now() };
    });
    assert.equal(turnBoundary.rejectedBeforeStart, turnBoundary.oldStart, "Old authoritative turn must reproduce the reported 18-minute clock before agent_start");
    assert.ok(turnBoundary.newStart > turnBoundary.oldStart && turnBoundary.now - turnBoundary.newStart < 2000,
      "agent_start must reset the running clock to this new run");
    assert.equal(turnBoundary.afterSteering, turnBoundary.newStart, "Steering within one run must preserve its start time");
    await page.waitForFunction(() => /^⏱️ 运行中 [\d.]+s$/.test(document.querySelector(".pi-enh-live-timer")?.textContent || ""), undefined, { timeout: 1800 });
    const historicalTimerCount = await page.evaluate(() => document.getElementById("msg-a1")?.querySelectorAll(".pi-enh-live-timer").length);
    assert.equal(historicalTimerCount, 0, "New turn must not attach its stopwatch to historical assistant messages");

    // =========================================================================
    // 2. 验证连活跃 assistant 消息都尚未生成（仅有最新 user 消息 + 聊天区尾部）时的聊天区尾部可见兜底
    // =========================================================================
    await page.evaluate(() => {
      document.getElementById("entry-a2")?.remove();
    });
    await page.waitForTimeout(500);

    const step2 = await page.evaluate(() => {
      const allTimers = Array.from(document.querySelectorAll(".pi-enh-live-timer"));
      const fallbacks = Array.from(document.querySelectorAll('[data-pi-enh-live-fallback="true"]'));
      const histMsg = document.getElementById("msg-a1");
      const u2 = document.getElementById("entry-u2");
      const spacer = document.getElementById("prompt-anchor-spacer");
      const timer = allTimers[0] || null;
      const timerRect = timer ? timer.getBoundingClientRect() : null;
      const u2Rect = u2 ? u2.getBoundingClientRect() : null;

      return {
        timerCount: allTimers.length,
        fallbackCount: fallbacks.length,
        histHasLiveTimer: Boolean(histMsg?.querySelector(".pi-enh-live-timer")),
        timerFollowsU2: Boolean(u2 && timer && (u2.compareDocumentPosition(timer) & Node.DOCUMENT_POSITION_FOLLOWING)),
        fallbackBeforeSpacer: Boolean(fallbacks[0] && spacer && fallbacks[0].nextElementSibling === spacer),
        timerRect: timerRect ? { top: timerRect.top, width: timerRect.width, height: timerRect.height } : null,
        u2Rect: u2Rect ? { bottom: u2Rect.bottom } : null,
      };
    });

    assert.equal(step2.timerCount, 1, "Must keep exactly 1 live timer at chat tail even when no active assistant node exists yet");
    assert.equal(step2.fallbackCount, 1, "Must have 1 chat-tail fallback container");
    assert.equal(step2.histHasLiveTimer, false, "Historical assistant message a1 must never be polluted when active turn has no assistant node");
    assert.equal(step2.timerFollowsU2, true, "Chat-tail fallback timer must follow latest user message u2");
    assert.equal(step2.fallbackBeforeSpacer, true, "Chat-tail fallback must sit immediately before promptAnchorSpacer");
    assert.ok(step2.timerRect && step2.timerRect.width > 0 && step2.timerRect.height > 0, "Chat-tail fallback timer must be visible");
    assert.ok(step2.u2Rect && step2.timerRect.top >= step2.u2Rect.bottom, "Chat-tail fallback timer must sit below latest user message u2");

    // =========================================================================
    // 3. 验证由缺失恢复：当活跃 assistant 消息及原生 footer 渲染出现后，自动迁移至原生 footer 并移除兜底容器
    // =========================================================================
    await page.evaluate(() => {
      const list = document.getElementById("chat-message-list");
      const spacer = document.getElementById("prompt-anchor-spacer");
      const entryA2 = document.createElement("div");
      entryA2.id = "entry-a2";
      entryA2.setAttribute("data-entry-id", "entry-a2");
      entryA2.innerHTML = `
        <div id="msg-a2" data-message-role="assistant" data-entry-id="entry-a2" style="margin-bottom: 16px;">
          <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
            <span>Gemini 3.8 Flash High</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div data-message-text="true">已完成工具调用并输出回复</div>
          </div>
          <div id="native-footer-a2" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
            <span id="ts-a2" data-pi-enh-timestamp="true" style="font-size: 10px; color: var(--text-dim); margin-left: auto;">12:01</span>
          </div>
        </div>
      `;
      list.insertBefore(entryA2, spacer);
    });
    await page.waitForTimeout(500);

    const step3 = await page.evaluate(() => {
      const allTimers = Array.from(document.querySelectorAll(".pi-enh-live-timer"));
      const fallbacks = Array.from(document.querySelectorAll('[data-pi-enh-live-fallback="true"]'));
      const nativeFooter = document.getElementById("native-footer-a2");
      const ts = document.getElementById("ts-a2");
      const timer = allTimers[0] || null;

      return {
        timerCount: allTimers.length,
        fallbackCount: fallbacks.length,
        inNativeFooter: Boolean(nativeFooter && timer && nativeFooter.contains(timer)),
        anchoredBeforeTimestamp: Boolean(timer && ts && timer.nextElementSibling === ts),
      };
    });

    assert.equal(step3.timerCount, 1, "Must still have exactly 1 live timer after recovery");
    assert.equal(step3.fallbackCount, 0, "Fallback container must be immediately removed once native footer is available");
    assert.equal(step3.inNativeFooter, true, "Live timer must migrate into the native assistant footer");
    assert.equal(step3.anchoredBeforeTimestamp, true, "Live timer must be anchored immediately before the timestamp span in native footer");

    // =========================================================================
    // 4. 验证禁用/关闭 live-stopwatch 插件时立即清理（包括 fallback 态下禁用）
    // =========================================================================
    await page.evaluate(() => {
      // 先移除原生 footer 回到 fallback 态，再测试关闭插件时是否连同 fallback 一起同步清理
      document.getElementById("native-footer-a2")?.remove();
    });
    await page.waitForTimeout(500);

    const beforeDisable = await page.evaluate(() => ({
      timers: document.querySelectorAll(".pi-enh-live-timer").length,
      fallbacks: document.querySelectorAll('[data-pi-enh-live-fallback="true"]').length,
    }));
    assert.equal(beforeDisable.timers, 1);
    assert.equal(beforeDisable.fallbacks, 1);

    const afterDisableImmediate = await page.evaluate(() => {
      window.__PI_ENH_SET_PLUGIN__("live-stopwatch", false);
      return {
        timers: document.querySelectorAll(".pi-enh-live-timer").length,
        fallbacks: document.querySelectorAll('[data-pi-enh-live-fallback="true"]').length,
      };
    });
    assert.equal(afterDisableImmediate.timers, 1, "The live stopwatch remains active as a core feature");
    assert.equal(afterDisableImmediate.fallbacks, 1, "The active stopwatch keeps its fallback container");

    // 重新开启插件，验证恢复显示
    await page.evaluate(() => {
      window.__PI_ENH_SET_PLUGIN__("live-stopwatch", true);
    });
    await page.waitForTimeout(500);
    const afterReEnable = await page.evaluate(() => ({
      timers: document.querySelectorAll(".pi-enh-live-timer").length,
      fallbacks: document.querySelectorAll('[data-pi-enh-live-fallback="true"]').length,
    }));
    assert.equal(afterReEnable.timers, 1, "Re-enabling live-stopwatch while running must restore live timer");
    assert.equal(afterReEnable.fallbacks, 1, "Re-enabling live-stopwatch without native footer must restore fallback container");

    // =========================================================================
    // 5. 验证会话切换导航立即清理 + 任务结束时立即清理且绝不误计历史旧轮次
    // =========================================================================
    const afterNavCleanup = await page.evaluate(() => {
      window.history.pushState({}, "", "?session=navigated-session");
      window.dispatchEvent(new PopStateEvent("popstate"));
      // 切回原会话继续验证结束清理
      window.history.pushState({}, "", "?session=live-stopwatch-test");
      return {
        timersAfterNav: document.querySelectorAll(".pi-enh-live-timer").length,
        fallbacksAfterNav: document.querySelectorAll('[data-pi-enh-live-fallback="true"]').length,
      };
    });
    assert.equal(afterNavCleanup.timersAfterNav, 0, "Session navigation must immediately clean up live timers");
    assert.equal(afterNavCleanup.fallbacksAfterNav, 0, "Session navigation must immediately clean up fallback containers");

    await page.waitForTimeout(500);
    await page.evaluate(() => {
      // 移除当前回合的 entry-a2（模拟当前回合尚未产生最终助手消息即停止），并结束运行态
      document.getElementById("entry-a2")?.remove();
      document.getElementById("active-stop-btn")?.remove();
      const ta = document.querySelector("textarea");
      if (ta) ta.setAttribute("placeholder", "输入消息...");
    });

    // 等待超过 2 个 tick（>800ms），跨过完成态结算防抖点
    await page.waitForTimeout(1000);

    const step5 = await page.evaluate(() => {
      const histMsg = document.getElementById("msg-a1");
      const histBadge = histMsg?.querySelector(".pi-enh-duration-badge");
      return {
        isRunning: window.__PI_ENH_IS_LIVE_RUNNING__?.("live-stopwatch-test"),
        timers: document.querySelectorAll(".pi-enh-live-timer").length,
        fallbacks: document.querySelectorAll('[data-pi-enh-live-fallback="true"]').length,
        histDurationSec: histBadge?.getAttribute("data-total-sec"),
        histBadgeText: histBadge?.textContent,
      };
    });

    assert.equal(step5.isRunning, false, "Session must no longer be live running after stop button and running placeholder are cleared");
    assert.equal(step5.timers, 0, "All live timers must be cleaned up when run ends");
    assert.equal(step5.fallbacks, 0, "All fallback containers must be cleaned up when run ends");
    assert.equal(step5.histDurationSec, "12", "Historical turn duration badge must never be overwritten by an aborted/empty new turn");
    // Native Codex history may page out every user message during a long tool turn.
    await page.evaluate(() => {
      const sid = "codex:long-history-clock";
      history.replaceState({}, "", "?session=" + encodeURIComponent(sid));
      document.getElementById("entry-u1")?.remove();
      document.getElementById("entry-u2")?.remove();
      const list = document.getElementById("chat-message-list");
      const row = document.createElement("div");
      row.id = "entry-a3";
      row.setAttribute("data-entry-id", "entry-a3");
      row.innerHTML = '<div id="msg-a3" data-message-role="assistant" data-entry-id="entry-a3" data-pi-enh-completed="true"><div data-message-text="true">中间进度，仍在执行工具</div><div style="display:flex;gap:8px;margin-top:4px"><span class="pi-enh-duration-badge" data-total-sec="1">⏱️ 1.0s</span></div></div>';
      list.appendChild(row);
      const stop = document.createElement("button");
      stop.id = "active-stop-btn"; stop.setAttribute("aria-label", "停止"); document.body.appendChild(stop);
      document.querySelector("textarea").placeholder = "立即引导 / 排队后续消息";
      const startedAt = Date.now() - 1800000;
      window.__PI_ENH_HANDLE_MODEL_SPEED_STREAM_EVENT__(sid, {type:"agent_start",taskTiming:{taskId:"native-long-turn",startedAt}});
    });
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.pi-enh-live-timer').count(),1,"authoritative clock must render even before truncated metrics are corrected");
    assert.equal(await page.locator('#msg-a3 .pi-enh-live-timer').count(),0,"completed card must not own a live clock");
    await page.evaluate(() => {
      const data = {context:{messages:[{role:"assistant",timestamp:Date.now()-15000,stopReason:"stop",model:"Codex",content:[{type:"text",text:"中间进度，仍在执行工具"}]}],entryIds:["entry-a3"],hasMore:true},tree:[]};
      window.__PI_WEB_GET_RESIDENT_SESSION_DATA__ = () => data;
      window.dispatchEvent(new CustomEvent("pi-native-session-data-change",{detail:{sessionId:"codex:long-history-clock"}}));
    });
    await page.waitForTimeout(700);
    assert.equal(await page.locator('[data-message-role="user"]').count(),0,"fixture must omit the user page");
    assert.equal(await page.locator('.pi-enh-live-timer').count(),1,"native clock survives when user is outside the rendered history window");
    assert.match(await page.locator('.pi-enh-live-timer').innerText(),/运行中 30分/);
    assert.equal(await page.locator('#msg-a3 .pi-enh-duration-badge').count(),0,"never show a fabricated one-second total for a truncated Codex turn");
    assert.equal(await page.locator('#msg-a1 .pi-enh-duration-badge').getAttribute("data-total-sec"),"12","old complete turn keeps its saved duration");
  } finally {
    await browser.close();
  }
});
