import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownUrlTransform,
  normalizeDisplayMath,
} = await jiti.import("../lib/markdown.ts");
const ReactMarkdown = (await jiti.import("react-markdown")).default;
const { createMarkdownMathPresencePlugin, isMarkdownMathCode } = await jiti.import("../lib/markdown-math.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        ...props,
      }, markdown),
    ),
  );
}

function renderServerMarkdownWithMath(markdown) {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: markdownRemarkPlugins,
        rehypePlugins: markdownRehypePlugins,
        urlTransform: markdownUrlTransform,
      },
      normalizeDisplayMath(markdown),
    ),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const relativeHtml = renderMarkdown("[file](components/MarkdownBody.tsx)");
  const fileUrlHtml = renderMarkdown("[report](file:///home/me/project/report.html)");

  assert.match(relativeHtml, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(relativeHtml, /target=|rel=|\snode=/);
  assert.match(fileUrlHtml, /<a href="file:\/\/\/home\/me\/project\/report\.html">report<\/a>/);
  assert.doesNotMatch(fileUrlHtml, /target=|rel=|\snode=/);
});

test("keeps file URLs inert without an in-app file handler", () => {
  const html = renderMarkdown("[report](file:///home/me/project/report.html)", { onOpenFile: undefined });

  assert.match(html, /<a href="" target="_blank" rel="noopener noreferrer">report<\/a>/);
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /5~7U/);
  assert.match(html, /100~200倍/);
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders backslash-escaped backticks inside inline code", () => {
  const html = renderMarkdown("`AudioManager\\`1.cs`");

  assert.match(html, /<code[^>]*>AudioManager`1\.cs<\/code>/);
  assert.doesNotMatch(html, /<\/code>1\.cs`/);
});

test("keeps inline math readable in server markup before the browser loads KaTeX", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /<code class="[^"]*math-inline[^"]*">r_c = K\^\{-1\}p<\/code>/);
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("keeps display math readable in server markup before the browser loads KaTeX", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /<code class="[^"]*math-display[^"]*">[\s\S]*lambda[\s\S]*<\/code>/);
  assert.doesNotMatch(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="[^"]*math-display[^"]*"/);
});

test("retains the static server renderer pipeline with sanitization before KaTeX", () => {
  assert.equal(markdownRehypePlugins.length, 3);
  assert.equal(markdownRehypePlugins[0].name, "rehypeRaw");
  assert.equal(markdownRehypePlugins[1][0].name, "rehypeSanitize");
  assert.equal(markdownRehypePlugins[2][0].name, "rehypeKatex");
});

