import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapRouteProviderToOAuth, resolveUviThresholdsFrom } from "../src/quota-cache.ts";
import { DEFAULT_UVI_THRESHOLDS } from "../src/types.ts";

describe("mapRouteProviderToOAuth", () => {
  it("maps known providers directly", () => {
    assert.equal(mapRouteProviderToOAuth("openai-codex"), "openai-codex");
    assert.equal(mapRouteProviderToOAuth("google-antigravity"), "google-antigravity");
    assert.equal(mapRouteProviderToOAuth("google-gemini-cli"), "google-gemini-cli");
    assert.equal(mapRouteProviderToOAuth("anthropic"), "anthropic");
  });

  it("maps claude-agent-sdk to anthropic", () => {
    assert.equal(mapRouteProviderToOAuth("claude-agent-sdk"), "anthropic");
  });

  it("uses authProvider when provider is not in the map", () => {
    assert.equal(mapRouteProviderToOAuth("unknown", "openai-codex"), "openai-codex");
  });

  it("returns null for unknown providers", () => {
    assert.equal(mapRouteProviderToOAuth("unknown"), null);
    assert.equal(mapRouteProviderToOAuth("unknown", "also-unknown"), null);
  });

  it("prefers authProvider over provider", () => {
    // If both are known, authProvider takes precedence
    assert.equal(mapRouteProviderToOAuth("openai-codex", "anthropic"), "anthropic");
  });

  it("handles empty strings gracefully", () => {
    assert.equal(mapRouteProviderToOAuth(""), null);
    assert.equal(mapRouteProviderToOAuth("", ""), null);
  });
});

describe("resolveUviThresholdsFrom", () => {
  it("returns defaults when nothing is set", () => {
    assert.deepEqual(resolveUviThresholdsFrom({}, undefined), DEFAULT_UVI_THRESHOLDS);
  });

  it("applies settings values over defaults", () => {
    const t = resolveUviThresholdsFrom({}, { critical: 1.2, stressed: 1.0 });
    assert.equal(t.critical, 1.2);
    assert.equal(t.stressed, 1.0);
    assert.equal(t.surplus, DEFAULT_UVI_THRESHOLDS.surplus);
    assert.equal(t.surplusMinElapsed, DEFAULT_UVI_THRESHOLDS.surplusMinElapsed);
  });

  it("env var wins over settings which wins over default", () => {
    const t = resolveUviThresholdsFrom(
      { AUTO_ROUTER_UVI_CRITICAL: "1.1" },
      { critical: 1.5, stressed: 1.3 },
    );
    assert.equal(t.critical, 1.1); // env beats settings
    assert.equal(t.stressed, 1.3); // settings beats default
    assert.equal(t.surplus, DEFAULT_UVI_THRESHOLDS.surplus); // default
  });

  it("ignores non-positive / non-numeric env and settings values", () => {
    const t = resolveUviThresholdsFrom(
      { AUTO_ROUTER_UVI_CRITICAL: "0", AUTO_ROUTER_UVI_STRESSED: "abc" },
      { surplus: -1 as unknown as number },
    );
    assert.equal(t.critical, DEFAULT_UVI_THRESHOLDS.critical);
    assert.equal(t.stressed, DEFAULT_UVI_THRESHOLDS.stressed);
    // settings surplus of -1 is invalid at the settings layer, but resolveFrom
    // trusts the object it's given; validation happens in readUviThresholdsFromSettings.
    // Here we only assert the env/default path; a negative surplus is passed through.
    assert.equal(t.surplus, -1);
  });

  it("clamps surplusMinElapsed into 0..1", () => {
    assert.equal(resolveUviThresholdsFrom({ AUTO_ROUTER_UVI_SURPLUS_MIN_ELAPSED: "5" }, undefined).surplusMinElapsed, 1);
  });
});
