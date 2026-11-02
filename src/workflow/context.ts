import { config } from "../config.ts";
import { q, one, json, type Db } from "../db/pool.ts";
import { knowledge } from "../knowledge/service.ts";
import { resolveKnowledge, type Resolution } from "../knowledge/resolve.ts";
import { hashOf } from "./definitions.ts";
import { ancestors } from "./graph.ts";
import type { RunRow, StepRow } from "./types.ts";

/** Everything a step attempt receives. Persisted as the attempt's input snapshot. */
export interface StepInput {
  run: { id: number; title: string; inputs: Record<string, any>; branch: string; definition_key: string; selected_repositories: string[]; allowed_repositories: string[] };
  work_item: { id: number; code: string; title: string; description: string; project: string; source: string; payload: any } | null;
  /** Outputs of every ancestor step, keyed by step key, with the attempt that produced them. */
  upstream: Record<string, { status: string; attempt_id: number | null; output: any }>;
  /** All answered questions of this step (every attempt), oldest first. */
  answers: Array<{ question: string; answer: string; attempt_id: number | null }>;
  /** Answers/feedback/overrides queued for this attempt (resume info, reviewer feedback...). */
  pending: any;
  approval: any;
}

export interface ResolvedContext {
  snapshot_id: number;
  hash: string;
  project: string;
  repositories: string[];
  knowledge: Resolution["applied"];
  overridden: Resolution["overridden"];
}

export async function buildStepInput(c: Db, run: RunRow, step: StepRow): Promise<StepInput> {
  const wi = run.work_item_id
    ? await one(c, "SELECT id, code, title, description, project, source, payload FROM work_items WHERE id = $1", [run.work_item_id])
    : null;
  const anc = ancestors(run.graph.steps, step.key);
  const upstream: StepInput["upstream"] = {};
  if (anc.size) {
    for (const s of await q<StepRow>(c, "SELECT key, status, current_attempt_id, output FROM workflow_steps WHERE run_id = $1 AND key = ANY($2)", [
      run.id,
      [...anc],
    ]))
      upstream[s.key] = { status: s.status, attempt_id: s.current_attempt_id, output: s.output };
  }
  const answers = await q(
    c,
    "SELECT question, answer, attempt_id FROM workflow_questions WHERE step_id = $1 AND status = 'answered' ORDER BY id",
    [step.id],
  );
  return {
    run: {
      id: run.id,
      title: run.title,
      inputs: run.inputs,
      branch: run.branch,
      definition_key: run.definition_key,
      selected_repositories: run.selected_repositories,
      allowed_repositories: run.allowed_repositories,
    },
    work_item: wi ?? null,
    upstream,
    answers,
    pending: step.pending_input,
    approval: step.approval,
  };
}

/** Text used for keyword applicability: the request plus upstream analysis keywords. */
function requestText(input: StepInput) {
  const parts = [input.run.title, input.work_item?.title, input.work_item?.description, JSON.stringify(input.run.inputs ?? {})];
  for (const u of Object.values(input.upstream)) {
    const kw = u.output?.keywords;
    if (Array.isArray(kw)) parts.push(kw.join(" "));
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * ContextResolver: resolve applicable knowledge for this step and persist an immutable, content-hashed
 * snapshot of what the attempt is given (knowledge item versions + upstream attempt ids + repositories).
 */
export async function resolveContext(c: Db, run: RunRow, step: StepRow, input: StepInput): Promise<ResolvedContext> {
  const project = input.work_item?.project || String(input.run.inputs?.project ?? "");
  const repositories = run.selected_repositories;
  const cfg = step.config ?? {};
  const explicit = [...((cfg.skills as string[]) ?? []), ...((cfg.knowledge as string[]) ?? [])];
  const res = resolveKnowledge(await knowledge.candidates(c), {
    organization: config.organization,
    project,
    repositories,
    workflowKey: run.definition_key,
    stepKey: step.key,
    stepType: step.type,
    text: requestText(input),
    explicit,
  });
  const content = {
    step: { key: step.key, type: step.type, generation: step.generation },
    project,
    repositories,
    upstream: Object.fromEntries(Object.entries(input.upstream).map(([k, v]) => [k, v.attempt_id])),
    answers: input.answers.length,
    input_hash: hashOf(input),
    knowledge: res.applied.map((k) => ({
      key: k.key,
      version: k.version,
      category: k.category,
      scope: k.scope_type,
      scope_ref: k.scope_ref,
      title: k.title,
      reason: k.reason,
      content: k.content,
      metadata: k.metadata,
    })),
    overridden: res.overridden,
    missing_explicit: explicit.filter((k) => !res.applied.some((a) => a.key === k)),
  };
  const hash = hashOf(content);
  const row = await one(c, "INSERT INTO context_snapshots (run_id, step_id, hash, content) VALUES ($1, $2, $3, $4) RETURNING id", [
    run.id,
    step.id,
    hash,
    json(content),
  ]);
  return { snapshot_id: row.id, hash, project, repositories, knowledge: res.applied, overridden: res.overridden };
}
