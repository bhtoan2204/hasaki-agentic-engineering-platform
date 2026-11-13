import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { config } from "../src/config.ts";
import { persistentInstanceId } from "../src/instanceIdentity.ts";
import {
  InstanceConflictError,
  instanceHealth,
  registerInstance,
  instanceSession,
  startInstanceHeartbeat,
} from "../src/instances.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  startRun,
  beginAttempt,
  finishAttempt,
  heartbeat,
  reapExpiredLeases,
  getRun,
  answerQuestions,
  runDetail,
  cancelRun,
} from "../src/workflow/engine.ts";
import { claimJob, drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { validateLocalConfiguration } from "../src/startupValidation.ts";
import { repositories, repoPath, syncRepositoriesFromConfig } from "../src/repos/service.ts";
import { resolveRepoPath, validateCheckout } from "../src/repos/paths.ts";
import { execution } from "../src/auth/execution.ts";
import { PersonalSession, personalSettings } from "../src/integrations/personal.ts";
import { attemptIsLive } from "../src/agent/platformTools.ts";
import { buildUserPrompt } from "../src/agent/stepPrompt.ts";
import { claudeExecutor } from "../src/agent/claude.ts";
import { ensureTestOwner } from "../src/auth/testOwner.ts";

const exec = promisify(execFile);
const child = async (id: string, mode: string, data?: unknown) => {
  const { stdout } = await exec(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "test/fixtures/instance-worker.ts",
      mode,
      ...(data ? [JSON.stringify(data)] : []),
    ],
    {
      env: { ...process.env, PLATFORM_INSTANCE: id },
      timeout: 15000,
    },
  );
  return stdout.trim() ? JSON.parse(stdout.trim()) : null;
};
/** Keeps the winner alive so a peer cannot treat its PID as gone and take the registration over. */
function registerAndHold(id: string) {
  const proc = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "test/fixtures/instance-worker.ts", "register-hold"],
    { env: { ...process.env, PLATFORM_INSTANCE: id } },
  );
  let out = "";
  let err = "";
  proc.stdout!.setEncoding("utf8");
  proc.stderr!.setEncoding("utf8");
  return new Promise<ChildProcess>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), 15000);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve(proc);
      else {
        proc.stdin?.end();
        reject(new Error(err || out || "register-hold failed"));
      }
    };
    proc.stdout!.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("registered")) finish(true);
    });
    proc.stderr!.on("data", (chunk: string) => {
      err += chunk;
    });
    proc.on("exit", () => finish(false));
  });
}
let seq = 0;
async function run(type: string) {
  const key = `recovery-${++seq}`;
  await definitions.create({
    key,
    spec: {
      name: key,
      steps: [
        {
          key: "only",
          type,
          name: "Only",
          ...(type === "condition"
            ? { config: { path: "inputs.ok" } }
            : type === "command"
              ? { config: { command: "echo never-executed" } }
              : {}),
        },
      ],
    },
  });
  return startRun({ definitionKey: key, outputLocale: "en" });
}
before(async () => {
  await migrate();
  registerExecutor("agent", {
    execute: async () => ({ kind: "completed", output: { recovered: true } }),
  });
  registerExecutor("condition", {
    execute: async () => ({ kind: "completed", output: { result: true } }),
  });
});
after(() => pool.end());

test("identity survives process restarts, is unique per installation, refuses Git storage and invalid IDs", async () => {
  const a = mkdtempSync(join(process.env.TEST_ROOT!, "identity-"));
  const b = mkdtempSync(join(process.env.TEST_ROOT!, "identity-"));
  const id = persistentInstanceId(a);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(persistentInstanceId(a), id);
  assert.equal(readFileSync(join(a, "instance-id"), "utf8").trim(), id);
  assert.notEqual(persistentInstanceId(b), id);
  const restart = () =>
    exec(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "test/fixtures/instance-worker.ts", "identity"],
      { env: { ...process.env, PLATFORM_INSTANCE: "" } },
    );
  assert.equal(JSON.parse((await restart()).stdout.trim()), config.instanceId);
  assert.equal(JSON.parse((await restart()).stdout.trim()), config.instanceId);
  assert.equal(persistentInstanceId(a, "legacy-host"), "legacy-host");
  assert.throws(() => persistentInstanceId(a, "bad:id"), /identity/);
  mkdirSync(join(b, ".git"));
  assert.throws(() => persistentInstanceId(join(b, "data")), /outside/);
});

