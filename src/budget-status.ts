/**
 * Footer budget status: account-level spend for metered OAuth providers
 * (today + month-to-date against the monthly credit pool), as opposed to the
 * per-session cost pi core shows.
 *
 * Source of truth is the provider's own usage endpoint (Anthropic
 * `/api/oauth/usage` -> `extra_usage.used_credits` / `monthly_limit`), which
 * the QuotaCache already polls for UVI. This module never fetches: a second
 * poller would compete with the router for the same rate limit (it 429s).
 *
 * Anthropic reports no daily figure, so "today" is derived: remember the
 * month-to-date counter at the start of the local day and subtract. Because
 * the counter is account-wide, that includes spend from every client on the
 * account, not just pi on this box.
 *
 * Units: `used_credits` / `monthly_limit` are CENTS (a $250 pool reports
 * monthly_limit 25000).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const BUDGET_STATUS_KEY = "auto-budget"; // sorts before "auto-router" so it is never truncated off

export type DayStart = {
  /** Month-to-date counter at the start of the day, in provider units (cents). */
  used: number;
  /**
   * False when the day's baseline had to be taken from the first reading of
   * the day (no earlier observation existed), so spend before that reading is
   * missing and "today" is a lower bound.
   */
  exact: boolean;
};

export type BudgetDayState = {
  version: 1;
  /** Local calendar day (YYYY-MM-DD) that `dayStart` belongs to. */
  day: string;
  dayStart: Record<string, DayStart>;
  /** Most recent reading per provider, carried across days to seed the next baseline. */
  last: Record<string, { used: number; day: string }>;
  /**
   * Last successful reading with its limit, so a restart during a run of
   * failed fetches (the usage endpoint 429s readily) shows the last known
   * figure marked stale instead of nothing.
   */
  reading?: Record<string, { used: number; limit: number; at: number }>;
};

export function emptyBudgetDayState(day: string): BudgetDayState {
  return { version: 1, day, dayStart: {}, last: {} };
}

/** Local-time YYYY-MM-DD. "Today" means the user's day, not UTC's. */
export function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Fold one month-to-date reading into the day state. Returns a NEW state plus
 * today's spend for that provider. Pure.
 *
 * - First reading of a new day: the baseline is the last reading seen on an
 *   earlier day (exact enough: spend between that reading and midnight lands
 *   on today, which is the best available). With no earlier reading at all the
 *   baseline is this reading itself and `exact` is false.
 * - A reading BELOW the baseline means the monthly pool reset; the baseline
 *   drops to 0 so today is everything spent since the reset.
 */
export function advanceBudgetDay(
  state: BudgetDayState | undefined,
  provider: string,
  used: number,
  today: string,
): { state: BudgetDayState; todayUsed: number; exact: boolean } {
  const base = state && state.version === 1 ? state : emptyBudgetDayState(today);
  const next: BudgetDayState = {
    version: 1,
    day: base.day,
    dayStart: { ...base.dayStart },
    last: { ...base.last },
    ...(base.reading ? { reading: { ...base.reading } } : {}),
  };
  if (next.day !== today) {
    next.day = today;
    next.dayStart = {};
  }

  let start = next.dayStart[provider];
  if (!start) {
    const prev = base.last[provider];
    if (prev && prev.day !== today) {
      start = used >= prev.used ? { used: prev.used, exact: true } : { used: 0, exact: true };
    } else if (prev && prev.day === today && used >= prev.used) {
      // dayStart lost (e.g. older file) but we did see this provider earlier today.
      start = { used: prev.used, exact: false };
    } else {
      start = { used, exact: false };
    }
  } else if (used < start.used) {
    start = { used: 0, exact: true }; // monthly pool reset mid-day
  }
  next.dayStart[provider] = start;
  next.last[provider] = { used, day: today };
  return { state: next, todayUsed: Math.max(0, used - start.used), exact: start.exact };
}

/** Record a successful reading (with its limit) for display after restarts. Pure. */
export function recordReading(
  state: BudgetDayState,
  provider: string,
  used: number,
  limit: number,
  at: number,
): BudgetDayState {
  return { ...state, reading: { ...(state.reading ?? {}), [provider]: { used, limit, at } } };
}

/**
 * Today's spend from persisted state alone, for when no fresh reading exists.
 * Undefined when the state does not describe today.
 */
export function persistedToday(
  state: BudgetDayState | undefined,
  provider: string,
  today: string,
): { todayUsed: number; exact: boolean } | undefined {
  if (!state || state.day !== today) return undefined;
  const start = state.dayStart[provider];
  const last = state.last[provider];
  if (!start || !last || last.day !== today) return undefined;
  return { todayUsed: Math.max(0, last.used - start.used), exact: start.exact };
}

export function loadBudgetDayState(path: string): BudgetDayState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && parsed.version === 1 && typeof parsed.day === "string") return parsed as BudgetDayState;
  } catch {
    // missing or unreadable: start fresh
  }
  return undefined;
}

export function saveBudgetDayState(path: string, state: BudgetDayState): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    // Footer display must never break routing.
  }
}

function dollars(cents: number): string {
  const v = cents / 100;
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

/**
 * e.g. "claude $6.10d · $185/$250m 74%". A "~" prefix on the daily figure
 * marks a lower bound (baseline taken mid-day); "$?d" means today is unknown;
 * a trailing "?" marks a stale reading.
 */
export function formatBudgetStatus(input: {
  label: string;
  usedCents: number;
  limitCents: number;
  todayCents: number | undefined;
  todayExact: boolean;
  stale?: boolean;
}): string {
  const pct = input.limitCents > 0 ? Math.round((input.usedCents / input.limitCents) * 100) : undefined;
  const today = input.todayCents === undefined
    ? "$?d"
    : `${input.todayExact ? "" : "~"}${dollars(input.todayCents)}d`;
  const month = `${dollars(input.usedCents)}/${dollars(input.limitCents)}m${pct !== undefined ? ` ${pct}%` : ""}`;
  return `${input.label} ${today} · ${month}${input.stale ? " ?" : ""}`;
}

/** Shown when there has never been a successful reading. Never silent. */
export function formatBudgetUnavailable(label: string, error: string | undefined): string {
  return `${label} budget ?${error ? ` (${error})` : ""}`;
}
