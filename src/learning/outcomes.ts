/**
 * Verified outcomes: what the platform can PROVE about a finished run, kept apart from what agents claim.
 *
 * Ladder (each rung needs its own evidence; a run is never "successful" just because its status is COMPLETED):
 *   coding_complete      every coding step completed and its exact commits are recorded
 *   tests_passed         a test record (test step / harness verification) passed on exactly the final commits
 *   review_passed        an independent verifier PASS bound to exactly the final commits
 *   pr_opened            the provider created the PR (not just a "create PR" link)
 *   pr_merged            the provider reports the PR MERGED (synced: syncPullRequestStates)
 *   deployed             no deployment integration records deployments → always "unknown", never guessed
 *   production_verified  a human resolved the linked production error group with evidence after the merge
 * Each rung is "proven", "not_reached" (evidence says it did not happen) or "unknown" (no evidence either way).
 *
 * Failure categories are deterministic, derived from data the platform already records; categories it cannot detect
 * (e.g. an invalid external API assumption) are never assigned. Nothing here calls a model or writes knowledge.
 */
import { config } from "../config.ts";
import { pool, q, one, json, type Db } from "../db/pool.ts";
import { gitProvider, workspacesOf } from "../git/provider.ts";
import { repositoryBaseBranch, repositoryReference } from "../repos/service.ts";
import { collectScopeState, TEST_FILE } from "../agent/scopeGuard.ts";
import { costTotalsForRuns } from "../report/cost.ts";

export const OUTCOME_VERSION = 1;
export const RUNGS = ["coding_complete", "tests_passed", "review_passed", "pr_opened", "pr_merged", "deployed", "production_verified"] as const;
export type Rung = (typeof RUNGS)[number];
export interface RungState { state: "proven" | "not_reached" | "unknown"; evidence: string | null }

