import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sha256 } from "./dataset.ts";
import type { claimJob } from "../workflow/scheduler.ts";
import type { heartbeat } from "../workflow/engine.ts";
import type { reapExpiredLeases } from "../workflow/recovery.ts";
import type { resolveContext, buildStepInput } from "../workflow/context.ts";
import type { config } from "../config.ts";
import type { withTx, q } from "../db/pool.ts";

export interface PerformanceProbe {
  pool: pg.Pool;
  withTx: typeof withTx;
  q: typeof q;
  scheduler: { claimJob: typeof claimJob };
  heartbeat: typeof heartbeat;
  reapExpiredLeases: typeof reapExpiredLeases;
  resolveContext: typeof resolveContext;
  buildStepInput: typeof buildStepInput;
  config: typeof config;
}

/** One disposable run: real context retrieval, an active claim, heartbeat, then lease recovery. */
export async function investigateSchedulerAndContext(
  s: PerformanceProbe,
  phases: Record<string, number>,
  workload: {
    knowledge_items: number;
    context_entries: number;
    repositories: number;
    answers: number;
  },
) {
  const key = `p${randomUUID().replaceAll("-", "")}`;
  const repos = Array.from({ length: workload.repositories }, (_, i) => `${key}-repo-${i}`);
  const hiddenRepo = `${key}-hidden`;
  const upstreamKeys = Array.from({ length: workload.context_entries }, (_, i) => `source-${i}`);
  const spec = {
    name: "performance-fixture",
    steps: [
      ...upstreamKeys.map((key) => ({ key, type: "agent", depends_on: [] })),
      { key: "measure", type: "agent", depends_on: upstreamKeys },
    ],
    skills: [`${key}.rule.0`],
    knowledge: [`${key}.rule.1`, `${key}.hidden`],
  };
  let definitionId: number | undefined;
  let versionId: number | undefined;
  let runId: number | undefined;
  let ownerId: number | undefined;
  const summary = {
    knowledge: 0,
    repositories: 0,
    upstream: 0,
    answers: 0,
    hidden_excluded: false,
    retrieval_hash: "",
    claimed: 0,
    heartbeat: 0,
    reaped: 0,
  };
  try {
    ownerId = Number(
      (
        await s.pool.query(
          "INSERT INTO users (username, password_hash, role) VALUES ($1, 'fixture-no-login', 'member') RETURNING id",
          [key.slice(0, 30)],
        )
      ).rows[0].id,
    );
    // Local registry entries have no hosted remote and cannot initiate external permission checks.
    await s.q(
      s.pool,
      "INSERT INTO repositories (name, provider, projects, allowed_actions) SELECT name, 'local', ARRAY[$2], ARRAY['read'] FROM unnest($1::text[]) AS name",
      [[...repos, hiddenRepo], key],
    );
    await s.q(
      s.pool,
      "INSERT INTO user_repository_access (user_id, repository_id, can_read) SELECT $1, id, true FROM repositories WHERE name = ANY($2)",
      [ownerId, repos],
    );
    const items = Array.from({ length: workload.knowledge_items }, (_, i) => ({
      key: `${key}.rule.${i}`,
      category: i % 2 ? "business_rule" : "agent_skill",
      scope: ["REPOSITORY", "PROJECT", "WORKFLOW"][i % 3],
      ref: i % 3 === 0 ? repos[i % repos.length] : key,
    }));
    items.push({
      key: `${key}.hidden`,
      category: "business_rule",
      scope: "REPOSITORY",
      ref: hiddenRepo,
    });
    await s.q(
      s.pool,
      `INSERT INTO knowledge_items (key, category, scope_type, scope_ref, title, owner_id, current_version)
       SELECT key, category, scope, ref, 'Fixture workflow ownership rule', $2, 1
       FROM jsonb_to_recordset($1) AS item(key text, category text, scope text, ref text)`,
      [JSON.stringify(items), ownerId],
    );
    await s.q(
      s.pool,
      `INSERT INTO knowledge_versions (item_id, version, content)
       SELECT id, 1, 'Fixture workflow ownership and recovery rule ' || split_part(key, '.', 3)
       FROM knowledge_items WHERE owner_id = $1`,
      [ownerId],
    );
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
      `INSERT INTO workflow_runs (definition_version_id, definition_key, title, status, graph, branch, worker_instance, owner_id, selected_repositories, allowed_repositories, inputs)
       VALUES ($1, $2, 'performance fixture', 'RUNNING', $3::jsonb, 'measure', $4, $5, $6, $6, $7) RETURNING *`,
      [
        versionId,
        key,
        JSON.stringify(spec),
        s.config.instanceId,
        ownerId,
        repos,
        JSON.stringify({ project: key }),
      ],
    );
    runId = Number(run.rows[0].id);
    const step = await s.pool.query(
      `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation, depends_on)
       VALUES ($1, 'measure', 'agent', 'Measure', $2, 'READY', 1, $3) RETURNING *`,
      [runId, upstreamKeys.length, upstreamKeys],
    );
    await s.pool.query(
      `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation, output)
       SELECT $1, 'source-' || n, 'agent', 'Fixture upstream', n, 'COMPLETED', 1,
         jsonb_build_object('keywords', jsonb_build_array('workflow', 'ownership'), 'evidence', 'src/fixture-' || n || '.ts:1', 'decision', repeat('Preserve ownership and recovery. ', 16))
       FROM generate_series(0, $2::int - 1) AS n`,
      [runId, upstreamKeys.length],
    );
    await s.pool.query(
      `INSERT INTO workflow_questions (run_id, step_id, question, status, answer)
       SELECT $1, $2, 'Fixture scope question ' || n, 'answered', 'Keep the repository scope'
       FROM generate_series(1, $3::int) AS n`,
      [runId, step.rows[0].id, workload.answers],
    );
    const job = await s.pool.query(
      "INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key) VALUES ($1, $2, 1, $3) RETURNING id",
      [runId, step.rows[0].id, key],
    );
    const jobId = Number(job.rows[0].id);
    const retrievalStart = performance.now();
    const resolved = await s.withTx(async (client) =>
      s.resolveContext(
        client,
        run.rows[0],
        step.rows[0],
        await s.buildStepInput(client, run.rows[0], step.rows[0]),
        "claude",
      ),
    );
    phases.context_retrieval_ms = performance.now() - retrievalStart;
    const selected = resolved.knowledge.filter((item) => item.key.startsWith(`${key}.rule.`));
    summary.knowledge = selected.length;
    summary.repositories = resolved.repoPaths?.length ?? 0;
    summary.upstream = Object.keys(resolved.upstream.plan).length;
    summary.answers = Number(
      (
        await s.pool.query(
          "SELECT content->>'answers' AS answers FROM context_snapshots WHERE id=$1",
          [resolved.snapshot_id],
        )
      ).rows[0].answers,
    );
    summary.hidden_excluded = !resolved.knowledge.some((item) => item.key === `${key}.hidden`);
    summary.retrieval_hash = sha256(
      JSON.stringify({
        content: selected.map((item) => item.content).sort(),
        upstream: resolved.upstream,
        answers: summary.answers,
        repositories: summary.repositories,
      }),
    );
    if (
      summary.knowledge !== workload.knowledge_items ||
      summary.repositories !== repos.length ||
      summary.upstream !== upstreamKeys.length ||
      summary.answers !== workload.answers ||
      !summary.hidden_excluded
    )
      throw new Error(
        "Representative context retrieval lost fixture knowledge, repositories, upstream, answers or visibility",
      );
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
    if (ownerId != null)
      await s.q(s.pool, "DELETE FROM knowledge_items WHERE owner_id=$1", [ownerId]);
    await s.q(s.pool, "DELETE FROM repositories WHERE name = ANY($1)", [[...repos, hiddenRepo]]);
    if (ownerId != null) await s.pool.query("DELETE FROM users WHERE id=$1", [ownerId]);
  }
}
