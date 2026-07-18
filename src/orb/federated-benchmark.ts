// LoopOver federated fleet intelligence (#1970) — the dashboard benchmark (#6481): "your gate precision vs
// peer median". Composes the three already-shipped pipeline stages — export (#6478, federated-bundle.ts),
// transport (#6479, federated-collector.ts), and trust-gated import (#6480, federated-import.ts) — into the
// one comparison the maintainer dashboard renders. No new storage, no new network primitive: this module is
// pure composition over functions that already exist and already fail safe on their own.
//
// FAIL-SAFE BY COMPOSITION, not by a wrapping try/catch: buildFederatedBundle degrades to null on any error,
// pullPeerBundles degrades to [] on any error or when not opted in, and importPeerBundles is a pure function
// with no I/O. None of the three can throw, so this module doesn't need to catch anything either — wrapping
// it in another try/catch would only hide which stage actually failed.
import { buildFederatedBundle, isFederatedIntelligenceEnabled } from "./federated-bundle";
import { importPeerBundles } from "./federated-import";
import { pullPeerBundles, type CollectorOpts } from "./federated-collector";
import { percentile } from "./analytics";
import type { FocusManifest } from "../signals/focus-manifest";

export interface FederatedBenchmark {
  /** This instance's own P(merged & not reverted | gate said merge), from buildFederatedBundle. Null below
   *  MIN_DECIDED, exactly like the exported bundle field it reuses. */
  localMergePrecision: number | null;
  /** Median mergePrecision across every accepted (trust-gated) peer bundle that itself cleared MIN_DECIDED.
   *  Null when no peer contributed a numeric value yet — an empty-state condition, not an error. */
  peerMedianMergePrecision: number | null;
  /** How many peers actually contributed to the median above (i.e. passed trust-gating AND had a non-null
   *  mergePrecision) — NOT the raw count of bundles pulled or accepted, which may include peers still below
   *  their own MIN_DECIDED threshold. */
  peerCount: number;
  generatedAt: string;
}

/**
 * Build the local-vs-peer-median benchmark for the maintainer dashboard.
 *
 * Returns null — touching nothing beyond the opt-in check — when federated intelligence is not enabled for
 * this deployment (`federatedIntelligence.enabled` off in the loopover self-repo's manifest). This is the
 * "an instance that hasn't opted in sees no new UI, not an empty/disabled version of it" gate #6481 requires;
 * the caller renders no panel at all on a null result, distinct from a real object with peerCount: 0 (opted
 * in, no peer data yet — an empty state, not an error).
 */
export async function buildFederatedBenchmark(
  manifest: Pick<FocusManifest, "federatedIntelligence"> | null | undefined,
  db: D1Database,
  opts: { now?: number; windowDays?: number } & CollectorOpts = {},
): Promise<FederatedBenchmark | null> {
  if (!isFederatedIntelligenceEnabled(manifest)) return null;

  const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
  // exactOptionalPropertyTypes forbids `windowDays: undefined` — only include the key when a real value was
  // passed, so an omitted opts.windowDays falls through to buildFederatedBundle's own default instead of
  // being overridden with an explicit undefined.
  const localBundle = await buildFederatedBundle(manifest, db, opts.windowDays === undefined ? { now } : { now, windowDays: opts.windowDays });

  const peerBundles = await pullPeerBundles(manifest, opts);
  const { accepted } = importPeerBundles(manifest, peerBundles);
  // MEDIAN, NOT MEAN (mirrors analytics.ts's own fleet aggregation, see federated-import.ts's header comment):
  // a bounded number of outliers cannot drag a median arbitrarily, so re-deriving a mean here would quietly
  // weaken the same poisoning-resistance property the import side already relies on holding by construction.
  const peerMergePrecisions = accepted
    .map((bundle) => bundle.mergePrecision)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return {
    localMergePrecision: localBundle?.mergePrecision ?? null,
    peerMedianMergePrecision: percentile(peerMergePrecisions, 50),
    peerCount: peerMergePrecisions.length,
    generatedAt: new Date(now).toISOString(),
  };
}
