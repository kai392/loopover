// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";
import type { RepoStackResult } from "./stack-detection.js";

/** Failure taxonomy surfaced in per-repo reports (#4788 readiness + #7634 full-execution). */
export const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
  STACK_DETECTION: "stack_detection_gap";
  EXECUTION: "execution_gap";
  GITTENSOR_ASSUMPTION: "loopover_assumption";
  CLONE_SETUP: "clone_setup";
  OTHER: "other";
  /** Plan/spec formed but local build/compile command failed (#7634). */
  COMPILE_FAILED: "plan_formed_compile_failed";
  /** Build succeeded but the repo's own test suite failed (#7634). */
  TESTS_FAILED: "compiled_tests_failed";
  /** Tests passed but the coding attempt produced no file changes (#7634). */
  NOOP_DIFF: "tests_passed_noop_diff";
  /** Coding attempt abandoned before a handoff (agent unconfigured / refused) (#7634). */
  EXECUTION_ABANDON: "execution_abandon";
}> = Object.freeze({
  STACK_DETECTION: "stack_detection_gap",
  EXECUTION: "execution_gap",
  GITTENSOR_ASSUMPTION: "loopover_assumption",
  CLONE_SETUP: "clone_setup",
  OTHER: "other",
  COMPILE_FAILED: "plan_formed_compile_failed",
  TESTS_FAILED: "compiled_tests_failed",
  NOOP_DIFF: "tests_passed_noop_diff",
  EXECUTION_ABANDON: "execution_abandon",
});

/** Instruction substrings that indicate a POSITIVE loopover/LoopOver CI assumption leaked into the agent prompt.
 *  Lines that explicitly tell the agent *not* to assume these are filtered out before scanning. */
export const GITTENSOR_POSITIVE_ASSUMPTION_CHECKS: ReadonlyArray<{ id: string; pattern: RegExp }> = Object.freeze([
  { id: "test_ci_script", pattern: /npm run test:ci/i },
  { id: "codecov_patch", pattern: /codecov\/patch/i },
  { id: "gittensor_label", pattern: /gittensor:(?:bug|feature|priority)/i },
  { id: "loopover_gate", pattern: /loopover gate/i },
]);

export const DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH: string = "benchmarks/cross-repo/manifest.json";
export const MAX_CROSS_REPO_MANIFEST_BYTES: number = 65_536;
export const MAX_CROSS_REPO_MANIFEST_REPOS: number = 100;

export type CrossRepoEvaluationManifestRepo = {
  repoFullName: string;
  stackHint?: string;
  requireTestCommand?: boolean;
  /** When true, include this repo in `--full-execution` runs (#7634). */
  fullExecution?: boolean;
  fixturePath?: string;
};

export type ParsedCrossRepoEvaluationManifest = {
  present: boolean;
  manifest: { repos: CrossRepoEvaluationManifestRepo[] };
  warnings: string[];
};

export type CrossRepoEvaluationResult = {
  repoFullName: string;
  passed: boolean;
  failureCategory: string | null;
  reason: string | null;
  stackDetected: boolean;
  usedDefaultGoalSpec: boolean | null;
  assumptionFindings: Array<{ id: string; line: string }>;
  stack?: RepoStackResult;
};

export type CrossRepoEvaluationSummary = {
  total: number;
  passed: number;
  failed: number;
  majorityPassed: boolean;
  withoutLoopoverConfig: number;
  failuresByCategory: Record<string, number>;
};

type EvaluateRepoReadinessOptions = {
  repoPath?: string;
  resolveRepoPath?: (entry: { repoFullName: string }) => string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  detectRepoStack?: (repoPath: string) => RepoStackResult;
  resolveMinerGoalSpec?: (repoPath: string) => { present: boolean };
  buildCodingTaskSpec?: (input: Record<string, unknown>) => {
    ready: boolean;
    verdict?: string;
    instructions?: string;
  };
};

/** Local coding-attempt outcome for `--full-execution` (#7634). Never opens a forge PR. */
export type CrossRepoCodingAttemptResult = {
  outcome: "handoff" | "abandon";
  changedFiles: string[];
  reason?: string;
};

