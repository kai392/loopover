// REGRESSED-verdict track-record aggregation (#8140) -- turns a history of persisted BacktestComparison
// results (#8086, persisted per CI run by #8138) into the summary the Phase-2 merge-gating decision (#8105)
// actually needs: how often a REGRESSED verdict fired, at what rate, broken down per rule. Pure aggregation
// over caller-supplied history -- how the records were persisted/loaded is the thin IO wrapper's concern, so
// this stays fully testable against synthetic fixtures before any real production data exists.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestComparison } from "./backtest-compare.js";

/** Per-rule verdict counts. `total` always equals the sum of the three verdict buckets. */
export type RegressedVerdictRuleBreakdown = {
  total: number;
  regressed: number;
  improved: number;
  unchanged: number;
};

export type RegressedVerdictTrackRecord = {
  totalRuns: number;
  regressedRuns: number;
  /** regressedRuns / totalRuns, or null when there are no runs at all -- the same "unknown stays unknown,
   *  never coerced to 0" discipline as BacktestScoreReport's own nullable ratios (#8085). */
  regressedRate: number | null;
  perRule: Map<string, RegressedVerdictRuleBreakdown>;
};

/**
 * Aggregate historical {@link BacktestComparison} results into the #8105 decision summary: total runs, the
 * count and rate of `"regressed"` verdicts, and a per-`ruleId` verdict breakdown. Insertion order of
 * `perRule` follows first appearance in `comparisons`, so a chronologically-ordered history yields a
 * chronologically-stable breakdown. Pure -- identical input always yields identical output.
 */
export function computeRegressedVerdictTrackRecord(comparisons: readonly BacktestComparison[]): RegressedVerdictTrackRecord {
  const perRule = new Map<string, RegressedVerdictRuleBreakdown>();
  let regressedRuns = 0;
  for (const comparison of comparisons) {
    let breakdown = perRule.get(comparison.ruleId);
    if (breakdown === undefined) {
      breakdown = { total: 0, regressed: 0, improved: 0, unchanged: 0 };
      perRule.set(comparison.ruleId, breakdown);
    }
    breakdown.total += 1;
    if (comparison.verdict === "regressed") {
      breakdown.regressed += 1;
      regressedRuns += 1;
    } else if (comparison.verdict === "improved") {
      breakdown.improved += 1;
    } else {
      breakdown.unchanged += 1;
    }
  }
  return {
    totalRuns: comparisons.length,
    regressedRuns,
    regressedRate: comparisons.length > 0 ? regressedRuns / comparisons.length : null,
    perRule,
  };
}
