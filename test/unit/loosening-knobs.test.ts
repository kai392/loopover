import { describe, expect, it } from "vitest";
import { splitBacktestCorpus, type BacktestCase } from "@loopover/engine";
import { evaluateKnobDrift, evaluateKnobLoosening, LOOSENABLE_KNOBS, type LoosenableKnob } from "../../src/services/loosening-knobs";
import {
  SATISFACTION_FLOOR_HARD_MINIMUM,
  SATISFACTION_FLOOR_HELD_OUT_FRACTION,
  SATISFACTION_FLOOR_LOOSENING_CANDIDATES,
  SATISFACTION_FLOOR_MIN_HELD_OUT_CASES,
  SATISFACTION_FLOOR_MIN_VISIBLE_CASES,
  SATISFACTION_FLOOR_RULE_ID,
  SATISFACTION_FLOOR_SPLIT_SEED,
} from "../../src/services/satisfaction-floor-loosening";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "../../src/services/linked-issue-satisfaction";
import { DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE } from "../../src/rules/advisory";
import { buildReportOnlyKnobRecs } from "../../src/review/loosening-recs";

const AI_KNOB = LOOSENABLE_KNOBS.ai_review_close_confidence!;

describe("LOOSENABLE_KNOBS registry invariants (#8159)", () => {
  it("pins the satisfaction knob to the #8121 narrow start's exact values and seed — behavior and held-out membership stay byte-stable", () => {
    expect(LOOSENABLE_KNOBS.satisfaction_floor).toEqual({
      knobId: "satisfaction_floor",
      ruleId: SATISFACTION_FLOOR_RULE_ID,
      shippedValue: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
      candidates: SATISFACTION_FLOOR_LOOSENING_CANDIDATES,
      hardMinimum: SATISFACTION_FLOOR_HARD_MINIMUM,
      minVisibleCases: SATISFACTION_FLOOR_MIN_VISIBLE_CASES,
      minHeldOutCases: SATISFACTION_FLOOR_MIN_HELD_OUT_CASES,
      heldOutFraction: SATISFACTION_FLOOR_HELD_OUT_FRACTION,
      splitSeed: SATISFACTION_FLOOR_SPLIT_SEED,
      applyMode: "live",
      // #8176's apply plumbing — pinned to the legacy run module's constants by knob-loosening-run.test.ts.
      overrideFlagKey: "satisfaction_floor_override",
      looseningEventType: "calibration.satisfaction_floor_loosened",
      autotuneEnvVar: "SATISFACTION_FLOOR_AUTOTUNE_ENABLED",
    });
  });

  it("pins the close-confidence knob to the shipped default, tight bounds, and its LIVE apply plumbing (#8176)", () => {
    expect(AI_KNOB.shippedValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(AI_KNOB.ruleId).toBe("ai_consensus_defect");
    expect(AI_KNOB.applyMode).toBe("live"); // flipped by #8176 — the override consumer ships with it
    expect(AI_KNOB.hardMinimum).toBe(0.85);
    expect(AI_KNOB.overrideFlagKey).toBe("ai_review_close_confidence_override");
    expect(AI_KNOB.looseningEventType).toBe("calibration.ai_review_close_confidence_loosened");
    expect(AI_KNOB.autotuneEnvVar).toBe("AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED");
  });

  it("every entry satisfies the structural safety invariants: candidates strictly below shipped, at/above the hard minimum, descending; ids and seeds unique", () => {
    const knobs = Object.values(LOOSENABLE_KNOBS);
    for (const knob of knobs) {
      expect(knob.candidates.length).toBeGreaterThan(0);
      for (const candidate of knob.candidates) {
        expect(candidate).toBeLessThan(knob.shippedValue);
        expect(candidate).toBeGreaterThanOrEqual(knob.hardMinimum);
      }
      expect([...knob.candidates].sort((a, b) => b - a)).toEqual([...knob.candidates]); // nearest-first
      expect(knob.minVisibleCases).toBeGreaterThan(0);
      expect(knob.minHeldOutCases).toBeGreaterThan(0);
      expect(["live", "report_only"]).toContain(knob.applyMode);
    }
    expect(new Set(knobs.map((knob) => knob.knobId)).size).toBe(knobs.length);
    expect(new Set(knobs.map((knob) => knob.splitSeed)).size).toBe(knobs.length);
    for (const [key, knob] of Object.entries(LOOSENABLE_KNOBS)) expect(key).toBe(knob.knobId);
  });
});

// Fixture strategy mirrors the satisfaction suite: probe the real splitter for slice membership under THIS
// knob's seed/rule, then assign confidence/label per slice.
function aiCase(targetKey: string, confidence: number, label: "reversed" | "confirmed"): BacktestCase {
  return {
    ruleId: AI_KNOB.ruleId,
    targetKey,
    outcome: "close",
    label,
    firedAt: "2026-06-01T00:00:00.000Z",
    decidedAt: "2026-06-02T00:00:00.000Z",
    metadata: { confidence },
  };
}

const POOL = Array.from({ length: 400 }, (_, i) => `acme/widgets#${i + 1}`);
const probe = POOL.map((key) => aiCase(key, 0.99, "confirmed"));
const { visible, heldOut } = splitBacktestCorpus(probe, AI_KNOB.heldOutFraction, AI_KNOB.splitSeed);
const visibleKeys = visible.map((c) => c.targetKey);
const heldOutKeys = heldOut.map((c) => c.targetKey);

function aiLooseningFriendlyCorpus(): BacktestCase[] {
  const cases: BacktestCase[] = [];
  // Borderline firings a human CONFIRMED at confidence 0.91 (between candidate 0.9 and shipped 0.93):
  // baseline predicts them reversed (false positives); candidate 0.9 stops firing them — precision improves.
  for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "confirmed"));
  for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "confirmed"));
  // A deep-low reversed anchor per slice keeps a true positive on both sides of every comparison.
  cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
  cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
  return cases;
}

