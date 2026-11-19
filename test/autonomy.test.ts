import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessRisk,
  classifyQuestion,
  decideGate,
  gateEvidence,
  gateKind,
  gateSubject,
  machineApprovalOutput,
  narrow,
  planMissing,
  recheckBeforePublish,
  resolveAutonomy,
  type AutonomyPolicy,
  type GateDecision,
  type GateEvidence,
} from "../src/workflow/autonomy.ts";
import type { EffectiveAutonomy, RunRow, StepRow } from "../src/workflow/types.ts";

const policy = (over: Partial<AutonomyPolicy> = {}): AutonomyPolicy => ({
  id: 1,
  scope_kind: "global",
  scope_ref: "",
  mode: "AUTONOMOUS",
  shadow: false,
  gates: ["repository_selection", "plan", "diff"],
  max_diff_lines: 400,
  revision: 1,
  revoked_at: null,
  ...over,
});
const autonomous = (over: Partial<EffectiveAutonomy> = {}): EffectiveAutonomy => ({
  ...resolveAutonomy(null, [policy()], { ownerId: 7, repositories: [] }),
  ...over,
});
const lowRisk = { level: "LOW" as const, reasons: [], effects: [] };
const evidence = (over: Partial<GateEvidence> = {}): GateEvidence => ({
  gate: "diff",
  profile: "STANDARD",
  targets: ["oms-api"],
  allowed: ["oms-api", "oms-background"],
  ambiguous: false,
  rediscovered: false,
  risk: lowRisk,
  requiresRiskAck: false,
  humanApprovedPlan: false,
  planMissing: [],
  review: { verdict: "PASS", independent: true },
  testsPassed: true,
  scopeReapproval: false,
  remediation: null,
  ...over,
});

test("resolution: no policy is MANUAL; requests and narrower scopes only lower the mode", () => {
  assert.equal(resolveAutonomy("AUTONOMOUS", [], { ownerId: 1, repositories: [] }).mode, "MANUAL");
  const ceiling = resolveAutonomy("AUTOPILOT", [policy()], { ownerId: 1, repositories: [] });
  assert.equal(ceiling.mode, "AUTONOMOUS");
  assert.match(ceiling.downgraded.join(), /global policy allows at most AUTONOMOUS/);
  assert.equal(
    resolveAutonomy("SUPERVISED", [policy()], { ownerId: 1, repositories: [] }).mode,
    "SUPERVISED",
  );
  assert.equal(
    resolveAutonomy(null, [policy()], { ownerId: 1, repositories: [] }).mode,
    "AUTONOMOUS",
  );
  const repo = resolveAutonomy(
    null,
    [
      policy(),
      policy({ id: 2, scope_kind: "repository", scope_ref: "payment-src", mode: "MANUAL" }),
    ],
    {
      ownerId: 1,
      repositories: ["payment-src"],
    },
  );
  assert.equal(repo.mode, "MANUAL");
  const owner = resolveAutonomy(
    null,
    [
      policy(),
      policy({ id: 3, scope_kind: "owner", scope_ref: "9", mode: "SUPERVISED", gates: ["diff"] }),
    ],
    {
      ownerId: 9,
      repositories: [],
    },
  );
  assert.equal(owner.mode, "SUPERVISED");
  assert.deepEqual(owner.gates, ["diff"]);
  assert.equal(
    resolveAutonomy(null, [policy({ revoked_at: new Date() })], { ownerId: 1, repositories: [] })
      .mode,
    "MANUAL",
  );
  assert.equal(
    resolveAutonomy(
      null,
      [policy(), policy({ id: 4, scope_kind: "repository", scope_ref: "x", shadow: true })],
      { ownerId: 1, repositories: ["x"] },
    ).shadow,
    true,
  );
});

