import { attachSessionProjectInfo, getSessionListVersion, listAllSessions, listSessionSummaries, mergeSessionLists } from "./session-reader";
import { getCompletionNotificationSuppressedRpcSessionIds, getRpcSessionInfos, getRunningRpcSessionIds } from "./rpc-manager";

/** One reader for the initial page and subsequent sidebar refreshes. */
export async function readSessionList(options: { summary?: boolean; force?: boolean } = {}) {
  const persisted = options.summary ? listSessionSummaries() : listAllSessions({ force: options.force });
  const sessionListVersion = getSessionListVersion();
  const [sessions, runtime] = await Promise.all([persisted, attachSessionProjectInfo(getRpcSessionInfos())]);
  return {
    sessions: mergeSessionLists(sessions, runtime), sessionListVersion,
    runningSessionIds: getRunningRpcSessionIds(),
    completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
  };
}
