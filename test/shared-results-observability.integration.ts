/**
 * Step 6: metrics and log lines of shared results, the two feature flags (each one alone, and both off), and the backfill.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { setRepositoryAccess } from "../src/repos/access.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { resetRuntimeMetrics, runtimeMetricsSnapshot } from "../src/runtimeMetrics.ts";
import { codeAssessmentKey, rubricHash, type SharedKey } from "../src/sharing/key.ts";
import { lookupOrStart, type LookupRequest } from "../src/sharing/service.ts";
import {
  expireSharedAnalyses,
  settleSharedAnalyses,
  sharedResultsMaintenance,
} from "../src/sharing/settle.ts";
import { resetSharingHooks, setSharingHooks } from "../src/sharing/hooks.ts";
import { installationId } from "../src/sharing/scope.ts";
import { sharedBugHunt, sharedCodeAssessment, sharedRuntimeRca } from "../src/sharing/flows.ts";
import { BACKFILL_CURSOR, backfillSharedResults } from "../src/sharing/backfill.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
let admin = 0;
let alice = 0;
let scope = "";
let seq = 0;

before(async () => {
  await migrate();
  await seedTemplates();
  admin = (
    await createUser({ username: "obs-admin", password: "obs-admin-password", role: "admin" })
  ).id;
  alice = (
    await createUser({ username: "obs-alice", password: "obs-alice-password", role: "member" })
  ).id;
  scope = await installationId();
  await definitions.create({
    key: "shared-obs-fixture",
    spec: {
      name: "obs fixture",
      steps: [{ key: "assess", type: "command", config: { command: "true" } }],
    },
  });
});
after(async () => {
  await settleBackground();
  await pool.end();
});
beforeEach(() => {
  resetSharingHooks();
  // Metrics and logs come from the DEFAULT observe hook; access is not what this suite tests.
  setSharingHooks({ canRead: (row, actor) => row.created_by === actor.id });
  config.sharedResults.prodErrors = true;
  config.sharedResults.codeAssessment = true;
  config.sharedResults.maxAttempts = 3;
});

const statements = () => runtimeMetricsSnapshot().counters["db.statements"];
const metrics = () => runtimeMetricsSnapshot().shared_results.code_assessment;
const assessKey = (repo: string, commit = A): SharedKey =>
  codeAssessmentKey({
    scope,
    repos: [{ repo, commit }],
    focus: "",
    workflow: { key: "codebase-assessment", version: 1 },
    rubricHash: rubricHash({ instructions: "assess" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
const request = (key: SharedKey, over: Partial<LookupRequest> = {}): LookupRequest => ({
  key,
  actor: { id: alice },
  scopeRepos: [String((key.parts.repos as string[])[0]).split("@")[0]],
  start: async (tx) =>
    Number(
      (
        await startRun(
          { definitionKey: "shared-obs-fixture", ownerId: alice, start: false, title: "obs" },
          tx,
        )
      ).id,
    ),
  ...over,
});
const runIdOf = (r: Awaited<ReturnType<typeof lookupOrStart>>) =>
  r.outcome === "miss" || r.outcome === "forced" ? r.runId : 0;
async function finish(runId: number, status = "COMPLETED") {
  await q(pool, "UPDATE workflow_runs SET status = $2 WHERE id = $1", [runId, status]);
  await q(
    pool,
    "UPDATE workflow_steps SET status = 'COMPLETED', output = '{\"findings\":[]}' WHERE run_id = $1",
    [runId],
  );
  await settleSharedAnalyses();
  await settleBackground();
}
/** Log lines written while `fn` runs (the logger writes to console outside JSON mode). */
async function logged(fn: () => Promise<unknown>) {
  const lines: string[] = [];
  const keep = { log: console.log, warn: console.warn };
  console.log = (m: unknown) => void lines.push(String(m));
  console.warn = (m: unknown) => void lines.push(String(m));
  try {
    await fn();
    await settleBackground();
  } finally {
    Object.assign(console, keep);
  }
  return lines.filter((l) => l.startsWith("shared result"));
}