test("two real processes share PostgreSQL: foreign claims and direct execution attempts are rejected", async () => {
  const r = await run("condition");
  const [foreign, owner] = await Promise.all([
    child("developer-b", "claim"),
    child(config.instanceId, "claim"),
  ]);
  assert.equal(foreign, null);
  assert.equal(owner.run_id, r.id);
  assert.equal(await child("developer-b", "begin", owner), false);
  const attempt = (await beginAttempt(owner, "parent"))!;
  assert.equal(
    (await child("developer-b", "finish", { job: owner, attempt: attempt.attempt })).applied,
    false,
  );
  // Foreign result rejection must not destroy the legitimate active attempt.
  assert.equal(
    (
      await finishAttempt(owner.id, owner.fencing_token, attempt.attempt.id, {
        kind: "completed",
        output: {},
      })
    ).applied,
    true,
  );
});

test("crash before result persistence: expired lease cannot revive or commit; owner safely retries control step", async () => {
  const r = await run("condition");
  const job = (await claimJob("crash", 30))!;
  const begun = (await beginAttempt(job, "crash"))!;
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );
  assert.equal(await heartbeat(job.id, job.fencing_token, 30), false);
  assert.equal((await attemptIsLive(begun.attempt.id, job.fencing_token)).ok, false);
  assert.equal(
    (
      await finishAttempt(job.id, job.fencing_token, begun.attempt.id, {
        kind: "completed",
        output: { stale: true },
      })
    ).applied,
    false,
  );
  await Promise.all([reapExpiredLeases(), reapExpiredLeases()]);
  assert.equal(await child("developer-b", "claim"), null);
  await drain();
  assert.equal((await getRun(r.id)).status, "COMPLETED");
  const history = await q(
    pool,
    "SELECT status FROM workflow_step_attempts WHERE run_id = $1 ORDER BY number",
    [r.id],
  );
  assert.deepEqual(
    history.map((a) => a.status),
    ["STALE", "COMPLETED"],
  );
});

test("interrupted non-idempotent agent never replays until explicit reconciliation, preserving session/checkpoint", async () => {
  const r = await run("agent");
  const job = (await claimJob("agent-crash", 30))!;
  const begun = (await beginAttempt(job, "agent-crash"))!;
  const oldQuestion = await one(
    pool,
    "INSERT INTO workflow_questions (run_id, step_id, attempt_id, question) VALUES ($1, $2, $3, 'Which file?') RETURNING id",
    [r.id, begun.step.id, begun.attempt.id],
  );
  await q(
    pool,
    "INSERT INTO agent_sessions (attempt_id, session_id, cwd, provider) VALUES ($1, 'saved-session', '/local/worktree', 'claude')",
    [begun.attempt.id],
  );
  await q(
    pool,
    "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'progress', '{\"note\":\"keep edits\"}')",
    [r.id, begun.step.id, begun.attempt.id],
  );
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );
  await reapExpiredLeases();
  assert.equal(await drain(), 0);
  const detail = await runDetail(r.id);
  assert.equal(detail.status, "WAITING");
  assert.equal(detail.worker.recovery, "NEEDS_ATTENTION");
  assert.equal(detail.steps[0].pending_input.resume.checkpoint.session_id, "saved-session");
  assert.equal(detail.steps[0].pending_input.resume.checkpoint.note, "keep edits");
  const question = detail.questions.find(
    (q) => q.id === detail.steps[0].pending_input.recovery.question_id,
  )!;
  await answerQuestions({ [oldQuestion!.id]: "src/payment.ts" });
  await assert.rejects(answerQuestions({ [question.id]: "just retry" }), /reconciled/);
  await answerQuestions({ [question.id]: "Reconciled — continue" });
  const recovered = (await getRun(r.id)).steps[0];
  const prompt = buildUserPrompt({ ...begun.input, pending: recovered.pending_input }, []);
  assert.ok(prompt.includes("Saved checkpoint") && prompt.includes("keep edits"));
  await drain();
  assert.equal((await getRun(r.id)).status, "COMPLETED");
  assert.equal(
    (
      await finishAttempt(job.id, job.fencing_token, begun.attempt.id, {
        kind: "completed",
        output: {},
      })
    ).applied,
    false,
  );
});

