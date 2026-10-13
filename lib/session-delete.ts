import { randomUUID } from "crypto";
import { createReadStream, type Stats } from "fs";
import { open, lstat, readFile, readdir, rename, unlink } from "fs/promises";
import { createInterface } from "readline";
import { basename, dirname, join, resolve as resolvePath } from "path";
import { listAllSessions, mergeSessionLists, resolveSessionPath,
  invalidateSessionPathCache, invalidateSessionManagerCache, invalidateSessionListCache } from "./session-reader";
import { sessionPathKey } from "./session-path";
import { abortSubagent, getRpcSession, getRpcSessionInfos, forgetRpcProjectStatus } from "./rpc-manager";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents";
import type { SessionEntry, SessionHeader, SessionInfo } from "./types";
import { deletedPaths as tombstones, ensureSessionWriteGuardInstalled, sealAndDeleteSync } from "./usage-delete-guard";

type DeleteContext = { sessions: SessionInfo[]; knownPaths: Set<string>; directoryFiles: (dir: string) => Promise<string[]> };
type ChildReparent = {
  sessionId: string;
  path: string;
  oldParentPath: string;
  parentSessionPath?: string;
  parentSessionId?: string;
};
type PreparedDelete = { paths: Map<string, string>; reparents: ChildReparent[] };
export type SessionDeleteResult = { id: string; ok: boolean; missing?: boolean; error?: string };

const SESSION_HEADER_READ_MAX_BYTES = 64 * 1024;
const MAX_SELECTED_PARENT_HOPS = 128;

async function readSessionHeaderAsync(filePath: string): Promise<SessionHeader | null> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_MAX_BYTES);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (buffer.subarray(0, bytesRead).indexOf(0x0a) >= 0) break;
    }
    if (bytesRead <= 0) return null;
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    // A header that exceeds the bounded prefix is malformed for this operation.
    if (newline < 0 && bytesRead === SESSION_HEADER_READ_MAX_BYTES) return null;
    const firstLine = buffer.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8").replace(/\r$/, "");
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" && typeof header.id === "string" ? header : null;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

