// Exercise the real MarkdownBody React component in an isolated browser fixture.
// Compare its eager static-KaTeX payload with the candidate lazy loader:
//   PI_PERF_BASELINE=1 PI_PERF_RESULT_PATH=/tmp/markdown-before.json node tests/markdown-lazy.pw.mjs
//   PI_PERF_RESULT_PATH=/tmp/markdown-after.json node tests/markdown-lazy.pw.mjs
// Set PI_PERF_SOURCE_ROOT when running this script from a separate checkout.
// The esbuild CSS adapter below is fixture-only; Next owns production CSS chunking.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.env.PI_PERF_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const load = createRequire(path.join(root, "package.json"));
const esbuild = load("esbuild");
const { chromium } = load(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const baseline = process.env.PI_PERF_BASELINE === "1";
const waitTimeoutMs = 8_000;
const quietWindowMs = 180;
const buildOutdir = path.join(root, ".pi-perf-markdown-lazy-output");
const katexDistDir = path.dirname(load.resolve("katex"));
const katexCssPath = path.join(katexDistDir, "katex.min.css");
const katexCss = readFileSync(katexCssPath);

assert.ok(katexCss.includes(Buffer.from(".katex")), "the installed KaTeX stylesheet must contain KaTeX rules");

const baselineImports = baseline
  ? `import rehypeKatex from "rehype-katex";\nimport "katex/dist/katex.min.css";\n(window as any).__baselineRehypeKatex = rehypeKatex;`
  : "";

const bundle = await esbuild.build({
  absWorkingDir: root,
  stdin: {
    resolveDir: root,
    sourcefile: "tests/markdown-lazy-fixture.tsx",
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { MarkdownBody } from "./components/MarkdownBody";
      ${baselineImports}

      const sanitizeInput = ${JSON.stringify(
        "<script>window.__markdownLazyXss = true</script>\n" +
        "<iframe src=\"/unsafe-frame\">frame text</iframe>\n" +
        "<object data=\"/unsafe-object\">object text</object>\n" +
        "<style>.markdown-body { display: none }</style>\n" +
        "<form><input name=\"unsafe\"></form>\n" +
        "<a href=\"javascript:window.__markdownLazyXss=true\" onclick=\"window.__markdownLazyXss=true\">unsafe link</a>\n" +
        "<span style=\"color:red\" onclick=\"window.__markdownLazyXss=true\">safe text</span>",
      )};
      const baselineMode = ${JSON.stringify(baseline)};
      (window as any).fixture = { setMathEnabled: null };

      function App() {
        const [mathEnabled, setMathEnabled] = React.useState(false);
        React.useEffect(() => {
          (window as any).fixture.setMathEnabled = setMathEnabled;
        }, []);

        const items = [
          ["plain", "A plain message with no formula."],
          ["inline-code", "Code stays literal: " + String.fromCharCode(96) + "$x^2$" + String.fromCharCode(96) + "."],
          ["dollar-text", "Currency stays literal: " + String.fromCharCode(92) + "$5.00 USD."],
          ["sanitize", sanitizeInput],
          ["inline-math", mathEnabled ? "Inline formula: $\\\\frac{1}{2}$" : "Inline formula target."],
          ["block-math", mathEnabled ? "$$\\nE = mc^2\\n$$" : "Block formula target."],
          ["peer-math", mathEnabled ? "Peer formula: $a^2+b^2=c^2$" : "Peer formula target."],
        ];

        return <main data-baseline={baselineMode}>
          {items.map(([name, text]) => (
            <section key={name} className={"fixture-" + name}>
              <MarkdownBody>{text}</MarkdownBody>
            </section>
          ))}
        </main>;
      }

      createRoot(document.getElementById("root")!).render(<App />);
    `,
  },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: buildOutdir,
  entryNames: "entry",
  chunkNames: "chunks/[name]-[hash]",
  publicPath: "/assets",
  write: false,
  metafile: true,
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{
    name: "markdown-lazy-fixture-katex-css",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^katex\/dist\/katex\.min\.css$/ }, () => ({
        path: "katex-min-css",
        namespace: "markdown-lazy-fixture-css",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "markdown-lazy-fixture-css" }, () => ({
        loader: "js",
        contents: `
          if (!document.querySelector('link[data-markdown-katex-fixture]')) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = "/katex/katex.min.css";
            link.dataset.markdownKatexFixture = "true";
            document.head.append(link);
          }
        `,
      }));
    },
  }],
});

function outputAssetUrl(outputPath) {
  const absoluteOutputPath = path.isAbsolute(outputPath)
    ? outputPath
    : path.resolve(root, outputPath);
  const relative = path.relative(buildOutdir, absoluteOutputPath);
  assert.ok(relative && !relative.startsWith(".."), `unexpected esbuild output path: ${outputPath}`);
  return `/assets/${relative.split(path.sep).join("/")}`;
}

const outputFiles = new Map(bundle.outputFiles.map((file) => [outputAssetUrl(file.path), file.contents]));
const entryUrl = [...outputFiles.keys()].find((url) => url === "/assets/entry.js");
assert.ok(entryUrl, "esbuild must emit the fixture entry module");
const entryOutput = bundle.outputFiles.find((file) => outputAssetUrl(file.path) === entryUrl);
assert.ok(entryOutput, "the entry output must be measurable");
const runtimeChunkUrls = Object.entries(bundle.metafile.outputs)
  .filter(([, output]) => /(?:^|\/)components\/MarkdownKatexRuntime\.ts$/.test(output.entryPoint ?? ""))
  .map(([outputPath]) => outputAssetUrl(outputPath));
assert.ok(runtimeChunkUrls.length <= 1, "the lazy KaTeX runtime must resolve to at most one browser chunk");

const requests = [];
const externalRequests = [];
const pageErrors = [];
let browser;

function send(response, body, contentType, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", body.byteLength);
  response.end(body);
}

function sendText(response, body, contentType, status = 200) {
  send(response, Buffer.from(body), contentType, status);
}

function contentTypeFor(urlPath) {
  if (urlPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (urlPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (urlPath.endsWith(".woff2")) return "font/woff2";
  if (urlPath.endsWith(".woff")) return "font/woff";
  if (urlPath.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

function requestPath(request) {
  return new URL(request.url ?? "/", "http://markdown-lazy.fixture").pathname;
}

function resourceStats(filter, fromIndex = 0) {
  const selected = requests.slice(fromIndex).filter(filter);
  return {
    count: selected.length,
    bytes: selected.reduce((total, request) => total + request.bytes, 0),
    urls: selected.map((request) => request.url),
  };
}

function isJavaScriptRequest(request) {
  return requestPath(request).endsWith(".js");
}

function isKatexCssRequest(request) {
  return requestPath(request) === "/katex/katex.min.css";
}

function isRuntimeChunkRequest(request) {
  return runtimeChunkUrls.includes(requestPath(request));
}

async function waitForQuietRequests(label) {
  const deadline = Date.now() + waitTimeoutMs;
  let previousCount = requests.length;
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (requests.length !== previousCount) {
      previousCount = requests.length;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietWindowMs) {
      return;
    }
  }
  throw new Error(`${label}: fixture requests did not settle`);
}

const server = http.createServer((request, response) => {
  const pathname = requestPath(request);
  let body;
  if (pathname === "/") {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Markdown lazy fixture</title></head><body><div id="root"></div><script type="module" src="${entryUrl}"></script></body></html>`;
    body = Buffer.from(html);
    requests.push({ method: request.method ?? "GET", url: request.url ?? "/", bytes: body.byteLength });
    send(response, body, "text/html; charset=utf-8");
    return;
  }
  if (outputFiles.has(pathname)) {
    body = outputFiles.get(pathname);
    requests.push({ method: request.method ?? "GET", url: request.url ?? "/", bytes: body.byteLength });
    send(response, body, contentTypeFor(pathname));
    return;
  }
  if (pathname === "/katex/katex.min.css") {
    body = katexCss;
    requests.push({ method: request.method ?? "GET", url: request.url ?? "/", bytes: body.byteLength });
    send(response, body, "text/css; charset=utf-8");
    return;
  }
  if (pathname.startsWith("/katex/fonts/")) {
    const relativeFont = decodeURIComponent(pathname.slice("/katex/".length));
    const fontPath = path.resolve(katexDistDir, relativeFont);
    const fontsRoot = path.resolve(katexDistDir, "fonts") + path.sep;
    if (!fontPath.startsWith(fontsRoot)) {
      requests.push({ method: request.method ?? "GET", url: request.url ?? "/", bytes: 0 });
      sendText(response, "Not found", "text/plain; charset=utf-8", 404);
      return;
    }
    try {
      body = readFileSync(fontPath);
    } catch {
      requests.push({ method: request.method ?? "GET", url: request.url ?? "/", bytes: 0 });
      sendText(response, "Not found", "text/plain; charset=utf-8", 404);
      return;
    }
    requests.push({ method: request.method ?? "GET", url: request.url ?? "/", bytes: body.byteLength });
    send(response, body, contentTypeFor(pathname));
    return;
  }
  requests.push({ method: request.method ?? "GET", url: request.url ?? "/", bytes: 0 });
  sendText(response, "Not found", "text/plain; charset=utf-8", 404);
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  await page.route("**/*", (route) => (
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  ));
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.fixture?.setMathEnabled === "function");
  await page.waitForFunction(() => document.querySelectorAll(".fixture-plain .markdown-body").length === 1);
  await waitForQuietRequests("initial plain markdown render");

  const initialRequestCount = requests.length;
  const initialJavaScript = resourceStats(isJavaScriptRequest);
  const initialCss = resourceStats(isKatexCssRequest);
  const initialRuntimeChunks = resourceStats(isRuntimeChunkRequest);

  await page.locator(".fixture-plain").getByText("A plain message with no formula.").waitFor();
  await page.locator(".fixture-inline-code code").getByText("$x^2$").waitFor();
  await page.locator(".fixture-dollar-text").getByText("Currency stays literal: $5.00 USD.").waitFor();
  await page.evaluate(() => window.fixture.setMathEnabled(true));
  await page.waitForFunction(() => (
    document.querySelector(".fixture-inline-math .katex") !== null &&
    document.querySelector(".fixture-block-math .katex-display .katex") !== null &&
    document.querySelector(".fixture-peer-math .katex") !== null
  ));
  await page.waitForFunction(() => {
    const link = document.querySelector("link[data-markdown-katex-fixture]");
    if (!link?.sheet) return false;
    const inline = document.querySelector(".fixture-inline-math .katex");
    return Boolean(inline && getComputedStyle(inline).fontFamily.includes("KaTeX_Main"));
  });
  await waitForQuietRequests("math render and KaTeX assets");

  const mathJavaScript = resourceStats(isJavaScriptRequest, initialRequestCount);
  const allCss = resourceStats(isKatexCssRequest);
  const allRuntimeChunks = resourceStats(isRuntimeChunkRequest);
  const mathEvidence = await page.evaluate(() => ({
    inlineKatex: document.querySelectorAll(".fixture-inline-math .katex").length,
    blockKatex: document.querySelectorAll(".fixture-block-math .katex-display .katex").length,
    peerKatex: document.querySelectorAll(".fixture-peer-math .katex").length,
    stylesheetLoaded: Boolean(document.querySelector("link[data-markdown-katex-fixture]")?.sheet),
    inlineFontFamily: getComputedStyle(document.querySelector(".fixture-inline-math .katex") ?? document.body).fontFamily,
  }));

  const sanitizerEvidence = await page.evaluate(() => {
    const root = document.querySelector(".fixture-sanitize .markdown-body") ?? document.createElement("div");
    const keptText = root.textContent?.includes("safe text") ?? false;
    return {
      keptText,
      removedElements: ["script", "iframe", "object", "style", "form"].filter((tag) => !root.querySelector(tag)),
      unsafeAttributes: root.querySelectorAll("[onclick], [style], [href^='javascript:']").length,
      xssExecuted: Boolean(window.__markdownLazyXss),
    };
  });

  assert.deepEqual(pageErrors, [], "the fixture should have no uncaught browser errors");
  assert.deepEqual(externalRequests, [], "the fixture must not contact external hosts or production APIs");
  assert.equal(requests.filter((request) => requestPath(request).startsWith("/api/")).length, 0,
    "the fixture must not call any product API endpoint");
  assert.ok(initialJavaScript.count >= 1, "the fixture entry JavaScript must load");
  assert.ok(initialJavaScript.bytes >= entryOutput.contents.byteLength,
    "initial JavaScript bytes must include the fixture entry");
  assert.equal(initialRuntimeChunks.count, 0, "the KaTeX runtime chunk must not be requested before formulas render");
  if (baseline) {
    assert.equal(initialCss.count, 1, "static baseline must load KaTeX CSS during initial render");
  } else {
    assert.equal(initialCss.count, 0, "candidate must not request KaTeX CSS before formulas render");
  }
  assert.equal(allCss.count, 1, "KaTeX stylesheet should be fetched once across all MarkdownBody instances");
  if (!baseline) {
    assert.equal(allRuntimeChunks.count, 1, "multiple math components should share one lazy KaTeX runtime chunk request");
  }
  assert.equal(mathEvidence.inlineKatex, 1, "inline math must be rendered by KaTeX");
  assert.equal(mathEvidence.blockKatex, 1, "block math must be rendered by KaTeX");
  assert.equal(mathEvidence.peerKatex, 1, "a second math component must use the shared runtime");
  assert.equal(mathEvidence.stylesheetLoaded, true, "the KaTeX stylesheet must be attached and loaded");
  assert.ok(mathEvidence.inlineFontFamily.includes("KaTeX_Main"), "KaTeX CSS font rules must apply in the fixture");
  assert.equal(sanitizerEvidence.keptText, true, "safe text should remain visible after sanitization");
  assert.deepEqual(sanitizerEvidence.removedElements, ["script", "iframe", "object", "style", "form"],
    "the existing markdown sanitizer must remove unsafe raw HTML elements");
  assert.equal(sanitizerEvidence.unsafeAttributes, 0, "the sanitizer must remove event, style, and javascript URL attributes");
  assert.equal(sanitizerEvidence.xssExecuted, false, "the sanitizer must prevent the raw HTML fixture from executing");

  const apiRequests = requests.filter((request) => requestPath(request).startsWith("/api/"));
  const result = {
    status: "passed",
    mode: baseline ? "static-katex-baseline" : "candidate-lazy-katex",
    sourceRoot: root,
    initial: {
      javascriptRequests: initialJavaScript.count,
      javascriptBytes: initialJavaScript.bytes,
      katexCssRequests: initialCss.count,
      katexCssBytes: initialCss.bytes,
      runtimeChunkRequests: initialRuntimeChunks.count,
      runtimeChunkUrls: initialRuntimeChunks.urls,
    },
    afterMath: {
      additionalJavascriptRequests: mathJavaScript.count,
      additionalJavascriptBytes: mathJavaScript.bytes,
      katexCssRequestsTotal: allCss.count,
      katexCssBytesTotal: allCss.bytes,
      runtimeChunkRequestsTotal: allRuntimeChunks.count,
      runtimeChunkUrls: allRuntimeChunks.urls,
    },
    rendering: mathEvidence,
    sanitization: sanitizerEvidence,
    network: {
      apiRequests: apiRequests.length,
      externalRequests: externalRequests.length,
      pageErrors: pageErrors.length,
    },
    fixtureNotes: {
      comparison: "same source root and real component; baseline adds an eager static rehype-katex and CSS import",
      cssAdapter: "esbuild fixture turns the real runtime CSS import into a lazy link; this does not prove Next CSS chunk behavior",
      stylesheetBytes: statSync(katexCssPath).size,
      realComponent: "components/MarkdownBody.tsx",
      componentInstances: 7,
    },
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = process.env.PI_PERF_RESULT_PATH;
  if (outputPath) {
    const resolvedOutputPath = path.resolve(outputPath);
    mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, json);
  }
  process.stdout.write(json);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
