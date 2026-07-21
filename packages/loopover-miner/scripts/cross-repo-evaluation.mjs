#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH,
  formatCrossRepoEvaluationReport,
  parseCrossRepoEvaluationManifest,
  runCrossRepoEvaluation,
  summarizeCrossRepoEvaluation,
} from "../lib/cross-repo-evaluation.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDefaultManifestPath() {
  return join(PACKAGE_ROOT, DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH);
}

export function parseCrossRepoEvaluationArgs(argv) {
  const args = argv ?? process.argv.slice(2);
  let manifestPath = resolveDefaultManifestPath();
  let json = false;
  let repoFilter = null;
  let requireMajority = false;
  let fullExecution = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--require-majority") {
      requireMajority = true;
      continue;
    }
    if (token === "--full-execution") {
      fullExecution = true;
      continue;
    }
    if (token === "--manifest") {
      const value = args[i + 1];
      if (!value) return { error: "Missing value for --manifest." };
      manifestPath = value;
      i += 1;
      continue;
    }
    if (token === "--repo") {
      const value = args[i + 1];
      if (!value) return { error: "Missing value for --repo." };
      repoFilter = value;
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    return { error: `Unknown argument: ${token}` };
  }
  return { manifestPath, json, repoFilter, requireMajority, fullExecution };
}

export function loadCrossRepoEvaluationManifest(manifestPath) {
  const content = readFileSync(manifestPath, "utf8");
  return parseCrossRepoEvaluationManifest(content);
}

export async function runCrossRepoEvaluationCli(options = {}) {
  const parsed = options.parsed ?? loadCrossRepoEvaluationManifest(options.manifestPath ?? resolveDefaultManifestPath());
  const results = await runCrossRepoEvaluation(parsed, {
    repoFilter: options.repoFilter ?? null,
    fullExecution: options.fullExecution === true,
  });
  const summary = summarizeCrossRepoEvaluation(results);
  return { parsed, results, summary };
}

function printHelp() {
  console.log(
    [
      "loopover-miner cross-repo evaluation (#4788 readiness / #7634 full-execution)",
      "",
      "Usage:",
      "  node packages/loopover-miner/scripts/cross-repo-evaluation.mjs [options]",
      "",
      "Options:",
      "  --manifest <path>     Benchmark manifest (default: benchmarks/cross-repo/manifest.json)",
      "  --repo <owner/repo>     Evaluate a single benchmark entry",
      "  --full-execution        Local discover->plan->code->build->test (no forge PR writes) (#7634)",
      "  --json                  Emit machine-readable JSON on stdout",
      "  --require-majority      Exit 1 unless a strict majority of repos pass",
      "  -h, --help              Show this help",
      "",
      "Prerequisite: clone benchmark repos into LOOPOVER_MINER_REPO_CLONE_DIR (see docs/cross-repo-evaluation.md).",
      "Full-execution never opens PRs against benchmark repos; inject runCodingAttempt or set",
      "LOOPOVER_MINER_FULL_EXECUTION_STUB=1 for a synthetic local handoff.",
    ].join("\n"),
  );
}

async function main() {
  const parsedArgs = parseCrossRepoEvaluationArgs();
  if (parsedArgs.help) {
    printHelp();
    return 0;
  }
  if (parsedArgs.error) {
    console.error(parsedArgs.error);
    return 2;
  }

  const { parsed, results, summary } = await runCrossRepoEvaluationCli(parsedArgs);
  if (parsedArgs.json) {
    console.log(JSON.stringify({ warnings: parsed.warnings, results, summary }, null, 2));
  } else {
    if (parsed.warnings.length > 0) {
      console.error(`manifest warnings:\n- ${parsed.warnings.join("\n- ")}`);
    }
    console.log(formatCrossRepoEvaluationReport(results, summary));
  }

  if (parsedArgs.requireMajority && !summary.majorityPassed) return 1;
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
