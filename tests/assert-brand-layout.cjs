'use strict';
const assert = require('node:assert/strict');

// Run against the real welcome header: detects minimum-sized/letterboxed brands.
module.exports = async function assertBrandLayout(page) {
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('[data-pi-element="new-session-brand-header"]');
    const svg = header.querySelector('svg');
    const wordmark = svg.querySelector('[data-pi-brand-part="wordmark"]');
    const disc = svg.querySelector('#flat-main-disc');
    const box = el => el.getBoundingClientRect().toJSON();
    const scale = svg.getScreenCTM().a;
    return {
      viewport: innerWidth, svg: box(svg), text: box(wordmark), disc: box(disc),
      fontPixels: Number(wordmark.getAttribute('font-size')) * scale,
      lastWord: box(wordmark.lastElementChild),
      version: box(header.querySelector('[data-pi-element="version-info-col"]')),
      wordmark: wordmark.textContent.trim(),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(geometry.wordmark, 'Agent Web Plus');
  assert.equal(geometry.overflow, false);
  assert(geometry.fontPixels >= (geometry.viewport < 600 ? 16 : 22), 'Welcome wordmark is too small');
  assert(Math.abs(geometry.fontPixels / geometry.disc.height - 94 / 175) < .01, 'Native text/icon proportion changed');
  assert(geometry.lastWord.right <= geometry.svg.right + 1, 'Brand is clipped');
  assert(geometry.svg.right <= geometry.version.left + 1, 'Brand overlaps version information');
  assert(geometry.text.bottom <= geometry.svg.bottom + 1, 'Brand exceeds SVG viewport');
  return geometry;
};
