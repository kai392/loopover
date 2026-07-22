// ORB adapter for @loopover/engine's shared signal-tracking primitive (#7982). WRAPS the existing audit_events
// store (via recordAuditEvent/listAuditEventsByType, db/repositories.ts) — this file intentionally contains no
// new schema, no new table, and no gate-decision logic of its own. It does NOT replace outcomes-wire.ts's
// pr_outcome/reversal system; that stays the ground-truth source for ORB's existing merge/close precision
// breaker (auto-tune.ts). This adapter exists so a NEW rule-level signal (starting with #7983/#7984/#7986) can
// be recorded the same way AMS's own adapter (packages/loopover-miner/lib/signal-tracking-store.ts) records
// its eligibility/policy calls, without either side reinventing storage.
//
// Event-type encoding: `ruleId` is folded directly into audit_events.event_type (`signal.rule_fired:<ruleId>`,
// `signal.human_override:<ruleId>`) rather than left in metadata — audit_events already carries a
// (event_type, created_at) index, so a per-rule history query stays an efficient index range scan instead of a
// metadata JSON scan. The rest of the event (target, domain-specific outcome/verdict, extra metadata) lives in
// metadataJson, read back via listAuditEventsByType.

import type { HumanOverrideEvent, RuleFiredEvent, SignalStore } from "@loopover/engine";

import { listAuditEventsByType, recordAuditEvent } from "../db/repositories";
import { REVIEW_THREAD_BLOCKER_CODE } from "./review-thread-findings";
import { CLA_CONSENT_MISSING_CODE } from "./cla-check";
import { AI_JUDGMENT_BLOCKER_CODES } from "../rules/advisory";
import type { GateCheckEvaluation } from "../rules/advisory";
import { nowIso } from "../utils/json";

const RULE_FIRED_EVENT_TYPE_PREFIX = "signal.rule_fired:";
const HUMAN_OVERRIDE_EVENT_TYPE_PREFIX = "signal.human_override:";

function ruleFiredEventType(ruleId: string): string {
  return `${RULE_FIRED_EVENT_TYPE_PREFIX}${ruleId}`;
}

function humanOverrideEventType(ruleId: string): string {
  return `${HUMAN_OVERRIDE_EVENT_TYPE_PREFIX}${ruleId}`;
}

/** Reconstruct a {@link RuleFiredEvent} from an `audit_events` row written by {@link createSignalStore}'s
 *  `recordRuleFired`. `ruleId` comes from the CALLER (the query was already scoped to one rule's event_type),
 *  not re-parsed from the row — mirrors how the row itself never duplicates it into metadata. A row with a
 *  missing/non-string `outcome` in its metadata (should never happen — see the doc comment on
 *  {@link listAuditEventsByType}) degrades to an empty string rather than throwing, keeping a report over a
 *  large window resilient to one bad row. */
function toRuleFiredEvent(ruleId: string, row: { targetKey: string | null; metadata: Record<string, unknown>; createdAt: string }): RuleFiredEvent {
  const outcome = typeof row.metadata.outcome === "string" ? row.metadata.outcome : "";
  const extraMetadata = { ...row.metadata };
  delete extraMetadata.outcome;
  return {
    ruleId,
    targetKey: row.targetKey ?? "",
    outcome,
    occurredAt: row.createdAt,
    ...(Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : {}),
  };
}

/** Reconstruct a {@link HumanOverrideEvent}, the override-side mirror of {@link toRuleFiredEvent}. A row whose
 *  metadata `verdict` isn't exactly `"reversed"`/`"confirmed"` degrades to `"confirmed"` (fail toward NOT
 *  inflating the reversal count on corrupt data) rather than throwing. */
function toHumanOverrideEvent(ruleId: string, row: { targetKey: string | null; metadata: Record<string, unknown>; createdAt: string }): HumanOverrideEvent {
  const verdict = row.metadata.verdict === "reversed" ? "reversed" : "confirmed";
  const extraMetadata = { ...row.metadata };
  delete extraMetadata.verdict;
  return {
    ruleId,
    targetKey: row.targetKey ?? "",
    verdict,
    occurredAt: row.createdAt,
    ...(Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : {}),
  };
}

/** Live, D1/Postgres-backed {@link SignalStore} for ORB. Every write is best-effort (`.catch(() => undefined)`,
 *  matching every other audit-event write in this codebase, e.g. outcomes-wire.ts's `recordAuditEvent` calls) —
 *  a failure to record a signal must never fail the review pass that produced it. Reads (`queryRuleHistory`)
 *  are NOT fail-open the same way: a read error propagates, since a caller computing a precision report needs
 *  to know its input is incomplete rather than silently scoring against a partial (possibly empty) history.
 */
