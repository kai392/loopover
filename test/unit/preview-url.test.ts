import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGitHubResponseCacheForTest, githubRateLimitAdmissionKeyForInstallation, latestGitHubRestRateLimitObservation } from "../../src/github/client";
import { extractPreviewUrl, getPreviewBuildState } from "../../src/review/visual/preview-url";

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("preview-url GitHub reads", () => {
  it("records REST admission telemetry only for installation-token preview lookups", async () => {
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { check_runs: [] },
        {
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
          },
        },
      ),
    );

    await expect(
      getPreviewBuildState({ token: "dummy-user-token", repo: { owner: "o", repo: "r" }, sha: "abc123" }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toBeNull();

    await expect(
      getPreviewBuildState({
        token: "dummy-installation-token",
        repo: { owner: "o", repo: "r" },
        sha: "abc123",
        rateLimitAdmissionKey: key,
      }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 42,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
    });
  });
});

describe("extractPreviewUrl", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("returns null for falsy input (%s)", (_label, input) => {
    expect(extractPreviewUrl(input)).toBeNull();
  });

  it("returns null when the text contains no URL at all", () => {
    expect(extractPreviewUrl("deploy is still pending, no link yet")).toBeNull();
  });

  it("returns null when the only URL is not a Cloudflare-preview host", () => {
    expect(extractPreviewUrl("see https://github.com/acme/widgets for details")).toBeNull();
  });

  it("skips a malformed URL-like substring that throws in new URL(...) and falls through to null", () => {
    // `http://[` matches the URL regex but throws inside `new URL(...)` (unterminated IPv6 host),
    // so the catch arm is taken and the scan falls through to null (#5848).
    expect(extractPreviewUrl("preview: http://[ oops")).toBeNull();
  });

  it("skips a malformed URL and still returns a later valid preview match", () => {
    // The malformed substring hits the catch arm, then the loop continues to the valid host.
    expect(extractPreviewUrl("http://[ then https://pr-1.app.workers.dev/route")).toBe(
      "https://pr-1.app.workers.dev",
    );
  });

  it("returns the base origin for a *.workers.dev link, dropping the path and query", () => {
    expect(extractPreviewUrl("build ready at https://pr-12.myapp.workers.dev/some/path?x=1")).toBe(
      "https://pr-12.myapp.workers.dev",
    );
  });

  it("returns the base origin for a *.pages.dev link", () => {
    expect(extractPreviewUrl("https://feature-x.docs.pages.dev")).toBe("https://feature-x.docs.pages.dev");
  });

  it("skips a non-preview URL that precedes the matching one (multi-match ordering)", () => {
    expect(
      extractPreviewUrl("https://github.com/acme/widgets/pull/7 and https://pr-3.site.pages.dev/preview"),
    ).toBe("https://pr-3.site.pages.dev");
  });
});
