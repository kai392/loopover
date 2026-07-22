import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built artifact for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / miner-deny-hook-synthesis.test.ts.
import { splitBacktestCorpus } from "../../packages/loopover-engine/src/calibration/backtest-split";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

function corpusCase(targetKey: string): BacktestCase {
  return {
    ruleId: "missing_linked_issue",
    targetKey,
    outcome: "block",
    label: "confirmed",
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
  };
}

// A dozen distinct targets -- enough that a 0.5 split reliably populates BOTH buckets and two different
// seeds reliably disagree on at least one case, without depending on any specific hash value.
const corpus = Array.from({ length: 12 }, (_, index) => corpusCase(`acme/widgets#${index + 1}`));

describe("splitBacktestCorpus (#8087)", () => {
  it("keeps every case visible at fraction 0 and holds every case out at fraction 1", () => {
    expect(splitBacktestCorpus(corpus, 0, "seed-a")).toEqual({ visible: corpus, heldOut: [] });
    expect(splitBacktestCorpus(corpus, 1, "seed-a")).toEqual({ visible: [], heldOut: corpus });
  });

  it("is deterministic: identical inputs produce byte-identical output, including per-bucket order", () => {
    const first = splitBacktestCorpus(corpus, 0.5, "seed-a");
    expect(splitBacktestCorpus(corpus, 0.5, "seed-a")).toEqual(first);
  });

  it("preserves original input order within each bucket, with both buckets populated at 0.5", () => {
    const { visible, heldOut } = splitBacktestCorpus(corpus, 0.5, "seed-a");
    expect(visible.length).toBeGreaterThan(0);
    expect(heldOut.length).toBeGreaterThan(0);
    for (const bucket of [visible, heldOut]) {
      const order = bucket.map((backtestCase) => corpus.indexOf(backtestCase));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("produces a different split for at least one case when only the seed changes", () => {
    const withSeedA = splitBacktestCorpus(corpus, 0.5, "seed-a");
    const withSeedB = splitBacktestCorpus(corpus, 0.5, "seed-b");
    expect(withSeedB.heldOut.map((c) => c.targetKey)).not.toEqual(withSeedA.heldOut.map((c) => c.targetKey));
  });

  it("throws on an out-of-range heldOutFraction in both directions, naming the invalid value", () => {
    expect(() => splitBacktestCorpus(corpus, -0.1, "seed-a")).toThrow("invalid_held_out_fraction: -0.1");
    expect(() => splitBacktestCorpus(corpus, 1.5, "seed-a")).toThrow("invalid_held_out_fraction: 1.5");
  });
});
