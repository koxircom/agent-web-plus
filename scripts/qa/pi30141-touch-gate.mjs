import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLongPressEvidence, assertNoFlashEvidence, assertSelectedTextCancelEvidence, resolveBuildId } from "./pi30141-touch-verifier.mjs";

const CONFIG_NAME = "pi30141-touch-gate.config.json";
const PANEL_SELECTOR = "#file-panel";

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Config must be an object");
  const baseUrl = input.baseUrl ? new URL(requireText(input.baseUrl, "baseUrl")) : null;
  if (baseUrl && !/^https?:$/.test(baseUrl.protocol)) throw new Error("baseUrl must use http or https");
  const engines = input.engines;
  if (!Array.isArray(engines) || engines.length !== 2 || new Set(engines.map((item) => String(item).toLowerCase())).size !== 2 || !["pi", "codex"].every((engine) => engines.map((item) => String(item).toLowerCase()).includes(engine))) {
    throw new Error("engines must include both pi and codex");
  }
  const engineUrls = Object.fromEntries(["pi", "codex"].map((engine) => {
    const value = input.engineUrls?.[engine];
    const url = value ? new URL(requireText(value, `engineUrls.${engine}`)) : baseUrl && new URL(baseUrl);
    if (!url || !/^https?:$/.test(url.protocol)) throw new Error(`Provide a valid engineUrls.${engine} or baseUrl`);
    url.searchParams.set("engine", engine);
    return [engine, url.toString()];
  }));
  if (!(typeof input.spaceId === "string" || Number.isInteger(input.spaceId))) throw new Error("spaceId must identify an existing TaskSpace");
  const viewports = input.viewports;
  if (!Array.isArray(viewports) || viewports.length === 0) throw new Error("viewports must be a non-empty array");
  for (const [index, viewport] of viewports.entries()) {
    if (!Number.isInteger(viewport?.width) || viewport.width < 240 || !Number.isInteger(viewport?.height) || viewport.height < 320) {
      throw new Error(`viewports[${index}] requires integer CSS width >= 240 and height >= 320`);
    }
  }
  if (JSON.stringify(viewports.map((viewport) => viewport.width)) !== JSON.stringify([390, 800, 1124])) {
    throw new Error("viewports must be the fixed CSS widths 390, 800, and 1124 in order");
  }
  const expectedBuildId = requireText(input.expectedBuildId, "expectedBuildId");
  const fingerprint = input.expectedAssetFingerprint;
  if (!fingerprint || typeof fingerprint !== "object" || Array.isArray(fingerprint)) {
    throw new Error("expectedAssetFingerprint must contain url and sha256");
  }
  const assetUrl = requireText(fingerprint.url, "expectedAssetFingerprint.url");
  if (!/^[a-f0-9]{64}$/i.test(fingerprint.sha256 ?? "")) throw new Error("expectedAssetFingerprint.sha256 must be a 64-character SHA-256 hex digest");
  const targets = Object.fromEntries(["pi", "codex"].map((engine) => {
    const target = input.selectionTargets?.[engine] || input.selectionTarget;
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error(`selection target for ${engine} must contain selector and text`);
    return [engine, {
      selector: requireText(target.selector, `selectionTargets.${engine}.selector`),
      text: requireText(target.text, `selectionTargets.${engine}.text`),
    }];
  }));
  const outputPath = requireText(input.outputPath, "outputPath");
  if (!isAbsolute(outputPath)) throw new Error("outputPath must be absolute in the ego-browser Windows runtime");

  return {
    ...input,
    baseUrl: baseUrl?.toString() || null,
    engineUrls,
    engines: ["pi", "codex"],
    expectedBuildId,
    expectedAssetFingerprint: { url: assetUrl, sha256: fingerprint.sha256.toLowerCase() },
    outputPath,
    panelSelector: input.panelSelector || PANEL_SELECTOR,
    pageLabel: input.pageLabel || "p1",
    holdMs: Number.isInteger(input.holdMs) ? Math.max(1000, input.holdMs) : 1000,
    selectionTargets: targets,
  };
}

