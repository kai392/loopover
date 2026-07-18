import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { StatusPill } from "@/components/site/control-primitives";
import {
  formatBenchmarkGeneratedAt,
  formatMergePrecisionPct,
  hasPeerBenchmark,
  precisionDeltaPct,
  type MaintainerFederatedBenchmark,
} from "@/components/site/app-panels/federated-benchmark-card-model";

/** Maintainer dashboard card (#6481): this instance's own gate precision vs the peer median computed from
 *  trust-gated federated bundles (#6478/#6479/#6480). The caller only mounts this when federation is enabled
 *  (data.qualityDashboard.federatedBenchmark is non-null) — an instance that hasn't opted in never sees this
 *  card at all, not a disabled version of it. No wallet/hotkey/reward/trust-score wording; "gate precision" is
 *  the same observable metric already shown elsewhere on this dashboard. */
export function FederatedBenchmarkCard({ benchmark }: { benchmark: MaintainerFederatedBenchmark }) {
  const hasPeers = hasPeerBenchmark(benchmark);
  const delta = precisionDeltaPct(benchmark);

  return (
    <AnalyticsCardShell
      title="Gate precision vs peer median"
      description="Your own gate precision alongside the peer median from trust-gated federated bundles. Opt-in only."
      state={hasPeers ? "ready" : "empty"}
      emptyTitle="No peer data yet"
      emptyHint="This instance is opted in, but no trust-gated peer bundle has contributed a comparable value yet. Configure a peer in federatedIntelligence.peerKeys, or wait for your collector's next pull."
      action={
        <span className="font-mono text-token-2xs text-muted-foreground">
          generated {formatBenchmarkGeneratedAt(benchmark.generatedAt)}
        </span>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric
          label="Your gate precision"
          value={formatMergePrecisionPct(benchmark.localMergePrecision)}
        />
        <Metric
          label="Peer median"
          value={formatMergePrecisionPct(benchmark.peerMedianMergePrecision)}
          detail={`${benchmark.peerCount} peer${benchmark.peerCount === 1 ? "" : "s"}`}
        />
        <Metric
          label="Delta"
          value={delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}pp`}
          tone={delta === null ? undefined : delta >= 0 ? "ready" : "warn"}
        />
      </div>
    </AnalyticsCardShell>
  );
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "ready" | "warn";
}) {
  return (
    <div className="rounded-token border border-border bg-background/40 p-3">
      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-token-lg font-semibold text-foreground">{value}</span>
        {tone ? (
          <StatusPill status={tone}>{tone === "ready" ? "ahead" : "behind"}</StatusPill>
        ) : null}
      </div>
      {detail ? <div className="mt-1 text-token-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}
