import { promises as fs } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface OdooAddonUpdateItem {
  name?: string;
  technical: string;
  status?: string;
  updatedAt?: string;
}

export interface OdooAddonLatestEntry {
  sessionId: string;
  updatedAt: string;
}

export interface SessionAddonUpdatesManifest {
  version: number;
  revision: number;
  updatedAt?: string;
  sessions: Record<string, OdooAddonUpdateItem[]>;
  latestByAddon: Record<string, OdooAddonLatestEntry>;
  available: boolean;
}

interface StatusError extends Error {
  status?: number;
}

function createManifestError(message: string): StatusError {
  const error = new Error(message) as StatusError;
  error.status = 500;
  return error;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function getSessionAddonUpdatesManifestPath(agentDir = getAgentDir()): string {
  return path.join(agentDir, "scripts", "pi-odoo-addons-manifest.json");
}

export async function readSessionAddonUpdates(agentDir = getAgentDir()): Promise<SessionAddonUpdatesManifest> {
  const filePath = getSessionAddonUpdatesManifestPath(agentDir);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return {
        version: 1,
        revision: 0,
        sessions: {},
        latestByAddon: {},
        available: false,
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw createManifestError("Invalid JSON in addons manifest");
  }

  if (!isPlainObject(parsed)) {
    throw createManifestError("Malformed manifest: root must be a plain object");
  }

  let version = 1;
  if (parsed.version !== undefined) {
    if (typeof parsed.version !== "number" || !Number.isFinite(parsed.version) || parsed.version < 0) {
      throw createManifestError("Malformed manifest: version must be a finite non-negative number");
    }
    version = parsed.version;
  }

  let revision = 0;
  if (parsed.revision !== undefined) {
    if (typeof parsed.revision !== "number" || !Number.isFinite(parsed.revision) || parsed.revision < 0) {
      throw createManifestError("Malformed manifest: revision must be a finite non-negative number");
    }
    revision = parsed.revision;
  }

  let updatedAt: string | undefined;
  if (parsed.updatedAt !== undefined) {
    if (typeof parsed.updatedAt !== "string") {
      throw createManifestError("Malformed manifest: updatedAt must be a string");
    }
    updatedAt = parsed.updatedAt;
  }

  if (!isPlainObject(parsed.sessions)) {
    throw createManifestError("Malformed manifest: sessions must be a plain object");
  }

  const cleanSessions: Record<string, OdooAddonUpdateItem[]> = {};
  for (const [key, val] of Object.entries(parsed.sessions)) {
    if (!Array.isArray(val)) {
      throw createManifestError(`Malformed manifest: sessions[${key}] must be an array`);
    }

    const items: OdooAddonUpdateItem[] = [];
    for (let i = 0; i < val.length; i++) {
      const item = val[i];
      if (!isPlainObject(item)) {
        throw createManifestError(`Malformed manifest: sessions[${key}][${i}] must be a plain object`);
      }
      if (typeof item.technical !== "string" || item.technical.length === 0) {
        throw createManifestError(`Malformed manifest: sessions[${key}][${i}].technical must be a non-empty string`);
      }
      if (item.name !== undefined && typeof item.name !== "string") {
        throw createManifestError(`Malformed manifest: sessions[${key}][${i}].name must be a string`);
      }
      if (item.status !== undefined && typeof item.status !== "string") {
        throw createManifestError(`Malformed manifest: sessions[${key}][${i}].status must be a string`);
      }
      if (item.updatedAt !== undefined && typeof item.updatedAt !== "string") {
        throw createManifestError(`Malformed manifest: sessions[${key}][${i}].updatedAt must be a string`);
      }

      const cleanItem: OdooAddonUpdateItem = {
        technical: item.technical,
      };
      if (typeof item.name === "string") cleanItem.name = item.name;
      if (typeof item.status === "string") cleanItem.status = item.status;
      if (typeof item.updatedAt === "string") cleanItem.updatedAt = item.updatedAt;

      items.push(cleanItem);
    }
    cleanSessions[key] = items;
  }

  const cleanLatestByAddon: Record<string, OdooAddonLatestEntry> = {};
  if (parsed.latestByAddon !== undefined) {
    if (!isPlainObject(parsed.latestByAddon)) {
      throw createManifestError("Malformed manifest: latestByAddon must be a plain object");
    }
    for (const [addonKey, entry] of Object.entries(parsed.latestByAddon)) {
      if (!isPlainObject(entry)) {
        throw createManifestError(`Malformed manifest: latestByAddon[${addonKey}] must be a plain object`);
      }
      if (typeof entry.sessionId !== "string" || typeof entry.updatedAt !== "string") {
        throw createManifestError(`Malformed manifest: latestByAddon[${addonKey}] entry must contain string sessionId and updatedAt`);
      }
      cleanLatestByAddon[addonKey] = {
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt,
      };
    }
  }

  return {
    version,
    revision,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    sessions: cleanSessions,
    latestByAddon: cleanLatestByAddon,
    available: true,
  };
}
