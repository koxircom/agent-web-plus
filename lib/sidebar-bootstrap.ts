import type { SessionInfo } from "./types";
import type { EnhancementStateReadResult } from "./enhancement-state-store.cjs";

export interface SidebarBootstrap {
  renderedAt: number;
  sessions: SessionInfo[];
  sessionListVersion: number;
  runningSessionIds: string[];
  completionNotificationSuppressedSessionIds: string[];
  decorations: EnhancementStateReadResult | null;
}
