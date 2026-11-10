import { pool, q, type Db } from "../db/pool.ts";
import { detectKnowledgeChanges } from "../knowledge/learning.ts";
import { extractRunMemory } from "../knowledge/memory.ts";
import { recordRunOutcome } from "../learning/outcomes.ts";
import { storeRunSummary } from "../report/runSummary.ts";
import type { RunStatus } from "./types.ts";

/** Work that must survive a crash between COMMIT and the in-process background task. */
export type EffectKind = "summary" | "outcome" | "memory" | "learning";

export function effectKindsFor(status: RunStatus): EffectKind[] {
  if (status === "COMPLETED") return ["summary", "outcome", "memory", "learning"];
  if (status === "FAILED" || status === "CANCELED") return ["summary", "outcome"];
  return [];
}

/** Insert in the same transaction as the status change. Existing rows are left to the worker. */
export async function enqueueRunEffects(c: Db, runId: number, status: RunStatus) {
  const kinds = effectKindsFor(status);
  if (!kinds.length) return;
  await q(
    c,
    `INSERT INTO workflow_run_effects (run_id, kind)
     SELECT $1, k FROM unnest($2::text[]) AS k
     ON CONFLICT DO NOTHING`,
    [runId, kinds],
  );
}

async function perform(kind: EffectKind, runId: number) {
  if (kind === "summary") {
    // storeRunSummary swallows errors. A missing snapshot must stay queued for the next claim.
    if (!(await storeRunSummary(runId))) throw new Error("summary was not stored");
    return;
  }
  if (kind === "outcome") {
    await recordRunOutcome(runId);
    return;
  }
  if (kind === "memory") {
    await extractRunMemory(runId);
    return;
  }
  // No model call unless a change analyzer is already registered. Unchanged inputs are not re-analysed.
  await detectKnowledgeChanges(runId);
}

/**
 * Claim a few pending effects and delete each only after it succeeds. Safe for overlapping workers:
 * SKIP LOCKED plus claimed_until stops a crash from dropping the row or running it twice at once.
 */
export async function dispatchRunEffects(limit = 8) {
  const rows = await q<{ run_id: number; kind: EffectKind }>(
    pool,
    `WITH picked AS (
       SELECT run_id, kind FROM workflow_run_effects
        WHERE claimed_until IS NULL OR claimed_until < now()
        ORDER BY created_at, run_id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE workflow_run_effects e
        SET claimed_until = now() + interval '10 minutes'
       FROM picked
      WHERE e.run_id = picked.run_id AND e.kind = picked.kind
     RETURNING e.run_id, e.kind`,
    [limit],
  );
  for (const row of rows) {
    try {
      await perform(row.kind, row.run_id);
      await q(pool, "DELETE FROM workflow_run_effects WHERE run_id = $1 AND kind = $2", [row.run_id, row.kind]);
    } catch (e) {
      await q(pool, "UPDATE workflow_run_effects SET claimed_until = NULL WHERE run_id = $1 AND kind = $2", [row.run_id, row.kind]).catch(() => {});
      console.error(`run effect ${row.kind} #${row.run_id}: ${(e as Error).message}`);
    }
  }
  return rows.length;
}
