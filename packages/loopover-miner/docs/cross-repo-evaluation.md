# Cross-repo evaluation harness

The **cross-repo evaluation harness** (#4788) is a repeatable readiness check that asks whether the miner can
approach a diverse benchmark repo set **without loopover-specific target-repo configuration** (no
`.loopover-miner.yml` required in the benchmark repos). It exercises the same offline path a real attempt uses
before the coding agent runs:

1. **Clone setup** — the repo exists under `LOOPOVER_MINER_REPO_CLONE_DIR`
2. **Stack auto-detection** (`detectRepoStack`, #4785)
3. **Coding-task spec composition** (`buildCodingTaskSpec`, #4786) including validation guidance derived from the
   detected stack
4. **Assumption scan** — agent instructions must not positively mandate LoopOver's own CI conventions

Each benchmark repo receives a **pass/fail** line. Failures are categorized:

| Category | Meaning |
| --- | --- |
| `stack_detection_gap` | No recognized manifest / stack could not be inferred |
| `execution_gap` | Stack detected but the coding-task path is not ready (e.g. missing inferred test command when required) |
| `loopover_assumption` | Agent instructions leak loopover-specific CI assumptions |
| `clone_setup` | The repo has not been cloned to the expected cache path |
| `other` | Unexpected errors |
| `plan_formed_compile_failed` | Full-execution: local build/compile failed after a coding handoff (#7634) |
| `compiled_tests_failed` | Full-execution: build ok but the repo's own test command failed (#7634) |
| `tests_passed_noop_diff` | Full-execution: build+tests ok but the coding attempt changed no files (#7634) |
| `execution_abandon` | Full-execution: coding attempt abandoned before handoff (#7634) |

The run also reports whether a **strict majority** of repos passed and how many succeeded **without** a per-target
`.loopover-miner.yml` (the default goal spec is acceptable).

## Benchmark manifest

Committed at [`benchmarks/cross-repo/manifest.json`](../benchmarks/cross-repo/manifest.json). Each entry is either a
bare `"owner/repo"` string or an object:

- **`repoFullName`** — canonical `owner/repo`
- **`stackHint`** — documentation only (not used by the evaluator)
- **`requireTestCommand`** — when `true`, stack detection must infer a test command or the repo fails with
  `execution_gap`
- **`fullExecution`** — when `true`, include this repo in the default `--full-execution` subset (#7634). At least two
  shipped entries are tagged; if fewer than two are tagged, the harness falls back to all `requireTestCommand` entries.

Malformed manifest fields degrade to documented defaults with warnings (same tolerant-parser convention as the
fleet run-manifest).

## Running locally

1. Clone the benchmark repos into the miner clone cache (once per machine):

   ```bash
   export LOOPOVER_MINER_REPO_CLONE_DIR="${LOOPOVER_MINER_REPO_CLONE_DIR:-$HOME/.config/loopover-miner/repos}"
   mkdir -p "$LOOPOVER_MINER_REPO_CLONE_DIR"
   # Example for one entry — repeat for each repo in the manifest
   git clone --depth 1 https://github.com/sindresorhus/is.git "$LOOPOVER_MINER_REPO_CLONE_DIR/sindresorhus/is"
   ```

2. Run the harness from the repo root:

   ```bash
   node packages/loopover-miner/scripts/cross-repo-evaluation.mjs
   ```

   Useful flags:

   - `--json` — machine-readable `{ warnings, results, summary }` payload
   - `--repo owner/repo` — evaluate a single manifest entry
   - `--manifest path/to/manifest.json` — alternate benchmark set (e.g. a fixture manifest in tests)
   - `--require-majority` — exit `1` unless a strict majority of repos pass (for CI-style gating)
   - `--full-execution` — after readiness, run local discover→plan→code→build→test (**no forge PR writes**, #7634)

## Full-execution mode (#7634)

`--full-execution` extends readiness with a **local-only** code→build→test loop against the tagged benchmark subset
(or `--repo` for a single entry). It never opens a GitHub/GitLab PR and never calls forge write APIs against the
benchmark repos.

1. Run the same readiness checks as the default mode
2. Invoke an injectable `runCodingAttempt` seam (discover→plan→code) that must return `handoff` + `changedFiles`
3. Run the detected `buildCommand` (when present) and `testCommand` locally via `runShellCommand`
4. Fail with execution-specific categories when compile fails, tests fail, the diff is empty, or the attempt abandons

**Default coding seam:** without an injected `runCodingAttempt`, the harness abandons with `execution_abandon`
unless `LOOPOVER_MINER_FULL_EXECUTION_STUB=1` is set (synthetic one-file handoff for local demos). Real agent wiring
stays opt-in so CI and unit tests stay offline and forge-write-free.

## Library API

Pure functions live in [`lib/cross-repo-evaluation.js`](../lib/cross-repo-evaluation.js):

- `parseCrossRepoEvaluationManifest(content)`
- `evaluateRepoReadiness(entry, options)` — inject `existsSync`, `detectRepoStack`, etc. for unit tests
- `evaluateRepoFullExecution(entry, options)` — readiness + local code→build→test; inject `runCodingAttempt` /
  `runShellCommand` (#7634)
- `runCrossRepoEvaluation(parsed, options)` — async; pass `fullExecution: true` for the execution path
- `summarizeCrossRepoEvaluation(results)`
- `formatCrossRepoEvaluationReport(results, summary)`

## Wiring

**Readiness mode** does not run the coding agent, open PRs, or call forge APIs. A green report means the miner’s
repo-agnostic stack-detection and coding-task-spec path is prepared for the benchmark repo.

**Full-execution mode** still does not open PRs or call forge write APIs. A green report means a local coding
handoff produced a non-empty diff that survived the target repo’s own build and test commands. A live production
attempt still needs credentials, governor policy, and queue state as documented in [`DEPLOYMENT.md`](../DEPLOYMENT.md).