async function readSubagentParentId(filePath: string, sessionId: string): Promise<string | null> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    let isHeader = true;
    for await (const line of lines) {
      if (isHeader) { isHeader = false; continue; }
      let entry: SessionEntry;
      try { entry = JSON.parse(line) as SessionEntry; } catch { continue; }
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_META_TYPE) continue;
      return readSubagentRun([entry], sessionId, filePath)?.parentSessionId ?? null;
    }
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sameFileVersion(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function rewriteSessionFileAtomically(filePath: string, contents: string, sourceStats: Stats): Promise<void> {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let ownsTemp = false;
  let operationError: unknown;
  try {
    handle = await open(tempPath, "wx", sourceStats.mode & 0o777);
    ownsTemp = true;
    await handle.writeFile(contents, "utf8");
    await handle.chmod(sourceStats.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const currentStats = await lstat(filePath);
    if (!sameFileVersion(sourceStats, currentStats)) {
      throw new Error(`Session changed while preparing its parent link: ${filePath}`);
    }
    await rename(tempPath, filePath);
    ownsTemp = false;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (handle) {
      try { await handle.close(); } catch (error) { cleanupError = error; }
    }
    if (ownsTemp) {
      try { await unlink(tempPath); } catch (error) {
        if (!isMissingPath(error)) cleanupError ??= error;
      }
    }
    if (cleanupError) {
      if (operationError) throw new AggregateError([operationError, cleanupError], `Session rewrite failed and its temporary file could not be cleaned: ${filePath}`);
      throw cleanupError;
    }
  }
}

async function reparentChildSession(plan: ChildReparent): Promise<void> {
  const runtime = getRpcSession(plan.sessionId);
  if (runtime) {
    if (runtime.isRunning()) throw new Error(`Cannot reparent active child session ${plan.sessionId}; stop it and retry.`);
    // An idle wrapper can still rewrite its cached header later. Dispose it before
    // replacing the file so the next request reloads the new parent link. Calling
    // shutdown on an already-closing wrapper waits for its existing shutdown promise.
    await runtime.shutdown();
    if (getRpcSession(plan.sessionId)) throw new Error(`Child session ${plan.sessionId} is still closing or reopened; retry the delete.`);
  }

  let sourceStats: Stats;
  let source: Buffer;
  try {
    sourceStats = await lstat(plan.path);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) throw new Error(`Refusing to rewrite a non-regular child session: ${plan.path}`);
    source = await readFile(plan.path);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  const afterReadStats = await lstat(plan.path);
  if (!sameFileVersion(sourceStats, afterReadStats)) {
    throw new Error(`Child session changed while being read for parent update: ${plan.path}`);
  }

  const content = source.toString("utf8");
  const lines = content.split("\n");
  const headerLine = lines[0]?.replace(/\r$/, "");
  let header: SessionHeader;
  try {
    header = JSON.parse(headerLine ?? "") as SessionHeader;
  } catch {
    throw new Error(`Child session has a malformed header: ${plan.path}`);
  }
  if (header.type !== "session" || sessionPathKey(header.parentSession ?? "") !== sessionPathKey(plan.oldParentPath)) {
    // A concurrent rename/reparent wins; never overwrite its newer relationship.
    return;
  }

  if (plan.parentSessionPath) header.parentSession = plan.parentSessionPath;
  else delete header.parentSession;
  lines[0] = JSON.stringify(header);
  if (plan.parentSessionPath && plan.parentSessionId) {
    for (let index = 1; index < lines.length; index += 1) {
      let entry: { type?: string; customType?: string; data?: unknown };
      try { entry = JSON.parse(lines[index]); } catch { continue; }
      if (
        entry.type !== "custom"
        || entry.customType !== SUBAGENT_META_TYPE
        || typeof entry.data !== "object"
        || entry.data === null
        || Array.isArray(entry.data)
      ) continue;
      entry.data = { ...entry.data, parentSessionId: plan.parentSessionId, parentSessionPath: plan.parentSessionPath };
      lines[index] = JSON.stringify(entry);
      break;
    }
  }

  if (getRpcSession(plan.sessionId)) {
    throw new Error(`Child session ${plan.sessionId} reopened while its parent link was being prepared; retry the delete.`);
  }
  await rewriteSessionFileAtomically(plan.path, lines.join("\n"), sourceStats);
  invalidateSessionManagerCache(plan.path);
  if (getRpcSession(plan.sessionId)) {
    throw new Error(`Child session ${plan.sessionId} reopened while its parent link was being updated; retry the delete.`);
  }
}

async function resolveSurvivingParent(
  parentSessionPath: string | undefined,
  deletingPathKeys: Set<string>,
  childSessionId: string,
): Promise<Pick<ChildReparent, "parentSessionPath" | "parentSessionId">> {
  if (!parentSessionPath) return {};
  const visited = new Set<string>();
  let candidatePath = parentSessionPath;
  for (let hop = 0; hop < MAX_SELECTED_PARENT_HOPS; hop += 1) {
    const key = sessionPathKey(candidatePath);
    if (visited.has(key)) throw new Error(`Cycle in selected parent chain while reparenting ${childSessionId}: ${candidatePath}`);
    visited.add(key);

    let header: SessionHeader | null;
    try { header = await readSessionHeaderAsync(candidatePath); }
    catch (error) {
      if (isMissingPath(error)) return {};
      throw error;
    }
    if (!header) throw new Error(`Cannot resolve selected parent header while reparenting ${childSessionId}: ${candidatePath}`);
    if (!deletingPathKeys.has(key)) {
      return { parentSessionPath: candidatePath, parentSessionId: header.id };
    }
    if (typeof header.parentSession !== "string" || !header.parentSession) return {};
    candidatePath = header.parentSession;
  }
  throw new Error(`Selected parent chain exceeded ${MAX_SELECTED_PARENT_HOPS} hops while reparenting ${childSessionId}`);
}

async function prepareSessionDelete(id: string, context: DeleteContext): Promise<PreparedDelete | null> {
  const filePath = await resolveSessionPath(id);
  if (!filePath) {
    return null;
  }

  // Read only the bounded header before deleting.
  let parentSessionPath: string | undefined;
  try {
    parentSessionPath = (await readSessionHeaderAsync(filePath))?.parentSession;
  } catch (error) {
    // Empty runtime sessions have a cached path before their first disk write.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let parentSessionId: string | undefined;
  if (parentSessionPath) {
    try {
      // The parent may have been deleted or moved already; treat it as absent.
      const parentHeader = await readSessionHeaderAsync(parentSessionPath);
      if (!parentHeader) throw new Error(`Cannot resolve the surviving parent session header: ${parentSessionPath}`);
      parentSessionId = parentHeader.id;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      parentSessionPath = undefined;
      parentSessionId = undefined;
    }
  }

  const targetPathKey = sessionPathKey(filePath);
  const dir = dirname(filePath);
  // Deleting a session also deletes every persisted or live subagent below it.
  const { sessions, knownPaths, directoryFiles } = context;
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const children = childrenByParent.get(session.relation.parentSessionId) ?? [];
    children.push(session.id);
    childrenByParent.set(session.relation.parentSessionId, children);
  }
  const sessionPaths = new Map(sessions.map((session) => [session.id, session.path]));
  // Include local files even when the global catalogue is stale or incomplete.
  for (const file of await directoryFiles(dir)) {
    const childPath = join(dir, file);
    if (sessionPathKey(childPath) === targetPathKey) continue;
    if (knownPaths.has(sessionPathKey(childPath))) continue; // Fresh catalogue already contains its relation metadata.
    let header: SessionHeader | null;
    try { header = await readSessionHeaderAsync(childPath); }
    catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    if (!header || typeof header.id !== "string") continue;
    let parentId: string | null;
    try { parentId = await readSubagentParentId(childPath, header.id); }
    catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(header.id);
    childrenByParent.set(parentId, children);
    sessionPaths.set(header.id, childPath);
  }
  const deletedSessionIds = new Set<string>([id]);
  const pending = [id];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (deletedSessionIds.has(childId)) continue;
      deletedSessionIds.add(childId);
      pending.push(childId);
    }
  }
  const deletedPaths = new Map<string, string>([[id, filePath]]);
  for (const deletedId of deletedSessionIds) {
    const sessionPath = sessionPaths.get(deletedId);
    if (sessionPath) deletedPaths.set(deletedId, sessionPath);
  }
  for (const deletedId of deletedSessionIds) {
    if (deletedPaths.has(deletedId)) continue;
    const runtimePath = getRpcSession(deletedId)?.sessionFile;
    if (runtimePath) deletedPaths.set(deletedId, runtimePath);
    else {
      const resolvedPath = await resolveSessionPath(deletedId);
      if (resolvedPath) deletedPaths.set(deletedId, resolvedPath);
    }
  }
  const deletedPathKeys = new Set([...deletedPaths.values()].map((path) => sessionPathKey(path)));

  const reparents: ChildReparent[] = [];
  // Re-attach surviving direct children to this session's parent. Only collect
  // plans here; all required rewrites must succeed before any target is deleted.
  for (const file of await directoryFiles(dir)) {
    const childPath = join(dir, file);
    if (deletedPathKeys.has(sessionPathKey(childPath))) continue;
    let header: SessionHeader | null;
    try { header = await readSessionHeaderAsync(childPath); }
    catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    if (
      typeof header?.parentSession === "string" && header.parentSession &&
      sessionPathKey(header.parentSession) === targetPathKey
    ) {
      reparents.push({
        sessionId: header.id,
        path: childPath,
        oldParentPath: filePath,
        ...(parentSessionPath ? { parentSessionPath } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      });
    }
  }

  return { paths: deletedPaths, reparents };
}

// Serialize destructive requests so overlapping batches cannot race reparenting or sealing.
declare global { var __piSessionDeleteQueue: Promise<unknown> | undefined; }
export function deleteSessions(ids: string[]) {
  const pending = (globalThis.__piSessionDeleteQueue ?? Promise.resolve())
    .catch(() => undefined).then(() => executeDeleteSessions([...new Set(ids)]));
  globalThis.__piSessionDeleteQueue = pending;
  void pending.finally(() => {
    if (globalThis.__piSessionDeleteQueue === pending) globalThis.__piSessionDeleteQueue = undefined;
  }).catch(() => undefined);
  return pending;
}

async function executeDeleteSessions(ids: string[]) {
  ensureSessionWriteGuardInstalled();
  const files = new Map<string, Promise<string[]>>();
  const sessions = mergeSessionLists(await listAllSessions({ force: true }), getRpcSessionInfos({ includeTransient: true }));
  const context: DeleteContext = {
    sessions, knownPaths: new Set(sessions.map((session) => sessionPathKey(session.path))),
    directoryFiles(dir) {
      if (!files.has(dir)) {
        files.set(dir, readdir(dir, { withFileTypes: true }).then((entries) => entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name)).catch((error) => {
          if (isMissingPath(error)) return [];
          throw error;
        }));
      }
      return files.get(dir)!;
    },
  };
  const planned = new Map<string, PreparedDelete>();
  const targets = new Map<string, string>();
  const results = new Map<string, SessionDeleteResult>();
  for (const id of ids) {
    if (targets.has(id)) {
      planned.set(id, { paths: new Map([[id, targets.get(id)!]]), reparents: [] });
      continue;
    }
    try {
      const prepared = await prepareSessionDelete(id, context);
      if (!prepared) { results.set(id, { id, ok: true, missing: true }); continue; }
      planned.set(id, prepared);
      for (const entry of prepared.paths) targets.set(...entry);
    } catch (error) { results.set(id, { id, ok: false, error: String(error) }); }
  }
  const persisted = new Map<string, string>();
  const unpersisted = new Map<string, string>();
  const deleted = new Set<string>();
  let deleteError: string | undefined;
  const confirm = (id: string, path: string) => {
    deleted.add(id);
    forgetRpcProjectStatus(id);
    invalidateSessionPathCache(id);
    invalidateSessionManagerCache(path);
  };
  try {
    const targetPathKeys = new Set([...targets.values()].map((path) => sessionPathKey(path)));
    const reparents = new Map<string, ChildReparent>();
    for (const prepared of planned.values()) {
      for (const reparent of prepared.reparents) {
        const key = sessionPathKey(reparent.path);
        if (!targetPathKeys.has(key)) reparents.set(key, reparent);
      }
    }
    // Resolve every planned target parent through this batch's full delete set.
    // Doing this before writes preserves the old serial cascade behavior without
    // exposing a surviving child to a parent that this same batch will remove.
    for (const [key, reparent] of reparents) {
      const parent = await resolveSurvivingParent(reparent.parentSessionPath, targetPathKeys, reparent.sessionId);
      reparents.set(key, { ...reparent, ...parent });
    }
    // Refuse the whole delete before touching any file if a surviving direct
    // child is actively running; its wrapper could otherwise append during rename.
    for (const reparent of reparents.values()) {
      const runtime = getRpcSession(reparent.sessionId);
      if (runtime?.isAlive() && runtime.isRunning()) {
        throw new Error(`Cannot reparent active child session ${reparent.sessionId}; stop it and retry.`);
      }
    }
    for (const reparent of reparents.values()) await reparentChildSession(reparent);

    // Close selected wrappers only after every required reparent write succeeds.
    for (const id of [...targets.keys()].reverse()) {
      try { await abortSubagent(id); } catch { /* ordinary, idle, or completed session */ }
      await getRpcSession(id)?.shutdown();
    }

    for (const [id, path] of targets) {
      try { await lstat(path); persisted.set(id, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        unpersisted.set(id, path);
      }
    }
    // One ledger lock/worker for the entire batch; retain fingerprint verification and tombstones.
    sealAndDeleteSync(persisted, confirm);
    for (const [id, path] of unpersisted) { tombstones.add(resolvePath(path)); confirm(id, path); }
  } catch (error) { deleteError = String(error); }
  if (targets.size > 0) invalidateSessionListCache();
  for (const [id, paths] of planned) {
    const ok = [...paths.paths.keys()].every((deletedId) => deleted.has(deletedId));
    results.set(id, { id, ok, ...(ok ? {} : { error: deleteError ?? "会话未能完全删除" }) });
  }
  return { results: ids.map((id) => results.get(id)!), deletedSessionIds: [...deleted] };
}
