export interface TaskTiming {
  taskId: string;
  requestId?: string;
  startedAt: number;
}

export function createTaskTiming(
  startedAt: number = Date.now(),
  options: { taskId?: string; requestId?: string },
): TaskTiming {
  const reqId = options?.requestId?.trim() || undefined;
  const taskId = options?.taskId?.trim() || reqId;
  if (!taskId) {
    throw new Error("TaskTiming requires a valid string taskId or requestId");
  }
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    throw new Error("TaskTiming requires a positive finite startedAt timestamp");
  }
  return {
    taskId,
    ...(reqId ? { requestId: reqId } : {}),
    startedAt: Math.min(startedAt, Date.now()),
  };
}
