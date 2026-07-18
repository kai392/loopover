import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { canonicalizeFederatedBundleBody, FEDERATED_BUNDLE_SCHEMA_VERSION, type FederatedSignalBundle } from "../../src/orb/federated-bundle";
import { buildFederatedBenchmark } from "../../src/orb/federated-benchmark";
import type { FederatedCollectorMode, FocusManifest } from "../../src/signals/focus-manifest";

const URL_OK = "https://collector.example.org/v1/federated";
// Fake 64-hex keys — the shape generateAnonSecret produces. Not secrets: locally-invented test fixtures.
const PEER_KEY_A = "a".repeat(64);
const PEER_KEY_B = "b".repeat(64);
const UNTRUSTED_KEY = "c".repeat(64);
const NOW = Date.parse("2026-07-16T00:00:00Z");

/** In-memory DB with the tables buildFederatedBundle reads (mirrors federated-bundle.test.ts's makeDb). */
function makeDb(): D1Database {
  const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
  driver.exec(`
    CREATE TABLE review_audit (
      id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, target_id TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'gate_decision', decision TEXT,
      source TEXT NOT NULL DEFAULT 'gittensory-native', head_sha TEXT, summary TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE system_flags (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  return createD1Adapter(driver);
}

/** A db that fails the test if it is touched at all — proves the opted-out path reads nothing. */
function untouchableDb(): D1Database {
  return new Proxy({} as D1Database, {
    get() {
      throw new Error("opted-out build must not touch the database");
    },
  });
}

let seq = 0;
async function resolved(
  db: D1Database,
  pr: number,
  o: { verdict?: string; outcome?: string; reversal?: "reversal_reverted" | "reversal_reopened" } = {},
): Promise<void> {
  const insert = (type: string, decision: string | null, at: string) =>
    db
      .prepare(
        `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, summary, created_at) VALUES (?, ?, ?, ?, ?, 'gittensory-native', NULL, ?)`,
      )
      .bind(`b${seq++}`, "owner/repo", `owner/repo#${pr}`, type, decision, at)
      .run();
  await insert("gate_decision", o.verdict ?? "merge", "2026-07-10T10:00:00Z");
  await insert("pr_outcome", o.outcome ?? "merged", "2026-07-10T12:00:00Z");
  if (o.reversal) await insert(o.reversal, null, "2026-07-10T13:00:00Z");
}

function manifest(
  o: {
    enabled?: boolean;
    peerKeys?: string[];
    collectorUrl?: string | null;
    collectorMode?: FederatedCollectorMode | null;
  } = {},
): Pick<FocusManifest, "federatedIntelligence"> {
  return {
    federatedIntelligence: {
      present: true,
      enabled: o.enabled ?? true,
      peerKeys: o.peerKeys ?? [PEER_KEY_A],
      collectorUrl: o.collectorUrl === undefined ? URL_OK : o.collectorUrl,
      collectorMode: o.collectorMode ?? null,
    },
  };
}

const peerBody = (over: Partial<FederatedSignalBundle> = {}) => ({
  schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION,
  instanceId: "peerinstance1234",
  generatedAt: "2026-07-15T00:00:00.000Z",
  windowDays: 90,
  decided: 40,
  mergePrecision: 0.8,
  closePrecision: 0.7,
  fpRate: 0.1,
  fnRate: 0.2,
  reversalRate: 0.05,
  cycleP50Ms: 1000,
  cycleP95Ms: 5000,
  slopRate: 0.1,
  copycatRate: 0.02,
  ...over,
});

/** Sign a peer bundle the way a real peer's export side does, so a real signature verifies against peerKeys. */
function signedWith(key: string, over: Partial<FederatedSignalBundle> = {}): FederatedSignalBundle {
  const payload = peerBody(over);
  const signature = createHmac("sha256", key).update(canonicalizeFederatedBundleBody(payload)).digest("hex");
  return { ...payload, signature };
}

function fetchReturning(bundles: FederatedSignalBundle[]): typeof fetch {
  return (async () => Response.json(bundles)) as unknown as typeof fetch;
}

