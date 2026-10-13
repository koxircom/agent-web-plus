import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ImagePreview.tsx", import.meta.url), "utf8");
const dialogSource = await readFile(new URL("./ImagePreviewDialog.tsx", import.meta.url), "utf8");
const shortcutsSource = await readFile(new URL("../hooks/useKeyboardShortcuts.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("composer attachments open in the shared preview with a separate remove button", async () => {
  const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(inputSource, /import \{ ImagePreview \} from "\.\/ImagePreview"/);
  assert.match(
    inputSource,
    /<ImagePreview key=\{img\.previewUrl\} src=\{img\.previewUrl\}>[\s\S]*?<img[\s\S]*?src=\{img\.previewUrl\}[\s\S]*?<\/ImagePreview>\s*<button\s*type="button"\s*onClick=\{\(\) => removeImage\(i\)\}/,
  );
});

test("uses a native modal dialog and restores focus to its trigger", () => {
  assert.match(source, /loadImagePreview\(\)\.then\(\(module\) => \{[\s\S]*?setDialog\(\(\) => module\.ImagePreviewDialog\)/);
  assert.match(source, /<Dialog src=\{src\} alt=\{alt\} triggerRef=\{triggerRef\} onClose=\{\(\) => setOpen\(false\)\} \/>/);
  assert.match(dialogSource, /useRef<HTMLDialogElement>\(null\)/);
  assert.match(dialogSource, /dialog\.showModal\(\)/);
  assert.match(dialogSource, /closeButtonRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(dialogSource, /const trigger = triggerRef\.current[\s\S]*?trigger\?\.isConnected[\s\S]*?trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(source + dialogSource, /createPortal/);
});

test("Escape closes image preview without reaching global shortcuts", () => {
  const body = source.match(/const cancelPending = \(event: KeyboardEvent\) => \{([\s\S]*?)\n    \};/)?.[1];
  assert.ok(body, "pending preview must own its Escape handler");
  let closed = 0;
  const handle = new Function("setOpen", "event", body).bind(null, (open) => { if (!open) closed += 1; });
  const key = (overrides = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, keyCode: 27,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides });
  const event = key(); handle(event);
  assert.equal(closed, 1);
  assert.equal(event.defaultPrevented, true, "global Stop must ignore preview Escape");
  assert.equal(event.stopped, true);
  handle(key({ key: "Enter" })); handle(key({ defaultPrevented: true }));
  handle(key({ isComposing: true })); handle(key({ keyCode: 229 }));
  assert.equal(closed, 1, "composition and handled keys must not close the preview");
  assert.match(shortcutsSource, /event\.key !== "Escape" \|\| event\.defaultPrevented \|\| !globalAbortHandler/);
  assert.match(
    dialogSource,
    /event\.key !== "Escape"[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?closePreview\(\)/,
  );
  assert.match(
    dialogSource,
    /onCancel=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?closePreview\(\)/,
  );
});

test("closes only when the backdrop itself is clicked", () => {
  assert.match(dialogSource, /event\.target === event\.currentTarget[\s\S]*?closePreview\(\)/);
});

test("keeps the preview and Pi-style close button inside mobile safe areas", () => {
  assert.match(
    cssSource,
    /\.image-preview-dialog \{[\s\S]*?env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-right\)[\s\S]*?env\(safe-area-inset-bottom\)[\s\S]*?env\(safe-area-inset-left\)/,
  );
  assert.match(
    cssSource,
    /\.image-preview-close \{[\s\S]*?top: max\(12px, env\(safe-area-inset-top\)\)[\s\S]*?right: max\(12px, env\(safe-area-inset-right\)\)[\s\S]*?border-radius: 6px[\s\S]*?background: var\(--bg-panel\)/,
  );
  assert.match(cssSource, /@media \(pointer: coarse\) \{[\s\S]*?\.image-preview-close \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(dialogSource, /<path d="M6 6l12 12M18 6 6 18" \/>/);
});
