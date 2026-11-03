import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

test("DOM feedback removal contract: dependencies and scripts removed", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies?.["html-to-image"], undefined, "html-to-image dependency must not exist");
  assert.equal(pkg.devDependencies?.["html-to-image"], undefined, "html-to-image devDependency must not exist");
  assert.doesNotMatch(pkg.scripts?.prebuild || "", /prepare-dom-feedback-assets/, "prebuild must not call prepare-dom-feedback-assets");
  assert.doesNotMatch(pkg.scripts?.prepack || "", /prepare-dom-feedback-assets/, "prepack must not call prepare-dom-feedback-assets");

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(lock.packages?.[""]?.dependencies?.["html-to-image"], undefined, "package-lock root must not contain html-to-image");
  assert.equal(lock.packages?.["node_modules/html-to-image"], undefined, "package-lock node_modules must not contain html-to-image");

  const depDisc = JSON.parse(fs.readFileSync(path.join(ROOT, "dependency-discovery.json"), "utf8"));
  const missingNames = (depDisc.missing || []).map(m => m.name);
  assert.ok(!missingNames.includes("html-to-image"), "dependency-discovery missing must not include html-to-image");

  const qaManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/qa/manifest.json"), "utf8"));
  const shardNames = (qaManifest.suites?.release?.shards || []).map(s => s.name);
  assert.ok(!shardNames.includes("release-dom-feedback"), "scripts/qa/manifest.json must not include release-dom-feedback shard");
});

test("DOM feedback removal contract: components use native iframe and no dom-feedback controls", () => {
  const appShell = fs.readFileSync(path.join(ROOT, "components/AppShell.tsx"), "utf8");
  assert.doesNotMatch(appShell, /DomFeedbackControl/, "AppShell must not import or render DomFeedbackControl");
  assert.doesNotMatch(appShell, /data-dom-feedback/, "AppShell must not contain data-dom-feedback attributes");

  const fileViewer = fs.readFileSync(path.join(ROOT, "components/FileViewer.tsx"), "utf8");
  assert.doesNotMatch(fileViewer, /DomFeedbackPreview/, "FileViewer must not import or render DomFeedbackPreview");
  assert.doesNotMatch(fileViewer, /data-dom-feedback/, "FileViewer must not contain data-dom-feedback attributes");
  assert.match(fileViewer, /<iframe\s+srcDoc=\{content\}\s+sandbox="allow-scripts"/, "FileViewer must use native iframe with allow-scripts sandbox");
});

test("DOM feedback removal contract: target files and directories deleted", () => {
  const targets = [
    "components/DomFeedbackControl.tsx",
    "components/DomFeedbackPreview.tsx",
    "components/dom-feedback",
    "lib/dom-feedback",
    "public/dom-feedback",
    "scripts/prepare-dom-feedback-assets.cjs",
    "scripts/qa/dom-feedback.cjs",
    "tests/dom-feedback-page.pw.mjs",
    "tests/dom-feedback-sourcemap.pw.mjs",
    "tests/dom-feedback.pw.mjs",
    "tests/fixtures/dom-feedback-helper.mjs",
    "tests/fixtures/dom-feedback-release.tsx"
  ];

  for (const rel of targets) {
    const full = path.join(ROOT, rel);
    assert.ok(!fs.existsSync(full), `Target must not exist: ${rel}`);
  }
});

test("DOM feedback removal contract: enhancement modules preserve quick-quote and history annotations", () => {
  const mod02 = fs.readFileSync(path.join(ROOT, "enhancements/modules/02-plugin-registry-and-settings-schema.js"), "utf8");
  assert.doesNotMatch(mod02, /id:\s*"dom-feedback"/, "Module 02 must not register dom-feedback plugin");
  assert.match(mod02, /id:\s*"quick-quote"/, "Module 02 must retain quick-quote plugin");

  const genSettings = fs.readFileSync(path.join(ROOT, "lib/enhancement-settings.generated.ts"), "utf8");
  assert.doesNotMatch(genSettings, /"dom-feedback":/, "Generated settings must not contain dom-feedback");
  assert.match(genSettings, /"quick-quote":/, "Generated settings must retain quick-quote");

  const mod04 = fs.readFileSync(path.join(ROOT, "enhancements/modules/04-sidebar-and-session-management.js"), "utf8");
  assert.doesNotMatch(mod04, /isPluginEnabled\("dom-feedback"\)/, "Module 04 must not check dom-feedback plugin enabled state");
  assert.match(mod04, /function enabledAnnotations\(\)/, "Module 04 must retain enabledAnnotations");

  const mod08 = fs.readFileSync(path.join(ROOT, "enhancements/modules/08-settings-panels-and-lifecycle.js"), "utf8");
  assert.doesNotMatch(mod08, /pi-dom-feedback-ready/, "Module 08 must not dispatch pi-dom-feedback-ready event");
});
