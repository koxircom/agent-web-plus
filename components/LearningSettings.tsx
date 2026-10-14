"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { LearningLesson, LearningReview, LearningStatus } from "@/lib/learning-types";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import styles from "./LearningSettings.module.css";

interface Props {
  cwd: string | null;
}

type ReviewState = LearningReview["status"];

const REVIEW_LABELS: Record<ReviewState, string> = {
  queued: "排队",
  running: "复盘中",
  completed: "已完成",
  failed: "失败",
  skipped: "跳过",
};

function lessonStatusLabel(status: LearningLesson["status"]): string {
  switch (status) {
    case "active": return "启用中";
    case "candidate": return "待确认";
    case "dismissed": return "已停用";
    case "published": return "已发布";
  }
}

function isLearningStatus(value: unknown): value is LearningStatus {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<LearningStatus>;
  return typeof data.enabled === "boolean" && Array.isArray(data.lessons);
}

export function LearningSettings({ cwd }: Props) {
  const descriptionId = useId();
  const idPrefix = useId();
  const loadSequenceRef = useRef(0);
  const contextGenerationRef = useRef(0);
  const previousCwdRef = useRef(cwd);
  const writeSequenceRef = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [snapshot, setSnapshot] = useState<{ cwd: string | null; data: LearningStatus } | null>(null);
  const [loadState, setLoadState] = useState<{ cwd: string | null; loading: boolean }>({ cwd, loading: true });
  const [errorState, setErrorState] = useState<{ cwd: string | null; message: string } | null>(null);
  const [pendingWrite, setPendingWrite] = useState<number | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    if (previousCwdRef.current !== cwd) {
      previousCwdRef.current = cwd;
      contextGenerationRef.current += 1;
      setPreviewingId(null);
      setConfirmingId(null);
    }

    const controller = new AbortController();
    const requestId = ++loadSequenceRef.current;
    setLoadState({ cwd, loading: true });
    setErrorState(null);
    setSnapshot((current) => current?.cwd === cwd ? current : null);

    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    void (async () => {
      try {
        const response = await fetch(`/api/learning${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data: unknown = await response.json();
        if (!response.ok || !isLearningStatus(data)) {
          throw new Error("读取自动复盘设置失败，请手动刷新重试。");
        }
        if (controller.signal.aborted || requestId !== loadSequenceRef.current) return;
        setSnapshot({ cwd, data });
      } catch {
        if (controller.signal.aborted || requestId !== loadSequenceRef.current) return;
        setErrorState({ cwd, message: "读取自动复盘设置失败，请手动刷新重试。" });
      } finally {
        if (!controller.signal.aborted && requestId === loadSequenceRef.current) {
          setLoadState({ cwd, loading: false });
        }
      }
    })();

    return () => controller.abort();
  }, [cwd, reloadKey]);

  const status = snapshot?.cwd === cwd ? snapshot.data : null;
  const loading = loadState.cwd !== cwd || loadState.loading;
  const error = errorState?.cwd === cwd ? errorState.message : null;
  const busy = pendingWrite !== null;

  async function toggleEnabled(enabled: boolean) {
    if (busy || loading || !status) return;
    const requestCwd = cwd;
    const contextGeneration = contextGenerationRef.current;
    const writeId = ++writeSequenceRef.current;
    setPendingWrite(writeId);
    setErrorState(null);
    try {
      const response = await fetch("/api/learning", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as { enabled?: unknown };
      if (!response.ok || typeof data.enabled !== "boolean") {
        throw new Error("保存自动复盘设置失败，请重试。");
      }
      if (contextGeneration === contextGenerationRef.current) {
        setSnapshot((current) => current?.cwd === requestCwd
          ? { ...current, data: { ...current.data, enabled: data.enabled as boolean } }
          : current);
      }
    } catch {
      if (contextGeneration === contextGenerationRef.current) {
        setErrorState({ cwd: requestCwd, message: "保存自动复盘设置失败，请重试。" });
      }
    } finally {
      if (writeSequenceRef.current === writeId) setPendingWrite(null);
    }
  }

  async function submitLessonAction(action: "dismiss" | "adoptSkill", lesson: LearningLesson) {
    if (!cwd || busy) return;
    const requestCwd = cwd;
    const contextGeneration = contextGenerationRef.current;
    const writeId = ++writeSequenceRef.current;
    setPendingWrite(writeId);
    setErrorState(null);
    try {
      const response = await fetch("/api/learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: requestCwd, action, lessonId: lesson.id }),
      });
      const data: unknown = await response.json();
      if (!response.ok || !isLearningStatus(data)) {
        throw new Error(action === "dismiss" ? "停用经验失败，请重试。" : "采用技能失败，请重试。");
      }
      if (contextGeneration === contextGenerationRef.current) {
        setSnapshot({ cwd: requestCwd, data });
        setPreviewingId(null);
        setConfirmingId(null);
      }
    } catch {
      if (contextGeneration === contextGenerationRef.current) {
        setErrorState({
          cwd: requestCwd,
          message: action === "dismiss" ? "停用经验失败，请重试。" : "采用技能失败，请重试。",
        });
      }
    } finally {
      if (writeSequenceRef.current === writeId) setPendingWrite(null);
    }
  }

  function refresh() {
    if (loading || busy) return;
    setReloadKey((current) => current + 1);
  }

  return (
    <section className={styles.root} aria-labelledby={`${idPrefix}-title`} aria-busy={loading || busy}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={`${idPrefix}-title`}>自动复盘</h2>
          <p id={descriptionId}>
            启用后，任务结束会使用该会话模型进行一次限量后台复盘，会产生额外模型调用费用；经验按项目保存，后续只作为参考。技能须确认采用，不覆盖已有技能。
          </p>
        </div>
        <ConfigSwitch
          checked={status?.enabled ?? false}
          disabled={!status || loading || busy}
          loading={loading || pendingWrite !== null}
          label="启用自动复盘"
          describedBy={descriptionId}
          onChange={(enabled) => void toggleEnabled(enabled)}
        />
      </header>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <section className={styles.records} aria-labelledby={`${idPrefix}-records-title`}>
        <div className={styles.recordsHeader}>
          <h3 id={`${idPrefix}-records-title`}>项目复盘记录</h3>
          <ConfigButton size="small" variant="secondary" onClick={refresh} disabled={loading || busy}>
            手动刷新
          </ConfigButton>
        </div>

        {!cwd ? (
          <p className={styles.empty} role="status">请先打开项目，再查看该项目的复盘记录。</p>
        ) : loading && !status ? (
          <p className={styles.empty} role="status" aria-live="polite">正在读取复盘记录…</p>
        ) : status ? (
          <>
            <div className={styles.review} aria-live="polite">
              <span className={styles.reviewLabel}>最近一次复盘</span>
              {status.lastReview ? (
                <>
                  <span className={`${styles.badge} ${styles[`review_${status.lastReview.status}`]}`}>
                    {REVIEW_LABELS[status.lastReview.status]}
                  </span>
                  {typeof status.lastReview.lessonCount === "number" && (
                    <span className={styles.muted}>本次记录 {status.lastReview.lessonCount} 条</span>
                  )}
                  {status.lastReview.error && <span className={styles.reviewError}>{status.lastReview.error}</span>}
                  {status.lastReview.status === "failed" && (
                    <span className={styles.reviewError}>最近一次复盘失败，请检查会话模型，并在完成新任务后再次复盘。</span>
                  )}
                </>
              ) : <span className={styles.muted}>暂无复盘任务</span>}
            </div>

            {status.lessons.length === 0 ? (
              <p className={styles.empty}>暂无项目经验或技能候选。</p>
            ) : (
              <ul className={styles.lessonList}>
                {status.lessons.map((lesson, index) => {
                  const previewId = `${idPrefix}-skill-preview-${index}`;
                  const isPreviewing = previewingId === lesson.id;
                  const isConfirming = confirmingId === lesson.id;
                  const isSkillCandidate = lesson.kind === "skill" && lesson.status === "candidate";
                  return (
                    <li key={lesson.id}>
                      <article className={styles.lesson}>
                        <div className={styles.lessonHeader}>
                          <h4>{lesson.title || "未命名经验"}</h4>
                          <div className={styles.badges}>
                            <span className={styles.badge}>{lesson.kind === "skill" ? "技能候选" : "经验"}</span>
                            <span className={`${styles.badge} ${styles[`lesson_${lesson.status}`]}`}>
                              {lessonStatusLabel(lesson.status)}
                            </span>
                          </div>
                        </div>
                        {!(lesson.kind === "skill" && lesson.status === "candidate") && (
                          <p className={styles.lessonContent}>{lesson.content}</p>
                        )}
                        <div className={styles.lessonFooter}>
                          <span className={styles.count}>出现 {lesson.occurrences} 次</span>
                          {((lesson.kind === "experience" && lesson.status === "active") || (lesson.kind === "skill" && lesson.status === "candidate")) && (
                            <ConfigButton
                              size="small"
                              variant="danger"
                              disabled={busy}
                              onClick={() => void submitLessonAction("dismiss", lesson)}
                            >
                              停用
                            </ConfigButton>
                          )}
                          {isSkillCandidate && (
                            <div className={styles.skillActions}>
                              <ConfigButton
                                size="small"
                                variant="secondary"
                                aria-expanded={isPreviewing}
                                aria-controls={previewId}
                                disabled={busy}
                                onClick={() => {
                                  setPreviewingId(isPreviewing ? null : lesson.id);
                                  setConfirmingId(null);
                                }}
                              >
                                {isPreviewing ? "收起正文" : "预览技能正文"}
                              </ConfigButton>
                              {isPreviewing && !isConfirming && (
                                <ConfigButton
                                  size="small"
                                  variant="primary"
                                  disabled={busy}
                                  onClick={() => setConfirmingId(lesson.id)}
                                >
                                  采用为项目技能
                                </ConfigButton>
                              )}
                            </div>
                          )}
                        </div>
                        {isSkillCandidate && isPreviewing && (
                          <div className={styles.preview} id={previewId}>
                            <h5>技能正文预览</h5>
                            <pre>{lesson.content}</pre>
                            {isConfirming && (
                              <div className={styles.confirmation} role="group" aria-label="确认采用技能">
                                <p>请确认将此技能写入当前项目的技能目录；打开新会话或重新加载后生效。</p>
                                <div className={styles.confirmActions}>
                                  <ConfigButton
                                    size="small"
                                    variant="primary"
                                    disabled={busy || !cwd}
                                    onClick={() => void submitLessonAction("adoptSkill", lesson)}
                                  >
                                    确认采用为项目技能
                                  </ConfigButton>
                                  <ConfigButton
                                    size="small"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => setConfirmingId(null)}
                                  >
                                    取消
                                  </ConfigButton>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {lesson.status === "published" && lesson.skillPath && (
                          <p className={styles.skillPath}>
                            项目技能路径：<code>{lesson.skillPath}</code>
                          </p>
                        )}
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : error ? null : (
          <p className={styles.empty} role="status">暂无项目复盘记录。</p>
        )}
      </section>
    </section>
  );
}
