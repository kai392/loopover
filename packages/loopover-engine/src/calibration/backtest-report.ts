// Markdown renderers for backtest results (#8088) -- the human-readable "receipt" a maintainer (and, per
// the parent epic, eventually an advisory CI comment) reads for a BacktestScoreReport (#8085) or a
// BacktestComparison (#8086). Deterministic pure functions producing stable Markdown, not ad-hoc console
// logging: byte-identical input always renders byte-identical output.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestComparison } from "./backtest-compare.js";
import type { BacktestScoreReport } from "./backtest-score.js";

/** Render a nullable ratio for display: `null` is `N/A` -- never `0`, the word `null`, or an empty cell
 *  (the same null-is-not-zero discipline BacktestScoreReport itself establishes). */
function renderRatio(value: number | null): string {
  return value === null ? "N/A" : String(value);
}

/**
 * Render one {@link BacktestScoreReport} as a Markdown table: the rule ID as a heading, then every count
 * and both (nullable) ratios. Pure string-in/string-out; the exact layout is pinned by a snapshot test.
 */
export function renderBacktestScoreReport(report: BacktestScoreReport): string {
  return [
    `### Backtest score — \`${report.ruleId}\``,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Cases scored | ${report.caseCount} |`,
    `| True positives | ${report.truePositive} |`,
    `| False positives | ${report.falsePositive} |`,
    `| True negatives | ${report.trueNegative} |`,
    `| False negatives | ${report.falseNegative} |`,
    `| Precision | ${renderRatio(report.precision)} |`,
    `| Recall | ${renderRatio(report.recall)} |`,
  ].join("\n");
}

/**
 * Render one {@link BacktestComparison} as Markdown: the rule ID as a heading, a "Regressed" section for
 * every regressed axis, a visually separate "Improved" section for every improved axis (an axis can only
 * ever appear under its own section -- the two lists are disjoint by construction upstream), and a closing
 * verdict line. The `"regressed"` closing line contains the literal word `REGRESSED` and states the change
 * should not be merged -- pinned wording, so a future automated consumer can detect the regressed case by
 * string match without re-implementing the comparison logic. Sections with no axes render as "(none)"
 * rather than listing anything, so an empty regression list can never read as if something regressed.
 */
export function renderBacktestComparison(comparison: BacktestComparison): string {
  const axisLines = (axes: ReadonlyArray<"precision" | "recall">): string[] =>
    axes.length === 0 ? ["- (none)"] : axes.map((axis) => `- ${axis}`);
  const verdictLine =
    comparison.verdict === "regressed"
      ? "Verdict: REGRESSED — do not merge"
      : comparison.verdict === "improved"
        ? "Verdict: improved"
        : "Verdict: unchanged";
  return [
    `### Backtest comparison — \`${comparison.ruleId}\``,
    "",
    "**Regressed**",
    "",
    ...axisLines(comparison.regressedAxes),
    "",
    "**Improved**",
    "",
    ...axisLines(comparison.improvedAxes),
    "",
    verdictLine,
  ].join("\n");
}
