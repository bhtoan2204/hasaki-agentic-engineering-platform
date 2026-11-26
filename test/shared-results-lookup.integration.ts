import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { codeAssessmentKey, rubricHash, type SharedKey } from "../src/sharing/key.ts";
import { lookupOrStart, waitForAnalysis, type LookupRequest } from "../src/sharing/service.ts";
import { settleSharedAnalyses } from "../src/sharing/settle.ts";
import { resetSharingHooks, setSharingHooks, sharingHooks } from "../src/sharing/hooks.ts";
import { analysisContext } from "../src/sharing/context.ts";
import { installationId } from "../src/sharing/scope.ts";
import { sharedCodeAssessment } from "../src/sharing/flows.ts";

let alice = 0;
let bob = 0;
let seq = 0;
before(async () => {
  await migrate();
  await seedTemplates();
  alice = (
    await createUser({ username: "share-alice", password: "share-alice-password", role: "member" })
  ).id;
  bob = (
    await createUser({ username: "share-bob", password: "share-bob-password", role: "member" })
  ).id;
  await definitions.create({
    key: "shared-fixture",
    spec: {
      name: "shared fixture",
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
  config.sharedResults.runningTimeoutMinutes = 360;
});

const SCOPE = "0b6f1a52-3c1e-4c8a-9d57-1f2a3b4c5d6e";
const newKey = (): SharedKey =>
  codeAssessmentKey({
    scope: SCOPE,
    repos: [{ repo: `repo-${++seq}`, commit: "a".repeat(40) }],
    workflow: { key: "codebase-assessment", version: 1 },
    rubricHash: rubricHash({ instructions: "assess" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
let starts = 0;
const request = (
  key: SharedKey,
  actor = alice,
  over: Partial<LookupRequest> = {},
): LookupRequest => ({
  key,
  actor: { id: actor },
  start: async (tx) => {
    starts++;
    return Number(
      (
        await startRun(
          {
            definitionKey: "shared-fixture",
            ownerId: actor,
            start: false,
            title: `share ${key.key.slice(0, 8)}`,
          },
          tx,
        )
      ).id,
    );
  },
  ...over,
});
const rowsOf = (key: SharedKey) =>
  q<{
    id: number;
    version: number;
    status: string;
    source_run_id: number | null;
    reuse_count: number;
  }>(
    pool,
    "SELECT id, version, status, source_run_id, reuse_count FROM shared_analyses WHERE kind = $1 AND key = $2 ORDER BY version",
    [key.kind, key.key],
  );
const runsFor = async (key: SharedKey) =>
  (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM workflow_runs WHERE title = $1", [
    `share ${key.key.slice(0, 8)}`,
  ]))!.n;
const complete = async (runId: number, output: unknown) => {
  await q(pool, "UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [runId]);
  await q(
    pool,
    "UPDATE workflow_steps SET status = 'COMPLETED', output = $2 WHERE run_id = $1 AND key = 'assess'",
    [runId, JSON.stringify(output)],
  );
};

test("miss claims the key and starts the run in one transaction; the next call waits instead of starting a second", async () => {
  const key = newKey();
  starts = 0;
  const first = await lookupOrStart(request(key));
  assert.equal(first.outcome, "miss");
  const rows = await rowsOf(key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "running");
  assert.equal(rows[0].source_run_id, first.outcome === "miss" ? first.runId : -1);
  const second = await lookupOrStart(request(key));
  assert.equal(second.outcome, "wait");
  assert.equal(second.analysis?.id, rows[0].id);
  assert.equal(starts, 1);
  assert.equal(await runsFor(key), 1);
});

test("N concurrent requests for one key start exactly one run; every other one waits on it", async () => {
  const key = newKey();
  starts = 0;
  const N = 12;
  const results = await Promise.all(Array.from({ length: N }, () => lookupOrStart(request(key))));
  const outcomes = results.map((r) => r.outcome).sort();
  assert.equal(outcomes.filter((o) => o === "miss").length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((o) => o === "wait").length, N - 1);
  assert.equal(starts, 1);
  assert.equal(await runsFor(key), 1);
  const rows = await rowsOf(key);
  assert.equal(rows.length, 1);
  assert.ok(
    results.every((r) => r.analysis?.id === rows[0].id),
    "everyone points at the same analysis",
  );
});

test("two instances (separate pools, separate connections) racing on one key still start exactly one run", async () => {
  const key = newKey();
  starts = 0;
  const other = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  try {
    // The second "instance" claims through its own connection: insert and wait on the same unique index.
    const viaOther = (async () => {
      const c = await other.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          `INSERT INTO shared_analyses (kind, key, version, status, key_parts, created_by, trigger)
           VALUES ($1, $2, COALESCE((SELECT max(version) FROM shared_analyses WHERE kind = $1 AND key = $2), 0) + 1, 'running', '{}', $3, 'manual')`,
          [key.kind, key.key, bob],
        );
        await new Promise((r) => setTimeout(r, 150)); // hold the claim while the first instance tries
        await c.query("COMMIT");
        return "claimed";
      } catch (e) {
        await c.query("ROLLBACK");
        return (e as { code?: string }).code === "23505" ? "lost" : String(e);
      } finally {
        c.release();
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    const here = await lookupOrStart(request(key));
    const there = await viaOther;
    assert.deepEqual(
      [there, here.outcome],
      ["claimed", "bypass"],
      "the other instance's claim (bob's) wins; alice may not read it",
    );
    assert.equal(starts, 0, "no second run");
  } finally {
    await other.end();
  }
});

test("a crash before the claim commits (the run fails to start) leaves no claim and no run; the next request claims", async () => {
  const key = newKey();
  await assert.rejects(
    lookupOrStart(
      request(key, alice, {
        start: async () => {
          throw new Error("engine refused");
        },
      }),
    ),
    /engine refused/,
  );
  assert.deepEqual(await rowsOf(key), []);
  assert.equal(await runsFor(key), 0);
  assert.equal((await lookupOrStart(request(key))).outcome, "miss");
});

test("a run that ends without publishing (canceled, crashed, failed) fails the claim; waiters are released and the key is free", async () => {
  const key = newKey();
  const first = await lookupOrStart(request(key));
  assert.equal(first.outcome, "miss");
  const id = first.analysis!.id;
  const waiting = waitForAnalysis(id, { id: alice }, { timeoutMs: 10_000, pollMs: 60_000 });
  await q(pool, "UPDATE workflow_runs SET status = 'CANCELED' WHERE id = $1", [
    first.outcome === "miss" ? first.runId : 0,
  ]);
  const started = Date.now();
  assert.ok((await settleSharedAnalyses()) >= 1, "this claim (and any other ended one) is settled");
  const w = await waiting;
  assert.equal(w.status, "failed");
  assert.ok(Date.now() - started < 5000, "woken by the notification, not by the 60 s poll");
  assert.match(JSON.stringify(w.analysis!.failure), /run canceled/);
  const again = await lookupOrStart(request(key));
  assert.equal(again.outcome, "miss", "a failed claim does not block the key");
  assert.equal(again.analysis!.version, 2);
});

test("a completed run publishes its snapshot; the creator then gets a hit without a model run, and the use is counted", async () => {
  const key = newKey();
  starts = 0;
  const first = await lookupOrStart(request(key));
  assert.equal(first.outcome, "miss");
  await complete(first.outcome === "miss" ? first.runId : 0, {
    findings: [{ id: "F1", title: "n+1 query" }],
  });
  await settleSharedAnalyses();
  const hit = await lookupOrStart(request(key));
  assert.equal(hit.outcome, "hit");
  assert.deepEqual(hit.analysis!.result, { findings: [{ id: "F1", title: "n+1 query" }] });
  assert.equal(starts, 1, "no second run");
  await settleBackground(); // the use is recorded in the background, after the answer
  const [row] = await rowsOf(key);
  assert.equal(row.reuse_count, 1);
  const uses = await q<{ outcome: string }>(
    pool,
    "SELECT outcome FROM shared_analysis_uses WHERE analysis_id = $1 ORDER BY id",
    [row.id],
  );
  assert.deepEqual(
    uses.map((u) => u.outcome),
    ["miss", "hit"],
  );
});

test("a completed run without the analysis output is failed, never published empty", async () => {
  const key = newKey();
  const first = await lookupOrStart(request(key));
  await q(pool, "UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [
    first.outcome === "miss" ? first.runId : 0,
  ]);
  await settleSharedAnalyses();
  const [row] = await rowsOf(key);
  assert.equal(row.status, "failed");
});

test("a run stuck past the running timeout fails its claim so the key is not blocked forever; a late result is not published", async () => {
  const key = newKey();
  const first = await lookupOrStart(request(key));
  const runId = first.outcome === "miss" ? first.runId : 0;
  await q(pool, "UPDATE workflow_runs SET status = 'RUNNING' WHERE id = $1", [runId]);
  await q(
    pool,
    "UPDATE shared_analyses SET started_at = now() - interval '7 hours' WHERE id = $1",
    [first.analysis!.id],
  );
  await settleSharedAnalyses();
  const [row] = await rowsOf(key);
  assert.equal(row.status, "failed");
  await complete(runId, { findings: [] });
  await settleSharedAnalyses();
  assert.equal((await rowsOf(key))[0].status, "failed", "the timed-out claim stays failed");
  assert.equal(
    (await lookupOrStart(request(key))).outcome,
    "bypass",
    "a failure that counts holds the key back (backoff)",
  );
  await q(
    pool,
    "UPDATE shared_analyses SET next_retry_at = now() - interval '1 minute' WHERE kind = $1 AND key = $2",
    [key.kind, key.key],
  );
  assert.equal(
    (await lookupOrStart(request(key))).outcome,
    "miss",
    "and frees it when the backoff has passed",
  );
});

test("a waiter gives up at its timeout and gets the running analysis back", async () => {
  const key = newKey();
  const first = await lookupOrStart(request(key));
  const t = Date.now();
  const w = await waitForAnalysis(
    first.analysis!.id,
    { id: alice },
    { timeoutMs: 300, pollMs: 50 },
  );
  assert.equal(w.status, "timeout");
  assert.equal(w.analysis!.status, "running");
  assert.ok(Date.now() - t < 2000);
});

test("two instances settling at once publish a row exactly once", async () => {
  const keys = [newKey(), newKey(), newKey()];
  for (const key of keys) {
    const r = await lookupOrStart(request(key));
    await complete(r.outcome === "miss" ? r.runId : 0, { findings: [] });
  }
  let published = 0;
  setSharingHooks({ observe: (e) => void (e.outcome === "published" && published++) });
  const counts = await Promise.all([
    settleSharedAnalyses(),
    settleSharedAnalyses(),
    settleSharedAnalyses(),
  ]);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    3,
  );
  assert.equal(published, 3);
  for (const key of keys) assert.equal((await rowsOf(key))[0].status, "valid");
});

test("access hook: a member the hook refuses runs unshared and never replaces the result", async () => {
  const key = newKey();
  const first = await lookupOrStart(request(key, alice));
  await complete(first.outcome === "miss" ? first.runId : 0, { findings: [] });
  await settleSharedAnalyses();
  starts = 0;
  const forBob = await lookupOrStart(request(key, bob));
  assert.equal(forBob.outcome, "bypass", "refused by the access hook");
  assert.equal(
    starts,
    0,
    "bypass does not start through the shared path (the caller starts its own run)",
  );
  assert.equal((await rowsOf(key)).length, 1, "alice's result is not superseded");
  setSharingHooks({ canRead: () => true });
  assert.equal(
    (await lookupOrStart(request(key, bob))).outcome,
    "hit",
    "allowed by the hook, bob reuses it",
  );
});

test("hooks for later steps: servable (step 4) and mayStart (step 4) are consulted", async () => {
  const key = newKey();
  const first = await lookupOrStart(request(key));
  await complete(first.outcome === "miss" ? first.runId : 0, { findings: [] });
  await settleSharedAnalyses();
  setSharingHooks({ servable: () => false });
  const stale = await lookupOrStart(request(key));
  assert.equal(stale.outcome, "miss", "an unservable (stale) result is re-run as a new version");
  assert.equal(stale.analysis!.version, 2);
  const key2 = newKey();
  setSharingHooks({ mayStart: () => false, servable: () => true });
  assert.equal((await lookupOrStart(request(key2))).outcome, "bypass");
  assert.deepEqual(await rowsOf(key2), []);
});

test("flags off: the flows return null and touch nothing (behaviour exactly as before)", async () => {
  config.sharedResults.codeAssessment = false;
  starts = 0;
  const r = await sharedCodeAssessment({
    actor: { id: alice },
    focus: "",
    commits: { "repo-off": "a".repeat(40) },
    start: async () => (starts++, 0),
  });
  assert.equal(r, null);
  assert.equal(starts, 0);
  config.sharedResults.prodErrors = false;
  config.sharedResults.codeAssessment = false;
  const before = (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM shared_analyses"))!
    .n;
  assert.equal(
    await settleSharedAnalyses(),
    0,
    "the reconcile task does nothing while both flags are off",
  );
  assert.equal(
    (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM shared_analyses"))!.n,
    before,
  );
});

test("the key of a real flow: the definition version, rubric and model come from the published workflow and the configuration", async () => {
  const ctx = await analysisContext(pool, "codebase-assessment", undefined);
  assert.ok(ctx.workflow.version >= 1);
  assert.match(ctx.rubricHash, /^[0-9a-f]{64}$/);
  assert.match(ctx.model, /^[a-z]+\/[^#]+#cfg:[0-9a-f]{16}$/);
  const codex = await analysisContext(pool, "codebase-assessment", "codex");
  assert.notEqual(codex.model, ctx.model, "another provider is another key");
  assert.equal(
    (await analysisContext(pool, "codebase-assessment", undefined)).model,
    ctx.model,
    "stable",
  );
  assert.match(await installationId(), /^[0-9a-f-]{36}$/);
  assert.ok(sharingHooks());
});
