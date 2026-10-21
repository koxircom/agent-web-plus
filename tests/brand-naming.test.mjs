import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function readRootFile(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), "utf8");
}

test("package.json 和 package-lock.json 版本符合合法 SemVer 且根与 package-lock 一致，关键兼容字段完整", () => {
  const pkg = JSON.parse(readRootFile("package.json"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "package.json 版本应为合法 SemVer");
  assert.equal(pkg.name, "@agegr/pi-web", "npm 内部包名应保留 @agegr/pi-web 以便兼容原位升级");
  assert.equal(pkg.bin["agent-web"], "bin/agent-web.js", "应支持 agent-web 启动入口");
  assert.equal(pkg.bin["pi-web"], "bin/pi-web.js", "应保留 pi-web 兼容启动入口");
  assert.equal(pkg.standalone, true, "应保留 standalone 发行版特性标识");

  const lock = JSON.parse(readRootFile("package-lock.json"));
  assert.equal(lock.version, pkg.version, "package-lock.json 根版本应与 package.json 一致");
  assert.equal(lock.packages[""].version, pkg.version, "package-lock.json packages[''] 版本应与 package.json 一致");
});

test("public/offline.html 离线字标严格对齐 lib/branding.ts 矢量几何事实源", () => {
  const offlineHtml = readRootFile("public/offline.html");

  // 验证基础 viewBox 与标题
  assert.match(offlineHtml, /viewBox="0 0 816 186"/, "SVG viewBox 应为 0 0 816 186");
  assert.match(offlineHtml, /<title>Agent Web Plus 离线<\/title>/, "页面标题应为 Agent Web Plus 离线");

  // 验证 wordmark 矢量几何
  assert.match(offlineHtml, /font-size:\s*64px;/, "字标 font-size 应严格为 64px");
  assert.match(offlineHtml, /letter-spacing:\s*normal;/, "字标 letter-spacing 应为 normal");
  assert.match(offlineHtml, /x1="620"/, "plusGradient 起始坐标 x1 应为 620");

  // 验证字标文字
  assert.match(offlineHtml, /<tspan fill="#ffffff">Agent Web <\/tspan>/, "应包含 Agent Web 字标");
  assert.match(offlineHtml, /<tspan fill="url\(#plusGradient\)">Plus<\/tspan>/, "应包含 Plus 渐变字标");

  // 严防旧字标回退
  assert.doesNotMatch(offlineHtml, /<tspan x="230" y="138">Pi<\/tspan>/, "不应再出现旧的 Pi 字标");
  assert.doesNotMatch(offlineHtml, /font-size:\s*94px/, "不应使用旧的 94px 大字号");
});

test("各语言文档及发布规范统一收敛为规范安装包 agent-web-plus-1.4.10.tgz", () => {
  const readmeZh = readRootFile("README.md");
  const readmeZhCn = readRootFile("README.zh-CN.md");
  const readmeJa = readRootFile("README.ja.md");
  const readmeRu = readRootFile("README.ru.md");
  const releaseDoc = readRootFile("docs/release.md");
  const compatDoc = readRootFile("docs/agent-web-compatibility.md");

  // 中文 README 包含规范包名与两入口说明
  assert.match(
    readmeZh,
    /releases\/download\/v1\.4\.10\/agent-web-plus-1\.4\.10\.tgz/,
    "README.md 应提供 agent-web-plus-1.4.10.tgz 下载命令",
  );
  assert.doesNotMatch(
    readmeZh,
    /pi-web-plus-1\.4\.0\.tgz/,
    "README.md 不应再使用旧版 1.4.0 的安装命令",
  );
  assert.match(
    readmeZhCn,
    /Agent Web Plus.*包含.*Pi Web Plus.*与.*Codex Web Plus.*两大入口/,
    "README.zh-CN.md 应包含两入口说明",
  );

  // 日文与俄文 README 包含规范包名与两入口说明
  assert.match(
    readmeJa,
    /releases\/download\/v1\.4\.10\/agent-web-plus-1\.4\.10\.tgz/,
    "README.ja.md 应提供 agent-web-plus-1.4.10.tgz 下载命令",
  );
  assert.match(
    readmeJa,
    /Pi Web Plus.*Codex Web Plus/,
    "README.ja.md 应说明 Pi Web Plus 与 Codex Web Plus 两入口",
  );

  assert.match(
    readmeRu,
    /releases\/download\/v1\.4\.10\/agent-web-plus-1\.4\.10\.tgz/,
    "README.ru.md 应提供 agent-web-plus-1.4.10.tgz 下载命令",
  );
  assert.match(
    readmeRu,
    /Pi Web Plus.*Codex Web Plus/,
    "README.ru.md 应说明 Pi Web Plus 与 Codex Web Plus 两入口",
  );

  // 发布与兼容文档说明
  assert.match(
    releaseDoc,
    /agent-web-plus-<\s*版本\s*>\.tgz|agent-web-plus-\${VERSION}\.tgz/,
    "docs/release.md 应将规范包名收敛为 agent-web-plus",
  );
  assert.match(
    compatDoc,
    /agent-web-plus-<\s*版本\s*>\.tgz/,
    "docs/agent-web-compatibility.md 应记录规范包名收敛",
  );
});

test("中文主文档 README.md 清晰定义产品层级、两入口、共享架构与切换菜单", () => {
  const readme = readRootFile("README.md");

  // 验证总品牌与两入口层级
  assert.match(readme, /Agent Web Plus.*包含.*Pi Web Plus.*与.*Codex Web Plus.*两大入口/, "应明确总品牌包含两入口");
  assert.match(readme, /共享同一个工作台前端与后台服务实例，无需分别安装/, "应明确共享工作台架构而非独立安装");

  // 验证左上角菜单项对应入口
  assert.match(readme, /Pi Agent.*对应.*Pi Web Plus.*Codex.*对应.*Codex Web Plus/, "应说明切换菜单对应的两入口");

  // 视频文案介绍两入口
  assert.match(readme, /介绍 Agent Web Plus 双入口/, "视频介绍文案应面向双入口");
  // 不再声称未对接会话删除（1.4.5 已支持）
  assert.doesNotMatch(readme, /会话删除/, "不应再出现未对接会话删除的错误陈述");

  // 严防旧版本 1.4.0 作为当前介绍版本
  assert.doesNotMatch(readme, /本文介绍面向 \*\*1\.4\.0\*\*/, "不应再出现本文介绍面向 1.4.0");
  assert.match(readme, /本文介绍面向 \*\*1\.4\.10\*\*/, "当前介绍应面向 1.4.10");
});

test("日文与俄文文档准确说明双引擎层级与共享架构，不再声称仅面向 Pi 引擎", () => {
  const ja = readRootFile("README.ja.md");
  const ru = readRootFile("README.ru.md");

  // 日文不再单称 pi 引擎专属，准确说明层级与共享
  assert.doesNotMatch(
    ja,
    /pi コーディングエージェント.*向けのスタンドアロン版ローカルブラウザー UI です/,
    "日文文档不应继续声称仅面向 pi 引擎",
  );
  assert.match(ja, /Pi Agent.*Codex.*統合ローカル Web ワークスペース/, "日文文档应准确说明双引擎统合工作台");
  assert.match(ja, /Pi Web Plus.*Codex Web Plus/, "日文文档应说明两入口");
  assert.match(ja, /別々にインストールする必要はありません/, "日文文档应说明共享工作台无需分别安装");

  // 俄文不再单称 pi 引擎专属，准确说明层级与共享
  assert.doesNotMatch(
    ru,
    /Автономный локальный браузерный интерфейс для pi coding agent/,
    "俄文文档不应继续声称仅面向 pi 引擎",
  );
  assert.match(ru, /единая локальная браузерная платформа.*Pi Agent.*Codex/, "俄文文档应准确说明双引擎统合工作台");
  assert.match(ru, /Pi Web Plus.*Codex Web Plus/, "俄文文档应说明两入口");
  assert.match(ru, /не требуют раздельной установки/, "俄文文档应说明共享工作台无需分别安装");
});

test("区分 PWA display standalone 为技术展示模式，而非品牌名称", () => {
  const manifestTs = readRootFile("app/manifest.ts");
  const pkg = JSON.parse(readRootFile("package.json"));

  // PWA display standalone 是 W3C 标准属性，品牌名为 Agent Web Plus
  assert.match(manifestTs, /display:\s*"standalone"/, "manifest 中 display 应为 standalone 显示模式");
  assert.match(manifestTs, /name:\s*BRAND_NAME/, "manifest 中 name 应为 BRAND_NAME 常量 (Agent Web Plus)");
  assert.equal(pkg.description.includes("Agent Web Plus"), true, "package.json description 应为 Agent Web Plus");
  assert.equal(pkg.standalone, true, "package.json standalone 为独立发行版属性");
});
