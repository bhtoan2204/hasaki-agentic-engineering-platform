import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyProfile,
  classifyProfile,
  resolveProfile,
  ProfileNotApplicable,
  type ProfileSignals,
} from "../src/workflow/profiles.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec, topoOrder } from "../src/workflow/graph.ts";

const sig = (over: Partial<ProfileSignals> = {}): ProfileSignals => ({
  title: "",
  description: "",
  project: "OMS",
  repositories: [],
  knownRepository: null,
  matchingRepositories: 0,
  ...over,
});
const tpl = (k: string) => validateSpec(TEMPLATES.find((t) => t.key === k)!.spec);

test("profile: one-field mapping bug in a known repository → FAST with reasons", () => {
  const d = classifyProfile(
    sig({
      title: "[Bug] Thiếu ZIP Code đơn Ecom US",
      description: "postal_code mapping bị mất khi Ecom gửi ZIP+4",
      knownRepository: "inside-product-worker-usa",
      matchingRepositories: 1,
    }),
  );
  assert.equal(d.profile, "FAST");
  assert.equal(d.confidence, "medium");
  assert.ok(d.reasons.some((r) => r.includes("inside-product-worker-usa")));
});

test("profile: normalization/whitespace bug in an explicitly selected repo → FAST (high confidence)", () => {
  const d = classifyProfile(
    sig({
      title: "[Bug] Tên khách hàng không được chuẩn hoá khoảng trắng",
      repositories: ["ecom-mapper"],
    }),
  );
  assert.equal(d.profile, "FAST");
  assert.equal(d.confidence, "high");
});

test("profile: short description alone is not FAST; unknown repo falls back to STANDARD", () => {
  assert.equal(classifyProfile(sig({ title: "Fix bug" })).profile, "STANDARD");
  const d = classifyProfile(sig({ title: "[Bug] Sai format postal code", description: "" }));
  assert.equal(d.profile, "STANDARD");
  assert.equal(d.confidence, "low");
  assert.ok(d.reasons.some((r) => /not known/.test(r)));
});

test("profile: payment, migration, security, distributed transactions are never FAST automatically", () => {
  for (const title of [
    "[Bug] Refund amount mapping sai",
    "[Bug] Lỗi đối soát COD field",
    "Fix migration for postal field",
    "Fix auth token field mapping",
    "[Bug] Thiếu field trong outbox event",
    "[Bug] Sai trường thanh toán",
  ]) {
    const d = classifyProfile(sig({ title, repositories: ["oms-api"] }));
    assert.notEqual(d.profile, "FAST", title);
    assert.ok(
      d.reasons.some((r) => /high-risk/.test(r)),
      title,
    );
  }
});

test("profile: multi-repo, epics and declared high risk → DEEP; manual override wins (with a warning when risky)", () => {
  assert.equal(
    classifyProfile(
      sig({ title: "[Bug] field mapping", repositories: ["oms-api", "oms-background"] }),
    ).profile,
    "DEEP",
  );
  assert.equal(classifyProfile(sig({ title: "[EPIC] Tiktok US" })).profile, "DEEP");
  assert.equal(
    classifyProfile(sig({ title: "[Bug] typo", repositories: ["oms-api"], declaredRisk: "high" }))
      .profile,
    "DEEP",
  );
  const forced = classifyProfile(sig({ title: "Refund mapping" }), "FAST");
  assert.equal(forced.profile, "FAST");
  assert.ok(forced.warnings.some((w) => /high-risk/.test(w)));
  assert.equal(
    classifyProfile(sig({ title: "[Bug] Thiếu ZIP Code", repositories: ["x"] }), "STANDARD")
      .profile,
    "STANDARD",
  );
});

