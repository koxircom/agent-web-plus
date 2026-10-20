import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  isEligibleSwipeTarget,
  evaluateSwipeMove,
  isFinalSwipeValid,
} from "../hooks/useMobileHorizontalSwipe.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, "..");
const projectRequire = createRequire(path.join(sourceRoot, "package.json"));

console.log("=== Running Mobile Navigation Horizontal Swipe Tests ===");

// ----------------------------------------------------
// Test 1: Gesture Threshold & Dominant Ratio Evaluations
// ----------------------------------------------------
{
  const stateShort = { horizontalLocked: true, abandoned: false };
  assert.equal(
    isFinalSwipeValid(-39, 0, "left", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    false,
    "Left swipe under 40px must be rejected"
  );
  assert.equal(
    isFinalSwipeValid(39, 0, "right", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    false,
    "Right swipe under 40px must be rejected"
  );
  assert.equal(
    isFinalSwipeValid(-40, 0, "left", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    true,
    "Left swipe >= 40px pure horizontal must be accepted"
  );
  assert.equal(
    isFinalSwipeValid(-50, 30, "left", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    true,
    "Left swipe 50px dx vs 30px dy (ratio 1.67 >= 1.3) must be accepted"
  );
  assert.equal(
    isFinalSwipeValid(42, 10, "right", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    true,
    "Right swipe 42px dx vs 10px dy must be accepted"
  );
  assert.equal(
    isFinalSwipeValid(-50, 42, "left", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    false,
    "Swipe with ratio 50/42=1.19 < 1.3 must be rejected"
  );
  assert.equal(
    isFinalSwipeValid(60, 50, "right", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    false,
    "Swipe with ratio 60/50=1.2 < 1.3 must be rejected"
  );
  assert.equal(
    isFinalSwipeValid(50, 0, "left", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    false,
    "Positive dx must not trigger left swipe"
  );
  assert.equal(
    isFinalSwipeValid(-50, 0, "right", stateShort, { threshold: 40, dominantRatio: 1.3 }),
    false,
    "Negative dx must not trigger right swipe"
  );
  console.log("✓ Test 1: Threshold & dominant ratio evaluations passed");
}

// ----------------------------------------------------
// Test 2: Vertical-First Permanent Abandonment Invariant
// ----------------------------------------------------
{
  let state = { horizontalLocked: false, abandoned: false };
  state = evaluateSwipeMove(2, 10, "left", state, { dominantRatio: 1.3 });
  assert.equal(state.abandoned, true, "Vertical scroll must abandon swipe immediately");
  assert.equal(state.horizontalLocked, false);

  state = evaluateSwipeMove(-80, 0, "left", state, { dominantRatio: 1.3 });
  assert.equal(state.abandoned, true, "Must stay abandoned throughout touch lifecycle");
  assert.equal(state.horizontalLocked, false);
  assert.equal(
    isFinalSwipeValid(-80, 0, "left", state, { threshold: 40, dominantRatio: 1.3 }),
    false,
    "Abandoned state must fail final validation"
  );

  let stateH = { horizontalLocked: false, abandoned: false };
  stateH = evaluateSwipeMove(-12, 3, "left", stateH, { dominantRatio: 1.3 });
  assert.equal(stateH.horizontalLocked, true, "Horizontal dominant movement must lock");
  assert.equal(stateH.abandoned, false);

  console.log("✓ Test 2: Vertical-first permanent abandonment passed");
}

// ----------------------------------------------------
// Test 3: Element Target Eligibility & Avoidance Invariants
// ----------------------------------------------------
{
  class MockElement {
    constructor(tagName, attrs = {}, styles = {}) {
      this.tagName = tagName.toUpperCase();
      this.attrs = attrs;
      this.styles = styles;
      this.parentElement = null;
      this.scrollWidth = 100;
      this.clientWidth = 100;
    }
    closest(selector) {
      let cur = this;
      const selectors = selector.split(",").map((s) => s.trim().toLowerCase());
      while (cur) {
        for (const s of selectors) {
          if (s === cur.tagName.toLowerCase()) return cur;
          if (s.startsWith(".") && (cur.attrs.class || "").includes(s.slice(1))) return cur;
          if (s.startsWith("[") && s.endsWith("]")) {
            const attrName = s.slice(1, -1).split("=")[0];
            if (cur.attrs[attrName] !== undefined) return cur;
          }
        }
        cur = cur.parentElement;
      }
      return null;
    }
  }

  global.HTMLElement = MockElement;
  global.window = {
    getSelection: () => ({ toString: () => "" }),
    getComputedStyle: (el) => el.styles || {},
  };

  const container = new MockElement("div");

  const p = new MockElement("p");
  p.parentElement = container;
  assert.equal(
    isEligibleSwipeTarget(p, container, { allowOnButtons: false }),
    true,
    "Plain text paragraph must be eligible for left swipe"
  );

  const span = new MockElement("span");
  span.parentElement = p;
  assert.equal(
    isEligibleSwipeTarget(span, container, { allowOnButtons: false }),
    true,
    "Plain text span must be eligible for left swipe"
  );

  const input = new MockElement("input");
  input.parentElement = container;
  assert.equal(
    isEligibleSwipeTarget(input, container, { allowOnButtons: false }),
    false,
    "Input element must be avoided"
  );

  const textarea = new MockElement("textarea");
  textarea.parentElement = container;
  assert.equal(
    isEligibleSwipeTarget(textarea, container, { allowOnButtons: false }),
    false,
    "Textarea element must be avoided"
  );

  const contentEditable = new MockElement("div", { contenteditable: "true" });
  contentEditable.parentElement = container;
  assert.equal(
    isEligibleSwipeTarget(contentEditable, container, { allowOnButtons: false }),
    false,
    "Contenteditable element must be avoided"
  );

  const pre = new MockElement("pre");
  pre.parentElement = container;
  const code = new MockElement("code");
  code.parentElement = pre;
  assert.equal(
    isEligibleSwipeTarget(code, container, { allowOnButtons: false }),
    false,
    "Code element inside pre must be avoided"
  );

  const table = new MockElement("table");
  table.parentElement = container;
  const td = new MockElement("td");
  td.parentElement = table;
  assert.equal(
    isEligibleSwipeTarget(td, container, { allowOnButtons: false }),
    false,
    "Table element must be avoided"
  );

  const hScrollContainer = new MockElement("div", {}, { overflowX: "auto" });
  hScrollContainer.scrollWidth = 300;
  hScrollContainer.clientWidth = 200;
  hScrollContainer.parentElement = container;
  const innerText = new MockElement("div");
  innerText.parentElement = hScrollContainer;
  assert.equal(
    isEligibleSwipeTarget(innerText, container, { allowOnButtons: false }),
    false,
    "Child of horizontally scrollable container must be avoided"
  );

  const btn = new MockElement("button");
  btn.parentElement = container;
  assert.equal(
    isEligibleSwipeTarget(btn, container, { allowOnButtons: false }),
    false,
    "Button must be avoided in chat view (allowOnButtons=false)"
  );
  assert.equal(
    isEligibleSwipeTarget(btn, container, { allowOnButtons: true }),
    true,
    "Button must be eligible in navigation overlay (allowOnButtons=true)"
  );

  global.window.getSelection = () => ({ toString: () => "Selected text" });
  assert.equal(
    isEligibleSwipeTarget(p, container, { allowOnButtons: false }),
    false,
    "Active selection must abort swipe eligibility"
  );
  global.window.getSelection = () => ({ toString: () => "" });

  console.log("✓ Test 3: Element eligibility & avoidance invariants passed");
}

// ----------------------------------------------------
// Test 4: Retirement of Legacy Paths & Byte-Identity Check
// ----------------------------------------------------
{
  const appShellPath = path.join(sourceRoot, "components/AppShell.tsx");
  const pkgPath = path.join(sourceRoot, "package.json");
  const lockPkgPath = path.join(sourceRoot, "package-lock.json");
  const content05 = fs.readFileSync(path.join(sourceRoot, "enhancements/modules/05-composer-and-input-workflow.js"), "utf8");
  const legacy05Patterns = [
    "SWIPE_DEBUG",
    "getMobileNavigationLayerElement",
    "getMobileNavigationBoxElement",
    "getMobileNavigationBackdropElement",
    "isMobileNavigationOpen",
    "openMobileNavigation",
    "closeMobileNavigation",
    "session-navigation",
  ];
  for (const pat of legacy05Patterns) {
    assert.equal(
      content05.includes(pat),
      false,
      `05 module must NOT contain retired pattern '${pat}'`
    );
  }

  const appShellContent = fs.readFileSync(appShellPath, "utf8");
  assert.equal(
    appShellContent.includes("__PI_TOGGLE_MOBILE_NAVIGATION__"),
    false,
    "AppShell must NOT expose __PI_TOGGLE_MOBILE_NAVIGATION__"
  );
  assert.equal(
    appShellContent.includes("pi:toggle-mobile-navigation"),
    false,
    "AppShell must NOT listen to pi:toggle-mobile-navigation"
  );

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);

  const pkgLock = JSON.parse(fs.readFileSync(lockPkgPath, "utf8"));
  assert.equal(pkgLock.version, pkg.version, "package-lock.json root version must match package.json");
  assert.equal(
    pkgLock.packages[""].version,
    pkg.version,
    "package-lock.json packages[''] version must match package.json"
  );

  console.log("✓ Test 4: Legacy paths retirement & byte-identity passed");
}

// ----------------------------------------------------
// Test 5: End-to-End Playwright Headless Browser Gesture Verification (Native CDP)
// ----------------------------------------------------
{
  const { build } = projectRequire("esbuild");
  const { chromium } = projectRequire("playwright");

  const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const assistant = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6.1-sol",
    stopReason: "stop",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });

  const messages1 = [
    user("第一轮问题：如何使用手机滑动手势？"),
    assistant("左滑打开导航，右滑关闭导航。正文普通文本均可滑动，代码块和输入框避让。\n\n```js\nconsole.log('code block avoidance test');\n```"),
    user("第二轮问题：测试导航长列表"),
    assistant("导航列表项支持右滑关闭，且抑制 ghost click。"),
  ];

  const messages2 = [
    user("会话二问题：测试会话切换与 DOM remount"),
    assistant("会话二回答：remount 后无需 rAF 轮询，手势依然直接可用。"),
  ];

  const session1 = {
    id: "nav-swipe-fixture-1",
    cwd: "/isolated",
    name: "Navigation swipe fixture 1",
    path: "/isolated/session-1.jsonl",
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: messages1.length,
    firstMessage: "navigation swipe test 1",
  };

  const session2 = {
    id: "nav-swipe-fixture-2",
    cwd: "/isolated",
    name: "Navigation swipe fixture 2",
    path: "/isolated/session-2.jsonl",
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: messages2.length,
    firstMessage: "navigation swipe test 2",
  };

  const bundle = await build({
    stdin: {
      resolveDir: sourceRoot,
      loader: "tsx",
      contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWindow } from './components/ChatWindow';
import { I18nProvider } from './hooks/useI18n';

function Fixture() {
  const [open, setOpen] = useState(false);
  const [currentSession, setCurrentSession] = useState(${JSON.stringify(session1)});

  return (
    <I18nProvider>
      <div style={{ padding: 4, display: 'flex', gap: 8, borderBottom: '1px solid var(--border)' }}>
        <button id="fixture-open" onClick={() => setOpen(true)}>打开导航</button>
        <button id="fixture-switch" onClick={() => {
          setCurrentSession(prev => prev.id === "nav-swipe-fixture-1" ? ${JSON.stringify(session2)} : ${JSON.stringify(session1)});
        }}>切换会话</button>
        <span id="nav-open-state">{open ? "OPEN" : "CLOSED"}</span>
      </div>
      <ChatWindow
        key={currentSession.id}
        session={currentSession}
        newSessionCwd={null}
        newSessionDraftKey={null}
        mobileNavigationOpen={open}
        onMobileNavigationOpenChange={setOpen}
      />
    </I18nProvider>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
      `,
    },
    bundle: true,
    write: false,
    outfile: "fixture.js",
    format: "iife",
    alias: { "@": sourceRoot },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"' },
  });

  const { compileSettingsCss } = projectRequire("./tests/native-settings-css.cjs");
  const css = (await compileSettingsCss()) + "\n" + bundle.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://fixture");
    if (u.pathname === "/bundle.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(bundle.outputFiles.find((f) => f.path.endsWith(".js")).text);
    }
    if (u.pathname.endsWith("/events")) {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: " + JSON.stringify({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] }) + "\n\n");
      return;
    }
    if (u.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      if (u.pathname.startsWith("/api/sessions/nav-swipe-fixture-")) {
        const isS2 = u.pathname.endsWith("2");
        const s = isS2 ? session2 : session1;
        const msgs = isS2 ? messages2 : messages1;
        const eIds = msgs.map((_, i) => "e" + i);
        return res.end(
          JSON.stringify({
            sessionId: s.id,
            info: s,
            tree: [],
            leafId: eIds[eIds.length - 1],
            totalActiveMs: 0,
            context: {
              messages: msgs,
              entryIds: eIds,
              oldestEntryId: "e0",
              hasMore: false,
              thinkingLevel: "off",
              model: { provider: "openai", modelId: "gpt-6.1-sol", id: "gpt-6.1-sol" },
            },
          })
        );
      }
      return res.end(JSON.stringify({ success: true, models: { "openai:gpt-6.1-sol": "GPT-6.1 Sol" }, modelList: [], skills: [], running: false, isStreaming: false, pendingExtensionUiRequests: [], data: {}, tools: [] }));
    }
    res.setHeader("content-type", "text/html");
    res.end(`<html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
  });

  let browser;
  try {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ["--no-sandbox"] });

    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });

    await page.goto(`http://127.0.0.1:${port}`);
    const scroll = page.locator("[data-pi-native-scroll-owner]");
    await scroll.getByText("第一轮问题：如何使用手机滑动手势？").waitFor();

    const dialog = page.getByRole("dialog", { name: "会话导航" });
    assert.equal(await dialog.count(), 0, "Dialog should be initially closed");

    // Connect real CDP session to page
    const client = await page.context().newCDPSession(page);

    // Setup global in-page touch event inspector to assert isTrusted === true
    await page.evaluate(() => {
      window.__touchEvents = [];
      window.__navEntryClickCount = 0;
      ["touchstart", "touchmove", "touchend", "touchcancel"].forEach((type) => {
        window.addEventListener(
          type,
          (e) => {
            window.__touchEvents.push({
              type: e.type,
              isTrusted: e.isTrusted,
              targetTag: e.target?.tagName,
            });
          },
          { capture: true, passive: true }
        );
      });
      document.addEventListener(
        "click",
        (e) => {
          if (e.target.closest("[data-minimap-preview-user], [data-minimap-preview-index]")) {
            window.__navEntryClickCount++;
          }
        },
        true
      );
    });

    // Helper: calculate element center and verify elementFromPoint
    const getTargetCoords = async (locatorOrSelector) => {
      const loc = typeof locatorOrSelector === "string" ? page.locator(locatorOrSelector).first() : locatorOrSelector;
      const box = await loc.boundingBox();
      assert.ok(box, `Element must be visible with bounding box`);
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      const hit = await page.evaluate(
        ({ cx, cy }) => {
          const el = document.elementFromPoint(cx, cy);
          return el ? el.tagName.toLowerCase() : null;
        },
        { cx: x, cy: y }
      );
      assert.ok(hit, `elementFromPoint at (${x}, ${y}) must hit valid target`);
      return { x, y, hit };
    };

    // Helper: dispatch native CDP touch gestures with 16ms stepping
    const nativeSwipe = async (startX, startY, endX, endY, steps = 6, options = {}) => {
      const { verticalFirst = false, cancel = false } = options;

      // 1. touchStart
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: Math.round(startX), y: Math.round(startY), id: 1 }],
      });
      await new Promise((r) => setTimeout(r, 16));

      let curX = startX;
      let curY = startY;

      // Vertical-first step: move down by 25px while dx is only 2px
      // Triggers absY >= 6 && absY > absX -> permanently abandons gesture
      if (verticalFirst) {
        curY += 25;
        curX += 2;
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: Math.round(curX), y: Math.round(curY), id: 1 }],
        });
        await new Promise((r) => setTimeout(r, 16));
      }

      // Step-by-step touchmove every 16ms
      for (let i = 1; i <= steps; i++) {
        const nextX = curX + ((endX - curX) * i) / steps;
        const nextY = curY + ((endY - curY) * i) / steps;
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: Math.round(nextX), y: Math.round(nextY), id: 1 }],
        });
        await new Promise((r) => setTimeout(r, 16));
      }

      if (cancel) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchCancel",
          touchPoints: [],
        });
      } else {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      }
      await new Promise((r) => setTimeout(r, 16));
    };

    const nativeTap = async (x, y) => {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1 }],
      });
      await new Promise((r) => setTimeout(r, 30));
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await new Promise((r) => setTimeout(r, 16));
    };

    const assertTouchEventsTrusted = async () => {
      const events = await page.evaluate(() => {
        const evs = window.__touchEvents.slice();
        window.__touchEvents = [];
        return evs;
      });
      assert.ok(events.length > 0, "Native touch events must have been recorded");
      assert.ok(events.every((e) => e.isTrusted === true), "All CDP touch events must have isTrusted === true");
    };

    // ----------------------------------------------------
    // 5a. Chat view: Native CDP swipe LEFT on message body text -> Opens navigation
    // ----------------------------------------------------
    console.log("5a. Testing chat view swipe left via native CDP input...");
    const pCoords = await getTargetCoords("[data-pi-native-scroll-owner] p");
    // Swipe left by 80px (from pCoords.x to pCoords.x - 80)
    await nativeSwipe(pCoords.x, pCoords.y, pCoords.x - 80, pCoords.y, 6);
    await assertTouchEventsTrusted();

    await dialog.waitFor({ state: "visible", timeout: 2500 });
    assert.equal(await dialog.count(), 1, "Navigation dialog must open after valid native left swipe");
    console.log("✓ 5a. Native left swipe on body text opened navigation");

    // ----------------------------------------------------
    // 5b. Navigation overlay: Native CDP swipe RIGHT on overlay -> Closes navigation
    // ----------------------------------------------------
    console.log("5b. Testing navigation overlay swipe right to close...");
    const boxCoords = await getTargetCoords("[data-minimap-preview-box]");
    await nativeSwipe(boxCoords.x, boxCoords.y, boxCoords.x + 80, boxCoords.y, 6);
    await assertTouchEventsTrusted();

    await dialog.waitFor({ state: "detached", timeout: 2500 });
    assert.equal(await dialog.count(), 0, "Navigation dialog must close after valid native right swipe");
    console.log("✓ 5b. Native right swipe on overlay closed navigation");

    // ----------------------------------------------------
    // 5c. Navigation entry button swipe right: Closes navigation AND suppresses ghost click
    // ----------------------------------------------------
    console.log("5c. Testing entry button swipe right and ghost click suppression...");
    await page.locator("#fixture-open").click();
    await dialog.waitFor({ state: "visible" });

    const userBtn = page.locator("[data-minimap-preview-user]").first();
    await userBtn.waitFor();
    const btnCoords = await getTargetCoords(userBtn);

    // Reset click count before swipe
    await page.evaluate(() => { window.__navEntryClickCount = 0; });

    // Swipe right directly on the button element
    await nativeSwipe(btnCoords.x, btnCoords.y, btnCoords.x + 80, btnCoords.y, 6);
    await assertTouchEventsTrusted();

    await dialog.waitFor({ state: "detached", timeout: 2500 });
    assert.equal(await dialog.count(), 0, "Right swipe on entry button must close navigation");

    // Assert ghost click was suppressed by timestamp guard (no callback triggered)
    const ghostClickCount = await page.evaluate(() => window.__navEntryClickCount);
    assert.equal(ghostClickCount, 0, "Ghost click on entry button must be suppressed after swipe");
    console.log("✓ 5c. Entry button swipe right closed navigation and suppressed ghost click");

    // ----------------------------------------------------
    // 5d. Real Tap: Normal tap on button triggers legitimate click callback (resets suppression)
    // ----------------------------------------------------
    console.log("5d. Testing real tap on entry button executes legitimate click callback...");
    await page.locator("#fixture-open").click();
    await dialog.waitFor({ state: "visible" });
    const freshBtnCoords = await getTargetCoords("[data-minimap-preview-user]");

    await nativeTap(freshBtnCoords.x, freshBtnCoords.y);
    await assertTouchEventsTrusted();
    await page.waitForTimeout(100);

    const normalClickCount = await page.evaluate(() => window.__navEntryClickCount);
    assert.equal(normalClickCount, 1, "Real tap must trigger normal click callback");
    console.log("✓ 5d. Real tap successfully triggered click callback without suppression");

    // Ensure dialog is closed for next tests
    if (await dialog.count() > 0) {
      const box2 = await getTargetCoords("[data-minimap-preview-box]");
      await nativeSwipe(box2.x, box2.y, box2.x + 80, box2.y, 6);
      await dialog.waitFor({ state: "detached", timeout: 2500 });
    }

    // ----------------------------------------------------
    // 5e. Vertical-first swipe: dy > dx initially permanently abandons horizontal swipe
    // ----------------------------------------------------
    console.log("5e. Testing vertical-first swipe permanent abandonment...");
    const vertCoords = await getTargetCoords("[data-pi-native-scroll-owner] p");
    // Moves dy=25, dx=2 first, then tries to swipe horizontally dx=-90
    await nativeSwipe(vertCoords.x, vertCoords.y, vertCoords.x - 90, vertCoords.y + 25, 6, { verticalFirst: true });
    await assertTouchEventsTrusted();
    await page.waitForTimeout(150);

    assert.equal(await dialog.count(), 0, "Vertical-first touch must permanently abandon swipe and NOT open navigation");
    console.log("✓ 5e. Vertical-first touch was rejected as scroll, navigation remained closed");

    // ----------------------------------------------------
    // 5f. Avoidance: Horizontal swipe on code blocks & textareas must NOT trigger swipe
    // ----------------------------------------------------
    console.log("5f. Testing swipe avoidance on code blocks and input controls...");
    const codeLoc = page.locator("[data-pi-native-scroll-owner] pre code").first();
    await codeLoc.waitFor();
    const codeCoords = await getTargetCoords(codeLoc);
    await nativeSwipe(codeCoords.x, codeCoords.y, codeCoords.x - 80, codeCoords.y, 6);
    await assertTouchEventsTrusted();
    await page.waitForTimeout(150);
    assert.equal(await dialog.count(), 0, "Swipe on code block must NOT open navigation");

    const inputLoc = page.locator("textarea").first();
    await inputLoc.waitFor();
    const inputCoords = await getTargetCoords(inputLoc);
    await nativeSwipe(inputCoords.x, inputCoords.y, inputCoords.x - 80, inputCoords.y, 6);
    await assertTouchEventsTrusted();
    await page.waitForTimeout(150);
    assert.equal(await dialog.count(), 0, "Swipe on textarea must NOT open navigation");
    console.log("✓ 5f. Code block and textarea horizontal swipes successfully avoided");

    // ----------------------------------------------------
    // 5g. Touch Cancel: Interrupted touch gesture resets safely without opening
    // ----------------------------------------------------
    console.log("5g. Testing touchcancel interruption safety...");
    const cancelCoords = await getTargetCoords("[data-pi-native-scroll-owner] p");
    await nativeSwipe(cancelCoords.x, cancelCoords.y, cancelCoords.x - 40, cancelCoords.y, 3, { cancel: true });
    await assertTouchEventsTrusted();
    await page.waitForTimeout(150);
    assert.equal(await dialog.count(), 0, "Canceled touch gesture must NOT open navigation");
    console.log("✓ 5g. Touch cancel safely reset gesture state");

    // ----------------------------------------------------
    // 5h. Session Switch & DOM Remount: Rebinds current ref directly without rAF polling
    // ----------------------------------------------------
    console.log("5h. Testing session switch and DOM remount reliability without rAF...");
    await page.locator("#fixture-switch").click();
    await scroll.getByText("会话二问题：测试会话切换与 DOM remount").waitFor({ timeout: 3000 });

    const newPCoords = await getTargetCoords("[data-pi-native-scroll-owner] p");
    await nativeSwipe(newPCoords.x, newPCoords.y, newPCoords.x - 80, newPCoords.y, 6);
    await assertTouchEventsTrusted();

    await dialog.waitFor({ state: "visible", timeout: 2500 });
    assert.equal(await dialog.count(), 1, "Navigation must open on newly mounted session DOM");
    console.log("✓ 5h. Gesture works reliably after session switch and DOM remount");

    await page.close();
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  console.log("✓ Test 5: Playwright headless browser gesture verification passed (All native CDP)");
}

console.log("\n=== ALL DIRECT TESTS PASSED! ===");
