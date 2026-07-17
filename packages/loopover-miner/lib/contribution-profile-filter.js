// Eligibility filtering of discover candidates against a ContributionProfile (#6798). Pure: given the candidate
// list and a per-repo profile map, it partitions candidates into kept + excluded-with-reason. No fetching, no
// side effects — discover-cli.js resolves the profiles and renders the result; this owns only the decision.
//
// SAFE-DEFAULT POSTURE (the load-bearing requirement): filtering activates ONLY when a repo's profile has a
// trustworthy eligibility signal (eligibilityLabels.confidence === "explicit"). A repo with no profile, or a
// low-confidence/empty one — a repo whose conventions AMS simply couldn't read — has EVERY candidate kept, so a
// weak profile can never cause AMS to silently skip real, eligible work.

/** Why a candidate was excluded. */
export const ELIGIBILITY_EXCLUSION_REASONS = Object.freeze({
  /** The issue carries a label the profile identified as maintainer-only / off-limits. */
  EXCLUSION_LABEL: "exclusion_label",
  /** The repo has a trustworthy eligibility convention, and the issue carries none of its eligibility labels. */
  MISSING_ELIGIBILITY_LABEL: "missing_eligibility_label",
  /** The issue carries BOTH an eligibility and an exclusion label — conflicting signals; exclusion wins. */
  CONFLICTING_SIGNALS: "conflicting_signals",
});

/** The actual repo label names a signal rule was derived from (its provenance details), lowercased for match. */
function labelNamesFromRule(rule) {
  const names = new Set();
  for (const entry of rule?.provenance ?? []) {
    if (typeof entry?.detail === "string")
      names.add(entry.detail.toLowerCase());
  }
  return names;
}

/** Does the candidate carry any label whose name is in `names`? Case-insensitive. */
function candidateHasAnyLabel(candidate, names) {
  if (names.size === 0) return false;
  for (const label of candidate?.labels ?? []) {
    if (typeof label === "string" && names.has(label.toLowerCase()))
      return true;
  }
  return false;
}

/**
 * Partition candidates into kept + excluded against per-repo ContributionProfiles.
 *
 * @param {Array<{ repoFullName: string, labels?: string[] }>} candidates the fanned-out discover candidates
 * @param {Map<string, import("./contribution-profile.js").ContributionProfile>} profilesByRepo profile per repoFullName
 * @returns {{ kept: object[], excluded: Array<{ candidate: object, reason: string }> }}
 */
export function filterCandidatesByProfiles(candidates, profilesByRepo) {
  const kept = [];
  const excluded = [];
  for (const candidate of candidates) {
    const profile = profilesByRepo?.get(candidate.repoFullName);
    // Trust gate: only an EXPLICIT eligibility signal is trustworthy enough to filter on. Anything weaker
    // (absent/inferred/unknown, or no profile at all) keeps every candidate — the safe default.
    if (profile?.eligibilityLabels?.confidence !== "explicit") {
      kept.push(candidate);
      continue;
    }
    const eligibilityNames = labelNamesFromRule(profile.eligibilityLabels);
    const exclusionNames = labelNamesFromRule(profile.exclusionLabels);
    const hasEligibility = candidateHasAnyLabel(candidate, eligibilityNames);
    const hasExclusion = candidateHasAnyLabel(candidate, exclusionNames);
    if (hasExclusion && hasEligibility) {
      // Conservative resolution for conflicting signals: exclusion wins. A maintainer marking an issue
      // off-limits outranks its also carrying an eligibility label — better to skip than to attempt work the
      // repo's own gate would reject.
      excluded.push({
        candidate,
        reason: ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS,
      });
      continue;
    }
    if (hasExclusion) {
      excluded.push({
        candidate,
        reason: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
      });
      continue;
    }
    if (!hasEligibility) {
      excluded.push({
        candidate,
        reason: ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
      });
      continue;
    }
    kept.push(candidate);
  }
  return { kept, excluded };
}