test("FAST DAG: analysis folded into the coding step, plan approval and AI review removed, tests/PR kept, valid DAG", () => {
  const spec = tpl("feature-implementation");
  const { spec: fast, changes } = applyProfile(spec, "FAST");
  const keys = fast.steps.map((s) => s.key);
  assert.deepEqual(keys, [
    "discover",
    "confirm_repos",
    "implement",
    "test",
    "pr",
    "qc_merge",
    "cleanup",
  ]);
  assert.equal(new Set(keys).size, keys.length, "no duplicated steps");
  const impl = fast.steps.find((s) => s.key === "implement")!;
  assert.deepEqual(impl.config.merged_from, ["analyze", "plan"]);
  assert.match(String(impl.config.instructions), /Requirement Analysis/);
  assert.deepEqual(impl.depends_on, ["confirm_repos"]);
  assert.deepEqual(
    fast.steps.find((s) => s.key === "pr")!.depends_on,
    ["test"],
    "review removed, PR rewired to tests",
  );
  assert.equal(
    fast.steps.find((s) => s.key === "pr")!.config.mode,
    "approval",
    "PR approval preserved",
  );
  assert.equal(fast.steps.find((s) => s.key === "discover")!.config.use_ai, false);
  assert.equal(
    fast.steps.find((s) => s.key === "confirm_repos")!.config.auto_approve_unambiguous,
    true,
  );
  assert.doesNotThrow(() => validateSpec({ ...fast }));
  assert.doesNotThrow(() => topoOrder(fast.steps));
  assert.ok(changes.some((c) => c.step === "approve_plan" && c.action === "removed"));
  assert.ok(changes.some((c) => c.step === "review" && c.action === "removed"));
  assert.ok(
    !spec.steps.find((s) => s.key === "implement")!.config.merged_from,
    "published spec untouched",
  );
  const bug = applyProfile(tpl("bug-investigation"), "FAST").spec;
  assert.deepEqual(bug.steps.find((s) => s.key === "implement")!.config.merged_from, [
    "analyze",
    "root_cause",
    "fix_proposal",
  ]);
  assert.deepEqual(
    bug.steps.map((s) => s.key),
    // The deterministic Proof-of-Fix step stays (it records PARTIAL at best without an independent review).
    // Deterministic, read-only steps stay: cross-repository impact and the Proof-of-Fix verdict.
    [
      "discover",
      "confirm_repos",
      "implement",
      "regression_test",
      "impact",
      "proof",
      "pr",
      "qc_merge",
      "cleanup",
    ],
  );
  assert.deepEqual(bug.steps.find((s) => s.key === "pr")!.depends_on, ["proof"]);
});

test("FAST not applicable: no coding step, or a branch depends on a removed step → caller falls back", () => {
  assert.throws(() => applyProfile(tpl("code-review"), "FAST"), ProfileNotApplicable);
  const spec = validateSpec({
    name: "x",
    steps: [
      { key: "analyze", type: "agent" },
      {
        key: "check",
        type: "condition",
        depends_on: ["analyze"],
        config: { path: "upstream.analyze.output.risky", op: "truthy" },
      },
      { key: "implement", type: "coding_agent", depends_on: ["check"] },
    ],
  });
  assert.throws(() => applyProfile(spec, "FAST"), /reads the output/);
});

test("STANDARD is the identity; DEEP removes auto-approval and enables AI discovery", () => {
  const spec = tpl("bug-investigation");
  assert.deepEqual(
    spec.steps.find((s) => s.key === "pr")!.depends_on,
    ["proof"],
    "the PR waits for the Proof-of-Fix verdict",
  );
  assert.deepEqual(
    spec.steps.find((s) => s.key === "proof")!.depends_on,
    ["review"],
    "bug fixes are code-reviewed before the proof and the PR",
  );
  assert.equal(applyProfile(spec, "STANDARD").spec, spec);
  const deep = applyProfile(spec, "DEEP");
  assert.equal(
    deep.spec.steps.find((s) => s.key === "confirm_repos")!.config.auto_approve_unambiguous,
    undefined,
  );
  assert.ok(deep.changes.length >= 1);
  assert.equal(deep.spec.steps.length, spec.steps.length);
});

test("MICRO cannot be forced without verified scope and impact evidence", () => {
  const decision = classifyProfile(
    sig({
      title: "Fix label typo",
      repositories: ["web"],
      declaredRisk: "low",
    }),
    "MICRO",
  );
  assert.equal(decision.profile, "STANDARD");
  assert.equal(decision.requested, "MICRO");
  assert.ok(decision.reasons.some((reason) => /verified/i.test(reason)));
});

test("risk and implementation complexity remain separate and AUTO retains existing routing", () => {
  const decision = classifyProfile(sig({ title: "Fix payment label", repositories: ["web"] }));
  assert.equal(decision.signals.business_risk, "high");
  assert.equal(decision.signals.implementation_complexity, "small");
  assert.equal(decision.profile, "STANDARD");
  const short = classifyProfile(sig({ title: "Fix", repositories: ["web"] }));
  assert.equal(short.signals.business_risk, "unknown");
  assert.notEqual(short.profile, "MICRO");
});