export type CrossRepoShellCommandResult = {
  ok: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type EvaluateRepoFullExecutionOptions = EvaluateRepoReadinessOptions & {
  /**
   * Run the local discover→plan→code step and return changed files. MUST NOT open PRs or call forge
   * write APIs (#7634). Injected in unit tests; default is a no-network stub that abandons unless
   * `LOOPOVER_MINER_FULL_EXECUTION_STUB=1` (synthetic handoff for local dry demos).
   */
  runCodingAttempt?: (input: {
    repoFullName: string;
    repoPath: string;
    stack: RepoStackResult;
    instructions: string;
  }) => CrossRepoCodingAttemptResult | Promise<CrossRepoCodingAttemptResult>;
  /** Run a local shell command (build/test). Injected in unit tests. */
  runShellCommand?: (input: {
    command: string;
    cwd: string;
  }) => CrossRepoShellCommandResult | Promise<CrossRepoShellCommandResult>;
};

// True UTF-8 byte count for the size guard (#7223): JS string `.length` is UTF-16 code units, which under-counts
// any multi-byte character (up to 4x for astral-plane code points), so `MAX_CROSS_REPO_MANIFEST_BYTES` -- named
// and warned about in BYTES -- was actually being compared against a code-unit count. Mirrors the identical helper
// in the three siblings this parser's own comment claims to follow: fleet-run-manifest.ts, miner-goal-spec.ts,
// and ams-policy-spec.ts.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function cloneEmptyManifest(warnings: string[] = []): ParsedCrossRepoEvaluationManifest {
  return { present: false, manifest: { repos: [] }, warnings };
}

/** Canonical `owner/repo` with exactly one slash and safe segments; anything else → null. */
export function normalizeCrossRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [owner, repo, extra] = value.trim().split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;
  return `${owner}/${repo}`;
}

function normalizeBoolean(value: unknown, field: string, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a boolean; falling back to ${fallback}.`);
  return fallback;
}

function normalizeOptionalString(value: unknown, field: string, warnings: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a string; ignoring the value.`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRepoList(value: unknown, warnings: string[]): CrossRepoEvaluationManifestRepo[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`CrossRepoEvaluationManifest field "repos" must be a list; ignoring a ${typeof value} value.`);
    return [];
  }
  const result: CrossRepoEvaluationManifestRepo[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (index >= MAX_CROSS_REPO_MANIFEST_REPOS) {
      warnings.push(
        `CrossRepoEvaluationManifest field "repos" exceeded ${MAX_CROSS_REPO_MANIFEST_REPOS} entries; extra entries ignored.`,
      );
      break;
    }
    let repoFullName: string | null = null;
    let stackHint: string | null = null;
    let requireTestCommand = false;
    let fullExecution = false;
    let fixturePath: string | null = null;
    if (typeof entry === "string") {
      repoFullName = normalizeCrossRepoFullName(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      repoFullName = normalizeCrossRepoFullName(record.repoFullName);
      stackHint = normalizeOptionalString(record.stackHint, "stackHint", warnings);
      requireTestCommand = normalizeBoolean(record.requireTestCommand, "requireTestCommand", false, warnings);
      fullExecution = normalizeBoolean(record.fullExecution, "fullExecution", false, warnings);
      fixturePath = normalizeOptionalString(record.fixturePath, "fixturePath", warnings);
    } else {
      warnings.push(`CrossRepoEvaluationManifest "repos" skipped a non-string, non-mapping entry.`);
      continue;
    }
    if (repoFullName === null) {
      warnings.push(`CrossRepoEvaluationManifest "repos" skipped an entry with an invalid "owner/repo" name.`);
      continue;
    }
    if (seen.has(repoFullName)) {
      warnings.push(`CrossRepoEvaluationManifest "repos" skipped a duplicate entry for ${repoFullName}.`);
      continue;
    }
    seen.add(repoFullName);
    const normalized: CrossRepoEvaluationManifestRepo = { repoFullName, requireTestCommand };
    if (stackHint) normalized.stackHint = stackHint;
    if (fixturePath) normalized.fixturePath = fixturePath;
    if (fullExecution) normalized.fullExecution = true;
    result.push(normalized);
  }
  return result;
}

/**
 * Tolerant JSON manifest parser (#4788). Malformed input degrades to an empty repo list with warnings rather than
 * throwing, mirroring the fleet-run-manifest / miner-goal-spec convention.
 */
