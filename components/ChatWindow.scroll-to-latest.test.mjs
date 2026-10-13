import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const scrollButtonSource = await readFile(new URL("./ChatScrollToBottom.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const scrollHelperSource = await readFile(new URL("../lib/chat-scroll-to-bottom.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function elementBlock() {
  const start = scrollButtonSource.indexOf("className={`chat-scroll-to-bottom");
  assert.notEqual(start, -1, "scroll-to-latest button not found");
  const buttonStart = scrollButtonSource.lastIndexOf("return <button", start);
  const buttonEnd = scrollButtonSource.indexOf("</button>", start);
  assert.notEqual(buttonStart, -1);
  assert.notEqual(buttonEnd, -1);
  return scrollButtonSource.slice(buttonStart, buttonEnd);
}

test("centers a new empty composer and keeps a loading session composer at the bottom", () => {
  assert.match(source, /\{isEmptyNew && <div className="min-h-0 flex-1" \/>\}/);
  assert.match(source, /if \(loading\)[\s\S]*?className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"[\s\S]*?<div className="chat-composer-footer relative shrink-0"(?: key="chat-input-container")?>\s*\{chatInputElement\}/);
});

test("shows the scroll-to-latest button only when the viewport is detached from the tail", () => {
  assert.match(source, /<ChatScrollToBottom\s+visible=\{showScrollToBottom && !pendingScrollRestore\}/);
  assert.match(
    scrollButtonSource,
    /className=\{`chat-scroll-to-bottom\$\{enhanced \? " is-enhanced" : ""\}\$\{visible \? " is-visible" : ""\}`\}/,
    "visibility must be a class toggle so the exit transition can play",
  );
});

test("floats the scroll-to-latest button above the composer, clear of the minimap", () => {
  const footer = source.indexOf('<div className="chat-composer-footer relative shrink-0"');
  const marker = source.indexOf("<ChatScrollToBottom", footer);
  assert.notEqual(footer, -1);
  assert.notEqual(marker, -1);
  const container = source.slice(footer, marker);
  const block = elementBlock();

  assert.match(container, /position: "absolute"/);
  assert.match(container, /bottom: "100%"/);
  assert.match(container, /right: columnEndInset/);
  assert.match(source, /const columnEndInset = useChatColumnInset\(scrollContainerRef, !loading && !error && !isEmptyNew, isMobile \? 0 : CHAT_MINIMAP_WIDTH\)/);
  assert.match(container, /justifyContent: "center"/);
  assert.match(container, /pointerEvents: "none"/);
  assert.match(cssSource, /\.chat-scroll-to-bottom\.is-visible \{[\s\S]*?pointer-events: auto;/);
  assert.match(cssSource, /\.chat-scroll-to-bottom:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent\)/);
  assert.match(block, /onClick=\{\(\) => \{/);
  assert.match(block, /window\.dispatchEvent\(new Event\("pi-chat-cancel-scroll-restore"\)\)/);
  assert.match(block, /if \(container\) cancelRef\.current = convergeChatTail\(container\)/);
});

test("keeps the visible button faint until hover or focus", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));
  const visible = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible {"));
  const reveal = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible:hover"));

  assert.match(visible.slice(0, visible.indexOf("}")), /opacity: 0\.28;[\s\S]*?visibility: visible;[\s\S]*?transform: none;/);
  assert.match(reveal.slice(0, reveal.indexOf("}")), /opacity: 1;/);
  assert.match(
    cssSource,
    /\.chat-scroll-to-bottom\.is-visible:hover,\s*\.chat-scroll-to-bottom\.is-visible:focus-visible \{[\s\S]*?opacity: 1;/,
  );
});

test("fades the button in and out without motion when motion is reduced", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));

  assert.match(hidden.slice(0, hidden.indexOf("}")), /opacity: 0;[\s\S]*?visibility: hidden;[\s\S]*?transform: translateY\(4px\) scale\(0\.96\);/);
  assert.match(hidden.slice(0, hidden.indexOf("}")), /transition:[\s\S]*?opacity 0\.16s ease,[\s\S]*?transform 0\.16s ease,[\s\S]*?visibility 0s linear 0\.16s;/);
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-scroll-to-bottom,\s*\.chat-scroll-to-bottom\.is-visible \{\s*transform: none;\s*transition:\s*opacity 0\.16s ease,/,
  );
});

test("converges to the live tail with the shared scroll helper", () => {
  const block = elementBlock();

  assert.match(block, /aria-label=\{label\}/);
  assert.match(scrollButtonSource, /import \{ convergeChatTail \} from "@\/lib\/chat-scroll-to-bottom"/);
  assert.match(scrollHelperSource, /const target = Math\.max\(0, height - container\.clientHeight\)/);
  assert.match(scrollHelperSource, /container\.scrollTo\(\{ top: target, behavior: "instant" \}\)/);
});

test("exposes the detached-tail flag from the session hook without a ref read", () => {
  assert.match(hookSource, /const \[showScrollToBottom, setShowScrollToBottom\] = useState\(false\)/);
  assert.match(
    hookSource,
    /const shouldShow = shouldShowScrollToLatest\(scrollTop, clientHeight, scrollHeight\);\s*setShowScrollToBottom\(\(previous\) => \(previous === shouldShow \? previous : shouldShow\)\);/,
  );
  assert.match(hookSource, /promptAnchorActive,\s*promptScrollRevision,\s*showScrollToBottom,\s*\/\/ Refs/);
});
