import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDailyQuotaWindow, buildBudgetUtilization } from "../src/budget-uvi.ts";
import { aggregateProviderUVI } from "../src/uvi.ts";
import {
  DEFAULT_UVI_THRESHOLDS,
  type QuotaWindow,
  type UVIThresholds,
  type UtilizationSnapshot,
} from "../src/types.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 2026-01-15 12:00 UTC. Month arithmetic in the tests below is done in local
// time, so assertions use bands that hold across every IANA timezone.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

// The user's tuned pacing thresholds (mirrors a typical settings.json entry).
const USER_THRESHOLDS: UVIThresholds = {
  stressed: 1.1,
  critical: 1.25,
  surplus: 0.5,
  surplusMinElapsed: 0.7,
  minElapsed: 0.1,
};

function makeWindow(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    provider: "anthropic",
    scope: "session",
    usedPercent: 50,
    windowDurationMs: 5 * HOUR,
    resetsAt: new Date(NOW + 3.75 * HOUR).toISOString(),
    source: "oauth-usage",
    fetchedAt: NOW,
    ...overrides,
  };
}

describe("buildDailyQuotaWindow", () => {
  it("builds a midnight-to-midnight window from spend vs limit", () => {
    const w = buildDailyQuotaWindow("anthropic", 25, 100, NOW);
    assert.ok(w, "expected a window");
    assert.equal(w!.provider, "anthropic");
    assert.equal(w!.scope, "daily");
    assert.equal(w!.usedPercent, 25);
    assert.equal(w!.source, "config");

    const reset = new Date(w!.resetsAt!);
    assert.equal(reset.getHours(), 0, "resets at local midnight");
    assert.equal(reset.getMinutes(), 0);
    assert.equal(reset.getSeconds(), 0);
    assert.equal(reset.getMilliseconds(), 0);

    const remaining = reset.getTime() - NOW;
    assert.ok(remaining > 0 && remaining <= DAY, `remaining ${remaining}ms must be in (0, 24h]`);
    // DST days run 23h/25h; a plain day is 24h.
    assert.ok(w!.windowDurationMs >= 23 * HOUR && w!.windowDurationMs <= 25 * HOUR);
  });

  it("clamps usedPercent into 0..100", () => {
    assert.equal(buildDailyQuotaWindow("p", 150, 100, NOW)!.usedPercent, 100);
    assert.equal(buildDailyQuotaWindow("p", -5, 100, NOW)!.usedPercent, 0);
  });

  it("returns null for non-positive or non-finite budgets", () => {
    assert.equal(buildDailyQuotaWindow("p", 10, 0, NOW), null);
    assert.equal(buildDailyQuotaWindow("p", 10, -1, NOW), null);
    assert.equal(buildDailyQuotaWindow("p", 10, Number.NaN, NOW), null);
  });
});

