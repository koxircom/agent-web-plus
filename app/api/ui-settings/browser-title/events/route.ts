import { resolveAgentDir } from "@/lib/browser-tab-title";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  subscribeBrowserTitle,
  type SubscriptionHandle,
} from "@/lib/browser-title-subscription";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (req && !isApiRequestAllowed(req)) {
    return new Response(JSON.stringify({ error: "Untrusted API request" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.signal.aborted) {
    return new Response(null, { status: 204 });
  }

  const agentDir = resolveAgentDir();
  const encoder = new TextEncoder();

  let subscription: SubscriptionHandle | null = null;
  let abortListener: (() => void) | null = null;
  let isClosed = false;
  let streamController: ReadableStreamDefaultController | null = null;
  let initialSent = false;
  let pendingFallbackComment: string | null = null;
  let lastSentRevision = -1;
  const sendSnapshot = (snapshot: { revision: number }) => {
    if (isClosed || !streamController || snapshot.revision <= lastSentRevision) return;
    lastSentRevision = snapshot.revision;
    streamController.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
    initialSent = true;
    if (pendingFallbackComment) {
      streamController.enqueue(encoder.encode(pendingFallbackComment));
      pendingFallbackComment = null;
    }
  };

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    if (subscription) {
      try {
        subscription.unsubscribe();
      } catch {}
      subscription = null;
    }
    if (abortListener) {
      req.signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      streamController = controller;

      if (req.signal.aborted || isClosed) {
        cleanup();
        try {
          controller.close();
        } catch {}
        return;
      }

      abortListener = () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", abortListener, { once: true });

      // 1. 注册 watch 先于 initial snapshot 避免 lost update
      // SSE GET readonly 不得 mkdir
      try {
        subscription = subscribeBrowserTitle(agentDir, {
          onSnapshot(snapshot) {
            if (isClosed || !streamController) return;
            try {
              sendSnapshot(snapshot);
            } catch {
              cleanup();
            }
          },
          onError(err) {
            if (isClosed || !streamController) return;
            const errPayload = JSON.stringify({ error: err.error });
            try {
              streamController.enqueue(encoder.encode(`event: error\ndata: ${errPayload}\n\n`));
            } catch {}
            cleanup();
            try {
              streamController.close();
            } catch {}
          },
          onFallback(info) {
            if (isClosed || !streamController) return;
            const comment = `: transport fallback: polling (${info.code})\n\n`;
            if (!initialSent) {
              pendingFallbackComment = comment;
            } else {
              try {
                streamController.enqueue(encoder.encode(comment));
              } catch {}
            }
          },
        });
      } catch {
        if (!isClosed) {
          const errPayload = JSON.stringify({ error: "Watcher unavailable" });
          try {
            controller.enqueue(encoder.encode(`event: error\ndata: ${errPayload}\n\n`));
          } catch {}
          cleanup();
          try {
            controller.close();
          } catch {}
          return;
        }
      }

      if (req.signal.aborted || isClosed || !subscription) {
        cleanup();
        try {
          controller.close();
        } catch {}
        return;
      }

      // 2. 发送 initial snapshot
      try {
        const initial = await subscription.getInitialSnapshot();
        if (!isClosed && streamController) {
          sendSnapshot(initial);
        }
      } catch {
        if (!isClosed && streamController) {
          const errPayload = JSON.stringify({ error: "Failed to read fresh settings" });
          try {
            streamController.enqueue(encoder.encode(`event: error\ndata: ${errPayload}\n\n`));
          } catch {}
          cleanup();
          try {
            streamController.close();
          } catch {}
          return;
        }
      }

      if (req.signal.aborted || isClosed) {
        cleanup();
        try {
          controller.close();
        } catch {}
        return;
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