export function parseCrossRepoEvaluationManifest(
  content: string | null | undefined,
): ParsedCrossRepoEvaluationManifest {
  if (content === undefined || content === null) return cloneEmptyManifest();
  if (typeof content !== "string") {
    return cloneEmptyManifest([`CrossRepoEvaluationManifest content must be a string; got ${typeof content}.`]);
  }
  const trimmed = content.trim();
  if (!trimmed) return cloneEmptyManifest();
  if (utf8ByteLength(trimmed) > MAX_CROSS_REPO_MANIFEST_BYTES) {
    return cloneEmptyManifest([
      `CrossRepoEvaluationManifest exceeded ${MAX_CROSS_REPO_MANIFEST_BYTES} bytes; ignoring the file.`,
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return cloneEmptyManifest(["CrossRepoEvaluationManifest is not valid JSON."]);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return cloneEmptyManifest(["CrossRepoEvaluationManifest root must be a JSON object."]);
  }
  const warnings: string[] = [];
  const repos = normalizeRepoList((raw as { repos?: unknown }).repos, warnings);
  return { present: true, manifest: { repos }, warnings };
}

/**
 * Scan agent instructions for positive loopover/LoopOver assumptions (#4788). Lines that already tell the agent
 * *not* to assume LoopOver conventions (the negative guidance from buildValidationGuidance) are skipped.
 */
export function scanPositiveLoopoverAssumptions(text: string): Array<{ id: string; line: string }> {
  if (typeof text !== "string") return [];
  const findings: Array<{ id: string; line: string }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /do not assume/i.test(trimmed)) continue;
    for (const check of GITTENSOR_POSITIVE_ASSUMPTION_CHECKS) {
      if (check.pattern.test(line)) findings.push({ id: check.id, line: trimmed });
    }
  }
  return findings;
}

function buildFailure(
  repoFullName: string,
  category: string,
  reason: string,
  extra: Partial<CrossRepoEvaluationResult> = {},
): CrossRepoEvaluationResult {
  return {
    repoFullName,
    passed: false,
    failureCategory: category,
    reason,
    stackDetected: false,
    usedDefaultGoalSpec: null,
    assumptionFindings: [],
    ...extra,
  };
}

function buildPass(repoFullName: string, extra: Partial<CrossRepoEvaluationResult> = {}): CrossRepoEvaluationResult {
  return {
    repoFullName,
    passed: true,
    failureCategory: null,
    reason: null,
    stackDetected: true,
    usedDefaultGoalSpec: true,
    assumptionFindings: [],
    ...extra,
  };
}

function resolveEvaluationRepoPath(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions = {},
): string {
  if (entry.fixturePath && typeof entry.fixturePath === "string") return entry.fixturePath;
  if (typeof options.repoPath === "string" && options.repoPath.trim()) return options.repoPath.trim();
  if (typeof options.resolveRepoPath === "function") return options.resolveRepoPath(entry);
  return resolveRepoCloneDir(entry.repoFullName, options.env ?? process.env);
}

function defaultClaimLedger(repoFullName: string): { listClaims: () => never[] } {
  return { listClaims: () => [] };
}

/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 */
export function evaluateRepoReadiness(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions = {},
): CrossRepoEvaluationResult {
  const repoFullName = entry?.repoFullName;
  if (typeof repoFullName !== "string" || !normalizeCrossRepoFullName(repoFullName)) {
    return buildFailure(
      typeof repoFullName === "string" ? repoFullName : "(invalid)",
      CROSS_REPO_FAILURE_CATEGORY.OTHER,
      "Benchmark entry is missing a valid owner/repo name.",
    );
  }

  const existsImpl = options.existsSync ?? existsSync;
  const detectImpl = options.detectRepoStack ?? detectRepoStack;
  const goalSpecImpl = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
  const buildSpecImpl: NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]> =
    options.buildCodingTaskSpec ??
    (buildCodingTaskSpec as unknown as NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]>);
  const repoPath = resolveEvaluationRepoPath(entry, options);

  if (!existsImpl(repoPath)) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP,
      `Repository path does not exist: ${repoPath}. Clone the repo or set LOOPOVER_MINER_REPO_CLONE_DIR.`,
    );
  }

  const goalSpec = goalSpecImpl(repoPath);
  const usedDefaultGoalSpec = goalSpec?.present !== true;

  const stack = detectImpl(repoPath);
  if (stack?.detected !== true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION,
      stack?.reason ?? "Stack auto-detection did not recognize this repository.",
      { stackDetected: false, usedDefaultGoalSpec },
    );
  }

  if (entry.requireTestCommand === true && !stack.testCommand) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
      "Stack detection succeeded but no test command was inferred while requireTestCommand is set.",
      { stackDetected: true, usedDefaultGoalSpec, stack },
    );
  }

  let specResult;
  try {
    specResult = buildSpecImpl({
      repoFullName,
      issue: {
        number: 1,
        title: "Cross-repo evaluation harness smoke issue",
        body: "Synthetic issue used only by the cross-repo evaluation harness.",
        labels: ["bug"],
      },
      context: { issues: [{ number: 1 }], pullRequests: [] },
      claimLedger: defaultClaimLedger(repoFullName),
      workingDirectory: repoPath,
      detectRepoStack: detectImpl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, message, {
      stackDetected: true,
      usedDefaultGoalSpec,
      stack,
    });
  }

  if (specResult?.ready !== true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
      `Coding task spec is not ready (verdict: ${specResult?.verdict ?? "unknown"}).`,
      { stackDetected: true, usedDefaultGoalSpec, stack },
    );
  }

  const assumptionFindings = scanPositiveLoopoverAssumptions(specResult.instructions ?? "");
  if (assumptionFindings.length > 0) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.GITTENSOR_ASSUMPTION,
      `Agent instructions leak loopover-specific assumptions (${assumptionFindings.map((f) => f.id).join(", ")}).`,
      { stackDetected: true, usedDefaultGoalSpec, stack, assumptionFindings },
    );
  }

  return buildPass(repoFullName, { usedDefaultGoalSpec, stack });
}