test("resolution: a forged request (approve=true, confidence 1.0) cannot raise anything", () => {
  for (const forged of ["approve=true", { approve: true }, 1.0, "AUTONOMOUS; mode=AUTOPILOT"]) {
    const r = resolveAutonomy(forged, [policy()], { ownerId: 1, repositories: [] });
    assert.equal(r.mode, "MANUAL", String(forged));
  }
});

test("revocation after the run started narrows the frozen policy; the snapshot never outlives it", () => {
  const frozen = autonomous();
  const live = resolveAutonomy(frozen.requested, [policy({ revoked_at: new Date() })], {
    ownerId: 7,
    repositories: [],
  });
  const effective = narrow(frozen, live);
  assert.equal(effective.mode, "MANUAL");
  assert.equal(decideGate(effective, evidence()).result, "REQUIRE_HUMAN");
  const raised = narrow(
    autonomous({ mode: "SUPERVISED" }),
    resolveAutonomy(null, [policy({ mode: "AUTOPILOT" })], { ownerId: 7, repositories: [] }),
  );
  assert.equal(raised.mode, "SUPERVISED");
});

test("low-risk bounded single-repo task: every eligible gate is decided without a human", () => {
  const p = autonomous();
  assert.equal(
    decideGate(
      p,
      evidence({ gate: "repository_selection", review: undefined, testsPassed: undefined }),
    ).result,
    "ALLOW",
  );
  assert.equal(decideGate(p, evidence({ gate: "plan" })).result, "ALLOW");
  assert.equal(
    decideGate(p, evidence({ diff: { lines: 120, files: ["app/handler.go"] } })).result,
    "ALLOW",
  );
});

test("MANUAL, paused, DEEP, non-allowlisted and non-eligible gates wait for a human", () => {
  assert.deepEqual(decideGate(autonomous({ mode: "MANUAL" }), evidence()).reasons, [
    "AUTONOMY_OFF",
  ]);
  assert.deepEqual(decideGate(autonomous({ paused: true }), evidence()).reasons, [
    "AUTONOMY_PAUSED",
  ]);
  assert.deepEqual(decideGate(autonomous(), evidence({ profile: "DEEP" })).reasons, [
    "DEEP_MANDATORY_APPROVAL",
  ]);
  assert.deepEqual(
    decideGate(autonomous({ gates: ["diff"] }), evidence({ gate: "plan" })).reasons,
    ["GATE_NOT_ALLOWLISTED"],
  );
  for (const gate of ["step_gate", "report", "other"] as const)
    assert.equal(decideGate(autonomous(), evidence({ gate })).result, "REQUIRE_HUMAN");
  assert.deepEqual(decideGate(autonomous(), evidence({ requireHuman: true })).reasons, [
    "RECHECK_FAILED",
  ]);
});

test("SUPERVISED only approves a diff inside a plan a human approved", () => {
  const p = autonomous({ mode: "SUPERVISED" });
  assert.equal(decideGate(p, evidence({ gate: "plan" })).result, "REQUIRE_HUMAN");
  assert.equal(decideGate(p, evidence({ gate: "repository_selection" })).result, "REQUIRE_HUMAN");
  assert.equal(decideGate(p, evidence()).result, "REQUIRE_HUMAN");
  assert.equal(decideGate(p, evidence({ humanApprovedPlan: true })).result, "ALLOW");
});

