import { useEffect, useRef } from "react";
import { encodeFilePathForApi } from "./file-paths";

export interface FileWatchFingerprint {
  exists: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  version?: string;
}

export type FileWatchChangeReason = "connected" | "modified" | "deleted" | "recreated";

export interface FileWatchClientOptions {
  filePath: string;
  sourceSessionId?: string | null;
  executionEngine?: "pi" | "codex";
  watchEnabled?: boolean;
  isPageVisible?: boolean;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onChange?: (fingerprint: FileWatchFingerprint, reason: FileWatchChangeReason) => void;
  onError?: (error: Error) => void;
}

export function buildWatchMetaUrl(
  filePath: string,
  sourceSessionId?: string | null,
  executionEngine?: "pi" | "codex",
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type: "watch-meta" });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  if (executionEngine) searchParams.set("engine", executionEngine);
  return `/api/files/${encoded}?${searchParams.toString()}`;
}

export class FileWatchClient {
  private options: FileWatchClientOptions;
  private closed = false;
  private inFlight = false;
  private timer: any = null;
  private abortController: AbortController | null = null;
  private connected = false;
  private hasInitialRead = false;
  private lastFingerprint: FileWatchFingerprint | null = null;
  private activeToken = 0;

  constructor(options: FileWatchClientOptions) {
    this.options = { ...options };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get currentFingerprint(): FileWatchFingerprint | null {
    return this.lastFingerprint ? { ...this.lastFingerprint } : null;
  }

  start(): void {
    if (this.closed) return;
    this.scheduleNext(0);
  }

  updateOptions(options: Partial<FileWatchClientOptions>): void {
    if (this.closed) return;
    const identityChanged =
      (options.filePath !== undefined && options.filePath !== this.options.filePath)
      || (options.sourceSessionId !== undefined && options.sourceSessionId !== this.options.sourceSessionId)
      || (options.executionEngine !== undefined && options.executionEngine !== this.options.executionEngine);

    this.options = { ...this.options, ...options };

    if (identityChanged) {
      this.activeToken++;
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      this.inFlight = false;
      this.connected = false;
      this.hasInitialRead = false;
      this.lastFingerprint = null;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }

    const watchEnabled = this.options.watchEnabled !== false;
    const isPageVisible = this.options.isPageVisible !== false;

    if (!watchEnabled || !isPageVisible) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.connected) {
        this.connected = false;
        this.options.onDisconnected?.();
      }
    } else if (!this.inFlight && !this.timer) {
      this.scheduleNext(0);
    }
  }

  private scheduleNext(delayMs?: number): void {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const watchEnabled = this.options.watchEnabled !== false;
    const isPageVisible = this.options.isPageVisible !== false;
    if (!watchEnabled || !isPageVisible) return;

    const interval = delayMs !== undefined
      ? delayMs
      : Math.max(1000, Math.min(2500, this.options.pollIntervalMs ?? 1500));

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, interval);

    if (typeof this.timer?.unref === "function") {
      this.timer.unref();
    }
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    const watchEnabled = this.options.watchEnabled !== false;
    const isPageVisible = this.options.isPageVisible !== false;
    if (!watchEnabled || !isPageVisible || this.inFlight) return;

    const currentToken = ++this.activeToken;
    this.inFlight = true;

    const controller = new AbortController();
    this.abortController = controller;

    const fetchImpl = this.options.fetchFn ?? globalThis.fetch;
    const url = buildWatchMetaUrl(
      this.options.filePath,
      this.options.sourceSessionId,
      this.options.executionEngine,
    );

    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        cache: "no-store",
      });

      if (this.closed || this.activeToken !== currentToken) return;

      let fingerprint: FileWatchFingerprint | null = null;

      if (response.status === 404) {
        let parsed: any = null;
        try {
          parsed = await response.json();
        } catch { /* ignore */ }
        if (parsed?.exists !== false) {
          this.handleFailure(new Error("File watch failed: HTTP 404"));
          return;
        }
        fingerprint = {
          exists: false,
          size: typeof parsed?.size === "number" ? parsed.size : 0,
          mtimeMs: typeof parsed?.mtimeMs === "number" ? parsed.mtimeMs : 0,
          ctimeMs: typeof parsed?.ctimeMs === "number" ? parsed.ctimeMs : 0,
          ino: typeof parsed?.ino === "number" ? parsed.ino : 0,
            ...(typeof parsed?.version === "string" ? { version: parsed.version } : {}),
        };
      } else if (response.ok) {
        const data = await response.json();
        if (this.closed || this.activeToken !== currentToken) return;

        if (data && typeof data === "object") {
          fingerprint = {
            exists: data.exists !== false,
            size: typeof data.size === "number" ? data.size : 0,
            mtimeMs: typeof data.mtimeMs === "number" ? data.mtimeMs : 0,
            ctimeMs: typeof data.ctimeMs === "number" ? data.ctimeMs : 0,
            ino: typeof data.ino === "number" ? data.ino : 0,
            ...(typeof data.version === "string" ? { version: data.version } : {}),
          };
        }
      } else {
        this.handleFailure(new Error(`File watch failed: HTTP ${response.status}`));
        return;
      }

      if (fingerprint) {
        this.handleSuccess(fingerprint);
      }
    } catch (err: unknown) {
      if (this.closed || this.activeToken !== currentToken) return;
      if ((err as Error)?.name === "AbortError") return;
      this.handleFailure(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (this.activeToken === currentToken) {
        this.inFlight = false;
        this.abortController = null;
        this.scheduleNext();
      }
    }
  }

  private handleSuccess(fingerprint: FileWatchFingerprint): void {
    const isFirst = !this.hasInitialRead;
    const wasConnected = this.connected;

    this.connected = true;
    this.hasInitialRead = true;

    if (!wasConnected) {
      this.options.onConnected?.();
    }

    if (isFirst) {
      this.lastFingerprint = fingerprint;
      this.options.onChange?.(fingerprint, "connected");
      return;
    }

    const prev = this.lastFingerprint;
    if (!prev) {
      this.lastFingerprint = fingerprint;
      this.options.onChange?.(fingerprint, "connected");
      return;
    }

    const isSame =
      prev.exists === fingerprint.exists
      && prev.size === fingerprint.size
      && (prev.version !== undefined && fingerprint.version !== undefined
        ? prev.version === fingerprint.version
        : prev.mtimeMs === fingerprint.mtimeMs
          && prev.ctimeMs === fingerprint.ctimeMs
          && prev.ino === fingerprint.ino);

    if (!isSame) {
      let reason: FileWatchChangeReason = "modified";
      if (!prev.exists && fingerprint.exists) {
        reason = "recreated";
      } else if (prev.exists && !fingerprint.exists) {
        reason = "deleted";
      }
      this.lastFingerprint = fingerprint;
      this.options.onChange?.(fingerprint, reason);
    }
  }

  private handleFailure(err: Error): void {
    if (this.connected) {
      this.connected = false;
      this.options.onDisconnected?.();
    }
    this.options.onError?.(err);
  }

  close(): void {
    this.closed = true;
    this.activeToken++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.inFlight = false;
    this.connected = false;
    this.options.onConnected = undefined;
    this.options.onDisconnected = undefined;
    this.options.onChange = undefined;
    this.options.onError = undefined;
  }
}

