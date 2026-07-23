import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeRegressedVerdictTrackRecord,
  type BacktestComparison,
  type BacktestScoreReport,
} from "../dist/index.js";

function report(ruleId: string): BacktestScoreReport {
  return {
    ruleId,
    caseCount: 10,
    truePositive: 4,
    falsePositive: 2,
    trueNegative: 3,
    falseNegative: 1,
    precision: 0.5,
    recall: 0.5,
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

test("barrel: the public entrypoint re-exports the track-record aggregation (#8140)", () => {
  assert.equal(typeof computeRegressedVerdictTrackRecord, "function");
});

test("computeRegressedVerdictTrackRecord: zero runs yields a null rate and an empty per-rule map", () => {
  assert.deepEqual(computeRegressedVerdictTrackRecord([]), {
    totalRuns: 0,
    regressedRuns: 0,
    regressedRate: null,
    perRule: new Map(),
  });
});

test("computeRegressedVerdictTrackRecord: an all-clean history reports a real 0 rate, never null", () => {
  const record = computeRegressedVerdictTrackRecord([
    comparison("missing_linked_issue", "improved"),
    comparison("missing_linked_issue", "unchanged"),
  ]);
  assert.equal(record.regressedRuns, 0);
  assert.equal(record.regressedRate, 0);
  assert.deepEqual(record.perRule.get("missing_linked_issue"), { total: 2, regressed: 0, improved: 1, unchanged: 1 });
});

test("computeRegressedVerdictTrackRecord: counts regressed runs and breaks verdicts down per ruleId", () => {
  const record = computeRegressedVerdictTrackRecord([
    comparison("ai_consensus_defect", "regressed"),
    comparison("missing_linked_issue", "improved"),
    comparison("ai_consensus_defect", "unchanged"),
    comparison("missing_linked_issue", "regressed"),
  ]);
  assert.equal(record.totalRuns, 4);
  assert.equal(record.regressedRuns, 2);
  assert.equal(record.regressedRate, 0.5);
  assert.deepEqual([...record.perRule.keys()], ["ai_consensus_defect", "missing_linked_issue"]);
  assert.deepEqual(record.perRule.get("ai_consensus_defect"), { total: 2, regressed: 1, improved: 0, unchanged: 1 });
  assert.deepEqual(record.perRule.get("missing_linked_issue"), { total: 2, regressed: 1, improved: 1, unchanged: 0 });
});
