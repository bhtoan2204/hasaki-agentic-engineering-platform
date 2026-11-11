/**
 * The feedback loop on top of verified outcomes (outcomes.ts):
 *   task outcome → failure category → suggested improvement → HUMAN REVIEW (knowledge proposals) → versioned change
 *   → benchmark → adoption or rollback (existing proposal approve/rollback + policy versions on every run).
 *
 * Quality controls:
 *  - Only platform-derived signals feed patterns (scope checks, verdicts, test records, telemetry) — never an agent's
 *    own conclusion; evaluation (synthetic benchmark) runs are excluded from production patterns.
 *  - A pattern needs repetition across several runs AND several distinct tasks before anything is proposed (no
 *    overfitting to one task); proposals are deduplicated by the existing proposal dedupe key and stay pending.
 *  - Nothing is promoted automatically; nothing calls a model.
 */
import { createHash } from "node:crypto";
import { pool, q, one, type Db } from "../db/pool.ts";
import { createProposal } from "../knowledge/proposals.ts";
import { redactPii, redactSecrets } from "../integrations/redact.ts";
import { workspacesOf } from "../git/provider.ts";
import { repositoryBaseBranch } from "../repos/service.ts";
import { config } from "../config.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TEST_FILE } from "../agent/scopeGuard.ts";
import { policyKey } from "./policyVersions.ts";
import { FAILURE_CATEGORIES, RUNGS, type FailureCategory } from "./outcomes.ts";

const exec = promisify(execFile);

/** The improvement a repeated category suggests, and the reviewable rule text (deterministic templates). */
export const IMPROVEMENTS: Record<FailureCategory, { kind: string; title: string; rule: string }> =
  {
    wrong_repository: {
      kind: "repository retrieval strategy",
      title: "Confirm the target repository before editing",
      rule: "Before changing code, confirm the target repository against the approved scope and the repository registry; if the change seems to belong to another repository, stop and ask instead of editing it.",
    },
    incorrect_business_assumption: {
      kind: "coding rule",
      title: "Do not implement unverified business assumptions",
      rule: "A business rule may only be implemented when it is backed by a verified source (approved requirement, business-rule knowledge, or code at a cited commit). Unverified assumptions must be raised as questions, not encoded.",
    },
    missing_regression_test: {
      kind: "deterministic validator / workflow instruction",
      title: "Every fix adds the required regression test",
      rule: "When the approved scope lists required tests, the change must add or update a test that fails before the fix and passes after it, in the same repository as the fix.",
    },
    out_of_scope_change: {
      kind: "workflow instruction",
      title: "Stay inside the approved change scope",
      rule: "Edit only the files listed in the approved scope (or their companion tests). A needed change elsewhere requires renewed approval before it is made.",
    },
    incomplete_fix: {
      kind: "coding rule / benchmark case",
      title: "Verify the failure path, not only the happy path",
      rule: "Before submitting a fix, exercise the reported failure path (test or reproduction) and the closest edge cases; a fix is complete only when the original failure no longer reproduces.",
    },
    build_test_failure: {
      kind: "workflow instruction",
      title: "Build and run the affected tests before submitting",
      rule: "Run the repository's build and the tests of every changed package before submitting; never submit code that does not compile.",
    },
    excessive_tokens: {
      kind: "context retrieval strategy",
      title: "Use targeted retrieval instead of broad reads",
      rule: "Locate code with platform get_symbol / find_dependencies / search_code first, then read targeted line ranges; avoid reading whole files or directories that are not needed for the change.",
    },
    repeated_search: {
      kind: "context retrieval strategy",
      title: "Do not repeat identical searches and reads",
      rule: "Keep notes of what was already searched and read; reuse earlier results instead of repeating identical tool calls or re-reading unchanged files.",
    },
    provider_handoff_loss: {
      kind: "workflow instruction",
      title: "Leave a resumable checkpoint before long operations",
      rule: "Commit progress and post a short status update (what is done, what remains, open questions) before long-running operations so another provider can resume without losing context.",
    },
    incorrect_confidence: {
      kind: "coding rule",
      title: "Confidence must follow verified evidence",
      rule: "Mark a root cause CONFIRMED only when it rests on verified facts; otherwise report it as PROBABLE or a hypothesis with the evidence still missing.",
    },
  };

export interface PatternOptions {
  days?: number;
  /** Owner scope: null = all owners (admin/support view). */
  ownerId?: number | null;
}