async function readConfig() {
  const query = new URL(import.meta.url).searchParams.get("config");
  const envPath = process.env.PI30141_TOUCH_GATE_CONFIG;
  const configUrl = query
    ? new URL(query)
    : envPath
      ? new URL(envPath.match(/^file:/i) ? envPath : pathToFileURL(envPath).href)
      : new URL(CONFIG_NAME, import.meta.url);
  if (configUrl.protocol !== "file:") throw new Error("The config query parameter must be an absolute file URL");
  const fs = await import("node:fs/promises");
  return validateConfig(JSON.parse(await fs.readFile(fileURLToPath(configUrl), "utf8")));
}

async function readBrowserIdentity(page) {
  const identity = await page.evaluate(() => ({
    platform: navigator.userAgentData?.platform || navigator.platform || "unknown",
    userAgent: navigator.userAgent,
    language: navigator.language,
    devicePixelRatio: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
  }));
  if (!/windows|win32|win64/i.test(`${identity.platform} ${identity.userAgent}`)) {
    throw new Error(`Windows browser required; measured ${identity.platform} / ${identity.userAgent}`);
  }
  return identity;
}

async function readBuildAndFingerprint(page, config) {
  const pageBuild = await page.evaluate(() => {
    const urls = [
      ...Array.from(document.scripts, (script) => script.src).filter(Boolean),
      ...Array.from(document.querySelectorAll('link[rel="stylesheet"]'), (link) => link.href).filter(Boolean),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ];
    const html = document.documentElement.outerHTML;
    const rscBuildIds = [...html.matchAll(/\\"b\\":\\"([^\\"]+)/g)].map((match) => match[1]);
    return { rscBuildIds, loadedUrls: [...new Set(urls)] };
  });
  const buildId = resolveBuildId(pageBuild.rscBuildIds);
  if (buildId.buildId !== config.expectedBuildId) {
    throw new Error(`Current page build mismatch: expected ${config.expectedBuildId}, measured ${buildId.buildId || buildId.source}`);
  }
  const target = new URL(config.expectedAssetFingerprint.url, await page.url());
  const loaded = pageBuild.loadedUrls.some((value) => {
    try { return new URL(value).pathname === target.pathname; } catch { return false; }
  });
  if (!loaded) throw new Error(`Fingerprint asset was not loaded by this page: ${target.pathname}`);
  const response = await page.fetch(target.toString(), { timeout: 20_000 });
  if (!response.ok || typeof response.body !== "string") {
    throw new Error(`Unable to read fingerprint asset from current Page: HTTP ${response.status}`);
  }
  const actualSha256 = createHash("sha256").update(response.body, "utf8").digest("hex");
  if (actualSha256 !== config.expectedAssetFingerprint.sha256) {
    throw new Error(`Current asset fingerprint mismatch: expected ${config.expectedAssetFingerprint.sha256}, measured ${actualSha256}`);
  }
  return {
    buildId: buildId.buildId,
    buildIdSource: buildId.source,
    assetFingerprint: {
      url: `${target.origin}${target.pathname}`,
      sha256: actualSha256,
      fetchedStatus: response.status,
      loadedByCurrentPage: loaded,
    },
  };
}

async function waitForFixtureAndAsset(page, config, target) {
  const assetPath = new URL(config.expectedAssetFingerprint.url, await page.url()).pathname;
  await page.waitForFunction(({ selector, text, assetPath, panelSelector }) => {
    const panel = document.querySelector(panelSelector);
    const fixture = document.querySelector(selector);
    if (!panel || !fixture || !(fixture.innerText || fixture.textContent || "").includes(text)) return false;
    const style = getComputedStyle(fixture);
    const rect = fixture.getBoundingClientRect();
    const fixtureVisible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    const enhancementLoaded = performance.getEntriesByType("resource").some((entry) => {
      try { return new URL(entry.name).pathname === assetPath; } catch { return false; }
    });
    return fixtureVisible && enhancementLoaded;
  }, { selector: target.selector, text: target.text, assetPath, panelSelector: config.panelSelector }, { timeout: 30_000 });
}

