import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { execution } from "../src/auth/execution.ts";
import { putUserSecret } from "../src/auth/secrets.ts";
import { createUser } from "../src/auth/users.ts";
import { decide, decideBash, isSecretPath } from "../src/agent/toolPolicy.ts";
import { config } from "../src/config.ts";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { prepareBranch } from "../src/git.ts";
import { gitProviderFor } from "../src/git/provider.ts";
import { openGithubPullRequest } from "../src/github.ts";
import {
  assertSelfCodingIsolation,
  commandProcessEnv,
  liveApplicationRoot,
  overlapsLiveApplication,
  resetSelfRepositoryCache,
  setBwrapForTests,
} from "../src/platform/selfDevelopment.ts";
import {
  requireRepositoryAccess,
  setGithubPermissionChecker,
  setRepositoryAccess,
} from "../src/repos/access.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { applyProfile } from "../src/workflow/profiles.ts";
import { safeRecovery } from "../src/workflow/recovery.ts";
import { workItems } from "../src/workitems/service.ts";

const PLATFORM_URL = "https://github.com/bhtoan2204/hasaki-agentic-engineering-platform.git";

after(() => pool.end());

test("self-development registers GitHub, isolates the live tree and stays recoverable", async () => {
  await migrate();
  await seedTemplates();
  const saved = {
    platform: { ...config.platform },
    github: { ...config.github },
    fetch: globalThis.fetch,
  };
  try {
    const stamp = Date.now();
    const admin = await createUser({
      username: `sd-admin-${stamp}`,
      password: "pw-12345678",
      role: "admin",
    });
    const member = await createUser({
      username: `sd-member-${stamp}`,
      password: "pw-12345678",
      role: "member",
    });
    const stranger = await createUser({
      username: `sd-stranger-${stamp}`,
      password: "pw-12345678",
      role: "member",
    });
    const repo = (await repositories.upsert(`platform-self-${stamp}`, {
      repository_url: "https://github.com/bhtoan2204/hasaki-agentic-engineering-platform",
      default_branch: "main",
      category: "Platform / Internal Tooling",
      enabled: true,
    }))!;
    assert.equal(repo.provider, "github");
    assert.equal(repo.repository_url, PLATFORM_URL);
    assert.equal(repo.category, "Platform / Internal Tooling");

    config.platform.repositoryUrl = PLATFORM_URL;
    config.github.allowSharedCredentials = false;
    resetSelfRepositoryCache();
    setGithubPermissionChecker(async () => ({
      state: "verified",
      can_read: true,
      can_write: true,
      reason: "verified",
    }));
    await putUserSecret(member.id, "github_token", "gh-test");

    await assert.rejects(
      () => requireRepositoryAccess(admin.id, repo.name, "read"),
      (error: { status?: number }) => error.status === 404,
    );
    await setRepositoryAccess(repo, member.id, "pull_request", admin.id);
    const granted = await requireRepositoryAccess(member.id, repo.name, "pull_request", {
      verify: true,
    });
    assert.equal(granted.access.effective.pull_request, true);

    const item = await workItems.createManual({
      title: "Optimize workflow execution",
      description: "Reduce unnecessary test execution.",
      ownerId: member.id,
    });
    const implied = await startRun({
      definitionKey: "platform-self-development",
      workItemId: item.id,
      ownerId: member.id,
      start: false,
      profile: "STANDARD",
    });
    assert.deepEqual(implied.selected_repositories, [repo.name]);
    assert.equal(
      implied.steps.find((step) => step.key === "confirm_repos")?.config.auto_approve_preselected,
      true,
    );

    const started = await startRun({
      definitionKey: "platform-self-development",
      workItemId: item.id,
      ownerId: member.id,
      repositories: [repo.name],
      start: false,
      profile: "STANDARD",
    });
    assert.equal(started.status, "PENDING");
    const keys = new Set(started.steps.map((step) => step.key));
    for (const key of ["analyze", "implement", "targeted_test", "review", "regression_test", "pr"])
      assert.equal(keys.has(key), true, key);
    assert.equal(started.steps.find((step) => step.key === "review")?.config.independent, true);

    const foreign = await workItems.createManual({
      title: "Unauthorized self-development",
      ownerId: stranger.id,
    });
    await assert.rejects(
      () =>
        startRun({
          definitionKey: "platform-self-development",
          workItemId: foreign.id,
          ownerId: stranger.id,
          repositories: [repo.name],
          start: false,
        }),
      /not accessible/,
    );

    const live = liveApplicationRoot();
    assert.ok(live);
    assert.equal(overlapsLiveApplication(live), true);
    await assert.rejects(
      () => prepareBranch("self", "live", "u1-self", "live", { checkoutPath: live }),
      /running application checkout/,
    );

    const name = `selfseed-${stamp}`;
    const repoPath = join(config.reposRoot, name);
    const origin = join(config.reposRoot, `${name}.git`);
    const sh = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Self",
          GIT_AUTHOR_EMAIL: "self@example.com",
          GIT_COMMITTER_NAME: "Self",
          GIT_COMMITTER_EMAIL: "self@example.com",
        },
      });
    execFileSync("git", ["init", "-q", "--bare", "-b", config.baseBranch, origin]);
    mkdirSync(repoPath);
    sh(repoPath, "init", "-q", "-b", config.baseBranch);
    writeFileSync(join(repoPath, "README.md"), "seed\n");
    sh(repoPath, "add", "README.md");
    sh(repoPath, "commit", "-qm", "seed");
    sh(repoPath, "remote", "add", "origin", origin);
    sh(repoPath, "push", "-q", "origin", config.baseBranch);
    const branch = "u9-platform-self";
    const first = await prepareBranch("self-code", name, branch, name, {
      skipFetch: true,
      defaultBranch: config.baseBranch,
    });
    const second = await prepareBranch("self-code", name, branch, name, {
      skipFetch: true,
      defaultBranch: config.baseBranch,
    });
    assert.equal(first.path, second.path);
    assert.equal(second.createdFrom, "existing worktree");
    assert.equal(first.path.startsWith(repoPath), false);
    assert.equal(sh(repoPath, "rev-parse", "--verify", branch).length > 0, true);

    const policy = {
      mode: "coding" as const,
      workspaces: [first.path],
      protectedRoots: [live],
      baseBranch: config.baseBranch,
    };
    assert.equal(
      decide("Write", { file_path: join(live, "src/agent/toolPolicy.ts") }, policy).allow,
      false,
    );
    assert.equal(decide("Write", { file_path: join(first.path, "src/ok.ts") }, policy).allow, true);
    assert.equal(decideBash("echo secret > src/pwn.ts", policy, live).allow, false);
    assert.equal(decideBash(`git -C ${live} reset --hard`, policy, first.path).allow, false);
    assert.equal(decideBash(`git -C ${live} clean -fd`, policy, first.path).allow, false);
    assert.equal(isSecretPath(".env"), true);
    assert.equal(isSecretPath(".env.example"), false);
    assert.equal(decide("Read", { file_path: join(live, ".env") }, policy, live).allow, false);

    sh(repoPath, "remote", "set-url", "origin", PLATFORM_URL);
    setBwrapForTests(null);
    config.platform.trustedOperatorIsolation = false;
    await assert.rejects(
      () => commandProcessEnv(repoPath, {}),
      /trustedOperatorIsolation|bubblewrap/,
    );
    config.platform.trustedOperatorIsolation = true;
    process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt";
    const isolated = await commandProcessEnv(repoPath, {});
    delete process.env.NODE_EXTRA_CA_CERTS;
    assert.equal(isolated.env.NODE_EXTRA_CA_CERTS, "/etc/ssl/certs/ca-certificates.crt");
    assert.equal("DATABASE_URL" in isolated.env, false);
    assert.equal("AUTH_SECRET" in isolated.env, false);
    assert.equal(isolated.env.TEST_DATABASE_ADMIN_URL?.endsWith("/platform"), false);
    assert.equal(isolated.isolation?.mode, "trusted");
    assert.equal(overlapsLiveApplication(repoPath), false);

    config.platform.trustedOperatorIsolation = false;
    assert.throws(() => assertSelfCodingIsolation("claude"), /trustedOperatorIsolation/);
    assert.doesNotThrow(() => assertSelfCodingIsolation("codex"));

    assert.equal(safeRecovery({ type: "coding_agent", config: {} }), false);
    assert.equal(safeRecovery({ type: "command", config: {} }), false);
    assert.equal(
      safeRecovery({ type: "integration", config: { action: "repository_discovery" } }),
      true,
    );

    let pulls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const target = String(url);
      const auth = new Headers(init?.headers).get("authorization");
      assert.equal(auth, "Bearer gh-test");
      if (method === "GET" && target.includes("/pulls?")) {
        pulls += 1;
        const body =
          pulls === 1 ? [] : [{ number: 7, html_url: "https://github.com/acme/app/pull/7" }];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (method === "POST" || method === "PATCH")
        return new Response(JSON.stringify({ html_url: "https://github.com/acme/app/pull/7" }), {
          status: method === "POST" ? 201 : 200,
        });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const [created, updated] = await execution.run(
      { userId: member.id, kind: "user" },
      async () => {
        const firstPr = await openGithubPullRequest("acme/app", branch, "Self", "body");
        const secondPr = await openGithubPullRequest("acme/app", branch, "Self", "body");
        return [firstPr, secondPr] as const;
      },
    );
    assert.equal(created.created, true);
    assert.equal(updated.created, false);
    assert.equal(updated.url, "https://github.com/acme/app/pull/7");

    const feature = (await definitions.version("feature-implementation"))!;
    assert.notEqual(feature.spec.execution_mode, "self_development");
    assert.equal(
      feature.spec.steps.some((step) => step.type === "git_pull_request"),
      true,
    );
    const self = (await definitions.version("platform-self-development"))!;
    assert.equal(self.spec.execution_mode, "self_development");
    const fast = applyProfile(self.spec, "FAST");
    assert.equal(
      fast.spec.steps.some((step) => step.key === "review"),
      true,
    );
    assert.equal(
      fast.spec.steps.some((step) => step.key === "regression_test"),
      true,
    );
    assert.equal(gitProviderFor("github").name, "github");
    assert.equal(gitProviderFor("bitbucket").name, "bitbucket");
  } finally {
    config.platform = saved.platform;
    config.github = saved.github;
    globalThis.fetch = saved.fetch;
    resetSelfRepositoryCache();
    setGithubPermissionChecker(null);
  }
});
