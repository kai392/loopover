import type { RepoStackResult } from "./stack-detection.js";
/** Failure taxonomy surfaced in per-repo reports (#4788 readiness + #7634 full-execution). */
export declare const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
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
}>;
/** Instruction substrings that indicate a POSITIVE loopover/LoopOver CI assumption leaked into the agent prompt.
 *  Lines that explicitly tell the agent *not* to assume these are filtered out before scanning. */
export declare const GITTENSOR_POSITIVE_ASSUMPTION_CHECKS: ReadonlyArray<{
    id: string;
    pattern: RegExp;
}>;
export declare const DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH: string;
export declare const MAX_CROSS_REPO_MANIFEST_BYTES: number;
export declare const MAX_CROSS_REPO_MANIFEST_REPOS: number;
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
    manifest: {
        repos: CrossRepoEvaluationManifestRepo[];
    };
    warnings: string[];
};
export type CrossRepoEvaluationResult = {
    repoFullName: string;
    passed: boolean;
    failureCategory: string | null;
    reason: string | null;
    stackDetected: boolean;
    usedDefaultGoalSpec: boolean | null;
    assumptionFindings: Array<{
        id: string;
        line: string;
    }>;
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
    resolveRepoPath?: (entry: {
        repoFullName: string;
    }) => string;
    env?: NodeJS.ProcessEnv;
    existsSync?: (path: string) => boolean;
    detectRepoStack?: (repoPath: string) => RepoStackResult;
    resolveMinerGoalSpec?: (repoPath: string) => {
        present: boolean;
    };
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
/** Canonical `owner/repo` with exactly one slash and safe segments; anything else → null. */
export declare function normalizeCrossRepoFullName(value: unknown): string | null;
/**
 * Tolerant JSON manifest parser (#4788). Malformed input degrades to an empty repo list with warnings rather than
 * throwing, mirroring the fleet-run-manifest / miner-goal-spec convention.
 */
export declare function parseCrossRepoEvaluationManifest(content: string | null | undefined): ParsedCrossRepoEvaluationManifest;
/**
 * Scan agent instructions for positive loopover/LoopOver assumptions (#4788). Lines that already tell the agent
 * *not* to assume LoopOver conventions (the negative guidance from buildValidationGuidance) are skipped.
 */
export declare function scanPositiveLoopoverAssumptions(text: string): Array<{
    id: string;
    line: string;
}>;
/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 */
export declare function evaluateRepoReadiness(entry: CrossRepoEvaluationManifestRepo, options?: EvaluateRepoReadinessOptions): CrossRepoEvaluationResult;
/**
 * Default coding-attempt seam for `--full-execution` (#7634). Never opens a PR.
 * - `LOOPOVER_MINER_FULL_EXECUTION_STUB=1` → synthetic handoff with one changed path (local demo only).
 * - Otherwise abandons with a clear reason (real agent wiring stays opt-in via `runCodingAttempt`).
 */
export declare function defaultRunCodingAttempt(input: {
    repoFullName: string;
    repoPath: string;
    stack: RepoStackResult;
    instructions: string;
    env?: NodeJS.ProcessEnv;
}): CrossRepoCodingAttemptResult;
/**
 * Default local shell runner for build/test commands (#7634). Sync spawn; no network.
 */
export declare function defaultRunShellCommand(input: {
    command: string;
    cwd: string;
}): CrossRepoShellCommandResult;
/**
 * Full-execution evaluation (#7634): readiness first, then local code→build→test with no forge writes.
 */
export declare function evaluateRepoFullExecution(entry: CrossRepoEvaluationManifestRepo, options?: EvaluateRepoFullExecutionOptions): Promise<CrossRepoEvaluationResult>;
/**
 * Run the harness across every repo in a parsed manifest (#4788).
 * Pass `fullExecution: true` (#7634) to run local code→build→test (still no forge writes).
 */
export declare function runCrossRepoEvaluation(parsed: ParsedCrossRepoEvaluationManifest, options?: {
    repoFilter?: string;
    fullExecution?: boolean;
    /** Minimum repos to include in full-execution when filtering by `fullExecution` / requireTestCommand. */
    fullExecutionMinRepos?: number;
} & EvaluateRepoFullExecutionOptions): Promise<CrossRepoEvaluationResult[]>;
/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 */
export declare function summarizeCrossRepoEvaluation(results: CrossRepoEvaluationResult[]): CrossRepoEvaluationSummary;
/**
 * Human-readable pass/fail report for one evaluation run (#4788).
 */
export declare function formatCrossRepoEvaluationReport(results: CrossRepoEvaluationResult[], summary?: CrossRepoEvaluationSummary): string;
export {};
