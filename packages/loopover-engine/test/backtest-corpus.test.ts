import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBacktestCorpus, type HumanOverrideEvent, type RuleFiredEvent } from "../dist/index.js";

function fired(ruleId: string, targetKey: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId, targetKey, outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

function override(
  ruleId: string,
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  overrides: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId, targetKey, verdict, occurredAt: "2026-07-22T01:00:00.000Z", ...overrides };
}

test("barrel: the public entrypoint re-exports the backtest-corpus builder (#8083)", () => {
  assert.equal(typeof buildBacktestCorpus, "function");
});

test("buildBacktestCorpus: empty inputs produce an empty corpus", () => {
  assert.deepEqual(buildBacktestCorpus("missing_linked_issue", [], []), []);
});

test("buildBacktestCorpus: a fired event with no matching override is excluded, not emitted unlabeled", () => {
  const cases = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1"), fired("missing_linked_issue", "a#2")],
    [override("missing_linked_issue", "a#2", "confirmed")],
  );
  assert.deepEqual(cases, [
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

test("buildBacktestCorpus: a single fired+override pair produces one correctly-labeled case, carrying the fired event's metadata", () => {
  const cases = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1", { outcome: "exclude", metadata: { repo: "acme/widgets" } })],
    [override("missing_linked_issue", "a#1", "reversed")],
  );
  assert.deepEqual(cases, [
    {
      ruleId: "missing_linked_issue",
      targetKey: "a#1",
      outcome: "exclude",
      label: "reversed",
      firedAt: "2026-07-22T00:00:00.000Z",
      decidedAt: "2026-07-22T01:00:00.000Z",
      metadata: { repo: "acme/widgets" },
    },
  ]);
});

test("buildBacktestCorpus: metadata is omitted entirely (not set to undefined) when the fired event has none", () => {
  const [firstCase] = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1")],
    [override("missing_linked_issue", "a#1", "confirmed")],
  );
  assert.equal(Object.hasOwn(firstCase!, "metadata"), false);
});

test("buildBacktestCorpus: multiple overrides pair each fired event with the nearest strictly-following one", () => {
  const cases = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1", { occurredAt: "2026-07-22T02:00:00.000Z" })],
    [
      // Before the firing -- never "following", must lose to the 03:00 verdict even though it's listed first.
      override("missing_linked_issue", "a#1", "confirmed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
      // Two strictly-following verdicts: 03:00 is closer to the 02:00 firing than 05:00.
      override("missing_linked_issue", "a#1", "reversed", { occurredAt: "2026-07-22T05:00:00.000Z" }),
      override("missing_linked_issue", "a#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
    ],
  );
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.label, "confirmed");
  assert.equal(cases[0]!.decidedAt, "2026-07-22T03:00:00.000Z");
});

test("buildBacktestCorpus: falls back to the most recent override when none strictly follows the firing", () => {
  const cases = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1", { occurredAt: "2026-07-22T09:00:00.000Z" })],
    [
      override("missing_linked_issue", "a#1", "confirmed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
      override("missing_linked_issue", "a#1", "reversed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
    ],
  );
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.label, "reversed");
  assert.equal(cases[0]!.decidedAt, "2026-07-22T03:00:00.000Z");
});

test("buildBacktestCorpus: two firings of one target each pair with their own nearest verdict -- one case per fired event, no duplicates", () => {
  const cases = buildBacktestCorpus(
    "missing_linked_issue",
    [
      fired("missing_linked_issue", "a#1", { occurredAt: "2026-07-22T00:00:00.000Z" }),
      fired("missing_linked_issue", "a#1", { occurredAt: "2026-07-22T04:00:00.000Z" }),
    ],
    [
      override("missing_linked_issue", "a#1", "reversed", { occurredAt: "2026-07-22T02:00:00.000Z" }),
      override("missing_linked_issue", "a#1", "confirmed", { occurredAt: "2026-07-22T06:00:00.000Z" }),
    ],
  );
  assert.equal(cases.length, 2);
  assert.deepEqual(
    cases.map((c) => [c.firedAt, c.label, c.decidedAt]),
    [
      ["2026-07-22T00:00:00.000Z", "reversed", "2026-07-22T02:00:00.000Z"],
      ["2026-07-22T04:00:00.000Z", "confirmed", "2026-07-22T06:00:00.000Z"],
    ],
  );
});

test("buildBacktestCorpus: fired events and overrides for a different ruleId are ignored on both sides", () => {
  const cases = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("other_rule", "a#1"), fired("missing_linked_issue", "a#1")],
    [
      override("other_rule", "a#1", "reversed", { occurredAt: "2026-07-22T02:00:00.000Z" }),
      override("missing_linked_issue", "a#1", "confirmed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
    ],
  );
  assert.deepEqual(
    cases.map((c) => [c.ruleId, c.label]),
    [["missing_linked_issue", "confirmed"]],
  );
});
