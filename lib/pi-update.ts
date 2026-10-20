export interface PiAgentReleaseStatus {
  latestVersion: string | null;
  releaseUrl: string | null;
}

interface PiAgentReleaseCache {
  value?: PiAgentReleaseStatus;
  expiresAt: number;
  retryAfter: number;
  inFlight?: Promise<PiAgentReleaseStatus>;
}

interface PiAgentReleaseCheckerOptions {
  repository?: string;
  tagPrefix?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  successTtlMs?: number;
  failureBackoffMs?: number;
}

const FETCH_TIMEOUT_MS = 8_000;
const SUCCESS_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const PI_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNAVAILABLE: PiAgentReleaseStatus = Object.freeze({ latestVersion: null, releaseUrl: null });

declare global {
  // Keep one checker across Next.js development hot reloads and route-module instances.
  var __piAgentReleaseChecker: (() => Promise<PiAgentReleaseStatus>) | undefined;
}

function statusFromTag(tagName: unknown, repository: string, tagPrefix: string): PiAgentReleaseStatus | null {
  if (typeof tagName !== "string") return null;
  const version = tagName.startsWith(tagPrefix) ? tagName.slice(tagPrefix.length) : tagName;
  if (!PI_VERSION_PATTERN.test(version)) return null;

  return {
    latestVersion: version,
    releaseUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tagName)}`,
  };
}

async function fetchLatestRelease(fetchImpl: typeof fetch, repository: string, tagPrefix: string): Promise<PiAgentReleaseStatus> {
  // One deadline also bounds the official-page fallback on shared API quotas.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "pi-web-standalone-pi-update-check",
    },
    signal,
  });
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel();
    const page = await fetchImpl(`https://github.com/${repository}/releases/latest`, {
      cache: "no-store",
      redirect: "follow",
      signal,
    });
    try {
      if (!page.ok) throw new Error(`GitHub release page returned HTTP ${page.status}`);
      const url = new URL(page.url);
      const pathPrefix = `/${repository}/releases/tag/`;
      if (url.origin !== "https://github.com" || !url.pathname.startsWith(pathPrefix)) {
        throw new Error("GitHub release page returned an unexpected URL");
      }
      const tag = decodeURIComponent(url.pathname.slice(pathPrefix.length));
      const status = statusFromTag(tag, repository, tagPrefix);
      if (!status) throw new Error("GitHub release page returned an invalid release tag");
      return status;
    } finally {
      // Only the final redirect URL is needed; never download or parse the HTML.
      await page.body?.cancel();
    }
  }
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);

  const body = await response.json() as { tag_name?: unknown };
  const status = statusFromTag(body.tag_name, repository, tagPrefix);
  if (!status) throw new Error("GitHub Releases returned an invalid release tag");
  return status;
}

export function createGithubReleaseChecker({
  repository = "earendil-works/pi",
  tagPrefix = "v",
  fetchImpl = fetch,
  now = Date.now,
  successTtlMs = SUCCESS_TTL_MS,
  failureBackoffMs = FAILURE_BACKOFF_MS,
}: PiAgentReleaseCheckerOptions = {}): () => Promise<PiAgentReleaseStatus> {
  const cache: PiAgentReleaseCache = { expiresAt: 0, retryAfter: 0 };

  return async function getLatestPiAgentRelease(): Promise<PiAgentReleaseStatus> {
    const currentTime = now();
    if (cache.value && cache.expiresAt > currentTime) return cache.value;
    if (cache.inFlight) return cache.inFlight;
    if (cache.retryAfter > currentTime) return UNAVAILABLE;

    cache.inFlight = fetchLatestRelease(fetchImpl, repository, tagPrefix).then((status) => {
      cache.value = status;
      cache.expiresAt = now() + successTtlMs;
      cache.retryAfter = 0;
      return status;
    }).catch(() => {
      cache.retryAfter = now() + failureBackoffMs;
      return UNAVAILABLE;
    }).finally(() => {
      cache.inFlight = undefined;
    });

    return cache.inFlight;
  };
}

export const createPiAgentReleaseChecker = createGithubReleaseChecker;

export function getLatestPiAgentRelease(): Promise<PiAgentReleaseStatus> {
  globalThis.__piAgentReleaseChecker ??= createPiAgentReleaseChecker();
  return globalThis.__piAgentReleaseChecker();
}
