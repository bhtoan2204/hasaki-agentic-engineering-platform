/**
 * User-scoped repository access (migration 045, src/repos/access.ts).
 * Admin (no grants), user A → repo A, user B → repo B, repo C shared for reading. All three have Bitbucket remotes;
 * Bitbucket is answered by a test checker that says each member can see their own repository and repo C.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { config } from "../src/config.ts";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { seedKnowledge, knowledge } from "../src/knowledge/service.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { putUserSecret } from "../src/auth/secrets.ts";
import { repositories } from "../src/repos/service.ts";
import {
  allowedRepositoriesForRun,
  assertRunScopeReadable,
  enforceRunRepositoryAccess,
  listAccessibleRepositories,
  requireRunRepositoryAccess,
  resolveEffectiveRepositoryPermissions,
  setBitbucketPermissionChecker,
} from "../src/repos/access.ts";
import { selectRepositories, startRun, retryStep, getRun } from "../src/workflow/engine.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import { recordWorkspace } from "../src/git/provider.ts";

let server: Server;
let base = "";
const ids: Record<string, number> = {};
type Call = (path: string, body?: unknown) => Promise<{ status: number; body: any }>;
let admin: Call, A: Call, B: Call;
let bitbucketCalls = 0;

async function login(username: string, password: string): Promise<Call> {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { csrf } = await r.json();
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrf }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}
const names = (rows: any[]) => rows.map((r) => r.name ?? r.repo).sort();
const register = (name: string, extra: Record<string, unknown> = {}) =>
  repositories.upsert(name, { repository_url: `https://bitbucket.org/hasaki/${name}.git`, projects: ["ACL"], description: `${name} service`, tags: [name], ...extra });

before(async () => {
  await migrate();
  await seedTemplates();
  await seedKnowledge();
  for (const [u, role] of [["acl-admin", "admin"], ["acl-a", "member"], ["acl-b", "member"]] as const)
    ids[u] = Number((await createUser({ username: u, password: `${u}-password`, role })).id);
  for (const u of ["acl-a", "acl-b"]) {
    await putUserSecret(ids[u], "bitbucket_user", `${u}@hasaki.vn`);
    await putUserSecret(ids[u], "bitbucket_token", `${u}-token`);
  }
  await register("repo-a", { dependencies: ["repo-b", "repo-c"] });
  await register("repo-b");
  await register("repo-c");
  // What Bitbucket says about each member's own token.
  setBitbucketPermissionChecker(async (creds, _ws, slug) => {
    bitbucketCalls++;
    const own = creds.user.startsWith("acl-a") ? "repo-a" : "repo-b";
    if (slug === own || slug === "repo-c") return { state: "verified", can_read: true, can_write: true, reason: "test" };
    return { state: "denied", can_read: false, can_write: false, reason: "test: no access" };
  });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  admin = await login("acl-admin", "acl-admin-password");
  A = await login("acl-a", "acl-a-password");
  B = await login("acl-b", "acl-b-password");
});

after(async () => {
  setBitbucketPermissionChecker(null);
  server.close();
  await pool.end();
});

beforeEach(() => {
  config.bitbucket.accessVerification = "strict";
});

test("10. migration: registry metadata is kept, nothing is shared and nobody is granted anything implicitly", async () => {
  const a = (await repositories.get("repo-a"))!;
  assert.equal(a.description, "repo-a service");
  assert.deepEqual(a.tags, ["repo-a"]);
  assert.equal(a.shared_access, "none");
  assert.equal(Number((await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM user_repository_access"))!.n), 0);
  assert.deepEqual(await listAccessibleRepositories(ids["acl-admin"]), [], "an admin role is not a grant");
  assert.deepEqual(await listAccessibleRepositories(ids["acl-a"]), []);
});

test("9. admin manages grants and shared access through the API, with an audit trail; members cannot", async () => {
  assert.equal((await A("/api/repositories/repo-a/access", { user_id: ids["acl-a"], level: "write" })).status, 403);
  assert.equal((await A("/api/repository-access")).status, 403);
  assert.equal((await admin("/api/repositories/repo-a/access", { user_id: ids["acl-a"], level: "pull_request" })).status, 200);
  assert.equal((await admin("/api/repositories/repo-b/access", { user_id: ids["acl-b"], level: "write" })).status, 200);
  assert.equal((await admin("/api/repositories/repo-c/shared", { level: "read" })).status, 200);
  assert.equal((await admin("/api/repositories/repo-a/access", { user_id: ids["acl-a"], level: "owner" })).status, 400);
  assert.equal((await admin("/api/repositories/nope/access", { user_id: ids["acl-a"], level: "read" })).status, 404);
  const m = (await admin("/api/repository-access")).body;
  assert.equal(m.policy, "strict");
  const grant = (repo: string, user: string) => m.grants.find((g: any) => g.repository_id === m.repositories.find((r: any) => r.name === repo).id && g.user_id === ids[user])?.level;
  assert.equal(grant("repo-a", "acl-a"), "pull_request");
  assert.equal(grant("repo-b", "acl-b"), "write");
  assert.equal(m.repositories.find((r: any) => r.name === "repo-c").shared_access, "read");
  const audit = (await admin("/api/repository-access/audit?repository=repo-a")).body;
  assert.ok(audit.some((x: any) => x.action === "repository.access.grant" && x.actor === "acl-admin" && x.detail.after === "pull_request"));
  // registration never grants or shares
  assert.equal((await admin("/api/repositories/repo-d", { repository_url: "https://bitbucket.org/hasaki/repo-d.git", shared_access: "read", projects: ["ACL"] })).status, 200);
  assert.equal((await repositories.get("repo-d"))!.shared_access, "none");
});

test("9. checkboxes and bulk: independent read/write/PR flags normalize to a level; one user on many repositories", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ read: true }, "read"],
    [{ read: true, write: true }, "write"],
    [{ read: true, write: true, pull_request: true }, "pull_request"],
    [{ pull_request: true }, "pull_request"], // a PR needs a pushed branch: implies write and read
    [{ read: false, write: false, pull_request: false }, "none"],
  ];
  for (const [flags, level] of cases) {
    const r = await admin("/api/repositories/repo-d/access", { user_id: ids["acl-b"], ...flags });
    assert.equal(r.status, 200, JSON.stringify(flags));
    assert.equal(r.body.after, level, JSON.stringify(flags));
  }
  assert.equal((await admin("/api/repositories/repo-d/access", { user_id: ids["acl-b"], write: "yes" })).status, 400);
  assert.equal((await A("/api/repository-access/bulk", { user_id: ids["acl-a"], level: "pull_request" })).status, 403);
  const bulk = await admin("/api/repository-access/bulk", { user_id: ids["acl-b"], level: "pull_request", repositories: ["repo-b", "repo-d"] });
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.body.repositories.sort(), ["repo-b", "repo-d"]);
  assert.equal((await admin("/api/repository-access/bulk", { user_id: ids["acl-b"], level: "read", repositories: ["nope"] })).status, 404);
  const m = (await admin("/api/repository-access")).body;
  const level = (repo: string) => m.grants.find((g: any) => g.user_id === ids["acl-b"] && g.repository_id === m.repositories.find((r: any) => r.name === repo).id)?.level;
  assert.equal(level("repo-b"), "pull_request");
  assert.equal(level("repo-d"), "pull_request");
  assert.ok((await admin("/api/repository-access/audit")).body.some((x: any) => x.action === "repository.access.bulk"));
  // restore what later tests expect
  await admin("/api/repositories/repo-b/access", { user_id: ids["acl-b"], level: "write" });
  await admin("/api/repositories/repo-d/access", { user_id: ids["acl-b"], level: "none" });
});

test("1/12. members see only their repositories; others are 404 everywhere; the admin manages without reading", async () => {
  assert.deepEqual(names((await A("/api/repositories")).body), ["repo-a", "repo-c"]);
  assert.deepEqual(names((await B("/api/repositories")).body), ["repo-b", "repo-c"]);
  assert.deepEqual(names((await admin("/api/repositories")).body), [], "My Repositories of an admin without grants");
  assert.ok(names((await admin("/api/repositories?manage=1")).body).includes("repo-b"), "management view lists the registry");
  assert.equal((await A("/api/repositories?manage=1")).status, 403);
  const mine = (await A("/api/repositories")).body.find((r: any) => r.name === "repo-a");
  assert.equal(mine.access.level, "pull_request");
  assert.equal(mine.access.bitbucket.state, "verified");
  assert.deepEqual(mine.dependencies, ["repo-c"], "a dependency on an inaccessible repository is not disclosed");
  assert.equal((await A("/api/repositories")).body.find((r: any) => r.name === "repo-c").access.source, "shared");
  for (const path of ["/api/repositories/repo-b", "/api/repositories/repo-b/workspace", "/api/repositories/does-not-exist"]) assert.equal((await A(path)).status, 404, path);
  for (const action of ["test-connection", "prepare", "refresh"]) assert.equal((await A(`/api/repositories/repo-b/${action}`, {})).status, 404, action);
  assert.equal((await A("/api/repositories/repo-a")).status, 200);
  assert.equal((await admin("/api/repositories/repo-a")).status, 404, "managing access is not reading the repository");
});

test("Bitbucket checks are cached per user (no call per request) and revalidation forces a new check", async () => {
  const before = bitbucketCalls;
  await A("/api/repositories");
  await A("/api/repositories");
  assert.equal(bitbucketCalls, before, "within the TTL the list never calls Bitbucket");
  const r = await A("/api/repository-access/revalidate", {});
  assert.equal(r.status, 200);
  assert.ok(bitbucketCalls > before);
  assert.equal((await A("/api/repository-access/revalidate", { user_id: ids["acl-b"] })).status, 403, "a member revalidates only themselves");
});

test("3 + Bitbucket: the user's own Bitbucket answer limits a platform grant (denied stays denied)", async () => {
  // grant B on repo-a: the platform says yes, B's Bitbucket token says no → no access
  await admin("/api/repositories/repo-a/access", { user_id: ids["acl-b"], level: "write" });
  const p = await resolveEffectiveRepositoryPermissions(ids["acl-b"], "repo-a", { verify: true });
  assert.equal(p!.platform.level, "write");
  assert.equal(p!.bitbucket.state, "denied");
  assert.equal(p!.effective.read, false);
  assert.ok(!names((await B("/api/repositories")).body).includes("repo-a"));
  await admin("/api/repositories/repo-a/access", { user_id: ids["acl-b"], level: "none" });
});

test("7. shared credentials never stand in for a user's own permission; only the explicit trust policy does", async () => {
  const saved = { ...config.bitbucket };
  const admUser = ids["acl-admin"];
  try {
    config.bitbucket.user = "service@hasaki.vn";
    config.bitbucket.token = "service-token";
    config.bitbucket.allowSharedCredentials = true;
    await admin("/api/repositories/repo-a/access", { user_id: admUser, level: "read" });
    const strict = await resolveEffectiveRepositoryPermissions(admUser, "repo-a", { verify: true });
    assert.equal(strict!.bitbucket.state, "unknown", "no personal credentials: unknown, not verified");
    assert.equal(strict!.effective.read, false, "unknown is never upgraded to allowed");
    config.bitbucket.accessVerification = "trusted";
    const trusted = await resolveEffectiveRepositoryPermissions(admUser, "repo-a");
    assert.equal(trusted!.bitbucket.state, "trusted");
    assert.equal(trusted!.effective.read, true);
    assert.equal(trusted!.effective.write, false, "still bounded by the platform grant (read)");
  } finally {
    Object.assign(config.bitbucket, saved);
    await admin("/api/repositories/repo-a/access", { user_id: admUser, level: "none" });
  }
});

test("write that Bitbucket does not report: strict refuses it, the personal policy relies on Bitbucket enforcing it", async () => {
  setBitbucketPermissionChecker(async (creds, _ws, slug) => {
    const own = creds.user.startsWith("acl-a") ? "repo-a" : "repo-b";
    return slug === own || slug === "repo-c" ? { state: "verified", can_read: true, can_write: null, reason: "read only reported" } : { state: "denied", can_read: false, can_write: false, reason: "" };
  });
  try {
    await A("/api/repository-access/revalidate", {});
    const strict = await resolveEffectiveRepositoryPermissions(ids["acl-a"], "repo-a");
    assert.deepEqual(strict!.effective, { read: true, write: false, pull_request: false });
    config.bitbucket.accessVerification = "personal";
    const personal = await resolveEffectiveRepositoryPermissions(ids["acl-a"], "repo-a");
    assert.deepEqual(personal!.effective, { read: true, write: true, pull_request: true });
  } finally {
    setBitbucketPermissionChecker(async (creds, _ws, slug) => {
      const own = creds.user.startsWith("acl-a") ? "repo-a" : "repo-b";
      if (slug === own || slug === "repo-c") return { state: "verified", can_read: true, can_write: true, reason: "test" };
      return { state: "denied", can_read: false, can_write: false, reason: "test: no access" };
    });
    await A("/api/repository-access/revalidate", {});
  }
});

test("2. ranking never returns a repository the caller cannot access", async () => {
  const r = await A("/api/repositories/rank", { text: "repo-b service repo-a repo-c", project: "ACL" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.ranked.map((x: any) => x.repo).sort(), ["repo-a", "repo-c"]);
  const unmapped = await A("/api/repositories/rank", { text: "repo-b", project: "" });
  assert.ok(!unmapped.body.ranked.some((x: any) => x.repo === "repo-b"), "no project mapping never widens to every repository");
  assert.deepEqual((await allowedRepositoriesForRun(ids["acl-admin"], "ACL")).sort(), [], "nor for an admin without grants");
});

test("3/6. runs: unauthorized names are refused at creation, preview, selection and through workflow inputs", async () => {
  const wi = (await A("/api/work-items", { title: "acl", project: "ACL" })).body;
  for (const body of [
    { workflow: "bug-investigation", work_item_id: wi.id, start: false, repositories: ["repo-b"] },
    { workflow: "bug-investigation", work_item_id: wi.id, start: false, inputs: { repositories: ["repo-b"] } },
    { workflow: "bug-investigation", work_item_id: wi.id, start: false, repositories: ["does-not-exist"] },
  ]) {
    const r = await A("/api/runs", body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.doesNotMatch(r.body.error, /repo-c|allowed:/, "the refusal does not list other repositories");
  }
  assert.equal((await A("/api/runs/preview", { workflow: "bug-investigation", work_item_id: wi.id, repositories: ["repo-b"] })).status, 403);
  const run = (await A("/api/runs", { workflow: "bug-investigation", work_item_id: wi.id, start: false, repositories: ["repo-a"] })).body;
  assert.deepEqual([...run.allowed_repositories].sort(), ["repo-a", "repo-c"], "scope = own repositories mapped to the project");
  assert.deepEqual(run.selected_repositories, ["repo-a"], "selection persisted for traceability");
  assert.equal((await A(`/api/runs/${run.id}/repositories`, { repositories: ["repo-b"] })).status, 400);
  await assert.rejects(selectRepositories(run.id, ["repo-b"]), /outside the allowed set/);
  // B cannot reach A's run at all
  assert.equal((await B(`/api/runs/${run.id}/repositories`, { repositories: ["repo-b"] })).status, 404);
});

test("4. agent tool scope: a repository the owner cannot read is rejected, by name or after revocation", async () => {
  await assert.rejects(assertRunScopeReadable(ids["acl-a"], ["repo-a", "repo-b"]), /revoked: repo-b/);
  await assertRunScopeReadable(ids["acl-a"], ["repo-a", "repo-c"]);
  const wi = (await A("/api/work-items", { title: "tools", project: "ACL" })).body;
  const run = (await A("/api/runs", { workflow: "bug-investigation", work_item_id: wi.id, start: false, repositories: ["repo-a"] })).body;
  await assert.rejects(requireRunRepositoryAccess(run.id, "repo-b", "read"), /outside run scope/);
  await requireRunRepositoryAccess(run.id, "repo-a", "pull_request");
});

test("8/11. revocation reaches existing runs: scope narrows, the step stops, writes and diffs are refused", async () => {
  const wi = (await A("/api/work-items", { title: "revoke", project: "ACL" })).body;
  const run = (await A("/api/runs", { workflow: "bug-investigation", work_item_id: wi.id, start: false, repositories: ["repo-a"] })).body;
  await recordWorkspace(run.id, { repo: "repo-a", branch: "wf/x", path: "/nonexistent/acl-a", created_from: "main" });
  const changesBefore = (await A(`/api/runs/${run.id}/changes`)).body;
  assert.ok(!changesBefore.repos?.[0]?.restricted);

  await admin("/api/repositories/repo-a/access", { user_id: ids["acl-a"], level: "none" });
  await admin("/api/repositories/repo-c/shared", { level: "none" });
  assert.ok(!names((await A("/api/repositories")).body).includes("repo-a"), "cached results were invalidated");
  await assert.rejects(requireRunRepositoryAccess(run.id, "repo-a", "write"), /revoked|insufficient/);
  await assert.rejects(assertRunScopeReadable(ids["acl-a"], run.allowed_repositories), /revoked: repo-a/);

  const row = await one<any>(pool, "SELECT id, owner_id, allowed_repositories, selected_repositories, inputs FROM workflow_runs WHERE id = $1", [run.id]);
  const scope = await enforceRunRepositoryAccess(row);
  assert.deepEqual(scope, { revoked: ["repo-a", "repo-c"], blocked: ["repo-a"], added: [], changed: true }, "a selected repository was revoked: the step must stop");
  assert.deepEqual(
    (await one<any>(pool, "SELECT allowed_repositories FROM workflow_runs WHERE id = $1", [run.id]))!.allowed_repositories,
    ["repo-a"],
    "the unselected revoked repository leaves the scope; the selected one stays recorded but blocked",
  );
  assert.ok(await one(pool, "SELECT 1 FROM workflow_events WHERE run_id = $1 AND content LIKE 'repository access revoked%'", [run.id]));

  const changes = (await A(`/api/runs/${run.id}/changes`)).body;
  assert.deepEqual(changes.repos.map((r: any) => [r.repo, r.restricted]), [["repo-a", true]], "history kept, code withheld");
  assert.equal((await admin(`/api/runs/${run.id}/changes?scope=all`)).body.repos[0].restricted, true, "support view needs read access too");
  await admin("/api/repositories/repo-a/access", { user_id: ids["acl-a"], level: "pull_request" });
  await admin("/api/repositories/repo-c/shared", { level: "read" });
});

test("8. a queued step of an existing run stops before executing once its selected repository is revoked; re-grant + retry resumes", async () => {
  let executed = 0;
  registerExecutor("agent", { execute: async () => (executed++, { kind: "completed", output: { ok: true } }) });
  await definitions.create({ key: "acl-one-step", ownerId: ids["acl-a"], spec: { name: "acl one step", steps: [{ key: "look", type: "agent", config: {} }] } } as any);
  const run = await startRun({ definitionKey: "acl-one-step", ownerId: ids["acl-a"], title: "acl scheduler", repositories: ["repo-a"], inputs: { project: "ACL" } });
  await admin("/api/repositories/repo-a/access", { user_id: ids["acl-a"], level: "none" });
  try {
    assert.equal(await runOnce("acl-worker"), true);
    assert.equal(executed, 0, "the executor never ran: no repository content was touched");
    const step = (await getRun(run.id)).steps.find((x: any) => x.key === "look")!;
    assert.ok(["FAILED", "WAITING_INPUT"].includes(step.status), `stopped safely, not running (${step.status})`);
    const attempt = await one<{ status: string; error: any }>(pool, "SELECT status, error FROM workflow_step_attempts WHERE run_id = $1", [run.id]);
    assert.match(JSON.stringify(attempt!.error), /Repository access revoked for the run owner: repo-a/);
    assert.equal(Number((await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE run_id = $1", [run.id]))!.n), 1, "not retried automatically");
  } finally {
    await admin("/api/repositories/repo-a/access", { user_id: ids["acl-a"], level: "pull_request" });
  }
  await retryStep(run.id, "look");
  assert.equal(await runOnce("acl-worker"), true);
  assert.equal(executed, 1);
  assert.equal((await getRun(run.id)).steps.find((x: any) => x.key === "look")!.status, "COMPLETED");
});

test("a run created before any grant picks the grant up when its step is retried (nothing selected yet)", async () => {
  // B has no access to repo-d; the run starts with an empty scope (the user story behind "no repositories are allowed")
  const wi = (await B("/api/work-items", { title: "before grant", project: "ACL" })).body;
  await admin("/api/repositories/repo-c/shared", { level: "none" });
  await admin("/api/repositories/repo-b/access", { user_id: ids["acl-b"], level: "none" });
  try {
    const run = (await B("/api/runs", { workflow: "bug-investigation", work_item_id: wi.id, start: false })).body;
    assert.deepEqual(run.allowed_repositories, []);
    await admin("/api/repositories/repo-b/access", { user_id: ids["acl-b"], level: "write" });
    const row = await one<any>(pool, "SELECT id, owner_id, allowed_repositories, selected_repositories, inputs FROM workflow_runs WHERE id = $1", [run.id]);
    const scope = await enforceRunRepositoryAccess(row);
    assert.deepEqual(scope, { revoked: [], blocked: [], added: ["repo-b"], changed: true });
    assert.deepEqual((await one<any>(pool, "SELECT allowed_repositories FROM workflow_runs WHERE id = $1", [run.id]))!.allowed_repositories, ["repo-b"]);
    assert.ok(await one(pool, "SELECT 1 FROM workflow_events WHERE run_id = $1 AND content LIKE 'repository scope refreshed%added: repo-b%'", [run.id]));
    // never wider than the owner's own access: A's repository is not added to B's run
    assert.ok(!row.allowed_repositories.includes("repo-a"));
    // once a repository is selected, the scope no longer widens
    await selectRepositories(run.id, ["repo-b"]);
    await admin("/api/repositories/repo-c/shared", { level: "read" });
    const selected = await one<any>(pool, "SELECT id, owner_id, allowed_repositories, selected_repositories, inputs FROM workflow_runs WHERE id = $1", [run.id]);
    assert.equal((await enforceRunRepositoryAccess(selected)).changed, false);
    assert.deepEqual(selected.allowed_repositories, ["repo-b"]);
  } finally {
    await admin("/api/repositories/repo-c/shared", { level: "read" });
    await admin("/api/repositories/repo-b/access", { user_id: ids["acl-b"], level: "write" });
  }
});

test("5. code intelligence status is filtered by access", async () => {
  const saved = config.codeIntelligence.enabled;
  config.codeIntelligence.enabled = true;
  try {
    const rows = (await A("/api/repositories/index-status")).body.repositories.map((r: any) => r.name).sort();
    assert.deepEqual(rows, ["repo-a", "repo-c"]);
    assert.equal((await A("/api/repositories/index-status?manage=1")).status, 403);
    assert.ok((await admin("/api/repositories/index-status?manage=1")).body.repositories.some((r: any) => r.name === "repo-b"));
  } finally {
    config.codeIntelligence.enabled = saved;
  }
});

test("11. repository knowledge (scoped or imported) is invisible without access to its repository", async () => {
  await knowledge.create({ key: "acl.repo-b.convention", category: "repository_convention", scope_type: "REPOSITORY", scope_ref: "repo-b", title: "B secrets", content: "repo-b internal detail", created_by: "test" } as any);
  await knowledge.create({ key: "acl.repo-b.skill", category: "agent_skill", scope_type: "GLOBAL", title: "B skill", content: "copied from repo-b", metadata: { imported_from_repository: true, source: [{ repo: "repo-b", path: ".claude/skills/x.md" }] }, created_by: "test" } as any);
  const listA = (await A("/api/knowledge")).body.map((k: any) => k.key);
  const listB = (await B("/api/knowledge")).body.map((k: any) => k.key);
  for (const key of ["acl.repo-b.convention", "acl.repo-b.skill"]) {
    assert.ok(!listA.includes(key), key);
    assert.ok(listB.includes(key), key);
    assert.equal((await A(`/api/knowledge/${key}`)).status, 404);
    assert.equal((await B(`/api/knowledge/${key}`)).status, 200);
  }
  const preview = (await A("/api/knowledge/preview", { project: "ACL", repositories: ["repo-b"], explicit: ["acl.repo-b.skill"], text: "anything" })).body;
  assert.doesNotMatch(JSON.stringify(preview), /repo-b internal detail|copied from repo-b/);
});

test("11. SSE payloads never carry repository data", async () => {
  // Live events are ids + kind only (src/api/stream.ts); a repository name can only reach a browser through the
  // REST endpoints exercised above.
  const { eventsSince } = await import("../src/api/stream.ts");
  const wi = (await A("/api/work-items", { title: "sse", project: "ACL" })).body;
  const run = (await A("/api/runs", { workflow: "bug-investigation", work_item_id: wi.id, start: false, repositories: ["repo-a"] })).body;
  const slice = await eventsSince({ userId: ids["acl-b"], role: "member", support: false, runId: null }, 0);
  assert.ok(!slice.events.some((e) => e.run_id === run.id), "another member gets no event of this run");
  const own = await eventsSince({ userId: ids["acl-a"], role: "member", support: false, runId: run.id }, 0);
  assert.ok(own.events.length > 0);
  for (const e of own.events) assert.deepEqual(Object.keys(e).sort(), ["attempt_id", "id", "kind", "run_id", "step_id"]);
});

test("deleting a repository removes its grants and checks with it", async () => {
  await register("repo-temp");
  await admin("/api/repositories/repo-temp/access", { user_id: ids["acl-a"], level: "read" });
  const id = (await repositories.get("repo-temp"))!.id;
  assert.equal((await admin("/api/repositories/repo-temp/delete", {})).status, 200);
  assert.equal((await q(pool, "SELECT 1 FROM user_repository_access WHERE repository_id = $1", [id])).length, 0);
});
