// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";
/** Failure taxonomy surfaced in per-repo reports (#4788 readiness + #7634 full-execution). */
export const CROSS_REPO_FAILURE_CATEGORY = Object.freeze({
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
export const GITTENSOR_POSITIVE_ASSUMPTION_CHECKS = Object.freeze([
    { id: "test_ci_script", pattern: /npm run test:ci/i },
    { id: "codecov_patch", pattern: /codecov\/patch/i },
    { id: "gittensor_label", pattern: /gittensor:(?:bug|feature|priority)/i },
    { id: "loopover_gate", pattern: /loopover gate/i },
]);
export const DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH = "benchmarks/cross-repo/manifest.json";
export const MAX_CROSS_REPO_MANIFEST_BYTES = 65_536;
export const MAX_CROSS_REPO_MANIFEST_REPOS = 100;
// True UTF-8 byte count for the size guard (#7223): JS string `.length` is UTF-16 code units, which under-counts
// any multi-byte character (up to 4x for astral-plane code points), so `MAX_CROSS_REPO_MANIFEST_BYTES` -- named
// and warned about in BYTES -- was actually being compared against a code-unit count. Mirrors the identical helper
// in the three siblings this parser's own comment claims to follow: fleet-run-manifest.ts, miner-goal-spec.ts,
// and ams-policy-spec.ts.
function utf8ByteLength(value) {
    let bytes = 0;
    for (const char of value) {
        const codePoint = char.codePointAt(0);
        if (codePoint <= 0x7f)
            bytes += 1;
        else if (codePoint <= 0x7ff)
            bytes += 2;
        else if (codePoint <= 0xffff)
            bytes += 3;
        else
            bytes += 4;
    }
    return bytes;
}
function cloneEmptyManifest(warnings = []) {
    return { present: false, manifest: { repos: [] }, warnings };
}
/** Canonical `owner/repo` with exactly one slash and safe segments; anything else → null. */
export function normalizeCrossRepoFullName(value) {
    if (typeof value !== "string")
        return null;
    const [owner, repo, extra] = value.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        return null;
    return `${owner}/${repo}`;
}
function normalizeBoolean(value, field, fallback, warnings) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === "boolean")
        return value;
    warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a boolean; falling back to ${fallback}.`);
    return fallback;
}
function normalizeOptionalString(value, field, warnings) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string") {
        warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a string; ignoring the value.`);
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}
function normalizeRepoList(value, warnings) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value)) {
        warnings.push(`CrossRepoEvaluationManifest field "repos" must be a list; ignoring a ${typeof value} value.`);
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const [index, entry] of value.entries()) {
        if (index >= MAX_CROSS_REPO_MANIFEST_REPOS) {
            warnings.push(`CrossRepoEvaluationManifest field "repos" exceeded ${MAX_CROSS_REPO_MANIFEST_REPOS} entries; extra entries ignored.`);
            break;
        }
        let repoFullName = null;
        let stackHint = null;
        let requireTestCommand = false;
        let fullExecution = false;
        let fixturePath = null;
        if (typeof entry === "string") {
            repoFullName = normalizeCrossRepoFullName(entry);
        }
        else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const record = entry;
            repoFullName = normalizeCrossRepoFullName(record.repoFullName);
            stackHint = normalizeOptionalString(record.stackHint, "stackHint", warnings);
            requireTestCommand = normalizeBoolean(record.requireTestCommand, "requireTestCommand", false, warnings);
            fullExecution = normalizeBoolean(record.fullExecution, "fullExecution", false, warnings);
            fixturePath = normalizeOptionalString(record.fixturePath, "fixturePath", warnings);
        }
        else {
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
        const normalized = { repoFullName, requireTestCommand };
        if (stackHint)
            normalized.stackHint = stackHint;
        if (fixturePath)
            normalized.fixturePath = fixturePath;
        if (fullExecution)
            normalized.fullExecution = true;
        result.push(normalized);
    }
    return result;
}
/**
 * Tolerant JSON manifest parser (#4788). Malformed input degrades to an empty repo list with warnings rather than
 * throwing, mirroring the fleet-run-manifest / miner-goal-spec convention.
 */