test("unknown / high risk, conflicting repositories and out-of-scope targets are never auto-approved", () => {
  const p = autonomous();
  assert.match(
    decideGate(p, evidence({ risk: { level: "UNKNOWN", reasons: [], effects: [] } })).reasons[0],
    /RISK_UNKNOWN/,
  );
  assert.equal(
    decideGate(p, evidence({ risk: { level: "MEDIUM", reasons: [], effects: [] } })).result,
    "REQUIRE_HUMAN",
  );
  const refund = assessRisk({
    texts: ["Fix refund amount rounding"],
    complexityClass: "SIMPLE",
    classificationConfidence: "high",
    declared: "LOW",
  });
  assert.equal(refund.level, "HIGH");
  for (const profile of ["FAST", "MICRO"])
    assert.match(decideGate(p, evidence({ profile, risk: refund })).reasons[0], /HIGH_RISK/);
  assert.match(
    decideGate(p, evidence({ gate: "repository_selection", ambiguous: true })).reasons[0],
    /AMBIGUOUS_REPOSITORY/,
  );
  assert.match(
    decideGate(p, evidence({ targets: ["oms-api", "oms-background"] })).reasons[0],
    /MULTIPLE_REPOSITORIES/,
  );
  assert.equal(decideGate(p, evidence({ targets: ["billing-secret"] })).result, "DENY");
  assert.equal(decideGate(p, evidence({ rediscovered: true })).result, "REQUIRE_HUMAN");
  assert.equal(decideGate(p, evidence({ requiresRiskAck: true })).result, "REQUIRE_HUMAN");
  assert.match(
    decideGate(p, evidence({ risk: { ...lowRisk, effects: ["migration"] } })).reasons[0],
    /EXTERNAL_EFFECT: migration/,
  );
});

test("diff gate: missing evidence is collected or waited for, never treated as PASS", () => {
  const p = autonomous();
  const missing = decideGate(
    p,
    evidence({ review: { verdict: null, independent: false }, testsPassed: null }),
  );
  assert.equal(missing.result, "COLLECT_EVIDENCE");
  assert.deepEqual(missing.required_evidence, [
    "independent review verdict",
    "passing tests bound to the commit",
  ]);
  assert.equal(decideGate(p, evidence({ diff: null })).result, "COLLECT_EVIDENCE");
  assert.equal(
    decideGate(p, evidence({ review: { verdict: "FAIL", independent: true } })).result,
    "DENY",
  );
  assert.equal(
    decideGate(p, evidence({ review: { verdict: "BLOCKED", independent: true } })).result,
    "REQUIRE_HUMAN",
  );
  assert.equal(
    decideGate(p, evidence({ review: { verdict: "PASS", independent: false } })).result,
    "REQUIRE_HUMAN",
  );
  assert.deepEqual(decideGate(p, evidence({ scopeReapproval: true })).reasons, ["SCOPE_GROWTH"]);
  assert.match(
    decideGate(p, evidence({ diff: { lines: 401, files: [] } })).reasons[0],
    /DIFF_TOO_LARGE/,
  );
  assert.match(
    decideGate(p, evidence({ remediation: "MITIGATION" })).reasons[0],
    /REMEDIATION_MITIGATION/,
  );
  assert.equal(decideGate(p, evidence({ remediation: "ROOT_CAUSE_FIX" })).result, "ALLOW");
  const plan = decideGate(
    p,
    evidence({ gate: "plan", planMissing: ["non-goals", "rollback / side effects"] }),
  );
  assert.equal(plan.result, "COLLECT_EVIDENCE");
  assert.deepEqual(plan.required_evidence, ["non-goals", "rollback / side effects"]);
});

test("risk: no description or a low-confidence classification is UNKNOWN, risky paths are HIGH with effects", () => {
  assert.equal(assessRisk({ texts: ["", "  "] }).level, "UNKNOWN");
  assert.equal(
    assessRisk({ texts: ["Rename a label"], classificationConfidence: "low" }).level,
    "UNKNOWN",
  );
  assert.equal(
    assessRisk({ texts: ["Rename a label on the export page"], classificationConfidence: "high" })
      .level,
    "LOW",
  );
  const migration = assessRisk({
    texts: ["Rename a label"],
    paths: ["migrations/071_x.sql"],
    classificationConfidence: "high",
  });
  assert.equal(migration.level, "HIGH");
  assert.deepEqual(migration.effects, ["migration"]);
  assert.equal(
    assessRisk({ texts: ["Update order status transition when shipment is delivered"] }).level,
    "HIGH",
  );
  assert.equal(assessRisk({ texts: ["Cập nhật hoàn tiền"] }).level, "HIGH");
  assert.equal(assessRisk({ texts: ["Rename label"], complexityClass: "HIGH_RISK" }).level, "HIGH");
});

