import { buildMonthlyQuotaWindow } from "./balance-fetcher.ts";
import { aggregateProviderUVI } from "./uvi.ts";
import type { QuotaWindow, UVIThresholds, UtilizationSnapshot } from "./types.ts";

/**
 * Build a calendar-day QuotaWindow for a user-configured daily budget so the
 * UVI pipeline paces against it like any other window.
 *
 * usedPercent = (dailySpend / dailyBudget) × 100
 * windowDurationMs = milliseconds from local midnight to local midnight
 *
 * The duration is derived from the actual midnight-to-midnight span, so DST
 * days (23h/25h) stay consistent with `resetsAt`.
 */
export function buildDailyQuotaWindow(
  provider: string,
  dailySpend: number,
  dailyBudget: number,
  now = Date.now(),
): QuotaWindow | null {
  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) return null;
  const usedPercent = Math.min(100, Math.max(0, (dailySpend / dailyBudget) * 100));

  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();

  return {
    provider,
    scope: "daily",
    usedPercent,
    resetsAt: new Date(endOfDay).toISOString(),
    windowDurationMs: endOfDay - startOfDay,
    source: "config",
    fetchedAt: now,
  };
}

export type BudgetUtilizationInput = {
  /**
   * Subscription (OAuth) snapshots from QuotaCache, keyed by provider id.
   * Their windows are merged with budget windows, never replaced, so a
   * provider paced by both an account pool and a user budget keeps both
   * signals. Snapshots are only read, never mutated.
   */
  oauthSnapshots: Record<string, UtilizationSnapshot>;
  dailyLimits: Record<string, number>;
  dailySpend: Record<string, number>;
  monthlyLimits: Record<string, number>;
  monthlySpend: Record<string, number>;
  now: number;
  thresholds: UVIThresholds;
};

/**
 * Merge user-configured budget windows into the utilization map that drives
 * UVI bucketing.
 *
 * For every provider with a positive daily or monthly limit a window is
 * built from tracked spend. If the provider also has an OAuth snapshot the
 * budget windows are appended to the snapshot's windows and the union is
 * re-aggregated (worst window wins, so the tighter of daily/monthly/account
 * paces). Providers without any limit pass through with their existing
 * snapshot untouched, and providers with only a budget appear as new entries.
 *
 * A pre-existing "critical" status is never downgraded by the merge: an
 * exhausted account pool (hard stop) must stay blocking even when the
 * elapsed-fraction math of a later month would read below the critical
 * threshold.
 */
export function buildBudgetUtilization(input: BudgetUtilizationInput): Record<string, UtilizationSnapshot> {
  const { oauthSnapshots, dailyLimits, dailySpend, monthlyLimits, monthlySpend, now, thresholds } = input;

  const out: Record<string, UtilizationSnapshot> = { ...oauthSnapshots };

  const providers = new Set<string>([...Object.keys(dailyLimits), ...Object.keys(monthlyLimits)]);
  for (const provider of providers) {
    const windows: QuotaWindow[] = [];

    const dailyLimit = dailyLimits[provider];
    if (typeof dailyLimit === "number" && dailyLimit > 0) {
      const window = buildDailyQuotaWindow(provider, dailySpend[provider] ?? 0, dailyLimit, now);
      if (window) windows.push(window);
    }

    const monthlyLimit = monthlyLimits[provider];
    if (typeof monthlyLimit === "number" && monthlyLimit > 0) {
      const window = buildMonthlyQuotaWindow(provider, monthlySpend[provider] ?? 0, monthlyLimit, now);
      if (window) windows.push(window);
    }

    if (windows.length === 0) continue;

    const existing = out[provider];
    const all = existing && existing.windows.length > 0 ? [...existing.windows, ...windows] : windows;
    let snap = aggregateProviderUVI(provider, all, now, thresholds);

    if (existing?.status === "critical" && snap.status !== "critical") {
      snap = { ...snap, status: "critical", reason: `${existing.reason}; ${snap.reason}` };
    }
    if (existing?.error) {
      snap = { ...snap, reason: `${snap.reason}; oauth: ${existing.error}` };
    }

    out[provider] = snap;
  }

  return out;
}