/**
 * Default coding-attempt seam for `--full-execution` (#7634). Never opens a PR.
 * - `LOOPOVER_MINER_FULL_EXECUTION_STUB=1` → synthetic handoff with one changed path (local demo only).
 * - Otherwise abandons with a clear reason (real agent wiring stays opt-in via `runCodingAttempt`).
 */
export function defaultRunCodingAttempt(input: {
  repoFullName: string;
  repoPath: string;
  stack: RepoStackResult;
  instructions: string;
  env?: NodeJS.ProcessEnv;
}): CrossRepoCodingAttemptResult {
  const env = input.env ?? process.env;
  if (/^(1|true|yes|on)$/i.test(env.LOOPOVER_MINER_FULL_EXECUTION_STUB ?? "")) {
    return { outcome: "handoff", changedFiles: ["CROSS_REPO_EVALUATION_STUB.diff"] };
  }
  return {
    outcome: "abandon",
    changedFiles: [],
    reason:
      "No runCodingAttempt injection and LOOPOVER_MINER_FULL_EXECUTION_STUB is unset — full-execution will not invent a live coding-agent run or open a forge PR.",
  };
}

/**
 * Default local shell runner for build/test commands (#7634). Sync spawn; no network.
 */
export function defaultRunShellCommand(input: { command: string; cwd: string }): CrossRepoShellCommandResult {
  const result = spawnSync(input.command, {
    cwd: input.cwd,
    shell: true,
    encoding: "utf8",
    env: process.env,
  });
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const out: CrossRepoShellCommandResult = { ok: exitCode === 0, exitCode };
  if (typeof result.stdout === "string") out.stdout = result.stdout;
  if (typeof result.stderr === "string") out.stderr = result.stderr;
  return out;
}

/**
 * Full-execution evaluation (#7634): readiness first, then local code→build→test with no forge writes.
 */
export async function evaluateRepoFullExecution(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoFullExecutionOptions = {},
): Promise<CrossRepoEvaluationResult> {
  const readiness = evaluateRepoReadiness(entry, options);
  if (readiness.passed !== true) return readiness;

  const repoFullName = readiness.repoFullName;
  const stack = readiness.stack;
  if (!stack || stack.detected !== true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION,
      "Full-execution requires a detected stack after readiness passed.",
      { stackDetected: false, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec },
    );
  }

  const repoPath = resolveEvaluationRepoPath(entry, options);
  const instructions =
    "Cross-repo full-execution local attempt (readiness already validated stack detection and coding-task composition).";

  const runAttempt =
    options.runCodingAttempt ??
    ((input) => defaultRunCodingAttempt(options.env ? { ...input, env: options.env } : input));
  const runCmd = options.runShellCommand ?? defaultRunShellCommand;

  const attempt = await runAttempt({ repoFullName, repoPath, stack, instructions });
  if (attempt?.outcome !== "handoff") {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION_ABANDON,
      attempt?.reason ?? "Coding attempt abandoned before handoff.",
      { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
    );
  }

  const changedFiles = Array.isArray(attempt.changedFiles)
    ? attempt.changedFiles.filter((p) => typeof p === "string" && p.trim())
    : [];

  if (stack.buildCommand) {
    const build = await runCmd({ command: stack.buildCommand, cwd: repoPath });
    if (!build?.ok) {
      return buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.COMPILE_FAILED,
        `Local build failed (exit ${build?.exitCode ?? "unknown"}): ${stack.buildCommand}`,
        { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
      );
    }
  }

  if (stack.testCommand) {
    const test = await runCmd({ command: stack.testCommand, cwd: repoPath });
    if (!test?.ok) {
      return buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.TESTS_FAILED,
        `Local tests failed (exit ${test?.exitCode ?? "unknown"}): ${stack.testCommand}`,
        { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
      );
    }
  } else if (entry.requireTestCommand === true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
      "Full-execution requires an inferred test command when requireTestCommand is set.",
      { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
    );
  }

  if (changedFiles.length === 0) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.NOOP_DIFF,
      "Build and tests succeeded but the coding attempt produced no changed files.",
      { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
    );
  }

  return buildPass(repoFullName, { usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack });
}

