import { execution } from "../auth/execution.ts";
import { pool, q, one, withTx } from "../db/pool.ts";
import { config } from "../config.ts";
import { instanceSession } from "../instances.ts";
import { hashOf } from "../workflow/definitions.ts";
import { safeDiagnostics } from "./telemetry.ts";
import type { PlatformToolEnv } from "./platformTools.ts";

/** Identity comes from worker-owned attempt data, never tool arguments or provider-selected IDs. */
export async function validateToolBinding(env: PlatformToolEnv) {
  const principal = execution.getStore();
  if (principal && (principal.userId !== env.ownerId || (principal.runId != null && principal.runId !== env.runId)))
    throw new Error("Authenticated principal does not own this run");
  const row = await one(
    pool,
    `SELECT a.effective_agent,a.run_id,a.step_id,a.status,a.fencing_token,a.generation AS attempt_generation,s.generation AS step_generation,s.type,s.current_attempt_id,s.status AS step_status,
    r.owner_id,r.worker_instance,r.status AS run_status,r.allowed_repositories,u.active,
    j.status AS job_status,j.fencing_token AS job_token,j.lease_expires_at>clock_timestamp() AS live,
    EXISTS(SELECT 1 FROM platform_instances i WHERE i.instance_id=r.worker_instance AND (i.session_id<>$2 OR i.stopped_at IS NOT NULL)) AS replaced
    FROM workflow_step_attempts a JOIN workflow_runs r ON r.id=a.run_id JOIN workflow_steps s ON s.id=a.step_id
    JOIN users u ON u.id=r.owner_id LEFT JOIN workflow_jobs j ON j.id=a.job_id AND j.run_id=a.run_id AND j.step_id=a.step_id AND j.generation=a.generation WHERE a.id=$1`,
    [env.attemptId, instanceSession],
  );
  if (
    !row ||
    !env.ownerId ||
    Number(row.owner_id) !== Number(env.ownerId) ||
    row.run_id !== env.runId ||
    row.step_id !== env.stepId
  )
    throw new Error("Attempt identity or owner mismatch");
  if (
    row.attempt_generation !== row.step_generation ||
    !row.active ||
    row.worker_instance !== config.instanceId ||
    row.replaced ||
    row.run_status === "CANCELED" ||
    !row.live ||
    row.job_status !== "running" ||
    row.status !== "RUNNING" ||
    row.step_status !== "RUNNING" ||
    row.current_attempt_id !== env.attemptId ||
    env.fencingToken == null ||
    Number(row.job_token) !== Number(env.fencingToken) ||
    Number(row.fencing_token) !== Number(env.fencingToken)
  )
    throw new Error("Attempt inactive, fenced, worker replaced or lease expired");
  env.attemptAllowedTools = row.effective_agent?.allowed_tools;
  if (env.policy) env.policy.allowedTools = env.attemptAllowedTools;
  if (env.mode === "coding" && row.type !== "coding_agent")
    throw new Error("Coding permission is not authorized by this workflow step");
  if (
    env.allowed.some((r) => !row.allowed_repositories.includes(r)) ||
    env.selected.some((r) => !env.allowed.includes(r))
  )
    throw new Error("Repository permissions exceed the persisted run scope");
}
export async function journalToolCall(
  env: PlatformToolEnv,
  name: string,
  readOnly: boolean,
  status: "ok" | "error" | "denied" | "timeout",
  started: number,
  args: unknown,
  result: string,
) {
  // Evidence is redacted, bounded and owner-scoped. SQL aggregation, rather than increments, makes retrying writes safe.
  await withTx(async (c) => {
    await q(
      c,
      `INSERT INTO agent_context_tool_calls(attempt_id,run_id,step_id,owner_id,worker_instance,pack_id,tool,read_only,status,duration_ms,input_hash,evidence)
      SELECT a.id,a.run_id,a.step_id,r.owner_id,r.worker_instance,p.id,$5,$6,$7,$8,$9,$10 FROM workflow_step_attempts a
      JOIN workflow_runs r ON r.id=a.run_id LEFT JOIN agent_context_packs p ON p.attempt_id=a.id
      WHERE a.id=$1 AND a.run_id=$2 AND a.step_id=$3 AND r.owner_id=$4`,
      [
        env.attemptId,
        env.runId,
        env.stepId,
        env.ownerId,
        name,
        readOnly,
        status,
        performance.now() - started,
        hashOf(args ?? {}),
        JSON.stringify({ result: result.slice(0, 24000), truncated: result.length > 24000 }),
      ],
    );
    await q(
      c,
      `UPDATE workflow_step_attempts a SET metrics=COALESCE(a.metrics,'{}')||jsonb_build_object('context_tools',stats.value)
      FROM (SELECT jsonb_build_object('calls',count(*),'failures',count(*) FILTER(WHERE status<>'ok'),
        'retrieval_calls',count(*) FILTER(WHERE read_only),'retrieval_failures',count(*) FILTER(WHERE read_only AND status<>'ok'),
        'duration_ms',sum(duration_ms)) AS value FROM agent_context_tool_calls WHERE attempt_id=$1) stats
      WHERE a.id=$1 AND a.run_id=$2 AND a.step_id=$3 AND a.status='RUNNING' AND a.fencing_token=$4`,
      [env.attemptId, env.runId, env.stepId, env.fencingToken],
    );
  });
}
export async function auditToolDenial(env: PlatformToolEnv, name: string, error: unknown) {
  // Do not write into an unrelated attempt's evidence if an environment identity has been forged.
  await q(
    pool,
    `INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail)
    SELECT id,'platform_tool.denied','attempt',$2,$3 FROM users WHERE id=$1`,
    [env.ownerId ?? null, String(env.attemptId), JSON.stringify({ tool: name, reason: safeDiagnostics(error) })],
  ).catch(() => {});
}
export async function postClarification(
  env: PlatformToolEnv,
  questions: Array<{ question: string; context?: string; options?: string[] }>,
) {
  return withTx(async (c) => {
    await q(c, "SET LOCAL statement_timeout='10s'");
    const run = await one(
      c,
      "SELECT id FROM workflow_runs WHERE id=$1 AND owner_id=$2 AND status<>'CANCELED' FOR UPDATE",
      [env.runId, env.ownerId],
    );
    if (!run) throw new Error("Run is no longer authorized");
    const active = await one(
      c,
      `SELECT a.id FROM workflow_step_attempts a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_jobs j ON j.id=a.job_id
      WHERE a.id=$1 AND a.step_id=$2 AND a.run_id=$3 AND a.status='RUNNING' AND s.current_attempt_id=a.id AND s.generation=a.generation
      AND j.fencing_token=$4 AND j.status='running' AND j.lease_expires_at>clock_timestamp()`,
      [env.attemptId, env.stepId, env.runId, env.fencingToken],
    );
    if (!active) throw new Error("Clarification attempt is no longer live");
    const existing = await one(
      c,
      "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id=$1 AND status='open'",
      [env.attemptId],
    );
    if (existing.n) return existing.n;
    for (const x of questions)
      await q(
        c,
        `INSERT INTO workflow_questions(run_id,step_id,attempt_id,question,context,options,suggested_answer) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          env.runId,
          env.stepId,
          env.attemptId,
          x.question,
          x.context ?? "",
          JSON.stringify(x.options ?? []),
          x.options?.[0] ?? null,
        ],
      );
    return questions.length;
  });
}