export function parseCrossRepoEvaluationManifest(content) {
    if (content === undefined || content === null)
        return cloneEmptyManifest();
    if (typeof content !== "string") {
        return cloneEmptyManifest([`CrossRepoEvaluationManifest content must be a string; got ${typeof content}.`]);
    }
    const trimmed = content.trim();
    if (!trimmed)
        return cloneEmptyManifest();
    if (utf8ByteLength(trimmed) > MAX_CROSS_REPO_MANIFEST_BYTES) {
        return cloneEmptyManifest([
            `CrossRepoEvaluationManifest exceeded ${MAX_CROSS_REPO_MANIFEST_BYTES} bytes; ignoring the file.`,
        ]);
    }
    let raw;
    try {
        raw = JSON.parse(trimmed);
    }
    catch {
        return cloneEmptyManifest(["CrossRepoEvaluationManifest is not valid JSON."]);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return cloneEmptyManifest(["CrossRepoEvaluationManifest root must be a JSON object."]);
    }
    const warnings = [];
    const repos = normalizeRepoList(raw.repos, warnings);
    return { present: true, manifest: { repos }, warnings };
}
/**
 * Scan agent instructions for positive loopover/LoopOver assumptions (#4788). Lines that already tell the agent
 * *not* to assume LoopOver conventions (the negative guidance from buildValidationGuidance) are skipped.
 */
export function scanPositiveLoopoverAssumptions(text) {
    if (typeof text !== "string")
        return [];
    const findings = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || /do not assume/i.test(trimmed))
            continue;
        for (const check of GITTENSOR_POSITIVE_ASSUMPTION_CHECKS) {
            if (check.pattern.test(line))
                findings.push({ id: check.id, line: trimmed });
        }
    }
    return findings;
}
function buildFailure(repoFullName, category, reason, extra = {}) {
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
function buildPass(repoFullName, extra = {}) {
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
function resolveEvaluationRepoPath(entry, options = {}) {
    if (entry.fixturePath && typeof entry.fixturePath === "string")
        return entry.fixturePath;
    if (typeof options.repoPath === "string" && options.repoPath.trim())
        return options.repoPath.trim();
    if (typeof options.resolveRepoPath === "function")
        return options.resolveRepoPath(entry);
    return resolveRepoCloneDir(entry.repoFullName, options.env ?? process.env);
}
function defaultClaimLedger(repoFullName) {
    return { listClaims: () => [] };
}
/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 */
export function evaluateRepoReadiness(entry, options = {}) {
    const repoFullName = entry?.repoFullName;
    if (typeof repoFullName !== "string" || !normalizeCrossRepoFullName(repoFullName)) {
        return buildFailure(typeof repoFullName === "string" ? repoFullName : "(invalid)", CROSS_REPO_FAILURE_CATEGORY.OTHER, "Benchmark entry is missing a valid owner/repo name.");
    }
    const existsImpl = options.existsSync ?? existsSync;
    const detectImpl = options.detectRepoStack ?? detectRepoStack;
    const goalSpecImpl = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
    const buildSpecImpl = options.buildCodingTaskSpec ??
        buildCodingTaskSpec;
    const repoPath = resolveEvaluationRepoPath(entry, options);
    if (!existsImpl(repoPath)) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP, `Repository path does not exist: ${repoPath}. Clone the repo or set LOOPOVER_MINER_REPO_CLONE_DIR.`);
    }
    const goalSpec = goalSpecImpl(repoPath);
    const usedDefaultGoalSpec = goalSpec?.present !== true;
    const stack = detectImpl(repoPath);
    if (stack?.detected !== true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION, stack?.reason ?? "Stack auto-detection did not recognize this repository.", { stackDetected: false, usedDefaultGoalSpec });
    }
    if (entry.requireTestCommand === true && !stack.testCommand) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, "Stack detection succeeded but no test command was inferred while requireTestCommand is set.", { stackDetected: true, usedDefaultGoalSpec, stack });
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, message, {
            stackDetected: true,
            usedDefaultGoalSpec,
            stack,
        });
    }
    if (specResult?.ready !== true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, `Coding task spec is not ready (verdict: ${specResult?.verdict ?? "unknown"}).`, { stackDetected: true, usedDefaultGoalSpec, stack });
    }
    const assumptionFindings = scanPositiveLoopoverAssumptions(specResult.instructions ?? "");
    if (assumptionFindings.length > 0) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.GITTENSOR_ASSUMPTION, `Agent instructions leak loopover-specific assumptions (${assumptionFindings.map((f) => f.id).join(", ")}).`, { stackDetected: true, usedDefaultGoalSpec, stack, assumptionFindings });
    }
    return buildPass(repoFullName, { usedDefaultGoalSpec, stack });
}
/**
 * Default coding-attempt seam for `--full-execution` (#7634). Never opens a PR.
 * - `LOOPOVER_MINER_FULL_EXECUTION_STUB=1` → synthetic handoff with one changed path (local demo only).
 * - Otherwise abandons with a clear reason (real agent wiring stays opt-in via `runCodingAttempt`).
 */
