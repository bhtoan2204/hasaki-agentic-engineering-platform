/**
 * Step 5: who may be served a shared analysis, isolation between installations and between projects, and the scrub that
 * runs before a result is stored. Access is the platform's own (repository grants; personal log connections); the
 * default hooks are used, nothing is stubbed.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { putSharedSecret, putUserSecret, deleteUserSecret } from "../src/auth/secrets.ts";
import { repositories } from "../src/repos/service.ts";
import { setRepositoryAccess, type AccessLevel } from "../src/repos/access.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import {
  bugHuntKey,
  codeAssessmentKey,
  rubricHash,
  runtimeRcaKey,
  type SharedKey,
} from "../src/sharing/key.ts";
import { lookupOrStart, waitForAnalysis, type LookupRequest } from "../src/sharing/service.ts";
import { settleSharedAnalyses } from "../src/sharing/settle.ts";
import { resetSharingHooks, setSharingHooks } from "../src/sharing/hooks.ts";
import { installationId } from "../src/sharing/scope.ts";
import { describeAnalysis } from "../src/sharing/view.ts";
import { SCRUB_VERSION } from "../src/sharing/scrub.ts";
import { sharedBugHunt, sharedCodeAssessment, sharedRuntimeRca } from "../src/sharing/flows.ts";
import { runtimeMetricsSnapshot } from "../src/runtimeMetrics.ts";
import { flushAllCaches } from "../src/cache/index.ts";

const OTHER_SCOPE = "9d2c4e1f-7a3b-4c5d-8e6f-0a1b2c3d4e5f";
const A = "a".repeat(40);
let admin = 0;
let alice = 0;
let bob = 0;
let carol = 0;
let scope = "";
let seq = 0;
const names: Record<number, string> = {};

before(async () => {
  await migrate();
  await seedTemplates();
  const user = async (username: string, role: "member" | "admin" = "member") => {
    const u = await createUser({ username, password: `${username}-password`, role });
    names[u.id] = username;
    return u.id;
  };
  admin = await user("access-admin", "admin");
  alice = await user("access-alice");
  bob = await user("access-bob");
  carol = await user("access-carol");
  scope = await installationId();
  await definitions.create({
    key: "shared-access-fixture",
    spec: {
      name: "access fixture",
      steps: [
        { key: "assess", type: "command", config: { command: "true" } },
        { key: "report", type: "command", config: { command: "true" } },
      ],
    },
  });
});
after(async () => {
  await settleBackground();
  await pool.end();
});
beforeEach(() => {
  resetSharingHooks();
  setSharingHooks({ observe: () => {} });
  config.sharedResults.prodErrors = true;
  config.sharedResults.codeAssessment = true;
  config.splunk.allowSharedToken = false;
});

/** A local repository (no remote: no Bitbucket check) with read grants for the given members. */
async function repo(readers: number[]) {
  const name = `access-repo-${++seq}`;
  const row = (await repositories.upsert(name, {}))!;
  for (const u of readers) await setRepositoryAccess(row, u, "read", admin);
  return name;
}
async function grant(name: string, userId: number, level: AccessLevel) {
  await setRepositoryAccess((await repositories.get(name))!, userId, level, admin);
}
const assessKey = (repos: string[], o: { scope?: string; focus?: string } = {}): SharedKey =>
  codeAssessmentKey({
    scope: o.scope ?? scope,
    repos: repos.map((repo) => ({ repo, commit: A })),
    focus: o.focus ?? "",
    workflow: { key: "codebase-assessment", version: 1 },
    rubricHash: rubricHash({ instructions: "assess" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
const errorKey = () => (++seq).toString(16).padStart(20, "0");
const rcaKey = (error: string): SharedKey =>
  runtimeRcaKey({
    scope,
    errorKey: error,
    contract: "v1",
    workflow: { key: "production-incident-investigation", version: 1 },
    rubricHash: rubricHash({ instructions: "rca" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
let starts = 0;
const request = (
  key: SharedKey,
  actor: number,
  over: Partial<LookupRequest> = {},
): LookupRequest => ({
  key,
  actor: { id: actor, username: names[actor] },
  scopeRepos: ((key.parts.repos as string[] | undefined) ?? []).map((r) => r.split("@")[0]),
  errorKey: (key.parts.error as string | undefined) ?? null,
  start: async (tx) => {
    starts++;
    return Number(
      (
        await startRun(
          { definitionKey: "shared-access-fixture", ownerId: actor, start: false, title: "access" },
          tx,
        )
      ).id,
    );
  },
  ...over,
});
const runIdOf = (r: Awaited<ReturnType<typeof lookupOrStart>>) =>
  r.outcome === "miss" || r.outcome === "forced" ? r.runId : 0;
async function complete(runId: number, output: unknown = { findings: [] }) {
  await q(pool, "UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [runId]);
  await q(
    pool,
    "UPDATE workflow_steps SET status = 'COMPLETED', output = $2 WHERE run_id = $1 AND key IN ('assess', 'report')",
    [runId, JSON.stringify(output)],
  );
}
async function publish(key: SharedKey, actor: number, output?: unknown, huntRepo?: string) {
  const r = await lookupOrStart(
    request(key, actor, {
      ...(huntRepo
        ? {
            start: async (tx) => {
              const runId = Number(
                (
                  await startRun(
                    {
                      definitionKey: "shared-access-fixture",
                      ownerId: actor,
                      start: false,
                      title: "access",
                    },
                    tx,
                  )
                ).id,
              );
              await tx.client.query(
                "INSERT INTO bug_hunts (fingerprint, run_id, requested_by, repositories, scope_key, report) VALUES ($1, $2, $3, $4, $5, $6)",
                [
                  key.parts.error,
                  runId,
                  actor,
                  [huntRepo],
                  huntRepo,
                  JSON.stringify({ confirmed: [] }),
                ],
              );
              return runId;
            },
          }
        : {}),
    }),
  );
  assert.ok(r.outcome === "miss" || r.outcome === "forced", `expected a claim, got ${r.outcome}`);
  await complete(runIdOf(r), output);
  await settleSharedAnalyses();
  await settleBackground();
  return r.analysis!;
}
const rowsOf = (key: SharedKey) =>
  q<{ id: number; version: number; status: string }>(
    pool,
    "SELECT id, version, status FROM shared_analyses WHERE kind = $1 AND key = $2 ORDER BY version",
    [key.kind, key.key],
  );

// ---- same project, other project, several repositories
test("a member who can read the repository reuses the result; the answer names who ran it", async () => {
  const name = await repo([alice, bob]);
  const key = assessKey([name]);
  await publish(key, alice);
  const hit = await lookupOrStart(request(key, bob));
  assert.equal(hit.outcome, "hit");
  const view = await describeAnalysis(hit, { id: bob });
  assert.equal(view.run_by.name, "access-alice");
  assert.equal(view.run_id, undefined, "the source run stays owner-only");
  assert.ok(view.result);
});

test("another project in the same installation: a member without the repository gets nothing, not even who ran it", async () => {
  const name = await repo([alice]);
  const key = assessKey([name]);
  await publish(key, alice);
  starts = 0;
  const r = await lookupOrStart(request(key, bob));
  assert.equal(r.outcome, "bypass");
  assert.equal(r.analysis, null, "no row, so no runner name, version or key crosses the boundary");
  assert.equal(starts, 0, "bob runs his own analysis outside sharing");
  const forced = await lookupOrStart(request(key, bob, { force: true }));
  assert.deepEqual([forced.outcome, forced.analysis], ["bypass", null], "nor can he force over it");
  assert.deepEqual(
    (await rowsOf(key)).map((r) => r.status),
    ["valid"],
    "alice's result is untouched",
  );
});

test("several repositories: every one must be readable; a write grant also reads", async () => {
  const a = await repo([alice, bob]);
  const b = await repo([alice]);
  const key = assessKey([a, b]);
  await publish(key, alice);
  assert.equal(
    (await lookupOrStart(request(key, bob))).outcome,
    "bypass",
    "one of two is not enough",
  );
  await grant(b, bob, "write");
  assert.equal((await lookupOrStart(request(key, bob))).outcome, "hit");
});

test("fail closed: a row without repositories, or with a repository nobody registered, is served to no one", async () => {
  const name = await repo([alice]);
  const key = assessKey([name]);
  const row = await publish(key, alice);
  await q(pool, "UPDATE shared_analyses SET scope_repos = '{}' WHERE id = $1", [row.id]);
  assert.equal((await lookupOrStart(request(key, alice))).outcome, "bypass");
  await q(pool, "UPDATE shared_analyses SET scope_repos = '{ghost-repo}' WHERE id = $1", [row.id]);
  assert.equal((await lookupOrStart(request(key, alice))).outcome, "bypass");
});

// ---- waiters
test("a waiter without access is not attached to the running analysis, and cannot read it through the wait", async () => {
  const name = await repo([alice]);
  const key = assessKey([name]);
  const first = await lookupOrStart(request(key, alice));
  assert.equal(first.outcome, "miss");
  starts = 0;
  const forBob = await lookupOrStart(request(key, bob));
  assert.deepEqual([forBob.outcome, forBob.analysis], ["bypass", null], "not a wait");
  assert.equal(starts, 0);
  const waiting = waitForAnalysis(
    first.analysis.id,
    { id: bob },
    { timeoutMs: 10_000, pollMs: 50 },
  );
  const own = waitForAnalysis(first.analysis.id, { id: alice }, { timeoutMs: 10_000, pollMs: 50 });
  await complete(runIdOf(first), { findings: ["x"] });
  await settleSharedAnalyses();
  assert.deepEqual(await waiting, { status: "denied", analysis: null });
  assert.equal((await own).status, "valid");
});

test("a waiter who loses access while waiting gets nothing when the analysis is published", async () => {
  const name = await repo([alice, bob]);
  const key = assessKey([name]);
  const first = await lookupOrStart(request(key, alice));
  const wait = await lookupOrStart(request(key, bob));
  assert.equal(wait.outcome, "wait");
  const waiting = waitForAnalysis(
    wait.analysis!.id,
    { id: bob },
    { timeoutMs: 10_000, pollMs: 50 },
  );
  await grant(name, bob, "none");
  await complete(runIdOf(first));
  await settleSharedAnalyses();
  assert.deepEqual(await waiting, { status: "denied", analysis: null });
});

// ---- access lost after sharing
test("access lost after sharing: the next lookup no longer serves it, the creator included; the row is kept", async () => {
  const name = await repo([alice, bob]);
  const key = assessKey([name]);
  await publish(key, alice);
  assert.equal((await lookupOrStart(request(key, bob))).outcome, "hit");
  await grant(name, bob, "none");
  assert.equal((await lookupOrStart(request(key, bob))).outcome, "bypass", "revoked: not served");
  await grant(name, alice, "none");
  assert.equal(
    (await lookupOrStart(request(key, alice))).outcome,
    "bypass",
    "the creator follows the same rule",
  );
  await grant(name, bob, "read");
  assert.equal(
    (await lookupOrStart(request(key, bob))).outcome,
    "hit",
    "granted again: served again",
  );
  assert.deepEqual(
    (await rowsOf(key)).map((r) => r.status),
    ["valid"],
  );
});

// ---- installations (tenants)
test("installations never see each other: same subject, another scope is another key, another row, no reads and no writes across", async () => {
  const name = await repo([alice]);
  const here = assessKey([name]);
  const there = assessKey([name], { scope: OTHER_SCOPE });
  assert.notEqual(here.key, there.key);
  await publish(here, alice);
  // A row written under another installation's scope (a restored dump, a shared database by mistake).
  const foreign = await lookupOrStart(request(there, alice));
  assert.equal(foreign.outcome, "miss", "never a hit on this installation's result");
  await complete(runIdOf(foreign));
  await settleSharedAnalyses();
  await settleBackground();
  assert.deepEqual(
    (await rowsOf(here)).map((r) => r.status),
    ["valid"],
    "the other scope's claim did not stale or supersede this one",
  );
  const r = await lookupOrStart(request(there, alice));
  assert.deepEqual(
    [r.outcome, r.analysis],
    ["bypass", null],
    "a row of another scope is served to nobody here, not even its creator",
  );
  const forced = await lookupOrStart(request(there, alice, { force: true }));
  assert.equal(forced.outcome, "bypass", "nor forced over");
  assert.deepEqual(
    (await rowsOf(there)).map((x) => x.status),
    ["valid"],
  );
});

// ---- runtime RCA: log evidence needs log access
test("runtime RCA: served only to members who can search logs themselves (personal Splunk or SigNoz, or the shared token when allowed)", async () => {
  const key = rcaKey(errorKey());
  await putUserSecret(alice, "splunk_token", JSON.stringify({ token: "t", user: "alice" }));
  await publish(key, alice);
  assert.equal((await lookupOrStart(request(key, bob))).outcome, "bypass", "bob has no log access");
  await putUserSecret(
    carol,
    "signoz",
    JSON.stringify({ baseUrl: "https://signoz.example", enabled: true, token: "k" }),
  );
  assert.equal((await lookupOrStart(request(key, carol))).outcome, "hit", "carol has SigNoz");
  await putUserSecret(
    carol,
    "signoz",
    JSON.stringify({ baseUrl: "https://signoz.example", enabled: false, token: "k" }),
  );
  assert.equal((await lookupOrStart(request(key, carol))).outcome, "bypass", "SigNoz disabled");
  await putSharedSecret("splunk_token", JSON.stringify({ token: "shared", user: "svc" }));
  assert.equal(
    (await lookupOrStart(request(key, bob))).outcome,
    "bypass",
    "a shared token members may not use gives no access",
  );
  config.splunk.allowSharedToken = true;
  assert.equal((await lookupOrStart(request(key, bob))).outcome, "hit");
  config.splunk.allowSharedToken = false;
  await deleteUserSecret(alice, "splunk_token");
  assert.equal((await lookupOrStart(request(key, alice))).outcome, "bypass", "the creator too");
});

test("N8: a member without log access cannot claim or supersede a shared runtime RCA (new, expired, stale, failed, or forced)", async () => {
  const key = rcaKey(errorKey());
  // No row exists yet: bob without Splunk/SigNoz bypasses sharing instead of claiming v1.
  starts = 0;
  const fresh = await lookupOrStart(request(key, bob));
  assert.deepEqual([fresh.outcome, fresh.analysis, starts], ["bypass", null, 0]);
  assert.deepEqual(await rowsOf(key), []);

  // Alice (with Splunk) publishes v1; then v1 expires. Bob still cannot claim v2 or force over it.
  await putUserSecret(alice, "splunk_token", JSON.stringify({ token: "t", user: "alice" }));
  try {
    await publish(key, alice, { summary: "real log RCA" });
    await q(
      pool,
      "UPDATE shared_analyses SET valid_until = now() - interval '1 minute' WHERE kind = $1 AND key = $2",
      [key.kind, key.key],
    );
    const expiredBob = await lookupOrStart(request(key, bob));
    const forcedBob = await lookupOrStart(request(key, bob, { force: true }));
    assert.deepEqual([expiredBob.outcome, expiredBob.analysis], ["bypass", null]);
    assert.deepEqual([forcedBob.outcome, forcedBob.analysis], ["bypass", null]);
    assert.deepEqual(
      (await rowsOf(key)).map((r) => [r.version, r.status]),
      [[1, "valid"]],
      "alice's row is not superseded or joined by a log-less run",
    );

    // Failed v1 past backoff: bob still cannot claim v2.
    await q(
      pool,
      "UPDATE shared_analyses SET status = 'failed', next_retry_at = now() - interval '1 minute', result = NULL WHERE kind = $1 AND key = $2",
      [key.kind, key.key],
    );
    const failedBob = await lookupOrStart(request(key, bob));
    assert.deepEqual([failedBob.outcome, failedBob.analysis], ["bypass", null]);
    assert.equal((await rowsOf(key)).length, 1);
  } finally {
    await deleteUserSecret(alice, "splunk_token");
  }
});

test("N8: a runtime RCA whose starter lost log access before settle is not published and does not supersede a prior valid RCA", async () => {
  const key = rcaKey(errorKey());
  await putUserSecret(alice, "splunk_token", JSON.stringify({ token: "t1", user: "alice" }));
  await putUserSecret(bob, "splunk_token", JSON.stringify({ token: "t2", user: "bob" }));
  try {
    await publish(key, alice, { summary: "alice log RCA" });
    const forced = await lookupOrStart(request(key, bob, { force: true }));
    assert.equal(forced.outcome, "forced");
    await deleteUserSecret(bob, "splunk_token");
    await complete(runIdOf(forced), { summary: "bob no-logs RCA" });
    await settleSharedAnalyses();
    const rows = await rowsOf(key);
    assert.deepEqual(
      rows.map((r) => [r.version, r.status]),
      [
        [1, "valid"],
        [2, "failed"],
      ],
      "v1 stays valid and is never superseded; v2 is refused at settle",
    );
    const hit = await lookupOrStart(request(key, alice));
    assert.equal(hit.outcome, "hit");
    assert.equal(hit.analysis!.version, 1);
  } finally {
    await deleteUserSecret(alice, "splunk_token").catch(() => {});
    await deleteUserSecret(bob, "splunk_token").catch(() => {});
  }
});

// ---- scrub before storing
test("scrub happens before the write: the stored row holds no secret or customer data, and records the scrub version", async () => {
  const name = await repo([alice]);
  const focus = "auth flow, ask nguyen.van.a@gmail.com";
  const key = assessKey([name], { focus });
  const SECRETS = [
    "sk-ant-api03-" + "Qw7".repeat(12),
    "AKIA" + "IOSFODNN7EXAMPLE",
    "abcDEF123456ghiJKL789",
    "S3cretPassw0rd",
    "r3d1sPassw0rd",
    "nguyen.van.a@",
    "0912345678",
    "079203001234",
    "MIIEowIBAAKCAQEA7",
  ];
  const output = {
    findings: [
      {
        title: "credentials in logs",
        evidence:
          `ERROR call failed key=${SECRETS[0]} aws ${SECRETS[1]}\n` +
          `  at Client.send (client.ts:42) Authorization: Bearer ${SECRETS[2]}\n` +
          `dial postgres://oms:${SECRETS[3]}@10.0.3.17:5432/oms; cache redis://:${SECRETS[4]}@cache:6379\n` +
          `customer nguyen.van.a@gmail.com 0912345678 CCCD ${SECRETS[7]} trace_id=4bf92f3577b34da6a3ce929d0e0e4736`,
        code: "const pem = `-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\n-----END PRIVATE KEY-----`;",
        config: { password: "hunter2" },
      },
    ],
  };
  const row = await publish(key, alice, output);
  const stored = await one<{ result: unknown; key_parts: Record<string, unknown> }>(
    pool,
    "SELECT result, key_parts FROM shared_analyses WHERE id = $1",
    [row.id],
  );
  const text = JSON.stringify(stored);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${s} was stored`);
  assert.ok(!text.includes("hunter2"));
  assert.match(text, /trace_id=4bf92f3577b34da6a3ce929d0e0e4736/, "trace ids are kept");
  assert.match(text, /client\.ts:42/, "the stack frame is kept");
  assert.equal(stored!.key_parts.scrub_version, SCRUB_VERSION);
  assert.equal(
    stored!.key_parts.focus,
    "auth flow, ask n***@gmail.com",
    "typed focus is scrubbed too",
  );
  const hit = await lookupOrStart(request(key, alice));
  assert.equal(hit.outcome, "hit", "the key is unchanged by the scrub of its stored parts");
});

test("a scrub that fails publishes nothing: the row fails instead", async () => {
  const name = await repo([alice]);
  const key = assessKey([name]);
  setSharingHooks({
    scrub: () => {
      throw new Error("boom");
    },
  });
  const r = await lookupOrStart(request(key, alice));
  await complete(runIdOf(r), { findings: ["raw"] });
  await settleSharedAnalyses();
  const row = await one<{ status: string; result: unknown; failure: { reason: string } }>(
    pool,
    "SELECT status, result, failure FROM shared_analyses WHERE id = $1",
    [r.analysis!.id],
  );
  assert.deepEqual(
    [row!.status, row!.result, row!.failure.reason],
    ["failed", null, "scrub failed"],
  );
});

test("N6: a report with a secret assignment keeps its prose (span redaction); an all-redacted result fails publish", async () => {
  const name = await repo([alice]);
  const k1 = assessKey([name]);
  const r1 = await lookupOrStart(request(k1, alice));
  const dbSecret = ["superSecret", "Value1234"].join("");
  await complete(runIdOf(r1), {
    report_markdown: `## Summary\nFound issue in config.\n\`db_secret_key = ${dbSecret}\`\nEnd.`,
  });
  await settleSharedAnalyses();
  const published = await one<{ status: string; result: { report_markdown: string } | null }>(
    pool,
    "SELECT status, result FROM shared_analyses WHERE id = $1",
    [r1.analysis!.id],
  );
  assert.equal(published!.status, "valid");
  assert.match(published!.result!.report_markdown, /^## Summary\nFound issue in config\./);
  assert.ok(!published!.result!.report_markdown.includes(dbSecret));

  const k2 = assessKey([name], { focus: "all-redacted-default" });
  const r2 = await lookupOrStart(request(k2, alice));
  await complete(runIdOf(r2), {
    report: "-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\n-----END PRIVATE KEY-----",
  });
  await settleSharedAnalyses();
  const rejectedDefault = await one<{
    status: string;
    result: unknown;
    failure: { reason: string };
  }>(pool, "SELECT status, result, failure FROM shared_analyses WHERE id = $1", [r2.analysis!.id]);
  assert.deepEqual(
    [rejectedDefault!.status, rejectedDefault!.result, rejectedDefault!.failure.reason],
    ["failed", null, "scrub failed"],
  );

  const k3 = assessKey([name], { focus: "all-redacted-hook" });
  setSharingHooks({ scrub: () => ({ report: "[redacted]" }) });
  const r3 = await lookupOrStart(request(k3, alice));
  await complete(runIdOf(r3), { report: "anything" });
  await settleSharedAnalyses();
  const rejectedHook = await one<{ status: string; result: unknown; failure: { reason: string } }>(
    pool,
    "SELECT status, result, failure FROM shared_analyses WHERE id = $1",
    [r3.analysis!.id],
  );
  assert.deepEqual(
    [rejectedHook!.status, rejectedHook!.result, rejectedHook!.failure.reason],
    ["failed", null, "scrub failed"],
  );
});

test("N9: hit path with default canRead measures real statement counts across all three kinds and short-circuits RCA log-access checks", async () => {
  const statements = () => runtimeMetricsSnapshot().counters["db.statements"];
  const name = await repo([alice, bob]);
  const errFp = errorKey();

  // Warm up installationId() and definitions cache so steady-state hit costs are measured cleanly.
  const kAssess = assessKey([name]);
  await publish(kAssess, alice);
  const kHunt = bugHuntKey({
    scope,
    errorKey: errFp,
    repos: [{ repo: name, commit: A }],
    workflow: { key: "production-bug-hunt", version: 1 },
    rubricHash: rubricHash({ instructions: "hunt" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
  await publish(kHunt, alice, undefined, name);
  const kRca = rcaKey(errFp);
  await putUserSecret(alice, "splunk_token", JSON.stringify({ token: "t1", user: "alice" }));
  await putUserSecret(
    carol,
    "signoz",
    JSON.stringify({ baseUrl: "https://signoz.example", enabled: true, token: "k" }),
  );
  await putSharedSecret("splunk_token", JSON.stringify({ token: "shared", user: "svc" }));
  config.splunk.allowSharedToken = true;

  try {
    await publish(kRca, alice);
    await settleBackground();

    // 1. lookupOrStart hit with default canReadShared for code_assessment and bug_hunt:
    // cold CacheAside (after invalidation/flush) pays 1 latestVersion + 3 repo-access SELECTs + 1 background recordUse = 5;
    // warm CacheAside pays 1 latestVersion + 1 background recordUse = 2.
    const measureLookup = async (key: SharedKey, userId: number, flush = false) => {
      await settleBackground();
      if (flush) flushAllCaches();
      const s0 = statements();
      const t0 = performance.now();
      const r = await lookupOrStart(request(key, userId));
      const ms = performance.now() - t0;
      await settleBackground();
      return { outcome: r.outcome, stmts: statements() - s0, ms };
    };
    const assessCold = await measureLookup(kAssess, bob, true);
    const assessWarm = await measureLookup(kAssess, bob, false);
    const huntCold = await measureLookup(kHunt, bob, true);
    const huntWarm = await measureLookup(kHunt, bob, false);
    assert.equal(assessCold.outcome, "hit");
    assert.equal(assessWarm.outcome, "hit");
    assert.equal(huntCold.outcome, "hit");
    assert.equal(huntWarm.outcome, "hit");
    assert.equal(assessCold.stmts, 5, `cold repo access hit (got ${assessCold.stmts})`);
    assert.equal(assessWarm.stmts, 2, `warm repo access hit (got ${assessWarm.stmts})`);
    assert.equal(huntCold.stmts, 5, `cold bug hunt hit (got ${huntCold.stmts})`);
    assert.equal(huntWarm.stmts, 2, `warm bug hunt hit (got ${huntWarm.stmts})`);

    // 2. lookupOrStart hit for runtime_rca: SigNoz and Splunk users with allowSharedToken=true use only
    // 1 latestVersion SELECT + 1 batched user_secrets SELECT + 1 background recordUse = 3 statements (no shared_secrets query).
    const rcaSignozHit = await measureLookup(kRca, carol);
    const rcaSplunkHit = await measureLookup(kRca, alice);
    assert.equal(rcaSignozHit.outcome, "hit");
    assert.equal(rcaSplunkHit.outcome, "hit");
    assert.equal(
      rcaSignozHit.stmts,
      3,
      `RCA hit with SigNoz + allowSharedToken=true should run 3 statements (got ${rcaSignozHit.stmts})`,
    );
    assert.equal(
      rcaSplunkHit.stmts,
      3,
      `RCA hit with personal Splunk should run 3 statements (got ${rcaSplunkHit.stmts})`,
    );

    // Also verify lazy decryption short-circuit: when alice has splunk_token + an undecryptable signoz ciphertext,
    // splunk_token succeeds without decrypting signoz.
    await q(
      pool,
      "INSERT INTO user_secrets (user_id, kind, ciphertext) VALUES ($1, 'signoz', 'corrupt-never-decrypted') ON CONFLICT (user_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext",
      [alice],
    );
    const rcaShortCircuit = await measureLookup(kRca, alice);
    assert.equal(rcaShortCircuit.outcome, "hit");
    assert.equal(rcaShortCircuit.stmts, 3);

    // 3. Full flow hit counts (analysisContext + key + lookupOrStart + background recordUse) across all 3 flows with real default canRead.
    const runFlow = async (fn: () => Promise<unknown>, flush = false) => {
      await settleBackground();
      if (flush) flushAllCaches();
      const s0 = statements();
      const t0 = performance.now();
      await fn();
      const ms = performance.now() - t0;
      await settleBackground();
      return { stmts: statements() - s0, ms };
    };
    await q(
      pool,
      "INSERT INTO prod_error_groups (fingerprint, day, namespace, service, level, signature) VALUES ($1, CURRENT_DATE, 'oms', 'api', 'error', 'sig') ON CONFLICT DO NOTHING",
      [errFp],
    );
    // Publish real workflow-matched entries for each flow so flows hit with default hooks.
    const flowStart = async (tx: Parameters<LookupRequest["start"]>[0]) =>
      Number(
        (
          await startRun(
            { definitionKey: "shared-access-fixture", ownerId: alice, start: false, title: "n9" },
            tx,
          )
        ).id,
      );
    const caMiss = await sharedCodeAssessment({
      actor: { id: alice },
      focus: "",
      commits: { [name]: A },
      start: flowStart,
    });
    assert.equal(caMiss?.outcome, "miss");
    await complete(caMiss!.outcome === "miss" ? caMiss!.runId : 0);
    const bhMiss = await sharedBugHunt({
      actor: { id: alice },
      fingerprint: errFp,
      commits: { [name]: A },
      start: flowStart,
    });
    assert.equal(bhMiss?.outcome, "miss");
    await q(
      pool,
      "INSERT INTO bug_hunts (fingerprint, run_id, requested_by, repositories, scope_key, report) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        errFp,
        bhMiss!.outcome === "miss" ? bhMiss!.runId : 0,
        alice,
        [name],
        name,
        JSON.stringify({ confirmed: [] }),
      ],
    );
    await complete(bhMiss!.outcome === "miss" ? bhMiss!.runId : 0);
    const rcaMiss = await sharedRuntimeRca({
      actor: { id: alice },
      fingerprint: errFp,
      contract: "v1",
      start: flowStart,
    });
    assert.equal(rcaMiss?.outcome, "miss");
    await complete(rcaMiss!.outcome === "miss" ? rcaMiss!.runId : 0);
    await settleSharedAnalyses();

    const caFlowCold = await runFlow(async () => {
      const r = await sharedCodeAssessment({
        actor: { id: bob },
        focus: "",
        commits: { [name]: A },
        start: flowStart,
      });
      assert.equal(r?.outcome, "hit");
    }, true);
    const caFlowWarm = await runFlow(async () => {
      const r = await sharedCodeAssessment({
        actor: { id: bob },
        focus: "",
        commits: { [name]: A },
        start: flowStart,
      });
      assert.equal(r?.outcome, "hit");
    }, false);
    const bhFlowCold = await runFlow(async () => {
      const r = await sharedBugHunt({
        actor: { id: bob },
        fingerprint: errFp,
        commits: { [name]: A },
        start: flowStart,
      });
      assert.equal(r?.outcome, "hit");
    }, true);
    const bhFlowWarm = await runFlow(async () => {
      const r = await sharedBugHunt({
        actor: { id: bob },
        fingerprint: errFp,
        commits: { [name]: A },
        start: flowStart,
      });
      assert.equal(r?.outcome, "hit");
    }, false);
    const rcaFlowWarm = await runFlow(async () => {
      const r = await sharedRuntimeRca({
        actor: { id: carol },
        fingerprint: errFp,
        contract: "v1",
        start: flowStart,
      });
      assert.equal(r?.outcome, "hit");
    }, false);
    assert.ok(caFlowWarm.stmts > 2 && bhFlowWarm.stmts > 2 && rcaFlowWarm.stmts > 3);
    console.log(
      `[N9 measured] lookup={assessCold:${assessCold.stmts} (${assessCold.ms.toFixed(1)}ms), assessWarm:${assessWarm.stmts} (${assessWarm.ms.toFixed(1)}ms), huntCold:${huntCold.stmts} (${huntCold.ms.toFixed(1)}ms), huntWarm:${huntWarm.stmts} (${huntWarm.ms.toFixed(1)}ms), rcaSplunk:${rcaSplunkHit.stmts} (${rcaSplunkHit.ms.toFixed(1)}ms), rcaSignoz:${rcaSignozHit.stmts} (${rcaSignozHit.ms.toFixed(1)}ms)} flow={assessCold:${caFlowCold.stmts} (${caFlowCold.ms.toFixed(1)}ms), assessWarm:${caFlowWarm.stmts} (${caFlowWarm.ms.toFixed(1)}ms), huntCold:${bhFlowCold.stmts} (${bhFlowCold.ms.toFixed(1)}ms), huntWarm:${bhFlowWarm.stmts} (${bhFlowWarm.ms.toFixed(1)}ms), rcaSignoz:${rcaFlowWarm.stmts} (${rcaFlowWarm.ms.toFixed(1)}ms)}`,
    );
  } finally {
    config.splunk.allowSharedToken = false;
    await deleteUserSecret(alice, "splunk_token").catch(() => {});
    await deleteUserSecret(alice, "signoz").catch(() => {});
    await deleteUserSecret(carol, "signoz").catch(() => {});
  }
});
