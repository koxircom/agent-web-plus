import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = source.indexOf("{/* Only the active viewer");
  const end = source.indexOf("</div>\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "file content comment not found");
  assert.notEqual(end, -1, "end of file content block not found");
  return source.slice(start, end);
}

test("only the active file tab mounts a FileViewer", () => {
  const block = fileContentBlock();
  assert.match(block, /activeFileTab\?\.filePath \? \(/);
  assert.doesNotMatch(block, /fileTabs\.map\(/);
  assert.equal(block.match(/<FileViewer/g)?.length, 1);
});

test("the active viewer restores tab state and saves it with a revision", () => {
  const block = fileContentBlock();
  assert.match(block, /key=\{`\$\{activeFileTab\.id\}:\$\{activeFileTab\.viewerRevision \?\? 0\}`\}/);
  assert.match(block, /initialState=\{activeFileTab\.viewerState\}/);
  assert.match(block, /handleFileViewerStateChange\(\s*activeFileTab\.id,\s*activeFileTab\.viewerRevision \?\? 0,/);
});

function viewerWatchEnabled({ rightPanelOpen, piExecutionReady }) {
  const expression = fileContentBlock().match(/watchEnabled=\{([^}]+)\}/)?.[1];
  assert.ok(expression, "native FileViewer watch binding is required");
  return runInNewContext(expression, { rightPanelOpen, piExecutionReady });
}

test("closing the file panel pauses its watcher for either chat engine", () => {
  for (const piExecutionReady of [false, true]) {
    assert.equal(viewerWatchEnabled({ rightPanelOpen: false, piExecutionReady }), false);
  }
});

test("an open file viewer watches its captured backend independently of the chat engine", () => {
  for (const piExecutionReady of [false, true]) {
    assert.equal(viewerWatchEnabled({ rightPanelOpen: true, piExecutionReady }), true);
  }
});

test("markdown preview links forward a PDF page fragment to the viewer", () => {
  const block = fileContentBlock();
  assert.match(block, /onOpenFile=\{\(filePath, page\) => handleOpenFile\(/);
  assert.match(block, /sourceSessionId: activeFileTab\.sourceSessionId,[\s\S]*?executionEngine: activeFileTab\.executionEngine,[\s\S]*?cwd: activeFileTab\.cwd,[\s\S]*?page,/);
});

test("remote Codex file viewers cannot start local watchers",()=>{assert.match(source,/const piExecutionReady = executionEngineReady && activeExecutionEngine === "pi"/);});