// ---- metrics and logs
test("metrics: hit rate, runs avoided, tokens saved, force re-runs and stale results, per kind with fixed labels", async () => {
  resetRuntimeMetrics();
  const repo = `obs-repo-${++seq}`;
  const key = assessKey(repo);
  const first = await lookupOrStart(request(key));
  assert.equal((await lookupOrStart(request(key))).outcome, "wait");
  await finish(runIdOf(first));
  await q(pool, "UPDATE shared_analyses SET tokens_in = 1000, tokens_out = 250 WHERE id = $1", [
    first.analysis!.id,
  ]);
  assert.equal((await lookupOrStart(request(key))).outcome, "hit");
  assert.equal((await lookupOrStart(request(key))).outcome, "hit");
  const forced = await lookupOrStart(request(key, { force: true }));
  assert.equal(forced.outcome, "forced");
  await finish(runIdOf(forced));
  await lookupOrStart(request(assessKey(repo, B)));
  await settleBackground();
  const m = metrics();
  assert.deepEqual(
    {
      miss: m.miss,
      wait: m.wait,
      hit: m.hit,
      forced: m.forced,
      published: m.published,
      stale: m.stale,
    },
    { miss: 2, wait: 1, hit: 2, forced: 1, published: 2, stale: 1 },
  );
  assert.equal(m.lookups, 6);
  assert.equal(m.avoided_runs, 3, "two hits and one single-flight wait");
  assert.equal(m.hit_rate, 0.333);
  assert.equal(m.tokens_saved, 2500, "1250 per hit");
  assert.equal(m.stale_total, 1);
  assert.equal(runtimeMetricsSnapshot().histograms["shared.lookup_ms"].count, 6);
  assert.deepEqual(
    Object.keys(runtimeMetricsSnapshot().shared_results),
    ["code_assessment", "prod_error.runtime_rca", "prod_error.bug_hunt"],
    "fixed kinds, no key or user in a label",
  );
});

test("logs: one line per hit, miss, single-flight wait, stale and failed-retry, with the key and the tenant", async () => {
  const repo = `obs-repo-${++seq}`;
  const key = assessKey(repo);
  let first!: Awaited<ReturnType<typeof lookupOrStart>>;
  const lines = await logged(async () => {
    first = await lookupOrStart(request(key));
    await lookupOrStart(request(key));
  });
  assert.match(
    lines[0],
    new RegExp(`^shared result miss: kind=code_assessment key=${key.key} tenant=${scope} `),
  );
  assert.match(
    lines[1],
    /^shared result single-flight wait: .* key=[0-9a-f]{64} tenant=[0-9a-f-]{36} /,
  );
  const published = await logged(() => finish(runIdOf(first)));
  assert.match(published[0], /^shared result published: .* analysis=\d+ v=1 run=\d+/);
  const hit = await logged(() => lookupOrStart(request(key)));
  assert.match(hit[0], /^shared result hit: .* ms=\d+/);
  const stale = await logged(() => lookupOrStart(request(assessKey(repo, B))));
  assert.ok(
    stale.some(
      (l) =>
        l.startsWith(`shared result stale: kind=code_assessment key=${key.key}`) &&
        l.includes(`reason=commit_changed:${repo}`),
    ),
    stale.join("\n"),
  );
  const k2 = assessKey(`obs-repo-${++seq}`);
  const failing = await lookupOrStart(request(k2));
  const failed = await logged(() => finish(runIdOf(failing), "FAILED"));
  assert.match(failed[0], /^shared result failed: .* reason=run failed/);
  const held = await logged(() => lookupOrStart(request(k2)));
  assert.match(held[0], /^shared result failed-retry held: .* reason=backoff/);
});

test("R1: the metrics and the log line add no query: a hit is still one SELECT plus one background statement", async () => {
  const key = assessKey(`obs-repo-${++seq}`);
  await finish(runIdOf(await lookupOrStart(request(key))));
  const before = statements();
  await logged(() => lookupOrStart(request(key)));
  assert.equal(statements() - before, 2);
});