describe("buildFederatedBenchmark() — not opted in", () => {
  it("returns null and touches neither the database nor the network for an absent/false manifest", async () => {
    const fetchSpy = vi.fn();
    expect(await buildFederatedBenchmark(manifest({ enabled: false }), untouchableDb(), { fetchFn: fetchSpy })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null for a null manifest", async () => {
    expect(await buildFederatedBenchmark(null, untouchableDb())).toBeNull();
  });
});

describe("buildFederatedBenchmark() — opted in, no peer data yet", () => {
  it("returns local precision with peerCount 0 and a null median when no collector is configured", async () => {
    const db = makeDb();
    for (let pr = 1; pr <= 5; pr++) await resolved(db, pr);

    const result = await buildFederatedBenchmark(manifest({ collectorUrl: null }), db, { now: NOW });

    expect(result).not.toBeNull();
    expect(result?.localMergePrecision).toBe(1);
    expect(result?.peerMedianMergePrecision).toBeNull();
    expect(result?.peerCount).toBe(0);
    expect(result?.generatedAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("returns peerCount 0 when every pulled bundle is rejected by trust-gating (untrusted key)", async () => {
    const db = makeDb();
    for (let pr = 1; pr <= 5; pr++) await resolved(db, pr);
    const fetchFn = fetchReturning([signedWith(UNTRUSTED_KEY)]);

    const result = await buildFederatedBenchmark(manifest({ peerKeys: [PEER_KEY_A] }), db, { now: NOW, fetchFn });

    expect(result?.peerCount).toBe(0);
    expect(result?.peerMedianMergePrecision).toBeNull();
  });

  it("excludes an accepted peer bundle whose own mergePrecision is null (peer below its own MIN_DECIDED)", async () => {
    const db = makeDb();
    for (let pr = 1; pr <= 5; pr++) await resolved(db, pr);
    const fetchFn = fetchReturning([signedWith(PEER_KEY_A, { mergePrecision: null })]);

    const result = await buildFederatedBenchmark(manifest({ peerKeys: [PEER_KEY_A] }), db, { now: NOW, fetchFn });

    expect(result?.peerCount).toBe(0);
    expect(result?.peerMedianMergePrecision).toBeNull();
  });
});

describe("buildFederatedBenchmark() — opted in, local precision below MIN_DECIDED", () => {
  it("reports a null local precision but still computes the peer median", async () => {
    const db = makeDb();
    await resolved(db, 1); // only 1 decided PR, below MIN_DECIDED (5)
    const fetchFn = fetchReturning([signedWith(PEER_KEY_A, { mergePrecision: 0.6 })]);

    const result = await buildFederatedBenchmark(manifest({ peerKeys: [PEER_KEY_A] }), db, { now: NOW, fetchFn });

    expect(result?.localMergePrecision).toBeNull();
    expect(result?.peerMedianMergePrecision).toBe(0.6);
    expect(result?.peerCount).toBe(1);
  });
});

describe("buildFederatedBenchmark() — opted in, real peer comparison", () => {
  it("computes the median (not the mean) across every accepted peer, ignoring an untrusted one mixed in", async () => {
    const db = makeDb();
    for (let pr = 1; pr <= 5; pr++) await resolved(db, pr);
    const fetchFn = fetchReturning([
      signedWith(PEER_KEY_A, { instanceId: "peer-a", mergePrecision: 0.5 }),
      signedWith(PEER_KEY_B, { instanceId: "peer-b", mergePrecision: 0.9 }),
      signedWith(UNTRUSTED_KEY, { instanceId: "peer-attacker", mergePrecision: 0.01 }),
    ]);

    const result = await buildFederatedBenchmark(manifest({ peerKeys: [PEER_KEY_A, PEER_KEY_B] }), db, { now: NOW, fetchFn });

    // Median of [0.5, 0.9] (the untrusted 0.01 is rejected, not merely a low outlier) is 0.5 under this
    // module's nearest-rank percentile(50) (analytics.ts: idx = ceil(0.5*2)-1 = 0) — pinning the real
    // cross-module contract, not a re-derivation.
    expect(result?.peerCount).toBe(2);
    expect(result?.peerMedianMergePrecision).toBe(0.5);
    expect(result?.localMergePrecision).toBe(1);
  });

  it("honors an explicit windowDays override, narrowing the local calibration window", async () => {
    const db = makeDb();
    // Resolved 30 days before `now` — inside the default 90-day window but outside a 7-day override.
    for (let pr = 1; pr <= 5; pr++) {
      await resolved(db, pr, {});
      await db.prepare("UPDATE review_audit SET created_at = '2026-06-16T12:00:00Z' WHERE target_id = ?").bind(`owner/repo#${pr}`).run();
    }

    const wide = await buildFederatedBenchmark(manifest({ collectorUrl: null }), db, { now: NOW, windowDays: 90 });
    const narrow = await buildFederatedBenchmark(manifest({ collectorUrl: null }), db, { now: NOW, windowDays: 7 });

    expect(wide?.localMergePrecision).toBe(1);
    expect(narrow?.localMergePrecision).toBeNull();
  });

  it("uses Date.now() for generatedAt when opts.now is not provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const db = makeDb();
      const result = await buildFederatedBenchmark(manifest({ collectorUrl: null }), db, {});
      expect(result?.generatedAt).toBe("2026-07-16T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
