import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { runtimeMetricsSnapshot } from "../src/runtimeMetrics.ts";
import {
  codeAssessmentKey,
  rubricHash,
  runtimeRcaKey,
  type SharedKey,
} from "../src/sharing/key.ts";
import { lookupOrStart, type LookupRequest } from "../src/sharing/service.ts";
import { expireSharedAnalyses, settleSharedAnalyses } from "../src/sharing/settle.ts";
import { resetSharingHooks, setSharingHooks } from "../src/sharing/hooks.ts";
import { describeAnalysis } from "../src/sharing/view.ts";
import { byId } from "../src/sharing/repository.ts";

const SCOPE = "0b6f1a52-3c1e-4c8a-9d57-1f2a3b4c5d6e";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
let alice = 0;
let bob = 0;
let seq = 0;
before(async () => {
  await migrate();
  await seedTemplates();
  alice = (
    await createUser({ username: "valid-alice", password: "valid-alice-password", role: "member" })
  ).id;
  bob = (
    await createUser({ username: "valid-bob", password: "valid-bob-password", role: "member" })
  ).id;
  await definitions.create({
    key: "shared-validity-fixture",
    spec: {
      name: "validity fixture",
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
  // These suites test lookup, validity and retry; access (step 5) is tested in shared-results-access.integration.ts.
  setSharingHooks({ observe: () => {}, canRead: (row, actor) => row.created_by === actor.id });
  config.sharedResults.prodErrors = true;
  config.sharedResults.codeAssessment = true;
  config.sharedResults.maxAttempts = 3;
  config.sharedResults.retryCapMinutes = 60;
  config.sharedResults.ttl = { runtimeRcaHours: 24, bugHuntDays: 30, codeAssessmentDays: 30 };
});

const repo = () => `valid-repo-${++seq}`;
const assessKey = (
  name: string,
  o: { commit?: string; rubric?: string; model?: string; version?: number; focus?: string } = {},
): SharedKey =>
  codeAssessmentKey({
    scope: SCOPE,
    repos: [{ repo: name, commit: o.commit ?? A }],
    focus: o.focus ?? "",
    workflow: { key: "codebase-assessment", version: o.version ?? 1 },
    rubricHash: rubricHash({ instructions: o.rubric ?? "assess" }),
    model: o.model ?? "claude/claude-opus-5-5#cfg:test",
  });
const request = (
  key: SharedKey,
  actor = alice,
  over: Partial<LookupRequest> = {},
): LookupRequest => ({
  key,
  actor: { id: actor, username: actor === alice ? "valid-alice" : "valid-bob" },
  scopeRepos: ((key.parts.repos as string[] | undefined) ?? []).map((r) => r.split("@")[0]),
  provenance: {
    provider: "claude",
    model: "claude/claude-opus-5-5#cfg:test",
    definitionVersion: 1,
    rubricHash: String(key.parts.rubric),
  },
  start: async (tx) =>
    Number(
      (
        await startRun(
          {
            definitionKey: "shared-validity-fixture",
            ownerId: actor,
            start: false,
            title: `validity ${key.key.slice(0, 8)}`,
          },
          tx,
        )
      ).id,
    ),
  ...over,
});
const rowsOf = (key: SharedKey) =>
  q<{
    id: number;
    version: number;
    status: string;
    stale_reason: string | null;
    attempts: number;
    trigger: string;
  }>(
    pool,
    "SELECT id, version, status, stale_reason, attempts, trigger FROM shared_analyses WHERE kind = $1 AND key = $2 ORDER BY version",
    [key.kind, key.key],
  );
const runIdOf = (r: Awaited<ReturnType<typeof lookupOrStart>>) =>
  r.outcome === "miss" || r.outcome === "forced" ? r.runId : 0;
const complete = async (runId: number, output: unknown = { findings: [] }) => {
  await q(pool, "UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [runId]);
  await q(
    pool,
    "UPDATE workflow_steps SET status = 'COMPLETED', output = $2 WHERE run_id = $1 AND key = 'assess'",
    [runId, JSON.stringify(output)],
  );
};
const publish = async (key: SharedKey, actor = alice, over: Partial<LookupRequest> = {}) => {
  const r = await lookupOrStart(request(key, actor, over));
  await complete(runIdOf(r));
  await settleSharedAnalyses();
  await settleBackground();
  return r;
};
const failRun = async (key: SharedKey, status = "FAILED") => {
  const r = await lookupOrStart(request(key));
  await q(pool, "UPDATE workflow_runs SET status = $2 WHERE id = $1", [runIdOf(r), status]);
  await settleSharedAnalyses();
  await settleBackground();
  return r;
};

// ---- stale rules
test("code moved: the result for the old commit is stale (commit_changed) once the new commit is analysed", async () => {
  const name = repo();
  const old = assessKey(name, { commit: A });
  await publish(old);
  assert.equal((await lookupOrStart(request(old))).outcome, "hit");
  const moved = assessKey(name, { commit: B });
  const second = await lookupOrStart(request(moved));
  assert.equal(
    second.outcome,
    "miss",
    "a new commit is a new key: never served from the old result",
  );
  await settleBackground();
  const [row] = await rowsOf(old);
  assert.equal(row.status, "stale");
  assert.equal(row.stale_reason, `commit_changed:${name}`);
});

test("rubric, definition and model changes make the old result stale with the matching reason", async () => {
  for (const [change, reason] of [
    [{ rubric: "assess more carefully" }, "rubric_changed"],
    [{ version: 2 }, "definition_changed"],
    [{ model: "claude/claude-sonnet-5-5#cfg:test" }, "model_changed"],
  ] as const) {
    const name = repo();
    const old = assessKey(name);
    await publish(old);
    const next = assessKey(name, change);
    assert.notEqual(next.key, old.key);
    assert.equal((await lookupOrStart(request(next))).outcome, "miss");
    await settleBackground();
    const [row] = await rowsOf(old);
    assert.deepEqual([row.status, row.stale_reason], ["stale", reason], JSON.stringify(change));
  }
});

test("a different subject is never made stale: another repository, another focus", async () => {
  const name = repo();
  const keep = assessKey(name, { focus: "refunds" });
  await publish(keep);
  await lookupOrStart(request(assessKey(name, { focus: "payments", commit: B })));
  await lookupOrStart(request(assessKey(repo(), { commit: B })));
  await settleBackground();
  assert.equal((await rowsOf(keep))[0].status, "valid");
});

test("TTL: a result past its end is not served, becomes stale with reason ttl, and the next request re-runs as a new version", async () => {
  const key = assessKey(repo());
  await publish(key);
  const [row] = await rowsOf(key);
  const valid = await one<{ valid_until: Date }>(
    pool,
    "SELECT valid_until FROM shared_analyses WHERE id = $1",
    [row.id],
  );
  const days = (valid!.valid_until.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `default TTL for an assessment is 30 days (${days})`);
  await q(
    pool,
    "UPDATE shared_analyses SET valid_until = now() - interval '1 minute' WHERE id = $1",
    [row.id],
  );
  const again = await lookupOrStart(request(key));
  assert.equal(again.outcome, "miss", "expired is not served, even before the sweep has marked it");
  assert.equal(again.analysis!.version, 2);
  await q(
    pool,
    "UPDATE shared_analyses SET status = 'valid', valid_until = now() - interval '1 minute', stale_reason = NULL WHERE id = $1",
    [row.id],
  );
  assert.ok((await expireSharedAnalyses()) >= 1);
  const [after] = await rowsOf(key);
  assert.deepEqual([after.status, after.stale_reason], ["stale", "ttl"]);
});

test("TTL is configurable per kind and applied at publish", async () => {
  config.sharedResults.ttl = { runtimeRcaHours: 6, bugHuntDays: 7, codeAssessmentDays: 2 };
  const key = assessKey(repo());
  await publish(key);
  const row = await one<{ hours: number }>(
    pool,
    "SELECT extract(epoch FROM (valid_until - finished_at)) / 3600 AS hours FROM shared_analyses WHERE kind = $1 AND key = $2",
    [key.kind, key.key],
  );
  assert.ok(Math.abs(Number(row!.hours) - 48) < 0.01);
});

// ---- failed, retry, backoff
test("a failed analysis is not cached forever: backoff 2^failures minutes, then it may start again", async () => {
  const key = assessKey(repo());
  await failRun(key);
  let [row] = await rowsOf(key);
  assert.deepEqual([row.status, row.attempts], ["failed", 1]);
  const wait = await one<{ minutes: number }>(
    pool,
    "SELECT extract(epoch FROM (next_retry_at - now())) / 60 AS minutes FROM shared_analyses WHERE id = $1",
    [row.id],
  );
  assert.ok(
    Math.abs(Number(wait!.minutes) - 2) < 0.1,
    `first backoff is 2 minutes (${wait!.minutes})`,
  );
  assert.equal(
    (await lookupOrStart(request(key))).outcome,
    "bypass",
    "held back during the backoff",
  );
  assert.equal((await rowsOf(key)).length, 1, "and nothing was started");
  await q(
    pool,
    "UPDATE shared_analyses SET next_retry_at = now() - interval '1 second' WHERE id = $1",
    [row.id],
  );
  const retry = await lookupOrStart(request(key));
  assert.equal(retry.outcome, "miss");
  assert.equal(retry.analysis!.version, 2);
  assert.equal(
    retry.analysis!.attempts,
    1,
    "the count of failures in a row is carried into the new version",
  );
  await q(pool, "UPDATE workflow_runs SET status = 'FAILED' WHERE id = $1", [runIdOf(retry)]);
  await settleSharedAnalyses();
  [row] = (await rowsOf(key)).slice(-1);
  assert.equal(row.attempts, 2);
  const second = await one<{ minutes: number }>(
    pool,
    "SELECT extract(epoch FROM (next_retry_at - now())) / 60 AS minutes FROM shared_analyses WHERE id = $1",
    [row.id],
  );
  assert.ok(Math.abs(Number(second!.minutes) - 4) < 0.1, "the second backoff is 4 minutes");
});

test("the backoff is capped, and after the maximum number of failures only a force re-run starts the key again", async () => {
  config.sharedResults.retryCapMinutes = 3;
  const key = assessKey(repo());
  for (let i = 0; i < 3; i++) {
    const [latest] = (await rowsOf(key)).slice(-1);
    if (latest)
      await q(
        pool,
        "UPDATE shared_analyses SET next_retry_at = now() - interval '1 second' WHERE id = $1",
        [latest.id],
      );
    await failRun(key);
  }
  const rows = await rowsOf(key);
  assert.deepEqual(
    rows.map((r) => r.attempts),
    [1, 2, 3],
  );
  const capped = await one<{ minutes: number }>(
    pool,
    "SELECT extract(epoch FROM (next_retry_at - now())) / 60 AS minutes FROM shared_analyses WHERE id = $1",
    [rows[2].id],
  );
  assert.ok(Number(capped!.minutes) <= 3.01, "capped at retryCapMinutes");
  await q(
    pool,
    "UPDATE shared_analyses SET next_retry_at = now() - interval '1 second' WHERE id = $1",
    [rows[2].id],
  );
  assert.equal(
    (await lookupOrStart(request(key))).outcome,
    "bypass",
    "out of attempts: even with the backoff over",
  );
  const forced = await lookupOrStart(request(key, alice, { force: true }));
  assert.equal(forced.outcome, "forced");
  assert.equal(forced.analysis!.attempts, 3, "the force starts it; the failures stay on record");
});

test("a run a person canceled is not a failure: no attempt counted, no backoff, the key is free at once", async () => {
  const key = assessKey(repo());
  await failRun(key, "CANCELED");
  const [row] = await rowsOf(key);
  assert.deepEqual([row.status, row.attempts], ["failed", 0]);
  const again = await lookupOrStart(request(key));
  assert.equal(again.outcome, "miss");
});

test("a success after failures starts the count again", async () => {
  const key = assessKey(repo());
  await failRun(key);
  await q(
    pool,
    "UPDATE shared_analyses SET next_retry_at = now() - interval '1 second' WHERE kind = $1 AND key = $2",
    [key.kind, key.key],
  );
  const ok = await lookupOrStart(request(key));
  await complete(runIdOf(ok));
  await settleSharedAnalyses();
  await q(
    pool,
    "UPDATE shared_analyses SET valid_until = now() - interval '1 minute' WHERE kind = $1 AND key = $2 AND status = 'valid'",
    [key.kind, key.key],
  );
  const next = await lookupOrStart(request(key));
  assert.equal(
    next.analysis!.attempts,
    0,
    "a valid latest version does not carry failures forward",
  );
});

// ---- force re-run
test("force re-run is a NEW VERSION: the old one stays valid and served until the new one is published, then it is superseded", async () => {
  const key = assessKey(repo());
  await publish(key);
  const forced = await lookupOrStart(request(key, alice, { force: true }));
  assert.equal(forced.outcome, "forced");
  assert.equal(forced.analysis!.version, 2);
  assert.equal(forced.analysis!.trigger, "force");
  let rows = await rowsOf(key);
  assert.deepEqual(
    rows.map((r) => [r.version, r.status]),
    [
      [1, "valid"],
      [2, "running"],
    ],
    "v1 is not touched while v2 runs",
  );
  const meanwhile = await lookupOrStart(request(key, alice));
  assert.equal(
    meanwhile.outcome,
    "wait",
    "nobody starts a third run: the forced one is the one in flight",
  );
  await complete(runIdOf(forced), { findings: [{ id: "NEW" }] });
  await settleSharedAnalyses();
  rows = await rowsOf(key);
  assert.deepEqual(
    rows.map((r) => [r.version, r.status]),
    [
      [1, "superseded"],
      [2, "valid"],
    ],
  );
  const hit = await lookupOrStart(request(key, alice));
  assert.equal(hit.outcome, "hit");
  assert.equal(hit.analysis!.version, 2);
  assert.deepEqual(hit.analysis!.result, { findings: [{ id: "NEW" }] });
});

test("a force beside a running analysis does not start a second run (single-flight is unchanged)", async () => {
  const key = assessKey(repo());
  const first = await lookupOrStart(request(key));
  assert.equal(first.outcome, "miss");
  const results = await Promise.all(
    Array.from({ length: 5 }, () => lookupOrStart(request(key, alice, { force: true }))),
  );
  assert.ok(results.every((r) => r.outcome === "wait"));
  assert.equal((await rowsOf(key)).length, 1);
});

test("a failed force leaves the last valid result in place", async () => {
  const key = assessKey(repo());
  await publish(key);
  const forced = await lookupOrStart(request(key, alice, { force: true }));
  await q(pool, "UPDATE workflow_runs SET status = 'FAILED' WHERE id = $1", [runIdOf(forced)]);
  await settleSharedAnalyses();
  assert.deepEqual(
    (await rowsOf(key)).map((r) => [r.version, r.status]),
    [
      [1, "valid"],
      [2, "failed"],
    ],
  );
  assert.equal(
    (await lookupOrStart(request(key))).outcome,
    "bypass",
    "the failed latest version holds the key; the valid v1 is not served meanwhile",
  );
});

test("a member who may not read the result cannot force over it (it would supersede it for everyone who may)", async () => {
  const key = assessKey(repo());
  await publish(key, alice);
  const forced = await lookupOrStart(request(key, bob, { force: true }));
  assert.equal(forced.outcome, "bypass");
  assert.deepEqual(
    (await rowsOf(key)).map((r) => [r.version, r.status]),
    [[1, "valid"]],
  );
});

// ---- provenance
test("provenance: who and how at claim time; tokens, cost, duration and validity at publish; the answer says all of it", async () => {
  const key = assessKey(repo(), { commit: C });
  const r = await lookupOrStart(request(key, alice));
  const [claimed] = await q<Record<string, unknown>>(
    pool,
    "SELECT created_by, trigger, provider, model, definition_version, rubric_hash, key_parts, finished_at FROM shared_analyses WHERE id = $1",
    [r.analysis!.id],
  );
  assert.deepEqual(
    [
      Number(claimed.created_by),
      claimed.trigger,
      claimed.provider,
      claimed.definition_version,
      claimed.rubric_hash,
      claimed.finished_at,
    ],
    [alice, "manual", "claude", 1, key.parts.rubric, null],
  );
  assert.equal(
    (claimed.key_parts as { workflow: string }).workflow,
    "codebase-assessment@1",
    "the key's inputs are kept readable",
  );
  await complete(runIdOf(r));
  await q(
    pool,
    "UPDATE workflow_runs SET started_at = now() - interval '90 seconds', finished_at = now() WHERE id = $1",
    [runIdOf(r)],
  );
  await settleSharedAnalyses();
  const hit = await lookupOrStart(request(key, bob, {}));
  assert.equal(hit.outcome, "bypass", "bob is refused by the access hook");
  const own = await lookupOrStart(request(key, alice));
  assert.equal(own.outcome, "hit");
  const view = await describeAnalysis(own, { id: alice, username: "valid-alice" });
  assert.deepEqual([view.run_by.id, view.run_by.name], [alice, "valid-alice"]);
  assert.equal(view.status, "valid");
  assert.equal(view.provenance.trigger, "manual");
  assert.equal(view.provenance.definition_version, 1);
  assert.equal(view.provenance.provider, "claude");
  assert.equal(view.provenance.model, "claude/claude-opus-5-5#cfg:test");
  assert.equal(view.provenance.key, key.key);
  assert.ok(
    view.provenance.duration_ms! >= 89_000 && view.provenance.duration_ms! < 120_000,
    "run wall time",
  );
  assert.equal(
    view.provenance.tokens_in,
    null,
    "no provider reported tokens: null, never an invented 0",
  );
  assert.equal(view.provenance.cost_usd, null);
  assert.equal(view.freshness.expired, false);
  assert.ok(view.freshness.age_seconds! >= 0 && view.freshness.age_seconds! < 30);
  assert.ok(view.freshness.valid_until);
  assert.equal(view.freshness.stale_reason, null);
  assert.equal(view.run_id, runIdOf(r), "the source run id only for the member who started it");
  assert.deepEqual(view.result, { findings: [] });
  const forBob = await describeAnalysis(
    { outcome: "hit", analysis: own.analysis! },
    { id: bob, username: "valid-bob" },
  );
  assert.equal(forBob.run_id, undefined, "runs stay owner-only");
  assert.equal(
    forBob.run_by.name,
    "valid-alice",
    "the runner is named in the same query as the row",
  );
});

test("provenance: tokens and cost come from the run's own attempts; a hit records the tokens it saved", async () => {
  const key = assessKey(repo());
  const r = await lookupOrStart(request(key));
  await complete(runIdOf(r));
  const step = await one<{ id: number }>(
    pool,
    "SELECT id FROM workflow_steps WHERE run_id = $1 AND key = 'assess'",
    [runIdOf(r)],
  );
  await q(
    pool,
    `INSERT INTO workflow_step_attempts (step_id, run_id, number, generation, status, worker, input, metrics)
     VALUES ($1, $2, 1, 1, 'COMPLETED', 'w', '{}', $3)`,
    [
      step!.id,
      runIdOf(r),
      JSON.stringify({ provider: "claude", tokens: { input: 1000, output: 250 }, cost_usd: 0.42 }),
    ],
  );
  await settleSharedAnalyses();
  const row = await one<{ tokens_in: number; tokens_out: number; cost_usd: string }>(
    pool,
    "SELECT tokens_in, tokens_out, cost_usd FROM shared_analyses WHERE kind = $1 AND key = $2",
    [key.kind, key.key],
  );
  assert.deepEqual(
    [Number(row!.tokens_in), Number(row!.tokens_out), Number(row!.cost_usd)],
    [1000, 250, 0.42],
  );
  await lookupOrStart(request(key));
  await settleBackground();
  const uses = await q<{ outcome: string; tokens_saved: number | null }>(
    pool,
    "SELECT u.outcome, u.tokens_saved FROM shared_analysis_uses u JOIN shared_analyses a ON a.id = u.analysis_id WHERE a.kind = $1 AND a.key = $2 ORDER BY u.id",
    [key.kind, key.key],
  );
  assert.deepEqual(
    uses.map((u) => [u.outcome, u.tokens_saved == null ? null : Number(u.tokens_saved)]),
    [
      ["miss", null],
      ["hit", 1250],
    ],
    "tokens saved = what the original run spent",
  );
});

test("the hit path adds no query and never waits for the use: one SELECT answers it; the use and the counter are one background statement", async () => {
  const key = assessKey(repo());
  await publish(key);
  await settleBackground();
  const statements = () => runtimeMetricsSnapshot().counters["db.statements"];
  // Another session holds the row the use would update: a hit that waited for it would hang.
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT 1 FROM shared_analyses WHERE kind = $1 AND key = $2 FOR UPDATE", [
    key.kind,
    key.key,
  ]);
  const before = statements();
  let hit;
  try {
    hit = await Promise.race([
      lookupOrStart(request(key)),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 5000)),
    ]);
    assert.notEqual(hit, "stuck", "the answer does not wait for the counter's UPDATE");
    assert.equal((hit as { outcome: string }).outcome, "hit");
  } finally {
    await holder.query("COMMIT");
    holder.release();
  }
  await settleBackground();
  assert.equal(
    statements() - before,
    2,
    "the lookup SELECT (the runner's name joined in) plus ONE statement for the use row and the counter",
  );
  const [row] = await q<{ reuse_count: number; last_reused_at: Date | null }>(
    pool,
    "SELECT reuse_count, last_reused_at FROM shared_analyses WHERE kind = $1 AND key = $2",
    [key.kind, key.key],
  );
  assert.equal(row.reuse_count, 1);
  assert.ok(row.last_reused_at);
  await lookupOrStart(request(key));
  await lookupOrStart(request(key));
  await settleBackground();
  assert.equal(
    (
      await q<{ reuse_count: number }>(
        pool,
        "SELECT reuse_count FROM shared_analyses WHERE kind = $1 AND key = $2",
        [key.kind, key.key],
      )
    )[0].reuse_count,
    3,
  );
  const uses = await q<{ outcome: string }>(
    pool,
    "SELECT outcome FROM shared_analysis_uses u JOIN shared_analyses a ON a.id = u.analysis_id WHERE a.kind = $1 AND a.key = $2 ORDER BY u.id",
    [key.kind, key.key],
  );
  assert.deepEqual(
    uses.map((u) => u.outcome),
    ["miss", "hit", "hit", "hit"],
  );
});

