// Pure row→comparison extraction for the #8140 track-record CLI. Split from the thin IO wrapper
// (backtest-track-record.ts) so every branch here is unit-testable — the same pure-core/thin-IO split
// backtest-corpus-export-core.ts / export-d1-core.ts already established for this epic's other CLI.
//
// Rows come from `audit_events` rows persisted by src/services/threshold-backtest-run.ts's
// persistThresholdBacktestRuns (#8138, event type `calibration.threshold_backtest_run`), whose metadata is
// `{ comparison: BacktestComparison, constantName: string }`. A corrupt/foreign row fails open to "skipped"
// (mirrors listAuditEventsByType's own corrupt-metadata posture) rather than aborting the whole summary.

import type { BacktestComparison } from "@loopover/engine";

type MetadataRow = { metadata_json?: unknown };

function parseMetadataJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* corrupt row -- fail open to {} (mirrors backtest-corpus-export.ts's own parseMetadataJson) */
  }
  return {};
}

function isBacktestComparison(value: unknown): value is BacktestComparison {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ruleId === "string" &&
    (candidate.verdict === "improved" || candidate.verdict === "regressed" || candidate.verdict === "unchanged")
  );
}

/** Extract every persisted {@link BacktestComparison} from raw `audit_events` metadata rows, skipping any
 *  corrupt or foreign-shaped row rather than throwing — a summary over a long history must survive one bad
 *  row. Preserves row order, so a `created_at ASC` query yields a chronologically-ordered history. */
export function comparisonsFromAuditMetadataRows(rows: readonly MetadataRow[]): BacktestComparison[] {
  const comparisons: BacktestComparison[] = [];
  for (const row of rows) {
    const comparison = parseMetadataJson(row.metadata_json).comparison;
    if (isBacktestComparison(comparison)) comparisons.push(comparison);
  }
  return comparisons;
}
