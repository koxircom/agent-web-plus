import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  alias: { "@/": `${rootDir}/` },
});

test("ChatInput static markup has empty React annotation host before textarea with data-pi-native-annotation-host", async () => {
  const { ChatInput } = await jiti.import("@/components/ChatInput.tsx");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        isStreaming: false,
        onSend() {},
      })
    )
  );

  assert.match(markup, /data-pi-native-annotation-host="true"/);
  const hostIndex = markup.indexOf('data-pi-native-annotation-host="true"');
  const textareaIndex = markup.indexOf("<textarea");
  assert.ok(hostIndex !== -1, "data-pi-native-annotation-host must exist in markup");
  assert.ok(textareaIndex !== -1, "textarea must exist in markup");
  assert.ok(hostIndex < textareaIndex, "annotation host must precede textarea in DOM order");

  // Host must be empty by default (no React children rendered inside it)
  const hostMatch = markup.match(/<div[^>]*data-pi-native-annotation-host="true"[^>]*>(.*?)<\/div>/);
  assert.ok(hostMatch, "empty host div must match");
  assert.equal(hostMatch[1], "", "React annotation host must be empty on initial render");
});

test("ChatInput compact mode omits annotation slot while retaining native composer identity", async () => {
  const { ChatInput } = await jiti.import("@/components/ChatInput.tsx");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");

  const compactMarkup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        isStreaming: false,
        onSend() {},
        compact: true,
      })
    )
  );

  assert.doesNotMatch(compactMarkup, /data-pi-native-annotation-host/, "compact mode must not render annotation host");
  assert.match(compactMarkup, /data-pi-native-composer-host/, "compact mode must retain unrelated native ownership identity");
});

test("composer.css grid rows: attachments/banner=row 1, host=row 2, textarea=row 3, toolbar=row 4", () => {
  const css = fs.readFileSync(path.join(rootDir, "app/composer.css"), "utf8");

  // Row 1: banner & attachments
  assert.match(css, /\.chat-composer-card \.chat-composer-banner-stack\s*\{[^}]*grid-area:\s*1\s*\/\s*1\s*\/\s*2\s*\/\s*-1/);
  assert.match(css, /\.chat-composer-card \.chat-composer-attachments\s*\{[^}]*grid-area:\s*1\s*\/\s*1\s*\/\s*2\s*\/\s*-1/);

  // Row 2: annotation host
  assert.match(css, /\.chat-composer-card \[data-pi-native-annotation-host\]\s*\{[^}]*grid-area:\s*2\s*\/\s*1\s*\/\s*3\s*\/\s*-1/);
  assert.match(css, /\.chat-composer-card \[data-pi-native-annotation-host\]:empty\s*\{[^}]*display:\s*none/);

  // Row 3: textarea
  assert.match(css, /\.chat-composer-card textarea\.chat-input-textarea[^}]*\{[^}]*grid-area:\s*3\s*\/\s*1\s*\/\s*4\s*\/\s*-1/);

  // Row 4: toolbar controls (no remaining grid-row: 3 in toolbar)
  assert.doesNotMatch(css, /grid-row:\s*3;/);
  assert.match(css, /\.chat-composer-card \.chat-composer-add-btn\s*\{[^}]*grid-row:\s*4;/);
  assert.match(css, /\.chat-composer-card \.chat-composer-attachment-controls\s*\{[^}]*grid-row:\s*4;/);
  assert.match(css, /\.chat-composer-card \.chat-composer-attach-btn[^}]*\{[^}]*grid-row:\s*4;/);
  assert.match(css, /\.chat-composer-card \.chat-composer-mode-status\s*\{[^}]*grid-row:\s*4;/);
  assert.match(css, /\.chat-composer-card \.chat-composer-model-controls\s*\{[^}]*grid-row:\s*4;/);
  assert.match(css, /\.chat-composer-card \.chat-composer-send-group[^}]*\{[^}]*grid-row:\s*4;/);
  assert.match(css, /\.chat-composer-card button\.chat-composer-stop\s*\{[^}]*grid-row:\s*4;/);
});

test("host rules converged single-owner in composer.css, non-native fallback preserved in enhancements.css", () => {
  const compCss = fs.readFileSync(path.join(rootDir, "app/composer.css"), "utf8");
  const enhCss = fs.readFileSync(path.join(rootDir, "app/enhancements.css"), "utf8");

  // Non-native fallback preserved in enhancements.css
  assert.match(enhCss, /\.pi-enh-annotation-rail\s*\{[^}]*margin:\s*0\s+auto/);
  assert.match(enhCss, /\.pi-enh-annotation-badge\s*\{[^}]*margin:\s*0\s+0\s+8px/);

  // Single-ownership: enhancements.css must NOT contain duplicate host rules
  assert.doesNotMatch(enhCss, /\[data-pi-native-annotation-host\]/);

  // Native host adapted in composer.css
  assert.match(compCss, /\[data-pi-native-annotation-host\] \.pi-enh-annotation-rail/);
  assert.match(compCss, /\[data-pi-native-annotation-host\] \.pi-enh-annotation-badge/);
});
