import { codexConnectionIdentity, isCodexSessionId } from "./execution-engine-settings";
import { deleteCodexSession, isCodexUncertainDeleteError, confirmCodexDeleteMissing } from "./execution-engines/codex-engine";
import { deleteSessions } from "./session-delete";
import type { SessionDeletionOrigin } from "./session-deletion-audit";

export type BatchDeleteState = "deleted" | "missing" | "failed" | "unknown" | "not_started";

export type BatchDeleteRowResult = {
  id: string;
  ok: boolean;
  state: BatchDeleteState;
  missing?: boolean;
  error?: string;
};

export type BatchDeleteStartFrame = {
  type: "start";
  total: number;
};

export type BatchDeleteItemStartFrame = {
  type: "item-start";
  id: string;
  index: number;
  total: number;
};

export type BatchDeleteResultFrame = {
  type: "result";
  processed: number;
  total: number;
  result: BatchDeleteRowResult;
  deletedSessionIds: string[];
};

export type BatchDeleteDoneFrame = {
  type: "done";
  processed: number;
  total: number;
  results: BatchDeleteRowResult[];
  deletedSessionIds: string[];
  stopped: boolean;
};

export type BatchDeleteFrame =
  | BatchDeleteStartFrame
  | BatchDeleteItemStartFrame
  | BatchDeleteResultFrame
  | BatchDeleteDoneFrame;

export type BatchDeleteExecutionOptions = {
  signal?: AbortSignal;
  expectedCodexIdentity?: string;
  reconcileUncertainDeletes?: boolean;
  origin?: SessionDeletionOrigin;
  onFrame?: (frame: BatchDeleteFrame) => boolean | void;
};

function safeSendFrame(
  onFrame: ((frame: BatchDeleteFrame) => boolean | void) | undefined,
  frame: BatchDeleteFrame,
): boolean {
  if (!onFrame) return true;
  try {
    const cont = onFrame(frame);
    return cont !== false;
  } catch {
    return false;
  }
}

