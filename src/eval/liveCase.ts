import { ownsInstance } from "../instances.ts";
import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool, q, one, withTx } from "../db/pool.ts";
import { config } from "../config.ts";
import { CaseSchema } from "./dataset.ts";
import { fixtureGit } from "./fixtures.ts";
import { changedCloneCount, diffFootprint } from "./ponytailMetrics.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";
export const liveWorkRoot = (evaluationId: unknown, caseRunId: unknown) =>
  join(config.dataDir, "evaluation-work", String(evaluationId), String(caseRunId), "live");
// postmaster.pid may name a reused pid: only a postgres process serving this directory counts.
export async function postmasterState(data: string): Promise<"running" | "stopped" | "unknown"> {
  const missing = (error: { code?: unknown }) => {
    if (error.code === "ENOENT") return null;
    throw error;
  };
  try {
    const pidFile = await readFile(join(data, "postmaster.pid"), "utf8").catch(missing);
    if (pidFile === null) return "stopped";
    const pid = Number(pidFile.split("\n")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return "unknown";
    await readdir("/proc/self");
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(missing);
    const args = cmdline?.split("\0") ?? [];
    if (!args.some((a) => a.includes("postgres"))) return "stopped";
    if (args.includes(data)) return "running";
    // Another user's process (EACCES/EPERM) cannot be our postmaster.
    const cwd = await realpath(`/proc/${pid}/cwd`).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "EACCES" || e.code === "EPERM") return null;
      throw e;
    });
    return cwd !== null && cwd === (await realpath(data)) ? "running" : "stopped";
  } catch {
    return "unknown";
  }
}
export async function stopPostmaster(data: string) {
  const state = await postmasterState(data);
  if (state === "stopped") return;
  if (state === "unknown")
    throw new Error(`cannot tell whether a postmaster serves ${data}; left in place`);
  const env = { PATH: process.env.PATH, HOME: dirname(data), LANG: "C.UTF-8" };
  await promisify(execFile)("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], {
    env,
    timeout: 15000,
  }).catch((error: { code?: unknown }) => {
    if (error.code === "ENOENT") throw new Error("pg_ctl not found on PATH");
  });
  if ((await postmasterState(data)) !== "stopped")
    throw new Error(`postmaster still serves ${data}; left in place`);
}
export const subdirectories = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
export const liveDatabases = async (root: string) =>
  (await subdirectories(root))
    .filter((name) => /^database-[0-9a-f-]{36}$/.test(name))
    .map((name) => join(root, name));
