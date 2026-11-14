import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProfile, type ProfileSignals } from "../src/workflow/profiles.ts";
import { planProfileTransition } from "../src/workflow/profileTransitions.ts";
import { selectVerificationScope } from "../src/agent/verificationScope.ts";
import { validateSpec } from "../src/workflow/graph.ts";
const evidence = {
  revision: "abc",
  indexRevision: "abc",
  files: ["src/label.ts"],
  impactKnown: true,
  priorFailureRuns: 0,
};
const signals: ProfileSignals = {
  title: "Fix label typo",
  description: "",
  project: "",
  repositories: ["web"],
  knownRepository: "web",
  matchingRepositories: 1,
  declaredRisk: "low",
  evidence,
};
test("verified leaf scope admits MICRO automatically and manually; risk and stale evidence cannot", () => {
  assert.equal(classifyProfile(signals).profile, "MICRO");
  assert.equal(classifyProfile(signals, "MICRO").profile, "MICRO");
  for (const patch of [
    { declaredRisk: "high" },
    { declaredRisk: "medium" },
    { evidence: { ...evidence, impactKnown: false } },
    { evidence: { ...evidence, indexRevision: "old" } },
    { evidence: { ...evidence, priorFailureRuns: 2 } },
  ])
    assert.notEqual(classifyProfile({ ...signals, ...patch }, "MICRO").profile, "MICRO");
});
test("MICRO escalation preserves completed side effects and restores pending mandatory gates", () => {
  const original = validateSpec({
    name: "change",
    steps: [
      { key: "discover", type: "integration" },
      { key: "analyze", type: "agent", depends_on: ["discover"] },
      { key: "implement", type: "coding_agent", depends_on: ["analyze"] },
      { key: "review", type: "agent", depends_on: ["implement"] },
      { key: "pr", type: "git_pull_request", depends_on: ["review"], config: { mode: "approval" } },
    ],
  });
  const plan = planProfileTransition({
    original,
    from: "MICRO",
    target: "STANDARD",
    reason: "impact uncertain",
    revision: 1,
    expectedRevision: 1,
    current: original,
    activeKey: "implement",
    completed: ["discover"],
    running: [],
    risk: "unknown",
  });
  assert.equal(plan.to, "STANDARD");
  assert.deepEqual(original.steps.find((step) => step.key === "implement")!.depends_on, [
    "analyze",
  ]);
  assert.deepEqual(plan.graph.steps.find((step) => step.key === "implement")!.depends_on, [
    "approve_profile_scope",
  ]);
  assert.equal(
    plan.graph.steps.find((step) => step.key === "approve_profile_scope")!.config.require_scope,
    true,
  );
  assert.deepEqual(plan.retained, ["discover"]);
  assert.equal(plan.graph.steps.find((s) => s.key === "review")!.config.independent, true);
  assert.equal(plan.graph.steps.find((s) => s.key === "pr")!.config.mode, "approval");
  assert.throws(
    () =>
      planProfileTransition({
        original,
        current: original,
        from: "MICRO",
        target: "FAST",
        reason: "scope",
        revision: 2,
        expectedRevision: 1,
        activeKey: "implement",
        completed: [],
        running: [],
        risk: "low",
      }),
    /stale/,
  );
});
test("unknown impact broadens verification and never drops the mandatory check", () => {
  const known = selectVerificationScope({
    files: ["src/label.ts"],
    approvedFiles: ["src/label.ts"],
    impactKnown: true,
    risk: "low",
    mandatory: "mandatory",
    targeted: "targeted",
    broad: "broad",
  });
  assert.deepEqual(known.commands, ["mandatory", "targeted"]);
  assert.equal(known.escalate, false);
  const unknown = selectVerificationScope({
    files: ["src/auth.ts"],
    approvedFiles: ["src/auth.ts"],
    impactKnown: false,
    risk: "high",
    mandatory: "mandatory",
    targeted: "targeted",
    broad: "broad",
  });
  assert.deepEqual(unknown.commands, ["mandatory", "broad"]);
  assert.equal(unknown.escalate, true);
});

import { decide } from "../src/agent/toolPolicy.ts";
import { resolveStepAgent } from "../src/agent/stepAgent.ts";
test("MICRO cannot broaden file scope through native edits or shell and ignores step profile overrides", () => {
  const policy = {
    mode: "coding" as const,
    baseBranch: "main",
    workspaces: ["/wt/repo"],
    delegation: true,
    micro: { files: ["src/label.ts"], calls: 0, limit: 20, exhausted: false },
  };
  assert.equal(decide("Write", { file_path: "/wt/repo/src/other.ts" }, policy).allow, false);
  assert.equal(
    decide("Bash", { command: "echo changed > /wt/repo/src/other.ts" }, policy).allow,
    false,
  );
  assert.equal(decide("Agent", {}, policy).allow, false);
  const effective = resolveStepAgent(
    { profile: "MICRO", agent_provider: "codex" },
    {
      type: "coding_agent",
      config: { agent: { execution_profile: "DEEP", context_tokens: 3000, timeout_ms: 2000 } },
    },
  )!;
  assert.equal(effective.execution_profile, "MICRO");
  assert.equal(effective.context_tokens, 3000);
  assert.equal(effective.timeout_ms, 2000);
});

import { classifyWithFallback } from "../src/workflow/profiles.ts";
test("one lightweight decision can resolve complexity uncertainty but cannot clear missing impact or risk", async () => {
  let calls = 0;
  const uncertain = {
    ...signals,
    title: "Update component",
    evidence: { ...evidence, files: ["src/component.ts"] },
  };
  const decide = async () => {
    calls++;
    return {
      text: JSON.stringify({
        implementationComplexity: "small",
        businessRisk: "low",
        confidence: 0.95,
        reasons: ["bounded leaf"],
      }),
      metrics: {},
    };
  };
  assert.equal((await classifyWithFallback(uncertain, "AUTO", decide)).profile, "MICRO");
  assert.equal(calls, 1);
  assert.notEqual(
    (await classifyWithFallback({ ...uncertain, evidence: undefined }, "MICRO", decide)).profile,
    "MICRO",
  );
  assert.equal(calls, 1);
  assert.notEqual(
    (
      await classifyWithFallback(uncertain, "AUTO", async () => ({
        text: "malformed",
        metrics: {},
      }))
    ).profile,
    "MICRO",
  );
});

test("MICRO budget decisions deny further execution and stricter provider limits remain authoritative", () => {
  const policy = {
    mode: "coding" as const,
    baseBranch: "main",
    workspaces: ["/wt/repo"],
    micro: { files: ["src/label.ts"], calls: 0, limit: 1, exhausted: false },
  };
  assert.equal(decide("Read", { file_path: "/wt/repo/src/label.ts" }, policy).allow, true);
  assert.equal(decide("Write", { file_path: "/wt/repo/src/label.ts" }, policy).allow, false);
  assert.equal(policy.micro.exhausted, true);
  const effective = resolveStepAgent(
    { profile: "MICRO", agent_provider: "codex" },
    { type: "coding_agent", config: { agent: { context_tokens: 64000, timeout_ms: 86400000 } } },
  )!;
  assert.equal(effective.context_tokens, 12000);
  assert.equal(effective.timeout_ms, 600000);
});