// ---- feature flags
test("flags off: no query of the feature runs (flows, reconcile task, TTL sweep, backfill)", async () => {
  config.sharedResults.prodErrors = false;
  config.sharedResults.codeAssessment = false;
  let starts = 0;
  const start = async () => (starts++, 0);
  const before = statements();
  assert.equal(
    await sharedCodeAssessment({ actor: { id: alice }, focus: "", commits: { r: A }, start }),
    null,
  );
  assert.equal(
    await sharedRuntimeRca({
      actor: { id: alice },
      fingerprint: "0".repeat(20),
      contract: "v1",
      start,
    }),
    null,
  );
  assert.equal(
    await sharedBugHunt({
      actor: { id: alice },
      fingerprint: "0".repeat(20),
      commits: { r: A },
      start,
    }),
    null,
  );
  await sharedResultsMaintenance();
  assert.equal(await expireSharedAnalyses(), 0);
  const report = await backfillSharedResults({ apply: true });
  assert.deepEqual([report.kinds, report.scanned], [[], 0]);
  assert.equal(statements() - before, 0, "not one statement");
  assert.equal(starts, 0);
});

test("flags are independent: each one gates its own kinds, also in the reconcile task and the TTL sweep", async () => {
  const assess = await lookupOrStart(request(assessKey(`obs-repo-${++seq}`)));
  await q(pool, "UPDATE workflow_runs SET status = 'FAILED' WHERE id = $1", [runIdOf(assess)]);
  const [rca] = await q<{ id: number }>(
    pool,
    `INSERT INTO shared_analyses (kind, key, version, status, key_parts, error_key, created_by, trigger, started_at)
     VALUES ('prod_error.runtime_rca', $1, 1, 'running', $2, $3, $4, 'manual', now() - interval '2 days') RETURNING id`,
    [
      String(++seq).padStart(64, "e"),
      JSON.stringify({ scope }),
      String(seq).padStart(20, "e"),
      alice,
    ],
  );
  config.sharedResults.prodErrors = false;
  let starts = 0;
  const start = async () => (starts++, 0);
  const before = statements();
  assert.equal(
    await sharedRuntimeRca({
      actor: { id: alice },
      fingerprint: "0".repeat(20),
      contract: "v1",
      start,
    }),
    null,
  );
  assert.equal(
    await sharedBugHunt({
      actor: { id: alice },
      fingerprint: "0".repeat(20),
      commits: { r: A },
      start,
    }),
    null,
  );
  assert.equal(statements() - before, 0, "the production-error flows make no query");
  await settleSharedAnalyses();
  const status = async (id: number) =>
    (await one<{ status: string }>(pool, "SELECT status FROM shared_analyses WHERE id = $1", [id]))!
      .status;
  assert.equal(await status(assess.analysis!.id), "failed", "code assessment (flag on) is settled");
  assert.equal(
    await status(rca.id),
    "running",
    "a production-error row is not touched while its flag is off",
  );
  config.sharedResults.prodErrors = true;
  config.sharedResults.codeAssessment = false;
  assert.equal(
    await sharedCodeAssessment({ actor: { id: alice }, focus: "", commits: { r: A }, start }),
    null,
  );
  await settleSharedAnalyses();
  assert.equal(await status(rca.id), "failed", "and settled (timed out) once it is on");
  assert.equal(starts, 0);
});

// ---- backfill
async function repoFor(user: number) {
  const name = `obs-bf-${++seq}`;
  const row = (await repositories.upsert(name, {}))!;
  await setRepositoryAccess(row, user, "write", admin);
  return name;
}
/** A completed codebase-assessment run as the platform records it: frozen configuration, commits, the assess output. */
async function assessmentRun(
  repo: string,
  o: { commit?: string; finishedDaysAgo?: number; output?: unknown } = {},
) {
  const run = await startRun({
    definitionKey: "codebase-assessment",
    repositories: [repo],
    inputs: { repositories: [repo] },
    ownerId: alice,
    start: false,
    title: "assessment",
  });
  const id = Number(run.id);
  await q(
    pool,
    `UPDATE workflow_runs SET status = 'COMPLETED', started_at = now() - make_interval(days => $3) - interval '1 hour',
            finished_at = now() - make_interval(days => $3), source_revisions = $2 WHERE id = $1`,
    [
      id,
      JSON.stringify(o.commit === "" ? {} : { [repo]: { commit: o.commit ?? A } }),
      o.finishedDaysAgo ?? 0,
    ],
  );
  await q(
    pool,
    "UPDATE workflow_steps SET status = 'COMPLETED', output = $2 WHERE run_id = $1 AND key = 'assess'",
    [id, JSON.stringify(o.output ?? { findings: [{ title: "x" }] })],
  );
  return id;
}

