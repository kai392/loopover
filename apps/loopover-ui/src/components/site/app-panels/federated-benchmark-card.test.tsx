import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FederatedBenchmarkCard } from "@/components/site/app-panels/federated-benchmark-card";
import type { MaintainerFederatedBenchmark } from "@/components/site/app-panels/federated-benchmark-card-model";

function benchmark(
  overrides: Partial<MaintainerFederatedBenchmark> = {},
): MaintainerFederatedBenchmark {
  return {
    localMergePrecision: 0.9,
    peerMedianMergePrecision: 0.8,
    peerCount: 3,
    generatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("FederatedBenchmarkCard", () => {
  it("renders both metrics, peer count, and a positive delta as 'ahead'", () => {
    render(<FederatedBenchmarkCard benchmark={benchmark()} />);
    expect(screen.getByText("Gate precision vs peer median")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("3 peers")).toBeTruthy();
    expect(screen.getByText("+10pp")).toBeTruthy();
    expect(screen.getByText("ahead")).toBeTruthy();
    expect(screen.getByText(/generated/i)).toBeTruthy();
  });

  it("shows singular 'peer' for a peer count of 1", () => {
    render(
      <FederatedBenchmarkCard
        benchmark={benchmark({ peerCount: 1, peerMedianMergePrecision: 0.9 })}
      />,
    );
    expect(screen.getByText("1 peer")).toBeTruthy();
  });

  it("renders a negative delta as 'behind'", () => {
    render(<FederatedBenchmarkCard benchmark={benchmark({ localMergePrecision: 0.6 })} />);
    expect(screen.getByText("-20pp")).toBeTruthy();
    expect(screen.getByText("behind")).toBeTruthy();
  });

  it("shows a dash delta with no tone pill when local precision is null despite real peer data", () => {
    render(<FederatedBenchmarkCard benchmark={benchmark({ localMergePrecision: null })} />);
    expect(screen.getByText("Your gate precision").parentElement?.textContent).toContain("—");
    expect(screen.queryByText("ahead")).toBeNull();
    expect(screen.queryByText("behind")).toBeNull();
  });

  it("renders the empty state when opted in but no peer has contributed a value yet", () => {
    render(
      <FederatedBenchmarkCard
        benchmark={benchmark({ peerCount: 0, peerMedianMergePrecision: null })}
      />,
    );
    expect(screen.getByText("No peer data yet")).toBeTruthy();
    expect(screen.getByText(/no trust-gated peer bundle has contributed/i)).toBeTruthy();
    expect(screen.queryByText("90%")).toBeNull();
  });
});
