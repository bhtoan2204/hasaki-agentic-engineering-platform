import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pool, one, q, retryTransient } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { answerQuestions, approveStep, beginAttempt, cancelRun, finishAttempt, getRun, heartbeat, pauseRun, reapExpiredLeases, releaseAttempt, resumeRun, startRun } from "../src/workflow/engine.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";

before(async () => {
  await migrate();
  await definitions.create({ key: "reliability-control", spec: { name: "control", steps: [
    { key: "a", type: "condition", config: { path: "inputs.go" } },
    { key: "b", type: "human_input", depends_on: ["a"] },
  ] } });
  await definitions.create({ key: "reliability-agent", spec: { name: "agent", steps: [{ key: "a", type: "agent", max_attempts: 1 }] } });
  await definitions.create({ key: "reliability-approval", spec: { name: "approval", steps: [{ key: "a", type: "condition", requires_approval: true, config: { path: "inputs.go" } }] } });
});
after(async () => { await settleBackground(); await pool.end(); });

async function claimed(definitionKey = "reliability-control") {
  const run = await startRun({ definitionKey });
  const job = await claimJob("reliability", 300);
  assert.equal(job?.run_id, run.id);
  const begun = await beginAttempt(job!, "reliability");
  assert.ok(begun);
  return { run, job: job!, begun };
}
async function rows(runId: number) {
  // A fresh connection sees only committed state; deferred workflow events are included.
  return {
    run: await one(pool, "SELECT * FROM workflow_runs WHERE id=$1", [runId]),
    steps: await q(pool, "SELECT * FROM workflow_steps WHERE run_id=$1 ORDER BY id", [runId]),
    jobs: await q(pool, "SELECT * FROM workflow_jobs WHERE run_id=$1 ORDER BY id", [runId]),
    attempts: await q(pool, "SELECT * FROM workflow_step_attempts WHERE run_id=$1 ORDER BY id", [runId]),
    questions: await q(pool, "SELECT * FROM workflow_questions WHERE run_id=$1 ORDER BY id", [runId]),
    checkpoints: await q(pool, "SELECT * FROM workflow_checkpoints WHERE run_id=$1 ORDER BY id", [runId]),
    events: await q(pool, "SELECT * FROM workflow_events WHERE run_id=$1 ORDER BY id", [runId]),
    effects: await q(pool, "SELECT * FROM workflow_run_effects WHERE run_id=$1 ORDER BY kind", [runId]),
    handoffs: await q(pool, "SELECT * FROM provider_handoffs WHERE run_id=$1 ORDER BY id", [runId]),
  };
}

// Real SQL failures, after earlier writes in the transaction: no mocked client or transaction wrapper.
async function failCheckpoint(runId: number, fn: () => Promise<unknown>) {
  await pool.query(`CREATE FUNCTION reliability_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.run_id = ${Number(runId)} THEN RAISE EXCEPTION 'injected checkpoint failure'; END IF; RETURN NEW; END $$`);
  await pool.query("CREATE TRIGGER reliability_checkpoint_failure BEFORE INSERT ON workflow_checkpoints FOR EACH ROW EXECUTE FUNCTION reliability_checkpoint_failure()");
  try { await assert.rejects(fn(), /injected checkpoint failure/); }
  finally {
    await pool.query("DROP TRIGGER reliability_checkpoint_failure ON workflow_checkpoints");
    await pool.query("DROP FUNCTION reliability_checkpoint_failure()");
  }
}

test("concurrent claims have one owner; crash before begin is recoverable and fences the old claim", async () => {
  const run = await startRun({ definitionKey: "reliability-control" });
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claimJob(`claim-${i}`, 300)));
  const winners = claims.filter((j) => j?.run_id === run.id);
  assert.equal(winners.length, 1);
  const job = winners[0]!;
  assert.equal(job.claims, 1);
  await q(pool, "UPDATE workflow_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal(await reapExpiredLeases(), 1);
  assert.equal(await beginAttempt(job, "old-worker"), null);
  const next = await claimJob("replacement", 300);
  assert.equal(next?.id, job.id);
  assert.ok(next!.fencing_token > job.fencing_token);
  const begun = await beginAttempt(next!, "replacement");
  assert.equal(begun?.attempt.number, 1);
  await cancelRun(run.id);
});

