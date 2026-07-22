import assert from "node:assert/strict";
import { test } from "node:test";

import type { BacktestCase } from "../dist/index.js";
import { splitBacktestCorpus } from "../dist/calibration/backtest-split.js";

function corpusCase(targetKey: string, overrides: Partial<BacktestCase> = {}): BacktestCase {
  return {
    ruleId: "missing_linked_issue",
    targetKey,
    outcome: "block",
    label: "confirmed",
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
    ...overrides,
  };
}

/** A dozen distinct targets -- enough that a 0.5 split reliably lands cases in BOTH buckets and that two
 *  different seeds reliably disagree on at least one case, without depending on any specific hash value. */
const corpus = Array.from({ length: 12 }, (_, index) => corpusCase(`acme/widgets#${index + 1}`));

test("splitBacktestCorpus: heldOutFraction 0 keeps every case visible", () => {
  const { visible, heldOut } = splitBacktestCorpus(corpus, 0, "seed-a");
  assert.deepEqual(visible, corpus);
  assert.deepEqual(heldOut, []);
});

test("splitBacktestCorpus: heldOutFraction 1 holds every case out", () => {
  const { visible, heldOut } = splitBacktestCorpus(corpus, 1, "seed-a");
  assert.deepEqual(heldOut, corpus);
  assert.deepEqual(visible, []);
});

test("splitBacktestCorpus: identical inputs produce byte-identical output, including per-bucket order", () => {
  const first = splitBacktestCorpus(corpus, 0.5, "seed-a");
  const second = splitBacktestCorpus(corpus, 0.5, "seed-a");
  assert.deepEqual(second, first);
});

test("splitBacktestCorpus: preserves each case's original input order within its bucket, with both buckets populated", () => {
  const { visible, heldOut } = splitBacktestCorpus(corpus, 0.5, "seed-a");
  assert.ok(visible.length > 0 && heldOut.length > 0, "0.5 over 12 distinct targets must populate both buckets");
  const inputIndex = (backtestCase: BacktestCase) => corpus.indexOf(backtestCase);
  for (const bucket of [visible, heldOut]) {
    const order = bucket.map(inputIndex);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  }
});

test("splitBacktestCorpus: a different seed produces a different split for at least one case", () => {
  const first = splitBacktestCorpus(corpus, 0.5, "seed-a");
  const second = splitBacktestCorpus(corpus, 0.5, "seed-b");
  assert.notDeepEqual(
    { visible: first.visible.map((c) => c.targetKey), heldOut: first.heldOut.map((c) => c.targetKey) },
    { visible: second.visible.map((c) => c.targetKey), heldOut: second.heldOut.map((c) => c.targetKey) },
  );
});

test("splitBacktestCorpus: throws on an out-of-range heldOutFraction in both directions, naming the value", () => {
  assert.throws(() => splitBacktestCorpus(corpus, -0.1, "seed-a"), /invalid_held_out_fraction: -0\.1/);
  assert.throws(() => splitBacktestCorpus(corpus, 1.5, "seed-a"), /invalid_held_out_fraction: 1\.5/);
});
