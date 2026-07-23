import { describe, expect, it } from "vitest";

import { comparisonsFromAuditMetadataRows } from "../../scripts/backtest-track-record-core";
import type { BacktestComparison } from "../../packages/loopover-engine/src/calibration/backtest-compare";
import type { BacktestScoreReport } from "../../packages/loopover-engine/src/calibration/backtest-score";

function report(ruleId: string): BacktestScoreReport {
  return {
    ruleId,
    caseCount: 1,
    truePositive: 1,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
    precision: 1,
    recall: 1,
  };
}

function comparison(ruleId: string, verdict: BacktestComparison["verdict"]): BacktestComparison {
  return {
    ruleId,
    baseline: report(ruleId),
    candidate: report(ruleId),
    regressedAxes: [],
    improvedAxes: [],
    verdict,
  };
}

function row(comparisonValue: unknown, constantName = "DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE"): { metadata_json: string } {
  return { metadata_json: JSON.stringify({ comparison: comparisonValue, constantName }) };
}

describe("comparisonsFromAuditMetadataRows (#8140)", () => {
  it("extracts every persisted comparison in row order", () => {
    const first = comparison("ai_consensus_defect", "regressed");
    const second = comparison("missing_linked_issue", "improved");
    expect(comparisonsFromAuditMetadataRows([row(first), row(second)])).toEqual([first, second]);
  });

  it("skips corrupt JSON, non-object metadata, and foreign-shaped comparisons instead of throwing", () => {
    const good = comparison("ai_consensus_defect", "unchanged");
    const rows = [
      { metadata_json: "{not json" }, // corrupt JSON -> parse fail-open
      { metadata_json: JSON.stringify([1, 2, 3]) }, // array metadata -> not an object
      { metadata_json: 42 as unknown }, // non-string metadata_json
      {}, // absent metadata_json
      row({ ruleId: 7, verdict: "regressed" }), // non-string ruleId -> foreign shape
      row({ ruleId: "x", verdict: "exploded" }), // unknown verdict -> foreign shape
      row(null), // null comparison
      row([]), // array comparison
      row(good),
    ];
    expect(comparisonsFromAuditMetadataRows(rows)).toEqual([good]);
  });

  it("returns an empty list for an empty history", () => {
    expect(comparisonsFromAuditMetadataRows([])).toEqual([]);
  });
});
