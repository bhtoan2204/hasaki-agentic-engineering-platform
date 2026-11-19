import { createHash } from "node:crypto";
import { pool, q, one, type Db } from "../db/pool.ts";
import { redactPii, redactSecrets } from "../integrations/redact.ts";
import { knowledge } from "../knowledge/service.ts";
import { isEvaluationRun } from "../eval/scope.ts";

/**
 * Outcome-driven lessons on the knowledge registry (category task_memory, owner-private, REPOSITORY scope). Purposes:
 * negative (an approach that failed, with its evidence and context — never a universal ban) and procedural (a test or
 * verification action that demonstrably worked). Extraction is deterministic from platform records; a lesson is stored
 * only when its quote occurs in the source it cites and its evidence ids exist. Lessons are non-authoritative
 * proposals: retrieved as task observations with provenance, never as rules, never able to change policy.
 */

export const LESSON_PURPOSES = ["episodic", "semantic", "procedural", "negative"] as const;
export type LessonPurpose = (typeof LESSON_PURPOSES)[number];

export interface LessonCandidate {
  purpose: LessonPurpose;
  repo: string;
  claim: string;
  /** What the lesson is about (finding, command…): opposite lessons about one subject are disputed, not merged. */
  subject: string;
  quote: string | null;
  source: { text: string; ref: string };
  evidence: { run_id: number; attempt_ids: number[]; observation_ids: number[] };
  files: string[];
  commit_sha: string | null;
  task_class: string;
}

// Text that tries to turn a lesson into authority (approve, bypass, grant, change autonomy/policy) is quarantined.
const ESCALATION =
  /\b(always|must|should)\s+(approve|merge|skip|disable|bypass)\b|\bignore\s+(the\s+)?(policy|policies|rules?|review|instructions?)\b|\bgrant\s+(access|permission|admin)\b|\b(autopilot|autonomous mode|auto-approve|disable (the )?(sandbox|tests?|checks?))\b/i;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const clean = (s: string) => redactPii(redactSecrets(s));

