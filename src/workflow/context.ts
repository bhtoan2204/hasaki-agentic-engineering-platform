import type { Untyped } from "../untyped.ts";
import { insertSnapshot } from "../context/repository.ts";
import {
  buildExecutionContract,
  type MandatoryExecutionContract,
} from "../agent/executionContract.ts";
import { detectNativeKnowledgeSources } from "../knowledge/nativeSources.ts";
import { visibleKnowledge } from "../knowledge/visibility.ts";
import { semanticRanksByKey } from "../retrieval/semantic.ts";
import type { ContextPack } from "../context/pack.ts";
import { config } from "../config.ts";
import { q, one, type Db } from "../db/pool.ts";
import { knowledge } from "../knowledge/service.ts";
import { resolveKnowledge, type Resolution } from "../knowledge/resolve.ts";
import {
  planKnowledge,
  planUpstream,
  type DisclosureEntry,
  type UpstreamPlanEntry,
} from "../context/plan.ts";
import { projectsOfRepositories, repoPath } from "../repos/service.ts";
import { independentUpstream, isIndependent, withheldSteps } from "../agent/independentReview.ts";
import { memoryFreshness, type MemoryMeta } from "../knowledge/memory.ts";
import { skillAvailability } from "../knowledge/external.ts";
import { TEST_COMMAND } from "./templates.ts";
import { verifyConfig } from "../agent/verify.ts";
import { createHash } from "node:crypto";
import { hashOf } from "./definitions.ts";
import { outputLocale } from "../agent/language.ts";
import { ancestors } from "./graph.ts";
import type { RunRow, StepRow } from "./types.ts";

/** Everything a step attempt receives. Persisted as the attempt's input snapshot. */
export interface StepInput {
  execution_contract?: MandatoryExecutionContract;
  execution_evidence_source?: { attempt_id: number; generation: number };
  run: {
    id: number;
    title: string;
    inputs: Record<string, unknown>;
    branch: string;
    definition_key: string;
    selected_repositories: string[];
    allowed_repositories: string[];
    output_locale?: "vi" | "en" | null;
  };
  work_item: {
    id: number;
    code: string;
    title: string;
    description: string;
    project: string;
    source: string;
    payload: Untyped;
  } | null;
  /** Outputs of every ancestor step, keyed by step key, with the attempt that produced them. */
  upstream: Record<string, { status: string; attempt_id: number | null; output: Untyped }>;
  /** All answered questions of this step (every attempt), oldest first. */
  answers: Array<{ question: string; answer: string; attempt_id: number | null }>;
  /** Answers/feedback/overrides queued for this attempt (resume info, reviewer feedback...). */
  pending: Untyped;
  approval: Untyped;
  /** When re-executed with instructions: the latest earlier attempt of this step (what to revise). */
  previous_attempt?: {
    number: number;
    generation: number;
    status: string;
    output: unknown;
    error: unknown;
  } | null;
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
  /** Explicitly assigned skills that cannot run here (blocked, missing runtime, unsupported provider): the attempt fails. */
  unavailableSkills?: Array<{ key: string; reason: string }>;
}