describe("buildBudgetUtilization", () => {
  it("passes OAuth snapshots through untouched when no limits are set", () => {
    const snap: UtilizationSnapshot = aggregateProviderUVI("anthropic", [makeWindow()], NOW);
    const result = buildBudgetUtilization({
      oauthSnapshots: { anthropic: snap },
      dailyLimits: {},
      dailySpend: {},
      monthlyLimits: {},
      monthlySpend: {},
      now: NOW,
      thresholds: USER_THRESHOLDS,
    });
    assert.deepEqual(Object.keys(result), ["anthropic"]);
    assert.equal(result.anthropic, snap, "snapshot must be the same object, unmodified");
  });

  it("paces a budget-only provider with no OAuth data or balance endpoint", () => {
    const result = buildBudgetUtilization({
      oauthSnapshots: {},
      dailyLimits: {},
      dailySpend: {},
      monthlyLimits: { google: 1000 },
      monthlySpend: { google: 100 },
      now: NOW,
      thresholds: USER_THRESHOLDS,
    });
    const snap = result.google;
    assert.ok(snap, "provider with only a figured budget must appear");
    assert.equal(snap.windows.length, 1);
    assert.equal(snap.windows[0].source, "config");
    assert.equal(snap.windows[0].scope, "monthly");
    assert.equal(snap.windows[0].usedPercent, 10);
    // 10% of the monthly budget ~halfway through January: comfortably ok in any TZ.
    assert.equal(snap.status, "ok");
  });

  it("emits one window per configured limit scope", () => {
    const result = buildBudgetUtilization({
      oauthSnapshots: {},
      dailyLimits: { google: 100 },
      dailySpend: { google: 25 },
      monthlyLimits: { google: 1000 },
      monthlySpend: { google: 50 },
      now: NOW,
      thresholds: USER_THRESHOLDS,
    });
    const windows = result.google.windows;
    assert.equal(windows.length, 2);
    assert.deepEqual(windows.map((w) => w.scope).sort(), ["daily", "monthly"]);
    const daily = windows.find((w) => w.scope === "daily")!;
    const monthly = windows.find((w) => w.scope === "monthly")!;
    assert.equal(daily.usedPercent, 25);
    assert.equal(monthly.usedPercent, 5);
  });

  it("merges budget windows with OAuth windows instead of replacing them", () => {
    const session = makeWindow({ usedPercent: 40, resetsAt: new Date(NOW + 3.75 * HOUR).toISOString() });
    const weekly = makeWindow({
      scope: "weekly",
      usedPercent: 20,
      windowDurationMs: 7 * DAY,
      resetsAt: new Date(NOW + 5 * DAY).toISOString(),
    });
    const oauth: UtilizationSnapshot = aggregateProviderUVI("anthropic", [session, weekly], NOW, DEFAULT_UVI_THRESHOLDS);

    const result = buildBudgetUtilization({
      oauthSnapshots: { anthropic: oauth },
      dailyLimits: { anthropic: 1000 },
      dailySpend: { anthropic: 1 },
      monthlyLimits: { anthropic: 1000 },
      monthlySpend: { anthropic: 20 },
      now: NOW,
      thresholds: DEFAULT_UVI_THRESHOLDS,
    });

    const merged = result.anthropic;
    assert.notEqual(merged, oauth, "merged snapshot is a new object");
    assert.equal(merged.windows.length, 4, "both OAuth windows survive the merge");
    assert.deepEqual(merged.windows.filter((w) => w.source === "config").map((w) => w.scope).sort(), ["daily", "monthly"]);
    // Worst window is still the OAuth session window (40% used at 25% elapsed = UVI 1.6).
    assert.equal(merged.status, "stressed");
    // The input snapshot must not be mutated.
    assert.equal(oauth.windows.length, 2);
  });

  it("applies the resolved thresholds to budget windows, not the defaults", () => {
    // 55% of a $100 monthly budget on Jan 15: UVI lands in [1.13, 1.22] across
    // every timezone — stressed under the user's 1.1 threshold, ok under the
    // default 1.5. This is the regression guard for the inconsistency where
    // budget windows ignored autoRouterUviThresholds.
    const input = {
      oauthSnapshots: {} as Record<string, UtilizationSnapshot>,
      dailyLimits: {} as Record<string, number>,
      dailySpend: {} as Record<string, number>,
      monthlyLimits: { google: 100 },
      monthlySpend: { google: 55 },
      now: NOW,
      thresholds: USER_THRESHOLDS,
    };
    assert.equal(buildBudgetUtilization(input).google.status, "stressed");
    assert.equal(
      buildBudgetUtilization({ ...input, thresholds: DEFAULT_UVI_THRESHOLDS }).google.status,
      "ok",
    );
  });

  it("never downgrades an exhausted-pool critical from the merge", () => {
    // OAuth window math reads "stressed" (100% used at 85% elapsed, UVI ~1.18)
    // but the quota cache hard-stopped it to critical. A light budget window
    // must not wash that out.
    const monthly = makeWindow({
      scope: "monthly",
      usedPercent: 100,
      windowDurationMs: 31 * DAY,
      resetsAt: new Date(NOW + 0.15 * 31 * DAY).toISOString(),
    });
    const base = aggregateProviderUVI("anthropic", [monthly], NOW, USER_THRESHOLDS);
    assert.equal(base.status, "stressed", "precondition: window math alone is not critical");
    const oauth: UtilizationSnapshot = {
      ...base,
      status: "critical",
      reason: `monthly spend limit reached; ${base.reason}`,
    };

    const result = buildBudgetUtilization({
      oauthSnapshots: { anthropic: oauth },
      dailyLimits: {},
      dailySpend: {},
      monthlyLimits: { anthropic: 1000 },
      monthlySpend: { anthropic: 5 },
      now: NOW,
      thresholds: USER_THRESHOLDS,
    });

    assert.equal(result.anthropic.status, "critical", "hard stop survives the merge");
    assert.match(result.anthropic.reason, /monthly spend limit reached/);
  });

  it("annotates OAuth fetch errors on the merged snapshot", () => {
    const oauth: UtilizationSnapshot = {
      provider: "anthropic",
      uvi: 0,
      status: "ok",
      windows: [],
      reason: "usage fetch error: HTTP 429",
      error: "HTTP 429",
      fetchedAt: NOW,
    };
    const result = buildBudgetUtilization({
      oauthSnapshots: { anthropic: oauth },
      dailyLimits: {},
      dailySpend: {},
      monthlyLimits: { anthropic: 1000 },
      monthlySpend: { anthropic: 50 },
      now: NOW,
      thresholds: USER_THRESHOLDS,
    });
    assert.match(result.anthropic.reason, /oauth: HTTP 429/);
    assert.equal(result.anthropic.windows.length, 1, "budget window still paces despite the fetch error");
  });
});
