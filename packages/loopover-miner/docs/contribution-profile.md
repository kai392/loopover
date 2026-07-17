# ContributionProfile schema — AMS per-repo contribution-eligibility rules

Design spike for **#6795**, part of the AMS per-repo contribution-profile epic (#6793). This documents the
`ContributionProfile` shape AMS uses to represent what it has learned about a repo's contribution-eligibility
rules, before any extraction (#6796), caching (#6797) or `discover` wiring (#6798) is built against it.

**Design/schema only — no extraction logic and no `discover` wiring here.** The importable types live in
`packages/loopover-miner/lib/contribution-profile.d.ts`; the constants and two pure helpers in
`contribution-profile.js`.

The shape is **grounded in the real-repo signal inventory** (#6794,
`ams-contribution-signal-inventory.md`), not designed in the abstract. Three of that inventory's findings
directly drove decisions the abstract shape would have gotten wrong — those are called out inline below.

## The core idea: a profile is a bundle of independently-confident signal rules

Every rule in the profile is a `ContributionSignalRule<T>`:

```ts
{ value: T | null; confidence: "explicit" | "inferred" | "absent" | "unknown"; provenance: [...] }
```

- `value` is `null` whenever `confidence` is `absent`/`unknown`, so a consumer can never mistake "no rule" for
  "empty rule".
- `confidence` is **per rule, not per repo.** _(Finding #2, #6794: signal quality varies widely_ within _one
  repo — `rust` has excellent label descriptions and no PR template; `react` has a PR template and almost no
  label descriptions. A single repo-level score would be useless.)_
- `absent` is a first-class value, distinct from `unknown`. _(Finding: 3/10 sampled repos expose no eligibility
  label at all — a real answer `discover` must be able to act on, different from "we failed to look".)_
- `provenance` records which signal each rule came from, for debuggability. _(Finding: the primary source
  differs per repo — some state rules only in agent docs, some only in labels.)_

## Fields

| Field               | Type                                         | Notes                                                                 |
| ------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `repoFullName`      | `string`                                     |                                                                       |
| `schemaVersion`     | `number`                                     | Bumped on any shape change, so an older cached profile is detectable. |
| `generatedAt`       | `string`                                     | ISO timestamp.                                                        |
| `eligibilityLabels` | `SignalRule<ContributionLabelMatcher[]>`     | OR-list of matchers; `absent` when the repo has no eligibility label. |
| `exclusionLabels`   | `SignalRule<ContributionLabelMatcher[]>`     | Usually `inferred` or `absent` (see below).                           |
| `prBody`            | `SignalRule<ContributionPrBodyRequirements>` | Optional slot, not a spine field (see below).                         |
| `completeness`      | confidence                                   | The **weakest** spine signal — see the rule below.                    |

### Eligibility labels are matchers over name AND description

`ContributionLabelMatcher` is `{ field: "name" | "description"; contains: string }` — a case-insensitive
substring test, not a fixed name list and not a regex (kept auditable).

> **Finding #1 (#6794):** `good first issue` / `help wanted` is present in only 6/10 sampled repos. `rust`,
> `deno` and `kubernetes` — the highest-activity repos — use their own taxonomies, and `rust` encodes the
> "good first issue" meaning **only** in the description of `E-easy` (`"…Good first issue."`), which a
> name-only match misses. So the matcher must be able to test the description, and the rule is an OR-list so a
> repo with several eligibility labels is represented fully.

### Exclusion labels are weaker by construction

> **Finding (#6794):** nothing in the sample marks issues maintainer-only via a label whose _name_ says so;
> the closest signals are status labels (`blocked`, `on-hold`) whose exclusion meaning is conventional, not
> stated. So `exclusionLabels` will usually be `inferred` or `absent`, and the confidence field is what lets
> `discover` weight it accordingly rather than trusting it like an explicit eligibility rule.

### PR-body requirements are an optional slot, not a spine field

> **Finding (#6794):** the linked-issue requirement — the rule loopover's own gate enforces hardest — is
> **loopover-local**, absent from the rest of the sample (loopover 8 mentions in `CONTRIBUTING.md`, react/rust/
> kubernetes 0). Modelling it as a core field would encode our own norm as an ecosystem norm. It lives in the
> optional `prBody` rule, which is `absent` for most repos.

### `completeness` is the weakest signal, not the average

`completeness = weakestConfidence([eligibilityLabels.confidence, exclusionLabels.confidence, prBody.confidence])`.
Weakest wins so one strong signal never masks an absent one — a profile with a crisp eligibility rule but no
exclusion data is still only as trustworthy as its weakest part, and `discover` should treat it conservatively.

## Assignee exclusion is a runtime check, not a stored rule

> **Finding (#6794):** "not assigned to the repo owner" is not documented for most repos and is derivable from
> the issue's own `assignees` field at query time. So it is **not** a profile field. `ContributionAssigneeRuntimeCheck`
> (`{ excludeAssignedLogins: string[] }`) names the live filter #6796/#6798 apply at discover time, keeping a
> runtime concern out of the cached profile.

## Agent docs rank at least as highly as `CONTRIBUTING.md`

Not a schema field, but a note for the extractor (#6796), from the inventory:

> **Finding (#6794):** `AGENTS.md`/`CLAUDE.md` is the most consistently-present non-label signal (6/10), and
> `sure-aio` has `AGENTS.md` and **no** `CONTRIBUTING.md`. Extraction that treats human docs as primary and
> agent docs as fallback has the priority backwards for that repo. `provenance.source` includes `agent_docs`
> as a first-class source for exactly this reason. Also: `CONTRIBUTING.md` lives at the repo root in 6/10 and
> under `.github/` in 2/10, so the extractor must probe both, and treat a very small file (react's is 208 B) as
> a signpost rather than as rules.

## Caching shape

The profile is cached in a local SQLite store keyed by repo, mirroring the miner's other local stores
(`policy-doc-cache.js`), because labels and docs both change over time.

- Table: `CONTRIBUTION_PROFILE_STORE_TABLE` = `"miner_contribution_profile"`.
- TTL: `CONTRIBUTION_PROFILE_CACHE_TTL_MS` = 7 days. Labels/docs change slowly; a week bounds staleness without
  re-fetching every run. `CachedContributionProfile.stale` is `true` once `fetchedAt` is older than the TTL,
  and the caller re-extracts.
- The store itself is #6797's deliverable; this issue only fixes the table name and TTL so that issue and this
  schema agree.

## What the implementation issues build on this

- **#6796 (extraction):** populates each `SignalRule` from labels + `CONTRIBUTING.md` (root and `.github/`) +
  PR template + agent docs, setting `confidence`/`provenance` per the findings above.
- **#6797 (cache + doctor):** the `miner_contribution_profile` SQLite store with the TTL above.
- **#6798 (`discover` wiring):** reads the profile's eligibility/exclusion rules to filter candidate issues —
  see the section below for the landed behavior.

## Discover eligibility filtering (#6798)

`loopover-miner discover` now filters candidate issues through each target repo's `ContributionProfile` before
ranking and enqueueing, so it no longer surfaces work a repo's own conventions would reject. The decision logic
is `filterCandidatesByProfiles` (`contribution-profile-filter.js`), a pure partition of candidates into `kept`
and `excluded` (each excluded entry carries a `reason`).

**Safe-default posture — the load-bearing rule.** Filtering activates for a repo **only** when its profile has
a trustworthy eligibility signal (`eligibilityLabels.confidence === "explicit"`). A repo with no profile, or a
low-confidence / empty one — a repo whose conventions AMS simply couldn't read — keeps **every** candidate. A
weak profile can never cause AMS to silently skip real, eligible work. On top of that, the default resolver
does no profile work at all without a GitHub token (it can't read a taxonomy reliably unauthenticated), so the
unauthenticated CLI path is byte-identical to before.

**What gets excluded, once a repo is trusted** (matched against the candidate's own labels, by the eligibility/
exclusion label _names_ the profile recorded in `provenance`):

| Reason                      | Meaning                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `exclusion_label`           | the issue carries a label the profile marks maintainer-only / off-limits                    |
| `missing_eligibility_label` | the repo has an eligibility convention and the issue carries none of its eligibility labels |
| `conflicting_signals`       | the issue carries **both** an eligibility and an exclusion label — **exclusion wins**       |

**Conflicting signals resolve conservatively:** an issue that is both eligibility-labelled and exclusion-labelled
is excluded, because a maintainer marking it off-limits outranks its also being help-wanted — better to skip
than to attempt work the repo's own gate would reject.

**Assignee exclusion is not yet applied here.** The candidate objects that flow through `discover` carry label
names but not assignees (`opportunity-fanout.js`'s `normalizeIssue` drops them), and `ContributionAssigneeRuntimeCheck`
is deliberately a runtime concern rather than a profile field. Threading assignees through the fan-out is a
follow-up; this PR scopes filtering to labels, which is the primary eligibility signal the #6794 inventory found.

The excluded set (repo + issue + reason) is surfaced in both the `--json` output (`result.excluded`) and the
plain-text summary (an `excluded (eligibility): N` block), so a human running `discover` sees exactly what AMS
inferred and why each candidate was skipped.
