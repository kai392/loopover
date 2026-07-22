import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist the @loopover/engine specifier resolves to), the same
// way miner-deny-hook-synthesis.test.ts imports the engine's normalizeRepoFullName -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace suite).
import {
  buildBacktestCorpus,
  type BacktestCase,
} from "../../packages/loopover-engine/src/calibration/backtest-corpus";
import type { HumanOverrideEvent, RuleFiredEvent } from "../../packages/loopover-engine/src/calibration/signal-tracking";

function fired(targetKey: string, occurredAt: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId: "missing_linked_issue", targetKey, outcome: "block", occurredAt, ...overrides };
}

function judged(
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  occurredAt: string,
  overrides: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId: "missing_linked_issue", targetKey, verdict, occurredAt, ...overrides };
}

describe("buildBacktestCorpus (#8083)", () => {
  it("returns an empty corpus for empty inputs", () => {
    expect(buildBacktestCorpus("missing_linked_issue", [], [])).toEqual([]);
  });

  it("excludes a fired event with no matching override instead of emitting an unlabeled case", () => {
    const cases = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T00:00:00.000Z"), fired("a#2", "2026-07-22T00:00:00.000Z")],
      [judged("a#2", "confirmed", "2026-07-22T01:00:00.000Z")],
    );
    expect(cases).toEqual([
      {
        ruleId: "missing_linked_issue",
        targetKey: "a#2",
        outcome: "block",
        label: "confirmed",
        firedAt: "2026-07-22T00:00:00.000Z",
        decidedAt: "2026-07-22T01:00:00.000Z",
      },
    ]);
  });

  it("carries the fired event's metadata through, and omits the property entirely when absent", () => {
    const withMetadata = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T00:00:00.000Z", { outcome: "exclude", metadata: { repo: "acme/widgets" } })],
      [judged("a#1", "reversed", "2026-07-22T01:00:00.000Z")],
    );
    expect(withMetadata[0]).toEqual({
      ruleId: "missing_linked_issue",
      targetKey: "a#1",
      outcome: "exclude",
      label: "reversed",
      firedAt: "2026-07-22T00:00:00.000Z",
      decidedAt: "2026-07-22T01:00:00.000Z",
      metadata: { repo: "acme/widgets" },
    });

    const withoutMetadata = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T00:00:00.000Z")],
      [judged("a#1", "confirmed", "2026-07-22T01:00:00.000Z")],
    ) as [BacktestCase];
    expect(Object.hasOwn(withoutMetadata[0], "metadata")).toBe(false);
  });

  it("pairs each fired event with the nearest strictly-following override, whatever the input order", () => {
    // Descending-listed candidates: the later 05:00 verdict is seen first and must be displaced by 03:00.
    const nearestListedLast = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T02:00:00.000Z")],
      [
        judged("a#1", "confirmed", "2026-07-22T01:00:00.000Z"), // before the firing -- never "following"
        judged("a#1", "reversed", "2026-07-22T05:00:00.000Z"),
        judged("a#1", "confirmed", "2026-07-22T03:00:00.000Z"),
      ],
    );
    expect(nearestListedLast).toHaveLength(1);
    expect(nearestListedLast[0]).toMatchObject({ label: "confirmed", decidedAt: "2026-07-22T03:00:00.000Z" });

    // Ascending-listed candidates: 03:00 is seen first and the later 05:00 must NOT displace it.
    const nearestListedFirst = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T02:00:00.000Z")],
      [
        judged("a#1", "confirmed", "2026-07-22T03:00:00.000Z"),
        judged("a#1", "reversed", "2026-07-22T05:00:00.000Z"),
      ],
    );
    expect(nearestListedFirst).toHaveLength(1);
    expect(nearestListedFirst[0]).toMatchObject({ label: "confirmed", decidedAt: "2026-07-22T03:00:00.000Z" });
  });

  it("falls back to the most recent override when none strictly follows the firing", () => {
    const cases = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T09:00:00.000Z")],
      [
        judged("a#1", "confirmed", "2026-07-22T01:00:00.000Z"),
        judged("a#1", "reversed", "2026-07-22T03:00:00.000Z"),
      ],
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ label: "reversed", decidedAt: "2026-07-22T03:00:00.000Z" });
  });

  it("emits exactly one case per fired event when a target is re-fired and re-judged -- no duplicates", () => {
    const cases = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T00:00:00.000Z"), fired("a#1", "2026-07-22T04:00:00.000Z")],
      [
        judged("a#1", "reversed", "2026-07-22T02:00:00.000Z"),
        judged("a#1", "confirmed", "2026-07-22T06:00:00.000Z"),
      ],
    );
    expect(cases.map((c) => [c.firedAt, c.label, c.decidedAt])).toEqual([
      ["2026-07-22T00:00:00.000Z", "reversed", "2026-07-22T02:00:00.000Z"],
      ["2026-07-22T04:00:00.000Z", "confirmed", "2026-07-22T06:00:00.000Z"],
    ]);
  });

  it("ignores fired events and overrides for a different ruleId on both sides", () => {
    const cases = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("a#1", "2026-07-22T00:00:00.000Z", { ruleId: "other_rule" }), fired("a#1", "2026-07-22T00:00:00.000Z")],
      [
        judged("a#1", "reversed", "2026-07-22T02:00:00.000Z", { ruleId: "other_rule" }),
        judged("a#1", "confirmed", "2026-07-22T01:00:00.000Z"),
      ],
    );
    expect(cases.map((c) => [c.ruleId, c.label])).toEqual([["missing_linked_issue", "confirmed"]]);
  });
});
