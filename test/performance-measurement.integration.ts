import { test } from "node:test";
import assert from "node:assert/strict";
import { platformPerformanceFixtures } from "../src/eval/performance.ts";
import { investigateSchedulerAndContext } from "../src/eval/performanceProbe.ts";
import { pool, withTx, q } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import * as scheduler from "../src/workflow/scheduler.ts";
import { heartbeat } from "../src/workflow/engine.ts";
import { reapExpiredLeases } from "../src/workflow/recovery.ts";
import { resolveContext, buildStepInput } from "../src/workflow/context.ts";

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
