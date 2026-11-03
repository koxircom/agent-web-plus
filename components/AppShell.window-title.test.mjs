import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appShellSource = fs.readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

test("AppShell imports useBrowserTabTitle and connects custom tab title to window title effect", () => {
  // 1. Hook import
  assert.match(appShellSource, /import\s*\{\s*useBrowserTabTitle\s*\}\s*from\s*"@\/hooks\/useBrowserTabTitle"/);

  // 2. Hook usage inside AppShell
  assert.match(appShellSource, /const\s*\{\s*customTitle:\s*customBrowserTabTitle,\s*appearance:\s*browserTabAppearance\s*\}\s*=\s*useBrowserTabTitle\(\);/);

  // 3. Effect logic checks customBrowserTabTitle first and bypasses extension title when present
  const effectBlock = appShellSource.slice(
    appShellSource.indexOf("const syncWindowTitle ="),
    appShellSource.indexOf("syncWindowTitle();"),
  );
  assert.ok(effectBlock.length > 0, "syncWindowTitle body exists");
  assert.match(effectBlock, /if\s*\(customBrowserTabTitle\)\s*\{/);
  assert.match(effectBlock, /document\.title\s*!==\s*customBrowserTabTitle/);
  assert.match(effectBlock, /document\.title\s*=\s*customBrowserTabTitle/);
  assert.match(effectBlock, /return;/);

  // 4. Default fallback restores composeEnhancementWindowTitle
  assert.match(effectBlock, /composeEnhancementWindowTitle\(requestedBase,\s*win\)/);

  // 5. Effect dependency array includes customBrowserTabTitle
  assert.match(appShellSource, /\},\s*\[activeCwd,\s*windowTitle,\s*customBrowserTabTitle,\s*browserTabAppearance,\s*activeCwdName,\s*activeExecutionEngine\]\);/);
});
