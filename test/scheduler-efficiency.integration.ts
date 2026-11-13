import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { measureQueries } from "../src/eval/performance.ts";
import { claimJob, reconcileAutomaticHandoff } from "../src/workflow/scheduler.ts";
import { heartbeat } from "../src/workflow/engine.ts";
import { config } from "../src/config.ts";
import { instanceSession } from "../src/instances.ts";
import { definitions } from "../src/workflow/definitions.ts";

before(async () => {
  await migrate();
});

after(async () => {
  await pool.end();
});

test("idle claims do not each scan automatic handoffs", async () => {
  const observed = await measureQueries(pool, async () => {
    for (let i = 0; i < 8; i++) assert.equal(await claimJob(`idle-${i}`, 30), undefined);
  });
  assert.equal(observed.query_calls, 8);
  assert.equal(observed.query_failures, 0);
});

test("concurrent handoff reconciliation shares one scan and the next call scans again", async () => {
  const concurrent = await measureQueries(pool, async () => {
    await Promise.all([reconcileAutomaticHandoff(), reconcileAutomaticHandoff()]);
  });
  assert.equal(concurrent.query_calls, 1);
  const sequential = await measureQueries(pool, async () => {
    await reconcileAutomaticHandoff();
    await reconcileAutomaticHandoff();
  });
  assert.equal(sequential.query_calls, 2);
});

test("heartbeat executes one query to extend the lease and check stopping handoff", async () => {
  const observed = await measureQueries(pool, async () => {
    assert.equal(await heartbeat(999999, 1, 30, 999999), false);
  });
  assert.equal(observed.query_calls, 1);
  assert.equal(observed.query_failures, 0);
});

test("heartbeat behavioral regression: extends lease when healthy, refuses renewal when handoff is STOPPING", async () => {
  await q(
    pool,
    `INSERT INTO platform_instances (instance_id, session_id, started_at, last_seen_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (instance_id) DO UPDATE SET session_id = $2, stopped_at = NULL, last_seen_at = now()`,
    [config.instanceId, instanceSession],
  );

  const key = `sched-hb-${Date.now()}`;
  const def = await definitions.create({
    key,
    spec: {
      name: key,
      steps: [{ key: "test-step", type: "coding_agent", config: {} }],
    },
  });
  const versionId = def!.versions[0].id;

  const run = (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_runs (definition_key, definition_version_id, title, graph, branch, status, worker_instance, allowed_repositories)
     VALUES ($1, $2, 'Test Run', '[]'::jsonb, 'test-branch', 'RUNNING', $3, '{"repo-a"}') RETURNING id`,
    [key, versionId, config.instanceId],
  ))!;

  const step = (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation)
     VALUES ($1, 'test-step', 'coding_agent', 'Test Step', 0, 'RUNNING', 1) RETURNING id`,
    [run.id],
  ))!;

  const job = (await one<{ id: number; fencing_token: number; lease_expires_at: Date }>(
    pool,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, status, fencing_token, lease_owner, lease_expires_at)
     VALUES ($1, $2, 1, $3, 'running', 1, $4, now() + interval '30 seconds')
     RETURNING id, fencing_token, lease_expires_at`,
    [run.id, step.id, `job-key-${run.id}`, config.instanceId],
  ))!;

  const attempt = (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_step_attempts (run_id, step_id, number, generation, status, job_id, fencing_token, worker)
     VALUES ($1, $2, 1, 1, 'RUNNING', $3, 1, 'test-worker') RETURNING id`,
    [run.id, step.id, job.id],
  ))!;

  const initialExpiry = new Date(job.lease_expires_at).getTime();
  const ok = await heartbeat(job.id, job.fencing_token, 60, attempt.id);
  assert.equal(ok, true, "heartbeat returns true on healthy active job");

  const renewed = (await one<{ lease_expires_at: Date }>(
    pool,
    "SELECT lease_expires_at FROM workflow_jobs WHERE id = $1",
    [job.id],
  ))!;
  const renewedExpiry = new Date(renewed.lease_expires_at).getTime();
  assert.ok(renewedExpiry > initialExpiry, "heartbeat extended lease_expires_at");

  // Insert STOPPING provider handoff for this attempt
  await q(
    pool,
    `INSERT INTO provider_handoffs (run_id, step_id, source_attempt_id, generation, original_provider, reason, status)
     VALUES ($1, $2, $3, 1, 'claude', 'quota', 'STOPPING')`,
    [run.id, step.id, attempt.id],
  );

  const refused = await heartbeat(job.id, job.fencing_token, 60, attempt.id);
  assert.equal(refused, false, "heartbeat returns false when provider handoff is STOPPING");

  const unextended = (await one<{ lease_expires_at: Date }>(
    pool,
    "SELECT lease_expires_at FROM workflow_jobs WHERE id = $1",
    [job.id],
  ))!;
  assert.equal(
    new Date(unextended.lease_expires_at).getTime(),
    renewedExpiry,
    "lease_expires_at was not extended while STOPPING",
  );

  // Heartbeat without attemptId still evaluates successfully
  const withoutAttempt = await heartbeat(job.id, job.fencing_token, 60);
  assert.equal(withoutAttempt, true, "heartbeat without attemptId still succeeds");

  await q(pool, "DELETE FROM workflow_runs WHERE id = $1", [run.id]);
});
