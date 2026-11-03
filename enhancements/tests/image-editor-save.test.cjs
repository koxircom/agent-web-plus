'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const SCRIPT_PATH = path.resolve(__dirname, '../assets/image-editor.js');
const SAMPLE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjuAAAAAElFTkSuQmCC';

test('image editor save and explicit download separation in real browser', async (t) => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.setContent(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Image Editor Save Test</title></head>
<body><div id="test-root"></div></body>
</html>`);

  await page.addScriptTag({ path: SCRIPT_PATH });

  // 辅助函数：在页面内画一笔标注
  async function performAnnotation(page) {
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('Canvas not found');
      const rect = canvas.getBoundingClientRect();
      const p1 = new PointerEvent('pointerdown', { clientX: rect.left + 1, clientY: rect.top + 1, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 });
      const p2 = new PointerEvent('pointermove', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1 });
      const p3 = new PointerEvent('pointerup', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 });
      canvas.dispatchEvent(p1);
      canvas.dispatchEvent(p2);
      canvas.dispatchEvent(p3);
    });
  }

  // 测试 1：editContext.replace 场景下，save 触发 replace=1 且 download=0
  await t.test('editor save triggers editContext.replace callback without downloading', async () => {
    const result = await page.evaluate(async (src) => {
      let downloadClicks = 0;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloadClicks++;
        return originalClick.call(this);
      };

      let replaceCalls = 0;
      let replacementData = null;

      const editor = window.PiImageEditor.create({
        showToast() {},
        closeComposerImageZoomModal() {},
      });

      editor(src, 'test-on-save', {
        replace: async (rep) => {
          replaceCalls++;
          replacementData = rep;
          return true;
        },
      });

      await new Promise(r => setTimeout(r, 200));

      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 1, clientY: rect.top + 1, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));

      const saveBtn = document.querySelector('[data-image-editor-action="save"]');
      if (!saveBtn) throw new Error('Save button not found');
      saveBtn.click();
      await new Promise(r => setTimeout(r, 120));

      HTMLAnchorElement.prototype.click = originalClick;
      return {
        downloadClicks,
        replaceCalls,
        hasPreviewUrl: Boolean(replacementData?.previewUrl?.startsWith('data:image/png')),
        hasBase64Data: Boolean(replacementData?.data),
        mimeType: replacementData?.mimeType,
      };
    }, SAMPLE_PNG);

    assert.equal(result.downloadClicks, 0, 'save must not trigger download');
    assert.equal(result.replaceCalls, 1, 'save must invoke replace callback');
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.hasPreviewUrl, true);
    assert.equal(result.hasBase64Data, true);
  });

  // 测试 2：readonly history 图片场景下，save 不会自动下载且绝不 fake 替换
  await t.test('editor save on readonly history image shows error without download or fake DOM replace', async () => {
    const result = await page.evaluate(async (src) => {
      let downloadClicks = 0;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloadClicks++;
        return originalClick.call(this);
      };

      const editor = window.PiImageEditor.create({
        showToast() {},
        closeComposerImageZoomModal() {},
      });

      // 未传 editContext（模拟只读历史图片）
      editor(src, 'test-readonly-history', null);

      await new Promise(r => setTimeout(r, 200));

      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 1, clientY: rect.top + 1, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));

      const saveBtn = document.querySelector('[data-image-editor-action="save"]');
      saveBtn.click();
      await new Promise(r => setTimeout(r, 120));

      const statusEl = document.querySelector('.pi-enh-image-editor-status');
      const statusText = statusEl ? statusEl.textContent : '';

      // 清理测试 2 的 dialog 防止影响后续测试
      const closeBtn = document.querySelector('.image-preview-close') || document.querySelector('[data-image-editor-action="cancel"]');
      if (closeBtn) closeBtn.click();
      const discardBtn = document.querySelector('[data-confirm-action="discard"]');
      if (discardBtn) discardBtn.click();
      const anyDialog = document.querySelector('dialog');
      if (anyDialog) {
        try { anyDialog.close(); } catch(e) {}
        anyDialog.remove();
      }

      HTMLAnchorElement.prototype.click = originalClick;
      return { downloadClicks, statusText };
    }, SAMPLE_PNG);

    assert.equal(result.downloadClicks, 0, 'save on readonly must not trigger download');
    assert.match(result.statusText, /只读历史图片不支持直接保存替换/);
  });

  // 测试 3：显式下载（explicit download）依然正常工作
  await t.test('explicit download button triggers download once', async () => {
    const result = await page.evaluate(async (src) => {
      let downloadClicks = 0;
      let downloadedFileName = '';
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          downloadClicks++;
          downloadedFileName = this.download;
        }
        return originalClick.call(this);
      };

      const editor = window.PiImageEditor.create({
        showToast() {},
        closeComposerImageZoomModal() {},
      });

      // autoEdit: false，以预览模式打开
      editor(src, 'my-explicit-download-pic', null, null, { autoEdit: false });
      await new Promise(r => setTimeout(r, 150));

      const downloadBtn = document.querySelector('[data-zoom-action="download"]');
      if (!downloadBtn) throw new Error('Download button not found in preview toolbar');
      downloadBtn.click();
      await new Promise(r => setTimeout(r, 80));

      // 关闭预览弹窗
      const closeBtn = document.querySelector('.image-preview-close');
      if (closeBtn) closeBtn.click();

      HTMLAnchorElement.prototype.click = originalClick;
      return { downloadClicks, downloadedFileName };
    }, SAMPLE_PNG);

    assert.equal(result.downloadClicks, 1, 'explicit download must trigger anchor click');
    assert.match(result.downloadedFileName, /my-explicit-download-pic\.png$/);
  });

  // 测试 4：Cancel 不 commit（不触发 callback，不触发 download）
  await t.test('cancel does not commit changes or trigger downloads', async () => {
    const result = await page.evaluate(async (src) => {
      let downloadClicks = 0;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloadClicks++;
        return originalClick.call(this);
      };

      let callbackCalls = 0;
      const editor = window.PiImageEditor.create({
        showToast() {},
        closeComposerImageZoomModal() {},
      });

      editor(src, 'test-cancel-pic', {
        onSave: () => { callbackCalls++; },
      });

      await new Promise(r => setTimeout(r, 200));

      // 绘制一笔
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 1, clientY: rect.top + 1, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1 }));

      // 点击取消
      const cancelBtn = document.querySelector('[data-image-editor-action="cancel"]');
      cancelBtn.click();
      await new Promise(r => setTimeout(r, 60));

      // 在确认弹窗中选择放弃修改退出
      const discardBtn = document.querySelector('[data-confirm-action="discard"]');
      if (!discardBtn) throw new Error('Discard button not found in confirm overlay');
      discardBtn.click();
      await new Promise(r => setTimeout(r, 80));

      const isDialogOpen = Boolean(document.querySelector('dialog[open]'));

      HTMLAnchorElement.prototype.click = originalClick;
      return { downloadClicks, callbackCalls, isDialogOpen };
    }, SAMPLE_PNG);

    assert.equal(result.downloadClicks, 0, 'cancel must not trigger download');
    assert.equal(result.callbackCalls, 0, 'cancel must not commit callback');
    assert.equal(result.isDialogOpen, false, 'dialog should be closed after cancel');
  });

  await browser.close();
});