export function claimHash(c: Pick<LessonCandidate, "purpose" | "repo" | "subject">) {
  return createHash("sha256")
    .update([c.purpose, c.repo, c.subject].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

/** Pure validation: the quote must be in the cited source, evidence must exist, no authority escalation, no generic advice. */
export function validateLesson(c: LessonCandidate, knownObservationIds: Set<number> = new Set()) {
  if (!c.claim.trim() || c.claim.length > 800)
    return { ok: false as const, reason: "empty or oversized claim" };
  if (ESCALATION.test(c.claim) || (c.quote && ESCALATION.test(c.quote)))
    return { ok: false as const, reason: "quarantined: tries to promote policy or authority" };
  if (c.quote && !norm(c.source.text).includes(norm(c.quote)))
    return {
      ok: false as const,
      reason: "quote not found in the cited source (fabricated evidence)",
    };
  if (c.evidence.observation_ids.some((id) => !knownObservationIds.has(id)))
    return { ok: false as const, reason: "cites an observation that does not exist" };
  if (!c.evidence.attempt_ids.length && !c.evidence.observation_ids.length)
    return { ok: false as const, reason: "no evidence reference" };
  if (!c.claim.includes(c.repo))
    return { ok: false as const, reason: "generic advice without task context" };
  return { ok: true as const };
}

interface RunFacts {
  run: { id: number; definition_key: string; selected_repositories: string[] };
  steps: Array<{
    key: string;
    type: string;
    config: Record<string, unknown>;
    attempts: Array<{ id: number; status: string; output: Record<string, unknown> | null }>;
  }>;
  observations: Array<{
    id: number;
    kind: string;
    repo: string | null;
    commit_sha: string | null;
    evidence: Record<string, unknown>;
  }>;
  heads: Record<string, string>;
  files: Record<string, string[]>;
}

const short = (s: unknown, n = 240) => norm(String(s ?? "")).slice(0, n);
const hash8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

/** Deterministic lessons of one finished run (pure). */
export function lessonsFromRun(f: RunFacts): LessonCandidate[] {
  const out: LessonCandidate[] = [];
  const onlyRepo = f.run.selected_repositories.length === 1 ? f.run.selected_repositories[0] : null;
  const base = (repo: string) => ({
    repo,
    commit_sha: f.heads[repo] ?? null,
    task_class: f.run.definition_key,
  });
  // Negative: what independent review rejected (an attempt that was later repaired is still a failed strategy).
  for (const s of f.steps)
    for (const a of s.attempts) {
      const o = a.output;
      if (o?.verdict !== "FAIL" || !Array.isArray(o.findings)) continue;
      for (const finding of (o.findings as Array<Record<string, unknown>>).slice(0, 3)) {
        const file = String(finding.file ?? "");
        const repo =
          file.includes(":") && f.run.selected_repositories.includes(file.split(":")[0])
            ? file.split(":")[0]
            : onlyRepo;
        const explanation = short(finding.explanation);
        if (!repo || !explanation) continue;
        const path = file.includes(":") ? file.split(":").slice(1).join(":") : file;
        out.push({
          ...base(repo),
          purpose: "negative",
          claim: `In ${repo}${path ? ` (${path})` : ""}, an implementation was rejected by independent review: ${explanation}. Consider another approach unless new evidence justifies it.`,
          subject: `finding:${repo}:${path}:${hash8(explanation)}`,
          quote: explanation,
          source: { text: JSON.stringify(o), ref: `attempt:${a.id}` },
          evidence: { run_id: f.run.id, attempt_ids: [a.id], observation_ids: [] },
          files: path ? [path] : (f.files[repo] ?? []).slice(0, 10),
        });
      }
    }
  // Negative: tests weakened by a change (removed/skipped/disabled), flagged by verification.
  for (const s of f.steps.filter((x) => x.type === "coding_agent"))
    for (const a of s.attempts) {
      const last =
        (
          a.output?.verification as
            { last?: Array<{ repo: string; weakened?: string[] }> } | undefined
        )?.last ?? [];
      for (const r of last)
        for (const w of (r.weakened ?? []).slice(0, 3))
          out.push({
            ...base(r.repo),
            purpose: "negative",
            claim: `In ${r.repo}, a change that weakened tests was flagged by verification: ${short(w)}. Fix the code, not the test.`,
            subject: `weakened:${r.repo}:${hash8(short(w))}`,
            quote: short(w),
            source: { text: JSON.stringify(a.output?.verification), ref: `attempt:${a.id}` },
            evidence: { run_id: f.run.id, attempt_ids: [a.id], observation_ids: [] },
            files: (f.files[r.repo] ?? []).slice(0, 10),
          });
    }
  // Procedural: required tests that passed on the final verification of a completed coding step.
  for (const s of f.steps.filter((x) => x.type === "coding_agent")) {
    const a = s.attempts.filter((x) => x.status === "COMPLETED").at(-1);
    const v = a?.output?.verification as
      | {
          passed?: boolean;
          last?: Array<{ repo: string; required_tests?: Record<string, string> }>;
        }
      | undefined;
    if (!a || v?.passed !== true) continue;
    const command = String((s.config.verify as { command?: string } | undefined)?.command ?? "");
    for (const r of v.last ?? []) {
      const passed = Object.entries(r.required_tests ?? {})
        .filter(([, st]) => st === "passed")
        .map(([t]) => t);
      if (!passed.length) continue;
      const names = passed.slice(0, 5).join(", ");
      out.push({
        ...base(r.repo),
        purpose: "procedural",
        claim: `In ${r.repo}, the required tests ${names} verified a change to ${(f.files[r.repo] ?? []).slice(0, 3).join(", ") || "this area"}${command ? ` (verification command \`${short(command, 160)}\`)` : ""}.`,
        subject: `tests:${r.repo}:${passed.slice(0, 5).sort().join(",")}`,
        quote: passed[0],
        source: { text: JSON.stringify(v), ref: `attempt:${a.id}` },
        evidence: { run_id: f.run.id, attempt_ids: [a.id], observation_ids: [] },
        files: (f.files[r.repo] ?? []).slice(0, 10),
      });
    }
  }
  // Negative: a later regression/rollback report, or a PR closed without merge.
  for (const o of f.observations) {
    const repos = o.repo ? [o.repo] : f.run.selected_repositories;
    for (const repo of repos) {
      if (o.kind === "regression_reported" || o.kind === "rollback_reported") {
        const note = short(o.evidence.note, 300);
        out.push({
          ...base(repo),
          purpose: "negative",
          claim: `In ${repo}, the change of run #${f.run.id} (${(f.files[repo] ?? []).slice(0, 3).join(", ") || "files unknown"}) was later reported as a ${o.kind === "rollback_reported" ? "rollback" : "regression"}${note ? `: ${note}` : ""}.`,
          subject: `${o.kind}:${repo}:${f.run.id}`,
          quote: note || null,
          source: { text: JSON.stringify(o.evidence), ref: `observation:${o.id}` },
          evidence: { run_id: f.run.id, attempt_ids: [], observation_ids: [o.id] },
          files: (f.files[repo] ?? []).slice(0, 10),
        });
      }
      if (o.kind === "pr_closed" && o.repo === repo)
        out.push({
          ...base(repo),
          purpose: "negative",
          claim: `In ${repo}, the pull request of run #${f.run.id} (${f.run.definition_key}) was closed without merge.`,
          subject: `pr_closed:${repo}:${f.run.id}`,
          quote: null,
          source: { text: JSON.stringify(o.evidence), ref: `observation:${o.id}` },
          evidence: { run_id: f.run.id, attempt_ids: [], observation_ids: [o.id] },
          files: (f.files[repo] ?? []).slice(0, 10),
        });
    }
  }
  return out;
}

async function factsOf(
  runId: number,
  db: Db,
): Promise<
  (RunFacts & { owner_id: number | null; work_item_id: number | null; outcome: unknown }) | null
> {
  const run = await one<{
    id: number;
    definition_key: string;
    selected_repositories: string[];
    owner_id: number | null;
    work_item_id: number | null;
    status: string;
    outcome: { repositories?: Array<{ repo: string; commit: string }> } | null;
  }>(
    db,
    "SELECT id, definition_key, selected_repositories, owner_id, work_item_id, status, outcome FROM workflow_runs WHERE id = $1",
    [runId],
  );
  if (!run || !["COMPLETED", "FAILED", "CANCELED"].includes(run.status)) return null;
  const steps = await q<{ id: number; key: string; type: string; config: Record<string, unknown> }>(
    db,
    "SELECT id, key, type, config FROM workflow_steps WHERE run_id = $1 ORDER BY position",
    [runId],
  );
  const attempts = await q<{
    id: number;
    step_id: number;
    status: string;
    output: Record<string, unknown> | null;
  }>(
    db,
    "SELECT id, step_id, status, output FROM workflow_step_attempts WHERE run_id = $1 ORDER BY id",
    [runId],
  );
  const observations = await q<{
    id: number;
    kind: string;
    repo: string | null;
    commit_sha: string | null;
    evidence: Record<string, unknown>;
  }>(
    db,
    "SELECT id, kind, repo, commit_sha, evidence FROM outcome_observations WHERE run_id = $1",
    [runId],
  );
  const files: Record<string, string[]> = {};
  const factHeads: Record<string, string> = {};
  for (const m of await q<{ files: string[] | null; repo: string; commit: string | null }>(
    db,
    `SELECT v.metadata->'memory'->'files' AS files, v.metadata->'memory'->>'repo' AS repo, v.metadata->'memory'->>'commit_sha' AS commit FROM knowledge_items i
       JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
      WHERE i.key LIKE $1`,
    [`memory.run-${runId}.%.facts`],
  ))
    if (m.repo) {
      files[m.repo] = m.files ?? [];
      if (m.commit) factHeads[m.repo] = m.commit;
    }
  return {
    run: {
      id: run.id,
      definition_key: run.definition_key,
      selected_repositories: run.selected_repositories,
    },
    steps: steps.map((s) => ({ ...s, attempts: attempts.filter((a) => a.step_id === s.id) })),
    observations,
    // The task commit: from the outcome, else from the run's verified memory facts (written by the memory effect).
    heads: {
      ...factHeads,
      ...Object.fromEntries((run.outcome?.repositories ?? []).map((r) => [r.repo, r.commit])),
    },
    files,
    owner_id: run.owner_id,
    work_item_id: run.work_item_id,
    outcome: run.outcome,
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export interface LearnReport {
  stored: number;
  corroborated: number;
  skipped: number;
  quarantined: Array<{ claim: string; reason: string }>;
  disputed: number;
}

/**
 * Learn from a finished run (idempotent: re-running adds nothing). Repeats of the same run or work item never count as
 * independent corroboration. Private to the run owner; evaluation runs are excluded.
 */
export async function extractLessons(runId: number, db: Db = pool): Promise<LearnReport> {
  const report: LearnReport = {
    stored: 0,
    corroborated: 0,
    skipped: 0,
    quarantined: [],
    disputed: 0,
  };
  if (await isEvaluationRun(runId)) return report;
  const f = await factsOf(runId, db);
  if (!f || f.owner_id == null) return report;
  const known = new Set(f.observations.map((o) => o.id));
  for (const c0 of lessonsFromRun(f)) {
    const c = {
      ...c0,
      claim: clean(c0.claim),
      quote: c0.quote ? clean(c0.quote) : null,
      source: { ...c0.source, text: clean(c0.source.text) },
    };
    const v = validateLesson(c, known);
    if (!v.ok) {
      report.quarantined.push({ claim: c.claim.slice(0, 120), reason: v.reason });
      continue;
    }
    const key = `memory.lesson.${c.purpose}.${slug(c.repo)}.${claimHash(c)}`;
    const existing = await knowledge.get(key, db, f.owner_id);
    const workKey = f.work_item_id != null ? `wi:${f.work_item_id}` : `run:${runId}`;
    if (existing) {
      const meta = (existing.versions[0]?.metadata ?? {}) as { memory?: Record<string, unknown> };
      const m = meta.memory ?? {};
      const seen = (m.corroborated_by as string[] | undefined) ?? [];
      if (seen.includes(workKey)) {
        // Same task again: no corroboration; only complete provenance that was missing when it was first learned.
        if (!m.commit_sha && c.commit_sha) {
          await knowledge.update(
            key,
            {
              metadata: {
                ...meta,
                memory: {
                  ...m,
                  commit_sha: c.commit_sha,
                  files: c.files.length ? c.files : m.files,
                },
              },
              change_note: `provenance completed from run #${runId}`,
              created_by: "outcome learning",
            },
            f.owner_id,
          );
        }
        report.skipped++;
        continue;
      }
      const by = [...seen, workKey];
      await knowledge.update(
        key,
        {
          metadata: {
            ...meta,
            memory: {
              ...m,
              corroborated_by: by,
              confidence: by.length >= 3 ? "high" : by.length === 2 ? "medium" : "low",
              commit_sha: c.commit_sha ?? m.commit_sha,
              files: c.files.length ? c.files : m.files,
              last_run_id: runId,
            },
          },
          change_note: `corroborated by run #${runId}`,
          created_by: "outcome learning",
        },
        f.owner_id,
      );
      report.corroborated++;
      continue;
    }
    const opposite = await one<{ key: string }>(
      db,
      `SELECT i.key FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
        WHERE i.category = 'task_memory' AND i.key LIKE 'memory.lesson.%' AND i.owner_id = $1
          AND v.metadata->'memory'->>'subject' = $2 AND v.metadata->'memory'->>'purpose' <> $3`,
      [f.owner_id, c.subject, c.purpose],
    );
    const status = opposite ? "disputed" : "active";
    await knowledge.create(
      {
        key,
        category: "task_memory",
        scope_type: "REPOSITORY",
        scope_ref: c.repo,
        title: `${c.purpose === "negative" ? "Lesson (failed approach)" : "Lesson (worked)"} — ${c.repo}`,
        content: [
          `Observed lesson (${c.purpose}, NON-AUTHORITATIVE — from verified run #${runId}; not a rule: confirm in the code, and new evidence may justify a different choice).`,
          c.claim,
          c.quote ? `Evidence (${c.source.ref}): "${c.quote}"` : `Evidence: ${c.source.ref}`,
        ].join("\n"),
        enabled: true,
        applicability: { repos: [c.repo] },
        metadata: {
          load: "on_demand",
          description: c.claim.slice(0, 200),
          memory: {
            run_id: runId,
            work_item: null,
            repo: c.repo,
            commit_sha: c.commit_sha ?? "",
            base_branch: "",
            files: c.files,
            // Trust of the evidence (platform-verified); the lesson itself stays a proposal (authority).
            trust: status === "disputed" ? "unverified" : "verified",
            confidence: "low",
            extracted_at: new Date().toISOString(),
            sources: [c.source.ref],
            purpose: c.purpose,
            authority: "proposal",
            claim: c.claim,
            claim_hash: claimHash(c),
            subject: c.subject,
            task_class: c.task_class,
            evidence: c.evidence,
            corroborated_by: [workKey],
            status,
          },
        },
        created_by: "outcome learning",
        change_note: `from run #${runId}`,
        ownerId: f.owner_id,
      },
      db,
    );
    report.stored++;
    if (opposite) {
      const other = await knowledge.get(opposite.key, db, f.owner_id);
      const meta = (other?.versions[0]?.metadata ?? {}) as { memory?: Record<string, unknown> };
      await knowledge.update(
        opposite.key,
        {
          metadata: {
            ...meta,
            memory: { ...meta.memory, status: "disputed", trust: "unverified" },
          },
          change_note: `disputed by run #${runId}`,
          created_by: "outcome learning",
        },
        f.owner_id,
      );
      report.disputed += 2;
    }
  }
  return report;
}

/** Learning view for the insights page: lessons by purpose and status, observation counts (owner-scoped unless all). */
export async function learningOverview(ownerId: number | null) {
  const lessons = await q<{ purpose: string; status: string; n: number; corroborated: number }>(
    pool,
    `SELECT v.metadata->'memory'->>'purpose' AS purpose, coalesce(v.metadata->'memory'->>'status', 'active') AS status,
            count(*)::int AS n, count(*) FILTER (WHERE jsonb_array_length(coalesce(v.metadata->'memory'->'corroborated_by', '[]')) > 1)::int AS corroborated
       FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
      WHERE i.key LIKE 'memory.lesson.%' AND ($1::bigint IS NULL OR i.owner_id = $1) GROUP BY 1, 2 ORDER BY 1, 2`,
    [ownerId],
  );
  const observations = await q<{ kind: string; n: number; verified: number }>(
    pool,
    `SELECT kind, count(*)::int AS n, count(*) FILTER (WHERE verified)::int AS verified FROM outcome_observations
      WHERE $1::bigint IS NULL OR owner_id = $1 GROUP BY 1 ORDER BY 1`,
    [ownerId],
  );
  const top = await q<{ key: string; claim: string; repo: string; corroborated: number }>(
    pool,
    `SELECT i.key, v.metadata->'memory'->>'claim' AS claim, i.scope_ref AS repo,
            jsonb_array_length(coalesce(v.metadata->'memory'->'corroborated_by', '[]'))::int AS corroborated
       FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
      WHERE i.key LIKE 'memory.lesson.negative.%' AND ($1::bigint IS NULL OR i.owner_id = $1)
      ORDER BY 4 DESC, i.id DESC LIMIT 10`,
    [ownerId],
  );
  return { lessons, observations, top_negative: top };
}