test("expired lease rejects completion before reaper; safe replay retains history and retry budget", async () => {
  const { run, job, begun } = await claimed();
  await q(pool, "UPDATE workflow_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal(await heartbeat(job.id, job.fencing_token, 300), false);
  assert.equal((await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { zombie: true } })).applied, false);
  assert.equal((await getRun(run.id)).steps[0].status, "RUNNING");
  await reapExpiredLeases();
  const state = await rows(run.id);
  assert.equal(state.attempts[0].status, "STALE");
  assert.equal(state.steps[0].attempt_count, 0);
  assert.equal(state.checkpoints[0].data.recovery.from_attempt_id, begun.attempt.id);
  const next = (await claimJob("replacement", 300))!;
  const nextAttempt = (await beginAttempt(next, "replacement"))!;
  assert.equal(nextAttempt.attempt.number, 2);
  assert.equal(nextAttempt.step.attempt_count, 1);
  assert.equal((await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { zombie: true } })).applied, false);
  await cancelRun(run.id);
});

test("completion checkpoint failure rolls back attempt, questions, steps, jobs, events and effects", async () => {
  const { run, job, begun } = await claimed();
  const before = await rows(run.id);
  const result = { kind: "waiting_input" as const, questions: [{ question: "continue?" }], checkpoint: { session_id: "persist-me" } };
  await failCheckpoint(run.id, () => finishAttempt(job.id, job.fencing_token, begun.attempt.id, result));
  assert.deepEqual(await rows(run.id), before);
  assert.equal((await finishAttempt(job.id, job.fencing_token, begun.attempt.id, result)).applied, true);
  const waiting = await rows(run.id);
  assert.equal(waiting.questions.length, 1);
  assert.equal(waiting.checkpoints[0].data.session_id, "persist-me");
  assert.equal((await finishAttempt(job.id, job.fencing_token, begun.attempt.id, result)).applied, false);
  assert.equal((await rows(run.id)).questions.length, 1);
  await cancelRun(run.id);
});

test("transient SQL failure during successful completion retries once without duplicate attempts or jobs", async () => {
  const { run, job, begun } = await claimed();
  await pool.query("CREATE SEQUENCE reliability_fault_seq");
  await pool.query(`CREATE FUNCTION reliability_job_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id = ${Number(job.id)} AND NEW.status='done' AND nextval('reliability_fault_seq')=1 THEN
      RAISE EXCEPTION 'injected connection failure' USING ERRCODE='08006'; END IF; RETURN NEW; END $$`);
  await pool.query("CREATE TRIGGER reliability_job_failure BEFORE UPDATE ON workflow_jobs FOR EACH ROW EXECUTE FUNCTION reliability_job_failure()");
  let calls = 0;
  try {
    await retryTransient(async () => {
      calls++;
      return finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { ok: true } });
    }, "completion fault", [0]);
  } finally {
    await pool.query("DROP TRIGGER reliability_job_failure ON workflow_jobs");
    await pool.query("DROP FUNCTION reliability_job_failure()");
    await pool.query("DROP SEQUENCE reliability_fault_seq");
  }
  assert.equal(calls, 2);
  const state = await rows(run.id);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.steps[0].attempt_count, 1);
  assert.deepEqual(state.steps.map((s) => s.status), ["COMPLETED", "READY"]);
  assert.equal(state.jobs.filter((j) => j.status === "queued").length, 1);
  assert.equal(state.events.filter((e) => e.content === "a: RUNNING → COMPLETED").length, 1);
  await cancelRun(run.id);
});

test("interruption rollback retains pending handoff; committed reconciliation preserves session, answers and budget", async () => {
  const { run, job, begun } = await claimed("reliability-agent");
  await q(pool, "INSERT INTO agent_sessions(attempt_id,session_id,cwd,provider) VALUES($1,'session-preserved','/tmp/preserved','claude')", [begun.attempt.id]);
  await q(pool, "INSERT INTO workflow_checkpoints(run_id,step_id,attempt_id,reason,data) VALUES($1,$2,$3,'progress',$4)", [run.id, begun.step.id, begun.attempt.id, { note: "preserved" }]);
  await q(pool, "INSERT INTO provider_handoffs(run_id,step_id,source_attempt_id,generation,original_provider,reason,status) VALUES($1,$2,$3,$4,'claude','manual','STOPPING')", [run.id, begun.step.id, begun.attempt.id, begun.step.generation]);
  const before = await rows(run.id);
  await failCheckpoint(run.id, () => releaseAttempt(job.id, job.fencing_token, begun.attempt.id, "lost worker"));
  assert.deepEqual(await rows(run.id), before);
  assert.equal(await releaseAttempt(job.id, job.fencing_token, begun.attempt.id, "lost worker"), true);
  assert.equal(await releaseAttempt(job.id, job.fencing_token, begun.attempt.id, "duplicate"), false);
  const state = await rows(run.id);
  assert.equal(state.steps[0].status, "WAITING_INPUT");
  assert.equal(state.steps[0].attempt_count, 0);
  assert.equal(state.handoffs[0].status, "BLOCKED");
  const cp = state.checkpoints.at(-1).data;
  assert.equal(cp.note, "preserved");
  assert.equal(cp.session_id, "session-preserved");
  assert.equal(cp.cwd, "/tmp/preserved");
  assert.equal(state.questions.length, 1);
  // A fresh API read after recovery sees durable state; answering cannot bypass the pending handoff.
  await answerQuestions({ [state.questions[0].id]: "Reconciled — continue" });
  assert.equal((await rows(run.id)).questions[0].status, "answered");
  assert.equal(await claimJob("blocked", 300), undefined);
  await cancelRun(run.id);
});