export async function cleanupLiveWork(runId: number | null, root: string) {
  for (const data of await liveDatabases(root)) await stopPostmaster(data);
  await q(pool, "DELETE FROM execution_workspaces WHERE run_id=$1 AND path LIKE $2", [
    runId,
    `${root}/%`,
  ]);
  await rm(root, { recursive: true, force: true });
}
export async function executeLiveCase(
  ctx: ExecutionContext,
  caseRun: Record<string, unknown>,
): Promise<ExecResult> {
  const task = CaseSchema.parse(caseRun.definition);
  const cfg = caseRun.configuration as { blocked?: string; ponytail: boolean };
  const phases = await q(
    pool,
    `SELECT a.metrics,a.status FROM evaluation_provider_phases p JOIN workflow_steps s ON s.key=p.step_key AND s.run_id=$2 JOIN workflow_step_attempts a ON a.id=s.current_attempt_id WHERE p.case_run_id=$1 ORDER BY p.ordinal`,
    [caseRun.id, ctx.run.id],
  );
  const root = liveWorkRoot(caseRun.evaluation_id, caseRun.id);
  let footprint = { added: 0, removed: 0, files: 0 },
    newClones = 0;
  const before: Record<string, string> = {},
    after: Record<string, string> = {};
  try {
    for (const repo of task.repositories) {
      const path = join(root, repo);
      const base = await fixtureGit(path, ["rev-list", "--max-parents=0", "HEAD"]);
      await fixtureGit(path, ["add", "-N", "."]);
      const diff = diffFootprint(await fixtureGit(path, ["diff", "--numstat", base]));
      footprint = {
        added: footprint.added + diff.added,
        removed: footprint.removed + diff.removed,
        files: footprint.files + diff.files,
      };
      for (const file of (await fixtureGit(path, ["diff", "--name-only", base]))
        .split("\n")
        .filter(Boolean)) {
        before[`${repo}:${file}`] = await fixtureGit(path, ["show", `${base}:${file}`]).catch(
          () => "",
        );
        after[`${repo}:${file}`] = await readFile(join(path, file), "utf8").catch(() => "");
      }
    }
    newClones = changedCloneCount(before, after);
  } catch (error) {
    if (!cfg.blocked) throw error;
  }
  const live = phases.map((p) => p.metrics?.evaluation_live).filter(Boolean);
  const verified =
    task.category === "review"
      ? phases.some((p) => p.metrics?.independent_verification?.verdict === "PASS")
      : phases.some((p) => p.metrics?.verification?.passed === true);
  const complete =
    phases.length > 0 &&
    phases.every((p) => p.status === "COMPLETED") &&
    live.length === phases.length;
  const passed = !cfg.blocked && complete && verified;
  const status = cfg.blocked || !complete ? "BLOCKED" : passed ? "PASS" : "FAIL";
  const tokens = live.reduce((n, m) => n + Number(m.tokens ?? 0), 0);
  const cost = live.reduce((n, m) => n + Number(m.cost_usd ?? 0), 0);
  const duration = live.reduce((n, m) => n + Number(m.duration_ms ?? 0), 0);
  const evidence = {
    details: {
      evidence_kind: status === "BLOCKED" ? "blocked" : "live_provider",
      footprint,
      new_clones: newClones,
      activation: phases.flatMap((p) => p.metrics?.skills ?? []),
      context_tokens: phases.map((p) =>
        p.metrics?.evaluation_context
          ? Number(p.metrics.evaluation_context.system_append_tokens ?? 0) +
            Number(p.metrics.evaluation_context.pack_tokens ?? 0)
          : null,
      ),
      test_coverage_signal: verified ? "verification_passed" : "unknown",
    },
    duration_ms: duration,
    verification_passed: verified,
  };
  const saved = await withTx(async (c) => {
    const run = await one(c, "SELECT status FROM workflow_runs WHERE id=$1 FOR SHARE", [
      ctx.run.id,
    ]);
    const lease = await one(
      c,
      "SELECT id FROM workflow_jobs WHERE id=$1 AND status='running' AND fencing_token=$2 AND lease_expires_at>clock_timestamp() FOR SHARE",
      [ctx.attempt.job_id, ctx.attempt.fencing_token],
    );
    await q(c, "SELECT instance_id FROM platform_instances WHERE instance_id=$1 FOR SHARE", [
      config.instanceId,
    ]);
    const active = await one(
      c,
      "SELECT id FROM workflow_steps WHERE id=$1 AND current_attempt_id=$2 AND status='RUNNING'",
      [ctx.step.id, ctx.attempt.id],
    );
    if (!lease || !(await ownsInstance(c)) || !active || run?.status === "CANCELED") return null;
    const inserted = await one(
      c,
      `INSERT INTO eval_results(suite,scenario,candidate,status,correct,regression,verdict,repairs,human_gates,wall_s,cost_usd,tokens,run_id,data,case_run_id,owner_id,quality_score,hard_gates_passed,failure_class) VALUES($1,$2,$3,$4,$5,$6,$4,$7,0,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(case_run_id) DO NOTHING RETURNING id`,
      [
        `${caseRun.suite_key}@${caseRun.version}`,
        task.task_id,
        cfg.ponytail ? "ponytail" : "baseline",
        status,
        status === "BLOCKED" ? null : passed,
        !verified,
        phases.reduce((n, p) => n + Number(p.metrics?.verification?.repairs ?? 0), 0),
        Math.ceil(duration / 1000),
        live.length ? cost : null,
        live.length ? tokens : null,
        ctx.run.id,
        JSON.stringify({ evidence, repetition: caseRun.repetition }),
        caseRun.id,
        ctx.run.owner_id,
        passed ? 100 : 0,
        passed,
        status === "BLOCKED" ? "infrastructure" : passed ? null : "validation_failure",
      ],
    );
    // A retry after a crash between commit and completion finds its own result already stored.
    return (
      inserted ?? (await one(c, "SELECT id FROM eval_results WHERE case_run_id=$1", [caseRun.id]))
    );
  });
  if (!saved)
    return {
      kind: "failed",
      error: "Evaluation result fenced",
      retryable: false,
    };
  await cleanupLiveWork(ctx.run.id, root).catch((error) =>
    console.error(`live evaluation cleanup failed: ${(error as Error).message}`),
  );
  return {
    kind: "completed",
    output: { evaluation_result_id: saved?.id, verdict: status, evidence },
  };
}
