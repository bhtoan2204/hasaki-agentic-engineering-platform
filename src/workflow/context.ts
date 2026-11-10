import { visibleKnowledge } from "../knowledge/visibility.ts";
import type { ContextPack } from "../context/pack.ts";
import { config } from "../config.ts";
import { q, one, json, type Db } from "../db/pool.ts";
import { knowledge } from "../knowledge/service.ts";
import { resolveKnowledge, type Resolution } from "../knowledge/resolve.ts";
import { planKnowledge, planUpstream, type DisclosureEntry, type UpstreamPlanEntry } from "../context/plan.ts";
import { repoPath } from "../repos/service.ts";
import { independentUpstream, isIndependent } from "../agent/independentReview.ts";
import { memoryFreshness } from "../knowledge/memory.ts";
import { TEST_COMMAND } from "./templates.ts";
import { verifyConfig } from "../agent/verify.ts";
import { createHash } from "node:crypto";
import { hashOf } from "./definitions.ts";
import { outputLocale } from "../agent/language.ts";
import { ancestors } from "./graph.ts";
import type { RunRow, StepRow } from "./types.ts";

/** Everything a step attempt receives. Persisted as the attempt's input snapshot. */
export interface StepInput {
  run: { id: number; title: string; inputs: Record<string, any>; branch: string; definition_key: string; selected_repositories: string[]; allowed_repositories: string[]; output_locale?: "vi" | "en" | null };
  work_item: { id: number; code: string; title: string; description: string; project: string; source: string; payload: any } | null;
  /** Outputs of every ancestor step, keyed by step key, with the attempt that produced them. */
  upstream: Record<string, { status: string; attempt_id: number | null; output: any }>;
  /** All answered questions of this step (every attempt), oldest first. */
  answers: Array<{ question: string; answer: string; attempt_id: number | null }>;
  /** Answers/feedback/overrides queued for this attempt (resume info, reviewer feedback...). */
  pending: any;
  approval: any;
  /** When re-executed with instructions: the latest earlier attempt of this step (what to revise). */
  previous_attempt?: { number: number; generation: number; status: string; output: any; error: any } | null;
}

