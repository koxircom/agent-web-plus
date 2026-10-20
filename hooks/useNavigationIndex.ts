"use client";
import { useEffect, useRef, useState } from "react";

export interface NavigationIndex { totalTurns: number; turns: { number: number; preview: string }[] }
export function parseNavigationIndex(value: unknown): NavigationIndex | null {
  const data = value as { available?: boolean; totalTurns?: number; turns?: NavigationIndex["turns"] };
  if (data?.available === false) return null;
  if (!Number.isSafeInteger(data?.totalTurns) || data.totalTurns! < 0 || !Array.isArray(data.turns)
    || data.turns.length > 1000) throw new Error("轮次索引格式无效");
  let previous = 0;
  for (const turn of data.turns) {
    if (!Number.isSafeInteger(turn.number) || turn.number <= previous || turn.number > data.totalTurns!
      || typeof turn.preview !== "string" || Array.from(turn.preview).length > 512) throw new Error("轮次索引格式无效");
    previous = turn.number;
  }
  return { totalTurns: data.totalTurns!, turns: data.turns };
}

/** Titles are a navigation view only. They never become transcript messages. */
export function useNavigationIndex(sessionId: string | null, visible: boolean, totalTurns: number) {
  const [snapshot, setSnapshot] = useState<{ id: string; value: NavigationIndex | null } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const currentId = useRef(sessionId); currentId.current = sessionId;
  const value = snapshot?.id === sessionId ? snapshot.value : undefined;
  useEffect(() => {
    if (!visible || !sessionId || value === null) return;
    const controller = new AbortController();
    setError(false);
    (async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/navigation`, { signal: controller.signal });
        if (!response.ok) throw new Error("轮次索引读取失败");
        const data = response.status === 204 ? null : parseNavigationIndex(await response.json());
        if (!controller.signal.aborted && currentId.current === sessionId) setSnapshot({ id: sessionId, value: data });
      } catch {
        if (!controller.signal.aborted && currentId.current === sessionId) setError(true);
      }
    })();
    return () => controller.abort();
    // A new total refreshes titles; ordinary assistant/tool deltas do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, visible, totalTurns, attempt]);
  return { value, error, retry: () => setAttempt(n => n + 1) };
}