export async function executeBatchDelete(
  requestedIds: string[],
  options: BatchDeleteExecutionOptions = {},
): Promise<{
  results: BatchDeleteRowResult[];
  deletedSessionIds: string[];
  auditWarning?: string;
  stopped: boolean;
}> {
  const uniqueIds = Array.from(new Set(requestedIds));
  const total = uniqueIds.length;

  let stopped = Boolean(options.signal?.aborted);

  if (!stopped) {
    const startOk = safeSendFrame(options.onFrame, { type: "start", total });
    if (!startOk) {
      stopped = true;
    }
  }

  if (stopped) {
    const results = uniqueIds.map((id) => ({
      id,
      ok: false,
      state: "not_started" as const,
      error: options.signal?.aborted ? "请求已取消" : "客户端连接已关闭",
    }));
    safeSendFrame(options.onFrame, {
      type: "done",
      processed: 0,
      total,
      results,
      deletedSessionIds: [],
      stopped: true,
    });
    return { results, deletedSessionIds: [], stopped: true };
  }

  const expectedCodexIdentity = uniqueIds.some(isCodexSessionId)
    ? options.expectedCodexIdentity ?? await codexConnectionIdentity() : undefined;
  const resultsMap = new Map<string, BatchDeleteRowResult>();
  const confirmedDeletedSet = new Set<string>();
  let processed = 0;
  let auditWarning: string | undefined;

  let i = 0;
  while (i < total) {
    if (options.signal?.aborted) {
      stopped = true;
    }

    const id = uniqueIds[i];

    if (stopped) {
      resultsMap.set(id, {
        id,
        ok: false,
        state: "not_started",
        error: options.signal?.aborted ? "请求已取消" : "前序操作停止后续调度",
      });
      i++;
      continue;
    }

    if (isCodexSessionId(id)) {
      const startOk = safeSendFrame(options.onFrame, {
        type: "item-start",
        id,
        index: i + 1,
        total,
      });
      if (!startOk) {
        stopped = true;
        resultsMap.set(id, {
          id,
          ok: false,
          state: "not_started",
          error: "流式传输中断，未派发此项",
        });
        i++;
        continue;
      }

      if (options.signal?.aborted) {
        stopped = true;
        resultsMap.set(id, {
          id,
          ok: false,
          state: "not_started",
          error: "请求已取消",
        });
        i++;
        continue;
      }

      try {
        await deleteCodexSession(id, expectedCodexIdentity);
        const itemRes: BatchDeleteRowResult = { id, ok: true, state: "deleted" };
        resultsMap.set(id, itemRes);
        confirmedDeletedSet.add(id);
        processed++;
        const frameOk = safeSendFrame(options.onFrame, {
          type: "result",
          processed,
          total,
          result: itemRes,
          deletedSessionIds: [id],
        });
        if (!frameOk) stopped = true;
      } catch (error: unknown) {
        const status =
          error && typeof error === "object" && "status" in error
            ? Number((error as { status?: number }).status)
            : 500;

        if (status === 404) {
          const itemRes: BatchDeleteRowResult = { id, ok: true, state: "missing", missing: true };
          resultsMap.set(id, itemRes);
          confirmedDeletedSet.add(id);
          processed++;
          const frameOk = safeSendFrame(options.onFrame, {
            type: "result",
            processed,
            total,
            result: itemRes,
            deletedSessionIds: [id],
          });
          if (!frameOk) stopped = true;
        } else {
          const uncertain = isCodexUncertainDeleteError(error);
          if (error && typeof error === "object" && "code" in error &&
              (error.code === "codex_session_refresh" || error.code === "codex_connection_required")) {
            stopped = true;
          }
          const errorMsg = error instanceof Error ? error.message : "Codex 删除失败";

          if (uncertain && options.reconcileUncertainDeletes && expectedCodexIdentity &&
              await confirmCodexDeleteMissing(id, expectedCodexIdentity)) {
            const itemRes: BatchDeleteRowResult = { id, ok: true, state: "missing", missing: true };
            resultsMap.set(id, itemRes);
            confirmedDeletedSet.add(id);
            processed++;
            if (!safeSendFrame(options.onFrame, { type: "result", processed, total,
              result: itemRes, deletedSessionIds: [id] })) stopped = true;
          } else if (uncertain) {
            const itemRes: BatchDeleteRowResult = { id, ok: false, state: "unknown", error: errorMsg };
            resultsMap.set(id, itemRes);
            processed++;
            stopped = true;
            const frameOk = safeSendFrame(options.onFrame, {
              type: "result",
              processed,
              total,
              result: itemRes,
              deletedSessionIds: [],
            });
            if (!frameOk) stopped = true;
          } else {
            // Known busy/queue/permission rejection -> 标记 failed，允许继续调度后续 ID
            const itemRes: BatchDeleteRowResult = { id, ok: false, state: "failed", error: errorMsg };
            resultsMap.set(id, itemRes);
            processed++;
            const frameOk = safeSendFrame(options.onFrame, {
              type: "result",
              processed,
              total,
              result: itemRes,
              deletedSessionIds: [],
            });
            if (!frameOk) stopped = true;
          }
        }
      }
      i++;
    } else {
      // 连续 Pi 会话 chunk 批处理
      const chunk: string[] = [];
      let nextIdx = i;
      while (nextIdx < total && !isCodexSessionId(uniqueIds[nextIdx])) {
        chunk.push(uniqueIds[nextIdx]);
        nextIdx++;
      }

      // 阶段 1：先 announce 所有 Pi 项，并检查 stream/signal
      let cancelBeforeSubmit = false;
      for (let cIdx = 0; cIdx < chunk.length; cIdx++) {
        if (options.signal?.aborted) {
          cancelBeforeSubmit = true;
          break;
        }
        const pId = chunk[cIdx];
        const dispatchIndex = i + cIdx + 1;
        const startOk = safeSendFrame(options.onFrame, {
          type: "item-start",
          id: pId,
          index: dispatchIndex,
          total,
        });
        if (!startOk) {
          cancelBeforeSubmit = true;
          break;
        }
      }

      if (!cancelBeforeSubmit && options.signal?.aborted) {
        cancelBeforeSubmit = true;
      }

      if (cancelBeforeSubmit) {
        stopped = true;
        for (let cIdx = 0; cIdx < chunk.length; cIdx++) {
          const pId = chunk[cIdx];
          resultsMap.set(pId, {
            id: pId,
            ok: false,
            state: "not_started",
            error: options.signal?.aborted ? "请求已取消" : "流式传输中断，未派发此项",
          });
        }
        i = nextIdx;
        continue;
      }

      // 阶段 2：调用一次原 Pi 快批
      try {
        const piBatchResult = await deleteSessions(chunk, { origin: options.origin ?? "api-batch" });
        if (piBatchResult.auditWarning) auditWarning = piBatchResult.auditWarning;

        const piResultsMap = new Map(piBatchResult.results.map((r) => [r.id, r]));
        const nonRequestedDeleted = piBatchResult.deletedSessionIds.filter(
          (delId) => !chunk.includes(delId),
        );
        let cascadedReported = false;

        // 已经调用后，无论断流都按实际回执记录所有真实结果，不重标 not_started；禁用新调度但不抹已提交事实
        for (let cIdx = 0; cIdx < chunk.length; cIdx++) {
          const pId = chunk[cIdx];
          const rawRes = piResultsMap.get(pId);
          const isOk = rawRes?.ok === true;
          const isMissing = rawRes?.missing === true;
          const state: BatchDeleteState = isOk ? (isMissing ? "missing" : "deleted") : "failed";

          const itemRes: BatchDeleteRowResult = {
            id: pId,
            ok: isOk,
            state,
            ...(isMissing ? { missing: true } : {}),
            ...(!isOk && rawRes?.error ? { error: rawRes.error } : {}),
          };
          resultsMap.set(pId, itemRes);
          processed++;

          const itemDeletedIds: string[] = [];
          if (isOk) {
            itemDeletedIds.push(pId);
            confirmedDeletedSet.add(pId);
            if (!cascadedReported && nonRequestedDeleted.length > 0) {
              itemDeletedIds.push(...nonRequestedDeleted);
              for (const dId of nonRequestedDeleted) confirmedDeletedSet.add(dId);
              cascadedReported = true;
            }
          }

          const frameOk = safeSendFrame(options.onFrame, {
            type: "result",
            processed,
            total,
            result: itemRes,
            deletedSessionIds: itemDeletedIds,
          });
          if (!frameOk) stopped = true;
        }

        if (options.signal?.aborted) {
          stopped = true;
        }
      } catch (piError: unknown) {
        const errorMsg = piError instanceof Error ? piError.message : "Pi 批量删除失败";
        for (let cIdx = 0; cIdx < chunk.length; cIdx++) {
          const pId = chunk[cIdx];
          const itemRes: BatchDeleteRowResult = {
            id: pId,
            ok: false,
            state: "failed",
            error: errorMsg,
          };
          resultsMap.set(pId, itemRes);
          processed++;

          const frameOk = safeSendFrame(options.onFrame, {
            type: "result",
            processed,
            total,
            result: itemRes,
            deletedSessionIds: [],
          });
          if (!frameOk) stopped = true;
        }
        stopped = true;
      }
      i = nextIdx;
    }
  }

  for (const id of uniqueIds) {
    if (!resultsMap.has(id)) {
      resultsMap.set(id, {
        id,
        ok: false,
        state: "not_started",
        error: options.signal?.aborted ? "请求已取消" : "前序操作停止后续调度",
      });
    }
  }

  const finalResults = uniqueIds.map((id) => resultsMap.get(id)!);
  const allDeletedIds = Array.from(confirmedDeletedSet);

  const isStopped = stopped || Boolean(options.signal?.aborted);

  safeSendFrame(options.onFrame, {
    type: "done",
    processed,
    total,
    results: finalResults,
    deletedSessionIds: allDeletedIds,
    stopped: isStopped,
  });

  return {
    results: finalResults,
    deletedSessionIds: allDeletedIds,
    ...(auditWarning ? { auditWarning } : {}),
    stopped: isStopped,
  };
}

export function createBatchDeleteStream(
  requestedIds: string[],
  options: { signal?: AbortSignal; origin?: SessionDeletionOrigin } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const internalAbortController = new AbortController();

  if (options.signal?.aborted) {
    internalAbortController.abort(options.signal.reason);
  } else if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => internalAbortController.abort(options.signal?.reason),
      { once: true },
    );
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let isClosed = false;

      const sendFrame = (frame: BatchDeleteFrame): boolean => {
        if (isClosed) return false;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
          return true;
        } catch {
          isClosed = true;
          internalAbortController.abort();
          return false;
        }
      };

      try {
        await executeBatchDelete(requestedIds, {
          signal: internalAbortController.signal,
          origin: options.origin,
          onFrame: sendFrame,
        });
      } catch (fatalError: unknown) {
        if (!isClosed) {
          isClosed = true;
          try {
            controller.error(fatalError);
          } catch {}
        }
      } finally {
        if (!isClosed) {
          try {
            controller.close();
          } catch {}
          isClosed = true;
        }
      }
    },
    cancel(reason) {
      internalAbortController.abort(reason);
    },
  });
}
