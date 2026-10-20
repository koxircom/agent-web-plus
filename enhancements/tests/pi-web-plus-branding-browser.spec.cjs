"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadPlaywrightChromium() {
  const candidates = [
    "playwright",
    "playwright-core",
    path.resolve(__dirname, "..", "..", "node_modules", "playwright"),
  ];
  for (const modName of candidates) {
    try {
      const mod = require(modName);
      if (mod && mod.chromium) {
        return mod.chromium;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("Playwright is required to run browser regression tests.");
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
      // fall through
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

const SOURCE_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_MODULES_DIR = path.resolve(__dirname, "..", "modules");
const RUNTIME_MODULES_DIR = path.resolve(SOURCE_ROOT, "..", "runtime-modules");

const MODULE_FILES = [
  "01-bootstrap-and-core-state.js",
  "02-plugin-registry-and-settings-schema.js",
  "03-session-cache-and-sync-engine.js",
  "04-sidebar-and-session-management.js",
  "05-composer-and-input-workflow.js",
  "06-chat-view-and-tool-cards.js",
  "07-kernel-scheduler-and-observers.js",
  "08-settings-panels-and-lifecycle.js",
];

function buildBundleFromDir(dirPath) {
  return MODULE_FILES.map((file) => fs.readFileSync(path.join(dirPath, file), "utf8")).join("");
}

test("public SVG brand assets and repository metadata satisfy Pi Web Plus contract", () => {
  const lightSvgPath = path.join(SOURCE_ROOT, "public", "icons", "pi-web-plus-logo-light.svg");
  const darkSvgPath = path.join(SOURCE_ROOT, "public", "icons", "pi-web-plus-logo-dark.svg");
  assert.equal(fs.existsSync(lightSvgPath), true, "light SVG asset must exist");
  assert.equal(fs.existsSync(darkSvgPath), true, "dark SVG asset must exist");

  const lightSvg = fs.readFileSync(lightSvgPath, "utf8");
  const darkSvg = fs.readFileSync(darkSvgPath, "utf8");

  for (const [name, svg, expectedFill] of [
    ["light", lightSvg, "#1a1a1a"],
    ["dark", darkSvg, "#e8e8e8"],
  ]) {
    assert.match(svg, /<svg[^>]+viewBox="0 0 200 32"/, `${name} svg must have viewBox`);
    assert.match(svg, /data-pi-brand-part="bubble"/, `${name} svg must contain bubble path`);
    assert.match(svg, /data-pi-brand-part="pi-bar"/, `${name} svg must contain pi vector path`);
    assert.match(svg, /data-pi-brand-part="plus"/, `${name} svg must contain plus vector path`);
    assert.match(svg, /Pi Web Plus<\/text>/, `${name} svg must contain Pi Web Plus wordmark`);
    assert.doesNotMatch(svg, /<image\b/i, `${name} svg must not embed raster <image>`);
    assert.equal(svg.includes(`fill="${expectedFill}"`), true, `${name} svg must use ${expectedFill}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "@agegr/pi-web");
  assert.equal(pkg.version, "1.1.0");
  assert.equal(pkg.piWebEdition, "koxir-standalone");
  assert.equal(pkg.standalone, true);
  assert.equal(pkg.homepage, "https://github.com/koxircom/agent-web-plus#readme");
  assert.equal(pkg.repository?.url, "git+https://github.com/koxircom/agent-web-plus.git");
  assert.equal(pkg.bugs?.url, "https://github.com/koxircom/agent-web-plus/issues");
});

async function verifyBundleInBrowser(chromium, bundleCode, label) {
  const browser = await chromium.launch(resolveChromiumLaunchOptions(chromium));
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    await context.route("**/*", async (route) => {
      const parsed = new URL(route.request().url());
      if (parsed.hostname === "pi-brand-test.local" && parsed.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html data-theme="light">
<head>
  <meta charset="utf-8" />
  <title>work - Pi Web</title>
  <style>
    :root, [data-theme="light"] {
      --bg: #ffffff;
      --bg-panel: #f5f5f5;
      --bg-hover: #eeeeee;
      --border: #e0e0e0;
      --text: #1a1a1a;
      --text-muted: #515c6b;
      --text-dim: #5e6673;
      --accent: #245bce;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --chat-content-max-width: 820px;
    }
    html.dark, [data-theme="dark"] {
      --bg: #1a1a1a;
      --bg-panel: #242424;
      --bg-hover: #2e2e2e;
      --border: #454545;
      --text: #e8e8e8;
      --text-muted: #b7b7b7;
      --text-dim: #a4a4a4;
      --accent: #a4c2f4;
    }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: sans-serif; display: flex; height: 100vh; }
  </style>
</head>
<body>
  <aside class="sidebar-container" style="width: 260px; box-sizing: border-box; border-right: 1px solid var(--border); background: var(--bg-panel); flex-shrink: 0;">
    <div style="display: flex; flex-direction: column; height: 100%;">
      <div style="padding: 12px 10px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0;">
        <div id="sidebar-header-row" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <button id="sidebar-brand-btn" style="background: none; border: none; padding: 0; cursor: default; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; color: var(--text); font-family: var(--font-mono); min-width: 6ch;">Pi Web</button>
          <div id="sidebar-actions" style="display: flex; gap: 6px;">
            <button id="sidebar-new-btn" style="display: flex; align-items: center; justify-content: center; gap: 5px; background: var(--bg-hover); border: 1px solid var(--border); color: var(--text-muted); height: 32px; padding-left: 10px; padding-right: 12px; border-radius: 7px; font-size: 12px; font-weight: 500; flex-shrink: 0;">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>
              新建
            </button>
            <button id="sidebar-search-btn" type="button" aria-controls="session-search-input" style="display: flex; height: 32px; width: 32px; flex-shrink: 0; align-items: center; justify-content: center; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-hover); color: var(--text-muted);">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div style="flex: 1;"></div>
    </div>
  </aside>

  <main class="chat-content" style="flex: 1; display: flex; flex-direction: column; min-width: 0;">
    <div style="flex: 1;"></div>
    <div id="welcome-wrapper" class="mb-3 w-full" style="padding-left: 16px; padding-right: 52px; box-sizing: border-box;">
      <div id="welcome-bar" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; max-width: var(--chat-content-max-width, 820px); margin: 0 auto; font-family: var(--font-mono);">
        <div id="welcome-left" style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; line-height: 1.4; overflow: hidden;">
          <img id="welcome-logo" src="/icons/apple-touch-icon.png" srcset="/_next/image?url=%2Ficons%2Fapple-touch-icon.png&w=32&q=75 1x, /_next/image?url=%2Ficons%2Fapple-touch-icon.png&w=64&q=75 2x" sizes="32px" loading="eager" width="32" height="32" alt="" style="color: transparent; flex-shrink: 0;" />
          <span id="welcome-text" style="font-size: 22px; color: var(--text); font-weight: 700; flex-shrink: 0; white-space: nowrap;">Pi Web</span>
        </div>
        <div id="welcome-versions" style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0;">
          <span style="font-size: 11px; color: var(--text-muted);">web <span style="color: var(--text);">v1.1.0</span></span>
          <span style="font-size: 11px; color: var(--text-muted);">pi <span style="color: var(--text);">v0.99.1</span></span>
        </div>
      </div>
    </div>
    <fieldset style="border: none; margin: 0; padding: 0 16px 24px;">
      <div style="max-width: 820px; margin: 0 auto;">
        <textarea placeholder="Ask anything..."></textarea>
      </div>
    </fieldset>
    <div style="flex: 1;"></div>
  </main>
</body>
</html>`,
        });
        return;
      }
      if (parsed.pathname.startsWith("/icons/")) {
        await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    const page = await context.newPage();
    await page.goto("http://pi-brand-test.local/", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: bundleCode });

    // 1. Verify default enabled state, plugin metadata, no PNG preload, and SVG dataURI
    const initialState = await page.evaluate(() => {
      const plugin = window.__PI_ENH_PLUGINS__?.find((p) => p.id === "pi-web-plus-branding");
      const enabled = window.__PI_ENH_IS_PLUGIN_ENABLED__?.("pi-web-plus-branding");
      const preloadLinks = document.head.querySelectorAll('link[rel="preload"][href*="apple-touch-icon"]').length;
      const hasPreloadImg = Boolean(window.__PI_ENH_LOGO_PRELOAD_IMG__);

      const img = document.getElementById("welcome-logo");
      const span = document.getElementById("welcome-text");
      const sidebarBtn = document.getElementById("sidebar-brand-btn");
      const src = img.getAttribute("src") || "";
      const decodedSvg = src.startsWith("data:image/svg+xml;utf8,")
        ? decodeURIComponent(src.slice("data:image/svg+xml;utf8,".length))
        : "";

      const imgRect = img.getBoundingClientRect();
      const verRect = document.getElementById("welcome-versions").getBoundingClientRect();
      const sbTitleRect = sidebarBtn.getBoundingClientRect();
      const sbActionsRect = document.getElementById("sidebar-actions").getBoundingClientRect();

      return {
        plugin,
        enabled,
        preloadLinks,
        hasPreloadImg,
        hasBrandAttr: img.getAttribute("data-pi-brand-logo"),
        brandColor: img.getAttribute("data-pi-brand-color"),
        hasSrcset: img.hasAttribute("srcset"),
        hasSizes: img.hasAttribute("sizes"),
        imgWidthAttr: img.getAttribute("width"),
        imgHeightAttr: img.getAttribute("height"),
        imgAlt: img.getAttribute("alt"),
        decodedSvg,
        spanDisplay: window.getComputedStyle(span).display,
        sidebarText: sidebarBtn.textContent,
        desktopGeometry: {
          imgWidth: imgRect.width,
          imgHeight: imgRect.height,
          imgRight: imgRect.right,
          verLeft: verRect.left,
          welcomeGap: verRect.left - imgRect.right,
          sbTitleRight: sbTitleRect.right,
          sbActionsLeft: sbActionsRect.left,
          sidebarGap: sbActionsRect.left - sbTitleRect.right,
          batchBtnPresent: Boolean(document.getElementById("pi-enh-session-batch-btn")),
        },
        isLiveRunning: window.__PI_ENH_IS_LIVE_RUNNING__?.(),
        lastRunningReason: window.__PI_ENH_LAST_RUNNING_REASON__,
      };
    });

    assert.equal(initialState.plugin?.name, "Pi Web Plus SVG 品牌", `${label}: plugin name`);
    assert.equal(initialState.plugin?.version, "1.0.0", `${label}: plugin version`);
    assert.equal(initialState.plugin?.category, "显示增强", `${label}: plugin category`);
    assert.equal(initialState.plugin?.defaultEnabled, true, `${label}: defaultEnabled`);
    assert.equal(initialState.enabled, true, `${label}: enabled by default`);
    assert.equal(initialState.preloadLinks, 0, `${label}: no PNG preload link when brand enabled`);
    assert.equal(initialState.hasPreloadImg, false, `${label}: no PNG preload Image when brand enabled`);
    assert.equal(initialState.hasBrandAttr, "true", `${label}: data-pi-brand-logo marker`);
    assert.equal(initialState.hasSrcset, false, `${label}: srcset removed while SVG active`);
    assert.equal(initialState.hasSizes, false, `${label}: sizes removed while SVG active`);
    assert.equal(initialState.imgWidthAttr, "200", `${label}: width=200`);
    assert.equal(initialState.imgHeightAttr, "32", `${label}: height=32`);
    assert.equal(initialState.imgAlt, "π+ Pi Web Plus", `${label}: alt text`);
    assert.match(initialState.decodedSvg, /data-pi-brand-part="pi-bar"/, `${label}: vector pi path`);
    assert.match(initialState.decodedSvg, /data-pi-brand-part="plus"/, `${label}: vector plus path`);
    assert.match(initialState.decodedSvg, /Pi Web Plus<\/text>/, `${label}: SVG wordmark`);
    assert.doesNotMatch(initialState.decodedSvg, /<image\b/i, `${label}: no raster image in SVG`);
    assert.equal(initialState.decodedSvg.includes('fill="#1a1a1a"'), true, `${label}: light theme text color`);
    assert.equal(initialState.spanDisplay, "none", `${label}: original Pi Web span hidden`);
    assert.equal(initialState.sidebarText, "Pi Web Plus", `${label}: sidebar brand text`);
    assert.equal(initialState.desktopGeometry.imgWidth, 200, `${label}: rendered SVG width`);
    assert.equal(initialState.desktopGeometry.imgHeight, 32, `${label}: rendered SVG height`);
    assert.equal(initialState.desktopGeometry.welcomeGap > 20, true, `${label}: desktop welcome no overlap`);
    assert.equal(initialState.desktopGeometry.batchBtnPresent, true, `${label}: batch button coexists`);
    assert.equal(initialState.desktopGeometry.sidebarGap >= 10, true, `${label}: 260px sidebar not crowded (gap=${initialState.desktopGeometry.sidebarGap})`);
    assert.equal(initialState.isLiveRunning, false, `${label}: empty session is idle`);
    assert.equal(initialState.lastRunningReason, "empty new session is idle", `${label}: empty session detected via data-pi-brand-logo`);

    // 2. Theme switching (Light -> Dark -> Light) immediate repaint
    const darkThemeState = await page.evaluate(async () => {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.classList.add("dark");
      await new Promise((r) => setTimeout(r, 20));
      const img = document.getElementById("welcome-logo");
      const src = img.getAttribute("src") || "";
      const decodedSvg = decodeURIComponent(src.slice("data:image/svg+xml;utf8,".length));
      return {
        brandColor: img.getAttribute("data-pi-brand-color"),
        decodedSvg,
      };
    });
    assert.equal(darkThemeState.brandColor, "#e8e8e8", `${label}: dark theme color updated immediately`);
    assert.equal(darkThemeState.decodedSvg.includes('fill="#e8e8e8"'), true, `${label}: dark SVG fill updated`);

    const backToLightState = await page.evaluate(async () => {
      document.documentElement.dataset.theme = "light";
      document.documentElement.classList.remove("dark");
      await new Promise((r) => setTimeout(r, 20));
      const img = document.getElementById("welcome-logo");
      return img.getAttribute("data-pi-brand-color");
    });
    assert.equal(backToLightState, "#1a1a1a", `${label}: light theme color restored immediately`);

    // 3. Mobile 360px geometry check
    await page.setViewportSize({ width: 360, height: 740 });
    const mobileGeometry = await page.evaluate(() => {
      const wrapper = document.getElementById("welcome-wrapper");
      wrapper.style.paddingRight = "16px";
      const imgRect = document.getElementById("welcome-logo").getBoundingClientRect();
      const verRect = document.getElementById("welcome-versions").getBoundingClientRect();
      return {
        imgWidth: imgRect.width,
        imgHeight: imgRect.height,
        imgRight: imgRect.right,
        verLeft: verRect.left,
        gap: verRect.left - imgRect.right,
      };
    });
    assert.equal(mobileGeometry.imgHeight, 32, `${label}: mobile SVG height`);
    assert.equal(mobileGeometry.gap >= 8, true, `${label}: mobile 360px no overlap with versions (gap=${mobileGeometry.gap})`);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 4. Title sanitization compatibility with "Pi Web Plus" (no orphan "Plus")
    const titleResults = await page.evaluate(() => {
      const results = {};
      document.title = "work - Pi Web Plus";
      results.suffixPlus = document.title;
      document.title = "Pi Web Plus - my-repo";
      results.prefixPlus = document.title;
      document.title = "my-repo · Pi Web+";
      results.dotPlusSymbol = document.title;
      document.title = "Pi Web Plus";
      results.barePlus = document.title;
      document.title = "Pi Website research";
      results.website = document.title;
      document.title = "Pi Websocket diagnostics";
      results.websocket = document.title;
      results.sidebarWebsite = window.__PI_ENH_COMPOSE_WINDOW_TITLE__("Pi Website research", "idle");
      results.sidebarWebsocket = window.__PI_ENH_COMPOSE_WINDOW_TITLE__("Pi Websocket diagnostics", "idle");
      return results;
    });
    assert.equal(titleResults.suffixPlus, "work", `${label}: 'work - Pi Web Plus' -> 'work'`);
    assert.equal(titleResults.prefixPlus, "my-repo", `${label}: 'Pi Web Plus - my-repo' -> 'my-repo'`);
    assert.equal(titleResults.dotPlusSymbol, "my-repo", `${label}: 'my-repo · Pi Web+' -> 'my-repo'`);
    assert.equal(titleResults.barePlus, "work", `${label}: 'Pi Web Plus' -> fallback 'work' without orphan Plus`);
    assert.equal(titleResults.website, "Pi Website research", `${label}: preserve non-brand Website title`);
    assert.equal(titleResults.websocket, "Pi Websocket diagnostics", `${label}: preserve non-brand Websocket title`);
    assert.equal(titleResults.sidebarWebsite, "Pi Website research", `${label}: sidebar preserves Website title`);
    assert.equal(titleResults.sidebarWebsocket, "Pi Websocket diagnostics", `${label}: sidebar preserves Websocket title`);

    // 5. Toggle OFF -> full reversible restoration -> Toggle ON -> Hot Unload Cleanup
    const toggleOffState = await page.evaluate(() => {
      window.__PI_ENH_SET_PLUGIN__("pi-web-plus-branding", false);
      const img = document.getElementById("welcome-logo");
      const span = document.getElementById("welcome-text");
      const sidebarBtn = document.getElementById("sidebar-brand-btn");
      return {
        src: img.getAttribute("src"),
        srcset: img.getAttribute("srcset"),
        sizes: img.getAttribute("sizes"),
        loading: img.getAttribute("loading"),
        width: img.getAttribute("width"),
        height: img.getAttribute("height"),
        style: img.getAttribute("style"),
        alt: img.getAttribute("alt"),
        hasBrandAttr: img.hasAttribute("data-pi-brand-logo"),
        spanDisplay: window.getComputedStyle(span).display,
        spanHiddenLabelAttr: span.hasAttribute("data-pi-brand-hidden-label"),
        sidebarText: sidebarBtn.textContent,
        sidebarFontSize: sidebarBtn.style.fontSize,
      };
    });
    assert.equal(toggleOffState.src, "/icons/apple-touch-icon.png", `${label}: off restores src`);
    assert.match(toggleOffState.srcset || "", /apple-touch-icon\.png/, `${label}: off restores srcset`);
    assert.equal(toggleOffState.sizes, "32px", `${label}: off restores sizes`);
    assert.equal(toggleOffState.loading, "eager", `${label}: off restores loading`);
    assert.equal(toggleOffState.width, "32", `${label}: off restores width`);
    assert.equal(toggleOffState.height, "32", `${label}: off restores height`);
    assert.equal(toggleOffState.style, "color: transparent; flex-shrink: 0;", `${label}: off restores style`);
    assert.equal(toggleOffState.alt, "", `${label}: off restores alt`);
    assert.equal(toggleOffState.hasBrandAttr, false, `${label}: off removes data-pi-brand-logo`);
    assert.notEqual(toggleOffState.spanDisplay, "none", `${label}: off restores span visibility`);
    assert.equal(toggleOffState.spanHiddenLabelAttr, false, `${label}: off removes hidden label marker`);
    assert.equal(toggleOffState.sidebarText, "Pi Web", `${label}: off restores sidebar title text`);
    assert.equal(toggleOffState.sidebarFontSize, "15px", `${label}: off restores sidebar font-size`);

    const toggleReOnState = await page.evaluate(() => {
      window.__PI_ENH_SET_PLUGIN__("pi-web-plus-branding", true);
      const img = document.getElementById("welcome-logo");
      const span = document.getElementById("welcome-text");
      const sidebarBtn = document.getElementById("sidebar-brand-btn");
      return {
        hasBrandAttr: img.getAttribute("data-pi-brand-logo"),
        isSvgDataUri: (img.getAttribute("src") || "").startsWith("data:image/svg+xml;utf8,"),
        spanDisplay: window.getComputedStyle(span).display,
        sidebarText: sidebarBtn.textContent,
      };
    });
    assert.equal(toggleReOnState.hasBrandAttr, "true", `${label}: re-on restores brand marker`);
    assert.equal(toggleReOnState.isSvgDataUri, true, `${label}: re-on restores SVG dataURI`);
    assert.equal(toggleReOnState.spanDisplay, "none", `${label}: re-on hides original span`);
    assert.equal(toggleReOnState.sidebarText, "Pi Web Plus", `${label}: re-on restores sidebar Pi Web Plus`);

    const cleanupState = await page.evaluate(() => {
      window.__PI_WEB_ENHANCEMENTS_CLEANUP__();
      const img = document.getElementById("welcome-logo");
      const span = document.getElementById("welcome-text");
      const sidebarBtn = document.getElementById("sidebar-brand-btn");
      return {
        src: img.getAttribute("src"),
        srcset: img.getAttribute("srcset"),
        width: img.getAttribute("width"),
        height: img.getAttribute("height"),
        hasBrandAttr: img.hasAttribute("data-pi-brand-logo"),
        spanDisplay: window.getComputedStyle(span).display,
        sidebarText: sidebarBtn.textContent,
      };
    });
    assert.equal(cleanupState.src, "/icons/apple-touch-icon.png", `${label}: cleanup restores src`);
    assert.match(cleanupState.srcset || "", /apple-touch-icon\.png/, `${label}: cleanup restores srcset`);
    assert.equal(cleanupState.width, "32", `${label}: cleanup restores width`);
    assert.equal(cleanupState.height, "32", `${label}: cleanup restores height`);
    assert.equal(cleanupState.hasBrandAttr, false, `${label}: cleanup removes brand marker`);
    assert.notEqual(cleanupState.spanDisplay, "none", `${label}: cleanup restores span display`);
    assert.equal(cleanupState.sidebarText, "Pi Web", `${label}: cleanup restores sidebar title`);

    await context.close();
  } finally {
    await browser.close();
  }
}

test("pi-web-plus-branding in real Chromium (source/enhancements/modules bundle)", async () => {
  const chromium = loadPlaywrightChromium();
  const bundleCode = buildBundleFromDir(SOURCE_MODULES_DIR);
  await verifyBundleInBrowser(chromium, bundleCode, "source-modules");
});

// NAS deployment snapshots are optional in a public source checkout.
test("pi-web-plus-branding in real Chromium (runtime-modules bundle)", { skip: !fs.existsSync(RUNTIME_MODULES_DIR) }, async () => {
  const chromium = loadPlaywrightChromium();
  const bundleCode = buildBundleFromDir(RUNTIME_MODULES_DIR);
  await verifyBundleInBrowser(chromium, bundleCode, "runtime-modules");
});
