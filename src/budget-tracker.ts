import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BudgetState, UtilizationSnapshot } from "./types.ts";
import { getAutoRouterStoragePaths } from "./storage-paths.ts";

export const DEFAULT_STATS_PATH = getAutoRouterStoragePaths({ ensure: false }).stats;

export type ProviderDailyStats = {
  inputTokens: number;
  outputTokens: number;
  /**
   * Cached prompt tokens READ back on this call. With prompt caching active,
   * providers report the cached prefix here and leave `inputTokens` holding only
   * the uncached remainder -- so `inputTokens` alone understates the real context
   * size by orders of magnitude. Billed at a discount, but never free.
   */
  cacheReadTokens: number;
  /** Prompt tokens WRITTEN into the cache (billed at a premium over plain input). */
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type ProviderMonthlyStats = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

/** Zero-value stats row; also the shape older (pre-cache-field) files migrate to. */
export const EMPTY_PROVIDER_STATS: ProviderDailyStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
};

/** Total prompt tokens actually sent: uncached remainder + cache reads + cache writes. */
export function totalPromptTokens(stats: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
  return stats.inputTokens + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
}

/** Share of prompt tokens served from cache (0-1), or null when nothing was sent. */
export function cacheHitRate(stats: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | null {
  const total = totalPromptTokens(stats);
  return total > 0 ? (stats.cacheReadTokens ?? 0) / total : null;
}

export type ProviderLimit = {
  dailyUsd?: number;
  monthlyUsd?: number;
};

export type BudgetStatsFile = {
  version: 2;
  daily: Record<string, Record<string, ProviderDailyStats>>;
  monthly: Record<string, Record<string, ProviderMonthlyStats>>;
  limits: Record<string, ProviderLimit>;
};

export function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function createDefaultStats(): BudgetStatsFile {
  return {
    version: 2,
    daily: {},
    monthly: {},
    limits: {},
  };
}

function sanitizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizeStatsFile(input: unknown): BudgetStatsFile {
  const base = createDefaultStats();
  if (!input || typeof input !== "object") return base;
  const raw = input as Record<string, unknown>;
  const daily = raw.daily && typeof raw.daily === "object" && !Array.isArray(raw.daily) ? raw.daily as Record<string, unknown> : {};
  const monthly = raw.monthly && typeof raw.monthly === "object" && !Array.isArray(raw.monthly) ? raw.monthly as Record<string, unknown> : {};
  const limits = raw.limits && typeof raw.limits === "object" && !Array.isArray(raw.limits) ? raw.limits as Record<string, unknown> : {};

  for (const [day, providers] of Object.entries(daily)) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    base.daily[day] = {};
    for (const [provider, stats] of Object.entries(providers as Record<string, unknown>)) {
      if (!stats || typeof stats !== "object" || Array.isArray(stats)) continue;
      const rawStats = stats as Record<string, unknown>;
      base.daily[day][provider] = {
        inputTokens: sanitizeNumber(rawStats.inputTokens),
        outputTokens: sanitizeNumber(rawStats.outputTokens),
        // Absent in files written before cache accounting landed -> 0.
        cacheReadTokens: sanitizeNumber(rawStats.cacheReadTokens),
        cacheWriteTokens: sanitizeNumber(rawStats.cacheWriteTokens),
        estimatedCost: sanitizeNumber(rawStats.estimatedCost),
      };
    }
  }

  for (const [mon, providers] of Object.entries(monthly)) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    base.monthly[mon] = {};
    for (const [provider, stats] of Object.entries(providers as Record<string, unknown>)) {
      if (!stats || typeof stats !== "object" || Array.isArray(stats)) continue;
      const rawStats = stats as Record<string, unknown>;
      base.monthly[mon][provider] = {
        inputTokens: sanitizeNumber(rawStats.inputTokens),
        outputTokens: sanitizeNumber(rawStats.outputTokens),
        cacheReadTokens: sanitizeNumber(rawStats.cacheReadTokens),
        cacheWriteTokens: sanitizeNumber(rawStats.cacheWriteTokens),
        estimatedCost: sanitizeNumber(rawStats.estimatedCost),
      };
    }
  }

  for (const [provider, limit] of Object.entries(limits)) {
    if (!limit || typeof limit !== "object" || Array.isArray(limit)) continue;
    const rawLimit = limit as Record<string, unknown>;
    const dailyUsd = sanitizeNumber(rawLimit.dailyUsd);
    const monthlyUsd = sanitizeNumber(rawLimit.monthlyUsd);
    if (dailyUsd > 0 || monthlyUsd > 0) {
      base.limits[provider] = {};
      if (dailyUsd > 0) base.limits[provider].dailyUsd = dailyUsd;
      if (monthlyUsd > 0) base.limits[provider].monthlyUsd = monthlyUsd;
    }
  }

  return base;
}

