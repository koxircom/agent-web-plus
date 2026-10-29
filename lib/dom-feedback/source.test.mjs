import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { transform } = require("esbuild");
const { TraceMap, allGeneratedPositionsFor } = require("@jridgewell/trace-mapping");
const { getDomSourceHint, normalizeDomSourceHint, normalizeDomCodeLocation, resolveDomSource } =
  await createJiti(import.meta.url).import("./source.ts");

async function jsxMap() {
  const source = `export function SourceMappedTarget() {\n  return <button id="mapped-button">Mapped DOM target</button>;\n}\n`;
  const result = await transform(source, {
    loader: "tsx",
    sourcefile: "src/SourceMappedTarget.tsx",
    format: "esm",
    jsx: "automatic",
    jsxDev: true,
    sourcemap: "external",
  });
  const map = JSON.parse(result.map);
  const [generated] = allGeneratedPositionsFor(new TraceMap(map), {
    source: map.sources[0],
    line: 2,
    column: 12,
  });
  assert.ok(generated, "esbuild produced a generated position for the JSX target");
  return { source, code: result.code, map, generated };
}

function stackHint(url, generated, componentName = "SourceMappedTarget") {
  return {
    frames: [{ url, line: generated.line, column: generated.column + 1 }],
    componentName,
  };
}

function dataMap(map) {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
}

test("getDomSourceHint is standalone and reads React 18 debug source without invoking getters", () => {
  const target = { parentElement: null };
  let getterCalls = 0;
  const fiber = {
    type: function SourceMappedTarget() {},
    return: null,
  };
  Object.defineProperty(fiber, "_debugSource", {
    enumerable: true,
    get() { getterCalls++; throw new Error("React properties must not be invoked"); },
  });
  target["__reactFiber$fixture"] = fiber;
  const standalone = runInNewContext(`(${getDomSourceHint.toString()})`, {});
  assert.equal(standalone(target), null);
  assert.equal(getterCalls, 0);

  const sourceTarget = { parentElement: null };
  sourceTarget["__reactFiber$fixture"] = {
    type: function CheckoutButton() {},
    _debugSource: { fileName: "/workspace/src/Checkout.tsx", lineNumber: 27, columnNumber: 9 },
    return: null,
  };
  const direct = standalone(sourceTarget);
  assert.deepEqual(JSON.parse(JSON.stringify(direct)), {
    direct: {
      filePath: "/workspace/src/Checkout.tsx",
      line: 27,
      column: 9,
      method: "react-debug-source",
      componentName: "CheckoutButton",
    },
    frames: [],
    componentName: "CheckoutButton",
  });
});

test("reads a bounded React 19 debug stack and normalizes source hint and location DTOs", () => {
  const target = { parentElement: null };
  const fiber = {
    type: function SourceMappedTarget() {},
    _debugStack: { stack: "Error: react-stack-top-frame\n    at SourceMappedTarget (https://fixture.test/assets/ui.js:18:42)\n    at renderWithHooks (https://fixture.test/node_modules/react-dom/client.js:400:9)" },
    return: null,
  };
  target["__reactFiber$fixture"] = fiber;
  const hint = getDomSourceHint(target);
  assert.equal(hint.componentName, "SourceMappedTarget");
  assert.deepEqual(hint.frames, [
    { url: "https://fixture.test/assets/ui.js", line: 18, column: 42 },
    { url: "https://fixture.test/node_modules/react-dom/client.js", line: 400, column: 9 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeDomSourceHint(hint))), JSON.parse(JSON.stringify(hint)));
  assert.equal(normalizeDomSourceHint({ ...hint, extra: true }), null);
  assert.equal(normalizeDomSourceHint({ ...hint, frames: [...hint.frames, ...hint.frames, ...hint.frames] }), null);
  assert.equal(normalizeDomSourceHint({ ...hint, frames: [{ url: "javascript:alert(1)", line: 1, column: 1 }] }), null);

  assert.deepEqual(normalizeDomCodeLocation({
    filePath: "https://user:password@example.test/src/Checkout.tsx?token=secret#part",
    line: 27,
    column: null,
    method: "sourcemap",
    componentName: "CheckoutButton",
  }), {
    filePath: "https://example.test/src/Checkout.tsx",
    line: 27,
    column: null,
    method: "sourcemap",
    componentName: "CheckoutButton",
  });
  assert.equal(normalizeDomCodeLocation({ filePath: "/src/a.tsx", line: 0, column: null, method: "sourcemap", componentName: null }), null);
  assert.equal(normalizeDomCodeLocation({ filePath: "/src/a.tsx", line: 1, column: 0, method: "sourcemap", componentName: null }), null);
});

