import assert from "node:assert/strict";
import test from "node:test";
import { createGithubReleaseChecker, createPiAgentReleaseChecker } from "./pi-update.ts";

test("coalesces concurrent release checks and caches a valid official release", async () => {
  let fetchCount = 0;
  let resolveFetch;
  const checker = createPiAgentReleaseChecker({
    fetchImpl: (url) => {
      assert.equal(url, "https://api.github.com/repos/earendil-works/pi/releases/latest");
      fetchCount += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
    now: () => 100,
  });

  const first = checker();
  const second = checker();
  assert.equal(fetchCount, 1);
  resolveFetch({ ok: true, json: async () => ({ tag_name: "v1.0.0" }) });

  const expected = {
    latestVersion: "1.0.0",
    releaseUrl: "https://github.com/earendil-works/pi/releases/tag/v1.0.0",
  };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.deepEqual(await checker(), expected);
  assert.equal(fetchCount, 1);
});

test("returns unavailable after a failure and backs off without inventing a version", async () => {
  let fetchCount = 0;
  let currentTime = 100;
  const checker = createPiAgentReleaseChecker({
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("offline");
    },
    now: () => currentTime,
    failureBackoffMs: 500,
  });

  assert.deepEqual(await checker(), { latestVersion: null, releaseUrl: null });
  currentTime += 499;
  assert.deepEqual(await checker(), { latestVersion: null, releaseUrl: null });
  assert.equal(fetchCount, 1);

  currentTime += 1;
  assert.deepEqual(await checker(), { latestVersion: null, releaseUrl: null });
  assert.equal(fetchCount, 2);
});

test("rejects malformed upstream tags instead of fabricating a release link", async () => {
  const checker = createPiAgentReleaseChecker({
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v1.0.0/other" }) }),
  });

  assert.deepEqual(await checker(), { latestVersion: null, releaseUrl: null });
});

test('the shared release checker validates Codex official tags and builds only official links',async()=>{
 const {createGithubReleaseChecker}=await import('./pi-update.ts');let calls=0;
 const checker=createGithubReleaseChecker({repository:'openai/codex',tagPrefix:'rust-v',fetchImpl:async url=>{calls++;assert.equal(url,'https://api.github.com/repos/openai/codex/releases/latest');return{ok:true,json:async()=>({tag_name:'rust-v0.163.0'})}}});
 const expected={latestVersion:'0.163.0',releaseUrl:'https://github.com/openai/codex/releases/tag/rust-v0.163.0'};
 assert.deepEqual(await checker(),expected);assert.deepEqual(await checker(),expected);assert.equal(calls,1);
});

test("API quota fallback uses the official release redirect, cancels bodies and caches the result", async () => {
  for (const quotaStatus of [403, 429]) {
    const calls = [];
    let canceled = 0;
    const checker = createGithubReleaseChecker({
      repository: "openai/codex", tagPrefix: "rust-v",
      fetchImpl: async (url, options) => {
        calls.push({ url, signal: options.signal });
        if (calls.length === 1) return { ok: false, status: quotaStatus, body: { cancel: async () => canceled++ } };
        return { ok: true, url: "https://github.com/openai/codex/releases/tag/rust-v0.163.0", body: { cancel: async () => canceled++ } };
      },
    });
    const expected = { latestVersion: "0.163.0", releaseUrl: "https://github.com/openai/codex/releases/tag/rust-v0.163.0" };
    assert.deepEqual(await checker(), expected);
    assert.deepEqual(await checker(), expected);
    assert.deepEqual(calls.map((call) => call.url), ["https://api.github.com/repos/openai/codex/releases/latest", "https://github.com/openai/codex/releases/latest"]);
    assert.equal(calls[0].signal, calls[1].signal);
    assert.equal(canceled, 2);
  }
});

test("invalid or failed fallback redirects remain unavailable and keep failure backoff", async () => {
  for (const url of [
    "https://example.com/openai/codex/releases/tag/rust-v0.163.0",
    "https://github.com/another/repo/releases/tag/rust-v0.163.0",
    "https://github.com/openai/codex/releases/tag/rust-v0.163.0/other",
    "https://github.com/openai/codex/releases/tag/rust-v0.163.0%2Fother",
    "https://github.com/openai/codex/releases/tag/rust-v0.163.0-alpha.1",
    "https://github.com/openai/codex/releases/tag/%ZZ",
  ]) {
    let calls = 0;
    let canceled = 0;
    const checker = createGithubReleaseChecker({
      repository: "openai/codex", tagPrefix: "rust-v",
      fetchImpl: async () => ++calls === 1 ? { ok: false, status: 403 } : { ok: true, url, body: { cancel: async () => canceled++ } },
    });
    assert.deepEqual(await checker(), { latestVersion: null, releaseUrl: null });
    assert.deepEqual(await checker(), { latestVersion: null, releaseUrl: null });
    assert.equal(calls, 2);
    assert.equal(canceled, 1);
  }
});

test("supports cachedOnly mode without issuing any upstream fetch when cache is empty", async () => {
  let calls = 0;
  const checker = createPiAgentReleaseChecker({
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ tag_name: "v1.0.0" }) };
    },
    now: () => 100,
  });

  const emptyResult = await checker({ cachedOnly: true });
  assert.deepEqual(emptyResult, { latestVersion: null, releaseUrl: null });
  assert.equal(calls, 0);

  // Normal call warms the cache
  const warmedResult = await checker();
  assert.equal(calls, 1);
  assert.deepEqual(warmedResult, {
    latestVersion: "1.0.0",
    releaseUrl: "https://github.com/earendil-works/pi/releases/tag/v1.0.0",
  });

  // Now cachedOnly returns the cached release without any new fetch
  const cachedResult = await checker({ cachedOnly: true });
  assert.deepEqual(cachedResult, warmedResult);
  assert.equal(calls, 1);
});

test("force cannot bypass inFlight and coalesces with concurrent request without double-fetching", async () => {
  let calls = 0;
  let resolveFirst;
  const checker = createPiAgentReleaseChecker({
    fetchImpl: () => {
      calls++;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    },
    now: () => 1000,
  });

  const p1 = checker();
  const p2 = checker({ force: true });
  assert.equal(calls, 1, "fetch must only be invoked once even with force: true while in-flight");

  resolveFirst({ ok: true, json: async () => ({ tag_name: "v2.0.0" }) });

  const res1 = await p1;
  const res2 = await p2;
  assert.deepEqual(res1, {
    latestVersion: "2.0.0",
    releaseUrl: "https://github.com/earendil-works/pi/releases/tag/v2.0.0",
  });
  assert.deepEqual(res2, res1);
  assert.equal(calls, 1);
});

test("force cannot arbitrarily bypass failure backoff during cooldown", async () => {
  let calls = 0;
  let time = 1000;
  const checker = createPiAgentReleaseChecker({
    fetchImpl: async () => {
      calls++;
      throw new Error("network error");
    },
    now: () => time,
    failureBackoffMs: 5000,
  });

  const failRes = await checker();
  assert.deepEqual(failRes, { latestVersion: null, releaseUrl: null });
  assert.equal(calls, 1);

  // During cooldown, force: true should still be blocked by backoff
  time += 1000;
  const forceRes = await checker({ force: true });
  assert.deepEqual(forceRes, { latestVersion: null, releaseUrl: null });
  assert.equal(calls, 1, "force must not bypass backoff during cooldown");

  // After cooldown expires, force can initiate a new fetch
  time += 4500;
  const afterCooldown = await checker({ force: true });
  assert.deepEqual(afterCooldown, { latestVersion: null, releaseUrl: null });
  assert.equal(calls, 2);
});