export class BudgetTracker {
  private stats: BudgetStatsFile = createDefaultStats();
  private loaded = false;
  private readonly path: string;
  private utilization: Record<string, UtilizationSnapshot> = {};

  constructor(path = DEFAULT_STATS_PATH) {
    this.path = path;
  }

  setUtilization(snapshots: Record<string, UtilizationSnapshot>): void {
    this.utilization = { ...snapshots };
  }

  getUtilization(): Record<string, UtilizationSnapshot> {
    return this.utilization;
  }

  getPath(): string {
    return this.path;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await readFile(this.path, "utf8");
      this.stats = sanitizeStatsFile(JSON.parse(content));
    } catch {
      this.stats = createDefaultStats();
    }
    this.loaded = true;
  }

  getRawStats(): BudgetStatsFile {
    return this.stats;
  }

  async save(): Promise<void> {
    await this.load();
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.stats, null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
  }

  private ensureDay(day = todayKey()): Record<string, ProviderDailyStats> {
    this.stats.daily[day] ??= {};
    return this.stats.daily[day];
  }

  getDailyProviderStats(provider: string, day = todayKey()): ProviderDailyStats {
    const dayStats = this.stats.daily[day]?.[provider];
    return dayStats ?? { ...EMPTY_PROVIDER_STATS };
  }

  getDailySpend(day = todayKey()): Record<string, number> {
    const dayStats = this.stats.daily[day] ?? {};
    return Object.fromEntries(Object.entries(dayStats).map(([provider, stats]) => [provider, sanitizeNumber(stats.estimatedCost)]));
  }

  getDailyLimits(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.stats.limits).map(([provider, limit]) => [provider, sanitizeNumber(limit.dailyUsd)]));
  }

  getMonthlySpend(mon = monthKey()): Record<string, number> {
    const monStats = this.stats.monthly[mon] ?? {};
    return Object.fromEntries(Object.entries(monStats).map(([provider, stats]) => [provider, sanitizeNumber(stats.estimatedCost)]));
  }

  getMonthlyLimits(): Record<string, number> {
    return Object.fromEntries(
      Object.entries(this.stats.limits)
        .filter(([, limit]) => typeof limit.monthlyUsd === "number" && limit.monthlyUsd > 0)
        .map(([provider, limit]) => [provider, limit.monthlyUsd!]),
    );
  }

  getBudgetState(day = todayKey(), mon = monthKey()): BudgetState {
    const state: BudgetState = {
      dailySpend: this.getDailySpend(day),
      dailyLimit: this.getDailyLimits(),
      monthlySpend: this.getMonthlySpend(mon),
      monthlyLimit: this.getMonthlyLimits(),
    };
    if (Object.keys(this.utilization).length > 0) state.utilization = this.utilization;
    return state;
  }

  getDailySummary(day = todayKey()): Array<{ provider: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCost: number; limitUsd?: number }> {
    const providers = new Set<string>([
      ...Object.keys(this.stats.daily[day] ?? {}),
      ...Object.keys(this.stats.limits),
    ]);
    return Array.from(providers)
      .sort((a, b) => a.localeCompare(b))
      .map((provider) => {
        const stats = this.getDailyProviderStats(provider, day);
        const limitUsd = this.stats.limits[provider]?.dailyUsd;
        return { provider, ...stats, limitUsd };
      });
  }

  async recordUsage(provider: string, usage: unknown, day = todayKey()): Promise<void> {
    await this.load();
    const raw = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
    const cost = raw.cost && typeof raw.cost === "object" ? raw.cost as Record<string, unknown> : {};
    const inputTokens = sanitizeNumber(raw.input);
    const outputTokens = sanitizeNumber(raw.output);
    // cacheRead/cacheWrite are where the bulk of a cached prompt lands; recording
    // only `input` made a 64K-context call look like a 2-token call.
    const cacheReadTokens = sanitizeNumber(raw.cacheRead);
    const cacheWriteTokens = sanitizeNumber(raw.cacheWrite);
    const estimatedCost = sanitizeNumber(cost.total);
    const dayStats = this.ensureDay(day);
    const current = dayStats[provider] ?? { ...EMPTY_PROVIDER_STATS };
    dayStats[provider] = {
      inputTokens: current.inputTokens + inputTokens,
      outputTokens: current.outputTokens + outputTokens,
      cacheReadTokens: current.cacheReadTokens + cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens + cacheWriteTokens,
      estimatedCost: current.estimatedCost + estimatedCost,
    };
    await this.save();
  }

  async setDailyLimit(provider: string, dailyUsd: number): Promise<void> {
    await this.load();
    if (!Number.isFinite(dailyUsd) || dailyUsd <= 0) throw new Error("dailyUsd must be > 0");
    this.stats.limits[provider] ??= {};
    this.stats.limits[provider].dailyUsd = dailyUsd;
    await this.save();
  }

  async clearDailyLimit(provider: string): Promise<void> {
    await this.load();
    const entry = this.stats.limits[provider];
    if (!entry) return;
    delete entry.dailyUsd;
    if (entry.monthlyUsd === undefined) delete this.stats.limits[provider];
    await this.save();
  }

  async setMonthlyLimit(provider: string, monthlyUsd: number): Promise<void> {
    await this.load();
    if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) throw new Error("monthlyUsd must be > 0");
    this.stats.limits[provider] ??= {};
    this.stats.limits[provider].monthlyUsd = monthlyUsd;
    await this.save();
  }

  async clearMonthlyLimit(provider: string): Promise<void> {
    await this.load();
    const entry = this.stats.limits[provider];
    if (!entry) return;
    delete entry.monthlyUsd;
    if (entry.dailyUsd === undefined) delete this.stats.limits[provider];
    await this.save();
  }

  private ensureMonth(mon = monthKey()): Record<string, ProviderMonthlyStats> {
    this.stats.monthly[mon] ??= {};
    return this.stats.monthly[mon];
  }

  async recordMonthlyUsage(provider: string, usage: unknown, mon = monthKey()): Promise<void> {
    await this.load();
    const raw = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
    const cost = raw.cost && typeof raw.cost === "object" ? raw.cost as Record<string, unknown> : {};
    const inputTokens = sanitizeNumber(raw.input);
    const outputTokens = sanitizeNumber(raw.output);
    const cacheReadTokens = sanitizeNumber(raw.cacheRead);
    const cacheWriteTokens = sanitizeNumber(raw.cacheWrite);
    const estimatedCost = sanitizeNumber(cost.total);
    const monStats = this.ensureMonth(mon);
    const current = monStats[provider] ?? { ...EMPTY_PROVIDER_STATS };
    monStats[provider] = {
      inputTokens: current.inputTokens + inputTokens,
      outputTokens: current.outputTokens + outputTokens,
      cacheReadTokens: current.cacheReadTokens + cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens + cacheWriteTokens,
      estimatedCost: current.estimatedCost + estimatedCost,
    };
    await this.save();
  }

  getMonthlyProviderStats(provider: string, mon = monthKey()): ProviderMonthlyStats {
    const monStats = this.stats.monthly[mon]?.[provider];
    return monStats ?? { ...EMPTY_PROVIDER_STATS };
  }
}