test("interrupted arbitrary commands and push/PR steps never get automatic replay", async () => {
  for (const type of ["command", "git_pull_request"]) {
    const r = await run(type);
    const job = (await claimJob("side-effect", 30))!;
    await beginAttempt(job, "side-effect");
    await q(
      pool,
      "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [job.id],
    );
    await reapExpiredLeases();
    assert.equal(await drain(), 0);
    assert.equal((await getRun(r.id)).steps[0].status, "WAITING_INPUT");
    const question = (await one(
      pool,
      "SELECT id FROM workflow_questions WHERE run_id = $1 AND status = 'open'",
      [r.id],
    ))!;
    await answerQuestions({ [question.id]: "Stop here" });
    assert.equal((await getRun(r.id)).status, "FAILED");
  }
});

test("replacement session fences an old worker with an unexpired job lease; same owner recovers", async () => {
  const r = await run("condition");
  const job = (await claimJob("old-process", 120))!;
  const begun = (await beginAttempt(job, "old-process"))!;
  await child(config.instanceId, "register");
  assert.equal(await heartbeat(job.id, job.fencing_token, 30), false);
  assert.equal(await claimJob("old-process", 30), undefined);
  assert.equal(
    (
      await finishAttempt(job.id, job.fencing_token, begun.attempt.id, {
        kind: "completed",
        output: {},
      })
    ).applied,
    false,
  );
  await q(
    pool,
    "UPDATE platform_instances SET last_seen_at = now() - interval '10 minutes' WHERE instance_id = $1",
    [config.instanceId],
  );
  await registerInstance();
  await reapExpiredLeases();
  await drain();
  assert.equal((await getRun(r.id)).status, "COMPLETED");
  assert.equal((await getRun(r.id)).worker_instance, config.instanceId);
  await q(pool, "DELETE FROM platform_instances WHERE instance_id = $1", [config.instanceId]);
});

test("registry rejects concurrent duplicate live IDs; replacement fences jobs; health uses database time", async () => {
  const pending = [registerAndHold(config.instanceId), registerAndHold(config.instanceId)];
  const results = await Promise.allSettled(pending);
  const live = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  try {
    assert.equal(live.length, 1);
    assert.match(
      String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason),
      /identity conflict/,
    );
  } finally {
    await Promise.all(
      live.map((proc) => {
        proc.stdin?.end();
        if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
        return once(proc, "exit");
      }),
    );
  }
  assert.equal((await instanceHealth(config.instanceId)).health, "ONLINE");
  await q(
    pool,
    "UPDATE platform_instances SET last_seen_at = now() - make_interval(secs => $2) WHERE instance_id = $1",
    [config.instanceId, config.instance.heartbeatSeconds * 2 + 1],
  );
  assert.equal((await instanceHealth(config.instanceId)).health, "STALE");
  await q(
    pool,
    "UPDATE platform_instances SET last_seen_at = now() - interval '10 minutes' WHERE instance_id = $1",
    [config.instanceId],
  );
  assert.equal((await instanceHealth(config.instanceId)).health, "OFFLINE");
  await registerInstance();
  assert.equal(
    (
      await one(pool, "SELECT session_id FROM platform_instances WHERE instance_id = $1", [
        config.instanceId,
      ])
    ).session_id,
    instanceSession,
  );
  await q(pool, "DELETE FROM platform_instances WHERE instance_id = $1", [config.instanceId]);
  const interval = config.instance.heartbeatSeconds;
  config.instance.heartbeatSeconds = 1;
  const hb = await startInstanceHeartbeat();
  try {
    await assert.rejects(startInstanceHeartbeat(), /already started/);
    await q(
      pool,
      "UPDATE platform_instances SET last_seen_at = now() - interval '3 seconds' WHERE instance_id = $1",
      [config.instanceId],
    );
    assert.equal((await instanceHealth(config.instanceId)).health, "STALE");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal((await instanceHealth(config.instanceId)).health, "ONLINE");
  } finally {
    await hb.stop();
    config.instance.heartbeatSeconds = interval;
  }
  assert.equal((await instanceHealth(config.instanceId)).health, "OFFLINE");
  assert.equal((await instanceHealth("unknown")).health, "UNKNOWN");
  await q(pool, "DELETE FROM platform_instances WHERE instance_id = $1", [config.instanceId]);
});

