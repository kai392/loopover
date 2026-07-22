import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / miner-deny-hook-synthesis.test.ts.
import {
  renderBacktestComparison,
  renderBacktestScoreReport,
} from "../../packages/loopover-engine/src/calibration/backtest-report";
import type { BacktestComparison } from "../../packages/loopover-engine/src/calibration/backtest-compare";
import type { BacktestScoreReport } from "../../packages/loopover-engine/src/calibration/backtest-score";

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

describe("renderBacktestScoreReport (#8088)", () => {
  it("renders the exact snapshot for a non-null report", () => {
    expect(renderBacktestScoreReport(report())).toBe(
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

  it("renders null precision/recall as N/A -- never 0, null, or an empty cell", () => {
    const rendered = renderBacktestScoreReport(report({ precision: null, recall: null }));
    expect(rendered).toContain("| Precision | N/A |");
    expect(rendered).toContain("| Recall | N/A |");
    expect(rendered).not.toContain("| Precision | 0 |");
    expect(rendered).not.toContain("null");
  });

  it("is deterministic for identical input", () => {
    expect(renderBacktestScoreReport(report())).toBe(renderBacktestScoreReport(report()));
  });
});

describe("renderBacktestComparison (#8088)", () => {
  it("puts each axis under its own section and pins the literal REGRESSED do-not-merge wording", () => {
    const rendered = renderBacktestComparison(
      comparison({ regressedAxes: ["recall"], improvedAxes: ["precision"], verdict: "regressed" }),
    );
    expect(rendered).toContain("**Regressed**\n\n- recall");
    expect(rendered).toContain("**Improved**\n\n- precision");
    expect(rendered).toContain("Verdict: REGRESSED — do not merge");
  });

  it("claims no regressed axis for an improved comparison", () => {
    const rendered = renderBacktestComparison(comparison());
    expect(rendered).toContain("**Regressed**\n\n- (none)");
    expect(rendered).toContain("**Improved**\n\n- precision");
    expect(rendered).toContain("Verdict: improved");
    expect(rendered).not.toContain("REGRESSED");
  });

  it("lists no axis on either side for an unchanged comparison", () => {
    const rendered = renderBacktestComparison(
      comparison({ improvedAxes: [], verdict: "unchanged", candidate: report() }),
    );
    expect(rendered).toContain("**Regressed**\n\n- (none)");
    expect(rendered).toContain("**Improved**\n\n- (none)");
    expect(rendered).toContain("Verdict: unchanged");
  });

  it("is deterministic for identical input", () => {
    const regressed = comparison({ regressedAxes: ["recall"], verdict: "regressed" });
    expect(renderBacktestComparison(regressed)).toBe(renderBacktestComparison(regressed));
  });
});
