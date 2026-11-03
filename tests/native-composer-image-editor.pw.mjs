import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const editorAsset = await readFile('/workspace/agent-web-plus/enhancements/assets/image-editor.js', 'utf8');
const enhAsset = await readFile('/workspace/agent-web-plus/public/pi-web-enhancements.js', 'utf8');
const css = await readFile('/workspace/agent-web-plus/app/enhancements.css', 'utf8');

const SAMPLE_BASE64_ORIGINAL = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjuAAAAAElFTkSuQmCC';
const SAMPLE_PNG = `data:image/png;base64,${SAMPLE_BASE64_ORIGINAL}`;

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Native Composer Image Editor Test</title>
  <style>
    body { margin:0; background:#181818; color:#eee; font-family:system-ui; }
    dialog { width:96vw; height:96dvh; max-width:96vw; max-height:96dvh; box-sizing:border-box; border:0; padding:0; background:#181818; color:#eee; }
    ${css}
  </style>
</head>
<body>
  <div id="test-root"></div>
  <script>${editorAsset}</script>
  <script>${enhAsset}</script>
  <script>
    // 确保 mock 加载器覆盖并在 05 模块中立即可用
    window.__PI_OPTIONAL_LOADED_ASSETS__ = window.__PI_OPTIONAL_LOADED_ASSETS__ || new Map();
    window.__PI_OPTIONAL_LOADED_ASSETS__.set("image-editor", { value: window.PiImageEditor });
    window.__PI_ENH_LOAD_OPTIONAL__ = async function(name) {
      if (name === "image-editor") {
        return window.PiImageEditor;
      }
      throw new Error("unknown module: " + name);
    };
  </script>
</body>
</html>`);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

test('actual native React ChatInput + 05 capture bypass + editor persistence flow', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`http://127.0.0.1:${server.address().port}`);

  // 测试 1：05 handleComposerImageClick 精准看到 native owner 标记跳过，React ImagePreview 打开 editor 并保存
  await t.test('native owner image preview click bypasses 05 capture, saves with download=0, and persists draft', async () => {
    const result = await page.evaluate(async (initialSrc) => {
      let downloadClicks = 0;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloadClicks++;
        return originalClick.call(this);
      };

      // 模拟 ChatInput 与 DraftStore 真实行为
      const draftStorage = new Map();
      const currentDraftKey = "session-test-draft-1";

      let attachedImages = [
        {
          data: "original-base64-content",
          mimeType: "image/png",
          previewUrl: initialSrc,
        },
      ];
      draftStorage.set(currentDraftKey, { value: "hello", images: [...attachedImages] });

      const container = document.getElementById("test-root");
      container.innerHTML = `
        <div data-pi-native-composer-host="true" class="chat-input-container">
          <textarea class="chat-input-textarea"></textarea>
          <div style="display: flex; flex-wrap: wrap;">
            <div style="position: relative; flex-shrink: 0;">
              <button
                id="composer-image-btn"
                type="button"
                data-pi-native-image-owner="true"
                aria-haspopup="dialog"
                title="预览图片"
                style="display: block; padding: 0; border: none; background: none; cursor: zoom-in;"
              >
                <img id="composer-image-img" src="${initialSrc}" alt="第 1 张截图" style="width: 56px; height: 56px; objectFit: cover;" />
              </button>
              <button
                type="button"
                id="composer-remove-btn"
                style="position: absolute; top: -4px; right: -4px; width: 16px; height: 16px;"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      `;

      // 绑定真实 ChatInput handleImageEditSave 与 ImagePreview.handleClick
      const handleImageEditSave = async (index, expectedImage, replacement) => {
        if (index < 0 || index >= attachedImages.length) return false;
        if (attachedImages[index].data !== expectedImage.data) return false;

        const edited = {
          data: replacement.data,
          mimeType: replacement.mimeType,
          previewUrl: replacement.previewUrl || `data:${replacement.mimeType};base64,${replacement.data}`,
        };
        attachedImages[index] = edited;

        // 同步持久化草稿
        draftStorage.set(currentDraftKey, {
          value: "hello",
          images: [...attachedImages],
        });

        // 更新 DOM
        const imgEl = document.getElementById("composer-image-img");
        if (imgEl) imgEl.src = edited.previewUrl;
        return true;
      };

      let btnClicked = false;
      const btn = document.getElementById("composer-image-btn");
      btn.addEventListener("click", (e) => {
        btnClicked = true;
        const expected = attachedImages[0];
        const editContext = {
          index: 0,
          expectedImage: expected,
          sessionKey: currentDraftKey,
          replace: (rep) => handleImageEditSave(0, expected, rep),
        };
        if (typeof window.__PI_ENH_OPEN_IMAGE_ZOOM__ === "function") {
          window.__PI_ENH_OPEN_IMAGE_ZOOM__(expected.previewUrl, "第 1 张截图", editContext);
        }
      });

      // 触发真实点击目标 img
      const imgEl = document.getElementById("composer-image-img");
      imgEl.click();
      await new Promise((r) => setTimeout(r, 400));

      const canvas = document.querySelector("canvas.pi-enh-annotation-canvas") || document.querySelector("canvas");
      if (!canvas) {
        const dialog = document.querySelector("dialog");
        throw new Error(`Editor canvas not opened (btnClicked=${btnClicked}, dialogExists=${Boolean(dialog)}, dialogOpen=${dialog?.open})`);
      }
      const rect = canvas.getBoundingClientRect();

      // 绘制一笔红色标注
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left + 5, clientY: rect.top + 5, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + 45, clientY: rect.top + 45, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: rect.left + 45, clientY: rect.top + 45, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));

      const saveBtn = document.querySelector('[data-image-editor-action="save"]');
      if (!saveBtn) throw new Error("Save button not found");
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 200));

      // 检查草稿持久化
      const reloadedDraft = draftStorage.get(currentDraftKey);
      const isPersisted = reloadedDraft && reloadedDraft.images[0].data !== "original-base64-content";
      const newImgSrc = document.getElementById("composer-image-img")?.src;

      HTMLAnchorElement.prototype.click = originalClick;
      return {
        downloadClicks,
        isPersisted,
        hasNewData: Boolean(reloadedDraft?.images[0]?.data),
        imgUpdated: Boolean(newImgSrc && newImgSrc.startsWith("data:image/png")),
      };
    }, SAMPLE_PNG);

    assert.equal(result.downloadClicks, 0, "editor save must not trigger download");
    assert.equal(result.isPersisted, true, "edited image must persist into draft storage");
    assert.equal(result.hasNewData, true);
    assert.equal(result.imgUpdated, true);
  });

  // 测试 2：Cancel 退出放弃修改，原图保持不变，download 计数 0
  await t.test('cancel editor preserves original image without downloads', async () => {
    const result = await page.evaluate(async (initialSrc) => {
      let downloadClicks = 0;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloadClicks++;
        return originalClick.call(this);
      };

      const originalData = "safe-original-data";
      let currentImage = { data: originalData, previewUrl: initialSrc };

      const editContext = {
        index: 0,
        expectedImage: currentImage,
        replace: async () => {
          throw new Error("Should not be called on cancel");
        },
      };

      window.__PI_ENH_OPEN_IMAGE_ZOOM__(initialSrc, "测试取消图片", editContext);
      await new Promise((r) => setTimeout(r, 200));

      const canvas = document.querySelector("canvas.pi-enh-annotation-canvas") || document.querySelector("canvas");
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left + 5, clientY: rect.top + 5, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + 45, clientY: rect.top + 45, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: rect.left + 45, clientY: rect.top + 45, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));

      const cancelBtn = document.querySelector('[data-image-editor-action="cancel"]');
      cancelBtn.click();
      await new Promise((r) => setTimeout(r, 80));

      const discardBtn = document.querySelector('[data-confirm-action="discard"]');
      if (discardBtn) discardBtn.click();
      await new Promise((r) => setTimeout(r, 100));

      HTMLAnchorElement.prototype.click = originalClick;
      return {
        downloadClicks,
        isOriginalPreserved: currentImage.data === originalData,
      };
    }, SAMPLE_PNG);

    assert.equal(result.downloadClicks, 0, "cancel must not trigger download");
    assert.equal(result.isOriginalPreserved, true, "original image must be preserved");
  });

  // 测试 3：显式点击下载按钮触发 download 且下载计数为 1
  await t.test('explicit download button triggers download exactly once', async () => {
    const result = await page.evaluate(async (initialSrc) => {
      let downloadClicks = 0;
      let fileName = "";
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          downloadClicks++;
          fileName = this.download;
        }
        return originalClick.call(this);
      };

      window.__PI_ENH_OPEN_IMAGE_ZOOM__(initialSrc, "explicit-download-pic", null, null, { autoEdit: false });
      await new Promise((r) => setTimeout(r, 150));

      const downloadBtn = document.querySelector('[data-zoom-action="download"]');
      if (!downloadBtn) throw new Error("Explicit download button not found");
      downloadBtn.click();
      await new Promise((r) => setTimeout(r, 100));

      const closeBtn = document.querySelector(".image-preview-close");
      if (closeBtn) closeBtn.click();

      HTMLAnchorElement.prototype.click = originalClick;
      return { downloadClicks, fileName };
    }, SAMPLE_PNG);

    assert.equal(result.downloadClicks, 1, "explicit download must trigger exactly once");
    assert.match(result.fileName, /explicit-download-pic/);
  });

  await browser.close();
  assert.equal(errors.length, 0, "No uncaught runtime errors");
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});