export function defaultRunCodingAttempt(input) {
    const env = input.env ?? process.env;
    if (/^(1|true|yes|on)$/i.test(env.LOOPOVER_MINER_FULL_EXECUTION_STUB ?? "")) {
        return { outcome: "handoff", changedFiles: ["CROSS_REPO_EVALUATION_STUB.diff"] };
    }
    return {
        outcome: "abandon",
        changedFiles: [],
        reason: "No runCodingAttempt injection and LOOPOVER_MINER_FULL_EXECUTION_STUB is unset — full-execution will not invent a live coding-agent run or open a forge PR.",
    };
}
/**
 * Default local shell runner for build/test commands (#7634). Sync spawn; no network.
 */
export function defaultRunShellCommand(input) {
    const result = spawnSync(input.command, {
        cwd: input.cwd,
        shell: true,
        encoding: "utf8",
        env: process.env,
    });
    const exitCode = typeof result.status === "number" ? result.status : 1;
    const out = { ok: exitCode === 0, exitCode };
    if (typeof result.stdout === "string")
        out.stdout = result.stdout;
    if (typeof result.stderr === "string")
        out.stderr = result.stderr;
    return out;
}
/**
 * Full-execution evaluation (#7634): readiness first, then local code→build→test with no forge writes.
 */
export async function evaluateRepoFullExecution(entry, options = {}) {
    const readiness = evaluateRepoReadiness(entry, options);
    if (readiness.passed !== true)
        return readiness;
    const repoFullName = readiness.repoFullName;
    const stack = readiness.stack;
    if (!stack || stack.detected !== true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION, "Full-execution requires a detected stack after readiness passed.", { stackDetected: false, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec });
    }
    const repoPath = resolveEvaluationRepoPath(entry, options);
    const instructions = "Cross-repo full-execution local attempt (readiness already validated stack detection and coding-task composition).";
    const runAttempt = options.runCodingAttempt ??
        ((input) => defaultRunCodingAttempt(options.env ? { ...input, env: options.env } : input));
    const runCmd = options.runShellCommand ?? defaultRunShellCommand;
    const attempt = await runAttempt({ repoFullName, repoPath, stack, instructions });
    if (attempt?.outcome !== "handoff") {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_ABANDON, attempt?.reason ?? "Coding attempt abandoned before handoff.", { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack });
    }
    const changedFiles = Array.isArray(attempt.changedFiles)
        ? attempt.changedFiles.filter((p) => typeof p === "string" && p.trim())
        : [];
    if (stack.buildCommand) {
        const build = await runCmd({ command: stack.buildCommand, cwd: repoPath });
        if (!build?.ok) {
            return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.COMPILE_FAILED, `Local build failed (exit ${build?.exitCode ?? "unknown"}): ${stack.buildCommand}`, { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack });
        }
    }
    if (stack.testCommand) {
        const test = await runCmd({ command: stack.testCommand, cwd: repoPath });
        if (!test?.ok) {
            return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.TESTS_FAILED, `Local tests failed (exit ${test?.exitCode ?? "unknown"}): ${stack.testCommand}`, { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack });
        }
    }
    else if (entry.requireTestCommand === true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, "Full-execution requires an inferred test command when requireTestCommand is set.", { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack });
    }
    if (changedFiles.length === 0) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.NOOP_DIFF, "Build and tests succeeded but the coding attempt produced no changed files.", { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack });
    }
    return buildPass(repoFullName, { usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack });
}
/**
 * Run the harness across every repo in a parsed manifest (#4788).
 * Pass `fullExecution: true` (#7634) to run local code→build→test (still no forge writes).
 */