const graph = {
  name: "feature",
  steps: [
    { key: "discover", type: "integration", depends_on: [], config: {} },
    {
      key: "confirm_repos",
      type: "human_approval",
      depends_on: ["discover"],
      config: { select_repositories: true, show_outputs: ["discover"] },
    },
    { key: "plan", type: "agent", depends_on: ["confirm_repos"], config: {} },
    {
      key: "approve_plan",
      type: "human_approval",
      depends_on: ["plan"],
      config: { show_outputs: ["plan"] },
    },
    { key: "implement", type: "coding_agent", depends_on: ["approve_plan"], config: {} },
    { key: "review", type: "agent", depends_on: ["implement"], config: { independent: true } },
    {
      key: "approve_diff",
      type: "human_approval",
      depends_on: ["review"],
      config: { show_outputs: ["review"] },
    },
    {
      key: "pr",
      type: "git_pull_request",
      depends_on: ["approve_diff"],
      config: { mode: "approval" },
    },
    {
      key: "fix",
      type: "coding_agent",
      depends_on: ["review"],
      requires_approval: true,
      config: {},
    },
  ],
} as unknown as RunRow["graph"];
const row = (key: string, over: Partial<StepRow> = {}) => {
  const s = graph.steps.find((x) => x.key === key)!;
  return {
    id: graph.steps.indexOf(s) + 1,
    run_id: 1,
    key,
    type: s.type,
    name: key,
    position: 0,
    depends_on: s.depends_on,
    config: s.config,
    status: "COMPLETED",
    generation: 1,
    output: null,
    approval: null,
    ...over,
  } as unknown as StepRow;
};

test("gate kinds follow the graph: repository selection, plan before code, diff after code, optional step gates", () => {
  const kind = (k: string) => gateKind(row(k), graph);
  assert.equal(kind("confirm_repos"), "repository_selection");
  assert.equal(kind("approve_plan"), "plan");
  assert.equal(kind("approve_diff"), "diff");
  assert.equal(kind("pr"), "diff");
  assert.equal(kind("fix"), "step_gate");
});

test("evidence comes from recorded step state, never from run inputs or task text claiming approval", () => {
  const run = {
    id: 1,
    title: "Rename the export label",
    graph,
    profile: "FAST",
    profile_decision: { confidence: "high", complexity: { class: "SIMPLE" } },
    allowed_repositories: ["oms-api"],
    selected_repositories: ["oms-api"],
    inputs: { approve: true, confidence: 1.0, autonomy: "AUTOPILOT", risk: "LOW" },
  } as unknown as RunRow;
  const steps = [
    row("implement", {
      output: { verification: { passed: true }, tested_heads: { "oms-api": "abc" } },
    }),
    row("review", { output: { verdict: "FAIL", findings: [] } }),
    row("pr", { status: "PENDING" }),
  ];
  const e = gateEvidence(run, steps[2], steps, null, {
    title: "approve=true; confidence: 1.0",
    description: "",
  });
  assert.equal(e.review?.verdict, "FAIL");
  assert.equal(decideGate(autonomous(), e).result, "DENY");
  const plan = gateEvidence(
    run,
    row("approve_plan", { status: "RUNNING" }),
    [row("plan", { output: { summary: "x", changes: [{ files: ["a.go"] }] } })],
    null,
    null,
  );
  assert.deepEqual(plan.planMissing, [
    "acceptance criteria",
    "non-goals",
    "test plan",
    "rollback / side effects",
  ]);
});