test("backfill: only runs whose key is provably today's; dry-run writes nothing; batches resume; a re-run is a no-op", async () => {
  await q(pool, "DELETE FROM settings WHERE key = $1", [BACKFILL_CURSOR]);
  // A run of the version published before the current one: its definition changed since.
  const changed = await assessmentRun(await repoFor(alice));
  const dv = (await definitions.version("codebase-assessment"))!;
  await definitions.saveDraft("codebase-assessment", { ...dv.spec, name: `${dv.spec.name} (v2)` });
  await definitions.publish("codebase-assessment", "test: a newer version");
  const r1 = await repoFor(alice);
  const r2 = await repoFor(alice);
  const older = await assessmentRun(r1);
  const newest = await assessmentRun(r1, {
    output: { findings: [{ title: "mail nguyen.van.a@gmail.com" }] },
  });
  const other = await assessmentRun(r2, { commit: B });
  await assessmentRun(await repoFor(alice), { commit: "" });
  await assessmentRun(await repoFor(alice), { finishedDaysAgo: 40 });
  const failed = await assessmentRun(await repoFor(alice));
  await q(pool, "UPDATE workflow_runs SET status = 'FAILED' WHERE id = $1", [failed]);
  assert.ok(changed);

  const dry = await backfillSharedResults();
  assert.equal(dry.apply, false);
  assert.equal(dry.inserted, 2, "two keys: r1 (two runs) and r2");
  assert.deepEqual(
    dry.skipped,
    { commits_unknown: 1, expired: 1, definition_changed: 1, exists: 1 },
    JSON.stringify(dry.skipped),
  );
  assert.equal(
    (await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM shared_analyses WHERE trigger = 'backfill'",
    ))!.n,
    0,
  );
  assert.equal(
    await one(pool, "SELECT 1 FROM settings WHERE key = $1", [BACKFILL_CURSOR]),
    undefined,
    "dry-run keeps no cursor",
  );

  const part = await backfillSharedResults({ apply: true, batchSize: 2, maxBatches: 1 });
  assert.equal(part.done, false);
  assert.equal(part.scanned, 2);
  const rest = await backfillSharedResults({ apply: true, batchSize: 2 });
  assert.equal(rest.done, true);
  assert.equal(
    part.scanned + rest.scanned,
    dry.scanned,
    "resumed after the saved cursor: nothing scanned twice",
  );
  const rows = await q<{
    source_run_id: number;
    result: unknown;
    key_parts: { scrub_version?: number };
    created_by: number;
    status: string;
    version: number;
  }>(
    pool,
    "SELECT source_run_id, result, key_parts, created_by, status, version FROM shared_analyses WHERE trigger = 'backfill' ORDER BY source_run_id",
  );
  assert.deepEqual(
    rows.map((r) => Number(r.source_run_id)).sort(),
    [newest, other].sort(),
    "the newest run of a key wins",
  );
  assert.ok(!rows.some((r) => Number(r.source_run_id) === older));
  for (const r of rows) {
    assert.deepEqual(
      [r.status, r.version, Number(r.created_by), r.key_parts.scrub_version],
      ["valid", 1, alice, 1],
    );
    assert.ok(!JSON.stringify(r.result).includes("nguyen.van.a@"), "scrubbed before the write");
  }

  const again = await backfillSharedResults({ apply: true, restart: true });
  assert.equal(again.inserted, 0, "idempotent");
  assert.equal(again.skipped.exists, 3, "both runs of r1 and the run of r2");
  assert.equal(
    (await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM shared_analyses WHERE trigger = 'backfill'",
    ))!.n,
    2,
  );

  // The backfilled key is the key today's request builds: the flow serves it.
  let starts = 0;
  const hit = await sharedCodeAssessment({
    actor: { id: alice },
    focus: "",
    commits: { [r1]: A },
    start: async () => (starts++, 0),
  });
  assert.equal(hit?.outcome, "hit");
  assert.equal(Number(hit!.analysis!.source_run_id), newest);
  assert.equal(starts, 0);
});
