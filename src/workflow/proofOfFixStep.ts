import { pool, q, one, type Db } from "../db/pool.ts";
import { buildFixProof, type FixProofReport } from "../agent/proofOfFix.ts";
import type { ExecResult } from "./types.ts";

/** The part of the executor context this deterministic step needs (kept structural: no executor import cycle). */
interface ProofContext {
  run: {
    id: number;
    title: string;
    owner_id?: number | null;
    selected_repositories?: string[];
    inputs?: Record<string, unknown> | null;
  };
  step: { id: number; config: unknown };
  attempt: { id: number; generation: number };
  input: { upstream: Record<string, { output: unknown }> };
  log(kind: "system", content: string, data?: unknown): Promise<void>;
}

/**
 * `proof_of_fix` integration action: builds the run's Proof-of-Fix report from upstream step outputs and persists it
 * (append-only, one row per attempt). Deterministic; changes no code. A FAILED verdict fails the step (non-retryable)
 * so a pull request cannot follow a demonstrably broken fix; config.block_on can add verdicts (e.g. INCONCLUSIVE).
 *
 * config: { root_cause_from, report_from?, implement_from?, test_from?, review_from?, block_on? }
 */
export async function proofOfFixStep(ctx: ProofContext): Promise<ExecResult> {
  const cfg = ctx.step.config as Record<string, unknown>;
  const reviewFrom = typeof cfg.review_from === "string" ? cfg.review_from : undefined;
  // Independence comes from the trusted workflow definition, never from an output.
  const review = reviewFrom
    ? await one<{ config: Record<string, unknown>; type: string }>(
        pool,
        "SELECT config,type FROM workflow_steps WHERE run_id=$1 AND key=$2",
        [ctx.run.id, reviewFrom],
      )
    : null;
  const report = buildFixProof({
    upstream: ctx.input.upstream,
    rootCauseFrom: String(cfg.root_cause_from ?? "root_cause"),
    reportFrom: typeof cfg.report_from === "string" ? cfg.report_from : undefined,
    implementFrom: typeof cfg.implement_from === "string" ? cfg.implement_from : undefined,
    testFrom: typeof cfg.test_from === "string" ? cfg.test_from : undefined,
    reviewFrom,
    reviewIndependent: review?.config?.independent === true,
    incident: { title: ctx.run.title, request: String(ctx.run.inputs?.request ?? "") },
  });
  const owner = Number(ctx.run.owner_id);
  // Causal memory: earlier FAILED approaches for the same code are residual risks of this fix (caution, not a rule).
  if (Number.isSafeInteger(owner) && owner > 0) {
    const { recallCausal } = await import("../memory/causal.ts");
    const cautions = await recallCausal(owner, {
      text: `${report.incident.title} ${report.root_cause.hypothesis}`,
      repositories: ctx.run.selected_repositories ?? [],
      files: report.root_cause.supporting.flatMap((e) =>
        e.location ? [e.location.split(":")[0]] : [],
      ),
      limit: 3,
      tokenBudget: 300,
    }).catch(() => ({ items: [] as Array<{ negative: boolean; text: string; id: number }> }));
    for (const c of cautions.items.filter((x) => x.negative))
      report.residual_risks.push(
        `earlier failed approach (causal memory #${c.id}): ${c.text.slice(0, 300)}`,
      );
  }
  const proofId = await saveFixProof(pool, {
    runId: ctx.run.id,
    stepId: ctx.step.id,
    attemptId: ctx.attempt.id,
    generation: ctx.attempt.generation,
    report,
  });
  if (Number.isSafeInteger(owner) && owner > 0)
    await import("../memory/causal.ts")
      .then(({ captureFromProof }) =>
        captureFromProof({
          ownerId: owner,
          runId: ctx.run.id,
          fixProofId: proofId,
          report,
          upstream: ctx.input.upstream,
          implementFrom: typeof cfg.implement_from === "string" ? cfg.implement_from : undefined,
        }),
      )
      .catch((e) =>
        ctx.log("system", `causal memory not recorded: ${(e as Error).message.slice(0, 200)}`),
      );
  await ctx.log(
    "system",
    `proof of fix: ${report.verdict}${report.missing.length ? ` — missing: ${report.missing.slice(0, 4).join("; ")}` : ""}${report.verdict === "FAILED" ? ` — ${report.reasons.join("; ")}` : ""}`,
    { proof_of_fix: report.verdict },
  );
  const blockOn = Array.isArray(cfg.block_on) ? cfg.block_on.map(String) : ["FAILED"];
  if (blockOn.includes(report.verdict))
    return {
      kind: "failed",
      error: `proof of fix ${report.verdict}: ${[...report.reasons, ...report.missing].slice(0, 5).join("; ")}`,
      retryable: false,
      details: report as unknown as Record<string, unknown>,
    };
  return { kind: "completed", output: report as unknown as Record<string, unknown> };
}

export async function saveFixProof(
  db: Db,
  p: {
    runId: number;
    stepId: number | null;
    attemptId: number | null;
    generation: number | null;
    report: FixProofReport;
  },
) {
  const row = await one<{ id: number }>(
    db,
    `INSERT INTO fix_proofs(run_id,step_id,attempt_id,generation,mode,verdict,report) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (attempt_id) DO UPDATE SET verdict=EXCLUDED.verdict,report=EXCLUDED.report,mode=EXCLUDED.mode RETURNING id`,
    [
      p.runId,
      p.stepId,
      p.attemptId,
      p.generation,
      p.report.mode,
      p.report.verdict,
      JSON.stringify(p.report),
    ],
  );
  return row?.id ?? null;
}

/** The run's current proof (newest) and the history of verdicts. Callers authorize the run first. */
export async function fixProofOf(runId: number, db: Db = pool) {
  const rows = await q<{
    id: number;
    verdict: string;
    mode: string;
    report: FixProofReport;
    created_at: string;
    attempt_id: number | null;
  }>(
    db,
    "SELECT id,verdict,mode,report,created_at,attempt_id FROM fix_proofs WHERE run_id=$1 ORDER BY id DESC LIMIT 20",
    [runId],
  );
  return {
    current: rows[0] ?? null,
    history: rows.map(({ id, verdict, created_at, attempt_id }) => ({
      id,
      verdict,
      created_at,
      attempt_id,
    })),
  };
}