async function projectViewport(page, viewport, initialDpr) {
  let projectedWidth = Math.round(viewport.width * initialDpr);
  let projectedHeight = Math.round(viewport.height * initialDpr);
  let measured;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width: projectedWidth,
      height: projectedHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
    measured = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      touches: navigator.maxTouchPoints,
      visualViewportWidth: window.visualViewport?.width ?? null,
    }));
    if (measured.width === viewport.width && measured.height === viewport.height) break;
    if (measured.width <= 0 || measured.height <= 0) throw new Error(`Invalid measured CSS viewport: ${JSON.stringify(measured)}`);
    projectedWidth = Math.round(projectedWidth * viewport.width / measured.width);
    projectedHeight = Math.round(projectedHeight * viewport.height / measured.height);
  }
  if (measured.width !== viewport.width || measured.height !== viewport.height) {
    throw new Error(`Could not project requested CSS viewport ${viewport.width}x${viewport.height}: ${JSON.stringify(measured)}`);
  }
  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  measured = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    touches: navigator.maxTouchPoints,
    visualViewportWidth: window.visualViewport?.width ?? null,
  }));
  if (measured.width !== viewport.width || measured.height !== viewport.height || measured.touches < 3) {
    throw new Error(`Measured touch viewport mismatch: ${JSON.stringify(measured)}`);
  }
  return {
    requestedCss: { width: viewport.width, height: viewport.height },
    projectedEmulationPixels: { width: projectedWidth, height: projectedHeight },
    measured: measured,
  };
}

async function waitPanelStable(page, selector) {
  await page.evaluate((panelSelector) => {
    window.__pi30141Stable = { selector: panelSelector, key: null, frames: 0 };
  }, selector);
  await page.waitForFunction((panelSelector) => {
    const panel = document.querySelector(panelSelector);
    const state = window.__pi30141Stable;
    if (!panel || !state) return false;
    const rect = panel.getBoundingClientRect();
    const key = [rect.x, rect.y, rect.width, rect.height, panel.className, panel.getAttribute("style") || ""].join("|");
    state.frames = key === state.key && !panel.getAnimations({ subtree: false }).some((animation) => animation.playState === "running") ? state.frames + 1 : 0;
    state.key = key;
    return state.frames >= 4;
  }, selector, { timeout: 15_000 });
  const state = await page.evaluate((panelSelector) => {
    const panel = document.querySelector(panelSelector);
    const rect = panel.getBoundingClientRect();
    return {
      className: String(panel.className),
      style: panel.getAttribute("style") || "",
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      open: panel.classList.contains("right-panel-open"),
      animationsRunning: panel.getAnimations({ subtree: false }).some((animation) => animation.playState === "running"),
    };
  }, selector);
  if (state.animationsRunning) throw new Error("Panel still has a running animation after stability wait");
  return state;
}

async function closePanel(page, selector) {
  const state = await waitPanelStable(page, selector);
  if (!state.open) return state;
  const closeSelector = `${selector} button[aria-controls="file-panel"][aria-expanded="true"]`;
  const count = await page.evaluate((value) => document.querySelectorAll(value).length, closeSelector);
  if (count !== 1) throw new Error(`Expected one visible panel close control, found ${count}`);
  await clickCssSelector(page, closeSelector);
  const closed = await waitPanelStable(page, selector);
  if (closed.open) throw new Error("The right panel remained open after the close control was used");
  return closed;
}

async function dispatchCssClick(page, x, y, clickCount = 1) {
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
}

async function clickCssSelector(page, selector) {
  const point = await page.evaluate((value) => {
    const element = document.querySelector(value);
    if (!element) throw new Error(`CDP click target not found: ${value}`);
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (rect.width <= 0 || rect.height <= 0 || !hit || !(hit === element || element.contains(hit))) {
      throw new Error(`CDP click target is obscured or outside the CSS viewport: ${value}`);
    }
    return { x, y };
  }, selector);
  await dispatchCssClick(page, point.x, point.y);
  return point;
}

