import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  beginAttempt,
  cancelRun,
  finishAttempt,
  getRun,
  reapExpiredLeases,
  startRun,
} from "../src/workflow/engine.ts";
import { recordExecutorReturn } from "../src/workflow/checkpoints.ts";
import { claimJob, drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { recordWorkspace } from "../src/git/provider.ts";
import { executionWorkspace } from "../src/git/workspaceCheckpoint.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { savePolicy } from "../src/workflow/autonomy.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import type { ExecResult } from "../src/workflow/types.ts";

const repo = "recovery-fixture";
let origin: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  }).trim();
/** Claimed as "<instance>:<pid>:…" by a worker process that has exited. */
const DEAD_WORKER = `${spawnSync("true").pid}:dead`;

// Scripted remote host: query-then-create keyed by source branch, like the real providers.
const remotePrs = new Map<string, number>();
let prCreates = 0;
let codingCalls = 0;
let codingResult: () => ExecResult = () => ({ kind: "completed", output: { summary: "done" } });

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  origin = join(config.reposRoot, repo);
  mkdirSync(origin, { recursive: true });
  execFileSync("git", ["-C", origin, "init", "-q", "-b", config.baseBranch]);
  writeFileSync(join(origin, "a.txt"), "base\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "base");
  await repositories.upsert(repo, { projects: ["RECOVERY"] });
  await definitions.create({
    key: "recovery-fixture",
    spec: {
      name: "Recovery fixture",
      steps: [{ key: "implement", type: "coding_agent", config: {}, max_attempts: 5 }],
    },
  });
  await definitions.create({
    key: "recovery-pr-fixture",
    spec: {
      name: "Recovery PR fixture",
      steps: [{ key: "pr", type: "git_pull_request", config: {} }],
    },
  });
  registerExecutor("coding_agent", {
    execute: async () => {
      codingCalls++;
      return codingResult();
    },
  });
  registerExecutor("integration", { execute: async () => ({ kind: "completed", output: {} }) });
  registerExecutor("git_pull_request", {
    execute: async (ctx) => {
      const key = `${repo}:${ctx.run.branch}`;
      if (!remotePrs.has(key)) remotePrs.set(key, ++prCreates);
      return { kind: "completed", output: { pull_requests: [{ id: remotePrs.get(key) }] } };
    },
  });
});

after(async () => {
  await settleBackground();
  setHandoffReadinessForTests(undefined);
  await pool.end();
});

beforeEach(async () => {
  await q(pool, "DELETE FROM autonomy_policies");
  await q(pool, "UPDATE workflow_jobs SET status = 'done' WHERE status = 'queued'");
  codingResult = () => ({ kind: "completed", output: { summary: "done" } });
});

const enableRecovery = (shadow = false) =>
  savePolicy({ scope_kind: "global", mode: "AUTONOMOUS", shadow, gates: ["recovery"] }, "admin");

type Begun = NonNullable<Awaited<ReturnType<typeof beginAttempt>>>;
type Job = NonNullable<Awaited<ReturnType<typeof claimJob>>>;

let seq = 0;
async function startWithWorktree(definitionKey = "recovery-fixture") {
  const run = await startRun({
    definitionKey,
    repositories: [repo],
    title: "Rename a label",
    profile: "STANDARD",
  });
  const path = join(config.reposRoot, `..`, `wt-recovery-${process.pid}-${++seq}`);
  git(origin, "worktree", "add", "-q", "-b", run.branch, path);
  await recordWorkspace(run.id, {
    repo,
    branch: run.branch,
    path,
    created_from: config.baseBranch,
  });
  return { run, path };
}

async function interrupt(
  runId: number,
  owner = DEAD_WORKER,
  beforeExpiry?: (begun: Begun, job: Job) => Promise<void>,
) {
  const job = (await claimJob(owner, 30))!;
  assert.equal(job.run_id, runId);
  const begun = (await beginAttempt(job, owner))!;
  await beforeExpiry?.(begun, job);
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );
  await reapExpiredLeases();
  return { job, begun };
}

