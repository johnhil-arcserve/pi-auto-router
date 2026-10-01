import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGET_STATUS_KEY,
  advanceBudgetDay,
  formatBudgetStatus,
  loadBudgetDayState,
  localDayKey,
  saveBudgetDayState,
} from "../src/budget-status.ts";

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
