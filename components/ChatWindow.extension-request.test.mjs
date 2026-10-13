import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ExtensionWaitingCount, AskUserTextPanel, AskUserSurface } = await jiti.import("./AskUserPanel.tsx");

const [chatWindow, chatInput, askUserPanel] = await Promise.all([
  readSource("./ChatWindow.tsx"),
  readSource("./ChatInput.tsx"),
  readSource("./AskUserPanel.tsx"),
]);

async function readSource(path) {
  const text = await readFile(new URL(path, import.meta.url), "utf8");
  return {
    text,
    file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  };
}

function functionDeclaration(source, name) {
  const declaration = source.file.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, `expected function ${name}`);
  return declaration;
}

function tagName(node) {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName
    : ts.isJsxSelfClosingElement(node) ? node.tagName
      : null;
  return tag && ts.isIdentifier(tag) ? tag.text : null;
}

function findNodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function jsxNodes(root, predicate = () => true) {
  return findNodes(root, (node) =>
    (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && predicate(node),
  );
}

function attribute(node, source, name) {
  const opening = ts.isJsxElement(node) ? node.openingElement
    : ts.isJsxSelfClosingElement(node) ? node
      : null;
  return opening?.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText(source.file) === name,
  );
}

function attributeExpression(node, source, name) {
  const initializer = attribute(node, source, name)?.initializer;
  return initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
}

