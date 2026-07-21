import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7763: in-process coverage for the loopover_watch_issues stdio tool.
// Same entrypoint-guard pattern as mcp-cli-repo-focus-manifest — import .ts, hold exported `server`,
// connect InMemoryTransport so v8/Codecov attributes registerStdioTool + manageIssueWatches.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const captured: Array<{ method: string; url: string; body?: unknown }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-watch-issues-"));
  const apiUrl = await startFixtureServer({
    onWatchRequest: ({ method, body }) => {
      captured.push({ method, url: "/v1/contributors/miner/watches", body });
    },
    onApiRequest: (request) => {
      const url = request.url ?? "";
      if (url.includes("/watches") && request.method === "GET") {
        captured.push({ method: "GET", url });
      }
    },
  });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  for (const specifier of MODULES) {
    loaded.set(specifier, (await import(specifier)) as unknown as BinModule);
  }
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_watch_issues stdio tool (in-process, #7763)", () => {
  it.each(MODULES)("registers and proxies list/watch/unwatch — %s", async (specifier) => {
    captured.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "watch-issues-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_watch_issues");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/watch repos|grabbable/i);

      const listResult = await client.callTool({
        name: "loopover_watch_issues",
        arguments: { login: "miner", action: "list" },
      });
      expect(listResult.isError).toBeFalsy();
      expect(JSON.stringify(listResult)).toContain("acme/widgets");
      expect(captured.some((row) => row.method === "GET")).toBe(true);

      captured.length = 0;
      const defaultList = await client.callTool({
        name: "loopover_watch_issues",
        arguments: { login: "miner" },
      });
      expect(defaultList.isError).toBeFalsy();
      expect(captured.some((row) => row.method === "GET")).toBe(true);

      captured.length = 0;
      const watchResult = await client.callTool({
        name: "loopover_watch_issues",
        arguments: {
          login: "miner",
          action: "watch",
          repoFullName: "acme/widgets",
          labels: ["bug"],
        },
      });
      expect(watchResult.isError).toBeFalsy();
      expect(JSON.stringify(watchResult)).toMatch(/watching|Watching/);
      expect(captured).toEqual([
        {
          method: "POST",
          url: "/v1/contributors/miner/watches",
          body: { repoFullName: "acme/widgets", labels: ["bug"] },
        },
      ]);

      captured.length = 0;
      const watchNoLabels = await client.callTool({
        name: "loopover_watch_issues",
        arguments: { login: "miner", action: "watch", repoFullName: "acme/gadgets" },
      });
      expect(watchNoLabels.isError).toBeFalsy();
      expect(captured).toEqual([
        {
          method: "POST",
          url: "/v1/contributors/miner/watches",
          body: { repoFullName: "acme/gadgets" },
        },
      ]);

      captured.length = 0;
      const missingRepo = await client.callTool({
        name: "loopover_watch_issues",
        arguments: { login: "miner", action: "watch" },
      });
      expect(missingRepo.isError).toBeTruthy();

      captured.length = 0;
      const unwatchResult = await client.callTool({
        name: "loopover_watch_issues",
        arguments: { login: "miner", action: "unwatch", repoFullName: "acme/widgets" },
      });
      expect(unwatchResult.isError).toBeFalsy();
      expect(JSON.stringify(unwatchResult)).toMatch(/unwatched|Watching/);
      expect(captured).toEqual([
        {
          method: "DELETE",
          url: "/v1/contributors/miner/watches",
          body: { repoFullName: "acme/widgets" },
        },
      ]);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
