import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetTracker, cacheHitRate, totalPromptTokens } from "../src/budget-tracker.ts";

describe("BudgetTracker", () => {
  it("starts empty when file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.load();
    assert.deepEqual(tracker.getBudgetState(), { dailySpend: {}, dailyLimit: {}, monthlySpend: {}, monthlyLimit: {} });
  });

  it("records usage and accumulates spend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.recordUsage("openai-codex", { input: 100, output: 50, cost: { total: 0.12 } }, "2026-04-25");
    await tracker.recordUsage("openai-codex", { input: 10, output: 5, cost: { total: 0.03 } }, "2026-04-25");
    const summary = tracker.getDailySummary("2026-04-25");
    assert.equal(summary.length, 1);
    assert.equal(summary[0].provider, "openai-codex");
    assert.equal(summary[0].inputTokens, 110);
    assert.equal(summary[0].outputTokens, 55);
    assert.equal(summary[0].estimatedCost, 0.15);
  });

  it("persists limits and daily stats across reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const path = join(dir, "stats.json");
    const trackerA = new BudgetTracker(path);
    await trackerA.recordUsage("google-antigravity", { input: 1, output: 2, cost: { total: 0.22 } }, "2026-04-25");
    await trackerA.setDailyLimit("google-antigravity", 5);

    const trackerB = new BudgetTracker(path);
    await trackerB.load();
    assert.equal(trackerB.getDailySpend("2026-04-25")["google-antigravity"], 0.22);
    assert.equal(trackerB.getDailyLimits()["google-antigravity"], 5);
  });

  it("gracefully handles corrupt json by resetting to defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const path = join(dir, "stats.json");
    await writeFile(path, "{not-json", "utf8");
    const tracker = new BudgetTracker(path);
    await tracker.load();
    assert.deepEqual(tracker.getBudgetState(), { dailySpend: {}, dailyLimit: {}, monthlySpend: {}, monthlyLimit: {} });
  });

  it("writes a versioned json file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const path = join(dir, "stats.json");
    const tracker = new BudgetTracker(path);
    await tracker.recordUsage("claude-agent-sdk", { input: 7, output: 8, cost: { total: 0 } }, "2026-04-25");
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.version, 2);
    assert.ok(raw.daily["2026-04-25"]);
  });

  it("can clear a limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.setDailyLimit("nvidia", 2.5);
    await tracker.clearDailyLimit("nvidia");
    assert.equal(tracker.getDailyLimits().nvidia, undefined);
  });

  it("exposes utilization snapshots through getBudgetState", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.load();
    assert.equal(tracker.getBudgetState().utilization, undefined);
    tracker.setUtilization({
      anthropic: {
        provider: "anthropic",
        uvi: 1.7,
        status: "stressed",
        windows: [],
        reason: "test",
        fetchedAt: 1,
      },
    });
    const state = tracker.getBudgetState();
    assert.ok(state.utilization);
    assert.equal(state.utilization!.anthropic.status, "stressed");
    assert.equal(tracker.getUtilization().anthropic.uvi, 1.7);
  });
});

describe("BudgetTracker prompt-cache accounting", () => {
  // Regression: prompt caching splits a prompt across input/cacheRead/cacheWrite.
  // Recording only `input` logged a 64K-context call as a ~2-token call, because
  // the cached prefix lands in cacheRead and never reached the stats file.
  it("records cache read/write tokens alongside input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.recordUsage(
      "anthropic",
      { input: 2, output: 500, cacheRead: 63000, cacheWrite: 1200, cost: { total: 0.42 } },
      "2026-04-25",
    );
    const stats = tracker.getDailyProviderStats("anthropic", "2026-04-25");
    assert.equal(stats.inputTokens, 2);
    assert.equal(stats.cacheReadTokens, 63000);
    assert.equal(stats.cacheWriteTokens, 1200);
    assert.equal(totalPromptTokens(stats), 64202, "full prompt size, not just the uncached remainder");
  });

  it("accumulates cache tokens across calls and months", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    const usage = { input: 5, output: 10, cacheRead: 1000, cacheWrite: 100, cost: { total: 0.01 } };
    await tracker.recordUsage("anthropic", usage, "2026-04-25");
    await tracker.recordUsage("anthropic", usage, "2026-04-25");
    await tracker.recordMonthlyUsage("anthropic", usage, "2026-04");
    await tracker.recordMonthlyUsage("anthropic", usage, "2026-04");

    const daily = tracker.getDailyProviderStats("anthropic", "2026-04-25");
    assert.equal(daily.cacheReadTokens, 2000);
    assert.equal(daily.cacheWriteTokens, 200);

    const monthly = tracker.getMonthlyProviderStats("anthropic", "2026-04");
    assert.equal(monthly.cacheReadTokens, 2000);
    assert.equal(monthly.cacheWriteTokens, 200);
  });

  it("reports a cache hit rate over the whole prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.recordUsage(
      "anthropic",
      { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } },
      "2026-04-25",
    );
    assert.equal(cacheHitRate(tracker.getDailyProviderStats("anthropic", "2026-04-25")), 0.9);
  });

  it("returns a null hit rate when no prompt tokens were sent", () => {
    assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
  });

  it("treats a provider that reports no cache fields as zero, not NaN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.recordUsage("hermes-qwen", { input: 300, output: 20, cost: { total: 0 } }, "2026-04-25");
    const stats = tracker.getDailyProviderStats("hermes-qwen", "2026-04-25");
    assert.equal(stats.cacheReadTokens, 0);
    assert.equal(stats.cacheWriteTokens, 0);
    assert.equal(totalPromptTokens(stats), 300);
    assert.equal(cacheHitRate(stats), 0);
  });

  it("migrates a pre-cache-field stats file without losing spend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const path = join(dir, "stats.json");
    // Shape written by the version that predates cache accounting.
    await writeFile(path, JSON.stringify({
      version: 2,
      daily: { "2026-04-25": { anthropic: { inputTokens: 400, outputTokens: 243, estimatedCost: 20.73 } } },
      monthly: { "2026-04": { anthropic: { inputTokens: 400, outputTokens: 243, estimatedCost: 20.73 } } },
      limits: { anthropic: { dailyUsd: 10 } },
    }));

    const tracker = new BudgetTracker(path);
    await tracker.load();
    const stats = tracker.getDailyProviderStats("anthropic", "2026-04-25");
    assert.equal(stats.inputTokens, 400, "existing counts preserved");
    assert.equal(stats.estimatedCost, 20.73, "spend preserved — the dollar gate must not move");
    assert.equal(stats.cacheReadTokens, 0, "missing cache fields default to 0, never NaN");
    assert.equal(stats.cacheWriteTokens, 0);
    assert.equal(tracker.getMonthlyProviderStats("anthropic", "2026-04").cacheReadTokens, 0);
    assert.equal(tracker.getDailyLimits().anthropic, 10);
  });
});