async function outcomesInWindow(o: PatternOptions, db: Db = pool) {
  const days = Math.min(365, Math.max(1, Math.round(o.days ?? 30)));
  return q<any>(
    db,
    `SELECT r.id, r.work_item_id, r.definition_key, r.outcome, r.policy_versions, r.outcome_at
       FROM workflow_runs r
      WHERE r.outcome IS NOT NULL AND r.outcome_at > now() - make_interval(days => $1)
        AND ($2::bigint IS NULL OR r.owner_id = $2)
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id) -- synthetic benchmarks are not production evidence
      ORDER BY r.id DESC LIMIT 2000`,
    [days, o.ownerId ?? null],
  );
}

/** Repeated failure categories, the verified-outcome distribution and an observational comparison by policy version. */
export async function qualityPatterns(o: PatternOptions = {}, db: Db = pool) {
  const rows = await outcomesInWindow(o, db);
  const byCat = new Map<string, { runs: number[]; tasks: Set<string>; examples: string[] }>();
  const levels: Record<string, number> = Object.fromEntries(["none", ...RUNGS].map((r) => [r, 0]));
  const byPolicy = new Map<
    string,
    {
      versions: any;
      runs: number;
      review_passed: number;
      tests_passed: number;
      with_failures: number;
      repairs: number;
      costs: number[];
    }
  >();
  let verifiedCost = 0,
    verifiedCount = 0;
  for (const r of rows) {
    const out = r.outcome;
    levels[out.verified_level] = (levels[out.verified_level] ?? 0) + 1;
    for (const c of out.failure_categories ?? []) {
      const e = byCat.get(c.category) ?? { runs: [], tasks: new Set<string>(), examples: [] };
      e.runs.push(Number(r.id));
      e.tasks.add(r.work_item_id ? `wi:${r.work_item_id}` : `run:${r.id}`);
      if (e.examples.length < 3) e.examples.push(`run #${r.id}: ${c.evidence}`);
      byCat.set(c.category, e);
    }
    const key = policyKey(r.policy_versions);
    const p = byPolicy.get(key) ?? {
      versions: r.policy_versions ?? null,
      runs: 0,
      review_passed: 0,
      tests_passed: 0,
      with_failures: 0,
      repairs: 0,
      costs: [],
    };
    p.runs++;
    if (out.ladder?.review_passed?.state === "proven") p.review_passed++;
    if (out.ladder?.tests_passed?.state === "proven") p.tests_passed++;
    if ((out.failure_categories ?? []).length) p.with_failures++;
    p.repairs +=
      Number(out.repairs?.harness ?? 0) + Number(out.repairs?.reviewer_fail_verdicts ?? 0);
    if (typeof out.usage?.cost_usd === "number") p.costs.push(out.usage.cost_usd);
    byPolicy.set(key, p);
    const verified =
      out.ladder?.tests_passed?.state === "proven" &&
      out.ladder?.review_passed?.state !== "not_reached";
    if (verified && typeof out.usage?.cost_usd === "number") {
      verifiedCost += out.usage.cost_usd;
      verifiedCount++;
    }
  }
  const median = (xs: number[]) =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null;
  return {
    window_days: Math.min(365, Math.max(1, Math.round(o.days ?? 30))),
    runs: rows.length,
    verified_levels: levels,
    cost_per_verified_task: verifiedCount
      ? Math.round((verifiedCost / verifiedCount) * 1e4) / 1e4
      : null,
    patterns: [...byCat.entries()]
      .map(([category, e]) => ({
        category,
        runs: e.runs.length,
        distinct_tasks: e.tasks.size,
        rate: rows.length ? Math.round((e.runs.length / rows.length) * 1000) / 10 : 0,
        run_ids: e.runs.slice(0, 20),
        examples: e.examples,
        suggested: IMPROVEMENTS[category as FailureCategory] ?? null,
      }))
      .sort((a, b) => b.runs - a.runs),
    undetected: ["invalid_external_api_assumption"],
    by_policy_version: [...byPolicy.entries()].map(([key, p]) => ({
      policy_key: key,
      versions: p.versions,
      runs: p.runs,
      review_passed_rate: Math.round((p.review_passed / p.runs) * 1000) / 10,
      tests_passed_rate: Math.round((p.tests_passed / p.runs) * 1000) / 10,
      failure_rate: Math.round((p.with_failures / p.runs) * 1000) / 10,
      avg_repairs: Math.round((p.repairs / p.runs) * 100) / 100,
      median_cost_usd: median(p.costs),
    })),
    comparison_note:
      "Observational: runs under different policy versions differ in tasks too. Adopt a policy only after a pinned paired benchmark comparison.",
  };
}

/**
 * Turn repeated failure categories into PENDING knowledge proposals (never promoted automatically). Needs `minRuns`
 * occurrences across at least `minTasks` distinct tasks. Re-running adds evidence to the same open proposal instead of
 * creating duplicates; an already approved rule is not proposed again.
 */