const step = async (runId: number, key = "implement") =>
  (await getRun(runId)).steps.find((s) => s.key === key)!;
const recoveryDecisions = (runId: number) =>
  q<{ action: string; outcome: string; reason: string; details: Record<string, unknown> }>(
    pool,
    "SELECT action, outcome, reason, details FROM execution_decisions WHERE run_id=$1 AND kind='recovery' ORDER BY id",
    [runId],
  );
const openQuestions = async (runId: number) =>
  Number(
    (await one(
      pool,
      "SELECT count(*)::int AS n FROM workflow_questions WHERE run_id=$1 AND status='open'",
      [runId],
    ))!.n,
  );

test("no policy (legacy): an interrupted coding step waits for reconciliation, as before", async () => {
  const { run } = await startWithWorktree();
  await interrupt(run.id);
  assert.equal((await step(run.id)).status, "WAITING_INPUT");
  assert.equal(await openQuestions(run.id), 1);
  assert.equal((await recoveryDecisions(run.id))[0].action, "REQUIRES_RECONCILIATION");
});

test("killed mid-edit: proven safe → resumed without a human, local edits kept, the old worker is fenced", async () => {
  await enableRecovery();
  const { run, path } = await startWithWorktree();
  writeFileSync(join(path, "a.txt"), "half-done edit\n");
  writeFileSync(join(path, "new.txt"), "untracked work\n");
  const { job, begun } = await interrupt(run.id);
  const s = await step(run.id);
  assert.equal(s.status, "READY");
  assert.equal(s.pending_input.recovery.kind, "RESUME");
  assert.equal(await openQuestions(run.id), 0);
  assert.equal(readFileSync(join(path, "a.txt"), "utf8"), "half-done edit\n");
  assert.equal(readFileSync(join(path, "new.txt"), "utf8"), "untracked work\n");
  const stale = await finishAttempt(job.id, job.fencing_token, begun.attempt.id, {
    kind: "completed",
    output: { stale: true },
  });
  assert.equal(stale.applied, false);
  const [d] = await recoveryDecisions(run.id);
  assert.equal(d.action, "RESUME");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  assert.equal(readFileSync(join(path, "a.txt"), "utf8"), "half-done edit\n");
});

test("killed after commit and after a sealed checkpoint: resumed on the same HEAD", async () => {
  await enableRecovery();
  const { run, path } = await startWithWorktree();
  writeFileSync(join(path, "a.txt"), "committed\n");
  git(path, "commit", "-qam", "work");
  const head = git(path, "rev-parse", "HEAD");
  await interrupt(run.id, DEAD_WORKER, async (begun, job) => {
    const ws = await executionWorkspace((await getRun(run.id)) as never, begun.step);
    assert.ok(
      await recordExecutorReturn(
        job,
        begun.attempt.id,
        { kind: "completed", output: {} },
        { fingerprint: ws!.fingerprint },
      ),
    );
  });
  assert.equal((await step(run.id)).status, "READY");
  assert.equal(git(path, "rev-parse", "HEAD"), head);
});