async function hideSidebarAt390(page) {
  const before = await page.evaluate(() => {
    const sidebar = document.querySelector("#session-sidebar");
    if (!sidebar) throw new Error("Session sidebar not found");
    const rect = sidebar.getBoundingClientRect();
    const button = [...document.querySelectorAll("button")].find((item) => /hide sidebar|隐藏侧边栏/i.test(`${item.getAttribute("aria-label") || ""} ${item.title || ""}`));
    const buttonRect = button?.getBoundingClientRect();
    const buttonHit = button && buttonRect ? document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2) : null;
    const backdrop = document.querySelector(".sidebar-overlay-backdrop");
    const point = { x: Math.max(rect.right + 8, innerWidth * 0.75), y: innerHeight * 0.5 };
    const backdropHit = backdrop && document.elementFromPoint(point.x, point.y);
    return {
      open: sidebar.classList.contains("sidebar-open"),
      className: String(sidebar.className),
      rect: { x: rect.x, right: rect.right, width: rect.width },
      buttonPoint: buttonRect ? { x: buttonRect.left + buttonRect.width / 2, y: buttonRect.top + buttonRect.height / 2 } : null,
      buttonHit: Boolean(button && buttonHit && (buttonHit === button || button.contains(buttonHit))),
      backdropPoint: backdropHit && (backdropHit === backdrop || backdrop.contains(backdropHit)) ? point : null,
    };
  });
  if (before.open) {
    if (before.buttonHit && before.buttonPoint) {
      await dispatchCssClick(page, before.buttonPoint.x, before.buttonPoint.y);
    } else if (before.backdropPoint) {
      await dispatchCssClick(page, before.backdropPoint.x, before.backdropPoint.y);
    } else {
      throw new Error("Open mobile sidebar has no hittable native toggle or backdrop");
    }
  }
  // The mobile media/layout transition may still be settling when state was
  // already closed before projection. Always wait for the actual geometry.
  await page.waitForFunction(() => {
    const sidebar = document.querySelector("#session-sidebar");
    return Boolean(sidebar && sidebar.classList.contains("sidebar-closed") && sidebar.getBoundingClientRect().right <= 1);
  }, undefined, { timeout: 8_000 });
  const after = await page.evaluate(() => {
    const sidebar = document.querySelector("#session-sidebar");
    const rect = sidebar.getBoundingClientRect();
    return { open: sidebar.classList.contains("sidebar-open"), className: String(sidebar.className), rect: { x: rect.x, right: rect.right, width: rect.width } };
  });
  if (after.open || after.rect.right > 1) throw new Error(`Mobile sidebar remains visible after UI/CDP collapse: ${JSON.stringify(after)}`);
  return { action: before.open ? before.buttonHit ? "toggle" : "overlay-backdrop" : "already-closed", before, after };
}

async function locateTextPoint(page, target) {
  await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Text target not found: ${selector}`);
    element.scrollIntoView({ block: "center", inline: "nearest" });
  }, target.selector);
  await page.evaluate((selector) => {
    window.__pi30141TargetStable = { selector, key: null, frames: 0 };
  }, target.selector);
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    const state = window.__pi30141TargetStable;
    if (!element || !state) return false;
    const rect = element.getBoundingClientRect();
    const key = [rect.x, rect.y, rect.width, rect.height].join("|");
    state.frames = key === state.key ? state.frames + 1 : 0;
    state.key = key;
    return state.frames >= 3;
  }, target.selector, { timeout: 12_000 });
  return page.evaluate(({ selector, text }) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Text target not found: ${selector}`);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const offset = node.nodeValue.indexOf(text);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + text.length);
      const rect = [...range.getClientRects()].sort((left, right) => right.width - left.width)[0];
      if (!rect) continue;
      if (rect.width <= 0 || rect.height <= 0) continue;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        targetFound: true,
        textMatched: true,
        inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      };
    }
    return { targetFound: true, textMatched: false, inViewport: false };
  }, target);
}