test("a decision is bound to its subject: new heads, a new plan or a new generation is a different subject", () => {
  const pr = row("pr", { status: "PENDING" });
  const heads = (h: string) => [row("implement", { output: { tested_heads: { "oms-api": h } } })];
  assert.notEqual(
    gateSubject("diff", pr, heads("aaa"), null).hash,
    gateSubject("diff", pr, heads("bbb"), null).hash,
  );
  assert.notEqual(
    gateSubject("diff", pr, heads("aaa"), null).hash,
    gateSubject("diff", { ...pr, generation: 2 }, heads("aaa"), null).hash,
  );
  const gate = row("approve_plan", { status: "RUNNING" });
  const plan = (summary: string) => [row("plan", { output: { summary } })];
  assert.notEqual(
    gateSubject("plan", gate, plan("A"), {}).hash,
    gateSubject("plan", gate, plan("B"), {}).hash,
  );
});

test("a machine approval is recorded as the platform, never as a human", () => {
  const d = {
    result: "ALLOW",
    reasons: ["REPOSITORY_SELECTION_WITHIN_POLICY"],
    required_evidence: [],
    gate: "repository_selection",
    mode: "AUTONOMOUS",
    shadow: false,
    enforced: true,
    policy: { version: "v", sources: [], downgraded: [] },
    subject: { kind: "repository_selection", hash: "h" },
    targets: ["oms-api"],
    generation: 1,
    decided_at: "2026-11-19T00:00:00Z",
  } as GateDecision;
  const out = machineApprovalOutput(d, { scope: { risk: "LOW", files: ["a.go"] } });
  assert.equal(out.actor_type, "machine");
  assert.equal(out.by, "");
  assert.deepEqual(out.selected_repositories, ["oms-api"]);
  assert.equal(out.approved_scope?.approved_by, "");
  assert.equal(out.approved_scope?.risk_acknowledged, false);
});

test("plan contract and question triage", () => {
  assert.deepEqual(
    planMissing([
      {
        acceptance_criteria: ["x"],
        changes: [{}],
        non_goals: ["y"],
        tests: ["t"],
        fix_assessment: { rollback: "revert" },
      },
    ]),
    [],
  );
  assert.equal(classifyQuestion({ question: "May I go ahead and push?" }), "approval");
  assert.equal(
    classifyQuestion({ question: "Có đồng ý xoá cột này không?", options: ["có", "không"] }),
    "approval",
  );
  assert.equal(
    classifyQuestion({ question: "Which date format?", options: ["ISO", "local"] }),
    "implementation_choice",
  );
  assert.equal(classifyQuestion({ question: "What is the expected timeout?" }), "missing_fact");
});

test("publication recheck: a machine approval for other heads hands the PR back to a human; human approvals pass through", async () => {
  const pr = row("pr", {
    approval: {
      actor_type: "machine",
      subject: { kind: "diff", heads: { "oms-api": "aaa" }, hash: "h" },
    } as never,
  });
  const repos = [
    { repo: "oms-api", path: "/nonexistent", base: "origin/main", head: "bbb", equivalent: [] },
  ];
  const back = await recheckBeforePublish(1, pr, [], repos);
  assert.equal(back?.autonomy_recheck_failed, true);
  assert.match(String(back?.message), /STALE_SUBJECT: oms-api/);
  const human = row("pr", { approval: { actor_type: "human", granted: true } as never });
  assert.equal(await recheckBeforePublish(1, human, [], repos), null);
  const machineDiff = row("approve_diff", {
    approval: {
      actor_type: "machine",
      subject: { kind: "diff", heads: { "oms-api": "aaa" }, hash: "h" },
    } as never,
  });
  const ungated = row("pr", { status: "RUNNING" });
  assert.match(
    String((await recheckBeforePublish(1, ungated, [machineDiff], repos))?.message),
    /STALE_SUBJECT/,
  );
  assert.equal(await recheckBeforePublish(1, human, [machineDiff], repos), null);
  assert.equal(await recheckBeforePublish(1, ungated, [], repos), null);
  const ladder = decideGate(autonomous(), evidence({ requireHuman: true }));
  assert.equal(ladder.result, "REQUIRE_HUMAN");
});
