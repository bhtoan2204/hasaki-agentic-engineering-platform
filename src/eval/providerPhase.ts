import { contextInventory } from "./controls.ts";
import { pool, one } from "../db/pool.ts";
import { execution } from "../auth/execution.ts";
import { ensureContextPack } from "../context/pack.ts";
import { newMetrics } from "../agent/metrics.ts";
import { dispatchPlatformTool, envFromExecution } from "../agent/platformTools.ts";
import { CaseSchema, referencePatches, sha256 } from "./dataset.ts";
import { harnessHash } from "./fixtures.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";

/** A fixture phase is an orchestration control, never evidence of real provider proficiency. */
export async function executeProviderPhase(ctx: ExecutionContext): Promise<ExecResult> {
  const p = await one(
    pool,
    `SELECT p.*,cr.workflow_step_key AS case_step_key,c.definition,e.configuration FROM evaluation_provider_phases p JOIN evaluation_case_runs cr ON cr.id=p.case_run_id JOIN benchmark_cases c ON c.id=cr.case_id JOIN evaluation_runs e ON e.id=cr.evaluation_id
 WHERE p.case_run_id=$1 AND p.ordinal=$2 AND p.step_key=$3 AND e.workflow_run_id=$4 AND e.owner_id=$5`,
    [
      ctx.step.config.evaluation_phase?.case_run_id,
      ctx.step.config.evaluation_phase?.ordinal,
      ctx.step.key,
      ctx.run.id,
      ctx.run.owner_id,
    ],
  );
  if (!p)
    return {
      kind: "failed",
      error: "Provider benchmark phase lacks an authoritative evaluation binding",
      retryable: false,
    };
  // Serial case scheduling must not disclose other tasks' solutions to the next case.
  const prefix = `${p.case_step_key}_p`;
  ctx.input = {
    ...ctx.input,
    upstream: Object.fromEntries(
      Object.entries(ctx.input.upstream).filter(([key]) => key.startsWith(prefix)),
    ),
  };
  ctx.context = {
    ...ctx.context,
    upstream: {
      ...ctx.context.upstream,
      plan: Object.fromEntries(
        Object.entries(ctx.context.upstream.plan).filter(([key]) => key.startsWith(prefix)),
      ),
    },
  };
  const cfg = p.configuration;
  if (cfg.blocked || cfg.mode !== "fixture" || cfg.adapter !== "provider_fixture")
    return {
      kind: "completed",
      output: {
        blocked: cfg.blocked ?? "No verified live provider benchmark connector",
        evidence_kind: "blocked",
        provider: p.provider,
      },
    };
  if (cfg.harness_hash !== (await harnessHash()))
    return {
      kind: "failed",
      error: "Benchmark harness changed",
      retryable: false,
    };
  if (cfg.context_inventory_hash !== (await contextInventory(Number(ctx.run.owner_id))))
    return {
      kind: "completed",
      output: {
        blocked: "Context inventory changed; create a new controlled evaluation",
        evidence_kind: "blocked",
      },
    };
  const task = CaseSchema.parse(p.definition),
    metrics = newMetrics("");
  const mode = p.role === "implementation" ? "coding" : "analysis";
  const policy = {
    mode: mode as "coding" | "analysis",
    workspaces: [],
    baseBranch: "main",
    allowedTools: cfg.allowed_tools,
  };
  const principal = execution.getStore();
  if (!principal) throw new Error("Authenticated benchmark owner required");
  return execution.run(
    {
      ...principal,
      evaluation: {
        codeIntelligence: cfg.code_intelligence,
        contextMode: cfg.context_variant,
        allowedTools: cfg.allowed_tools,
      },
    },
    async () => {
      let pack = null,
        retrieval: any = null;
      if (cfg.context_variant !== "minimal") {
        pack = await ensureContextPack(ctx, metrics, policy);
        ctx.context.contextPack = pack;
      }
      if (cfg.context_variant === "tools") {
        const env = envFromExecution(ctx, mode, policy, metrics, () => {});
        retrieval = await dispatchPlatformTool(
          "get_run_context",
          { section: "all", offset: 0, limit: 5 },
          env,
        );
      }
      const patches = p.role === "implementation" ? (referencePatches[task.task_id] ?? []) : [];
      const artifact = await ctx.artifact(
        "evaluation",
        "provider-phase.json",
        JSON.stringify({
          provider: p.provider,
          model: p.model,
          role: p.role,
          task_id: task.task_id,
          base_commit: task.base_commit,
          context_variant: cfg.context_variant,
          pack_id: pack?.id ?? null,
          prompt_hash: sha256(task.description + JSON.stringify(task.expected_behavior)),
          upstream: ctx.input.upstream,
          retrieval_observed: retrieval != null,
          notice: "Deterministic fixture control. No model called; not provider quality evidence.",
        }),
      );
      await ctx.recordMetrics({
        execution_kind: "fixture_control",
        provider: p.provider,
        tokens: null,
        cost_usd: null,
        model: p.model ?? "",
        evaluation: {
          phase_id: p.id,
          case_run_id: p.case_run_id,
          context_variant: cfg.context_variant,
          context_pack_id: pack?.id ?? null,
          retrieval_observed: retrieval != null,
        },
      });
      return {
        kind: "completed",
        output: {
          evidence_kind: "fixture_control",
          provider: p.provider,
          role: p.role,
          patches,
          artifact_id: artifact,
          context_variant: cfg.context_variant,
          context_pack_id: pack?.id ?? null,
          summary: "Simulated provider phase; inspect deterministic validator results separately",
        },
      };
    },
  );
}
