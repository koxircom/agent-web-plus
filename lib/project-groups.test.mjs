import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const {
  getProjectActivity,
  getRecentProjects,
  isLegitimateProjectRoot,
  sessionsForProject,
} = await jiti.import("./project-groups.ts");

function session(id, projectRoot, modified) {
  return {
    id,
    path: `${id}.jsonl`,
    cwd: projectRoot,
    projectRoot,
    projectKey: projectIdentityKey(projectRoot, "win32"),
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
  };
}

test("Windows path variants form one recent project using the newest display path", () => {
  const older = session("older", "C:\\Users\\Alex\\Project\\Study\\ELM", "2026-08-12T00:00:00.000Z");
  const newer = session("newer", "c:/users/ALEX/project/study/elm", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(getRecentProjects([older, newer]), [{
    key: older.projectKey,
    root: newer.projectRoot,
  }]);
});

test("project filtering includes every session with the stable identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");
  const other = session("other", "D:\\Elsewhere", "2026-08-13T01:00:00.000Z");

  assert.deepEqual(
    sessionsForProject([first, second, other], first.projectKey).map((item) => item.id),
    ["first", "second"],
  );
});

test("running and unread counts aggregate under the stable project identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");

  const activity = getProjectActivity(
    [first, second],
    new Set(["first", "second"]),
    new Set(["second"]),
  );

  assert.deepEqual(activity.get(first.projectKey), { running: 2, unread: 1 });
  assert.equal(activity.size, 1);
});

test("temporary test directories and system roots are filtered out of recent projects", () => {
  const normal = session("work", "/workspace/work", "2026-11-05T00:00:00.000Z");
  const odoo = session("odoo", "/workspace/odoo", "2026-11-05T01:00:00.000Z");
  const tmp1 = session("tmp1", "/tmp/test-subagent-poc", "2026-11-05T02:00:00.000Z");
  const tmp2 = session("tmp2", "/tmp", "2026-11-05T03:00:00.000Z");
  const ptmp = session("ptmp", "/private/tmp/run", "2026-11-05T04:00:00.000Z");
  const app = session("app", "/app", "2026-11-05T05:00:00.000Z");

  assert.equal(isLegitimateProjectRoot("/tmp/foo"), false);
  assert.equal(isLegitimateProjectRoot("/tmp"), false);
  assert.equal(isLegitimateProjectRoot("/app"), false);
  assert.equal(isLegitimateProjectRoot("/workspace/work"), true);
  assert.equal(isLegitimateProjectRoot("/workspace/odoo"), true);

  const projects = getRecentProjects([normal, odoo, tmp1, tmp2, ptmp, app]);
  assert.deepEqual(
    projects.map((p) => p.root),
    ["/workspace/odoo", "/workspace/work"],
  );
});
