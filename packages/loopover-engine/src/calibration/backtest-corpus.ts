// Backtest corpus builder (#8083) -- turns signal-tracking's raw fired/override event streams into a list of
// concrete labeled cases ("this rule fired against this target, and a human later said it was right/wrong"),
// replayable against a different candidate rule/classifier later (the parent calibration epic's backtest
// premise). computeRulePrecision (signal-tracking.ts) aggregates the same pairing into one precision number;
// this module keeps each PAIRED case as an individual record instead, which is what a backtest needs.
//
// Same purity contract as signal-tracking.ts itself: no IO, no DB, no env -- only the existing event types.

import type { HumanOverrideEvent, RuleFiredEvent } from "./signal-tracking.js";

/** One labeled backtest case: a specific rule firing plus the human verdict that later judged it. `outcome`
 *  is the fired event's own outcome; `label` is the override's verdict; `metadata` is the fired event's
 *  metadata, omitted entirely (not set to `undefined`) when the fired event has none -- the same
 *  optional-property discipline {@link RuleFiredEvent} itself already uses. */
export type BacktestCase = {
  ruleId: string;
  targetKey: string;
  outcome: string;
  label: "reversed" | "confirmed";
  firedAt: string;
  decidedAt: string;
  metadata?: Record<string, unknown>;
};

/**
 * Pick the override that judges `fired`: the one whose `occurredAt` is closest in time AFTER the fired
 * event's own `occurredAt` (a verdict normally follows the firing it judges); when none strictly follows
 * (e.g. the target was re-fired after its last judgment), fall back to the most recent override overall.
 * Ties on `occurredAt` keep the earliest-listed candidate, so the choice is deterministic for a stable
 * input order.
 */
function pickPairedOverride(fired: RuleFiredEvent, candidates: readonly HumanOverrideEvent[]): HumanOverrideEvent {
  const firedAtMs = Date.parse(fired.occurredAt);
  let following: HumanOverrideEvent | null = null;
  let followingMs = Number.POSITIVE_INFINITY;
  let latest = candidates[0]!;
  let latestMs = Date.parse(latest.occurredAt);
  for (const candidate of candidates) {
    const candidateMs = Date.parse(candidate.occurredAt);
    if (candidateMs > firedAtMs && candidateMs < followingMs) {
      following = candidate;
      followingMs = candidateMs;
    }
    if (candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return following ?? latest;
}

/**
 * Build the labeled backtest corpus for `ruleId` from its fired + override events. Mirrors
 * computeRulePrecision's (signal-tracking.ts) "only the decided ones count" discipline: a fired event with no matching
 * override is EXCLUDED from the result (not included as an unlabeled case). Pairing rule: a fired event and
 * an override pair when both carry the function's `ruleId` AND the same `targetKey`; when a target has
 * multiple overrides for the rule (re-fired and re-judged more than once), each fired event pairs with the
 * override whose `occurredAt` is closest in time after that specific fired event's `occurredAt`, falling
 * back to the most recent override when none strictly follows it -- one case per fired event, never
 * duplicates. Cases keep the fired events' input order.
 */
export function buildBacktestCorpus(
  ruleId: string,
  fired: readonly RuleFiredEvent[],
  overrides: readonly HumanOverrideEvent[],
): BacktestCase[] {
  // Mirrors overrideMatchesRule's one-line `event.ruleId === ruleId` filter in signal-tracking.ts (that
  // helper is deliberately not exported -- this module is additive-only, so the filter is restated here).
  const ruleOverrides = overrides.filter((event) => event.ruleId === ruleId);
  const cases: BacktestCase[] = [];
  for (const event of fired) {
    if (event.ruleId !== ruleId) continue;
    const candidates = ruleOverrides.filter((override) => override.targetKey === event.targetKey);
    if (candidates.length === 0) continue;
    const override = pickPairedOverride(event, candidates);
    cases.push({
      ruleId,
      targetKey: event.targetKey,
      outcome: event.outcome,
      label: override.verdict,
      firedAt: event.occurredAt,
      decidedAt: override.occurredAt,
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
    });
  }
  return cases;
}