test("server startup waits once for an unclean exit without changing instance identity", async () => {
  const offline = config.instance.offlineSeconds;
  config.instance.offlineSeconds = 1;
  let hb: Awaited<ReturnType<typeof startInstanceHeartbeat>> | undefined;
  const waits: number[] = [];
  try {
    await registerInstance(config.instanceId, randomUUID());
    hb = await startInstanceHeartbeat({
      waitForPrevious: true,
      onWait: (seconds) => waits.push(seconds),
    });
    assert.deepEqual(waits, [1]);
    assert.equal(
      (await one(pool, "SELECT session_id FROM platform_instances WHERE instance_id=$1", [
        config.instanceId,
      ]))!.session_id,
      instanceSession,
    );
  } finally {
    await hb?.stop();
    config.instance.offlineSeconds = offline;
    await q(pool, "DELETE FROM platform_instances WHERE instance_id=$1", [config.instanceId]);
  }
});

test("startup grace period never replaces a registration that keeps heartbeating", async () => {
  const offline = config.instance.offlineSeconds;
  config.instance.offlineSeconds = 1;
  let pending = Promise.resolve();
  const liveSession = randomUUID();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await registerInstance(config.instanceId, liveSession);
    await assert.rejects(
      startInstanceHeartbeat({
        waitForPrevious: true,
        onWait: () => {
          timer = setInterval(() => {
            pending = pending.then(async () => {
              await q(
                pool,
                "UPDATE platform_instances SET last_seen_at=now() WHERE instance_id=$1 AND session_id=$2",
                [config.instanceId, liveSession],
              );
            });
          }, 100);
        },
      }),
      InstanceConflictError,
    );
    assert.equal(
      (await one(pool, "SELECT session_id FROM platform_instances WHERE instance_id=$1", [
        config.instanceId,
      ]))!.session_id,
      liveSession,
    );
  } finally {
    clearInterval(timer);
    await pending;
    config.instance.offlineSeconds = offline;
    await q(pool, "DELETE FROM platform_instances WHERE instance_id=$1", [config.instanceId]);
  }
  // A rejected startup must release the in-process guard for a later attempt.
  const hb = await startInstanceHeartbeat();
  await hb.stop();
  await q(pool, "DELETE FROM platform_instances WHERE instance_id=$1", [config.instanceId]);
});

test("startup takes over at once when the previous registration's process on this host is gone; otherwise it stays protected", async () => {
  const { previousProcessGone } = await import("../src/instances.ts");
  const host = hostname();
  // Decision rules (alive() injected).
  assert.equal(
    previousProcessGone({ host, pid: 4242 }, { host, pid: 1 }, () => false),
    true,
    "same host, dead pid",
  );
  assert.equal(
    previousProcessGone({ host, pid: 4242 }, { host, pid: 1 }, () => true),
    false,
    "same host, still running",
  );
  assert.equal(
    previousProcessGone({ host: "other-host", pid: 4242 }, { host, pid: 1 }, () => false),
    false,
    "another machine",
  );
  assert.equal(
    previousProcessGone({}, { host, pid: 1 }, () => false),
    false,
    "no pid recorded (older version)",
  );
  // End to end with a real exited process: no wait at all.
  const { spawnSync } = await import("node:child_process");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  let hb: Awaited<ReturnType<typeof startInstanceHeartbeat>> | undefined;
  const waits: number[] = [];
  try {
    await registerInstance(config.instanceId, randomUUID());
    await q(pool, "UPDATE platform_instances SET metadata = $2 WHERE instance_id = $1", [
      config.instanceId,
      JSON.stringify({ host, pid: dead }),
    ]);
    const t0 = Date.now();
    hb = await startInstanceHeartbeat({ waitForPrevious: true, onWait: (s) => waits.push(s) });
    assert.deepEqual(waits, [], "no grace-period wait");
    assert.ok(Date.now() - t0 < 5000);
    const row = await one(
      pool,
      "SELECT session_id, metadata FROM platform_instances WHERE instance_id=$1",
      [config.instanceId],
    );
    assert.equal(row!.session_id, instanceSession);
    assert.equal(row!.metadata.pid, process.pid, "the new process records itself");
  } finally {
    await hb?.stop();
    await q(pool, "DELETE FROM platform_instances WHERE instance_id=$1", [config.instanceId]);
  }
});

test("lost identity with existing local workspace records requires explicit administration", async () => {
  const r = await run("condition");
  await q(
    pool,
    "UPDATE workflow_runs SET worker_instance = 'original-installation' WHERE id = $1",
    [r.id],
  );
  await q(
    pool,
    "INSERT INTO execution_workspaces (run_id, repo, branch, path) VALUES ($1, 'local', 'existing', $2)",
    [r.id, join(config.dataDir, "worktrees", "existing", "local")],
  );
  await assert.rejects(registerInstance(), /cannot be inferred safely/);
  assert.equal((await getRun(r.id)).worker_instance, "original-installation");
  await cancelRun(r.id);
  await q(pool, "DELETE FROM execution_workspaces WHERE run_id = $1", [r.id]);
});

