import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { default: SyntaxHighlighter } = await jiti.import("react-syntax-highlighter/dist/esm/prism-async-light");

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const watchClientSource = await readFile(new URL("../lib/file-watch-client.ts", import.meta.url), "utf8");
const watchClientAst = ts.createSourceFile("file-watch-client.ts", watchClientSource, ts.ScriptTarget.Latest, true);
const watchHookNode = watchClientAst.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "useFileWatch",
);
assert.ok(watchHookNode, "useFileWatch hook must exist");
const watchHookJs = ts.transpileModule(watchHookNode.getText(watchClientAst), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { FileWatchClient } = await jiti.import("../lib/file-watch-client.ts");
const createUseFileWatch = new Function(
  "exports",
  "useRef",
  "useEffect",
  "FileWatchClient",
  `${watchHookJs}; return exports.useFileWatch;`,
);


function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.notEqual(start, -1, `${name} not found`);
  assert.notEqual(end, -1, `${nextName} not found after ${name}`);
  return source.slice(start, end);
}

function watcherCallBlock(block) {
  const start = block.indexOf("useFileWatch({");
  const end = start < 0 ? -1 : block.indexOf("\n  });", start);
  assert.ok(start >= 0, "useFileWatch call missing");
  assert.ok(end > start, "useFileWatch call must be closed");
  return block.slice(start, end);
}

function createHookHarness() {
  const refs = [];
  let refIndex = 0;
  let dependencies = null;
  let cleanup = null;

  const useRef = (initial) => {
    const index = refIndex++;
    refs[index] ??= { current: initial };
    return refs[index];
  };
  const useEffect = (effect, nextDependencies) => {
    const unchanged = dependencies !== null
      && nextDependencies.length === dependencies.length
      && nextDependencies.every((value, index) => value === dependencies?.[index]);
    if (unchanged) return;
    cleanup?.();
    dependencies = nextDependencies;
    cleanup = effect() ?? null;
  };
  const useFileWatch = createUseFileWatch({}, useRef, useEffect, FileWatchClient);

  return {
    render(options) {
      refIndex = 0;
      useFileWatch(options);
    },
    unmount() {
      cleanup?.();
      cleanup = null;
      dependencies = null;
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

for (const [name, nextName, synchronize] of [
  ["ImageViewer", "formatDuration", "synchronizeImage"],
  ["AudioViewer", "VideoViewer", "synchronizeAudio"],
  ["VideoViewer", "DocumentViewer", "synchronizeVideo"],
  ["DocumentViewer", "FileViewer", "synchronizeDocument"],
  ["TextFileViewer", null, "synchronizeText"],
]) {
  test(`${name} forwards pause state and synchronizes from watch changes`, () => {
    const block = functionBlock(name, nextName);
    const call = watcherCallBlock(block);

    assert.match(block, new RegExp(`${name}\\([\\s\\S]*?watchEnabled = true`));
    assert.match(call, /\bwatchEnabled,/);
    assert.match(call, /\bisPageVisible,/);
    assert.match(call, /onConnected:\s*\(\) => setWatching\(true\)/);
    assert.ok(call.indexOf("onChange:") >= 0, "watch changes must drive viewer synchronization");
    assert.ok(call.indexOf(synchronize + "()") > call.indexOf("onChange:"), `${synchronize} must run from onChange`);
  });
}

test("useFileWatch pauses while disabled or hidden, then connects and synchronizes", async (t) => {
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json({
    exists: true,
    size: 12,
    mtimeMs: 100,
    ctimeMs: 100,
    ino: 7,
  }));
  const harness = createHookHarness();
  const notifications = [];
  const options = (watchEnabled, isPageVisible) => ({
    filePath: "/workspace/preview.png",
    executionEngine: "pi",
    watchEnabled,
    isPageVisible,
    onConnected: () => notifications.push("connected"),
    onDisconnected: () => notifications.push("disconnected"),
    onChange: (fingerprint, reason) => {
      notifications.push(`change:${reason}:${fingerprint.exists}`);
    },
  });

  try {
    harness.render(options(false, true));
    harness.render(options(true, false));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.mock.callCount(), 0, "disabled or hidden viewers issue no metadata request");

    harness.render(options(true, true));
    await waitFor(() => notifications.length === 2, "visible watcher should report its initial connection");
    assert.deepEqual(notifications, ["connected", "change:connected:true"]);

    harness.render(options(true, false));
    const afterHide = requests.mock.callCount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.mock.callCount(), afterHide, "hiding closes the active poller");

    harness.render(options(true, true));
    await waitFor(() => notifications.length === 4, "visible watcher should reconnect and synchronize again");
    assert.deepEqual(notifications.slice(2), ["connected", "change:connected:true"]);

    harness.render(options(false, true));
    const afterDisable = requests.mock.callCount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.mock.callCount(), afterDisable, "disabling closes the active poller");
  } finally {
    harness.unmount();
  }
});

test("FileViewer forwards watcher state to every viewer implementation", () => {
  const block = functionBlock("FileViewer", "TextFileViewer");
  assert.equal(block.match(/watchEnabled=\{watchEnabled\}/g)?.length, 5);
});

test("TextFileViewer snapshots and restores lightweight tab state", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /onStateChangeRef\.current\?\.\(\{ \.\.\.viewerStateRef\.current \}\)/);
  assert.match(block, /displayMode: requestedInitialDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.displayMode = nextDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.wrapLines = next/);
  assert.match(block, /viewerStateRef\.current\.scrollTop = event\.currentTarget\.scrollTop/);
  assert.match(block, /viewerStateRef\.current\.scrollLeft = event\.currentTarget\.scrollLeft/);
  assert.match(block, /content\.scrollTop = viewerStateRef\.current\.scrollTop/);
  assert.match(block, /content\.scrollLeft = viewerStateRef\.current\.scrollLeft/);
});

test("TextFileViewer keeps first-mount preview eligibility across Strict Effects cleanup", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /defaultPreviewEligibleRef = useRef\(/);
  assert.match(block, /defaultPreviewEligibleRef\.current[\s\S]*updateDisplayMode\("preview"\)/);
});

test("markdown table tokens stay inline despite Tailwind's table utility", async () => {
  await SyntaxHighlighter.preload();
  await SyntaxHighlighter.loadLanguage("markdown");
  const html = renderToStaticMarkup(
    React.createElement(
      SyntaxHighlighter,
      { language: "markdown" },
      "| Name | Desc |\n| --- | --- |\n| A | first |",
    ),
  );

  assert.ok(Array.from(html.matchAll(/class="([^"]+)"/g)).some((m) => {
    const classes = m[1].split(/\s+/);
    return classes.includes("token") && classes.includes("table");
  }), "Markdown table tokens retain both CSS classes after async grammar loading");
  assert.match(cssSource, /span\.token\.table\s*\{[^}]*display:\s*inline;/);
});


test("native file viewer synchronizes only its committed ready content", () => {
  assert.match(source, /if \(loading \|\| error \|\| !data\) return;/);
  assert.match(source, /__PI_ENH_SYNC_FILE_VIEWER__/);
  assert.match(source, /\[filePath, loading, error, data\]/);
});