test("not proven → no automatic restore, local data kept, the exact missing evidence goes to the human", async () => {
  await enableRecovery();
  const cases: Array<
    [
      string,
      (path: string) => void,
      RegExp,
      ((begun: Begun, job: Job, runId: number) => Promise<void>)?,
    ]
  > = [
    [
      "ownership mismatch",
      (p) => git(p, "checkout", "-q", "-b", `other-${seq}`),
      /worktree is on other-/,
    ],
    ["half-done git operation", () => {}, /index\.lock/],
    [
      "workspace changed after the checkpoint",
      () => {},
      /changed after the checkpoint/,
      async (begun, job, runId) => {
        const ws = await executionWorkspace((await getRun(runId)) as never, begun.step);
        await recordExecutorReturn(
          job,
          begun.attempt.id,
          { kind: "completed", output: {} },
          { fingerprint: ws!.fingerprint },
        );
        writeFileSync(
          join(
            (await q(pool, "SELECT path FROM execution_workspaces WHERE run_id=$1", [runId]))[0]
              .path,
            "late.txt",
          ),
          "x",
        );
      },
    ],
    [
      "corrupted checkpoint",
      () => {},
      /integrity/,
      async (begun, job, runId) => {
        const ws = await executionWorkspace((await getRun(runId)) as never, begun.step);
        await recordExecutorReturn(
          job,
          begun.attempt.id,
          { kind: "completed", output: {} },
          { fingerprint: ws!.fingerprint },
        );
        await q(
          pool,
          "UPDATE workflow_checkpoints SET execution = jsonb_set(execution, '{milestone}', '\"tampered\"') WHERE attempt_id=$1 AND reason='executor_returned'",
          [begun.attempt.id],
        );
      },
    ],
    ["the worker may still run", () => {}, /may still be active/],
  ];
  for (const [name, prepare, expected, hook] of cases) {
    const { run, path } = await startWithWorktree();
    writeFileSync(join(path, "keep.txt"), name);
    if (name === "half-done git operation")
      writeFileSync(git(path, "rev-parse", "--absolute-git-dir") + "/index.lock", "");
    else prepare(path);
    await interrupt(
      run.id,
      name === "the worker may still run" ? `${process.pid}:x` : DEAD_WORKER,
      hook && ((b, j) => hook(b, j, run.id)),
    );
    const s = await step(run.id);
    assert.equal(s.status, "WAITING_INPUT", name);
    const question = await one(
      pool,
      "SELECT context FROM workflow_questions WHERE run_id=$1 AND status='open'",
      [run.id],
    );
    assert.match(question!.context, expected, name);
    assert.equal(readFileSync(join(path, "keep.txt"), "utf8"), name);
  }
});

test("a process still working in the worktree blocks the resume", async () => {
  await enableRecovery();
  const { run, path } = await startWithWorktree();
  const child = spawn("sleep", ["10"], { cwd: path });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await interrupt(run.id);
    assert.equal((await step(run.id)).status, "WAITING_INPUT");
    assert.match(
      (await recoveryDecisions(run.id))[0].details.not_proven!.toString(),
      /processes still run in the worktree/,
    );
  } finally {
    child.kill("SIGKILL");
  }
});

test("shadow: the proof is recorded as planned but a human still reconciles", async () => {
  await enableRecovery(true);
  const { run } = await startWithWorktree();
  await interrupt(run.id);
  assert.equal((await step(run.id)).status, "WAITING_INPUT");
  const log = await recoveryDecisions(run.id);
  assert.deepEqual(
    log.map((d) => [d.action, d.outcome]),
    [
      ["REQUIRES_RECONCILIATION", "applied"],
      ["RESUME", "planned"],
    ],
  );
});

test("automatic resumes are bounded per step and survive restarts; a canceled run is not recovered", async () => {
  await enableRecovery();
  const { run } = await startWithWorktree();
  await interrupt(run.id);
  await interrupt(run.id);
  assert.equal((await step(run.id)).status, "READY");
  await interrupt(run.id);
  assert.equal((await step(run.id)).status, "WAITING_INPUT");
  const episode = await one(
    pool,
    "SELECT auto_recoveries, occurrences FROM recovery_episodes WHERE run_id=$1 AND signature='interrupted:coding_agent'",
    [run.id],
  );
  assert.deepEqual([episode!.auto_recoveries, episode!.occurrences], [2, 3]);

  const canceled = await startWithWorktree();
  const job = (await claimJob(DEAD_WORKER, 30))!;
  await beginAttempt(job, DEAD_WORKER);
  await cancelRun(canceled.run.id);
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );
  await reapExpiredLeases();
  assert.equal(
    (await recoveryDecisions(canceled.run.id)).filter((d) => d.action === "RESUME").length,
    0,
  );
  assert.equal((await getRun(canceled.run.id)).status, "CANCELED");
});