// ---- production error occurrences
test("production errors: new occurrences do not invalidate or re-run; the answer shows the counts now next to the counts then", async () => {
  const fp = "87d5edbc020d1f804eb9";
  await q(pool, "DELETE FROM prod_error_groups WHERE fingerprint = $1", [fp]);
  await q(
    pool,
    `INSERT INTO prod_error_groups (fingerprint, namespace, service, level, signature, day, today_count, yesterday_count, last_at, severity)
     VALUES ($1, 'oms', 'oms-api', 'error', 'order <n> not found', current_date, 40, 10, now() - interval '1 hour', 'high')`,
    [fp],
  );
  const key = runtimeRcaKey({
    scope: SCOPE,
    errorKey: fp,
    workflow: { key: "production-incident-investigation", version: 1 },
    contract: "unified-rca/v1",
    rubricHash: rubricHash({ instructions: "rca" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
  await q(pool, "DELETE FROM shared_analyses WHERE kind = $1 AND key = $2", [key.kind, key.key]);
  const req = (a = alice) => request(key, a, { errorKey: fp, scopeRepos: [] });
  const first = await lookupOrStart(req());
  await q(pool, "UPDATE workflow_steps SET key = 'report' WHERE run_id = $1", [
    runIdOf(first),
  ]).catch(() => {});
  await q(pool, "UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [runIdOf(first)]);
  await q(
    pool,
    "UPDATE workflow_steps SET status = 'COMPLETED', output = '{\"root_cause\":\"x\"}' WHERE run_id = $1",
    [runIdOf(first)],
  );
  await settleSharedAnalyses();
  const hit1 = await lookupOrStart(req());
  assert.equal(hit1.outcome, "hit");
  const v1 = await describeAnalysis(hit1, { id: alice });
  assert.equal(
    v1.occurrences!.at_analysis!.today_count,
    40,
    "what the group showed when it was analysed",
  );
  assert.equal(v1.occurrences!.now!.today_count, 40);
  assert.equal(v1.occurrences!.new_since_analysis, 0);
  // a later scan updates the group: the same row the scans write
  await q(
    pool,
    "UPDATE prod_error_groups SET today_count = 95, last_at = now() WHERE fingerprint = $1",
    [fp],
  );
  const hit2 = await lookupOrStart(req());
  assert.equal(hit2.outcome, "hit", "more occurrences do not invalidate it");
  assert.equal(hit2.analysis!.id, hit1.analysis!.id, "and nothing was analysed again");
  assert.equal(
    (
      await q(pool, "SELECT 1 FROM shared_analyses WHERE kind = $1 AND key = $2", [
        key.kind,
        key.key,
      ])
    ).length,
    1,
  );
  const v2 = await describeAnalysis(hit2, { id: alice });
  assert.equal(v2.occurrences!.at_analysis!.today_count, 40);
  assert.equal(v2.occurrences!.now!.today_count, 95);
  assert.equal(v2.occurrences!.new_since_analysis, 55);
  assert.equal(v2.status, "valid");
  // another day: counts are per scan window, so no difference is claimed
  await q(
    pool,
    "UPDATE prod_error_groups SET day = current_date + 1, today_count = 3 WHERE fingerprint = $1",
    [fp],
  );
  const v3 = await describeAnalysis(await lookupOrStart(req()), { id: alice });
  assert.equal(v3.occurrences!.new_since_analysis, null);
});

test("the answer for a failed analysis says why, when it can start again and whether it is out of attempts", async () => {
  const key = assessKey(repo());
  const r = await failRun(key);
  const row = (await rowsOf(key))[0];
  const bypass = await lookupOrStart(request(key));
  const view = await describeAnalysis(bypass, { id: alice, username: "valid-alice" });
  assert.equal(view.status, "failed");
  assert.equal(view.failure!.attempts, 1);
  assert.equal(view.failure!.reason, "run failed");
  assert.ok(view.failure!.retry_at, "when it may start again");
  assert.equal(view.failure!.exhausted, false);
  assert.ok(r && row);
  await q(pool, "UPDATE shared_analyses SET attempts = 3 WHERE id = $1", [row.id]);
  const exhausted = await describeAnalysis(await lookupOrStart(request(key)), { id: alice });
  assert.equal(exhausted.failure!.exhausted, true);
});

test("a stale result's answer carries the reason and is not served", async () => {
  const name = repo();
  const old = assessKey(name);
  await publish(old);
  await lookupOrStart(request(assessKey(name, { commit: B })));
  await settleBackground();
  const latest = await lookupOrStart(request(old));
  assert.equal(latest.outcome, "miss", "stale is never served");
  const [row] = await rowsOf(old);
  assert.equal(row.status, "stale");
  const described = await describeAnalysis(
    { outcome: "bypass", analysis: await byId(pool, row.id) },
    { id: alice },
  );
  assert.equal(described.status, "stale");
  assert.equal(
    described.freshness.stale_reason,
    `commit_changed:${name}`,
    "the answer says why it is stale",
  );
});
