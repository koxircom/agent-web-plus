import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SessionDeletionOrigin = "api-single" | "api-batch" | "native";
type Plan = { operationId: string; origin: SessionDeletionOrigin; requestedIds: string[]; resolvedIds: string[] };

/** Small metadata journal. It contains no transcript, credentials or client IP.
 * The durable plan precedes mutation; a failed outcome write never undoes or
 * misreports an already successful deletion. External unlink is not attributed. */
export function createSessionDeletionAudit(agentDir = getAgentDir()) {
  const dir = join(agentDir, "state"), file = join(dir, "session-deletions-v1.jsonl");
  const write = (record: object) => {
    const firstCreated = mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existed = existsSync(file);
    const fd = openSync(file, "a", 0o600);
    try { writeFileSync(fd, JSON.stringify({ schema: 1, at: new Date().toISOString(), ...record }) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (!existed && process.platform !== "win32") {
      const parent = openSync(dir, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    if (firstCreated && process.platform !== "win32") {
      for (let current = dir; ; current = dirname(current)) {
        const parent = openSync(dirname(current), "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
        if (current === firstCreated) break;
      }
    }
  };
  return {
    begin(requestedIds: string[], resolvedIds: string[], origin: SessionDeletionOrigin): Plan {
      const plan = { operationId: randomUUID(), origin, requestedIds: [...requestedIds], resolvedIds: [...resolvedIds] };
      write({ ...plan, phase: "planned" });
      return plan;
    },
    finish(plan: Plan, outcome: { deletedIds: string[]; missingIds: string[]; failedIds: string[] }) {
      write({ ...plan, ...outcome, phase: outcome.failedIds.length ? "failed-or-partial" : "completed" });
    },
  };
}
