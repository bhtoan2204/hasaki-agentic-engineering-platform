import { config } from "../config.ts";
import { q, one, json, type Db } from "../db/pool.ts";
import { knowledge } from "../knowledge/service.ts";
import { resolveKnowledge, type Resolution } from "../knowledge/resolve.ts";
import { planKnowledge, planUpstream, type DisclosureEntry, type UpstreamPlanEntry } from "../context/plan.ts";
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
  /** Progressive disclosure per knowledge key (inline / index / search) with relevance score. */
  disclosure: DisclosureEntry[];
  /** Upstream outputs as they go into the prompt (full or summarized within the budget). */
  upstream: { plan: Record<string, UpstreamPlanEntry>; text: Record<string, string> };
  /** Text used for relevance ranking (request + step instructions + upstream keywords). */
  requestText: string;
  /** Code locations already identified by upstream steps (current attempts only), most referenced first. */
  fileRefs: Array<{ path: string; refs: number; from: string[] }>;
}

const CODE_REF = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w.-]+\.(?:go|ts|tsx|js|jsx|py|java|kt|sql|proto|ya?ml|json|php|rb|cs))(?::(\d+))?/g;

/**
 * Deterministic handoff of source locations: files read/edited/grepped by the CURRENT attempt of each ancestor step
 * (invalidated attempts are excluded, so stale exploration is never handed on) plus path[:line] references in their
 * outputs. Saves the next agent from rediscovering where the relevant code is.
 */
export async function collectFileRefs(c: Db, upstream: StepInput["upstream"]) {
  const byPath = new Map<string, { refs: number; from: Set<string> }>();
  const add = (path: string, from: string) => {
    const p = path.replace(/^\.\//, "");
    if (!p || p.length > 300) return;
    const e = byPath.get(p) ?? byPath.set(p, { refs: 0, from: new Set() }).get(p)!;
    e.refs++;
    e.from.add(from);
  };
  const attemptIds = Object.values(upstream).map((u) => u.attempt_id).filter((x): x is number => !!x);
  if (attemptIds.length) {
    const rows = await q<{ key: string; name: string; path: string }>(
      c,
      `SELECT s.key, e.data->>'name' AS name, COALESCE(e.data->'input'->>'file_path', e.data->'input'->>'path') AS path
         FROM workflow_events e JOIN workflow_steps s ON s.id = e.step_id
        WHERE e.attempt_id = ANY($1) AND e.kind = 'tool' AND e.data->>'name' IN ('Read', 'Edit', 'Write', 'MultiEdit', 'Grep')`,
      [attemptIds],
    );
    for (const r of rows) if (r.path && /\.[a-z]{1,5}$/i.test(r.path)) add(r.path, r.key);
  }
  for (const [key, u] of Object.entries(upstream)) {
    if (u.status !== "COMPLETED" || !u.output) continue;
    for (const m of JSON.stringify(u.output).replace(/\\n/g, " ").matchAll(CODE_REF)) add(m[2] ? `${m[1]}:${m[2]}` : m[1], key);
  }
  return [...byPath.entries()]
    .map(([path, v]) => ({ path, refs: v.refs, from: [...v.from] }))
    .sort((a, b) => b.refs - a.refs || a.path.localeCompare(b.path))
    .slice(0, 30);
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
  const explicit = [
    ...((cfg.skills as string[]) ?? []),
    ...((cfg.knowledge as string[]) ?? []),
    ...(run.graph.skills ?? []),
    ...(run.graph.knowledge ?? []),
  ];
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
  const rankText = [requestText(input), step.name, String(cfg.instructions ?? "")].join("\n");
  const disclosure = planKnowledge(res.applied, {
    requestText: rankText,
    stepType: step.type,
    inlineTokens: config.agent.inlineKnowledgeTokens,
    indexSize: Number(cfg.knowledge_index_size ?? config.agent.knowledgeIndexSize),
  });
  const completed = Object.fromEntries(Object.entries(input.upstream).filter(([, u]) => u.status === "COMPLETED"));
  const upstream = planUpstream(completed, step.depends_on, Number(cfg.upstream_tokens ?? config.agent.upstreamTokens));
  const fileRefs = step.type === "agent" || step.type === "coding_agent" ? await collectFileRefs(c, input.upstream) : [];
  const content = {
    step: { key: step.key, type: step.type, generation: step.generation },
    // How the prompt was shaped — enough to reproduce/audit what the agent was shown.
    prompt_plan: {
      knowledge: disclosure,
      upstream: upstream.plan,
      file_refs: fileRefs,
      budgets: { inline_knowledge_tokens: config.agent.inlineKnowledgeTokens, index_size: config.agent.knowledgeIndexSize, upstream_tokens: config.agent.upstreamTokens },
      setting_sources: config.agent.settingSources,
      delegation: cfg.delegation?.enabled === true,
    },
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
  return { snapshot_id: row.id, hash, project, repositories, knowledge: res.applied, overridden: res.overridden, disclosure, upstream, requestText: rankText, fileRefs };
}
