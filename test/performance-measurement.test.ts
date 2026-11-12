import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  distribution,
  measureQueries,
  pairedSummary,
  pinnedCandidateIdentity,
  platformPerformanceFixtures,
} from "../src/eval/performance.ts";
import { investigateSchedulerAndContext } from "../src/eval/performanceProbe.ts";
import { pool, withTx, q } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import * as scheduler from "../src/workflow/scheduler.ts";
import { heartbeat } from "../src/workflow/engine.ts";
import { reapExpiredLeases } from "../src/workflow/recovery.ts";
import { resolveContext, buildStepInput } from "../src/workflow/context.ts";

test("query measurement counts completed and failed operations without retaining SQL or parameters", async () => {
  const target = {
    async query(sql: string) {
      if (sql === "failure") throw new Error("expected");
      return { rows: [42] };
    },
  };
  const original = target.query;
  const observed = await measureQueries(target, async () => {
    assert.deepEqual(await target.query("private fixture statement"), { rows: [42] });
    await assert.rejects(target.query("failure"), /expected/);
    return "done";
  });
  assert.equal(observed.value, "done");
  assert.equal(observed.query_calls, 2);
  assert.equal(observed.query_failures, 1);
  assert.ok(observed.query_elapsed_ms >= 0);
  assert.equal(target.query, original);
  assert.doesNotMatch(JSON.stringify(observed), /private fixture|expected|statement/);
  await assert.rejects(
    measureQueries(target, async () => {
      throw new Error("aborted");
    }),
    /aborted/,
  );
  assert.equal(target.query, original);
});

test("paired reports retain slower samples and reject unmatched workloads or changed outputs", () => {
  assert.deepEqual(distribution([1, 2, 3, 4, 100]), { min: 1, median: 3, p95: 100, max: 100 });
  assert.equal(distribution([1, 3]).median, 2);
  const baseline = [
    { fixture: "small", repetition: 0, temperature: "warm", wall_ms: 10, output_hash: "a" },
  ];
  const candidate = [{ ...baseline[0], wall_ms: 15 }];
  assert.equal(pairedSummary(baseline, candidate)[0].delta_ms.median, 5);
  assert.throws(() => pairedSummary(baseline, []), /Unmatched/);
  assert.throws(
    () => pairedSummary(baseline, [{ ...candidate[0], output_hash: "b" }]),
    /Output mismatch/,
  );
  assert.throws(() => distribution([NaN]), /Invalid/);
});

test("a dirty worktree is not reported as the pinned HEAD revision", () => {
  const revision = "a".repeat(40);
  const tree = "b".repeat(40);
  assert.deepEqual(pinnedCandidateIdentity("", revision, tree), { revision, tree });
  assert.deepEqual(pinnedCandidateIdentity("?? .performance-baseline-abc/\n", revision, tree), {
    revision,
    tree,
  });
  assert.throws(
    () => pinnedCandidateIdentity(" M src/workflow/engine.ts\n", revision, tree),
    /cannot be reported as the pinned HEAD revision/,
  );
  assert.throws(() => pinnedCandidateIdentity("", "HEAD", tree), /full HEAD commit/);
});

test("scheduler and context probe claims, heartbeats, recovers and retrieves context", async () => {
  for (const fixture of platformPerformanceFixtures) {
    const phases: Record<string, number> = {};
    const summary = await investigateSchedulerAndContext(
      {
        pool,
        withTx,
        q,
        scheduler,
        heartbeat,
        reapExpiredLeases,
        resolveContext,
        buildStepInput,
        config,
      },
      phases,
      fixture,
    );
    assert.equal(summary.claimed, 1);
    assert.equal(summary.heartbeat, 1);
    assert.ok(summary.reaped >= 1);
    assert.equal(summary.knowledge, fixture.knowledge_items);
    assert.equal(summary.repositories, fixture.repositories);
    assert.equal(summary.upstream, fixture.context_entries);
    assert.equal(summary.answers, fixture.answers);
    assert.equal(summary.hidden_excluded, true);
    assert.ok(phases.context_retrieval_ms >= 0);
    assert.ok(phases.scheduler_active_ms >= 0);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM workflow_runs WHERE title = 'performance fixture'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM users WHERE password_hash = 'fixture-no-login'",
        )
      ).rows[0].n,
      0,
    );
  }
});

test("platform benchmark refuses inherited application endpoints before loading platform code", () => {
  const child = spawnSync(process.execPath, ["src/cli/benchPerformance.ts"], {
    env: {
      ...process.env,
      PLATFORM_TEST: "0",
      DATABASE_URL: "postgres://unused@remote.invalid/platform",
    },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(child.status, 1);
  assert.match(
    child.stderr,
    /Run this suite with --import .\/test\/setup.ts and test-owned PostgreSQL/,
  );
});