/**
 * Run the harness across every repo in a parsed manifest (#4788).
 * Pass `fullExecution: true` (#7634) to run local code→build→test (still no forge writes).
 */
export async function runCrossRepoEvaluation(
  parsed: ParsedCrossRepoEvaluationManifest,
  options: {
    repoFilter?: string;
    fullExecution?: boolean;
    /** Minimum repos to include in full-execution when filtering by `fullExecution` / requireTestCommand. */
    fullExecutionMinRepos?: number;
  } & EvaluateRepoFullExecutionOptions = {},
): Promise<CrossRepoEvaluationResult[]> {
  const repos = parsed?.manifest?.repos ?? [];
  let selected = repos;
  if (options.fullExecution === true && !options.repoFilter) {
    const tagged = repos.filter((r) => r.fullExecution === true);
    const withTests = repos.filter((r) => r.requireTestCommand === true);
    selected = tagged.length >= (options.fullExecutionMinRepos ?? 2) ? tagged : withTests;
  }
  const results: CrossRepoEvaluationResult[] = [];
  for (const entry of selected) {
    if (options.repoFilter && entry.repoFullName !== options.repoFilter) continue;
    if (options.fullExecution === true) {
      results.push(await evaluateRepoFullExecution(entry, options));
    } else {
      results.push(evaluateRepoReadiness(entry, options));
    }
  }
  return results;
}

/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 */
export function summarizeCrossRepoEvaluation(results: CrossRepoEvaluationResult[]): CrossRepoEvaluationSummary {
  const list = Array.isArray(results) ? results : [];
  let passed = 0;
  let failed = 0;
  const failuresByCategory: Record<string, number> = {};
  for (const result of list) {
    if (result?.passed === true) {
      passed += 1;
      continue;
    }
    failed += 1;
    const category = result?.failureCategory ?? CROSS_REPO_FAILURE_CATEGORY.OTHER;
    failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
  }
  const total = passed + failed;
  const majorityPassed = total > 0 ? passed > failed : false;
  const withoutLoopoverConfig = list.filter((r) => r?.usedDefaultGoalSpec !== false).length;
  return {
    total,
    passed,
    failed,
    majorityPassed,
    withoutLoopoverConfig,
    failuresByCategory,
  };
}

/**
 * Human-readable pass/fail report for one evaluation run (#4788).
 */
export function formatCrossRepoEvaluationReport(
  results: CrossRepoEvaluationResult[],
  summary: CrossRepoEvaluationSummary = summarizeCrossRepoEvaluation(results),
): string {
  const lines = ["loopover-miner cross-repo evaluation", ""];
  for (const result of results) {
    if (result.passed) {
      lines.push(`PASS ${result.repoFullName}`);
      continue;
    }
    lines.push(`FAIL ${result.repoFullName} [${result.failureCategory}] ${result.reason}`);
  }
  lines.push(
    "",
    `summary: ${summary.passed}/${summary.total} passed` +
      (summary.majorityPassed ? " (majority passed)" : " (majority failed)"),
  );
  if (summary.total > 0) {
    lines.push(`without loopover-specific target config: ${summary.withoutLoopoverConfig}/${summary.total}`);
  }
  const categories = Object.entries(summary.failuresByCategory).sort(([a], [b]) => a.localeCompare(b));
  if (categories.length > 0) {
    lines.push("", "failures by category:");
    for (const [category, count] of categories) {
      lines.push(`- ${category}: ${count}`);
    }
  }
  return lines.join("\n");
}
