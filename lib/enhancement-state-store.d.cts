export interface EnhancementTagDefinition {
  id: string;
  name: string;
  color?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
}

export interface EnhancementDurableState {
  sessionTagsDefinitions: EnhancementTagDefinition[];
  sessionTagMappings: Record<string, unknown>;
  sessionColors: Record<string, string>;
  enhancementSettingsByClient: Record<string, Record<string, string>>;
}

export interface EnhancementStateReadResult {
  ok: true;
  revision: number;
  state: EnhancementDurableState;
  storageVersion: 1;
  alreadyInitialized?: boolean;
}

export interface EnhancementStateCommitResult extends EnhancementStateReadResult {
  acknowledgedOpIds: string[];
  tagIdRemap: Record<string, string>;
}

export interface StateLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
}

export interface RecoverStaleLockOptions {
  offlineMaintenance?: boolean;
  expectedToken?: string;
}

export interface RecoverStaleLockResult {
  ok: boolean;
  recovered: boolean;
  reason?: string;
  owner?: unknown;
  warning?: string;
  error?: string;
  previousOwner?: unknown;
}

export interface EnhancementStateStoreInstance {
  initializeFromLegacy(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  initializeFromLegacyLocked(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  ensureInitializedFromLegacy(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  ensureInitializedFromLegacyLocked(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  read(): EnhancementStateReadResult;
  commit(operations: unknown[]): Promise<EnhancementStateCommitResult>;
  commitSync(operations: unknown[]): EnhancementStateCommitResult;
  commitLocked(operations: unknown[]): EnhancementStateCommitResult;
  recoverStaleLock(options?: RecoverStaleLockOptions): RecoverStaleLockResult;
  withLock<T>(fn: () => Promise<T> | T, options?: StateLockOptions): Promise<T>;
  withLockSync<T>(fn: () => T, options?: StateLockOptions): T;
  withReadLockSync?<T>(fn: () => T, options?: StateLockOptions): T;
}

export declare class EnhancementStateStore {
  constructor(options: { agentDir: string });
  initializeFromLegacy(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  initializeFromLegacyLocked(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  ensureInitializedFromLegacy(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  ensureInitializedFromLegacyLocked(options?: { modelsConfigPath?: string }): EnhancementStateReadResult;
  read(): EnhancementStateReadResult;
  commit(operations: unknown[]): Promise<EnhancementStateCommitResult>;
  commitSync(operations: unknown[]): EnhancementStateCommitResult;
  commitLocked(operations: unknown[]): EnhancementStateCommitResult;
}

export function createStateStore(options: { agentDir: string }): EnhancementStateStoreInstance;

export function withAgentStateLock<T>(
  agentDir: string,
  fn: () => Promise<T> | T,
  options?: StateLockOptions,
): Promise<T>;

export function withAgentStateLockSync<T>(
  agentDir: string,
  fn: () => T,
  options?: StateLockOptions,
): T;

export function withAgentStateReadLockSync<T>(
  agentDir: string,
  fn: () => T,
  options?: StateLockOptions,
): T;

export function recoverStaleLock(
  agentDirOrLockDir: string,
  options?: RecoverStaleLockOptions,
): RecoverStaleLockResult;