export const FAILURE_CATEGORIES = [
  "wrong_repository",
  "incorrect_business_assumption",
  "missing_regression_test",
  "out_of_scope_change",
  "incomplete_fix",
  "build_test_failure",
  "excessive_tokens",
  "repeated_search",
  "provider_handoff_loss",
  "incorrect_confidence",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
/** Listed so reports can say so explicitly: no recorded signal identifies these reliably. */
export const UNDETECTABLE_CATEGORIES = ["invalid_external_api_assumption"];

/** Everything the derivation needs, loaded from the run's own records. */
export interface OutcomeFacts {
  run: { id: number; status: string; definition_key: string; profile: string | null; agent_provider: string | null; work_item_id: number | null; policy_versions: Record<string, string> | null };
  steps: Array<{ key: string; type: string; status: string; independent: boolean; output: any; attempts: Array<{ status: string; output: any; error: string | null; metrics: any }> }>;
  final_heads: Record<string, string>;
  changed_files: Record<string, string[]>;
  pull_requests: Array<{ repo: string; url: string; created: boolean; state: string | null; merged_at: string | null }>;
  production: Array<{ fingerprint: string; lifecycle_status: string; resolved_at: string | null; evidence: string | null }>;
  handoffs: Array<{ status: string }>;
  usage: { cost_usd: number | null; tokens: number; availability: string };
  token_baseline: { median: number | null; samples: number };
  human: { answers: number; approvals: number; rejections: number; feedback: number };
}

const proven = (evidence: string): RungState => ({ state: "proven", evidence });
const no = (evidence: string): RungState => ({ state: "not_reached", evidence });
const unknown = (evidence: string): RungState => ({ state: "unknown", evidence });
const sameHeads = (a: Record<string, string> | undefined | null, b: Record<string, string>) =>
  !!a && Object.keys(b).length > 0 && Object.entries(b).every(([r, sha]) => a[r] === sha);

/** Pure: facts → outcome (unit-tested). */
export function deriveOutcome(f: OutcomeFacts) {
  const coding = f.steps.filter((s) => s.type === "coding_agent");
  const tests = f.steps.filter((s) => s.type === "command" && Array.isArray(s.output?.results));
  const verifiers = f.steps.filter((s) => s.independent);
  const heads = f.final_heads;
  const ladder = {} as Record<Rung, RungState>;

  ladder.coding_complete = !coding.length
    ? unknown("no coding step in this workflow")
    : coding.every((s) => s.status === "COMPLETED" && s.output?.commits && Object.keys(s.output.commits).length)
      ? proven(`commits ${Object.entries(heads).map(([r, s]) => `${r}@${s.slice(0, 12)}`).join(", ")}`)
      : no(`coding step(s) ${coding.filter((s) => s.status !== "COMPLETED").map((s) => `${s.key}=${s.status}`).join(", ") || "recorded no commits"}`);

  const testRecords = [
    ...tests.filter((s) => s.status === "COMPLETED").map((s) => ({ step: s.key, passed: s.output.passed === true && !s.output.decision, heads: s.output.tested_heads })),
    ...coding.filter((s) => s.output?.verification).map((s) => ({ step: s.key, passed: s.output.verification.passed === true, heads: s.output.tested_heads })),
  ];
  const bound = testRecords.filter((t) => t.passed && sameHeads(t.heads, heads));
  ladder.tests_passed = bound.length
    ? proven(`${bound.map((t) => t.step).join(", ")} passed on the final commits`)
    : testRecords.some((t) => !t.passed)
      ? no(`failing or human-excepted tests in ${testRecords.filter((t) => !t.passed).map((t) => t.step).join(", ")}`)
      : unknown(testRecords.length ? "test records are not bound to the final commits" : "no test step ran");

  const passes = verifiers.filter((s) => s.status === "COMPLETED" && s.output?.verdict === "PASS" && sameHeads(s.output?.verified_heads, heads));
  ladder.review_passed = !verifiers.length
    ? unknown("no independent verification in this workflow")
    : passes.length === verifiers.length
      ? proven(`independent PASS on the final commits (${passes.map((s) => s.key).join(", ")})`)
      : no(`verifier(s) without a PASS on the final commits: ${verifiers.filter((s) => !passes.includes(s)).map((s) => `${s.key}=${s.output?.verdict ?? s.status}`).join(", ")}`);

  // A real PR: created by this run, or an existing PR it updated (its URL names a PR id) — never a "create PR" link.
  const created = f.pull_requests.filter((p) => p.created || /\/pull-requests\/\d+(?:[/?#]|$)/.test(p.url));
  ladder.pr_opened = created.length ? proven(created.map((p) => p.url).join(", ")) : f.pull_requests.length ? no("only a create-PR link was produced") : unknown("no PR record");

  const merged = created.filter((p) => p.state === "MERGED");
  ladder.pr_merged = !created.length
    ? unknown("no PR")
    : merged.length === created.length
      ? proven(`merged: ${merged.map((p) => `${p.url}${p.merged_at ? ` at ${p.merged_at}` : ""}`).join(", ")}`)
      : created.some((p) => p.state === "DECLINED" || p.state === "SUPERSEDED")
        ? no("a PR was declined/superseded")
        : unknown(created.some((p) => p.state) ? "PR still open" : "PR state never synced from the provider");

  ladder.deployed = unknown("no deployment integration records deployments");

  const resolved = f.production.filter((p) => p.lifecycle_status === "resolved" && p.evidence && (!merged[0]?.merged_at || !p.resolved_at || p.resolved_at >= merged[0].merged_at));
  ladder.production_verified = !f.production.length
    ? unknown("no production error group is linked to this work item")
    : resolved.length === f.production.length
      ? proven(`resolved by a human with evidence: ${resolved.map((p) => p.fingerprint.slice(0, 12)).join(", ")}`)
      : unknown("linked production errors are not resolved with evidence after the merge");

  let verified_level: Rung | "none" = "none";
  for (const r of RUNGS) {
    if (ladder[r].state !== "proven") break;
    verified_level = r;
  }

  // ---- failure categories (each with the evidence that triggered it)
  const cat: Array<{ category: FailureCategory; evidence: string }> = [];
  const add = (category: FailureCategory, evidence: string) => cat.push({ category, evidence: evidence.slice(0, 300) });
  const scopeChecks = coding.flatMap((s) => [s.output?.scope_check, ...s.attempts.map((a) => a.output?.scope_check)]).filter(Boolean);
  const unauthorized = [...new Set(scopeChecks.flatMap((c: any) => c.unauthorized_repos ?? []))];
  if (unauthorized.length) add("wrong_repository", `changed repositories outside the approved scope: ${unauthorized.join(", ")}`);
  const oos = [...new Set(scopeChecks.flatMap((c: any) => c.out_of_scope_files ?? []))];
  if (oos.length) add("out_of_scope_change", `${oos.length} out-of-scope file(s), e.g. ${oos.slice(0, 3).join(", ")}`);
  const assumptions = f.steps.flatMap((s) => [s.output, ...s.attempts.map((a) => a.output)]).flatMap((o: any) => [...(o?.scope_check?.unsupported_assumptions ?? []), ...(o?.unsupported_assumptions ?? [])]);
  const contradicted = f.steps.flatMap((s) => (Array.isArray(s.output?.claims) ? s.output.claims : [])).filter((c: any) => c?.verification_status === "contradicted");
  if (assumptions.length || contradicted.length) add("incorrect_business_assumption", [assumptions.length ? `${assumptions.length} unsupported assumption(s)` : "", contradicted.length ? `${contradicted.length} contradicted claim(s), e.g. "${String(contradicted[0].claim).slice(0, 120)}"` : ""].filter(Boolean).join("; "));
  const requiredTests = f.steps.map((s) => s.output?.approved_scope?.required_tests).find((t) => Array.isArray(t) && t.length) ?? [];
  const changedTests = Object.values(f.changed_files).flat().filter((p) => TEST_FILE.test(p));
  if (requiredTests.length && coding.length && !changedTests.length) add("missing_regression_test", `approved scope requires ${requiredTests.length} test(s), the change adds or edits no test file`);
  const verdicts = verifiers.flatMap((s) => s.attempts.map((a) => a.output?.verdict)).filter(Boolean);
  const repairs = coding.reduce((n, s) => n + Number(s.output?.verification?.repairs ?? 0), 0);
  if (verdicts.includes("FAIL") || repairs > 0 || (f.run.status === "FAILED" && verifiers.some((s) => s.status === "FAILED")))
    add("incomplete_fix", `${verdicts.filter((v) => v === "FAIL").length} reviewer FAIL verdict(s), ${repairs} harness repair round(s)`);
  const testFailures = [...tests.flatMap((s) => s.attempts.filter((a) => a.output?.passed === false || /tests? failed|build failed|exit \d+/i.test(a.error ?? ""))), ...coding.flatMap((s) => s.attempts.filter((a) => /verification (still failing|made no progress)/i.test(a.error ?? "")))];
  if (testFailures.length) add("build_test_failure", `${testFailures.length} failed test/verification attempt(s)`);
  if (f.token_baseline.median != null && f.token_baseline.samples >= 5 && f.usage.tokens >= 10_000 && f.usage.tokens > 3 * f.token_baseline.median)
    add("excessive_tokens", `${f.usage.tokens} tokens vs median ${Math.round(f.token_baseline.median)} for ${f.run.definition_key} (${f.token_baseline.samples} runs)`);
  const rep = f.steps.flatMap((s) => s.attempts.map((a) => a.metrics?.tool_repeats)).filter(Boolean).reduce((acc: any, r: any) => ({ calls: acc.calls + r.calls, dup: acc.dup + r.duplicate_calls, reread: acc.reread + r.repeated_file_reads }), { calls: 0, dup: 0, reread: 0 });
  if ((rep.dup >= 5 && rep.dup / Math.max(1, rep.calls) >= 0.2) || rep.reread >= 10) add("repeated_search", `${rep.dup} duplicate tool call(s) of ${rep.calls}, ${rep.reread} repeated file read(s)`);
  const lost = f.handoffs.filter((h) => h.status === "BLOCKED"); // the only terminal "could not continue" state
  if (lost.length) add("provider_handoff_loss", `${lost.length} provider handoff(s) ended ${[...new Set(lost.map((h) => h.status))].join("/")}`);
  const overclaimed = f.steps.reduce((n, s) => n + Number(s.output?.evidence_validation?.downgraded ?? 0), 0);
  const confirmedThenFailed = f.steps.some((s) => s.output?.root_cause_assessment?.status === "CONFIRMED") && (verdicts.includes("FAIL") || f.run.status === "FAILED");
  if (overclaimed > 0 || confirmedThenFailed) add("incorrect_confidence", [overclaimed ? `${overclaimed} claim(s) downgraded by the platform` : "", confirmedThenFailed ? "root cause marked CONFIRMED, but the fix failed review/verification" : ""].filter(Boolean).join("; "));

  return {
    version: OUTCOME_VERSION,
    run_id: f.run.id,
    run_status: f.run.status,
    completed_is_not_success: true,
    ladder,
    verified_level,
    failure_categories: cat,
    undetectable_categories: UNDETECTABLE_CATEGORIES,
    provider: f.run.agent_provider,
    profile: f.run.profile,
    policy_versions: f.run.policy_versions,
    repositories: Object.entries(heads).map(([repo, commit]) => ({ repo, commit })),
    usage: f.usage,
    repairs: { harness: repairs, reviewer_fail_verdicts: verdicts.filter((v) => v === "FAIL").length },
    human: f.human,
  };
}
export type RunOutcome = ReturnType<typeof deriveOutcome>;

export async function collectOutcomeFacts(runId: number, db: Db = pool): Promise<OutcomeFacts | null> {
  const run = await one<any>(db, "SELECT id, status, definition_key, profile, agent_provider, work_item_id, policy_versions FROM workflow_runs WHERE id = $1", [runId]);
  if (!run) return null;
  const steps = await q<any>(db, "SELECT id, key, type, status, output, config->>'independent' = 'true' AS independent FROM workflow_steps WHERE run_id = $1 ORDER BY position", [runId]);
  const attempts = await q<any>(db, "SELECT step_id, status, output, error, metrics FROM workflow_step_attempts WHERE run_id = $1 ORDER BY id", [runId]);
  const coding = steps.filter((s) => s.type === "coding_agent" && s.output?.commits);
  const final_heads: Record<string, string> = Object.assign({}, ...coding.map((s) => s.output.commits));
  let changed_files: Record<string, string[]> = {};
  try {
    const ws = await workspacesOf(runId, db);
    changed_files = (await collectScopeState(await Promise.all(ws.map(async (w) => ({ repo: w.repo, path: w.path, base: `origin/${await repositoryBaseBranch(w.repo).catch(() => config.baseBranch)}` }))))).files;
  } catch {
    /* worktrees may be gone: the test-file check then simply does not fire */
  }
  const prs = await q<any>(db, "SELECT repo, url, created, state, merged_at FROM pull_requests WHERE run_id = $1 ORDER BY id", [runId]);
  const production = run.work_item_id
    ? await q<any>(
        db,
        `SELECT g.fingerprint, g.lifecycle_status,
                (SELECT max(e.created_at) FROM prod_error_lifecycle_events e WHERE e.fingerprint = g.fingerprint AND e.action = 'resolve') AS resolved_at,
                (SELECT e.evidence FROM prod_error_lifecycle_events e WHERE e.fingerprint = g.fingerprint AND e.action = 'resolve' AND e.evidence <> '' ORDER BY e.id DESC LIMIT 1) AS evidence
           FROM prod_error_groups g WHERE g.work_item_id = $1`,
        [run.work_item_id],
      ).catch(() => [])
    : [];
  const handoffs = await q<any>(db, "SELECT status FROM provider_handoffs WHERE run_id = $1", [runId]).catch(() => []);
  const cost = (await costTotalsForRuns([runId]).catch(() => new Map())).get(runId);
  const baseline = await one<any>(
    db,
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t) AS median, count(*)::int AS samples FROM (
       SELECT sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)) AS t FROM execution_attempt_telemetry x JOIN workflow_runs r ON r.id = x.run_id
        WHERE r.definition_key = $1 AND r.id <> $2 AND r.status IN ('COMPLETED','FAILED') GROUP BY x.run_id ORDER BY x.run_id DESC LIMIT 50) s`,
    [run.definition_key, runId],
  ).catch(() => null);
  const human = await one<any>(
    db,
    `SELECT (SELECT count(*)::int FROM workflow_questions WHERE run_id = $1 AND status = 'answered') AS answers,
            (SELECT count(*)::int FROM workflow_steps WHERE run_id = $1 AND approval->>'granted' = 'true') AS approvals,
            (SELECT count(*)::int FROM workflow_steps WHERE run_id = $1 AND approval->>'granted' = 'false') AS rejections,
            (SELECT count(*)::int FROM workflow_events WHERE run_id = $1 AND kind = 'user') AS feedback`,
    [runId],
  ).catch(() => null);
  return {
    run: { ...run, policy_versions: run.policy_versions ?? null },
    steps: steps.map((s) => ({ key: s.key, type: s.type, status: s.status, independent: !!s.independent, output: s.output, attempts: attempts.filter((a) => Number(a.step_id) === Number(s.id)) })),
    final_heads,
    changed_files,
    pull_requests: prs.map((p) => ({ ...p, merged_at: p.merged_at ? new Date(p.merged_at).toISOString() : null })),
    production: production.map((p: any) => ({ ...p, resolved_at: p.resolved_at ? new Date(p.resolved_at).toISOString() : null })),
    handoffs,
    usage: { cost_usd: cost?.cost_usd ?? null, tokens: cost?.tokens ?? 0, availability: cost?.availability ?? "none" },
    token_baseline: { median: baseline?.median != null ? Number(baseline.median) : null, samples: Number(baseline?.samples ?? 0) },
    human: { answers: Number(human?.answers ?? 0), approvals: Number(human?.approvals ?? 0), rejections: Number(human?.rejections ?? 0), feedback: Number(human?.feedback ?? 0) },
  };
}

/**
 * Sync PR lifecycle states from the provider (read-only API call per open PR) and refresh the affected outcomes.
 * A merge is recorded only when the provider says MERGED; failures leave the state unknown, never guessed.
 */
export async function syncPullRequestStates(opts: { runId?: number; limit?: number } = {}) {
  const provider = gitProvider();
  if (!provider.pullRequestState) return { checked: 0, updated: 0, errors: ["the git provider cannot report PR states"] };
  const rows = await q<any>(
    pool,
    `SELECT id, repo, url, run_id, state FROM pull_requests
      WHERE (state IS NULL OR state = 'OPEN') AND ($1::bigint IS NULL OR run_id = $1) ORDER BY state_checked_at NULLS FIRST, id LIMIT $2`,
    [opts.runId ?? null, Math.min(200, opts.limit ?? 50)],
  );
  let updated = 0;
  const errors: string[] = [];
  const runs = new Set<number>();
  for (const r of rows) {
    try {
      const reg = await one<any>(pool, "SELECT * FROM repositories WHERE name = $1", [r.repo]);
      const st = await provider.pullRequestState({ repo: reg ? repositoryReference(reg) : r.repo, url: r.url });
      if (!st) continue;
      const state = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"].includes(st.state) ? st.state : null;
      await q(pool, "UPDATE pull_requests SET state = $2, merged_at = $3, merge_commit = $4, state_checked_at = now() WHERE id = $1", [r.id, state, st.merged_at, st.merge_commit]);
      if (state !== r.state) {
        updated++;
        if (r.run_id) runs.add(Number(r.run_id));
      }
    } catch (e) {
      errors.push(`${r.repo}: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
    }
  }
  for (const id of runs) await recordRunOutcome(id).catch(() => {});
  return { checked: rows.length, updated, errors };
}

/** Compute and store the outcome (idempotent; re-run after a PR state sync or a production resolution). */
export async function recordRunOutcome(runId: number, db: Db = pool) {
  const facts = await collectOutcomeFacts(runId, db);
  if (!facts || !["COMPLETED", "FAILED", "CANCELED"].includes(facts.run.status)) return null;
  const outcome = deriveOutcome(facts);
  await q(db, "UPDATE workflow_runs SET outcome = $2, outcome_at = now() WHERE id = $1", [runId, json(outcome)]);
  return outcome;
}
