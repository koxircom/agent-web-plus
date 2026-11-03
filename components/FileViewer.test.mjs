import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const enhancementModule = await readFile(
  new URL("../enhancements/modules/06-chat-view-and-tool-cards.js", import.meta.url),
  "utf8",
);

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const useLightweightSource = sourceLines\.length > SOURCE_HIGHLIGHT_MAX_LINES/);

  // Both source trees are memoized so unrelated re-renders (panel open/close,
  // selection changes) reuse them instead of rebuilding every line element.
  assert.match(source, /const highlightedSource = useMemo\(/);

  const lightweightStart = source.indexOf("const lightweightSourceLines = useMemo(");
  const lightweightEnd = source.indexOf("[sourceLines, useLightweightSource, wrapLines]", lightweightStart);
  assert.notEqual(lightweightStart, -1);
  assert.notEqual(lightweightEnd, -1);

  const lightweightSource = source.slice(lightweightStart, lightweightEnd);
  assert.match(lightweightSource, /useLightweightSource \? sourceLines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);

  // The lightweight branch still wins over the syntax highlighter in the JSX.
  const branchStart = source.indexOf(") : useLightweightSource ? (");
  assert.notEqual(branchStart, -1);
  assert.match(source.slice(branchStart), /className="file-source-view is-lightweight"/);
  assert.notEqual(source.indexOf("highlightedSource", branchStart), -1);
});

test("lightweight source rows are skipped for highlighted, diff, and preview views", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false) => {
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const FILE_LINE_NUMBER_STYLE = {};
      ${calculations}
      return lightweightSourceLines;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(1_000), language: "text" };

  assert.equal(render({ ...large, content: "line\n".repeat(999) }, "source"), null);
  assert.equal(render(large, "diff", true), null);
  assert.equal(render(large, "source", true, true), null);
  for (const language of ["html", "markdown"]) {
    assert.equal(render({ ...large, language }, "preview"), null);
  }
  for (const mode of ["source", "diff", "preview"]) {
    const rows = render(large, mode);
    assert.equal(rows.length, 1_001, `${mode} must retain its source fallback`);
    assert.equal(rows[0].props["data-line-number"], 1);
    assert.equal(rows[0].props.children[1].props.children, "line");
  }
  assert.equal(render(large, "source", false, false, true)[0].props.children[1].props.style.whiteSpace, "pre-wrap");
});

test("markdown preview links carry PDF page fragments", () => {
  assert.match(source, /parsePdfPageFragment/);
  assert.match(source, /onOpenFile\(linkedFile, parsePdfPageFragment\(href\) \?\? undefined\)/);
});

