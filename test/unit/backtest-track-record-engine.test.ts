import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built artifact for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / miner-deny-hook-synthesis.test.ts.
import { computeRegressedVerdictTrackRecord } from "../../packages/loopover-engine/src/calibration/backtest-track-record";
import type { BacktestComparison } from "../../packages/loopover-engine/src/calibration/backtest-compare";
import type { BacktestScoreReport } from "../../packages/loopover-engine/src/calibration/backtest-score";

function report(ruleId: string, overrides: Partial<BacktestScoreReport> = {}): BacktestScoreReport {
  return {
    ruleId,
    caseCount: 10,
    truePositive: 4,
    falsePositive: 2,
    trueNegative: 3,
    falseNegative: 1,
    precision: 0.5,
    recall: 0.5,
    ...overrides,
  };
}

function comparison(ruleId: string, verdict: BacktestComparison["verdict"]): BacktestComparison {
  return {
    ruleId,
    baseline: report(ruleId),
    candidate: report(ruleId),
    regressedAxes: verdict === "regressed" ? ["recall"] : [],
    improvedAxes: verdict === "improved" ? ["precision"] : [],
    verdict,
  };
}

describe("computeRegressedVerdictTrackRecord (#8140)", () => {
  it("reports zero runs with a null rate and an empty per-rule map -- unknown stays unknown, never 0", () => {
    expect(computeRegressedVerdictTrackRecord([])).toEqual({
      totalRuns: 0,
      regressedRuns: 0,
      regressedRate: null,
      perRule: new Map(),
    });
  });

  it("reports an all-clean history with zero regressed runs and a real 0 rate", () => {
    const record = computeRegressedVerdictTrackRecord([
      comparison("missing_linked_issue", "improved"),
      comparison("missing_linked_issue", "unchanged"),
    ]);
    expect(record.totalRuns).toBe(2);
    expect(record.regressedRuns).toBe(0);
    expect(record.regressedRate).toBe(0);
    expect(record.perRule.get("missing_linked_issue")).toEqual({ total: 2, regressed: 0, improved: 1, unchanged: 1 });
  });

  it("counts regressed runs and computes the rate over the full history", () => {
    const record = computeRegressedVerdictTrackRecord([
      comparison("missing_linked_issue", "regressed"),
      comparison("missing_linked_issue", "improved"),
      comparison("missing_linked_issue", "regressed"),
      comparison("missing_linked_issue", "unchanged"),
    ]);
    expect(record.totalRuns).toBe(4);
    expect(record.regressedRuns).toBe(2);
    expect(record.regressedRate).toBe(0.5);
  });

  it("breaks the verdicts down per ruleId with more than one rule present, keeping first-appearance order", () => {
    const record = computeRegressedVerdictTrackRecord([
      comparison("ai_consensus_defect", "regressed"),
      comparison("missing_linked_issue", "improved"),
      comparison("ai_consensus_defect", "unchanged"),
      comparison("missing_linked_issue", "regressed"),
      comparison("ai_consensus_defect", "regressed"),
    ]);
    expect([...record.perRule.keys()]).toEqual(["ai_consensus_defect", "missing_linked_issue"]);
    expect(record.perRule.get("ai_consensus_defect")).toEqual({ total: 3, regressed: 2, improved: 0, unchanged: 1 });
    expect(record.perRule.get("missing_linked_issue")).toEqual({ total: 2, regressed: 1, improved: 1, unchanged: 0 });
    expect(record.totalRuns).toBe(5);
    expect(record.regressedRuns).toBe(3);
    expect(record.regressedRate).toBe(0.6);
  });

  it("every per-rule total equals the sum of its three verdict buckets", () => {
    const record = computeRegressedVerdictTrackRecord([
      comparison("a", "regressed"),
      comparison("a", "improved"),
      comparison("b", "unchanged"),
    ]);
    for (const breakdown of record.perRule.values()) {
      expect(breakdown.total).toBe(breakdown.regressed + breakdown.improved + breakdown.unchanged);
    }
  });
});
