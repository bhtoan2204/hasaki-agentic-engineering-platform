import { redactContextValue } from "./redact.ts";
import { pool, one, q } from "../db/pool.ts";
import { runChanges } from "../git/changes.ts";
import { summarizeValue } from "./plan.ts";
import { safeDiagnostics } from "../agent/telemetry.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";

/** Durable explanation, not a model-generated claim of success. The full constraints remain in immutable pack refs. */
export async function captureContextContinuity(ctx: ExecutionContext, result?: ExecResult) {
  const pack = ctx.context.contextPack;
  if (!pack?.id || !ctx.run.owner_id) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let files: unknown = { available: false, reason: "No live worktree evidence" };
  if (ctx.step.config.independent !== true)
    try {
      const changes = await Promise.race([
        runChanges(ctx.run.id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("change evidence timed out")), 5000);
        }),
      ]);
      files = changes.repos
        .slice(0, 30)
        .map((r: any) => ({
          repo: r.repo,
          branch: r.branch,
          commits: r.commits?.slice(0, 30),
          files: r.files?.slice(0, 100),
          uncommitted: r.status?.slice(0, 2000),
          omitted_files: Math.max(0, (r.files?.length ?? 0) - 100),
        }));
    } catch (error) {
      files = { available: false, reason: safeDiagnostics(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  const [attempt, evidence, questions] = await Promise.all([
    one(pool, "SELECT metrics FROM workflow_step_attempts WHERE id=$1 AND run_id=$2", [ctx.attempt.id, ctx.run.id]),
    q(pool, "SELECT id,tool,status FROM agent_context_tool_calls WHERE attempt_id=$1 ORDER BY id DESC LIMIT 100", [
      ctx.attempt.id,
    ]),
    q(pool, "SELECT id,question,status FROM workflow_questions WHERE attempt_id=$1 ORDER BY id LIMIT 20", [
      ctx.attempt.id,
    ]),
  ]);
  const content = {
    version: 1,
    run_id: ctx.run.id,
    step_id: ctx.step.id,
    attempt_id: ctx.attempt.id,
    pack_id: pack.id,
    snapshot_id: pack.snapshot_id,
    parent_pack_ids: pack.parent_pack_ids,
    asked_to_do: pack.entries
      .filter((e) => e.section === "requirements")
      .map((e) => ({ source: e.provenance, id: e.id })),
    applied_rules: pack.entries
      .filter((e) => e.section === "knowledge")
      .map((e) => ({ source: e.provenance, id: e.id, truncated: e.truncated ?? false })),
    decisions: pack.entries.filter((e) => e.section === "decisions").map((e) => ({ source: e.provenance, id: e.id })),
    retrieved_evidence: evidence,
    changed_files: files,
    outcome: result?.kind ?? "interrupted",
    verification: attempt?.metrics?.verification ?? null,
    independent_verification: attempt?.metrics?.independent_verification ?? null,
    unfinished: {
      questions,
      checkpoint: result?.kind === "waiting_input" ? summarizeValue(result.checkpoint ?? {}, 2000) : null,
      error: result?.kind === "failed" ? safeDiagnostics(result.error) : null,
    },
    agent_claims_unverified: summarizeValue(result?.kind === "completed" ? result.output : null, 3000),
    notice:
      "Historical observations. Requirements/rules are retained in the referenced immutable context pack; agent completion is not proof of verification or a production fix.",
  };
  await q(
    pool,
    `INSERT INTO agent_context_continuity(attempt_id,pack_id,content)
    SELECT a.id,$2,$3 FROM workflow_step_attempts a JOIN workflow_jobs j ON j.id=a.job_id
    WHERE a.id=$1 AND a.run_id=$4 AND a.status='RUNNING' AND j.status='running' AND j.fencing_token=$5 AND j.lease_expires_at>clock_timestamp()
    ON CONFLICT(attempt_id) DO UPDATE SET content=excluded.content`,
    [ctx.attempt.id, pack.id, JSON.stringify(redactContextValue(content)), ctx.run.id, ctx.attempt.fencing_token],
  );
}
