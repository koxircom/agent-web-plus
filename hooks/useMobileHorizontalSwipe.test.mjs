import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSwipeMove,
  getNativeSidebarSwipeStartLimit,
  isEligibleSwipeTarget,
} from "./useMobileHorizontalSwipe.ts";

test("sidebar swipe start region matches the original drawer and wide-layout limits", () => {
  assert.equal(getNativeSidebarSwipeStartLimit(320), 280);
  assert.equal(getNativeSidebarSwipeStartLimit(390), 331.5);
  assert.equal(getNativeSidebarSwipeStartLimit(600), 510);
  assert.equal(getNativeSidebarSwipeStartLimit(700), 525);
  assert.equal(getNativeSidebarSwipeStartLimit(900), 580);
});

test("SVG touch targets work while preserving gesture avoidance and vertical-first behavior", () => {
  const previousGlobals = {
    HTMLElement: globalThis.HTMLElement,
    SVGElement: globalThis.SVGElement,
    window: globalThis.window,
    document: globalThis.document,
  };

  class MockElement {
    constructor(tagName, options = {}) {
      this.tagName = tagName.toUpperCase();
      this.role = options.role;
      this.parentElement = null;
      this.scrollWidth = options.scrollWidth ?? 100;
      this.clientWidth = options.clientWidth ?? 100;
      this.overflowX = options.overflowX ?? "visible";
    }

    closest(selector) {
      const selectors = selector.split(",").map((item) => item.trim().toLowerCase());
      let current = this;
      while (current) {
        if (selectors.includes(current.tagName.toLowerCase()) || (selectors.includes("[role='dialog']") && current.role === "dialog")) return current;
        current = current.parentElement;
      }
      return null;
    }
  }

  class MockHTMLElement extends MockElement {}
  class MockSVGElement extends MockElement {}

  try {
    globalThis.HTMLElement = MockHTMLElement;
    globalThis.SVGElement = MockSVGElement;
    globalThis.window = {
      getSelection: () => ({ toString: () => "" }),
      getComputedStyle: (element) => ({ overflowX: element.overflowX }),
    };

    const container = new MockHTMLElement("div");
    globalThis.document = { body: container };

    const svgPath = new MockSVGElement("path");
    svgPath.parentElement = container;
    assert.equal(isEligibleSwipeTarget(svgPath, container), true);

    const button = new MockHTMLElement("button");
    button.parentElement = container;
    const buttonIcon = new MockSVGElement("path");
    buttonIcon.parentElement = button;
    assert.equal(isEligibleSwipeTarget(buttonIcon, container), false);
    assert.equal(isEligibleSwipeTarget(buttonIcon, container, { allowOnButtons: true }), true);

    container.role = "dialog";
    assert.equal(isEligibleSwipeTarget(buttonIcon, container, { allowOnButtons: true }), true,
      "The navigation dialog must recognize its own right swipe");
    const nestedDialog = new MockHTMLElement("dialog");
    nestedDialog.parentElement = container;
    const nestedText = new MockHTMLElement("span"); nestedText.parentElement = nestedDialog;
    assert.equal(isEligibleSwipeTarget(nestedText, container, { allowOnButtons: true }), false);
    const input = new MockHTMLElement("textarea"); input.parentElement = container;
    assert.equal(isEligibleSwipeTarget(input, container, { allowOnButtons: true }), false);

    const codeBlock = new MockHTMLElement("pre");
    codeBlock.parentElement = container;
    const codeIcon = new MockSVGElement("path");
    codeIcon.parentElement = codeBlock;
    assert.equal(isEligibleSwipeTarget(codeIcon, container, { allowOnButtons: true }), false);

    const horizontalScroller = new MockHTMLElement("div", {
      scrollWidth: 300,
      clientWidth: 200,
      overflowX: "auto",
    });
    horizontalScroller.parentElement = container;
    const scrollerIcon = new MockSVGElement("path");
    scrollerIcon.parentElement = horizontalScroller;
    assert.equal(isEligibleSwipeTarget(scrollerIcon, container, { allowOnButtons: true }), false);

    assert.deepEqual(
      evaluateSwipeMove(2, 10, "right", { horizontalLocked: false, abandoned: false }),
      { horizontalLocked: false, abandoned: true },
    );
  } finally {
    globalThis.HTMLElement = previousGlobals.HTMLElement;
    globalThis.SVGElement = previousGlobals.SVGElement;
    globalThis.window = previousGlobals.window;
    globalThis.document = previousGlobals.document;
  }
});
