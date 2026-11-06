import { NextResponse } from "next/server";
import type { AppUpdateResponse } from "@/lib/api-types";
import { getPiWebReleaseUrl, getPiWebVersionFromReleaseRedirect, isNewerStableVersion, PI_WEB_LATEST_RELEASE_URL } from "@/lib/app-update";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1";

interface AppUpdateCache {
  value?: AppUpdateResponse;
  expiresAt: number;
  inFlight?: Promise<AppUpdateResponse>;
}

declare global {
  var __piWebAppUpdateCache: AppUpdateCache | undefined;
}

function getCache(): AppUpdateCache {
  return globalThis.__piWebAppUpdateCache ??= { expiresAt: 0 };
}

async function fetchLatestVersion(): Promise<AppUpdateResponse> {
  // GitHub's public latest-release redirect carries the stable tag without the
  // REST API quota shared by every installation behind the same proxy exit.
  const response = await fetch(PI_WEB_LATEST_RELEASE_URL, {
    method: "HEAD",
    redirect: "manual",
    cache: "no-store",
    headers: {
      "User-Agent": "pi-web-standalone-update-check",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  }
  const latestVersion = getPiWebVersionFromReleaseRedirect(response.headers.get("location"));
  const releaseUrl = latestVersion ? getPiWebReleaseUrl(latestVersion) : null;
  if (!latestVersion || !releaseUrl) throw new Error("GitHub Releases returned an invalid tag");

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerStableVersion(latestVersion, CURRENT_VERSION),
    releaseUrl,
  };
}

async function loadUpdateStatus(): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchLatestVersion().then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.value) return cache.value;
    throw error;
  }
}

export async function GET() {
  if (SKIP_VERSION_CHECK) {
    return NextResponse.json({
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      updateAvailable: false,
      releaseUrl: "",
    } satisfies AppUpdateResponse);
  }
  try {
    return NextResponse.json(await loadUpdateStatus());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