test("profile fallback applies STANDARD independent verification to configured boundaries", () => {
  const spec = validateSpec({
    name: "Boundary",
    steps: [
      { key: "analyze", type: "agent", config: { agent: { provider: "codex" } } },
      { key: "implement", type: "coding_agent", depends_on: ["analyze"] },
      { key: "review", type: "agent", depends_on: ["implement"] },
      { key: "pr", type: "integration", depends_on: ["review"], config: { mode: "approval" } },
    ],
  });
  const decision = classifyProfile(sig({ title: "Fix typo", repositories: ["web"] }), "FAST");
  const result = resolveProfile(spec, decision);
  assert.equal(result.decision.profile, "STANDARD");
  assert.equal(result.decision.requested, "FAST");
  assert.match(result.decision.reasons.join(" "), /explicit agent configuration/);
  assert.equal(result.spec.steps.find((step) => step.key === "review")!.config.independent, true);
  assert.equal(result.spec.steps.find((step) => step.key === "pr")!.config.mode, "approval");
  assert.equal(spec.steps.find((step) => step.key === "review")!.config.independent, undefined);
});

test("MICRO declines graphs with plan approvals and mandatory independent review", () => {
  assert.throws(() => applyProfile(tpl("feature-implementation"), "MICRO"), ProfileNotApplicable);
});

test("MICRO graph folds only explicit self-review and preserves deterministic checks and PR approval", () => {
  const spec = validateSpec({
    name: "Local change",
    steps: [
      { key: "analyze", type: "agent", config: { instructions: "Find the label" } },
      { key: "plan", type: "agent", depends_on: ["analyze"] },
      {
        key: "implement",
        type: "coding_agent",
        depends_on: ["plan"],
        config: { delegation: { enabled: true } },
      },
      {
        key: "self_review",
        type: "agent",
        depends_on: ["implement"],
        config: { independent: false, instructions: "Check the label" },
      },
      {
        key: "test",
        type: "integration",
        depends_on: ["self_review"],
        config: { action: "tests" },
      },
      { key: "pr", type: "integration", depends_on: ["test"], config: { mode: "approval" } },
    ],
  });
  const result = applyProfile(spec, "MICRO");
  assert.deepEqual(
    result.spec.steps.map((step) => step.key),
    ["implement", "test", "pr"],
  );
  assert.deepEqual(result.spec.steps.find((step) => step.key === "test")!.depends_on, [
    "implement",
  ]);
  assert.equal(result.spec.steps.find((step) => step.key === "pr")!.config.mode, "approval");
  const coding = result.spec.steps.find((step) => step.key === "implement")!;
  assert.match(String(coding.config.instructions), /Check the label/);
  assert.deepEqual(coding.config.delegation, { enabled: false });
  assert.deepEqual(coding.config.merged_from, ["analyze", "plan", "self_review"]);
  assert.doesNotThrow(() => validateSpec(result.spec));
  assert.equal(spec.steps.length, 6);
});

test("MICRO refuses mandatory review, multiple coding sessions and approval boundaries", () => {
  for (const steps of [
    [
      { key: "implement", type: "coding_agent" },
      { key: "review", type: "agent", depends_on: ["implement"] },
    ],
    [
      { key: "implement", type: "coding_agent" },
      { key: "fix", type: "coding_agent", depends_on: ["implement"] },
    ],
    [
      { key: "approve", type: "human_approval" },
      { key: "implement", type: "coding_agent", depends_on: ["approve"] },
    ],
  ])
    assert.throws(
      () => applyProfile(validateSpec({ name: "Boundaries", steps }), "MICRO"),
      ProfileNotApplicable,
    );
});

test("MICRO cannot fold independent phases or discard structured output contracts", () => {
  for (const config of [{ independent: true }, { output_contract: "{ findings: [] }" }]) {
    const spec = validateSpec({
      name: "Preserve phase contract",
      steps: [
        { key: "analyze", type: "agent", config },
        { key: "implement", type: "coding_agent", depends_on: ["analyze"] },
      ],
    });
    assert.throws(() => applyProfile(spec, "MICRO"), ProfileNotApplicable);
  }
});

test("MICRO preserves consumers of a removed phase output by declining folding", () => {
  const spec = validateSpec({
    name: "Consumer",
    steps: [
      { key: "analyze", type: "agent" },
      { key: "implement", type: "coding_agent", depends_on: ["analyze"] },
      {
        key: "test",
        type: "integration",
        depends_on: ["implement"],
        config: { input: "upstream.analyze.output.command" },
      },
    ],
  });
  assert.throws(() => applyProfile(spec, "MICRO"), /reads a phase output/);
});
