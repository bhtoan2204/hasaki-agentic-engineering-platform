import { createHash } from "node:crypto";
import { z } from "zod";
import { q, one, json, type Db } from "../db/pool.ts";
import { runEvents } from "./events.ts";
import { EngineError, lockRun, stepsOf } from "./mutations.ts";
import { topoOrder } from "./graph.ts";

export const SubtaskSpec = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "subtask id must be lowercase [a-z0-9_-]"),
  title: z.string().min(1),
  description: z.string().min(1),
  objective: z.string().min(1),
  expected_output: z.string().min(1),
  acceptance_criteria: z.array(z.string()).min(1),
  target_repos: z.array(z.string()).min(1),
  code_context: z.array(z.string()).default([]),
  /** Other subtask ids, or keys of existing steps (e.g. the approved plan step). */
  depends_on: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  complexity: z.enum(["low", "medium", "high"]).default("medium"),
  execution_strategy: z.enum(["sequential", "parallel"]).default("sequential"),
  agent_role: z.string().default("coder"),
  testing: z.array(z.string()).default([]),
  /** Files this subtask will write; overlap with a sibling forces sequential order. */
  owned_files: z.array(z.string()).default([]),
});
export type SubtaskSpec = z.infer<typeof SubtaskSpec>;

export const DecompositionPlan = z.object({
  summary: z.string().min(1),
  subtasks: z.array(SubtaskSpec).min(1),
});
export type DecompositionPlan = z.infer<typeof DecompositionPlan>;

export interface DecompositionLimits {
  max_subtasks: number;
  max_depth: number;
  /** Maximum number of replan revisions per run. */
  max_replans: number;
}
/** Hard ceilings: callers may tighten the limits but never raise them above these. */
export const HARD_LIMITS: DecompositionLimits = { max_subtasks: 20, max_depth: 2, max_replans: 5 };
const clampLimits = (l: DecompositionLimits): DecompositionLimits => ({
  max_subtasks: Math.min(l.max_subtasks, HARD_LIMITS.max_subtasks),
  max_depth: Math.min(l.max_depth, HARD_LIMITS.max_depth),
  max_replans: Math.min(l.max_replans, HARD_LIMITS.max_replans),
});

/** Conservative defaults; decomposition itself is opt-in per step config. */
export const DEFAULT_LIMITS: DecompositionLimits = { max_subtasks: 8, max_depth: 1, max_replans: 2 };

export interface TaskSignals {
  repositories: number;
  acceptance_criteria: number;
  estimated_effort_hours: number;
}

/** Deterministic heuristic: small tasks are never split. */
export function shouldDecompose(s: TaskSignals): { decompose: boolean; reason: string } {
  if (s.repositories >= 2 && s.acceptance_criteria >= 4)
    return { decompose: true, reason: "multiple repositories and many acceptance criteria" };
  if (s.estimated_effort_hours >= 8)
    return { decompose: true, reason: "estimated effort exceeds a single coding step" };
  if (s.acceptance_criteria >= 8)
    return { decompose: true, reason: "too many acceptance criteria for one step" };
  return { decompose: false, reason: "task is small enough for a single coding step" };
}

export interface ExpansionContext {
  existingKeys: string[];
  allowedRepositories: string[];
  limits: DecompositionLimits;
  /** Subtasks already materialized (counted against max_subtasks). */
  existingSubtasks?: number;
  /** Live steps with their dependencies; used to reject cycles introduced by the downstream rewire. */
  existingSteps?: { key: string; depends_on: string[]; subtask_id?: string | null; status?: string }[];
  /** Step the plan expands; steps waiting on it are rewired to wait for the leaf subtasks. */
  planStepKey?: string;
}

const stepKey = (id: string) => `subtask-${id}`;