test("resolves an about:srcdoc generated stack through inline JSX source map offsets", async () => {
  const { code, map, generated } = await jsxMap();
  const script = `${code}\n//# sourceMappingURL=${dataMap(map)}`;
  const html = `<!doctype html>\n<html>\n<body>\n<script>\n${script}\n</script>\n</body>\n</html>`;
  const scriptStart = html.indexOf(script);
  const scriptLine = html.slice(0, scriptStart).split("\n").length;
  const hint = stackHint("about:srcdoc", {
    line: scriptLine + generated.line - 1,
    column: generated.column + 1,
  });
  const controller = new AbortController();
  const location = await resolveDomSource(hint, {
    html,
    pageUrl: "http://fixture.test/preview.html",
    signal: controller.signal,
  });
  assert.equal(location.filePath, "src/SourceMappedTarget.tsx");
  assert.equal(location.line, 2);
  assert.equal(location.method, "sourcemap");
  assert.ok(location.column > 0);
});

test("matches an inline sourceURL and decodes a data source map", async () => {
  const { code, map, generated } = await jsxMap();
  const sourceUrl = "webpack-internal:///src/SourceMappedTarget.tsx";
  const html = `<script>\n${code}\n//# sourceMappingURL=${dataMap(map)}\n//# sourceURL=${sourceUrl}\n</script>`;
  const location = await resolveDomSource(stackHint(sourceUrl, generated), {
    html,
    pageUrl: "http://fixture.test/app",
    signal: new AbortController().signal,
  });
  assert.equal(location.filePath, "src/SourceMappedTarget.tsx");
  assert.equal(location.line, 2);
  assert.equal(location.method, "sourcemap");
});

test("loads a same-origin external source map and rejects missing or damaged maps", async () => {
  const { code, map, generated } = await jsxMap();
  const scriptUrl = "https://fixture.test/assets/mapped.js";
  const loaded = [];
  const location = await resolveDomSource(stackHint(scriptUrl, generated), {
    pageUrl: "https://fixture.test/app?session=local",
    signal: new AbortController().signal,
    load: async url => {
      loaded.push(url);
      if (url === scriptUrl) return `${code}\n//# sourceMappingURL=mapped.js.map`;
      if (url === "https://fixture.test/assets/mapped.js.map") return JSON.stringify(map);
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(location.filePath, "src/SourceMappedTarget.tsx");
  assert.equal(location.line, 2);
  assert.deepEqual(loaded, [scriptUrl, "https://fixture.test/assets/mapped.js.map"]);

  const missing = await resolveDomSource(stackHint(scriptUrl, generated), {
    pageUrl: "https://fixture.test/app",
    signal: new AbortController().signal,
    load: async () => code,
  });
  assert.equal(missing, null, "generated frames remain usable as DOM targets when no map exists");

  const broken = await resolveDomSource(stackHint(scriptUrl, generated), {
    pageUrl: "https://fixture.test/app",
    signal: new AbortController().signal,
    load: async url => url === scriptUrl
      ? `${code}\n//# sourceMappingURL=mapped.js.map`
      : "{this is not a source map}",
  });
  assert.equal(broken, null, "a malformed map falls back without rejecting the target");
});

test("aborting source lookup cancels its loader and returns no stale location", async () => {
  const { code, generated } = await jsxMap();
  const controller = new AbortController();
  let loaderSignal;
  const pending = resolveDomSource(stackHint("https://fixture.test/assets/mapped.js", generated), {
    pageUrl: "https://fixture.test/app",
    signal: controller.signal,
    load: (_url, signal) => {
      loaderSignal = signal;
      return new Promise(resolve => signal.addEventListener("abort", () => resolve(code), { once: true }));
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(loaderSignal.aborted, true);
});
