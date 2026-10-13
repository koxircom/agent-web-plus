import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const cssSource = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");

const nativeMenuOwners = [
  {
    file: "components/SessionSidebar.tsx",
    pattern: /className="pi-native-menu-motion"\s+data-menu-motion-state=\{open \? "open" : "closed"\}\s+inert=\{!open\}\s+aria-hidden=\{!open\}/,
  },
  {
    file: "components/ModelSelector.tsx",
    pattern: /className="pi-native-menu-motion"\s+role="listbox"/,
  },
  {
    file: "components/ThinkingSelector.tsx",
    pattern: /className="thinking-selector-menu pi-native-menu-motion"/,
  },
  {
    file: "components/BranchNavigator.tsx",
    pattern: /className="pi-native-menu-motion"/g,
    count: 2,
  },
];

for (const { file, pattern, count = 1 } of nativeMenuOwners) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const matches = source.match(pattern);
  assert.equal(matches?.length ?? 0, count, `${file} must use the shared menu motion`);
}

assert.match(cssSource, /@keyframes pi-native-menu-enter[\s\S]*?from\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?translate:\s*0 -8px;[\s\S]*?scale:\s*0\.95;/);
assert.match(cssSource, /to\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?translate:\s*0 0;[\s\S]*?scale:\s*1;/);
assert.match(cssSource, /\.pi-native-menu-motion\s*\{\s*animation:\s*pi-native-menu-enter 200ms cubic-bezier\(0\.333333, 1, 0\.666667, 1\) both;/);
assert.match(cssSource, /\.pi-native-menu-motion\[data-menu-motion-state="closed"\]\s*\{\s*animation-name:\s*pi-native-menu-exit;/);
assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.pi-native-menu-motion,[\s\S]*?\.pi-native-menu-motion\[data-menu-motion-state="closed"\]\s*\{\s*animation:\s*none;/);
assert.doesNotMatch(cssSource.match(/@keyframes pi-native-menu-enter\s*\{[\s\S]*?\n\}/)?.[0] ?? "", /transform\s*:/);

let chromium;
let compileSettingsCss;
let esbuild;
({ chromium } = require(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright"));
esbuild = require(process.env.COMPOSER_ESBUILD_MODULE || "esbuild");
({ compileSettingsCss } = require("./native-settings-css.cjs"));

const fixtureSource = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { I18nProvider } from './hooks/useI18n';
  import { ModelSelector } from './components/ModelSelector';
  import { ThinkingSelector } from './components/ThinkingSelector';
  import { BranchNavigator } from './components/BranchNavigator';

  function Fixture() {
    return <I18nProvider initialLocale="en">
      <main style={{ display: 'flex', gap: 24, padding: 32 }}>
        <div id="model-root"><ModelSelector
          ariaLabel="Model menu"
          options={[{ provider: 'fixture', modelId: 'fixture-model', name: 'Fixture model' }]}
          value={{ provider: 'fixture', modelId: 'fixture-model' }}
          onChange={() => {}}
        /></div>
        <div id="thinking-root"><ThinkingSelector
          levels={['auto', 'low']}
          value="auto"
          displayLabel="Auto"
          descriptions={{ auto: 'Automatic', low: 'Low' }}
          label="Thinking menu"
          title="Thinking level"
          disabled={false}
          native={true}
          onChange={() => {}}
        /></div>
        <div id="branch-root"><BranchNavigator
          tree={[]}
          activeLeafId={null}
          onLeafChange={() => {}}
          hasSession={false}
        /></div>
      </main>
    </I18nProvider>;
  }

  createRoot(document.getElementById('root')).render(<Fixture />);
`;
const fixtureBundle = esbuild.buildSync({
  stdin: { contents: fixtureSource, resolveDir: root, loader: "tsx" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  nodePaths: [path.join(root, "node_modules")],
  alias: { "@": root },
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
}).outputFiles[0].text;
const css = await compileSettingsCss();
const composerCss = fs.readFileSync(path.join(root, "app/composer.css"), "utf8");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  ...(process.env.COMPOSER_CHROMIUM_PATH ? { executablePath: process.env.COMPOSER_CHROMIUM_PATH } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent(`<!doctype html><html data-theme="dark"><head><style>${css}\n${composerCss}
    html, body, #root { min-height: 100%; margin: 0; background: var(--bg); color: var(--text); }
  </style></head><body><div id="root"></div><script>${fixtureBundle}</script></body></html>`);

  await page.getByRole("button", { name: "Model menu" }).click();
  const modelMenu = page.getByRole("listbox", { name: "Model menu" });
  await modelMenu.waitFor();
  const entry = await modelMenu.evaluate(async (element) => {
    element.style.transform = "translateX(12px)";
    const animation = element.getAnimations().find((candidate) => candidate.animationName === "pi-native-menu-enter");
    if (!animation) throw new Error("native menu entry animation was not created");
    animation.pause();
    animation.currentTime = 0;
    const start = {
      opacity: getComputedStyle(element).opacity,
      translate: getComputedStyle(element).translate,
      scale: getComputedStyle(element).scale,
      transform: getComputedStyle(element).transform,
    };
    const timing = animation.effect?.getTiming();
    animation.currentTime = 200;
    const end = {
      opacity: getComputedStyle(element).opacity,
      translate: getComputedStyle(element).translate,
      scale: getComputedStyle(element).scale,
      transform: getComputedStyle(element).transform,
    };
    return { name: animation.animationName, timing, easing: getComputedStyle(element).animationTimingFunction, start, end };
  });
  assert.equal(entry.name, "pi-native-menu-enter");
  assert.equal(entry.timing.duration, 200);
  assert.equal(entry.easing, "cubic-bezier(0.333333, 1, 0.666667, 1)");
  assert.equal(entry.start.opacity, "0");
  assert.match(entry.start.translate, /-8px/);
  assert.equal(entry.start.scale, "0.95");
  assert.equal(entry.end.opacity, "1");
  assert.equal(entry.end.scale, "1");
  assert.equal(entry.start.transform, "matrix(1, 0, 0, 1, 12, 0)");
  assert.equal(entry.end.transform, entry.start.transform, "motion must preserve the menu's positioning transform");

  await page.getByRole("button", { name: "Thinking menu" }).click();
  const thinkingMenu = page.getByRole("listbox", { name: "Thinking menu" });
  await thinkingMenu.waitFor();
  const thinkingAnimation = await thinkingMenu.evaluate((element) => ({
    name: element.getAnimations().find((candidate) => candidate.animationName === "pi-native-menu-enter")?.animationName,
    duration: element.getAnimations().find((candidate) => candidate.animationName === "pi-native-menu-enter")?.effect?.getTiming().duration,
  }));
  assert.equal(thinkingAnimation.name, "pi-native-menu-enter");
  assert.equal(thinkingAnimation.duration, 200);

  await page.getByRole("button", { name: /branches/i }).click();
  const branchMenu = page.locator("#branch-root .pi-native-menu-motion");
  await branchMenu.waitFor();
  const branchAnimation = await branchMenu.evaluate((element) => element.getAnimations()
    .find((candidate) => candidate.animationName === "pi-native-menu-enter")?.animationName);
  assert.equal(branchAnimation, "pi-native-menu-enter");

  const exitName = await page.evaluate(() => {
    const element = document.createElement("div");
    element.className = "pi-native-menu-motion";
    element.dataset.menuMotionState = "open";
    document.body.append(element);
    const enter = element.getAnimations().find((candidate) => candidate.animationName === "pi-native-menu-enter");
    if (!enter) throw new Error("shared dropdown entry animation was not created");
    enter.pause();
    enter.currentTime = 200;
    element.dataset.menuMotionState = "closed";
    return new Promise((resolve) => requestAnimationFrame(() => {
      const exit = element.getAnimations().find((candidate) => candidate.animationName === "pi-native-menu-exit");
      if (!exit) throw new Error("shared dropdown exit animation was not created");
      exit.pause();
      exit.currentTime = 0;
      resolve({ name: exit.animationName, opacity: getComputedStyle(element).opacity, scale: getComputedStyle(element).scale });
    }));
  });
  assert.equal(exitName.name, "pi-native-menu-exit");
  assert.equal(exitName.opacity, "1");
  assert.equal(exitName.scale, "1");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: /branches/i }).click();
  const reducedMotion = await page.evaluate(() => {
    const element = document.createElement("div");
    element.className = "pi-native-menu-motion";
    element.dataset.menuMotionState = "closed";
    document.body.append(element);
    const style = getComputedStyle(element);
    return { animationName: style.animationName, display: style.display, animations: element.getAnimations().length };
  });
  assert.equal(reducedMotion.animationName, "none");
  assert.equal(reducedMotion.display, "none", "reduced-motion close hides the dropdown immediately");
  assert.equal(reducedMotion.animations, 0);
  assert.deepEqual(pageErrors, [], "native menu fixture must render without runtime errors");

  console.log("Menu motion passed: upstream geometry/easing, transform preservation, dropdown exit, and reduced motion.");
} finally {
  await browser.close();
}