test("concurrent resume and approval retain existing conflict behavior without duplicate execution", async () => {
  const run = await startRun({ definitionKey: "reliability-control" });
  await pauseRun(run.id);
  const resumed = await Promise.allSettled([resumeRun(run.id), resumeRun(run.id)]);
  assert.equal(resumed.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = resumed.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  assert.equal((await rows(run.id)).jobs.filter((j) => j.status === "queued").length, 1);
  await cancelRun(run.id);
  const gated = await startRun({ definitionKey: "reliability-approval" });
  const approvals = await Promise.allSettled([approveStep(gated.id, "a"), approveStep(gated.id, "a")]);
  assert.equal(approvals.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((approvals.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.status, 409);
  assert.equal((await rows(gated.id)).jobs.length, 1);
  const job = (await claimJob("approval", 300))!;
  const begun = (await beginAttempt(job, "approval"))!;
  await cancelRun(gated.id);
  assert.equal((await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { late: true } })).applied, false);
  assert.equal((await getRun(gated.id)).status, "CANCELED");
  assert.equal((await rows(gated.id)).attempts[0].status, "CANCELED");
});

test("completion waits on run serialization before locking the job", async () => {
  const { run, job, begun } = await claimed();
  const blocker = await pool.connect();
  let finishing: ReturnType<typeof finishAttempt> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE", [run.id]);
    finishing = finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { ok: true } });
    // Wait for an observed PostgreSQL lock wait, not an assumed execution delay.
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = !!await one(pool, `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
        AND query='SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE'`);
      if (waiting) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(waiting, "completion reached run lock barrier");
    // If completion had acquired the job first this NOWAIT would fail.
    await blocker.query("SELECT id FROM workflow_jobs WHERE id=$1 FOR UPDATE NOWAIT", [job.id]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (finishing) await finishing;
    await cancelRun(run.id);
  }
});

test("failure flushing terminal events rolls back successful result, derived status and durable effects", async () => {
  const { run, job, begun } = await claimed("reliability-agent");
  const before = await rows(run.id);
  await pool.query(`CREATE FUNCTION reliability_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.run_id = ${Number(run.id)} AND NEW.kind='status' THEN RAISE EXCEPTION 'injected event flush failure'; END IF; RETURN NEW; END $$`);
  await pool.query("CREATE TRIGGER reliability_event_failure BEFORE INSERT ON workflow_events FOR EACH ROW EXECUTE FUNCTION reliability_event_failure()");
  try {
    await assert.rejects(finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { ok: true } }), /injected event flush failure/);
  } finally {
    await pool.query("DROP TRIGGER reliability_event_failure ON workflow_events");
    await pool.query("DROP FUNCTION reliability_event_failure()");
  }
  assert.deepEqual(await rows(run.id), before);
  assert.equal((await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { ok: true } })).applied, true);
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});

test("persisted run without optional policy metadata resumes its pinned graph and checkpoint", async () => {
  const { run, job, begun } = await claimed();
  await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "waiting_input", questions: [{ question: "legacy answer?" }], checkpoint: { note: "old checkpoint shape" } });
  await pauseRun(run.id);
  // Simulate absent optional metadata; retain mandatory owner and explicit worker assignment.
  await q(pool, "UPDATE workflow_runs SET policy_versions='{}'::jsonb WHERE id=$1", [run.id]);
  await definitions.saveDraft("reliability-control", { name: "new version", steps: [{ key: "new", type: "human_input" }] });
  await definitions.publish("reliability-control");
  const question = (await rows(run.id)).questions[0];
  await answerQuestions({ [question.id]: "retained answer" });
  await resumeRun(run.id);
  const next = (await claimJob("legacy", 300))!;
  const resumed = (await beginAttempt(next, "legacy"))!;
  assert.equal(resumed.step.key, "a");
  assert.equal(resumed.input.pending.resume.checkpoint.note, "old checkpoint shape");
  assert.equal(resumed.input.answers[0].answer, "retained answer");
  assert.equal(resumed.attempt.number, 2);
  await cancelRun(run.id);
});
