import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const shelfSource = await readFile(new URL("./NoticeShelf.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("renders temporary notices once at the top right of the chat column", () => {
  const noticeShelfUsages = source.match(/<NoticeShelf notices=\{notices\}/g) ?? [];

  assert.equal(noticeShelfUsages.length, 1);
  assert.match(
    source,
    /position: "absolute",\s*top: 12,\s*left: 0,\s*right: isMobile \? 0 : CHAT_MINIMAP_WIDTH,[\s\S]*?justifyContent: "flex-end",[\s\S]*?<NoticeShelf notices=\{notices\} floating onPauseChange=\{setNoticePaused\}[^\n]*\/>/,
  );
});

test("pauses only for a visible notice", () => {
  assert.match(
    hookSource,
    /noticeState\.visible\.some\(\(notice\) => notice\.id === pausedNoticeId\)\) return/,
  );
});

test("lets keyboard users pause and scroll long notices", () => {
  assert.match(shelfSource, /onFocus=\{\(\) => onPauseChange\?\.\(notice\.id\)\}/);
  assert.match(shelfSource, /onBlur=\{\(event\) => \{\s*if \(!event\.currentTarget\.contains\(event\.relatedTarget as Node \| null\) && !event\.currentTarget\.matches\(":hover"\)\) onPauseChange\?\.\(null\)/);
  assert.match(shelfSource, /onMouseLeave=\{\(event\) => \{\s*if \(!event\.currentTarget\.contains\(document\.activeElement\)\) onPauseChange\?\.\(null\)/);
  assert.match(shelfSource, /<div\s+tabIndex=\{0\}\s+style=\{\{[^}]*overflowY: "auto"/);
});


test("shared notices expose safe recovery controls for Pi and Codex", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { NoticeShelf } = await jiti.import("./NoticeShelf.tsx");
  for (const sessionId of ["pi-session", "codex:session"]) {
    const render = (notice) => renderToStaticMarkup(React.createElement(NoticeShelf, {
      notices: [{ id: "n", type: "warning", message: "当前操作未完成", ...notice }],
      sessionId, onDismiss() {}, onRefresh() {}, onOpenConnectionSettings() {},
    }));
    assert.match(render({ recovery: "connection" }), /打开连接设置/);
    assert.match(render({ recovery: "session" }), /刷新会话状态/);
    const unsupported = render({ recovery: "codex-client" });
    assert.match(unsupported, /回到发起任务的 Codex 桌面应用或 CLI/);
    assert.doesNotMatch(unsupported, />刷新会话状态</);
    const unknown = render({});
    assert.match(unknown, /查看处理方式/);
    assert.match(unknown, /复制问题信息/);
    assert.match(unknown, /打开问题反馈/);
    assert.match(unknown, /关闭提示/);
    assert.doesNotMatch(render({ type: "success" }), /查看处理方式/);
  }
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShell, /onOpenSettings=\{openSettingsSection\}/);
  assert.match(hookSource, /recovery: request\.recovery/);
  assert.match(hookSource, /dismissNotice:|setNoticePaused: setPausedNoticeId, dismissNotice/);
  assert.match(hookSource, /case "extension_ui_closed":[\s\S]*?dispatchNotice\(\{ type: "remove", id: event\.id/);
  assert.match(hookSource, /回答未能确认提交[\s\S]*?recovery: "session"/);
});