test("the server compatibility entrypoint still renders math synchronously", () => {
  const html = renderServerMarkdownWithMath(String.raw`\(r_c = K^{-1}p\)`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("detects only actual math AST nodes, not code nodes", () => {
  let detections = 0;
  const transformer = createMarkdownMathPresencePlugin(() => detections++)();

  transformer({ type: "root", children: [{ type: "inlineCode", value: "$x$" }] });
  assert.equal(detections, 0);
  transformer({ type: "root", children: [{ type: "code", lang: null, value: "$$x$$" }] });
  assert.equal(detections, 0);
  transformer({ type: "root", children: [{ type: "inlineMath", value: "x" }] });
  assert.equal(detections, 1);
  transformer({ type: "root", children: [{ type: "math", value: "x" }] });
  assert.equal(detections, 2);
  assert.equal(isMarkdownMathCode("language-math math-display"), true);
  assert.equal(isMarkdownMathCode("language-js"), false);
});

test("keeps KaTeX and its stylesheet behind one dynamic client entrypoint", async () => {
  const [bodySource, viewerSource, hookSource, runtimeSource, layoutSource, safeModuleSource] = await Promise.all([
    readFile(new URL("./MarkdownBody.tsx", import.meta.url), "utf8"),
    readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("./useMarkdownMathPlugins.ts", import.meta.url), "utf8"),
    readFile(new URL("./MarkdownKatexRuntime.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/markdown-math.ts", import.meta.url), "utf8"),
  ]);

  assert.match(bodySource, /useMarkdownMathPlugins/);
  assert.match(viewerSource, /useMarkdownMathPlugins/);
  assert.doesNotMatch(bodySource, /rehype-katex|@\/lib\/markdown["']/);
  assert.doesNotMatch(viewerSource, /rehype-katex|@\/lib\/markdown["']/);
  assert.match(hookSource, /import\(["']\.\/MarkdownKatexRuntime["']\)/);
  assert.doesNotMatch(hookSource, /\bfrom\s*["']\.\/MarkdownKatexRuntime["']/);
  assert.doesNotMatch(safeModuleSource, /rehype-katex|katex\/dist/);
  assert.match(runtimeSource, /from ["']rehype-katex["']/);
  assert.match(runtimeSource, /katex\/dist\/katex\.min\.css/);
  assert.doesNotMatch(layoutSource, /katex\.min\.css/);
});

test("keeps model-emitted bracket-only formula lines readable during server rendering", () => {
  const html = renderMarkdown(String.raw`平均一致性：

[ C(x) = \frac{2}{T(T-1)} \sum_{i<j} S(\hat{y}^{(i)}, \hat{y}^{(j)}) ]`);

  assert.match(html, /class="[^"]*math-display[^"]*"/);
  assert.match(html, /\\sum/);
  assert.doesNotMatch(html, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("previews completed Mermaid diagrams by default", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");

  assert.match(html, /mermaid-block-loading/);
  assert.match(html, />源代码</);
  assert.doesNotMatch(html, /A --&gt; B/);
});

test("keeps Mermaid source visible while the response is streaming", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", { isStreaming: true });

  assert.doesNotMatch(html, /mermaid-block-loading/);
  assert.match(html, />预览</);
  assert.match(html, /A --&gt; B/);
});

test("opens markdown images in the shared image preview", () => {
  const localHtml = renderMarkdown("![chart](docs/tmp/chart.png)");
  const remoteHtml = renderMarkdown("![logo](https://example.com/logo.png)");

  assert.match(localHtml, /<button[^>]+aria-label="预览图片: chart"[^>]*>/);
  assert.match(localHtml, /<img[^>]+src="\/api\/files\/home\/me\/project\/docs\/tmp\/chart\.png\?type=read"/);
  assert.match(localHtml, /<img[^>]+alt="chart"/);
  assert.match(remoteHtml, /<button[^>]+aria-label="预览图片: logo"[^>]*>/);
  assert.match(remoteHtml, /<img[^>]+src="https:\/\/example\.com\/logo\.png"/);
});

test("keeps linked markdown images as links instead of nested preview buttons", () => {
  const html = renderMarkdown("[![diagram](docs/tmp/diagram.png)](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")[^>]*>/,
  );
  assert.match(html, /<img[^>]+alt="diagram"/);
  assert.doesNotMatch(html, /<a[^>]*>[\s\S]*<button/);
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*<\/a>/);
});

test("uses a generic preview label when a markdown image has no alt text", () => {
  const html = renderMarkdown("![](https://example.com/shot.png)");

  assert.match(html, /<button[^>]+aria-label="预览图片"[^>]*>/);
  assert.doesNotMatch(html, /预览图片:/);
});


test("opens complete HTTP and HTTPS inline-code URLs in a safe new tab", () => {
  for (const url of ["http://103.170.217.198:8317", "http://103.170.217.198:8317/management.html", "https://example.com/docs?q=1#section"]) {
    const html = renderMarkdown("`" + url + "`");
    assert(html.includes('href="' + url + '"'));
    assert.match(html, /target="_blank" rel="noopener noreferrer"><code class="markdown-inline-code"/);
    assert.doesNotMatch(html, /\snode=/);
    assert(html.includes(url + "</code></a>"));
  }
});

test("leaves commands, code blocks and non-HTTP schemes as code", () => {
  for (const code of ["curl http://example.com", "javascript:alert(1)", "data:text/html,hello", "file:///tmp/report.html", "ftp://example.com", "https://", "http://example.com:99999"]) {
    const html = renderMarkdown("`" + code + "`");
    assert.doesNotMatch(html, /<a\b/);
    assert.match(html, /class="markdown-inline-code"/);
  }
  for (const markdown of ["```text\nhttp://example.com\n```", "    http://example.com"]) {
    assert.doesNotMatch(renderMarkdown(markdown), /<a\b/);
  }
});

test("does not nest links when an inline-code URL is already a link label", () => {
  const html = renderMarkdown("[`http://example.com`](https://example.com/docs)");
  assert.equal((html.match(/<a\b/g) ?? []).length, 1);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /<code class="markdown-inline-code">http:\/\/example.com<\/code>/);
});
