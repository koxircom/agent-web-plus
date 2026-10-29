/** Internal trusted IPC contract. Never return tokens/session IDs through the public collaboration panel. */
export interface OdooLanActor {
  sessionId: string;
  sessionName: string;
  ownerPid: number;
  sourceRoot?: string;
}
export interface OdooLanOwner extends OdooLanActor {
  instanceId: string;
  instanceLabel: string;
  token?: string;
  generation?: number;
  legacy?: boolean;
}
export interface OdooLanQueue extends OdooLanActor {
  instanceId: string;
  instanceLabel: string;
  queueId: string;
  sequence: number;
  resumeTask: string;
  reason?: string;
  enqueuedAt: string;
}
export interface OdooLanHandoff extends OdooLanOwner {
  handoffId: string;
  token: string;
  generation: number;
  resumeTask: string;
  createdAt: string;
}
export interface OdooLanResource {
  resource: string;
  status: "held" | "handoff" | "unknown";
  owner?: OdooLanOwner;
  handoff?: OdooLanHandoff;
  queue: OdooLanQueue[];
  error?: string;
}
export interface OdooLanSnapshot {
  protocol: "odoo-addon-lan-v1";
  version: 1;
  revision: number;
  updatedAt: string;
  resources: OdooLanResource[];
}
export interface OdooLanCommand {
  action: "status" | "acquire" | "release" | "cancel" | "ack";
  actor?: OdooLanActor;
  resource?: string;
  resumeTask?: string;
  reason?: string;
  token?: string;
  generation?: number;
  handoffId?: string;
  queueId?: string;
}
export interface OdooLanResult {
  status: "acquired" | "queued" | "released" | "cancelled" | "acknowledged";
  resource?: string;
  token?: string;
  generation?: number;
  queueId?: string;
  position?: number;
  legacy?: boolean;
  snapshot: OdooLanSnapshot;
}
export interface OdooLanConfig {
  version: 1;
  enabled: boolean;
  instanceId: string;
  instanceLabel: string;
  role: "authority" | "client";
  stateRoot?: string;
  authorityScript: string;
  /** Trusted deployment configuration only: never populated from model tool arguments. */
  ssh?: { host: string; port: number; user: string; identityFile: string; container: string };
}
export interface OdooLanClient {
  isConfigured(): boolean;
  readonly instanceId: string;
  readonly instanceLabel: string;
  status(): Promise<OdooLanSnapshot>;
  request(command: OdooLanCommand): Promise<OdooLanResult | OdooLanSnapshot>;
  /** Undefined while disconnected/unknown: never pretend the authority is empty. */
  getCachedSnapshot(): OdooLanSnapshot | undefined;
  subscribe(callback: () => void): () => void;
  close(): Promise<void>;
}