function attributeString(node, source, name) {
  const initializer = attribute(node, source, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function hasAttribute(node, source, name) {
  return Boolean(attribute(node, source, name));
}

function booleanAttribute(node, source, name, value) {
  const expression = attributeExpression(node, source, name);
  return expression?.kind === (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);
}

function hasTag(root, name) {
  return jsxNodes(root, (node) => tagName(node) === name).length > 0;
}

function hasStyleProperty(node, source, name, value) {
  const style = attributeExpression(node, source, "style");
  if (!style || !ts.isObjectLiteralExpression(style)) return false;
  return style.properties.some((property) => {
    if (!ts.isPropertyAssignment(property) || property.name.getText(source.file).replaceAll('"', "") !== name) return false;
    const initializer = property.initializer;
    return ts.isStringLiteral(initializer) && initializer.text === value;
  });
}

function compileArrow(source, arrow) {
  const js = ts.transpileModule(`(${arrow.getText(source.file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return (event, context = {}) => new Script(js).runInNewContext(context)(event);
}

function renderWaitingCount(count) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ExtensionWaitingCount, { count }),
  ));
}

test("renders extension requests in the native composer dock before the composer", () => {
  const chatWindowFunction = functionDeclaration(chatWindow, "ChatWindow");
  const chatInputCall = jsxNodes(chatWindowFunction, (node) => tagName(node) === "ChatInput")[0];
  const extensionPanel = attributeExpression(chatInputCall, chatWindow, "extensionPanel");
  assert.ok(extensionPanel, "ChatWindow must supply its extension panel to ChatInput");

  const dock = jsxNodes(extensionPanel, (node) =>
    tagName(node) === "div" && attributeString(node, chatWindow, "className") === "pi-native-extension-dock",
  )[0];
  assert.ok(dock, "extension requests use the native dock");
  assert.ok(jsxNodes(dock, (node) =>
    tagName(node) === "div" && attributeString(node, chatWindow, "className") === "pi-native-extension-column",
  ).length > 0, "the dock keeps requests in its native column");

  const chatInputFunction = findNodes(chatInput.file, (node) =>
    ts.isFunctionExpression(node) && node.name?.text === "ChatInput",
  )[0];
  assert.ok(chatInputFunction, "ChatInput renders the supplied extension panel");
  const insertedPanel = findNodes(chatInputFunction, (node) => ts.isJsxExpression(node) &&
    node.expression && ts.isIdentifier(node.expression) && node.expression.text === "extensionPanel")[0];
  const composerRoot = jsxNodes(chatInputFunction, (node) =>
    attributeString(node, chatInput, "data-pi-native-composer-layout") === "true",
  )[0];
  assert.ok(insertedPanel && composerRoot, "ChatInput must render the panel and native composer root");
  assert.equal(insertedPanel.parent, composerRoot.parent, "the dock is a sibling of the native composer root");
  assert.ok(insertedPanel.getStart() < composerRoot.getStart(), "the dock appears directly above the composer");
});

test("routes each request id and its own queue count into the current surfaces", () => {
  const chatWindowFunction = functionDeclaration(chatWindow, "ChatWindow");
  const dialog = jsxNodes(chatWindowFunction, (node) => tagName(node) === "ExtensionDialog")[0];
  const textPanel = jsxNodes(chatWindowFunction, (node) => tagName(node) === "AskUserTextPanel")[0];
  const customSurface = jsxNodes(chatWindowFunction, (node) => tagName(node) === "AskUserSurface")[0];
  assert.ok(dialog && textPanel && customSurface, "select/confirm, input/editor, and custom requests each have a surface");

  for (const [node, requestId] of [[dialog, "extensionDialog.id"], [textPanel, "extensionDialog.id"], [customSurface, "extensionCustomUi.id"]]) {
    assert.equal(attributeExpression(node, chatWindow, "key")?.getText(chatWindow.file), requestId,
      `${tagName(node)} is keyed by its active request id`);
  }
  for (const node of [dialog, textPanel]) {
    assert.equal(attributeExpression(node, chatWindow, "waitingCount")?.getText(chatWindow.file), "waitingExtensionDialogCount",
      `${tagName(node)} receives the dialog queue count`);
  }
  assert.equal(attributeExpression(customSurface, chatWindow, "waitingCount")?.getText(chatWindow.file), "waitingExtensionCustomUiCount",
    "the keyed custom surface receives the custom queue count");

  const fallback = attributeExpression(customSurface, chatWindow, "fallback");
  const fallbackPanel = fallback && jsxNodes(fallback, (node) => tagName(node) === "ExtensionCustomPanel")[0];
  assert.ok(fallbackPanel, "custom requests retain their fallback renderer under the keyed surface");
  assert.equal(attributeExpression(fallbackPanel, chatWindow, "waitingCount")?.getText(chatWindow.file), "waitingExtensionCustomUiCount",
    "the fallback receives the same custom queue count");

  const askUserSurface = functionDeclaration(askUserPanel, "AskUserSurface");
  const nativeAskUserPanel = jsxNodes(askUserSurface, (node) => tagName(node) === "AskUserPanel")[0];
  assert.equal(attributeExpression(nativeAskUserPanel, askUserPanel, "waitingCount")?.getText(askUserPanel.file), "waitingCount",
    "the native Ask User surface forwards its count to its panel");
});

test("keeps title scrolling independent from the expanded dialog body", () => {
  const dialogFunction = functionDeclaration(chatWindow, "ExtensionDialog");
  const expandedDialog = jsxNodes(dialogFunction, (node) =>
    tagName(node) === "div" && attributeString(node, chatWindow, "role") === "dialog",
  )[0];
  assert.ok(expandedDialog, "expanded select/confirm requests keep a dialog root");
  assert.ok(hasStyleProperty(expandedDialog, chatWindow, "maxHeight", "min(360px, 42dvh)"));

  const titleHeader = jsxNodes(expandedDialog, (node) => tagName(node) === "div" &&
    hasStyleProperty(node, chatWindow, "maxHeight", "min(100px, 14dvh)"))[0];
  assert.ok(titleHeader, "long titles are limited to a scrollable header");
  assert.ok(hasStyleProperty(titleHeader, chatWindow, "overflowY", "auto"));
  assert.ok(findNodes(titleHeader, (node) => ts.isJsxExpression(node) &&
    node.expression?.getText(chatWindow.file) === "request.title").length > 0);
  assert.ok(jsxNodes(titleHeader, (node) => hasStyleProperty(node, chatWindow, "whiteSpace", "pre-wrap")
    && hasStyleProperty(node, chatWindow, "overflowWrap", "anywhere")).length > 0,
  "title newlines and long words remain readable");

  const bodyScroller = jsxNodes(expandedDialog, (node) => tagName(node) === "div" &&
    hasStyleProperty(node, chatWindow, "overflowY", "auto") &&
    hasStyleProperty(node, chatWindow, "flex", "1 1 auto"))[0];
  assert.ok(bodyScroller, "the body has its own overflow scroller");
});

test("preserves cancellation and keyboard behavior for extension select/confirm requests", () => {
  const dialogFunction = functionDeclaration(chatWindow, "ExtensionDialog");
  const cancelButton = jsxNodes(dialogFunction, (node) => tagName(node) === "button" &&
    attributeExpression(node, chatWindow, "onClick")?.getText(chatWindow.file).includes("cancelled: true"))[0];
  assert.ok(cancelButton, "the dialog keeps an explicit cancel action");
  assert.ok(cancelButton.getText(chatWindow.file).includes('t("chat.cancel")'), "the action keeps the cancel label");

  const optionButton = jsxNodes(dialogFunction, (node) => tagName(node) === "div" &&
    hasAttribute(node, chatWindow, "data-extension-option") && hasAttribute(node, chatWindow, "onKeyDown"))[0];
  assert.ok(optionButton, "select options remain keyboard-operable");
  const optionKeyHandler = attributeExpression(optionButton, chatWindow, "onKeyDown");
  const request = { id: "request-1" };
  const responses = [];
  compileArrow(chatWindow, optionKeyHandler)({
    key: "Enter",
    preventDefault() {},
  }, { onRespond: (_request, response) => responses.push(response), request, option: "Second" });
  assert.equal(JSON.stringify(responses), JSON.stringify([{ value: "Second" }]));

  const optionList = jsxNodes(dialogFunction, (node) => tagName(node) === "div" &&
    attributeExpression(node, chatWindow, "onKeyDown")?.getText(chatWindow.file).includes("querySelectorAll"))[0];
  assert.ok(optionList, "select options keep arrow-key navigation");
  const optionListHandler = attributeExpression(optionList, chatWindow, "onKeyDown");
  const focused = [];
  const buttons = [0, 1].map((index) => ({
    focus() { focused.push(index); },
    scrollIntoView() {},
  }));
  let prevented = false;
  compileArrow(chatWindow, optionListHandler)({
    key: "ArrowDown",
    target: buttons[1],
    currentTarget: { querySelectorAll: () => buttons },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(focused, [0], "arrow navigation wraps the last option to the first");

  const root = jsxNodes(dialogFunction, (node) => tagName(node) === "div" &&
    attributeString(node, chatWindow, "className") === "pi-native-extension-host" && attribute(node, chatWindow, "onKeyDown"))[0];
  const escapeHandler = attributeExpression(root, chatWindow, "onKeyDown");
  const escapeResponses = [];
  let escapePrevented = false;
  compileArrow(chatWindow, escapeHandler)({
    key: "Escape", nativeEvent: { isComposing: false },
    preventDefault() { escapePrevented = true; }, stopPropagation() {},
  }, { request, onRespond: (_request, response) => escapeResponses.push(response) });
  assert.equal(escapePrevented, true);
  assert.equal(JSON.stringify(escapeResponses), JSON.stringify([{ cancelled: true }]));
});

test("renders confirmation and select-option content through MarkdownBody", () => {
  const markdownImport = chatWindow.file.statements.some((statement) =>
    ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === "./MarkdownBody",
  );
  assert.equal(markdownImport, true);
  const dialogFunction = functionDeclaration(chatWindow, "ExtensionDialog");
  const markdownChildren = jsxNodes(dialogFunction, (node) => tagName(node) === "MarkdownBody")
    .flatMap((node) => ts.isJsxElement(node) ? node.children : []);
  const expressions = markdownChildren.filter(ts.isJsxExpression).map((node) => node.expression?.getText(chatWindow.file));
  assert.ok(expressions.includes("request.message"), "confirm messages retain Markdown rendering");
  assert.ok(expressions.includes("option"), "select options retain Markdown rendering");
});

test("shows queue waiting counts in collapsed and expanded headers and hides zero", () => {
  const dialogFunction = functionDeclaration(chatWindow, "ExtensionDialog");
  const customFunction = functionDeclaration(chatWindow, "ExtensionCustomPanel");
  for (const component of [dialogFunction, customFunction]) {
    const collapsedHeader = jsxNodes(component, (node) => tagName(node) === "button" &&
      booleanAttribute(node, chatWindow, "aria-expanded", false))[0];
    const expandedHeader = jsxNodes(component, (node) => tagName(node) === "div" &&
      attributeString(node, chatWindow, "role") === "dialog")[0];
    assert.ok(collapsedHeader && hasTag(collapsedHeader, "ExtensionWaitingCount"),
      `${component.name.text} shows the count while collapsed`);
    assert.ok(expandedHeader && hasTag(expandedHeader, "ExtensionWaitingCount"),
      `${component.name.text} shows the count while expanded`);
  }

  const textPanelFunction = functionDeclaration(askUserPanel, "AskUserTextPanel");
  const nativePanelFunction = functionDeclaration(askUserPanel, "AskUserPanel");
  for (const component of [textPanelFunction, nativePanelFunction]) {
    const questionRow = jsxNodes(component, (node) => tagName(node) === "div" &&
      attributeString(node, askUserPanel, "className") === "pi-native-ask-question-row")[0];
    assert.ok(questionRow && hasTag(questionRow, "ExtensionWaitingCount"),
      `${component.name.text} displays the queue count in its native question row`);
  }

  const zero = renderWaitingCount(0);
  const positive = renderWaitingCount(3);
  assert.equal(zero, "", "an empty waiting queue adds no visible marker");
  assert.match(positive, /role="status"/);
  assert.match(positive, /还有 3 个/);
});

test("native text and custom question surfaces render their own waiting count", () => {
  const question = { toolCallId: "question", question: "选择继续方式", options: [{ title: "继续" }] };
  const custom = { id: "custom", method: "custom", lines: [], askUser: question };
  const render = (Component, props) => renderToStaticMarkup(React.createElement(
    I18nProvider, null, React.createElement(Component, props),
  ));
  for (const waitingCount of [0, 2]) {
    for (const method of ["input", "editor"]) {
      const html = render(AskUserTextPanel, { request: { id: method, method, title: "请回答" }, onRespond() {}, waitingCount });
      assert.equal(html.includes("还有 2 个"), waitingCount > 0, method);
    }
    const html = render(AskUserSurface, { request: custom, onInput: async () => true, fallback: "terminal fallback", waitingCount });
    assert.ok(html.includes(question.question));
    assert.equal(html.includes("还有 2 个"), waitingCount > 0, "custom native question");
    assert.equal(html.includes("terminal fallback"), false);
  }
  const fallback = render(AskUserSurface, { request: { ...custom, askUser: undefined }, onInput: async () => true, fallback: "terminal fallback", waitingCount: 2 });
  assert.equal(fallback, "terminal fallback");
});
