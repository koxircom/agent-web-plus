import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readNoticeRecovery, noticeRecoveryFromError, noticeRecoveryHelp } from "./notice-recovery.ts";

test("only allowlisted recovery actions survive the wire", () => {
  for (const recovery of ["connection", "session", "codex-client"]) {
    assert.equal(readNoticeRecovery(recovery), recovery);
    assert.equal(noticeRecoveryFromError({ recovery }), recovery);
    assert.ok(noticeRecoveryHelp(recovery).length > 20);
  }
  for (const value of ["https://evil.invalid", "javascript:alert(1)", { command: "stop" }, null]) {
    assert.equal(readNoticeRecovery(value), undefined);
    assert.equal(noticeRecoveryFromError({ recovery: value }), undefined);
  }
  assert.equal(noticeRecoveryFromError({ code: "codex_connection_required" }), "connection");
  assert.equal(noticeRecoveryFromError({ code: "codex_session_refresh" }), "session");
  assert.equal(noticeRecoveryFromError({ code: "codex_operation_unsupported" }), "codex-client");
  assert.equal(noticeRecoveryFromError(new Error("bridge/privateMethod")), undefined);
});

test("recovery metadata does not overwrite prompt delivery ownership", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("./agent-client.ts", import.meta.url), "utf8");
  assert.match(route, /recovery: noticeRecoveryFromError\(error\)/);
  assert.match(route, /code: uncertain \? "prompt_uncertain" : "prompt_rejected"/);
  assert.match(client, /readNoticeRecovery\(body\.recovery\)/);
});
