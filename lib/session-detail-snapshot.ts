import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionContext } from "./types";
import { buildSessionContext } from "./session-context";
import { projectTreeForResponse, toSummaryTree } from "./project-tree";
import { computeSessionTotalActiveMs } from "./session-timing";
import { computeSessionStats, type SessionFileStats } from "./session-stats";
import { computeSessionRevision } from "./session-revision";
import { readSubagentRun, readSubagentSessionResources } from "./subagent-session-snapshot";
import { readSessionToolSelection } from "./session-tool-selection";

export interface SessionDetailSnapshotOptions {
  filePath: string;
  sessionId: string;
  sourceId: string;
  summaryTree: boolean;
  deferThinking: boolean;
  deferToolResults?: boolean;
  deferToolResultImages: boolean;
  tail: number;
  fingerprint?: string;
  unstable?: boolean;
}

export interface SessionDetailSnapshot {
  leafId: string | null;
  tree: unknown[];
  context: SessionContext;
  stats: SessionFileStats;
  totalActiveMs: number;
  snapshotRevision: string | null;
  header: ReturnType<SessionManager["getHeader"]>;
  sessionName: ReturnType<SessionManager["getSessionName"]>;
  firstMessage: string;
  subagent: ReturnType<typeof readSubagentRun>;
  toolNames: string[] | undefined;
}

/** Project one authoritative SessionManager snapshot into the session detail payload. */
export function buildSessionDetailSnapshot(
  sessionManager: SessionManager,
  options: SessionDetailSnapshotOptions,
): SessionDetailSnapshot {
  const entries = sessionManager.getEntries() as unknown as SessionEntry[];
  const leafId = sessionManager.getLeafId();
  const projectedTree = projectTreeForResponse(sessionManager.getTree());
  const tree = options.summaryTree ? toSummaryTree(projectedTree) : projectedTree;
  const context = buildSessionContext(entries, leafId, {
    deferThinking: options.deferThinking,
    deferToolResults: options.deferToolResults,
    deferToolResultImages: options.deferToolResultImages,
    tail: options.tail,
    sessionId: options.sessionId,
  });
  const totalActiveMs = computeSessionTotalActiveMs(entries);
  const stats = computeSessionStats(entries);
  const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
  const snapshotRevision = computeSessionRevision({
    filePath: options.filePath,
    sourceId: options.sourceId,
    entryCount: entries.length,
    latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
    leafId: leafId ?? null,
    unstable: options.unstable,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  });
  const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
  const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;
  const firstMessage = firstUserMessage?.role === "user"
    ? (() => {
        const content = firstUserMessage.content;
        return typeof content === "string"
          ? content
          : (Array.isArray(content)
            ? (content.find((block) => block.type === "text") as { text: string } | undefined)?.text ?? ""
            : "") || "(no messages)";
      })()
    : "(no messages)";
  const header = sessionManager.getHeader();
  const subagent = header ? readSubagentRun(entries, header.id, options.filePath) : null;
  const toolNames = readSubagentSessionResources(entries)?.tools ?? readSessionToolSelection(entries);

  return {
    leafId,
    tree,
    context,
    stats,
    totalActiveMs,
    snapshotRevision,
    header,
    sessionName: sessionManager.getSessionName(),
    firstMessage,
    subagent,
    toolNames,
  };
}
