#!/usr/bin/env node
// Read-only ORB D1 → REGRESSED-verdict track-record summary (#8140, epic #8082). Queries the
// `calibration.threshold_backtest_run` audit_events rows persisted per CI run by
// src/services/threshold-backtest-run.ts (#8138) via `wrangler d1 execute --json` (no writes), extracts each
// run's persisted BacktestComparison, runs computeRegressedVerdictTrackRecord, and prints the summary #8105's
// Phase-2 merge-gating decision needs. The pure pieces live in @loopover/engine (aggregation) and
// backtest-track-record-core.ts (row extraction, unit-tested); this file is the thin IO wrapper — mirrors
// backtest-corpus-export.ts / export-d1-data.ts.
//
//   tsx scripts/backtest-track-record.ts [--remote] [--since-date <iso>] [--db loopover]
//
// --remote reads the deployed D1 (default is the local miniflare DB). --since-date scopes to rows whose
// created_at is >= the date; omit it for the full history. NEVER pass a write command.
import { spawnSync } from "node:child_process";
import { computeRegressedVerdictTrackRecord } from "@loopover/engine";
import { comparisonsFromAuditMetadataRows } from "./backtest-track-record-core.js";

type D1Row = Record<string, unknown>;

type Args = {
  remote: boolean;
  sinceDate: string | undefined;
  db: string;
};

const THRESHOLD_BACKTEST_EVENT_TYPE = "calibration.threshold_backtest_run"; // keep in sync with threshold-backtest-run.ts

function parseArgs(argv: string[]): Args {
  const args: Args = { remote: false, sinceDate: undefined, db: "loopover" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--since-date") args.sinceDate = argv[++i];
    else if (flag === "--db") args.db = argv[++i]!;
  }
  return args;
}

// Run a read-only SQL statement via wrangler and return the result rows. Throws on any wrangler failure so a
// partial/garbled read can never be mistaken for a complete history. Mirrors backtest-corpus-export.ts's d1Query.
function d1Query(db: string, remote: boolean, sql: string): D1Row[] {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  const parsed = JSON.parse(result.stdout);
  // wrangler returns [{ results: [...], success, meta }] (one entry per statement).
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const sinceClause = args.sinceDate ? ` AND created_at >= ${sqlStringLiteral(args.sinceDate)}` : "";
  const rows = d1Query(
    args.db,
    args.remote,
    `SELECT metadata_json FROM audit_events WHERE event_type = ${sqlStringLiteral(THRESHOLD_BACKTEST_EVENT_TYPE)}${sinceClause} ORDER BY created_at ASC`,
  );
  const record = computeRegressedVerdictTrackRecord(comparisonsFromAuditMetadataRows(rows));
  console.log(`Backtest runs: ${record.totalRuns}`);
  console.log(`REGRESSED verdicts: ${record.regressedRuns} (rate: ${record.regressedRate === null ? "N/A" : record.regressedRate.toFixed(3)})`);
  console.log("Per rule:");
  for (const [ruleId, breakdown] of record.perRule) {
    console.log(`  ${ruleId}: total=${breakdown.total} regressed=${breakdown.regressed} improved=${breakdown.improved} unchanged=${breakdown.unchanged}`);
  }
}

main();