describe("evaluateKnobLoosening on the close-confidence knob (#8159)", () => {
  it("proposes the smallest candidate step with full evidence when both splits support it", () => {
    const proposal = evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus());
    expect(proposal).not.toBeNull();
    expect(proposal!.knobId).toBe("ai_review_close_confidence");
    expect(proposal!.currentValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(proposal!.proposedValue).toBe(0.9);
    expect(proposal!.visible.verdict).toBe("improved");
    expect(proposal!.heldOut.verdict).not.toBe("regressed");
  });

  it("never loosens on a sample below THIS knob's own (higher) floors", () => {
    const thin = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases - 1).map((key) => aiCase(key, 0.91, "confirmed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.91, "confirmed")),
    ];
    expect(evaluateKnobLoosening(AI_KNOB, thin)).toBeNull();
  });

  it("refuses to step below the hard minimum even from an already-loosened current value", () => {
    expect(evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus(), AI_KNOB.hardMinimum)).toBeNull();
  });
});

describe("buildReportOnlyKnobRecs (#8159)", () => {
  it("surfaces the evidence with the report-only action line and NEVER a payload", () => {
    const proposal = evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus())!;
    const recs = buildReportOnlyKnobRecs([proposal]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.project).toBe("global:ai_review_close_confidence");
    expect(recs[0]!.severity).toBe("good");
    expect(recs[0]!.message).toContain(`${DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE} → 0.9`);
    expect(recs[0]!.message).toContain("no override consumer yet");
    expect(recs[0]!.overridePayload).toBeUndefined();
    expect(buildReportOnlyKnobRecs([])).toEqual([]);
  });
});

// ── #8212: config-drift evaluation (epic #8211 track A) ─────────────────────────────────────────────────────