test("two reapers at once recover an interrupted attempt exactly once", async () => {
  await enableRecovery();
  const { run } = await startWithWorktree();
  const job = (await claimJob(DEAD_WORKER, 30))!;
  await beginAttempt(job, DEAD_WORKER);
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );
  await Promise.all([reapExpiredLeases(), reapExpiredLeases()]);
  assert.equal((await recoveryDecisions(run.id)).length, 1);
  assert.equal(
    Number(
      (await one(
        pool,
        "SELECT count(*)::int AS n FROM workflow_jobs WHERE run_id=$1 AND status='queued'",
        [run.id],
      ))!.n,
    ),
    1,
  );
});

test("crash after the remote PR was created: reconciled with the host, never a second PR; without policy it waits", async () => {
  const legacy = await startWithWorktree("recovery-pr-fixture");
  await interrupt(legacy.run.id, DEAD_WORKER, async (begun) => {
    remotePrs.set(`${repo}:${begun.run.branch}`, ++prCreates);
  });
  assert.equal((await step(legacy.run.id, "pr")).status, "WAITING_INPUT");

  await enableRecovery();
  const { run } = await startWithWorktree("recovery-pr-fixture");
  const before = prCreates;
  await interrupt(run.id, DEAD_WORKER, async (begun) => {
    remotePrs.set(`${repo}:${begun.run.branch}`, ++prCreates);
  });
  const s = await step(run.id, "pr");
  assert.equal(s.pending_input.recovery.kind, "RECONCILE");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  assert.equal(prCreates - before, 1, "duplicate external effects");
});

test("the same failure on an unchanged workspace escalates once as no-progress; counters outlive attempts; other runs unaffected", async () => {
  await enableRecovery();
  codingResult = () => ({
    kind: "failed",
    error: "3 tests failed in ./internal/label (0.42s)",
    retryable: true,
  });
  const { run } = await startWithWorktree();
  const other = await startWithWorktree();
  const calls = codingCalls;
  for (let i = 0; i < 4; i++) {
    await q(
      pool,
      "UPDATE workflow_jobs SET available_at = now() WHERE run_id = $1 AND status = 'queued'",
      [run.id],
    );
    await drain();
  }
  const s = await step(run.id);
  assert.equal(s.status, "WAITING_INPUT");
  assert.equal(s.attempt_count, 2);
  assert.ok(codingCalls - calls >= 2);
  const episode = await one(
    pool,
    "SELECT occurrences, status, notified_at FROM recovery_episodes WHERE run_id=$1 AND category='code_test'",
    [run.id],
  );
  assert.deepEqual(
    [episode!.occurrences, episode!.status, !!episode!.notified_at],
    [2, "escalated", true],
  );
  const q1 = await one(
    pool,
    "SELECT context FROM workflow_questions WHERE run_id=$1 AND status='open'",
    [run.id],
  );
  assert.match(q1!.context, /no progress/);
  const otherEpisodes = await q(pool, "SELECT occurrences FROM recovery_episodes WHERE run_id=$1", [
    other.run.id,
  ]);
  assert.ok(otherEpisodes.every((e) => e.occurrences <= 1));
});

test("without the recovery gate the same repeats keep the legacy bounded retry; the escalation is only recorded", async () => {
  codingResult = () => ({
    kind: "failed",
    error: "3 tests failed in ./internal/label (0.42s)",
    retryable: true,
  });
  const { run } = await startWithWorktree();
  for (let i = 0; i < 3; i++) {
    await q(
      pool,
      "UPDATE workflow_jobs SET available_at = now() WHERE run_id = $1 AND status = 'queued'",
      [run.id],
    );
    await drain();
  }
  assert.equal((await step(run.id)).status, "RETRYING");
  const shadow = (await recoveryDecisions(run.id)).filter((d) => d.details.shadow_escalation);
  assert.ok(shadow.length >= 1);
});