test("legacy hostname identities require administrator decision, never reassign runs", async () => {
  const r = await run("condition");
  await q(pool, "UPDATE workflow_runs SET worker_instance = $2 WHERE id = $1", [
    r.id,
    hostname().replace(/:/g, "-"),
  ]);
  await assert.rejects(registerInstance(), /Legacy hostname-owned/);
  assert.equal((await getRun(r.id)).worker_instance, hostname().replace(/:/g, "-"));
  await cancelRun(r.id);
});

test("local overrides survive shared metadata changes; missing checkout cannot disable shared registry", async () => {
  const original = config.repositories;
  const a = mkdtempSync(join(process.env.TEST_ROOT!, "checkout-a-"));
  const b = mkdtempSync(join(process.env.TEST_ROOT!, "checkout-b-"));
  try {
    await repositories.upsert("local-repo", {
      projects: ["Shared"],
      remote_slug: "team/local-repo",
    });
    config.repositories = { "local-repo": a };
    await exec("git", ["init", "-q", a]);
    await exec("git", [
      "-C",
      a,
      "remote",
      "add",
      "origin",
      "git@bitbucket.org:team/local-repo.git",
    ]);
    assert.equal(await validateCheckout((await repositories.get("local-repo"))!), a);
    assert.equal(
      resolveRepoPath({ name: "local-repo" }, { ...config, repositories: { "local-repo": b } }),
      b,
    );
    await repositories.upsert("local-repo", {
      description: "shared metadata update",
      path: "different/layout",
    });
    assert.equal(repoPath((await repositories.get("local-repo"))!), a);
    await repositories.upsert("local-repo", { remote_slug: "team/wrong" });
    await assert.rejects(
      validateCheckout((await repositories.get("local-repo"))!),
      /origin does not match/,
    );
    config.repositories = { "local-repo": join(a, "missing") };
    await syncRepositoriesFromConfig();
    assert.equal((await repositories.get("local-repo"))!.enabled, true);
    await assert.rejects(
      validateCheckout((await repositories.get("local-repo"))!),
      /unavailable locally/,
    );
    await assert.rejects(repositories.upsert("local-repo", { path: a }), /relative layout/);
    assert.throws(
      () =>
        resolveRepoPath(
          { name: "local-repo", path: "../../escape" },
          { ...config, repositories: {} },
        ),
      /Unsafe/,
    );
  } finally {
    config.repositories = original;
  }
});

test("missing optional providers emit actionable warnings without blocking startup", async () => {
  const warnings = await validateLocalConfiguration(() => false);
  assert.equal(warnings.filter((s) => /CLI unavailable/.test(s)).length, 3);
});

test("personal session memory and encrypted storage never cross authenticated actors or global settings", async () => {
  const owner = await ensureTestOwner();
  const other = (await one(
    pool,
    "INSERT INTO users (username, password_hash, role) VALUES ('other-session-user', 'unused', 'member') RETURNING id",
  ))!.id;
  const session = new PersonalSession<{ value: string }>();
  await execution.run({ userId: owner, kind: "user" }, async () => {
    session.current = { value: "private" };
    await personalSettings.set("argocd_token", "fake-private-value");
  });
  await execution.run({ userId: other, kind: "user" }, async () => {
    assert.equal(session.current, null);
    assert.equal(await personalSettings.get("argocd_token"), null);
  });
  const secret = await one(
    pool,
    "SELECT ciphertext FROM user_secrets WHERE user_id = $1 AND kind = 'argocd_token'",
    [owner],
  );
  assert.ok(secret && !secret.ciphertext.includes("fake-private-value"));
  assert.equal(await one(pool, "SELECT 1 FROM settings WHERE key = 'argocd_token'"), undefined);
});

test("coding preflight pauses for missing checkout without calling a model or disabling shared metadata", async () => {
  await repositories.upsert("missing-checkout", { projects: ["Missing"] });
  const result = await claudeExecutor.execute({
    run: {
      selected_repositories: ["missing-checkout"],
      output_locale: "en",
      agent_provider: "claude",
    },
    step: { type: "coding_agent" },
  } as any);
  assert.equal(result.kind, "waiting_input");
  assert.equal((await repositories.get("missing-checkout"))!.enabled, true);
});
