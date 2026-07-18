// Federated benchmark card model (#6481). UI-side mirror of FederatedBenchmark from
// src/orb/federated-benchmark.ts, plus pure display helpers.

export type MaintainerFederatedBenchmark = {
  localMergePrecision: number | null;
  peerMedianMergePrecision: number | null;
  peerCount: number;
  generatedAt: string;
};

/** mergePrecision is a 0-1 ratio (P(merged & not reverted | gate said merge)), never a 0-100 value. */
export function formatMergePrecisionPct(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

/** True once at least one peer has contributed a numeric value to the median — distinct from "opted in but
 *  no peer data yet", which renders the panel's empty state rather than a comparison. */
export function hasPeerBenchmark(benchmark: MaintainerFederatedBenchmark): boolean {
  return benchmark.peerCount > 0 && benchmark.peerMedianMergePrecision !== null;
}

/** Local precision minus peer median, in percentage points. Null whenever either side is unavailable — never
 *  a misleading zero. */
export function precisionDeltaPct(benchmark: MaintainerFederatedBenchmark): number | null {
  if (benchmark.localMergePrecision === null || benchmark.peerMedianMergePrecision === null)
    return null;
  return (
    Math.round((benchmark.localMergePrecision - benchmark.peerMedianMergePrecision) * 1000) / 10
  );
}

export function formatBenchmarkGeneratedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toUTCString().slice(5, 22);
}
