import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getPiWebReleaseUrl, isNewerStableVersion, getPiWebVersionFromReleaseRedirect } = await jiti.import("./app-update.ts");

test("detects newer stable Agent Web Plus versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("accepts only a canonical stable release redirect for this repository", () => {
  assert.equal(getPiWebVersionFromReleaseRedirect("https://github.com/koxircom/agent-web-plus/releases/tag/v1.4.79"), "1.4.79");
  assert.equal(getPiWebVersionFromReleaseRedirect("/koxircom/agent-web-plus/releases/tag/v1.4.79"), "1.4.79");
  for (const value of [null, "", "https://example.com/koxircom/agent-web-plus/releases/tag/v1.4.79",
    "https://github.com/other/project/releases/tag/v1.4.79", "/koxircom/agent-web-plus/releases/tag/v1.4.80-beta.1",
    "https://name:password@github.com/koxircom/agent-web-plus/releases/tag/v1.4.79",
    "/koxircom/agent-web-plus/releases/tag/v1.4.79?redirect=other", "/koxircom/agent-web-plus/releases/tag/v1.4.79#fragment"]) {
    assert.equal(getPiWebVersionFromReleaseRedirect(value), null);
  }
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("builds a release-notes URL only for stable versions", () => {
  assert.equal(
    getPiWebReleaseUrl("0.8.8"),
    "https://github.com/koxircom/agent-web-plus/releases/tag/v0.8.8",
  );
  assert.equal(getPiWebReleaseUrl("0.8.8-beta.1"), null);
});