export async function proposeImprovements(
  o: PatternOptions & { minRuns?: number; minTasks?: number; by: string },
  db: Db = pool,
) {
  const minRuns = Math.max(2, o.minRuns ?? 3),
    minTasks = Math.max(2, o.minTasks ?? 2);
  const p = await qualityPatterns(o, db);
  const results: Array<{
    category: string;
    status: string;
    proposal_id?: number;
    reason?: string;
  }> = [];
  for (const pat of p.patterns) {
    const imp = IMPROVEMENTS[pat.category as FailureCategory];
    if (!imp) continue;
    if (pat.runs < minRuns || pat.distinct_tasks < minTasks) {
      results.push({
        category: pat.category,
        status: "below_threshold",
        reason: `${pat.runs} run(s) / ${pat.distinct_tasks} task(s); needs ${minRuns} / ${minTasks}`,
      });
      continue;
    }
    const r = await createProposal(
      {
        ownerId: null,
        changeType: "CREATE",
        proposed: {
          key: `rule.failure-pattern.${pat.category.replace(/_/g, "-")}`,
          title: imp.title,
          category: "coding_standard",
          scope_type: "GLOBAL",
          conflict_key: `failure-pattern:${pat.category}`,
          content: `${imp.rule}\n\n(Proposed from a repeated failure pattern: ${pat.category}, ${pat.runs} runs across ${pat.distinct_tasks} tasks in ${p.window_days} days. Suggested change type: ${imp.kind}.)`,
        },
        domain: "coding_standard",
        confidence: Math.min(0.6, 0.2 + pat.distinct_tasks * 0.05),
        uncertainty:
          "Derived from platform failure signals, not from a human statement; review whether a rule, a validator, a benchmark case or a retrieval change is the right fix.",
        evidence: pat.run_ids.slice(0, 10).map((id, i) => ({
          source: "failure_pattern",
          ref: { run_id: id, category: pat.category },
          author: "platform",
          trust: "platform" as const,
          quote: (pat.examples[i] ?? `run #${id}: ${pat.category}`).slice(0, 300),
        })),
        sourceKind: "failure_pattern",
        createdBy: o.by,
      },
      db,
    ).catch((e) => ({ proposal: null, created: false, reason: (e as Error).message }));
    results.push({
      category: pat.category,
      status: r.proposal ? (r.created ? "proposed" : "merged_into_existing") : "skipped",
      proposal_id: r.proposal?.id ? Number(r.proposal.id) : undefined,
      reason: r.reason,
    });
  }
  return { thresholds: { min_runs: minRuns, min_tasks: minTasks }, results };
}

// ---------------------------------------------------------------- regression case candidates

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Requirement text for a benchmark: secrets, credentials and customer data removed; bounded. */
export function sanitizeRequirement(text: string) {
  // Stricter than log redaction (which keeps masked fragments): a benchmark keeps no part of contact data or URLs.
  return clip(
    redactPii(redactSecrets(String(text ?? "")))
      .replace(/https?:\/\/[^\s)]+/g, "[url]")
      .replace(/[^\s<>()]+@[^\s<>()]+\.[a-z]{2,}/gi, "[email]")
      .replace(/\+?\d[\d*.\s-]{6,}\d/g, (m) =>
        /\*/.test(m) || m.replace(/\D/g, "").length >= 9 ? "[phone]" : m,
      ),
    4000,
  );
}

/**
 * Propose a completed run as a regression benchmark candidate (pending human review). Requires platform-proven tests
 * on the final commits and a human-accepted change (merged PR or an approved PR step). The run's own tests were written
 * by the agent, so they are recorded as agent-authored and can never be the sole ground truth: accepting the candidate
 * requires human acceptance criteria (reviewRegressionCase).
 */
