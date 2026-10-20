interface SessionReadRuntime {
  isAlive(): boolean;
  isRunning(): boolean;
  hasUnpersistedSession?(): boolean;
}
/** Active writers and not-yet-persisted new sessions own their in-memory history. */
export function selectSessionReadRuntime<T extends SessionReadRuntime>(runtime: T | null | undefined): T | undefined {
  return runtime?.isAlive() && (runtime.isRunning() || runtime.hasUnpersistedSession?.()) ? runtime : undefined;
}
/** A new writer/runtime during the disk read invalidates its revision commitment. */
export function isSessionReadStable(initial: SessionReadRuntime | null | undefined, current: SessionReadRuntime | null | undefined): boolean {
  return !selectSessionReadRuntime(current) && (!current?.isAlive() || current === initial);
}