/** Validate a plan against the live graph. Returns the effective (possibly serialized) subtasks. */
export function validateExpansion(
  plan: DecompositionPlan,
  ctx: ExpansionContext,
): { subtasks: SubtaskSpec[]; errors: string[] } {
  const errors: string[] = [];
  const subtasks = plan.subtasks.map((s) => ({ ...s, depends_on: [...s.depends_on] }));
  const total = subtasks.length + (ctx.existingSubtasks ?? 0);
  if (total > ctx.limits.max_subtasks)
    errors.push(`plan has ${total} subtasks, limit is ${ctx.limits.max_subtasks}`);
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (ids.has(s.id)) errors.push(`duplicate subtask id "${s.id}"`);
    ids.add(s.id);
    if (ctx.existingKeys.includes(stepKey(s.id))) errors.push(`subtask "${s.id}" already exists`);
  }
  const allowed = new Set(ctx.allowedRepositories);
  for (const s of subtasks) {
    for (const r of s.target_repos)
      if (!allowed.has(r)) errors.push(`subtask "${s.id}" targets repository "${r}" outside the allowed set`);
    for (const d of s.depends_on) {
      if (d === s.id) errors.push(`subtask "${s.id}" depends on itself`);
      else if (!ids.has(d) && !ctx.existingKeys.includes(d))
        errors.push(`subtask "${s.id}" depends on unknown "${d}"`);
    }
  }
  // Shared-file ownership: overlapping writers must not run in parallel — serialize them.
  for (let i = 0; i < subtasks.length; i++)
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i], b = subtasks[j];
      const overlap = a.owned_files.some((f) => b.owned_files.includes(f));
      if (overlap && !reaches(subtasks, b.id, a.id) && !reaches(subtasks, a.id, b.id)) {
        b.depends_on.push(a.id);
        b.execution_strategy = "sequential";
      }
    }
  if (!errors.length) {
    try {
      const toKey = (d: string) => (ids.has(d) ? stepKey(d) : d);
      const referenced = new Set(subtasks.flatMap((s) => s.depends_on));
      const leaves = subtasks.filter((s) => !referenced.has(s.id)).map((s) => stepKey(s.id));
      const live = (ctx.existingSteps ?? []).map((st) => ({
        key: st.key,
        depends_on:
          ctx.planStepKey && st.depends_on.includes(ctx.planStepKey) && st.status === "PENDING" && !st.subtask_id
            ? [...new Set([...st.depends_on, ...leaves])]
            : st.depends_on,
      }));
      topoOrder([
        ...live,
        ...subtasks.map((s) => ({
          key: stepKey(s.id),
          depends_on: s.depends_on.length ? s.depends_on.map(toKey) : ctx.planStepKey ? [ctx.planStepKey] : [],
        })),
      ]);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { subtasks, errors };
}

function reaches(subtasks: SubtaskSpec[], from: string, to: string): boolean {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const k = stack.pop()!;
    if (k === to) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(byId.get(k)?.depends_on ?? []));
  }
  return false;
}

export function planHash(plan: DecompositionPlan): string {
  const canon = [...plan.subtasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({ ...s, depends_on: [...s.depends_on].sort() }));
  return createHash("sha256").update(JSON.stringify({ summary: plan.summary, canon })).digest("hex");
}

export const idempotencyKey = (runId: number, hash: string, kind: string) =>
  createHash("sha256").update(`${runId}:${kind}:${hash}`).digest("hex");

/**
 * Materialize an approved plan as durable PENDING steps in one transaction.
 * Caller owns the transaction. Retrying with the same plan is a no-op (idempotent).
 * Steps that depended on the plan step keep working: `downstream` steps are rewired to wait for all subtasks.
 */
