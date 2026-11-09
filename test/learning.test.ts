import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOutcome, type OutcomeFacts } from "../src/learning/outcomes.ts";
import { sanitizeRequirement } from "../src/learning/patterns.ts";
import { executionPolicyVersions, policyKey } from "../src/learning/policyVersions.ts";

const H = "a".repeat(40);
const OTHER = "b".repeat(40);
function facts(over: Partial<OutcomeFacts> = {}): OutcomeFacts {
  return {
    run: { id: 1, status: "COMPLETED", definition_key: "bug-investigation", profile: "STANDARD", agent_provider: "claude", work_item_id: 7, policy_versions: { prompt_template: "p1" } },
    steps: [
      { key: "implement", type: "coding_agent", status: "COMPLETED", independent: false, output: { summary: "fully tested, trust me", commits: { svc: H }, verification: { passed: true, repairs: 0 }, tested_heads: { svc: H } }, attempts: [] },
      { key: "regression_test", type: "command", status: "COMPLETED", independent: false, output: { results: [{ repo: "svc", passed: true }], passed: true, tested_heads: { svc: H } }, attempts: [] },
      { key: "review", type: "agent", status: "COMPLETED", independent: true, output: { verdict: "PASS", verified_heads: { svc: H } }, attempts: [{ status: "COMPLETED", output: { verdict: "PASS" }, error: null, metrics: null }] },
    ],
    final_heads: { svc: H },
    changed_files: { svc: ["app/refund.go", "app/refund_test.go"] },
    pull_requests: [{ repo: "svc", url: "https://bitbucket.org/ws/svc/pull-requests/12", created: true, state: null, merged_at: null }],
    production: [],
    handoffs: [],
    usage: { cost_usd: 1.2, tokens: 50_000, availability: "complete" },
    token_baseline: { median: 40_000, samples: 10 },
    human: { answers: 0, approvals: 1, rejections: 0, feedback: 0 },
    ...over,
  };
}

test("outcome ladder: only proven states count — COMPLETED is not success, a PR is not a merge, deployment is never guessed", () => {
  const o = deriveOutcome(facts());
  assert.equal(o.completed_is_not_success, true);
  assert.deepEqual(Object.fromEntries(Object.entries(o.ladder).map(([k, v]) => [k, v.state])), {
    coding_complete: "proven", tests_passed: "proven", review_passed: "proven", pr_opened: "proven",
    pr_merged: "unknown", deployed: "unknown", production_verified: "unknown",
  });
  assert.equal(o.verified_level, "pr_opened");
  assert.match(o.ladder.pr_merged.evidence!, /never synced/);
  const merged = deriveOutcome(facts({ pull_requests: [{ repo: "svc", url: "https://bitbucket.org/ws/svc/pull-requests/12", created: true, state: "MERGED", merged_at: "2026-11-09T10:00:00.000Z" }] }));
  assert.equal(merged.ladder.pr_merged.state, "proven");
  assert.equal(merged.verified_level, "pr_merged", "deployment is unknown, so the ladder stops at the merge");
  assert.equal(deriveOutcome(facts({ pull_requests: [{ repo: "svc", url: "https://bitbucket.org/ws/svc/pull-requests/new?source=x", created: false, state: null, merged_at: null }] })).ladder.pr_opened.state, "not_reached", "a create-PR link is not a PR");
  assert.equal(deriveOutcome(facts({ pull_requests: [{ repo: "svc", url: "https://bitbucket.org/ws/svc/pull-requests/12", created: false, state: null, merged_at: null }] })).ladder.pr_opened.state, "proven", "an existing PR the run updated is a real PR");
});

test("outcome ladder: tests and review must be bound to the final commits; agent claims prove nothing", () => {
  const stale = facts();
  stale.steps[1].output.tested_heads = { svc: OTHER };
  stale.steps[0].output.tested_heads = { svc: OTHER };
  stale.steps[2].output.verified_heads = { svc: OTHER };
  const o = deriveOutcome(stale);
  assert.equal(o.ladder.tests_passed.state, "unknown");
  assert.match(o.ladder.tests_passed.evidence!, /not bound to the final commits/);
  assert.equal(o.ladder.review_passed.state, "not_reached");
  assert.equal(o.verified_level, "coding_complete");
  const excepted = facts();
  excepted.steps[1].output = { ...excepted.steps[1].output, passed: false, decision: { action: "continue_with_exception" } };
  excepted.steps[0].output.verification = undefined;
  assert.equal(deriveOutcome(excepted).ladder.tests_passed.state, "not_reached", "human-excepted failures are not passing tests");
  const production = deriveOutcome(facts({ production: [{ fingerprint: "f".repeat(40), lifecycle_status: "resolved", resolved_at: "2026-11-09T11:00:00.000Z", evidence: "no recurrence for 48h after deploy" }], pull_requests: [{ repo: "svc", url: "https://bitbucket.org/ws/svc/pull-requests/12", created: true, state: "MERGED", merged_at: "2026-11-09T10:00:00.000Z" }] }));
  assert.equal(production.ladder.production_verified.state, "proven");
  assert.equal(production.verified_level, "pr_merged", "a gap (deployed unknown) stops the verified level even if a later rung is proven");
});