async function beginProbe(page, panelSelector, gesture) {
  await page.evaluate(({ panelSelector, gesture }) => {
    const panel = document.querySelector(panelSelector);
    if (!panel) throw new Error(`Panel not found: ${panelSelector}`);
    const state = {
      panel,
      gesture,
      startedAt: performance.now(),
      endedAt: null,
      frames: [],
      touchEvents: [],
      transitions: [],
      postGestureFrames: 0,
      stableFrames: 0,
      lastFrameKey: null,
      done: false,
      classValue: panel.getAttribute("class") || "",
      styleValue: panel.getAttribute("style") || "",
    };
    const panelVisibleFrom = (classValue, styleValue) => {
      const classNames = new Set(String(classValue || "").split(/\s+/));
      const scratch = document.createElement("div");
      scratch.style.cssText = styleValue || "";
      const transform = scratch.style.transform;
      const closedTransform = /translate(?:X|3d)\(\s*100%[,)]/i.test(transform);
      return classNames.has("right-panel-open") || !classNames.has("right-panel-closed") || Boolean(transform && !closedTransform);
    };
    const processMutations = (records) => {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.target !== panel || !["class", "style"].includes(record.attributeName)) continue;
        const name = record.attributeName;
        const current = name === "class" ? panel.getAttribute("class") || "" : panel.getAttribute("style") || "";
        let next = current;
        for (let nextIndex = index + 1; nextIndex < records.length; nextIndex += 1) {
          if (records[nextIndex].target === panel && records[nextIndex].attributeName === name) {
            next = records[nextIndex].oldValue || "";
            break;
          }
        }
        const oldClass = name === "class" ? record.oldValue || "" : state.classValue;
        const oldStyle = name === "style" ? record.oldValue || "" : state.styleValue;
        const newClass = name === "class" ? next : oldClass;
        const newStyle = name === "style" ? next : oldStyle;
        state.transitions.push({
          time: performance.now(),
          attribute: name,
          oldValue: record.oldValue || "",
          newValue: next,
          panelVisible: panelVisibleFrom(oldClass, oldStyle) || panelVisibleFrom(newClass, newStyle),
        });
        if (name === "class") state.classValue = next;
        else state.styleValue = next;
      }
    };
    state.observer = new MutationObserver(processMutations);
    state.observer.observe(panel, { attributes: true, attributeFilter: ["class", "style"], attributeOldValue: true });
    state.contextMenuEvents = [];
    state.onContextMenu = (event) => state.contextMenuEvents.push({ trusted: event.isTrusted, time: performance.now() });
    document.addEventListener("contextmenu", state.onContextMenu, { capture: true });
    state.onTouch = (event) => {
      if (!event.type.startsWith("touch")) return;
      state.touchEvents.push({
        type: event.type,
        trusted: event.isTrusted,
        touchCount: event.touches.length,
        changedCount: event.changedTouches.length,
        time: performance.now(),
      });
    };
    for (const type of ["touchstart", "touchend", "touchcancel"]) document.addEventListener(type, state.onTouch, { capture: true, passive: true });
    state.processMutations = processMutations;
    state.sample = () => {
      const rect = panel.getBoundingClientRect();
      const className = String(panel.className);
      const style = panel.getAttribute("style") || "";
      const scratch = document.createElement("div");
      scratch.style.cssText = style;
      const transform = scratch.style.transform;
      const classOpen = panel.classList.contains("right-panel-open");
      const styleOpen = Boolean(transform && !/translate(?:X|3d)\(\s*100%[,)]/i.test(transform));
      const geometryVisible = rect.width > 1 && rect.right > 1 && rect.left < innerWidth - 1;
      const visible = classOpen || styleOpen || geometryVisible;
      const frame = {
        time: performance.now(),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        className,
        style,
        panelVisible: visible,
      };
      state.frames.push(frame);
      if (state.endedAt !== null) state.postGestureFrames += 1;
      const key = [frame.x, frame.y, frame.width, frame.height, frame.className, frame.style, frame.panelVisible].join("|");
      state.stableFrames = key === state.lastFrameKey && !panel.getAnimations({ subtree: false }).some((animation) => animation.playState === "running") ? state.stableFrames + 1 : 0;
      state.lastFrameKey = key;
      const elapsed = state.endedAt === null ? 0 : performance.now() - state.endedAt;
      if (state.endedAt !== null && elapsed >= 400 && state.postGestureFrames >= 2 && state.stableFrames >= 3) state.done = true;
      if (performance.now() - state.startedAt > 15_000) state.done = true;
      if (!state.done) requestAnimationFrame(state.sample);
    };
    window.__pi30141TouchProbe = state;
    requestAnimationFrame(state.sample);
  }, { panelSelector, gesture });
}

async function endProbe(page, nativeSelectionTarget = null) {
  await page.evaluate(() => {
    const state = window.__pi30141TouchProbe;
    if (state) state.endedAt = performance.now();
  });
  await page.waitForFunction(() => window.__pi30141TouchProbe?.done === true, undefined, { timeout: 18_000 });
  const result = await page.evaluate((targetSelector) => {
    const state = window.__pi30141TouchProbe;
    if (!state) throw new Error("Touch probe disappeared before collection");
    state.processMutations(state.observer.takeRecords());
    state.observer.disconnect();
    for (const type of ["touchstart", "touchend", "touchcancel"]) document.removeEventListener(type, state.onTouch, { capture: true });
    document.removeEventListener("contextmenu", state.onContextMenu, { capture: true });
    const selection = window.getSelection();
    const selectedText = selection?.toString() || "";
    const target = targetSelector ? document.querySelector(targetSelector) : null;
    let insideTarget = false;
    if (target && selection?.rangeCount) insideTarget = target.contains(selection.getRangeAt(0).commonAncestorContainer);
    const panel = state.panel;
    const rect = panel.getBoundingClientRect();
    const finalPanelOpen = panel.classList.contains("right-panel-open") || (rect.width > 1 && rect.right > 1 && rect.left < innerWidth - 1);
    const postGestureDurationMs = state.endedAt === null ? 0 : performance.now() - state.endedAt;
    const result = {
      schemaVersion: 1,
      gesture: state.gesture,
      touchEvents: state.touchEvents,
      contextMenuEvents: state.contextMenuEvents,
      frames: state.frames,
      mutationObserver: { target: "file-panel", attributes: ["class", "style"], transitions: state.transitions },
      postGestureDurationMs,
      postGestureFrames: state.postGestureFrames,
      finalPanelOpen,
      nativeSelection: targetSelector ? { observed: selectedText.length > 0, selectedLength: selectedText.length, insideTarget } : null,
    };
    delete window.__pi30141TouchProbe;
    return result;
  }, nativeSelectionTarget);
  return result;
}