export interface ResolvedContext {
  contextPack?: ContextPack;
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
  /** Primary checkout path of each repository the run may use (selected, else allowed). */
  repoPaths?: Array<{ name: string; path: string }>;
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
  let upstream: StepInput["upstream"] = {};
  if (anc.size) {
    for (const s of await q<StepRow>(c, "SELECT key, status, current_attempt_id, output FROM workflow_steps WHERE run_id = $1 AND key = ANY($2)", [
      run.id,
      [...anc],
    ]))
      upstream[s.key] = { status: s.status, attempt_id: s.current_attempt_id, output: s.output };
  }
  // Independent verification: the coding agent's own claims never reach the verifier (only platform evidence does).
  if (isIndependent(step.config)) upstream = independentUpstream(run.graph.steps, upstream);
  const answers = await q(
    c,
    "SELECT question, answer, attempt_id FROM workflow_questions WHERE step_id = $1 AND status = 'answered' ORDER BY id",
    [step.id],
  );
  const reexec = step.pending_input?.reexecute || step.pending_input?.feedback;
  const previous_attempt = reexec
    ? ((await one(
      c,
      `SELECT number, generation, status, output, error FROM workflow_step_attempts
          WHERE step_id = $1 AND generation < $2 AND (output IS NOT NULL OR error IS NOT NULL) ORDER BY number DESC LIMIT 1`,
      [step.id, step.generation],
    )) ?? null)
    : null;
  return {
    previous_attempt,
    run: {
      id: run.id,
      title: run.title,
      inputs: run.inputs,
      branch: run.branch,
      definition_key: run.definition_key,
      selected_repositories: run.selected_repositories,
      allowed_repositories: run.allowed_repositories,
      output_locale: outputLocale(run),
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
  const pinned: Array<{ key: string; version: number }> = input.pending?.reexecute?.skills ?? [];
  // One instant for version selection (effective dates) and expiry, recorded in the snapshot for reproducibility.
  const at = new Date();
  // Knowledge derived from repositories the owner cannot read never reaches the agent.
  const res = resolveKnowledge(await visibleKnowledge(run.owner_id, await knowledge.candidates(c, run.owner_id, at)), {
    organization: config.organization,
    project,
    repositories,
    workflowKey: run.definition_key,
    stepKey: step.key,
    stepType: step.type,
    text: requestText(input),
    explicit,
    now: at,
  });
  // Skills selected for this re-execution, at the exact version pinned when it was requested.
  for (const p of pinned) {
    const v = await one(
      c,
      `SELECT i.id, i.owner_id, i.updated_at, i.key, i.title, i.category, i.scope_type, i.scope_ref, i.conflict_key, i.priority, i.enforced, v.version, v.content, v.applicability, v.metadata
         FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = $2 WHERE i.key = $1 AND (i.owner_id IS NULL OR i.owner_id = $3) AND i.enabled AND v.version <= i.current_version ORDER BY i.owner_id NULLS LAST LIMIT 1`,
      [p.key, p.version, run.owner_id],
    );
    res.applied = res.applied.filter((k) => k.key !== p.key);
    if (v) res.applied.push({ ...v, reason: `selected for this re-execution (v${p.version})` });
  }
  // Cross-task memory: never untrusted conclusions (they are disabled until approved); only provably FRESH items load
  // (STALE and UNKNOWN — missing provenance, unavailable repo or history — are excluded and recorded with the reason).
  const memoryStale: string[] = [];
  const memoryStates: Array<{ key: string; trust: string | null; state: string; reason: string }> = [];
  const memoryItems = res.applied.filter((k) => k.category === "task_memory");
  if (memoryItems.length) {
    const repoRows = await q<import("../repos/service.ts").RepositoryRow>(c, "SELECT * FROM repositories WHERE name = ANY($1)", [[...new Set(memoryItems.map((k) => String((k.metadata as any)?.memory?.repo ?? "")))]]);
    for (const k of memoryItems) {
      const m = (k.metadata as any)?.memory;
      const trusted = m && (m.trust === "verified" || m.trust === "approved");
      const row = repoRows.find((r) => r.name === m?.repo);
      const fresh = trusted ? await memoryFreshness(m, row ? repoPath(row) : null) : { state: "UNKNOWN", reason: "not verified or approved" };
      memoryStates.push({ key: k.key, trust: m?.trust ?? null, state: fresh.state, reason: fresh.reason });
      if (!trusted || fresh.state !== "FRESH") memoryStale.push(k.key);
    }
    res.applied = res.applied.filter((k) => !memoryStale.includes(k.key));
  }
  const rankText = [requestText(input), step.name, String(cfg.instructions ?? ""), String(input.pending?.reexecute?.instructions ?? "")].join("\n");
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
      reexecute: input.pending?.reexecute
        ? { instructions: input.pending.reexecute.instructions, skills: pinned.map((p) => `${p.key}@v${p.version}`), previous_attempt: input.previous_attempt?.number ?? null }
        : null,
      delegation: cfg.delegation?.enabled === true,
      // The checks this attempt is held to (coding steps): audit trail for "why did it (not) complete".
      verification: step.type === "coding_agent" ? verificationPlan(cfg) : null,
      memory_excluded: memoryStale,
      memory_freshness: memoryStates,
    },
    project,
    repositories,
    upstream: Object.fromEntries(Object.entries(input.upstream).map(([k, v]) => [k, v.attempt_id])),
    answers: input.answers.length,
    input_hash: hashOf(input),
    knowledge: res.applied.map((k) => ({
      id: k.id, owner_id: k.owner_id ?? null, updated_at: k.updated_at,
      key: k.key,
      version: k.version,
      category: k.category,
      scope: k.scope_type,
      scope_ref: k.scope_ref,
      title: k.title,
      reason: k.reason,
      content: k.content,
      metadata: k.metadata,
      ...(k.effective_from ? { effective_from: k.effective_from } : {}),
    })),
    overridden: res.overridden,
    missing_explicit: explicit.filter((k) => !res.applied.some((a) => a.key === k)),
  };
  const hash = hashOf(content);
  // The resolution instant decides which versions were in effect; it is recorded but not part of the content hash.
  Object.assign(content, { resolved_at: at.toISOString() });
  const row = await one(c, "INSERT INTO context_snapshots (run_id, step_id, hash, content) VALUES ($1, $2, $3, $4) RETURNING id", [
    run.id,
    step.id,
    hash,
    json(content),
  ]);
  const names = repositories.length ? repositories : run.allowed_repositories;
  const repoPaths = names.length
    ? (await q<import("../repos/service.ts").RepositoryRow>(c, "SELECT * FROM repositories WHERE name = ANY($1) ORDER BY name", [names])).map((r) => ({ name: r.name, path: repoPath(r) }))
    : [];
  return { snapshot_id: row.id, hash, project, repositories, knowledge: res.applied, overridden: res.overridden, disclosure, upstream, requestText: rankText, fileRefs, repoPaths };
}

function verificationPlan(cfg: Record<string, any>) {
  const v = verifyConfig(cfg, TEST_COMMAND);
  if (!v) return { enabled: false };
  return { enabled: true, command_sha256: createHash("sha256").update(v.command).digest("hex").slice(0, 16), default_command: v.command === TEST_COMMAND, max_repairs: v.maxRepairs, baseline: v.baseline, allow_test_weakening: v.allowTestWeakening };
}
