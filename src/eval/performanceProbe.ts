import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sha256 } from "./dataset.ts";
import type { claimJob } from "../workflow/scheduler.ts";
import type { heartbeat } from "../workflow/engine.ts";
import type { reapExpiredLeases } from "../workflow/recovery.ts";
import type { resolveContext } from "../workflow/context.ts";
import type { config } from "../config.ts";
import type { withTx } from "../db/pool.ts";

export interface PerformanceProbe {
  pool: pg.Pool;
  withTx: typeof withTx;
  scheduler: { claimJob: typeof claimJob };
  heartbeat: typeof heartbeat;
  reapExpiredLeases: typeof reapExpiredLeases;
  resolveContext: typeof resolveContext;
  config: typeof config;
}

/** One disposable run: real context retrieval, an active claim, heartbeat, then lease recovery. */
export async function investigateSchedulerAndContext(
  s: PerformanceProbe,
  phases: Record<string, number>,
) {
  const key = `p${randomUUID().replaceAll("-", "")}`;
  const spec = { name: "performance-fixture", steps: [], skills: [], knowledge: [] };
  let definitionId: number | undefined;
  let versionId: number | undefined;
  let runId: number | undefined;
  const summary = { knowledge: 0, claimed: 0, heartbeat: 0, reaped: 0 };
  try {
    const def = await s.pool.query(
      "INSERT INTO workflow_definitions (key, name) VALUES ($1, 'performance fixture') RETURNING id",
      [key],
    );
    definitionId = Number(def.rows[0].id);
    const ver = await s.pool.query(
      "INSERT INTO workflow_definition_versions (definition_id, version, spec, spec_hash) VALUES ($1, 1, $2::jsonb, $3) RETURNING id",
      [definitionId, JSON.stringify(spec), sha256(JSON.stringify(spec))],
    );
    versionId = Number(ver.rows[0].id);
    const run = await s.pool.query(
      `INSERT INTO workflow_runs (definition_version_id, definition_key, title, status, graph, branch, worker_instance)
       VALUES ($1, $2, 'performance fixture', 'RUNNING', $3::jsonb, 'measure', $4) RETURNING *`,
      [versionId, key, JSON.stringify(spec), s.config.instanceId],
    );
    runId = Number(run.rows[0].id);
    const step = await s.pool.query(
      `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation)
       VALUES ($1, 'measure', 'agent', 'Measure', 0, 'READY', 1) RETURNING *`,
      [runId],
    );
    const job = await s.pool.query(
      "INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key) VALUES ($1, $2, 1, $3) RETURNING id",
      [runId, step.rows[0].id, key],
    );
    const jobId = Number(job.rows[0].id);
    const retrievalStart = performance.now();
    const resolved = await s.withTx((client) =>
      s.resolveContext(
        client,
        run.rows[0],
        step.rows[0],
        {
          run: {
            id: runId!,
            title: "performance fixture",
            inputs: {},
            branch: "measure",
            definition_key: key,
            selected_repositories: [],
            allowed_repositories: [],
          },
          work_item: null,
          upstream: {},
          answers: [],
          pending: null,
          approval: null,
        },
        "claude",
      ),
    );
    phases.context_retrieval_ms = performance.now() - retrievalStart;
    summary.knowledge = resolved.knowledge.length;
    const activeStart = performance.now();
    const claimed = await s.scheduler.claimJob("performance-fixture", 30);
    if (!claimed || Number(claimed.id) !== jobId)
      throw new Error("Active-queue claim did not return the fixture job");
    summary.claimed = 1;
    if (!(await s.heartbeat(jobId, Number(claimed.fencing_token), 30)))
      throw new Error("Heartbeat did not hold the fixture lease");
    summary.heartbeat = 1;
    await s.pool.query(
      "UPDATE workflow_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    summary.reaped = await s.reapExpiredLeases();
    if (summary.reaped < 1) throw new Error("Expired fixture lease was not recovered");
    phases.scheduler_active_ms = performance.now() - activeStart;
    return summary;
  } finally {
    if (runId != null) await s.pool.query("DELETE FROM workflow_runs WHERE id = $1", [runId]);
    if (versionId != null)
      await s.pool.query("DELETE FROM workflow_definition_versions WHERE id = $1", [versionId]);
    if (definitionId != null)
      await s.pool.query("DELETE FROM workflow_definitions WHERE id = $1", [definitionId]);
  }
}