export async function proposeRegressionCase(runId: number, ownerId: number | null, db: Db = pool) {
  const run = await one<any>(
    db,
    "SELECT r.id, r.status, r.outcome, r.work_item_id, w.title, w.description FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1",
    [runId],
  );
  if (!run?.outcome) return { created: [], refused: "the run has no recorded outcome yet" };
  const lad = run.outcome.ladder ?? {};
  if (lad.tests_passed?.state !== "proven")
    return { created: [], refused: "tests did not pass on the final commits (platform-proven)" };
  const humanAccepted =
    lad.pr_merged?.state === "proven" || Number(run.outcome.human?.approvals ?? 0) > 0;
  if (!humanAccepted)
    return {
      created: [],
      refused:
        "no human acceptance (merged PR or approval) — an agent's own result is not ground truth",
    };
  const requirement = sanitizeRequirement(
    [run.title, run.description].filter(Boolean).join("\n\n"),
  );
  if (!requirement.trim()) return { created: [], refused: "no task requirement to benchmark" };
  const steps = await q<any>(
    db,
    "SELECT key, output, config FROM workflow_steps WHERE run_id = $1 AND status = 'COMPLETED' ORDER BY position",
    [runId],
  );
  const scope = steps.map((s) => s.output?.approved_scope).find(Boolean) ?? null;
  const testSteps = steps
    .filter((s) => Array.isArray(s.output?.results))
    .map((s) => ({ step: s.key, command: s.config?.command ?? null }));
  const created: any[] = [];
  for (const { repo, commit } of run.outcome.repositories ?? []) {
    const ws = (await workspacesOf(runId, db)).find((w) => w.repo === repo);
    let base = "",
      changed: string[] = [];
    try {
      if (ws) {
        const b = `origin/${await repositoryBaseBranch(repo).catch(() => config.baseBranch)}`;
        base = (await exec("git", ["-C", ws.path, "merge-base", b, commit])).stdout.trim();
        changed = (
          await exec("git", ["-C", ws.path, "diff", "--name-only", `${base}..${commit}`])
        ).stdout
          .split("\n")
          .filter(Boolean);
      }
    } catch {
      /* worktree gone or commit unknown: refused below */
    }
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(commit)) {
      created.push({ repo, refused: "cannot pin the base commit (worktree no longer available)" });
      continue;
    }
    const row = await one<any>(
      db,
      `INSERT INTO regression_case_candidates(run_id, work_item_id, owner_id, repository, base_commit, fix_commit, requirement, acceptance, safety)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (run_id, repository) DO NOTHING RETURNING id`,
      [
        runId,
        run.work_item_id,
        ownerId,
        repo,
        base,
        commit,
        requirement,
        JSON.stringify({
          test_steps: testSteps,
          agent_authored_tests: changed.filter((p) => TEST_FILE.test(p)),
          human_acceptance: {
            pr_merged: lad.pr_merged?.state === "proven",
            approvals: Number(run.outcome.human?.approvals ?? 0),
          },
          independent_ground_truth: false,
          note: "Hidden acceptance tests must come from a human (or a pre-existing test that failed before the fix) — not from this run's own tests.",
        }),
        JSON.stringify({
          allowed_files: (scope?.changes ?? [])
            .filter((c: any) => c.repo === repo)
            .flatMap((c: any) => c.files ?? []),
          prohibited_assumptions: scope?.prohibited_assumptions ?? [],
          no_network: true,
          no_external_side_effects: true,
          requirement_fingerprint: createHash("sha256")
            .update(requirement)
            .digest("hex")
            .slice(0, 16),
        }),
      ],
    );
    created.push(row ? { repo, id: Number(row.id) } : { repo, refused: "already proposed" });
  }
  return { created, refused: null };
}

/** Human review of a candidate. Accepting requires human acceptance criteria: the benchmark's independent ground truth. */
export async function reviewRegressionCase(
  id: number,
  decision: "accepted" | "rejected",
  by: string,
  body: { acceptance_criteria?: unknown; comment?: unknown },
  db: Db = pool,
) {
  const c = await one<any>(db, "SELECT * FROM regression_case_candidates WHERE id = $1", [id]);
  if (!c) throw new Error("regression case candidate not found");
  if (c.status !== "pending") throw new Error(`candidate is already ${c.status}`);
  const criteria = String(body.acceptance_criteria ?? "").trim();
  if (decision === "accepted" && criteria.length < 20)
    throw new Error(
      "accepting needs human-written acceptance criteria (≥ 20 characters): the run's own agent-written tests cannot be the ground truth",
    );
  const acceptance =
    decision === "accepted"
      ? {
          ...c.acceptance,
          human_acceptance_criteria: sanitizeRequirement(criteria),
          independent_ground_truth: true,
        }
      : c.acceptance;
  return one(
    db,
    "UPDATE regression_case_candidates SET status = $2, reviewed_by = $3, reviewed_at = now(), review_comment = $4, acceptance = $5 WHERE id = $1 RETURNING *",
    [id, decision, by, String(body.comment ?? "").slice(0, 2000), JSON.stringify(acceptance)],
  );
}

export const regressionCases = (ownerId: number | null, db: Db = pool) =>
  q(
    db,
    "SELECT * FROM regression_case_candidates WHERE ($1::bigint IS NULL OR owner_id = $1) ORDER BY id DESC LIMIT 200",
    [ownerId],
  );

export { FAILURE_CATEGORIES };