async function runThreeFinger(page, viewport, gesture, panelSelector) {
  await beginProbe(page, panelSelector, gesture);
  const x = Math.round(viewport.width * 0.58);
  const y = Math.round(viewport.height * 0.42);
  const points = [
    { x, y, id: 1 },
    { x: x + 24, y: y + 20, id: 2 },
    { x: x + 48, y: y + 40, id: 3 },
  ];
  try {
    await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]] });
    await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
    await page.cdp("Input.dispatchTouchEvent", { type: gesture === "cancel" ? "touchCancel" : "touchEnd", touchPoints: [] });
    return await endProbe(page);
  } catch (error) {
    await page.evaluate(() => window.__pi30141TouchProbe?.observer.disconnect()).catch(() => {});
    throw error;
  }
}

async function runLongPress(page, config, geometry, target) {
  const point = await locateTextPoint(page, target);
  if (!point.textMatched || !point.inViewport) throw new Error(`Configured plain-text target is not visible: ${JSON.stringify(point)}`);
  const selectionClearedBeforeGesture = await clearSelectionAtPoint(page, point, target.selector, "native long press");
  await beginProbe(page, config.panelSelector, "longPress");
  try {
    await page.cdp("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(point.x), y: Math.round(point.y), id: 1 }],
    });
    await page.waitForTimeout(config.holdMs);
    const selectionDuringHold = await readSelectionState(page, target.selector);
    await page.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const result = await endProbe(page, target.selector);
    result.targetPoint = { x: point.x, y: point.y, textMatched: point.textMatched, inViewport: point.inViewport };
    result.viewport = geometry;
    result.selectionDuringHold = selectionDuringHold;
    result.selectionClearedBeforeGesture = selectionClearedBeforeGesture;
    result.cancelDelivered = result.touchEvents.some((event) => event.trusted && event.type === "touchcancel");
    result.contextMenuSeen = result.contextMenuEvents.some((event) => event.trusted);
    result.inputOrigin = "ego_browser_cdp_touch_dispatch";
    result.holdMs = config.holdMs;
    result.outcome = result.nativeSelection?.observed && result.nativeSelection.insideTarget
      ? "native_selection_observed_panel_closed"
      : "native_selection_unavailable";
    return result;
  } catch (error) {
    await page.evaluate(() => window.__pi30141TouchProbe?.observer.disconnect()).catch(() => {});
    throw error;
  }
}

async function readSelectionState(page, selector) {
  return page.evaluate((targetSelector) => {
    const selection = window.getSelection();
    const target = document.querySelector(targetSelector);
    const observed = Boolean(selection?.toString().length);
    const insideTarget = Boolean(target && selection?.rangeCount && target.contains(selection.getRangeAt(0).commonAncestorContainer));
    return { observed, insideTarget, selectedLength: selection?.toString().length || 0, isCollapsed: selection?.isCollapsed ?? true };
  }, selector);
}

async function clearSelectionAtPoint(page, point, selector, gesture) {
  await dispatchCssClick(page, Math.round(point.x), Math.round(point.y));
  const state = await readSelectionState(page, selector);
  if (state.observed || state.selectedLength !== 0) {
    throw new Error(`Could not clear the existing selection before ${gesture}: ${JSON.stringify(state)}`);
  }
  return state;
}