export async function materializeSubtasks(
  c: Db,
  runId: number,
  planStepKey: string,
  rawPlan: unknown,
  opts: { actor: string; reason: string; allowedRepositories: string[]; approvedBy?: string; limits?: Partial<DecompositionLimits>; kind?: "decomposition" | "replan" },
): Promise<{ created: string[]; revision: number; replayed: boolean }> {
  const kind = opts.kind ?? "decomposition";
  const limits = clampLimits({ ...DEFAULT_LIMITS, ...opts.limits });
  const parsed = DecompositionPlan.safeParse(rawPlan);
  if (!parsed.success)
    throw new EngineError("invalid decomposition plan: " + parsed.error.issues.map((i) => i.message).join("; "), 422);
  const plan = parsed.data;
  await lockRun(c, runId);
  const key = idempotencyKey(runId, planHash(plan), kind);
  const prior = await one<{ revision: number }>(c, "SELECT revision FROM workflow_graph_revisions WHERE idempotency_key = $1", [key]);
  if (prior) return { created: [], revision: prior.revision, replayed: true };

  const steps = await stepsOf(c, runId);
  const planStep = steps.find((s) => s.key === planStepKey);
  if (!planStep) throw new EngineError(`plan step "${planStepKey}" not found`, 404);
  // The plan must have been approved by a human: the plan step has to be completed first.
  if (planStep.status !== "COMPLETED")
    throw new EngineError(`plan step "${planStepKey}" is not approved/completed (status ${planStep.status})`, 409);
  // Proof of human approval: a completed approval gate that depends on the plan step and records who granted it.
  const gate = steps.find(
    (s) =>
      s.type === "human_approval" &&
      s.status === "COMPLETED" &&
      s.depends_on.includes(planStepKey) &&
      s.approval?.granted === true &&
      !!s.approval?.by,
  );
  if (!gate)
    throw new EngineError(`plan step "${planStepKey}" has no completed human approval gate`, 403);
  if (kind === "replan" && !opts.approvedBy)
    throw new EngineError("replan requires explicit human approval (approvedBy)", 403);
  // Downstream steps that already started cannot be made to wait for new subtasks.
  const started = steps.filter(
    (s) =>
      s.depends_on.includes(planStepKey) &&
      !s.subtask_id &&
      s.id !== gate.id &&
      !["PENDING", "COMPLETED", "SKIPPED"].includes(s.status),
  );
  if (started.length)
    throw new EngineError(`steps already active after the plan step: ${started.map((s) => s.key).join(", ")}`, 409);
  const depth = planStep.subtask_id ? 2 : 1;
  if (depth > limits.max_depth)
    throw new EngineError(`expansion depth ${depth} exceeds limit ${limits.max_depth}`, 409);
  const revs = await q<{ kind: string }>(c, "SELECT kind FROM workflow_graph_revisions WHERE run_id = $1", [runId]);
  if (kind === "replan" && revs.filter((r) => r.kind === "replan").length >= limits.max_replans)
    throw new EngineError(`replan limit (${limits.max_replans}) reached`, 409);
  if (kind === "decomposition" && revs.some((r) => r.kind === "decomposition"))
    throw new EngineError("run already decomposed; use an explicit replan", 409);

  const { subtasks, errors } = validateExpansion(plan, {
    existingKeys: steps.map((s) => s.key),
    allowedRepositories: opts.allowedRepositories,
    limits,
    existingSubtasks: steps.filter((s) => s.subtask_id).length,
    existingSteps: steps,
    planStepKey,
  });
  if (errors.length) throw new EngineError("invalid expansion: " + errors.join("; "), 422);

  const revision = revs.length + 1;
  await q(
    c,
    `INSERT INTO workflow_graph_revisions (run_id, revision, kind, reason, actor, plan, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [runId, revision, kind, opts.reason, opts.actor, json(plan), key],
  );
  const toKey = (d: string) => (subtasks.some((s) => s.id === d) ? stepKey(d) : d);
  const created: string[] = [];
  let position = Math.max(...steps.map((s) => s.position)) + 1;
  for (const s of subtasks) {
    const deps = s.depends_on.length ? s.depends_on.map(toKey) : [planStepKey];
    await q(
      c,
      `INSERT INTO workflow_steps (run_id, key, type, name, position, depends_on, config, requires_approval, max_attempts, retry_backoff_s, status, parent_step_key, subtask_id, graph_revision)
       VALUES ($1, $2, 'coding_agent', $3, $4, $5, $6, $10, 2, 5, 'PENDING', $7, $8, $9)`,
      [runId, stepKey(s.id), s.title, position++, deps, json({
        subtask: s,
        // Scope: a subtask may only touch its own target repositories (validated ⊆ the run's allowed set).
        scope: { repositories: s.target_repos, permissions: s.permissions, owned_files: s.owned_files },
      }), planStepKey, s.id, revision, s.risk === "high"],
    );
    created.push(stepKey(s.id));
  }
  // Steps that were waiting on the plan step must also wait for every leaf subtask.
  const referenced = new Set(subtasks.flatMap((s) => s.depends_on));
  const leaves = subtasks.filter((s) => !referenced.has(s.id)).map((s) => stepKey(s.id));
  for (const st of steps) {
    if (st.depends_on.includes(planStepKey) && st.status === "PENDING" && !st.subtask_id)
      await q(c, "UPDATE workflow_steps SET depends_on = $2, updated_at = now() WHERE id = $1", [
        st.id,
        [...new Set([...st.depends_on, ...leaves])],
      ]);
  }
  await runEvents.add(c, runId, "graph", `graph revision ${revision} (${kind}): +${created.length} subtasks — ${opts.reason}`, planStep.id);
  return { created, revision, replayed: false };
}
