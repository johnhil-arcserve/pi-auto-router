import { auditBudget, type BudgetAuditResult } from "./budget-auditor.ts";
import type { BudgetState, RouteTarget } from "./types.ts";

export type PartitionResult = {
  ordered: RouteTarget[];
  promoted: RouteTarget[];
  normal: RouteTarget[];
  demoted: RouteTarget[];
  rejections: string[];
  warnings: string[];
  uviNotes: string[];
  audits: Map<RouteTarget, BudgetAuditResult>;
};

export function partitionAuditedCandidates(
  candidates: RouteTarget[],
  budgetState: BudgetState | undefined,
  opts?: { hardMode?: boolean },
): PartitionResult {
  const hardMode = opts?.hardMode ?? false;
  const promoted: RouteTarget[] = [];
  const normal: RouteTarget[] = [];
  const demoted: RouteTarget[] = [];
  const rejections: string[] = [];
  const warnings: string[] = [];
  const warnedProviders = new Set<string>();
  const uviNotes: string[] = [];
  const audits = new Map<RouteTarget, BudgetAuditResult>();

  for (const cand of candidates) {
    const audit = auditBudget(cand.provider, budgetState);
    audits.set(cand, audit);
    if (audit.status === "blocked") {
      rejections.push(`${cand.label}: ${audit.message}`);
      continue;
    }
    // Budgets and UVI are audited per provider, so every target sharing a
    // stressed provider (e.g. Sonnet/Haiku/Opus all on `anthropic`) produces
    // the identical warning. Only surface it once per provider, otherwise it
    // gets joined N times into the same footer/reasoning string.
    if (audit.status === "warning" && audit.message && !warnedProviders.has(cand.provider)) {
      warnings.push(audit.message);
      warnedProviders.add(cand.provider);
    }
    if (audit.hint === "promote") {
      promoted.push(cand);
      uviNotes.push(`${cand.label} promoted (UVI=${audit.uvi?.toFixed(2)} surplus)`);
    } else if (audit.hint === "demote") {
      demoted.push(cand);
      uviNotes.push(`${cand.label} demoted (UVI=${audit.uvi?.toFixed(2)} stressed)`);
    } else {
      normal.push(cand);
    }
  }

  return {
    ordered: hardMode ? [...promoted, ...normal] : [...promoted, ...normal, ...demoted],
    promoted,
    normal,
    demoted,
    rejections,
    warnings,
    uviNotes,
    audits,
  };
}
