import { isCodexSessionId } from "@/lib/execution-engine-settings";
import { selectSessionReadRuntime, isSessionReadStable } from "@/lib/session-read-source";
import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { deleteSessions } from "@/lib/session-delete";
import {
  attachSessionProjectInfo,
  openSessionManager,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  getSessionFileFingerprint,
  readSessionHeader,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { getPromptEntryIds } from "@/lib/prompt-delivery";
import { startServerPerf } from "@/lib/perf";
import { jsonResponse } from "@/lib/json-response";
import { negotiateSessionSync, type SessionSyncScope } from "@/lib/session-sync-server";
import { getSessionHistoryPool, HistoryAbortedError } from "@/lib/session-history-pool";
import { buildSessionDetailSnapshot, type SessionDetailSnapshot } from "@/lib/session-detail-snapshot";
import {
  GUARD_VERSION,
  ensureSessionWriteGuardInstalled,
} from "@/lib/usage-delete-guard";

ensureSessionWriteGuardInstalled();

function sessionSnapshotChanged(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (isCodexSessionId(id)) {
    try {
      return Response.json(await (await import("@/lib/execution-engines/codex-engine")).readCodexSession(id, req), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 502;
      return Response.json({ error: error instanceof Error ? error.message : "历史记录暂时无法读取" },
        { status: status >= 400 && status <= 599 ? status : 502, headers: { "Cache-Control": "no-store" } });
    }
  }
  const perf = startServerPerf("GET /api/sessions/[id]");
  try {
    perf?.span("resolve");
    const rpc = getRpcSession(id);
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    // Persisted idle wrappers read stable disk. A new SDK session has no file
    // until its first conversation message and must retain its memory source.
    const liveRpc = selectSessionReadRuntime(liveWrapper);
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    const filePath = liveRpc?.sessionFile || resolvedPath || "";
    if (searchParams.get("lookup") === "1") {
      // A search click needs only current identity, never a full history parse.
      let exists = Boolean(liveRpc);
      if (!exists) {
        try { exists = getSessionFileFingerprint(filePath) !== null && readSessionHeader(filePath)?.id === id; }
        catch { /* A concurrent removal is an unavailable result. */ }
      }
      return NextResponse.json(exists ? { sessionId: id, exists: true } : { error: "Session not found" }, {
        status: exists ? 200 : 404, headers: { "Cache-Control": "no-store" },
      });
    }
    const summaryTree = searchParams.get("tree") === "summary";
    const deferToolResults = searchParams.get("deferTools") === "1";
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;

    const buildSnapshot = async () => {
      if (req.signal.aborted) throw new HistoryAbortedError();
      const actualFilePath = liveRpc?.sessionFile
        || liveRpc?.inner.sessionManager.getSessionFile()
        || resolvedPath
        || "";
      let diskFingerprint: string | undefined;
      let snapshot: SessionDetailSnapshot;
      if (liveRpc) {
        perf?.span("open");
        snapshot = buildSessionDetailSnapshot(liveRpc.inner.sessionManager, {
          filePath: actualFilePath,
          sessionId: id,
          sourceId: `runtime:${String(liveRpc.inner.sessionId)}`,
          summaryTree,
          unstable: Boolean(liveRpc.hasUnpersistedSession?.()),
          deferThinking,
          deferToolResults,
          deferToolResultImages,
          tail,
        });
        // The live writer remains the authoritative source; reject a snapshot
        // if that wrapper was replaced or stopped while its data was projected.
        const currentRpc = getRpcSession(id);
        if (currentRpc !== liveRpc || selectSessionReadRuntime(liveRpc) !== liveRpc) {
          throw sessionSnapshotChanged("构建会话详情期间，运行中的写入状态发生变化，请重试。");
        }
      } else {
        const pool = getSessionHistoryPool();
        const result = await pool.querySessionDetailResult(actualFilePath, {
          sessionId: id,
          sourceId: "disk",
          summaryTree,
          deferThinking,
          deferToolResults,
          deferToolResultImages,
          tail,
          signal: req.signal,
        });
        if (typeof result.fingerprint !== "string") {
          throw sessionSnapshotChanged("读取会话详情时无法验证文件版本，请重试。");
        }
        diskFingerprint = result.fingerprint;
        if (req.signal.aborted) throw new HistoryAbortedError();
        if (!isSessionReadStable(liveWrapper, getRpcSession(id))) {
          throw sessionSnapshotChanged("读取会话详情期间，运行中的写入状态发生变化，请重试。");
        }
        snapshot = JSON.parse(result.jsonString) as SessionDetailSnapshot;
        perf?.span("open");
      }
      if (req.signal.aborted) throw new HistoryAbortedError();
      perf?.span("tree");
      perf?.span("context");
      perf?.span("stats");
      const { leafId, tree, context, totalActiveMs, stats, snapshotRevision, sessionName, header, subagent, toolNames } = snapshot;
      let modified = header?.timestamp ?? new Date().toISOString();
      try { modified = statSync(actualFilePath).mtime.toISOString(); } catch { /* use header timestamp */ }
      const parentSessionId = header?.parentSession
        ? await resolveSessionIdByPath(header.parentSession)
        : undefined;
      if (req.signal.aborted) throw new HistoryAbortedError();
      const info = header ? (await attachSessionProjectInfo([{
        path: actualFilePath,
        id: header.id,
        cwd: header.cwd ?? "",
        name: sessionName,
        created: header.timestamp,
        modified,
        messageCount: stats.totalMessages,
        firstMessage: snapshot.firstMessage,
        parentSessionId,
        ...(subagent
          ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
          : header.parentSession
            ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
            : {}),
        transient: !actualFilePath || !existsSync(actualFilePath),
      }]))[0] : null;
      if (req.signal.aborted) throw new HistoryAbortedError();
      // attachSessionProjectInfo is asynchronous. Revalidate after it completes,
      // because a writer/runtime can replace the selected source while project
      // metadata is being resolved even when the initial snapshot was stable.
      const finalRpc = getRpcSession(id);
      if (liveRpc) {
        if (finalRpc !== liveRpc || selectSessionReadRuntime(liveRpc) !== liveRpc) {
          throw sessionSnapshotChanged("读取会话详情期间，运行中的写入状态发生变化，请重试。");
        }
      } else {
        if (!isSessionReadStable(liveWrapper, finalRpc)) {
          throw sessionSnapshotChanged("读取会话详情期间，运行中的写入状态发生变化，请重试。");
        }
        if (diskFingerprint && getSessionFileFingerprint(actualFilePath) !== diskFingerprint) {
          throw sessionSnapshotChanged("读取会话详情期间，会话文件发生变化，请重试。");
        }
      }

      return {
        sessionId: id,
        promptEntryIds: Object.fromEntries(Object.entries(getPromptEntryIds(id)).filter(([, entryId]) => context.entryIds.includes(entryId))),
        filePath: actualFilePath,
        info,
        leafId,
        tree,
        usageDeleteGuard: GUARD_VERSION,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      };
    };

    const isSync = searchParams.get("sync") === "1";
    if (isSync) {
      const baseRevision = searchParams.get("baseRevision");
      const scope: SessionSyncScope = {
        sessionId: id,
        summaryTree,
        tail,
        deferThinking,
        deferMedia: deferToolResultImages,
        deferToolResults,
      };
      const initialRpc = liveWrapper;
      const syncResponse = await negotiateSessionSync({
        sessionId: id,
        filePath,
        baseRevision,
        scope,
        isLive: Boolean(liveRpc),
        isRunning: Boolean(liveRpc?.isRunning()),
        getFileFingerprint: getSessionFileFingerprint,
        buildSnapshot,
        isStableRead: () => {
          const currentRpc = getRpcSession(id);
          return isSessionReadStable(initialRpc, currentRpc);
        },
      });
      if (req.signal.aborted) throw new HistoryAbortedError();
      const res = jsonResponse(req, syncResponse, {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Pi-Session-Sync": "1",
        },
      });
      return perf?.attach(res) ?? res;
    }

    const responseData = await buildSnapshot();
    if (req.signal.aborted) throw new HistoryAbortedError();
    return perf?.attach(jsonResponse(req, responseData)) ?? jsonResponse(req, responseData);
  } catch (error) {
    const err = error as { name?: string; statusCode?: number; message?: string };
    const status = req.signal.aborted || err?.name === "HistoryAbortedError" ? 499 : (err?.statusCode ?? 500);
    const headers = status === 503 ? { "Retry-After": "1" } : undefined;
    return NextResponse.json({ error: err?.message || String(error) }, { status, headers });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (isCodexSessionId(id)) {
      await (await import("@/lib/execution-engines/codex-bridge-client")).codexBridgeJson(`/api/sessions/${id.slice(6)}/rename`, { title: name });
      return NextResponse.json({ ok: true });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // PATCH writes via appendSessionInfo — open fresh, bypassing the cache.
    const sm = openSessionManager(filePath, { mutable: true });
    sm.appendSessionInfo(name.trim());
    invalidateSessionManagerCache(filePath);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id] uses the same guarded deletion owner as batch requests.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (isCodexSessionId(id)) return NextResponse.json({ error: "请在 Codex 执行端管理会话删除" }, { status: 409 });
  try {
    const { results, auditWarning } = await deleteSessions([id], { origin: "api-single" });
    const result = results[0];
    if (result.missing) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
    return NextResponse.json({ ok: true, ...(auditWarning ? { auditWarning } : {}) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