export interface UseFileWatchParams {
  filePath: string;
  sourceSessionId?: string | null;
  executionEngine?: "pi" | "codex";
  watchEnabled?: boolean;
  isPageVisible: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onChange?: (fingerprint: FileWatchFingerprint, reason: FileWatchChangeReason) => void;
  onError?: (error: Error) => void;
}

export function useFileWatch({
  filePath,
  sourceSessionId,
  executionEngine,
  watchEnabled = true,
  isPageVisible,
  onConnected,
  onDisconnected,
  onChange,
  onError,
}: UseFileWatchParams): void {
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);

  onConnectedRef.current = onConnected;
  onDisconnectedRef.current = onDisconnected;
  onChangeRef.current = onChange;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!watchEnabled || !isPageVisible) {
      return;
    }

    const client = new FileWatchClient({
      filePath,
      sourceSessionId,
      executionEngine,
      watchEnabled,
      isPageVisible,
      onConnected: () => onConnectedRef.current?.(),
      onDisconnected: () => onDisconnectedRef.current?.(),
      onChange: (fp, reason) => onChangeRef.current?.(fp, reason),
      onError: (err) => onErrorRef.current?.(err),
    });

    client.start();

    return () => {
      client.close();
    };
  }, [executionEngine, filePath, isPageVisible, sourceSessionId, watchEnabled]);
}