test("Markdown mode controls and Copy Source stay under FileViewer ownership", () => {
  assert.match(source, /className="file-viewer-mode-switch"[\s\S]*?displayModes\.map\(\(mode\)/);
  assert.match(source, /onClick=\{\(\) => updateDisplayMode\(mode\)\}/);
  assert.match(source, /\{isMarkdown && obsidianMarkdownViewerEnabled && \(/);
  assert.match(source, /pi:obsidian-markdown-viewer-preferences-change/);
  assert.match(source, /"复制源码"[\s\S]*?"已复制"|"已复制"[\s\S]*?"复制源码"/);
  assert.match(source, /title="复制源码全文"/);
  assert.match(source, /while \(truncated\)[\s\S]*getFileApiUrl\(filePath, "read", sourceSessionId, \{ offset \}, executionEngine\)/);
  assert.match(source, /navigator\.clipboard\.writeText\(source\)/);
  assert.match(source, /await navigator\.clipboard\.writeText\(source\)[\s\S]*?catch \{[\s\S]*?if \(stopIfStale\(\)\) return;[\s\S]*?document\.execCommand\("copy"\)/);
  assert.match(source, /useEffect\(\(\) => \{\s*viewerIdentityRef\.current = \{ filePath, sourceSessionId, executionEngine, cwd \};[\s\S]*?return \(\) => \{[\s\S]*?contentRequestRef\.current\+\+;[\s\S]*?viewerIdentityRef\.current = null;/);
  assert.match(source, /\.\.\.\(hasGitDiff \? \["diff" as const\] : \[\]\)/);

  assert.doesNotMatch(enhancementModule, /pi-enh-md-mode-switch|pi-enh-md-btn|previewBtn\.click\(\)|sourceBtn\.click\(\)/);
  assert.match(enhancementModule, /pi:obsidian-markdown-viewer-preferences-change/);
});

test("file watch streams release EventSource when hidden and reconnect when visible", () => {
  // 1. 验证 useIsPageVisible 包含 visibilitychange, pageshow, pagehide
  assert.match(source, /function useIsPageVisible\(\): boolean/);
  assert.match(source, /document\.addEventListener\("visibilitychange", handleVisibility\)/);
  assert.match(source, /window\.addEventListener\("pageshow", handleShow\)/);
  assert.match(source, /window\.addEventListener\("pagehide", handleHide\)/);
  assert.match(source, /document\.removeEventListener\("visibilitychange", handleVisibility\)/);
  assert.match(source, /window\.removeEventListener\("pageshow", handleShow\)/);
  assert.match(source, /window\.removeEventListener\("pagehide", handleHide\)/);

  // 2. 验证各个 viewer 统一使用 useFileWatch 并且传入 isPageVisible 和 watchEnabled 守卫，彻底移除 EventSource/esRef
  assert.doesNotMatch(source, /new EventSource\(/, "all EventSource usage must be removed in favor of short fetch");
  assert.doesNotMatch(source, /esRef/, "esRef must be removed");
  for (const name of ["ImageViewer", "AudioViewer", "VideoViewer", "DocumentViewer", "TextFileViewer"]) {
    const fnStart = source.indexOf(`function ${name}(`);
    assert.notEqual(fnStart, -1, `${name} must exist`);
    const nextFn = source.indexOf("function ", fnStart + 1);
    const fnEnd = nextFn !== -1 ? nextFn : source.length;
    const fnBody = source.slice(fnStart, fnEnd !== -1 ? fnEnd : fnStart + 3000);

    assert.match(fnBody, /const isPageVisible = useIsPageVisible\(\);/, `${name} must consume useIsPageVisible`);
    assert.match(fnBody, /useFileWatch\(\{[\s\S]*?watchEnabled[\s\S]*?isPageVisible[\s\S]*?\}\)/, `${name} must invoke useFileWatch with watchEnabled and isPageVisible`);
  }

  // 3. 验证 handleShow 必须读取 visibilityState 且挂载后立即核对当前 visibility
  assert.match(source, /handleVisibility\(\);/, "useEffect must check visibility immediately on subscribe");
  assert.doesNotMatch(source, /handleShow\s*=\s*\(\)\s*=>\s*setIsVisible\(true\)/, "handleShow must not unconditionally set visible to true");

  // 4. 小范围函数行为测试：后台 pageshow 不恢复占槽，前台 pageshow / visible 恢复，pagehide 释放
  let visibleState = true;
  const setVisible = (val) => { visibleState = val; };
  const mockDoc = { visibilityState: "hidden" };
  const readVisible = () => (typeof mockDoc !== "undefined" ? mockDoc.visibilityState !== "hidden" : true);

  const handleVisibility = () => setVisible(readVisible());
  const handleHide = () => setVisible(false);
  const handleShow = () => setVisible(readVisible());

  // 初始挂载立即复核
  handleVisibility();
  assert.equal(visibleState, false, "initial effect check identifies hidden page");

  // 后台 pageshow（例如 bfcache 恢复但在后台）：必须保持 false，绝不恢复占槽
  mockDoc.visibilityState = "hidden";
  handleShow();
  assert.equal(visibleState, false, "pageshow while hidden must remain false");

  // 前台 pageshow
  mockDoc.visibilityState = "visible";
  handleShow();
  assert.equal(visibleState, true, "pageshow while visible restores true");

  // pagehide
  handleHide();
  assert.equal(visibleState, false, "pagehide deactivates");
});