describe("evaluateKnobDrift (#8212)", () => {
  // Live value loosened to the hard minimum; humans have been REVERSING firings in the 0.85–0.9 band, so the
  // TIGHTER candidate 0.9 classifies them correctly while live 0.85 misses them — the stale-config signal.
  function tighterFriendlyCorpus(): BacktestCase[] {
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.87, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.87, "reversed"));
    // A deep-low reversed anchor per slice keeps a baseline true positive in every comparison.
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    return cases;
  }

  it("reports a TIGHTER dominating alternative from a loosened live value — the stale-config signal", () => {
    const report = evaluateKnobDrift(AI_KNOB, tighterFriendlyCorpus(), AI_KNOB.hardMinimum, 1234);
    expect(report).not.toBeNull();
    expect(report!.bestValue).toBe(0.9); // nearest alternative to live 0.85 that clears both splits
    expect(report!.direction).toBe("tighter");
    expect(report!.liveValue).toBe(AI_KNOB.hardMinimum);
    expect(report!.visible.verdict).toBe("improved");
    expect(report!.heldOut.verdict).not.toBe("regressed");
    expect(report!.visibleCases).toBeGreaterThanOrEqual(AI_KNOB.minVisibleCases);
    expect(report!.heldOutCases).toBeGreaterThanOrEqual(AI_KNOB.minHeldOutCases);
    expect(report!.evaluatedAtMs).toBe(1234);
  });

  it("reports a LOOSER dominating alternative from the shipped default — duplicating the loosening loop's own proposal", () => {
    const report = evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus());
    expect(report).not.toBeNull();
    expect(report!.liveValue).toBe(AI_KNOB.shippedValue); // default liveValue arm
    expect(report!.bestValue).toBe(0.9);
    expect(report!.direction).toBe("looser");
    // Deterministic: byte-identical inputs yield the byte-identical report.
    expect(evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus())).toEqual(report);
  });

  it("labels the winner 'shipped' when the shipped value itself dominates a drifted live value", () => {
    // Humans reversed firings in the 0.90–0.93 band: only shipped 0.93 catches them; candidate 0.9 (tried
    // first, nearer to live 0.85) leaves them exactly as live does and is passed over as non-improving.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "reversed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));

    const report = evaluateKnobDrift(AI_KNOB, cases, AI_KNOB.hardMinimum);
    expect(report).not.toBeNull();
    expect(report!.bestValue).toBe(AI_KNOB.shippedValue);
    expect(report!.direction).toBe("shipped");
  });

  it("returns null — never a guess — when no alternative dominates the live value", () => {
    // High-confidence confirmed cases classify identically under every threshold: nothing can improve.
    const flat = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6).map((key) => aiCase(key, 0.99, "confirmed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.99, "confirmed")),
    ];
    expect(evaluateKnobDrift(AI_KNOB, flat)).toBeNull();
  });

  it("returns null below the visible-sample floor and below the held-out floor, independently", () => {
    const thinVisible = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases - 1).map((key) => aiCase(key, 0.87, "reversed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.87, "reversed")),
    ];
    expect(evaluateKnobDrift(AI_KNOB, thinVisible, AI_KNOB.hardMinimum)).toBeNull();
    const thinHeldOut = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6).map((key) => aiCase(key, 0.87, "reversed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases - 1).map((key) => aiCase(key, 0.87, "reversed")),
    ];
    expect(evaluateKnobDrift(AI_KNOB, thinHeldOut, AI_KNOB.hardMinimum)).toBeNull();
  });

  it("rejects an alternative that improves the visible split but regresses held-out — and stays null when every alternative does", () => {
    // Visible slice supports tightening (reversed labels at 0.87); the held-out slice punishes it (the same
    // band CONFIRMED there — any tighter threshold manufactures false positives on held-out).
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.87, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.87, "confirmed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));

    expect(evaluateKnobDrift(AI_KNOB, cases, AI_KNOB.hardMinimum)).toBeNull();
  });

  it("filters alternatives below the hard minimum and breaks equidistant ties toward the lower value, deterministically", () => {
    const syntheticKnob: LoosenableKnob = {
      knobId: "synthetic_drift_knob",
      ruleId: AI_KNOB.ruleId,
      shippedValue: 0.6,
      candidates: [0.4, 0.2],
      hardMinimum: 0.3,
      minVisibleCases: 2,
      minHeldOutCases: 1,
      heldOutFraction: AI_KNOB.heldOutFraction,
      splitSeed: AI_KNOB.splitSeed, // reuse the probed membership under the same seed/rule
      applyMode: "report_only",
      overrideFlagKey: "synthetic_drift_knob_override",
      looseningEventType: "calibration.synthetic_drift_knob",
      autotuneEnvVar: "SYNTHETIC_DRIFT_KNOB_AUTOTUNE_ENABLED",
    };
    // From live 0.5 the alternative set is {0.4, 0.6} (0.2 is below the hard minimum and never evaluated) —
    // an exact-distance tie, ordered [0.4, 0.6]. The 0.55-band reversed labels mean only shipped 0.6 improves.
    const cases: BacktestCase[] = [
      ...visibleKeys.slice(0, 4).map((key) => aiCase(key, 0.55, "reversed")),
      ...heldOutKeys.slice(0, 2).map((key) => aiCase(key, 0.55, "reversed")),
      aiCase(visibleKeys[10]!, 0.1, "reversed"),
      aiCase(heldOutKeys[6]!, 0.1, "reversed"),
    ];
    const report = evaluateKnobDrift(syntheticKnob, cases, 0.5);
    expect(report).not.toBeNull();
    expect(report!.bestValue).toBe(0.6);
    expect(report!.direction).toBe("shipped");
  });
});
