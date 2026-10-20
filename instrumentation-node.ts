import { startCodexAttentionMonitor, stopCodexAttentionMonitor } from "@/lib/codex-attention-monitor";
import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startLockHandoffDispatcher, stopLockHandoffDispatcher } from "@/lib/lock-handoff-dispatcher";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();
  startLockHandoffDispatcher();
  startCodexAttentionMonitor();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => {
    closeAllAgentEventStreams();
    void stopLockHandoffDispatcher();
    void stopCodexAttentionMonitor();
  };
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
