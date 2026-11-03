import assert from "node:assert/strict";
import test from "node:test";

import {
  createTouchContactGuardCore,
  isFilePanelInteractionTarget,
  isKeyboardClick,
  isExplicitMouseClick,
  isTouchClick,
} from "./useTouchContactGuard.ts";

test("isFilePanelInteractionTarget detects toolbar file toggle and linked file targets", () => {
  class MockElement {
    constructor(tagName, attributes = {}) {
      this.tagName = tagName.toUpperCase();
      this.attributes = attributes;
      this.parentElement = null;
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    closest(selector) {
      const parts = selector.split(",").map((s) => s.trim());
      let cur = this;
      while (cur) {
        for (const part of parts) {
          if (part.startsWith(".") && cur.attributes.className?.includes(part.slice(1))) return cur;
          if (part.startsWith("[") && part.endsWith("]")) {
            const attrMatch = part.slice(1, -1).split("=");
            const attrName = attrMatch[0];
            const attrVal = attrMatch[1]?.replace(/['"]/g, "");
            if (attrVal !== undefined) {
              if (cur.attributes[attrName] === attrVal) return cur;
            } else if (cur.attributes[attrName] !== undefined) {
              return cur;
            }
          }
          if (part.includes("[") && part.endsWith("]")) {
            const tag = part.slice(0, part.indexOf("[")).toLowerCase();
            const attr = part.slice(part.indexOf("[") + 1, -1);
            if (cur.tagName.toLowerCase() === tag && cur.attributes[attr] !== undefined) return cur;
          }
          if (cur.tagName.toLowerCase() === part.toLowerCase()) return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }
  }

  // Toolbar button and child icon
  const toolbarBtn = new MockElement("button", { "aria-controls": "file-panel" });
  const icon = new MockElement("svg");
  icon.parentElement = toolbarBtn;
  assert.equal(isFilePanelInteractionTarget(toolbarBtn), true);
  assert.equal(isFilePanelInteractionTarget(icon), true);

  // Desktop file panel toggle class
  const desktopBtn = new MockElement("button", { className: "desktop-file-panel-toggle" });
  assert.equal(isFilePanelInteractionTarget(desktopBtn), true);

  // Markdown local file link
  const link = new MockElement("a", { href: "/workspace/report.pdf" });
  const spanInLink = new MockElement("span");
  spanInLink.parentElement = link;
  assert.equal(isFilePanelInteractionTarget(link), true);
  assert.equal(isFilePanelInteractionTarget(spanInLink), true);

  // Written file item
  const writtenFile = new MockElement("button", { "data-file-path": "/src/main.ts" });
  assert.equal(isFilePanelInteractionTarget(writtenFile), true);

  // External network links must NOT be treated as file panel interactions (do not block general hyperlinks)
  const extWebLink = new MockElement("a", { href: "https://github.com/project/repo" });
  assert.equal(isFilePanelInteractionTarget(extWebLink), false, "https links must not be treated as file target");

  const extHttpLink = new MockElement("a", { href: "http://example.com/docs" });
  assert.equal(isFilePanelInteractionTarget(extHttpLink), false, "http links must not be treated as file target");

  const anchorHashLink = new MockElement("a", { href: "#heading-2" });
  assert.equal(isFilePanelInteractionTarget(anchorHashLink), false, "hash anchors must not be treated as file target");

  const mailLink = new MockElement("a", { href: "mailto:support@example.com" });
  assert.equal(isFilePanelInteractionTarget(mailLink), false, "mailto links must not be treated as file target");

  // Unrelated elements
  const normalBtn = new MockElement("button", {});
  const normalDiv = new MockElement("div", {});
  assert.equal(isFilePanelInteractionTarget(normalBtn), false);
  assert.equal(isFilePanelInteractionTarget(normalDiv), false);
});

test("differentiates touch synthetic clicks from keyboard and mouse interactions", () => {
  // Keyboard click: detail === 0, no touch capability
  const keyboardClick = { detail: 0 };
  assert.equal(isKeyboardClick(keyboardClick), true);
  assert.equal(isExplicitMouseClick(keyboardClick), false);
  assert.equal(isTouchClick(keyboardClick), false);

  // Mouse click: pointerType === "mouse", firesTouchEvents === false
  const mouseClick = {
    detail: 1,
    pointerType: "mouse",
    sourceCapabilities: { firesTouchEvents: false },
  };
  assert.equal(isKeyboardClick(mouseClick), false);
  assert.equal(isExplicitMouseClick(mouseClick), true);
  assert.equal(isTouchClick(mouseClick), false);

  // Chromium touch compatibility click: sourceCapabilities.firesTouchEvents === true
  const touchCompatClick = {
    detail: 1,
    sourceCapabilities: { firesTouchEvents: true },
  };
  assert.equal(isKeyboardClick(touchCompatClick), false);
  assert.equal(isExplicitMouseClick(touchCompatClick), false);
  assert.equal(isTouchClick(touchCompatClick), true);

  // PointerEvent touch click: pointerType === "touch"
  const pointerTouchClick = {
    detail: 1,
    pointerType: "touch",
  };
  assert.equal(isKeyboardClick(pointerTouchClick), false);
  assert.equal(isExplicitMouseClick(pointerTouchClick), false);
  assert.equal(isTouchClick(pointerTouchClick), true);
});

test("three-finger contact lifecycle: contamination, step-by-step release, and synthetic click blocking", () => {
  const guard = createTouchContactGuardCore();

  // 1. First finger down: clean single touch
  guard.handleTouchStart({ touches: [{ identifier: 1 }] });
  assert.equal(guard.isContaminated(), false);
  assert.equal(guard.isBlockPending(), false);

  // 2. Second finger down: contaminated!
  guard.handleTouchStart({ touches: [{ identifier: 1 }, { identifier: 2 }] });
  assert.equal(guard.isContaminated(), true);
  assert.equal(guard.isBlockPending(), true);

  // 3. Third finger down (e.g. 3-finger screenshot gesture): remains contaminated
  guard.handleTouchStart({ touches: [{ identifier: 1 }, { identifier: 2 }, { identifier: 3 }] });
  assert.equal(guard.isContaminated(), true);

  // 4. Step-by-step finger lift: finger 2 lifts (2 touches remaining)
  guard.handleTouchEnd({ touches: [{ identifier: 1 }, { identifier: 3 }] });
  assert.equal(guard.isContaminated(), true, "must keep contaminated during step-by-step release");

  // 5. Finger 1 lifts (1 touch remaining)
  guard.handleTouchEnd({ touches: [{ identifier: 3 }] });
  assert.equal(guard.isContaminated(), true, "must not treat 1 remaining finger as a new clean tap");

  // 6. Finger 3 lifts: all released
  guard.handleTouchEnd({ touches: [] });
  assert.equal(guard.isBlockPending(), true, "must wait to block synthetic click after full release");

  // 7. Synthetic compatibility click generated by browser after multi-touch release
  const syntheticClick1 = {
    detail: 1,
    sourceCapabilities: { firesTouchEvents: true },
  };
  assert.equal(guard.shouldBlockClick(syntheticClick1), true, "must block first synthetic click from contaminated multi-touch");

  // Consume the blocked click
  guard.consumeClickBlock();

  // Multi-click invariant: second compatibility click from the same multi-touch sequence must NOT leak
  const syntheticClick2 = {
    detail: 1,
    sourceCapabilities: { firesTouchEvents: true },
  };
  assert.equal(guard.shouldBlockClick(syntheticClick2), true, "must not leak second compatibility click from same multi-touch sequence");
  guard.consumeClickBlock();

  // Third compatibility click from the same multi-touch sequence
  const syntheticClick3 = {
    detail: 1,
    pointerType: "touch",
  };
  assert.equal(guard.shouldBlockClick(syntheticClick3), true, "must not leak third compatibility click from same multi-touch sequence");
  guard.consumeClickBlock();

  // 8. Legitimate new single-finger tap begins
  guard.handleTouchStart({ touches: [{ identifier: 4 }] });
  assert.equal(guard.isContaminated(), false, "new single-finger tap recovers immediately");
  assert.equal(guard.isBlockPending(), false);

  guard.handleTouchEnd({ touches: [] });
  assert.equal(guard.isBlockPending(), false);

  const cleanTapClick = {
    detail: 1,
    sourceCapabilities: { firesTouchEvents: true },
  };
  assert.equal(guard.shouldBlockClick(cleanTapClick), false, "clean single-finger tap click is allowed");
});

test("mouse and keyboard events are never blocked even if touch contact state was pending", () => {
  const guard = createTouchContactGuardCore();

  // Simulate multi-touch contamination
  guard.handleTouchStart({ touches: [{}, {}] });
  guard.handleTouchEnd({ touches: [] });
  assert.equal(guard.isBlockPending(), true);

  // Keyboard navigation on button/link (detail: 0) must be allowed
  const keyboardEnter = { detail: 0 };
  assert.equal(guard.shouldBlockClick(keyboardEnter), false);

  // Physical mouse click must be allowed
  const mouseClick = {
    detail: 1,
    pointerType: "mouse",
    sourceCapabilities: { firesTouchEvents: false },
  };
  assert.equal(guard.shouldBlockClick(mouseClick), false);
});

test("touchcancel during multi-touch screenshot or system gesture sets block pending", () => {
  const guard = createTouchContactGuardCore();

  // Multi-touch starts
  guard.handleTouchStart({ touches: [{}, {}, {}] });
  assert.equal(guard.isContaminated(), true);

  // System gesture cancels the touches
  guard.handleTouchCancel({ touches: [] });
  assert.equal(guard.isBlockPending(), true);

  // Synthetic click is still blocked
  assert.equal(guard.shouldBlockClick({ detail: 1, pointerType: "touch" }), true);
  guard.consumeClickBlock();

  // Next single-finger tap recovers immediately
  guard.handleTouchStart({ touches: [{}] });
  assert.equal(guard.isContaminated(), false);
  assert.equal(guard.isBlockPending(), false);
});

test("pointer event tracking handles multi-pointer sequences correctly", () => {
  const guard = createTouchContactGuardCore();

  // Pointer 1 down
  guard.handlePointerDown({ pointerId: 10, pointerType: "touch" });
  assert.equal(guard.isContaminated(), false);

  // Pointer 2 down
  guard.handlePointerDown({ pointerId: 11, pointerType: "touch" });
  assert.equal(guard.isContaminated(), true);

  // Pointer 1 up
  guard.handlePointerUp({ pointerId: 10, pointerType: "touch" });
  assert.equal(guard.isContaminated(), true);

  // Pointer 2 up
  guard.handlePointerUp({ pointerId: 11, pointerType: "touch" });
  assert.equal(guard.isBlockPending(), true);

  // Click is blocked
  assert.equal(guard.shouldBlockClick({ detail: 1, pointerType: "touch" }), true);
  guard.consumeClickBlock();

  // New pointer down recovers
  guard.handlePointerDown({ pointerId: 12, pointerType: "touch" });
  assert.equal(guard.isContaminated(), false);
});

test("window capture layer prevents legacy onLegacyFileLinkClick execution via defaultPrevented", () => {
  const guard = createTouchContactGuardCore();

  // 1. Contaminate with 3-finger contact
  guard.handleTouchStart({ touches: [{}, {}, {}] });
  guard.handleTouchEnd({ touches: [] });
  assert.equal(guard.isBlockPending(), true);

  // Mock DOM event on a legacy file link
  let defaultPrevented = false;
  let propagationStopped = false;
  let immediatePropagationStopped = false;
  const target = {
    tagName: "A",
    attributes: { "data-file-path": "/workspace/test-report.pdf" },
    getAttribute(n) { return this.attributes[n] ?? null; },
    closest(sel) {
      if (sel.includes("[data-file-path]") || sel.includes(".pi-enh-file-link")) return this;
      return null;
    },
  };

  const event = {
    target,
    button: 0,
    shiftKey: false,
    altKey: false,
    pointerType: "touch",
    get defaultPrevented() { return defaultPrevented; },
    preventDefault() { defaultPrevented = true; },
    stopPropagation() { propagationStopped = true; },
    stopImmediatePropagation() { immediatePropagationStopped = true; },
  };

  // Step 1: Window click capture runs first
  if (guard.shouldBlockClick(event) && isFilePanelInteractionTarget(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    guard.consumeClickBlock();
  }

  assert.equal(defaultPrevented, true, "window capture must call preventDefault on file interaction click");
  assert.equal(propagationStopped, true, "window capture must call stopPropagation");
  assert.equal(immediatePropagationStopped, true, "window capture must call stopImmediatePropagation");

  // Step 2: Legacy document capture listener onLegacyFileLinkClick runs afterwards
  let viewerOpenedWith = null;
  function mockLegacyFileLinkClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.shiftKey || e.altKey) return;
    const a = e.target?.closest?.(".pi-enh-file-link, [data-file-path]");
    if (!a) return;
    viewerOpenedWith = a.getAttribute("data-file-path");
  }

  mockLegacyFileLinkClick(event);
  assert.equal(viewerOpenedWith, null, "legacy file listener must early-return due to defaultPrevented, never opening viewer");
});

test("real keyboard and mouse clicks during and after contaminated window are 100% allowed", () => {
  const guard = createTouchContactGuardCore();

  // Enter contamination state
  guard.handleTouchStart({ touches: [{}, {}] });
  guard.handleTouchEnd({ touches: [] });
  assert.equal(guard.isBlockPending(), true);

  // Synthetic touch click is blocked
  const touchClick = { detail: 1, pointerType: "touch" };
  assert.equal(guard.shouldBlockClick(touchClick), true);
  guard.consumeClickBlock();

  // Keyboard Space / Enter (detail: 0) must be allowed immediately without false-positive suppression
  const keyboardEnter = { detail: 0, nativeEvent: { detail: 0 } };
  assert.equal(guard.shouldBlockClick(keyboardEnter), false, "keyboard enter must never be blocked");

  const keyboardSpace = { detail: 0, nativeEvent: { detail: 0, pointerType: "" } };
  assert.equal(guard.shouldBlockClick(keyboardSpace), false, "keyboard space must never be blocked");

  // Physical mouse click (pointerType: mouse, firesTouchEvents: false) must be allowed
  const mouseClick = {
    detail: 1,
    pointerType: "mouse",
    sourceCapabilities: { firesTouchEvents: false },
  };
  assert.equal(guard.shouldBlockClick(mouseClick), false, "physical mouse click must never be blocked");

  // Another synthetic touch click in the same sequence is still blocked
  const touchClick2 = { detail: 1, sourceCapabilities: { firesTouchEvents: true } };
  assert.equal(guard.shouldBlockClick(touchClick2), true, "second synthetic touch click in same sequence is still blocked");
});