const CODE_REF =
  /(?:^|[\s`'"([])((?:[\w.-]+\/)*[\w.-]+\.(?:go|ts|tsx|js|jsx|py|java|kt|sql|proto|ya?ml|json|php|rb|cs))(?::(\d+))?/g;

/** Shell commands that only read source; their file arguments are handed on like Read/Grep tool calls. */
const SHELL_READ =
  /^(?:cat|sed|head|tail|grep|egrep|rg|nl|less|wc|awk|git\s+(?:show|diff|log|blame|grep))\b/;
const SHELL_PATH =
  /(?:^|[\s`'"([:=])((?:[\w.-]+\/)*[\w.-]+\.(?:go|ts|tsx|js|jsx|mjs|py|java|kt|sql|proto|ya?ml|json|php|rb|cs|css|md))(?::(\d+))?(?=$|[\s`'"),;:|])/g;

/** Repository-relative files a read-only shell command names (absolute paths under `roots` are made relative). */
export function shellReadPaths(command: string, roots: string[] = []): string[] {
  let text = command;
  for (const r of roots) if (r) text = text.split(`${r.replace(/\/$/, "")}/`).join("");
  const out = new Set<string>();
  for (const raw of text.split(/&&|\|\||;|\||\n/)) {
    const seg = raw.trim();
    if (!SHELL_READ.test(seg)) continue;
    for (const m of seg.matchAll(SHELL_PATH)) if (!m[1].startsWith("/")) out.add(m[1]);
  }
  return [...out];
}

/**
 * Deterministic handoff of source locations: files read/edited/grepped by the CURRENT attempt of each ancestor step
 * (invalidated attempts are excluded, so stale exploration is never handed on) — through file tools or read-only
 * shell commands — plus path[:line] references in their outputs. Saves the next agent from rediscovering where the
 * relevant code is.
 *
 * Revision-aware: an ancestor attempt that read a different revision than the run's pinned one (sourceRevision.ts)
 * contributes nothing; its attempt id is reported in `excluded` instead. Attempts recorded before pinning existed
 * have no revision and are kept. Withheld ancestors are not in `upstream`, so they never contribute.
 */
export async function collectFileRefs(
  c: Db,
  upstream: StepInput["upstream"],
  opts: { runId?: number; excluded?: number[] } = {},
) {
  const byPath = new Map<string, { refs: number; from: Set<string> }>();
  const add = (path: string, from: string) => {
    const p = path.replace(/^\.\//, "");
    if (!p || p.length > 300) return;
    const e = byPath.get(p) ?? byPath.set(p, { refs: 0, from: new Set() }).get(p)!;
    e.refs++;
    e.from.add(from);
  };
  let attemptIds = Object.values(upstream)
    .map((u) => u.attempt_id)
    .filter((x): x is number => !!x);
  const stale = new Set<number>();
  if (attemptIds.length && opts.runId) {
    const pins =
      (
        await one<{ s: Record<string, { commit: string }> | null }>(
          c,
          "SELECT source_revisions AS s FROM workflow_runs WHERE id = $1",
          [opts.runId],
        )
      )?.s ?? {};
    const revs = await q<{ id: number; rev: Record<string, { read: string | null }> | null }>(
      c,
      "SELECT id, metrics->'source_revision' AS rev FROM workflow_step_attempts WHERE id = ANY($1)",
      [attemptIds],
    );
    for (const r of revs)
      if (
        Object.entries(r.rev ?? {}).some(
          ([repo, v]) => pins[repo] && v?.read && v.read !== pins[repo].commit,
        )
      )
        stale.add(Number(r.id));
    attemptIds = attemptIds.filter((id) => !stale.has(id));
    opts.excluded?.push(...stale);
  }
  if (attemptIds.length) {
    const roots = opts.runId
      ? (
          await q<{ path: string }>(c, "SELECT path FROM execution_workspaces WHERE run_id = $1", [
            opts.runId,
          ])
        ).map((w) => w.path)
      : [];
    const rows = await q<{
      key: string;
      name: string;
      path: string | null;
      command: string | null;
    }>(
      c,
      `SELECT s.key, e.data->>'name' AS name, COALESCE(e.data->'input'->>'file_path', e.data->'input'->>'path') AS path,
              e.data->'input'->>'command' AS command
         FROM workflow_events e JOIN workflow_steps s ON s.id = e.step_id
        WHERE e.attempt_id = ANY($1) AND e.kind = 'tool'
          AND e.data->>'name' IN ('Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Bash', 'shell')`,
      [attemptIds],
    );
    for (const r of rows) {
      if (r.path && /\.[a-z]{1,5}$/i.test(r.path)) add(r.path, r.key);
      if (r.command) for (const p of shellReadPaths(r.command, roots)) add(p, r.key);
    }
  }
  for (const [key, u] of Object.entries(upstream)) {
    if (u.status !== "COMPLETED" || !u.output || (u.attempt_id && stale.has(u.attempt_id)))
      continue;
    for (const m of JSON.stringify(u.output).replace(/\\n/g, " ").matchAll(CODE_REF))
      add(m[2] ? `${m[1]}:${m[2]}` : m[1], key);
  }
  return [...byPath.entries()]
    .map(([path, v]) => ({ path, refs: v.refs, from: [...v.from] }))
    .sort((a, b) => b.refs - a.refs || a.path.localeCompare(b.path))
    .slice(0, 30);
}

export async function buildStepInput(c: Db, run: RunRow, step: StepRow): Promise<StepInput> {
  const wi = run.work_item_id
    ? await one(
        c,
        "SELECT id, code, title, description, project, source, payload FROM work_items WHERE id = $1",
        [run.work_item_id],
      )
    : null;
  const liveSteps = await q<StepRow>(
    c,
    "SELECT * FROM workflow_steps WHERE run_id=$1 ORDER BY position",
    [run.id],
  );
  const anc = ancestors(liveSteps, step.key);
  let upstream: StepInput["upstream"] = {};
  if (anc.size) {
    for (const s of await q<StepRow>(
      c,
      "SELECT key, status, current_attempt_id, output FROM workflow_steps WHERE run_id = $1 AND key = ANY($2)",
      [run.id, [...anc]],
    ))
      upstream[s.key] = { status: s.status, attempt_id: s.current_attempt_id, output: s.output };
  }
  // Independent verification: the coding agent's own claims never reach the verifier (only platform evidence does).
  if (isIndependent(step.config)) upstream = independentUpstream(liveSteps, upstream);
  // A step that must judge another step's claims without its reasoning (Bug Hunter verifier) never receives it.
  for (const key of withheldSteps(step.config)) delete upstream[key];
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
  let execution_contract: MandatoryExecutionContract | undefined;
  let execution_evidence_source: StepInput["execution_evidence_source"];
  if (step.type === "coding_agent" && !isIndependent(step.config)) {
    const previous = await one<{ input: StepInput }>(
      c,
      "SELECT input FROM workflow_step_attempts WHERE step_id=$1 AND generation=$2 ORDER BY id LIMIT 1",
      [step.id, step.generation],
    );
    const retry = step.pending_input?.execution_retry?.source_attempt_id
      ? await one<{ id: number; generation: number; input: StepInput }>(
          c,
          "SELECT id,generation,input FROM workflow_step_attempts WHERE id=$1 AND step_id=$2 AND generation<$3 AND status IN ('FAILED','CANCELED')",
          [step.pending_input.execution_retry.source_attempt_id, step.id, step.generation],
        )
      : null;
    // Work a worker observed in a generation that never completed was never accepted, so a later generation keeps that baseline.
    const unaccepted = previous
      ? null
      : await one<{ id: number; generation: number }>(
          c,
          `SELECT a.id, a.generation FROM workflow_step_attempts a
        WHERE a.step_id=$1 AND a.generation<$2
          AND a.generation > coalesce((SELECT max(generation) FROM workflow_step_attempts WHERE step_id=$1 AND generation<$2 AND status='COMPLETED'), 0)
          AND EXISTS (SELECT 1 FROM workflow_artifacts r WHERE r.attempt_id=a.id AND r.kind='implementation_baseline')
        ORDER BY a.id LIMIT 1`,
          [step.id, step.generation],
        );
    execution_evidence_source =
      previous?.input.execution_evidence_source ??
      (unaccepted ? { attempt_id: unaccepted.id, generation: unaccepted.generation } : undefined) ??
      (retry?.input.execution_contract
        ? { attempt_id: retry.id, generation: retry.generation }
        : undefined);
    execution_contract = previous
      ? previous.input.execution_contract
      : retry
        ? retry.input.execution_contract
        : buildExecutionContract(
            upstream,
            run.selected_repositories.length ? run.selected_repositories : run.allowed_repositories,
            wi,
            {
              graph: {
                ...run.graph,
                steps: liveSteps.map((s) => ({
                  ...s,
                  retry_backoff_seconds: s.retry_backoff_s,
                  run_if: s.run_if ?? undefined,
                })),
              },
              step,
              definition_version_id: run.definition_version_id,
              profile: run.profile,
              allowed_repositories: run.allowed_repositories,
              request: { title: run.title, description: wi?.description, inputs: run.inputs },
            },
          );
  }
  return {
    execution_contract,
    execution_evidence_source,
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
  const parts = [
    input.run.title,
    input.work_item?.title,
    input.work_item?.description,
    JSON.stringify(input.run.inputs ?? {}),
  ];
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
export async function resolveContext(
  c: Db,
  run: RunRow,
  step: StepRow,
  input: StepInput,
  provider?: string | null,
): Promise<ResolvedContext> {
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
  const res = resolveKnowledge(
    await visibleKnowledge(run.owner_id, await knowledge.candidates(c, run.owner_id, at)),
    {
      organization: config.organization,
      project,
      repositories,
      repositoryProjects: await projectsOfRepositories(repositories ?? [], c),
      workflowKey: run.definition_key,
      stepKey: cfg.evaluation_phase?.semantic_role ?? step.key,
      stepType: step.type,
      text: requestText(input),
      explicit,
      now: at,
      ponytailEnabled:
        (!cfg.evaluation_phase ||
          (cfg.evaluation_phase.ponytail ??
            ((cfg.skills as string[]) ?? []).some((k) => k.startsWith("skill.ext.ponytail")))) &&
        config.knowledge.ponytail.enabled,
    },
  );
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
  const memoryStates: Array<{ key: string; trust: string | null; state: string; reason: string }> =
    [];
  const memoryItems = res.applied.filter((k) => k.category === "task_memory");
  if (memoryItems.length) {
    const repoRows = await q<import("../repos/service.ts").RepositoryRow>(
      c,
      "SELECT * FROM repositories WHERE name = ANY($1)",
      [
        [
          ...new Set(
            memoryItems.map((k) =>
              String((k.metadata?.memory as Partial<MemoryMeta> | undefined)?.repo ?? ""),
            ),
          ),
        ],
      ],
    );
    for (const k of memoryItems) {
      const m = k.metadata?.memory as Partial<MemoryMeta> | undefined;
      const trusted = m && (m.trust === "verified" || m.trust === "approved");
      const row = repoRows.find((r) => r.name === m?.repo);
      const fresh = trusted
        ? await memoryFreshness(m, row ? repoPath(row) : null)
        : { state: "UNKNOWN", reason: "not verified or approved" };
      memoryStates.push({
        key: k.key,
        trust: m?.trust ?? null,
        state: fresh.state,
        reason: fresh.reason,
      });
      if (!trusted || fresh.state !== "FRESH") memoryStale.push(k.key);
    }
    res.applied = res.applied.filter((k) => !memoryStale.includes(k.key));
    // Outcome lessons (learning/lessons.ts): only active ones of this kind of task, the best few — never prompt stuffing.
    const lesson = (k: (typeof res.applied)[number]) => k.key.startsWith("memory.lesson.");
    const meta = (k: (typeof res.applied)[number]) =>
      (k.metadata?.memory ?? {}) as {
        status?: string;
        task_class?: string;
        corroborated_by?: string[];
        extracted_at?: string;
      };
    const relevant = res.applied
      .filter(lesson)
      .filter(
        (k) =>
          (meta(k).status ?? "active") === "active" &&
          (!meta(k).task_class || meta(k).task_class === run.definition_key),
      )
      .sort(
        (a, b) =>
          (meta(b).corroborated_by?.length ?? 0) - (meta(a).corroborated_by?.length ?? 0) ||
          String(meta(b).extracted_at ?? "").localeCompare(String(meta(a).extracted_at ?? "")),
      )
      .slice(0, config.learning.maxLessons);
    for (const k of res.applied.filter(lesson))
      if (!relevant.includes(k))
        memoryStates.push({
          key: k.key,
          trust: (k.metadata?.memory as Partial<MemoryMeta> | undefined)?.trust ?? null,
          state: "EXCLUDED",
          reason: "lesson not active, other task class, or over the lesson budget",
        });
    res.applied = res.applied.filter((k) => !lesson(k) || relevant.includes(k));
  }
  // Third-party skills the agent cannot use here never reach it; an explicitly assigned one fails the attempt.
  const unavailable = new Map<string, string>();
  for (const k of res.applied) {
    const a = skillAvailability(k.metadata, provider);
    if (!a.available) unavailable.set(k.key, a.reason);
  }
  for (const k of res.applied) {
    const parent = k.metadata?.parent_skill;
    if (typeof parent === "string" && unavailable.has(parent) && !unavailable.has(k.key))
      unavailable.set(k.key, `supporting file of unavailable ${parent}`);
  }
  const unavailableSkills: Array<{ key: string; reason: string }> = [];
  for (const k of res.applied.filter((x) => unavailable.has(x.key))) {
    res.overridden.push({
      key: k.key,
      version: k.version,
      by: "",
      conflict_key: k.conflict_key ?? "",
      reason: "unavailable",
      detail: unavailable.get(k.key),
    });
    if (k.reason === "assigned to step" || k.reason.startsWith("selected for this re-execution"))
      unavailableSkills.push({ key: k.key, reason: unavailable.get(k.key)! });
  }
  res.applied = res.applied.filter((k) => !unavailable.has(k.key));
  const rankText = [
    requestText(input),
    step.name,
    String(cfg.instructions ?? ""),
    String(input.pending?.reexecute?.instructions ?? ""),
  ].join("\n");
  const semantic = await semanticRanksByKey(run.owner_id, rankText, res.applied);
  const disclosure = planKnowledge(res.applied, {
    requestText: rankText,
    semantic: semantic && new Map([...semantic].map(([key, h]) => [key, h.rank])),
    stepType: step.type,
    inlineTokens:
      run.profile === "MICRO"
        ? Math.min(3000, config.agent.inlineKnowledgeTokens)
        : config.agent.inlineKnowledgeTokens,
    indexSize:
      run.profile === "MICRO"
        ? Math.min(4, Number(cfg.knowledge_index_size ?? config.agent.knowledgeIndexSize))
        : Number(cfg.knowledge_index_size ?? config.agent.knowledgeIndexSize),
  });
  const completed = Object.fromEntries(
    Object.entries(input.upstream).filter(([, u]) => u.status === "COMPLETED"),
  );
  const upstream = planUpstream(
    completed,
    step.depends_on,
    run.profile === "MICRO"
      ? Math.min(2000, Number(cfg.upstream_tokens ?? config.agent.upstreamTokens))
      : Number(cfg.upstream_tokens ?? config.agent.upstreamTokens),
  );
  const staleRefAttempts: number[] = [];
  const fileRefs =
    step.type === "agent" || step.type === "coding_agent"
      ? await collectFileRefs(c, input.upstream, { runId: run.id, excluded: staleRefAttempts })
      : [];
  const nativeSources =
    step.type === "agent" || step.type === "coding_agent"
      ? await detectNativeKnowledgeSources(
          await q<{ repo: string; path: string }>(
            c,
            "SELECT repo, path FROM execution_workspaces WHERE run_id=$1 AND (subtask_id IS NULL OR subtask_id=$2) ORDER BY repo",
            [run.id, step.subtask_id ?? null],
          ),
        )
      : [];
  const content = {
    native_sources: nativeSources,
    step: { key: step.key, type: step.type, generation: step.generation },
    // How the prompt was shaped — enough to reproduce/audit what the agent was shown.
    prompt_plan: {
      knowledge: disclosure,
      upstream: upstream.plan,
      file_refs: fileRefs,
      // Ancestor attempts whose exploration was at another revision than the run's pinned one (not handed on).
      ...(staleRefAttempts.length ? { file_refs_stale_attempts: staleRefAttempts } : {}),
      budgets: {
        inline_knowledge_tokens: config.agent.inlineKnowledgeTokens,
        index_size: config.agent.knowledgeIndexSize,
        upstream_tokens: config.agent.upstreamTokens,
      },
      setting_sources: config.agent.settingSources,
      reexecute: input.pending?.reexecute
        ? {
            instructions: input.pending.reexecute.instructions,
            skills: pinned.map((p) => `${p.key}@v${p.version}`),
            previous_attempt: input.previous_attempt?.number ?? null,
          }
        : null,
      delegation: cfg.delegation?.enabled === true,
      // The checks this attempt is held to (coding steps): audit trail for "why did it (not) complete".
      verification: step.type === "coding_agent" ? verificationPlan(cfg) : null,
      memory_excluded: memoryStale,
      memory_freshness: memoryStates,
      ...(provider ? { provider } : {}),
      ...(unavailableSkills.length ? { unavailable_skills: unavailableSkills } : {}),
    },
    project,
    repositories,
    upstream: Object.fromEntries(Object.entries(input.upstream).map(([k, v]) => [k, v.attempt_id])),
    answers: input.answers.length,
    input_hash: hashOf(input),
    knowledge: res.applied.map((k) => ({
      id: k.id,
      owner_id: k.owner_id ?? null,
      updated_at: k.updated_at,
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
  const snapshotId = await insertSnapshot(c, run.id, step.id, hash, content);
  const names = repositories.length ? repositories : run.allowed_repositories;
  const repoPaths = names.length
    ? (
        await q<import("../repos/service.ts").RepositoryRow>(
          c,
          "SELECT * FROM repositories WHERE name = ANY($1) ORDER BY name",
          [names],
        )
      ).map((r) => ({ name: r.name, path: repoPath(r) }))
    : [];
  return {
    snapshot_id: snapshotId,
    hash,
    project,
    repositories,
    knowledge: res.applied,
    overridden: res.overridden,
    disclosure,
    upstream,
    requestText: rankText,
    fileRefs,
    repoPaths,
    unavailableSkills,
  };
}

function verificationPlan(cfg: Record<string, unknown>) {
  const v = verifyConfig(cfg, TEST_COMMAND);
  if (!v) return { enabled: false };
  return {
    enabled: true,
    command_sha256: createHash("sha256").update(v.command).digest("hex").slice(0, 16),
    default_command: v.command === TEST_COMMAND,
    max_repairs: v.maxRepairs,
    baseline: v.baseline,
    allow_test_weakening: v.allowTestWeakening,
  };
}