export async function runCrossRepoEvaluation(parsed, options = {}) {
    const repos = parsed?.manifest?.repos ?? [];
    let selected = repos;
    if (options.fullExecution === true && !options.repoFilter) {
        const tagged = repos.filter((r) => r.fullExecution === true);
        const withTests = repos.filter((r) => r.requireTestCommand === true);
        selected = tagged.length >= (options.fullExecutionMinRepos ?? 2) ? tagged : withTests;
    }
    const results = [];
    for (const entry of selected) {
        if (options.repoFilter && entry.repoFullName !== options.repoFilter)
            continue;
        if (options.fullExecution === true) {
            results.push(await evaluateRepoFullExecution(entry, options));
        }
        else {
            results.push(evaluateRepoReadiness(entry, options));
        }
    }
    return results;
}
/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 */
export function summarizeCrossRepoEvaluation(results) {
    const list = Array.isArray(results) ? results : [];
    let passed = 0;
    let failed = 0;
    const failuresByCategory = {};
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
export function formatCrossRepoEvaluationReport(results, summary = summarizeCrossRepoEvaluation(results)) {
    const lines = ["loopover-miner cross-repo evaluation", ""];
    for (const result of results) {
        if (result.passed) {
            lines.push(`PASS ${result.repoFullName}`);
            continue;
        }
        lines.push(`FAIL ${result.repoFullName} [${result.failureCategory}] ${result.reason}`);
    }
    lines.push("", `summary: ${summary.passed}/${summary.total} passed` +
        (summary.majorityPassed ? " (majority passed)" : " (majority failed)"));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGlIQUFpSDtBQUNqSCw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFFckcsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQy9DLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFFckMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDNUQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLG1CQUFtQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDMUUsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBR3ZELDhGQUE4RjtBQUM5RixNQUFNLENBQUMsTUFBTSwyQkFBMkIsR0FjbkMsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNqQixlQUFlLEVBQUUscUJBQXFCO0lBQ3RDLFNBQVMsRUFBRSxlQUFlO0lBQzFCLG9CQUFvQixFQUFFLHFCQUFxQjtJQUMzQyxXQUFXLEVBQUUsYUFBYTtJQUMxQixLQUFLLEVBQUUsT0FBTztJQUNkLGNBQWMsRUFBRSw0QkFBNEI7SUFDNUMsWUFBWSxFQUFFLHVCQUF1QjtJQUNyQyxTQUFTLEVBQUUsd0JBQXdCO0lBQ25DLGlCQUFpQixFQUFFLG1CQUFtQjtDQUN2QyxDQUFDLENBQUM7QUFFSDttR0FDbUc7QUFDbkcsTUFBTSxDQUFDLE1BQU0sb0NBQW9DLEdBQW1ELE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDaEgsRUFBRSxFQUFFLEVBQUUsZ0JBQWdCLEVBQUUsT0FBTyxFQUFFLGtCQUFrQixFQUFFO0lBQ3JELEVBQUUsRUFBRSxFQUFFLGVBQWUsRUFB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