export function createSignalStore(env: Env): SignalStore {
  return {
    async recordRuleFired(event: RuleFiredEvent): Promise<void> {
      await recordAuditEvent(env, {
        eventType: ruleFiredEventType(event.ruleId),
        actor: "loopover",
        targetKey: event.targetKey,
        outcome: "completed",
        detail: `rule ${event.ruleId} fired (${event.outcome}) against ${event.targetKey}`,
        metadata: { outcome: event.outcome, ...(event.metadata ?? {}) },
        createdAt: event.occurredAt || nowIso(),
      }).catch(() => undefined);
    },
    async recordHumanOverride(event: HumanOverrideEvent): Promise<void> {
      await recordAuditEvent(env, {
        eventType: humanOverrideEventType(event.ruleId),
        actor: "human",
        targetKey: event.targetKey,
        outcome: "completed",
        detail: `human ${event.verdict} rule ${event.ruleId} against ${event.targetKey}`,
        metadata: { verdict: event.verdict, ...(event.metadata ?? {}) },
        createdAt: event.occurredAt || nowIso(),
      }).catch(() => undefined);
    },
    async queryRuleHistory(ruleId: string, sinceMs: number): Promise<{ fired: RuleFiredEvent[]; overrides: HumanOverrideEvent[] }> {
      const sinceIso = new Date(sinceMs).toISOString();
      const [firedRows, overrideRows] = await Promise.all([
        listAuditEventsByType(env, ruleFiredEventType(ruleId), sinceIso),
        listAuditEventsByType(env, humanOverrideEventType(ruleId), sinceIso),
      ]);
      return {
        fired: firedRows.map((row) => toRuleFiredEvent(ruleId, row)),
        overrides: overrideRows.map((row) => toHumanOverrideEvent(ruleId, row)),
      };
    },
  };
}

/** Every finding code `isConfiguredGateBlocker` (src/rules/advisory.ts) recognizes as gate-authority-bearing
 *  (#8104) — composed from the SAME exported constants that function's own body checks
 *  (`AI_JUDGMENT_BLOCKER_CODES`, `REVIEW_THREAD_BLOCKER_CODE`, `CLA_CONSENT_MISSING_CODE`) plus its literal
 *  codes, so this list tracks that function rather than a second hand-maintained vocabulary. Includes
 *  `linked_issue_scope_mismatch`: the reversal sweep below covers the FULL list (one shared loop, per #8104's
 *  own instruction to fold #8101's single-code check into it), while the fired-recording helper excludes that
 *  one code because #8101 already records its firings at its own upstream push site
 *  (runLinkedIssueSatisfactionForAdvisory) — recording it here too would double-count. */
export const GATE_BLOCKER_SIGNAL_RULE_IDS: readonly string[] = [
  ...AI_JUDGMENT_BLOCKER_CODES,
  REVIEW_THREAD_BLOCKER_CODE,
  CLA_CONSENT_MISSING_CODE,
  "missing_linked_issue",
  "duplicate_pr_risk",
  "secret_leak",
  "pre_merge_check_required",
  "manifest_missing_tests",
  "manifest_linked_issue_required",
  "self_authored_linked_issue",
  "content_lane_deliverable_missing",
  "lockfile_tamper_risk",
  "linked_issue_scope_mismatch",
];

/**
 * Record a {@link RuleFiredEvent} for every configured gate blocker in `evaluation` (#8104) — the generic
 * counterpart of #8101's site-specific `linked_issue_scope_mismatch` hook, called from the gate-CONCLUSION
 * computation (the one place every `isConfiguredGateBlocker` code becomes a real, gate-authority-bearing
 * decision). Filtered by {@link GATE_BLOCKER_SIGNAL_RULE_IDS}, so the synthesized slop blocker and any
 * surface-lane code never record; `linked_issue_scope_mismatch` is excluded here because #8101 already
 * records it at its own push site — recording twice would double-count its fired history. Best-effort per
 * finding (SignalStore's own never-fail-the-review contract): a recording failure must never affect the gate
 * decision, and one finding's failure never skips the rest. A skipped/undefined evaluation records nothing.
 */
export async function recordConfiguredGateBlockerFirings(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  evaluation: GateCheckEvaluation | undefined,
): Promise<void> {
  if (!evaluation) return;
  const store = createSignalStore(env);
  for (const finding of evaluation.blockers) {
    if (finding.code === "linked_issue_scope_mismatch") continue;
    if (!GATE_BLOCKER_SIGNAL_RULE_IDS.includes(finding.code)) continue;
    await store
      .recordRuleFired({
        ruleId: finding.code,
        targetKey: `${repoFullName}#${pullNumber}`,
        // Defensive: `severity` is required on AdvisoryFinding, but a hand-built/legacy finding without one
        // must still record a usable outcome rather than the string "undefined".
        outcome: finding.severity ?? "blocker",
        occurredAt: nowIso(),
        ...(finding.confidence !== undefined ? { metadata: { confidence: finding.confidence } } : {}),
      })
      .catch(() => undefined);
  }
}
