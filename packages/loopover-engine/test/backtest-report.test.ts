import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderBacktestComparison,
  renderBacktestScoreReport,
  type BacktestComparison,
  type BacktestScoreReport,
} from "../dist/index.js";

function report(overrides: Partial<BacktestScoreReport> = {}): BacktestScoreReport {
  return {
    ruleId: "missing_linked_issue",
    caseCount: 4,
    truePositive: 1,
    falsePositive: 1,
    trueNegative: 1,
    falseNegative: 1,
    precision: 0.5,
    recall: 0.5,
    ...overrides,
  };
}

function comparison(overrides: Partial<BacktestComparison> = {}): BacktestComparison {
  return {
    ruleId: "missing_linked_issue",
    baseline: report(),
    candidate: report({ precision: 0.75 }),
    regressedAxes: [],
    improvedAxes: ["precision"],
    verdict: "improved",
    ...overrides,
  };
}

test("renderBacktestScoreReport: snapshot -- a non-null report renders every count and both ratios", () => {
  assert.equal(
    renderBacktestScoreReport(report()),
    [
      "### Backtest score — `missing_linked_issue`",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      "| Cases scored | 4 |",
      "| True positives | 1 |",
      "| False positives | 1 |",
      "| True negatives | 1 |",
      "| False negatives | 1 |",
      "| Precision | 0.5 |",
      "| Recall | 0.5 |",
    ].join("\n"),
  );
});

test("renderBacktestScoreReport: null precision/recall render as N/A, never 0, null, or an empty cell", () => {
  const rendered = renderBacktestScoreReport(report({ precision: null, recall: null }));
  assert.match(rendered, /\| Precision \| N\/A \|/);
  assert.match(rendered, /\| Recall \| N\/A \|/);
  assert.doesNotMatch(rendered, /\| Precision \| (0|null)? \|/);
  assert.doesNotMatch(rendered, /\| Recall \| (0|null)? \|/);
});

test("renderBacktestComparison: a regressed comparison names the regressed axis under Regressed and closes with the literal REGRESSED wording", () => {
  const rendered = renderBacktestComparison(
    comparison({ regressedAxes: ["recall"], improvedAxes: ["precision"], verdict: "regressed" }),
  );
  assert.match(rendered, /\*\*Regressed\*\*\n\n- recall/);
  assert.match(rendered, /\*\*Improved\*\*\n\n- precision/);
  assert.match(rendered, /Verdict: REGRESSED — do not merge/);
});

test("renderBacktestComparison: an improved comparison claims no regressed axis", () => {
  const rendered = renderBacktestComparison(comparison());
  assert.match(rendered, /\*\*Regressed\*\*\n\n- \(none\)/);
  assert.match(rendered, /\*\*Improved\*\*\n\n- precision/);
  assert.match(rendered, /Verdict: improved/);
  assert.doesNotMatch(rendered, /REGRESSED/);
});

test("renderBacktestComparison: an unchanged comparison lists no axis on either side", () => {
  const rendered = renderBacktestComparison(
    comparison({ improvedAxes: [], verdict: "unchanged", candidate: report() }),
  );
  assert.match(rendered, /\*\*Regressed\*\*\n\n- \(none\)/);
  assert.match(rendered, /\*\*Improved\*\*\n\n- \(none\)/);
  assert.match(rendered, /Verdict: unchanged/);
});

test("both renderers are deterministic: identical input renders byte-identical output", () => {
  assert.equal(renderBacktestScoreReport(report()), renderBacktestScoreReport(report()));
  const regressed = comparison({ regressedAxes: ["recall"], verdict: "regressed" });
  assert.equal(renderBacktestComparison(regressed), renderBacktestComparison(regressed));
});
