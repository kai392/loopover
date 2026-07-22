// Deterministic held-out/visible corpus split (#8087) -- the dual-target evaluation method: iterate a
// candidate rule against the visible slice, score it against BOTH slices, so a fix can't be hand-tuned to
// just the specific incidents already known about. Reuses the same content-hash approach as
// stableProposalId in ../miner/deny-hook-synthesis.ts (sha256 over a composite key): a case's assignment
// depends only on (seed, ruleId, targetKey) -- never on its position or on cases.length -- so a corpus
// that grows over time never reshuffles which already-processed cases were previously held out.
//
// Same purity contract as the rest of this module family: no IO, no Math.random(), no wall-clock reads.

import { createHash } from "node:crypto";
import type { BacktestCase } from "./backtest-corpus.js";

/**
 * Partition `cases` into a visible slice and a held-out slice of roughly `heldOutFraction` of the corpus.
 * Deterministic: sha256(`${seed}:${ruleId}:${targetKey}`), first 8 hex chars as a base-16 integer over
 * 0xffffffff, held out when strictly below `heldOutFraction` -- identical inputs always produce
 * byte-identical output. Each case keeps its original input-order position within its assigned bucket
 * (no sorting, no shuffling). Throws when `heldOutFraction` is outside the inclusive [0, 1] range.
 */
export function splitBacktestCorpus(
  cases: readonly BacktestCase[],
  heldOutFraction: number,
  seed: string,
): { visible: BacktestCase[]; heldOut: BacktestCase[] } {
  // Negated compound form so a NaN fraction also fails closed instead of silently splitting nothing out.
  if (!(heldOutFraction >= 0 && heldOutFraction <= 1)) {
    throw new Error(`invalid_held_out_fraction: ${heldOutFraction}`);
  }
  const visible: BacktestCase[] = [];
  const heldOut: BacktestCase[] = [];
  for (const backtestCase of cases) {
    const digest = createHash("sha256")
      .update(`${seed}:${backtestCase.ruleId}:${backtestCase.targetKey}`)
      .digest("hex");
    const value = parseInt(digest.slice(0, 8), 16) / 0xffffffff;
    if (value < heldOutFraction) heldOut.push(backtestCase);
    else visible.push(backtestCase);
  }
  return { visible, heldOut };
}