test("rate limit: Retry-After is honoured and the next try is persisted, not polled", async () => {
  codingResult = () => ({
    kind: "failed",
    error: "429 Too Many Requests, retry after 120 seconds",
    retryable: true,
    details: { failure_code: "RATE_LIMIT" },
  });
  const { run } = await startWithWorktree();
  await drain();
  const job = await one(
    pool,
    "SELECT available_at > now() + interval '115 seconds' AS later FROM workflow_jobs WHERE run_id=$1 AND status='queued'",
    [run.id],
  );
  assert.equal(job!.later, true);
  const episode = await one(
    pool,
    "SELECT category, next_eligible_at IS NOT NULL AS due FROM recovery_episodes WHERE run_id=$1",
    [run.id],
  );
  assert.deepEqual([episode!.category, episode!.due], ["rate_limit", true]);
  await cancelRun(run.id);
});

test("measurement: scripted crash fixtures, legacy path vs proven recovery", async () => {
  const measure = async (policy: boolean) => {
    await q(pool, "DELETE FROM autonomy_policies");
    if (policy) await enableRecovery();
    const runs: number[] = [];
    const callsBefore = codingCalls;
    const prsBefore = prCreates;
    for (let i = 0; i < 3; i++) {
      const { run, path } = await startWithWorktree();
      writeFileSync(join(path, "a.txt"), `edit ${i}\n`);
      await interrupt(run.id);
      runs.push(run.id);
      await q(
        pool,
        "UPDATE workflow_jobs SET available_at = now() + interval '1 hour' WHERE run_id = $1 AND status = 'queued'",
        [run.id],
      );
    }
    for (let i = 0; i < 2; i++) {
      const { run } = await startWithWorktree("recovery-pr-fixture");
      await interrupt(run.id, DEAD_WORKER, async (begun) => {
        remotePrs.set(`${repo}:${begun.run.branch}`, ++prCreates);
      });
      runs.push(run.id);
      await q(
        pool,
        "UPDATE workflow_jobs SET available_at = now() + interval '1 hour' WHERE run_id = $1 AND status = 'queued'",
        [run.id],
      );
    }
    await q(
      pool,
      "UPDATE workflow_jobs SET available_at = now() WHERE run_id = ANY($1) AND status = 'queued'",
      [runs],
    );
    await drain();
    const rows = await q(
      pool,
      `SELECT (SELECT count(*)::int FROM workflow_questions WHERE run_id = ANY($1) AND status = 'open') AS interventions,
              (SELECT count(*)::int FROM workflow_runs WHERE id = ANY($1) AND status = 'COMPLETED') AS recovered,
              (SELECT avg(latency_ms) FROM execution_decisions WHERE run_id = ANY($1) AND kind = 'recovery') AS latency_ms`,
      [runs],
    );
    return {
      fixtures: runs.length,
      recovered: rows[0].recovered,
      interventions: rows[0].interventions,
      recovery_latency_ms:
        rows[0].latency_ms == null ? null : Math.round(Number(rows[0].latency_ms)),
      extra_provider_invocations: codingCalls - callsBefore,
      duplicate_external_effects: prCreates - prsBefore - 2,
    };
  };
  const legacy = await measure(false);
  const proven = await measure(true);
  console.log(`recovery-measurement ${JSON.stringify({ legacy, proven })}`);
  assert.equal(legacy.interventions, 5);
  assert.equal(legacy.recovered, 0);
  assert.equal(proven.interventions, 0);
  assert.equal(proven.recovered, 5);
  assert.equal(proven.duplicate_external_effects, 0);
  assert.equal(proven.extra_provider_invocations, 3);
});