test("failure categories are deterministic and evidence-backed", () => {
  const f = facts({
    steps: [
      { key: "fix_proposal", type: "agent", status: "COMPLETED", independent: false, output: { root_cause_assessment: { status: "CONFIRMED" }, evidence_validation: { downgraded: 2 }, claims: [{ claim: "status 7 means refunded", verification_status: "contradicted" }] }, attempts: [] },
      { key: "approve_fix", type: "human_approval", status: "COMPLETED", independent: false, output: { approved_scope: { required_tests: ["refund regression test"] } }, attempts: [] },
      {
        key: "implement", type: "coding_agent", status: "COMPLETED", independent: false,
        output: { commits: { svc: H }, verification: { passed: true, repairs: 1 }, scope_check: { out_of_scope_files: ["svc:app/ledger.go"], unauthorized_repos: ["other"] } },
        attempts: [{ status: "FAILED", output: null, error: "verification still failing after 2 repair(s)", metrics: { tool_repeats: { calls: 30, duplicate_calls: 9, repeated_file_reads: 3 } } }],
      },
      { key: "review", type: "agent", status: "COMPLETED", independent: true, output: { verdict: "PASS", verified_heads: { svc: H } }, attempts: [{ status: "COMPLETED", output: { verdict: "FAIL" }, error: null, metrics: null }, { status: "COMPLETED", output: { verdict: "PASS" }, error: null, metrics: null }] },
    ],
    changed_files: { svc: ["app/refund.go"] },
    usage: { cost_usd: 3, tokens: 200_000, availability: "complete" },
    handoffs: [{ status: "BLOCKED" }],
  });
  const cats = deriveOutcome(f).failure_categories.map((c) => c.category).sort();
  assert.deepEqual(cats, ["build_test_failure", "excessive_tokens", "incomplete_fix", "incorrect_business_assumption", "incorrect_confidence", "missing_regression_test", "out_of_scope_change", "provider_handoff_loss", "repeated_search", "wrong_repository"]);
  assert.deepEqual(deriveOutcome(facts()).failure_categories, [], "a clean run has no failure category");
  assert.deepEqual(deriveOutcome(facts({ token_baseline: { median: 1000, samples: 2 } })).failure_categories, [], "no token verdict on a tiny baseline");
});

test("policy versions are content-addressed and comparable; requirements are sanitized for benchmarks", () => {
  const v = executionPolicyVersions();
  for (const k of ["prompt_template", "verification", "scope", "context_retrieval", "routing", "review_rules", "outcome_rules"]) assert.ok(v[k], k);
  assert.match(v.prompt_template, /^[0-9a-f]{12}$/);
  assert.equal(policyKey(v), policyKey({ ...v }));
  assert.notEqual(policyKey(v), policyKey({ ...v, prompt_template: "000000000000" }));
  assert.equal(policyKey(null), "unversioned", "legacy runs stay comparable as one group");
  const s = sanitizeRequirement("Customer nguyen.van.a@example.com (0912345678) reports refund; token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 see https://internal.hasaki.vn/x");
  assert.doesNotMatch(s, /example\.com|0912345678|ghp_|internal\.hasaki/);
  assert.match(s, /reports refund/);
});

test("complexity: deterministic classes, history raises the class, user override wins, never a guarantee", async () => {
  const { classifyComplexity, classifyProfile } = await import("../src/workflow/profiles.ts");
  const d = (title: string, repos = ["oms-api"], declaredRisk: string | null = null) => classifyProfile({ title, description: "", project: "OMS", repositories: repos, knownRepository: null, matchingRepositories: 1, declaredRisk });
  assert.equal(classifyComplexity(d("[Bug] sai format postal code")).class, "TRIVIAL");
  assert.equal(classifyComplexity(d("Refund amount wrong for installment orders")).class, "HIGH_RISK");
  assert.equal(classifyComplexity(d("add endpoint", ["a", "b"])).class, "COMPLEX");
  assert.equal(classifyComplexity(d("add endpoint")).class, "STANDARD");
  assert.equal(classifyComplexity(d("add endpoint"), { priorFailureRuns: 2 }).class, "COMPLEX", "repeated verified failures raise the class");
  const o = classifyComplexity(d("Refund amount wrong"), { priorFailureRuns: 0 }, "standard");
  assert.deepEqual([o.class, o.source], ["STANDARD", "user_override"]);
  assert.match(o.disclaimer, /not a guarantee/);
});
