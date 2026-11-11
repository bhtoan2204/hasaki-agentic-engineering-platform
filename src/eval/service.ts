import { compareContextEffect } from "./contextEffect.ts";
import { contextInventory } from "./controls.ts";
import { pool, q, one, withTx } from "../db/pool.ts";
import { config } from "../config.ts";
import { definitions } from "../workflow/definitions.ts";
import { startRun, cancelRun } from "../workflow/engine.ts";
import { repositories } from "../repos/service.ts";
import { materializeSuite, fixtureName } from "./fixtures.ts";
import { sha256, SuiteSchema } from "./dataset.ts";
import {
  defaultScoring,
  ScoringSchema,
  compareResults,
  PolicySchema,
  aggregateResults,
} from "./scoring.ts";
import { sandboxIdentity } from "./isolation.ts";
import { HttpError } from "../http/error.ts";

export { ConfigurationSchema } from "./configuration.ts";
import { ConfigurationSchema } from "./configuration.ts";
export async function publishBuiltinSuite() {
  return withTx(async (c) => {
    await q(c, "SELECT pg_advisory_xact_lock($1)", [727_027]);
    const suite = await materializeSuite(),
      content = JSON.stringify(suite),
      hash = sha256(content);
    const old = await one(c, "SELECT * FROM benchmark_suites WHERE suite_key=$1 AND version=$2", [
      suite.key,
      suite.version,
    ]);
    if (old) {
      if (old.content_hash !== hash)
        throw new Error("Immutable benchmark version changed; publish a new suite version");
      return old;
    }
    const row = await one(
      c,
      "INSERT INTO benchmark_suites(suite_key,version,content_hash,title,manifest) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [suite.key, suite.version, hash, suite.title, content],
    );
    for (const task of suite.cases)
      await q(
        c,
        `INSERT INTO benchmark_cases(suite_id,task_id,category,difficulty,origin,repository,base_commit,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          row!.id,
          task.task_id,
          task.category,
          task.difficulty,
          task.origin,
          task.repository,
          task.base_commit,
          JSON.stringify(task),
        ],
      );
    for (const logical of Object.keys(suite.repositories))
      await repositories.upsert(
        fixtureName(logical),
        {
          provider: "benchmark",
          projects: [`__benchmark:${suite.key}`],
          description: "Synthetic evaluation fixture; never a production repository",
          allowed_actions: ["read", "write"],
        },
        c,
      );
    return row!;
  });
}
export async function listSuites() {
  return q(
    pool,
    `SELECT s.id,s.suite_key,s.version,s.title,s.content_hash,count(c.id)::int AS cases,array_agg(DISTINCT c.category) AS categories FROM benchmark_suites s JOIN benchmark_cases c ON c.suite_id=s.id GROUP BY s.id ORDER BY s.suite_key,s.version DESC`,
  );
}
export async function createEvaluation(
  ownerId: number,
  input: {
    suite_id: number;
    request_key: string;
    configuration?: unknown;
    scoring?: unknown;
    paid_approval?: boolean;
  },
  isAdmin = false,
) {
  if (!config.evaluation.enabled)
    throw new HttpError(409, "Evaluation framework is disabled on this worker");
  if (!input.request_key || input.request_key.length > 160)
    throw new HttpError(400, "A bounded request_key is required for idempotency");
  const cfg = ConfigurationSchema.parse(input.configuration ?? {}),
    scoring = ScoringSchema.parse(input.scoring ?? defaultScoring);
  if (
    cfg.case_limit > config.evaluation.maxCases ||
    cfg.repetitions > config.evaluation.maxRepetitions ||
    cfg.max_case_seconds > config.evaluation.maxCaseSeconds ||
    cfg.max_tokens > config.evaluation.maxTokens ||
    cfg.max_cost_usd > config.evaluation.maxCostUsd
  )
    throw new HttpError(400, "Evaluation exceeds local execution limits");
  if (cfg.mode === "live" && (!input.paid_approval || !isAdmin))
    throw new HttpError(403, "Live paid evaluation requires explicit administrator approval");
  const row = await one(pool, "SELECT * FROM benchmark_suites WHERE id=$1", [input.suite_id]);
  if (!row) throw new HttpError(404, "Suite not found");
  const suite = SuiteSchema.parse(row.manifest),
    cases = suite.cases.slice(0, cfg.case_limit);
  let sandbox: any = null,
    blocked: string | null = null;
  try {
    sandbox = await sandboxIdentity();
  } catch (e) {
    blocked = (e as Error).message;
  }
  if (cfg.mode === "live")
    blocked =
      "Live execution is BLOCKED: this installation has no verified provider connector enforcing both hard token/cost budgets and outbound API isolation. Approval is recorded, not treated as a sandbox guarantee.";
  const inventory = cfg.provider_sequence ? await contextInventory(ownerId) : null;
  const frozen = {
    context_inventory_hash: inventory,
    ...cfg,
    sandbox,
    blocked,
    paid_approval: cfg.mode === "live" ? { by: ownerId, at: new Date().toISOString() } : null,
    harness_hash: suite.harness_hash,
  };
  const hashConfiguration: Record<string, unknown> = { ...cfg };
  if (!cfg.provider_sequence) delete hashConfiguration.context_tokens; // Preserve legacy request-key hashes.
  const hash = sha256(JSON.stringify({ ...hashConfiguration, scoring }));
  return withTx(async (c) => {
    await q(c, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `evaluation:${ownerId}:${input.request_key}`,
    ]);
    const old = await one(c, "SELECT * FROM evaluation_runs WHERE owner_id=$1 AND request_key=$2", [
      ownerId,
      input.request_key,
    ]);
    if (old) {
      if (old.configuration_hash !== hash || old.suite_id !== row.id)
        throw new HttpError(409, "Idempotency key reused with a different configuration");
      return old;
    }
    const constraints = sha256(
      JSON.stringify({
        suite: row.content_hash,
        cases: cases.map((c: any) => c.task_id),
        repetitions: cfg.repetitions,
        seconds: cfg.max_case_seconds,
        tokens: cfg.max_tokens,
        cost: cfg.max_cost_usd,
        scoring,
        sandbox,
        ...(cfg.provider_sequence
          ? {
              controlled_version: "provider-benchmark-v1",
              context_inventory_hash: inventory,
              mode: cfg.mode,
              adapter: cfg.adapter,
              prompt: cfg.prompt_version,
              tools: cfg.allowed_tools ?? null,
              context_tokens: cfg.context_tokens,
            }
          : {}),
      }),
    );
    const evaluation = await one(
      c,
      `INSERT INTO evaluation_runs(suite_id,owner_id,configuration,configuration_hash,scoring,constraints_hash,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        row.id,
        ownerId,
        JSON.stringify(frozen),
        hash,
        JSON.stringify(scoring),
        constraints,
        input.request_key,
      ],
    );
    const ids = await q(c, "SELECT id,task_id FROM benchmark_cases WHERE suite_id=$1", [row.id]);
    const tasks: any[] = [];
    for (let repetition = 1; repetition <= cfg.repetitions; repetition++)
      for (const task of cases) {
        const key = `case_${task.task_id.slice(-3)}_r${repetition}`;
        const cr = await one(
          c,
          `INSERT INTO evaluation_case_runs(evaluation_id,case_id,repetition,workflow_step_key) VALUES($1,$2,$3,$4) RETURNING id`,
          [evaluation!.id, ids.find((r) => r.task_id === task.task_id)!.id, repetition, key],
        );
        const previous = tasks.length ? tasks[tasks.length - 1].key : null;
        const phases = cfg.provider_sequence ?? [];
        for (const [ordinal, agent] of phases.entries()) {
          const phaseKey = `${key}_p${ordinal + 1}`;
          const role =
            phases.length === 1
              ? "implementation"
              : ordinal === 0 && phases.length === 3
                ? "research"
                : ordinal === phases.length - 1 && phases.length === 3
                  ? "verification"
                  : ordinal === phases.length - 1
                    ? "verification"
                    : "implementation";
          tasks.push({
            key: phaseKey,
            type: role === "implementation" ? "coding_agent" : "agent",
            name: `${task.task_id}: ${agent.provider} · ${role}`,
            depends_on: ordinal ? [`${key}_p${ordinal}`] : previous ? [previous] : [],
            config: {
              evaluation_phase: { case_run_id: cr!.id, ordinal, role },
              instructions: task.description,
              agent: {
                ...agent,
                fallback: { mode: "disabled" },
                model: agent.model ?? null,
                execution_profile: "STANDARD",
                timeout_ms: Math.max(
                  1000,
                  Math.floor((cfg.max_case_seconds * 1000) / phases.length),
                ),
                context_tokens: cfg.context_tokens,
              },
            },
            max_attempts: 1,
          });
          await q(
            c,
            "INSERT INTO evaluation_provider_phases(case_run_id,ordinal,step_key,provider,model,role) VALUES($1,$2,$3,$4,$5,$6)",
            [cr!.id, ordinal, phaseKey, agent.provider, agent.model ?? null, role],
          );
        }
        tasks.push({
          key,
          type: "integration",
          name: `${task.task_id} · repetition ${repetition}`,
          depends_on: tasks.length ? [tasks[tasks.length - 1].key] : [],
          config: { action: "benchmark_case", case_run_id: cr!.id },
          requires_approval: !!task.clarification && cfg.mode !== "dry_run" && !blocked,
          max_attempts: 2,
          retry_backoff_seconds: 0,
        });
      }
    // Existing definition/start APIs use their own transactions. No external work starts until workflow start below.
    const definition = await definitions.create({
      key: `evaluation-${evaluation!.id}`,
      ownerId,
      spec: { name: `${suite.title} · ${cfg.adapter}`, steps: tasks },
    });
    const run = await startRun({
      definitionKey: definition.key,
      ownerId,
      title: `Evaluation ${evaluation!.id}: ${suite.key}`,
      repositories: Object.keys(suite.repositories).map(fixtureName),
      inputs: { project: `__benchmark:${suite.key}` },
      start: false,
      agentProvider: "codex",
    });
    await q(c, "UPDATE evaluation_runs SET workflow_run_id=$2 WHERE id=$1", [
      evaluation!.id,
      run.id,
    ]);
    return { ...evaluation, workflow_run_id: run.id };
  });
}
export async function evaluationDetail(id: number, ownerId: number) {
  const row = await one(
    pool,
    `SELECT e.*,r.status,r.created_at AS workflow_created_at,r.started_at,r.finished_at,r.definition_version_id FROM evaluation_runs e JOIN workflow_runs r ON r.id=e.workflow_run_id WHERE e.id=$1 AND e.owner_id=$2`,
    [id, ownerId],
  );
  if (!row) throw new HttpError(404, "Evaluation not found");
  const cases = await q(
    pool,
    `SELECT cr.id,cr.repetition,cr.workflow_step_key,c.task_id,c.category,c.difficulty,c.origin,c.definition,c.base_commit,s.status AS step_status,s.current_attempt_id,er.*,sample.completion_duration_ms
 FROM evaluation_case_runs cr JOIN benchmark_cases c ON c.id=cr.case_id LEFT JOIN workflow_steps s ON s.run_id=$2 AND s.key=cr.workflow_step_key LEFT JOIN eval_results er ON er.case_run_id=cr.id LEFT JOIN evaluation_analytics_samples sample ON sample.case_run_id=cr.id WHERE cr.evaluation_id=$1 ORDER BY cr.repetition,c.task_id`,
    [id, row.workflow_run_id],
  );
  return {
    ...row,
    cases: cases.map((c) => ({
      ...c,
      definition: {
        ...c.definition,
        validation: { ...c.definition.validation, hidden_checks: undefined },
      },
    })),
    summary: aggregateResults(
      cases.filter((c) => c.case_run_id),
      cases.length,
    ),
  };
}
export async function evaluationList(ownerId: number) {
  return q(
    pool,
    `SELECT e.id,e.suite_id,e.configuration,e.created_at,e.workflow_run_id,r.status,count(cr.id)::int AS tasks,count(er.id)::int AS finished,count(er.id) FILTER(WHERE er.correct)::int AS successes,round(avg(er.quality_score),2) AS average_score FROM evaluation_runs e JOIN workflow_runs r ON r.id=e.workflow_run_id JOIN evaluation_case_runs cr ON cr.evaluation_id=e.id LEFT JOIN eval_results er ON er.case_run_id=cr.id WHERE e.owner_id=$1 GROUP BY e.id,r.status ORDER BY e.id DESC LIMIT 100`,
    [ownerId],
  );
}
export async function cancelEvaluation(id: number, ownerId: number) {
  const row = await evaluationDetail(id, ownerId);
  return cancelRun(row.workflow_run_id, "Evaluation canceled by owner");
}
export async function createComparison(
  ownerId: number,
  baseline: number,
  candidate: number,
  rawPolicy: unknown,
) {
  const policy = PolicySchema.parse(rawPolicy ?? {});
  const [a, b] = await Promise.all([
    evaluationDetail(baseline, ownerId),
    evaluationDetail(candidate, ownerId),
  ]);
  if (a.suite_id !== b.suite_id || a.constraints_hash !== b.constraints_hash)
    throw new HttpError(
      409,
      "Comparisons require identical suite versions, case/repetition sets, validation, scoring and execution constraints",
    );
  if (a.configuration.provider_sequence || b.configuration.provider_sequence) {
    if (!a.configuration.provider_sequence || !b.configuration.provider_sequence)
      throw new HttpError(409, "Legacy and controlled provider experiments cannot be paired");
    if (
      a.configuration.context_variant !== b.configuration.context_variant &&
      JSON.stringify(a.configuration.provider_sequence) !==
        JSON.stringify(b.configuration.provider_sequence)
    )
      throw new HttpError(
        409,
        "Context A/B comparisons must hold the provider/model sequence fixed",
      );
  }
  return one(
    pool,
    "INSERT INTO evaluation_comparisons(owner_id,baseline_id,candidate_id,policy) VALUES($1,$2,$3,$4) RETURNING *",
    [ownerId, baseline, candidate, JSON.stringify(policy)],
  );
}
export async function comparisonDetail(id: number, ownerId: number) {
  const pair = await one(pool, "SELECT * FROM evaluation_comparisons WHERE id=$1 AND owner_id=$2", [
    id,
    ownerId,
  ]);
  if (!pair) throw new HttpError(404, "Comparison not found");
  const [a, b] = await Promise.all([
    evaluationDetail(pair.baseline_id, ownerId),
    evaluationDetail(pair.candidate_id, ownerId),
  ]);
  const critical = new Set<string>(
    a.cases.filter((c: any) => c.definition.critical).map((c: any) => c.task_id),
  );
  const report = compareResults(
    a.cases.filter((c: any) => c.case_run_id),
    b.cases.filter((c: any) => c.case_run_id),
    a.cases.length,
    critical,
    pair.policy,
  );
  if (report.verdict === "PASS" && (a.status !== "COMPLETED" || b.status !== "COMPLETED"))
    report.verdict = "INCONCLUSIVE";
  return { ...pair, report, context_report: compareContextEffect(a, b) };
}
