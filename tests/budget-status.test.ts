import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGET_STATUS_KEY,
  advanceBudgetDay,
  formatBudgetStatus,
  formatBudgetUnavailable,
  loadBudgetDayState,
  localDayKey,
  persistedToday,
  recordReading,
  saveBudgetDayState,
} from "../src/budget-status.ts";
import { QuotaCache } from "../src/quota-cache.ts";

test("status key sorts before auto-router so the footer never truncates it off", () => {
  assert.ok(BUDGET_STATUS_KEY.localeCompare("auto-router") < 0);
  assert.ok(BUDGET_STATUS_KEY.localeCompare("auto-router-model") < 0);
});

test("first-ever reading: today is 0 and marked as a lower bound", () => {
  const r = advanceBudgetDay(undefined, "anthropic", 18497, "2026-10-01");
  assert.equal(r.todayUsed, 0);
  assert.equal(r.exact, false);
});

test("same day: today accumulates from the day's baseline", () => {
  let r = advanceBudgetDay(undefined, "anthropic", 18000, "2026-10-01");
  r = advanceBudgetDay(r.state, "anthropic", 18250, "2026-10-01");
  r = advanceBudgetDay(r.state, "anthropic", 18610, "2026-10-01");
  assert.equal(r.todayUsed, 610);
});

test("new day: baseline is the last reading from the previous day, and exact", () => {
  let r = advanceBudgetDay(undefined, "anthropic", 18000, "2026-10-01");
  r = advanceBudgetDay(r.state, "anthropic", 18600, "2026-10-01");
  r = advanceBudgetDay(r.state, "anthropic", 18900, "2026-10-02");
  assert.equal(r.todayUsed, 300);
  assert.equal(r.exact, true);
  r = advanceBudgetDay(r.state, "anthropic", 19000, "2026-10-02");
  assert.equal(r.todayUsed, 400);
});

test("pool reset across days: counter dropped, today counts from zero", () => {
  let r = advanceBudgetDay(undefined, "anthropic", 24000, "2026-10-31");
  r = advanceBudgetDay(r.state, "anthropic", 150, "2026-11-01");
  assert.equal(r.todayUsed, 150);
  assert.equal(r.exact, true);
});

test("pool reset mid-day: baseline drops to zero", () => {
  let r = advanceBudgetDay(undefined, "anthropic", 24000, "2026-11-01");
  r = advanceBudgetDay(r.state, "anthropic", 24100, "2026-11-01");
  r = advanceBudgetDay(r.state, "anthropic", 40, "2026-11-01");
  assert.equal(r.todayUsed, 40);
});

test("advance is pure: input state is not mutated", () => {
  const a = advanceBudgetDay(undefined, "anthropic", 100, "2026-10-01").state;
  const snapshot = JSON.stringify(a);
  advanceBudgetDay(a, "anthropic", 500, "2026-10-02");
  assert.equal(JSON.stringify(a), snapshot);
});

test("state round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-status-"));
  try {
    const path = join(dir, "auto-router.budget-day.json");
    assert.equal(loadBudgetDayState(path), undefined);
    const r = advanceBudgetDay(undefined, "anthropic", 18000, "2026-10-01");
    saveBudgetDayState(path, r.state);
    const back = advanceBudgetDay(loadBudgetDayState(path), "anthropic", 18200, "2026-10-01");
    assert.equal(back.todayUsed, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("format: cents rendered as dollars with month percent", () => {
  const s = formatBudgetStatus({ label: "claude", usedCents: 18497, limitCents: 25000, todayCents: 610, todayExact: true });
  assert.equal(s, "claude $6.10d · $185/$250m 74%");
});

test("format: lower-bound and stale markers", () => {
  const s = formatBudgetStatus({ label: "claude", usedCents: 500, limitCents: 25000, todayCents: 0, todayExact: false, stale: true });
  assert.equal(s, "claude ~$0.00d · $5.00/$250m 2% ?");
});

test("localDayKey uses local calendar day", () => {
  assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("format: unknown today renders $?d", () => {
  const s = formatBudgetStatus({ label: "claude", usedCents: 18497, limitCents: 25000, todayCents: undefined, todayExact: false, stale: true });
  assert.equal(s, "claude $?d · $185/$250m 74% ?");
});

test("unavailable is never empty: names the error", () => {
  assert.equal(formatBudgetUnavailable("claude", "HTTP 429"), "claude budget ? (HTTP 429)");
  assert.equal(formatBudgetUnavailable("claude", undefined), "claude budget ?");
});

test("persisted reading survives a restart and still yields today", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-status-"));
  try {
    const path = join(dir, "auto-router.budget-day.json");
    let r = advanceBudgetDay(undefined, "anthropic", 18000, "2026-10-01");
    r = advanceBudgetDay(r.state, "anthropic", 18300, "2026-10-01");
    saveBudgetDayState(path, recordReading(r.state, "anthropic", 18300, 25000, 123));
    const back = loadBudgetDayState(path)!;
    assert.deepEqual(back.reading?.anthropic, { used: 18300, limit: 25000, at: 123 });
    assert.deepEqual(persistedToday(back, "anthropic", "2026-10-01"), { todayUsed: 300, exact: false });
    assert.equal(persistedToday(back, "anthropic", "2026-10-02"), undefined, "yesterday's state is not today");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("advance preserves a recorded reading", () => {
  const s = recordReading(advanceBudgetDay(undefined, "anthropic", 1, "2026-10-01").state, "anthropic", 1, 25000, 9);
  const next = advanceBudgetDay(s, "anthropic", 2, "2026-10-02").state;
  assert.deepEqual(next.reading?.anthropic, { used: 1, limit: 25000, at: 9 });
});

test("QuotaCache backs off on repeated usage-endpoint failures and resets on success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-status-"));
  let status = 429;
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (status !== 200) return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ five_hour: null, seven_day: null, extra_usage: { is_enabled: true, monthly_limit: 25000, used_credits: 310 } }), { status: 200 });
  };
  try {
    const cache = new QuotaCache({
      ttlMs: 60_000,
      enabled: true,
      fetchConfig: {
        providerIds: ["anthropic"],
        authFile: join(dir, "auth.json"),
        auth: { anthropic: { type: "oauth", access: "x", refresh: "r", expires: Date.now() + 86_400_000 } } as any,
        fetchFn: fetchFn as any,
      },
    });
    assert.equal(cache.effectiveTtlMs(), 60_000);
    await cache.refreshNow();
    assert.equal(calls, 1);
    assert.equal(cache.getUsage("anthropic"), undefined, "a failed first fetch leaves no usage");
    assert.match(cache.getSnapshot("anthropic")?.error ?? "", /429/);
    assert.equal(cache.effectiveTtlMs(), 120_000);
    await cache.refreshNow();
    assert.equal(cache.effectiveTtlMs(), 240_000);
    for (let i = 0; i < 10; i++) await cache.refreshNow();
    assert.equal(cache.effectiveTtlMs(), 15 * 60_000, "capped");

    status = 200;
    await cache.refreshNow();
    assert.equal(cache.effectiveTtlMs(), 60_000, "success resets backoff");
    assert.equal(cache.getUsage("anthropic")?.extraSpend, 310);

    status = 429;
    await cache.refreshNow();
    assert.equal(cache.getUsage("anthropic")?.extraSpend, 310, "last good reading kept");
    assert.equal(cache.getUsage("anthropic")?.stale, true, "and marked stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
