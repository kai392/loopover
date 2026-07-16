import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv as rawCreateTestEnv } from "../helpers/d1";

// The self-dogfood route resolves its target repo via resolveLoopOverSelfRepoFullName(env), which reads
// LOOPOVER_DRIFT_ISSUE_REPO -- createTestEnv()'s own default deliberately does NOT match any real repo
// name (to avoid leaking the bundled self-repo manifest into unrelated tests elsewhere), so pin it here
// to the real current self-repo identity these tests are actually about.
const SELF_REPO = "JSONbored/loopover";
function createTestEnv(overrides: Partial<Env> = {}): Env {
  return rawCreateTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO, ...overrides });
}

const SELF_DOGFOOD_PATH = "/v1/repos/JSONbored/loopover/self-dogfood-registration-pack";
const APP_SELF_DOGFOOD_PATH = "/v1/app/self-dogfood/registration-pack";

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`,
    "content-type": "application/json",
  };
}

async function seedInstalledRepo(env: Env, installationId: number, owner: string, name: string): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", contents: "read" },
      events: ["repository"],
    },
  });
  await upsertRepositoryFromGitHub(
    env,
    { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } },
    installationId,
  );
}

describe("self-dogfood registration-pack route auth", () => {
  it("rejects unauthenticated access to the repo-scoped route", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(SELF_DOGFOOD_PATH, {}, env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects unauthorized session access to the repo-scoped route", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "new-user", id: 2468 });
    const response = await app.request(SELF_DOGFOOD_PATH, { headers: { cookie: `loopover_session=${token}` } }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("rejects wrong-repo access after role check", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const response = await app.request(
      "/v1/repos/other/repo/self-dogfood-registration-pack",
      { headers: { cookie: `loopover_session=${token}` } },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "self_dogfood_repo_only", repoFullName: "JSONbored/loopover" });
  });

  it("rejects app-route sessions scoped only to an unrelated installed repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedInstalledRepo(env, 201, "JSONbored", "loopover");
    await seedInstalledRepo(env, 202, "unrelated-owner", "unrelated-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "unrelated-owner", id: 202 });
    const response = await app.request(APP_SELF_DOGFOOD_PATH, { headers: { cookie: `loopover_session=${token}` } }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });

  it("allows app-route sessions scoped to the configured self-dogfood repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedInstalledRepo(env, 201, "JSONbored", "loopover");
    const { token } = await createSessionForGitHubUser(env, { login: "JSONbored", id: 201 });
    const response = await app.request(APP_SELF_DOGFOOD_PATH, { headers: { cookie: `loopover_session=${token}` } }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "loopover_self_dogfood_registration_pack",
      repoFullName: "JSONbored/loopover",
      privateOnly: true,
    });
  });

  it("allows static-token access to the configured self-dogfood repo", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(SELF_DOGFOOD_PATH, { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "loopover_self_dogfood_registration_pack",
      repoFullName: "JSONbored/loopover",
      privateOnly: true,
      advisoryOnly: true,
    });
  });
});