async function runSelectedTextCancel(page, config, geometry, target) {
  const baseline = await waitPanelStable(page, config.panelSelector);
  if (baseline.open) throw new Error("Selected-text cancel contract requires a closed-panel baseline");
  const point = await locateTextPoint(page, target);
  if (!point.textMatched || !point.inViewport) return { schemaVersion: 1, gesture: "selectedTextControlledCancel", status: "target_unavailable", targetPoint: point, viewport: geometry };
  const selectionClearedBeforeGesture = await clearSelectionAtPoint(page, point, target.selector, "selected-text double click");
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  for (const clickCount of [1, 2]) {
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
  }
  let selectionBeforeCancel;
  try {
    await page.waitForFunction((selector) => {
      const selected = window.getSelection();
      const target = document.querySelector(selector);
      return Boolean(selected?.toString().length && target && selected.rangeCount && target.contains(selected.getRangeAt(0).commonAncestorContainer));
    }, target.selector, { timeout: 3_000 });
    selectionBeforeCancel = await readSelectionState(page, target.selector);
  } catch {
    selectionBeforeCancel = await readSelectionState(page, target.selector);
  }
  if (!selectionBeforeCancel.observed || !selectionBeforeCancel.insideTarget) {
    return { schemaVersion: 1, gesture: "selectedTextControlledCancel", status: "native_selection_unavailable", selectionBeforeCancel, targetPoint: point, viewport: geometry };
  }
  const selectedPanelState = await waitPanelStable(page, config.panelSelector);
  if (selectedPanelState.open) throw new Error("Text selection opened the right panel before the controlled cancel");
  await beginProbe(page, config.panelSelector, "selectedTextControlledCancel");
  try {
    await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(point.x), y: Math.round(point.y), id: 1 }] });
    await page.waitForTimeout(config.holdMs);
    await page.cdp("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    const result = await endProbe(page, target.selector);
    result.viewport = geometry;
    result.targetPoint = { x: point.x, y: point.y, textMatched: true, inViewport: true };
    result.cancelOrigin = "test_harness_cdp_controlled";
    result.inputOrigin = "native_mouse_double_click_then_ego_cdp_touch_dispatch";
    result.selectionBeforeCancel = selectionBeforeCancel;
    result.selectionClearedBeforeGesture = selectionClearedBeforeGesture;
    result.selectionAfterCancel = result.nativeSelection;
    result.status = "observed";
    assertSelectedTextCancelEvidence(result);
    return result;
  } catch (error) {
    await page.evaluate(() => window.__pi30141TouchProbe?.observer.disconnect()).catch(() => {});
    throw error;
  }
}

async function writeReceipt(path, receipt) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export async function runGate(configInput) {
  const config = validateConfig(configInput);
  const shard = config.executionShard || null;
  if (shard && (!["pi", "codex"].includes(shard.engine) || ![390, 800, 1124].includes(shard.width))) {
    throw new Error("executionShard must identify one fixed engine/width combination");
  }
  if (typeof globalThis.taskSpace !== "function") throw new Error("Run this module inside ego-browser nodejs; taskSpace is unavailable");
  const task = await globalThis.taskSpace(config.spaceId);
  if (String(task.spaceId) !== String(config.spaceId)) throw new Error(`Resumed TaskSpace mismatch: ${task.spaceId}`);
  const pages = await task.pages();
  const page = pages.find((candidate) => candidate.label === config.pageLabel);
  if (!page) throw new Error(`Page ${config.pageLabel} is not present in existing TaskSpace ${config.spaceId}`);

  const receipt = {
    schemaVersion: 1,
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    taskSpaceId: task.spaceId,
    pageLabel: page.label,
    requested: {
      engines: config.engines,
      engineUrls: Object.fromEntries(Object.entries(config.engineUrls).map(([engine, value]) => {
        const url = new URL(value);
        return [engine, `${url.origin}${url.pathname}`];
      })),
      expectedBuildId: config.expectedBuildId,
      expectedAssetFingerprint: config.expectedAssetFingerprint,
      viewports: config.viewports,
    },
    executionShard: shard,
    cases: [],
    failures: [],
    capabilityGaps: [],
  };
  let metricsTouched = false;
  try {
    for (const engine of config.engines.filter((value) => !shard || value === shard.engine)) {
      await page.goto(config.engineUrls[engine]);
      const target = config.selectionTargets[engine];
      await waitForFixtureAndAsset(page, config, target);
      const currentUrl = new URL(await page.url());
      receipt.pageUrls ||= {};
      receipt.pageUrls[engine] = `${currentUrl.origin}${currentUrl.pathname}`;
      receipt.browser ||= await readBrowserIdentity(page);
      receipt.browser.isWindows = true;
      const build = await readBuildAndFingerprint(page, config);
      receipt.buildByEngine ||= {};
      receipt.buildByEngine[engine] = build;
      if (!receipt.build) receipt.build = build;
      else if (JSON.stringify(receipt.build) !== JSON.stringify(build)) throw new Error(`Build or asset fingerprint differs between ${engine} and ${config.engines[0]}`);

      for (const viewport of config.viewports.filter((value) => !shard || value.width === shard.width)) {
        try {
          metricsTouched = true;
          const geometry = await projectViewport(page, viewport, receipt.browser.devicePixelRatio);
          if (viewport.width === 390) geometry.sidebarPreparation = await hideSidebarAt390(page);
          const baseline = await waitPanelStable(page, config.panelSelector);
          if (baseline.open) await closePanel(page, config.panelSelector);
          for (const gesture of ["cancel", "end"]) {
            let result;
            try {
              result = await runThreeFinger(page, viewport, gesture, config.panelSelector);
              result.engine = engine;
              result.viewport = geometry;
              assertNoFlashEvidence(result);
            } catch (error) {
              if (result) result.error = error.message;
              else result = { schemaVersion: 1, engine, gesture, viewport: geometry, error: error.message };
              receipt.failures.push({ engine, viewport, gesture, error: error.message });
            }
            receipt.cases.push(result);
            await closePanel(page, config.panelSelector).catch((error) => receipt.failures.push({ engine, viewport, gesture, cleanupError: error.message }));
          }

          let longPress;
          try {
            await waitPanelStable(page, config.panelSelector);
            longPress = await runLongPress(page, config, geometry, target);
            longPress.engine = engine;
            assertLongPressEvidence(longPress);
            if (longPress.outcome === "native_selection_unavailable") {
              receipt.capabilityGaps.push({ engine, width: viewport.width, kind: "native-long-press-selection", contextMenuSeen: longPress.contextMenuSeen, cancelDelivered: longPress.cancelDelivered });
            }
          } catch (error) {
            if (longPress) longPress.error = error.message;
            else longPress = { schemaVersion: 1, engine, gesture: "longPress", viewport: geometry, error: error.message };
            receipt.failures.push({ engine, viewport, gesture: "longPress", error: error.message });
          }
          receipt.cases.push(longPress);
          await closePanel(page, config.panelSelector).catch((error) => receipt.failures.push({ engine, viewport, gesture: "longPress", cleanupError: error.message }));

          let selectedTextContract;
          try {
            selectedTextContract = await runSelectedTextCancel(page, config, geometry, target);
            selectedTextContract.engine = engine;
            if (selectedTextContract.status === "native_selection_unavailable" || selectedTextContract.status === "target_unavailable") {
              receipt.capabilityGaps.push({ engine, width: viewport.width, kind: "selected-text-controlled-cancel", status: selectedTextContract.status });
              throw new Error(`Required selected-text cancellation could not be exercised: ${selectedTextContract.status}`);
            }
          } catch (error) {
            if (selectedTextContract) selectedTextContract.error = error.message;
            else selectedTextContract = { schemaVersion: 1, engine, gesture: "selectedTextControlledCancel", viewport: geometry, error: error.message };
            receipt.failures.push({ engine, viewport, gesture: "selectedTextControlledCancel", error: error.message });
          }
          receipt.cases.push(selectedTextContract);
          await closePanel(page, config.panelSelector).catch((error) => receipt.failures.push({ engine, viewport, gesture: "selectedTextControlledCancel", cleanupError: error.message }));
        } catch (error) {
          receipt.failures.push({ engine, viewport, error: error.message });
        }
      }
    }
  } catch (error) {
    receipt.failures.push({ fatal: error.message });
  } finally {
    if (metricsTouched) {
      await page.cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.status = receipt.failures.length ? "failed" : "passed";
    receipt.outputPath = config.outputPath;
    await writeReceipt(config.outputPath, receipt);
  }
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.failures.length) throw new Error(`Windows touch gate failed; receipt: ${config.outputPath}`);
  return receipt;
}

if (typeof globalThis.taskSpace === "function") await runGate(await readConfig());
