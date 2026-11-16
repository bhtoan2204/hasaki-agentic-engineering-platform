import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type PolicyContext } from "../src/agent/toolPolicy.ts";
import { planProfileTransition } from "../src/workflow/profileTransitions.ts";
import { validateSpec } from "../src/workflow/graph.ts";

test("MICRO profile denies subagents (Task, Agent) and arbitrary shell execution", () => {
  const policy: PolicyContext = {
    mode: "coding",
    baseBranch: "main",
    workspaces: ["/wt/repo"],
    micro: { files: ["src/button.ts"], calls: 0, limit: 10, exhausted: false },
  };

  // Deny Task and Agent subagents
  assert.equal(decide("Task", {}, policy).allow, false);
  assert.equal(decide("Agent", {}, policy).allow, false);

  // Deny Bash / shell execution
  const bashDecision = decide("Bash", { command: "ls -la" }, policy);
  assert.equal(bashDecision.allow, false);
  assert.ok(bashDecision.reason?.includes("MICRO shell execution has uncertain write scope"));
});

test("MICRO profile strictly restricts file edits to approved leaf files", () => {
  const policy: PolicyContext = {
    mode: "coding",
    baseBranch: "main",
    workspaces: ["/wt/repo"],
    micro: { files: ["src/button.ts"], calls: 0, limit: 10, exhausted: false },
  };

  // Editing approved leaf file is allowed
  assert.equal(decide("Write", { file_path: "/wt/repo/src/button.ts" }, policy).allow, true);
  assert.equal(decide("Edit", { file_path: "/wt/repo/src/button.ts" }, policy).allow, true);

  // Editing outside approved file is blocked and exhausts micro scope
  const unapprovedEdit = decide("Write", { file_path: "/wt/repo/src/database.ts" }, policy);
  assert.equal(unapprovedEdit.allow, false);
  assert.ok(unapprovedEdit.reason?.includes("edit exceeds verified MICRO file scope"));
  assert.equal(policy.micro?.exhausted, true);
});

test("MICRO escalation preserves completed side effects and restores mandatory review gates", () => {
  const original = validateSpec({
    name: "micro-workflow",
    steps: [
      { key: "analyze", type: "agent" },
      { key: "implement", type: "coding_agent", depends_on: ["analyze"] },
      { key: "review", type: "agent", depends_on: ["implement"] },
      { key: "pr", type: "git_pull_request", depends_on: ["review"], config: { mode: "approval" } },
    ],
  });

  const transition = planProfileTransition({
    original,
    current: original,
    from: "MICRO",
    target: "STANDARD",
    reason: "changes touch non-leaf files",
    revision: 1,
    expectedRevision: 1,
    activeKey: "implement",
    completed: ["analyze"],
    running: [],
    risk: "medium",
  });

  assert.equal(transition.to, "STANDARD");
  // Completed step analyze is retained
  assert.deepEqual(transition.retained, ["analyze"]);
  // Review gate is restored as independent review
  const reviewStep = transition.graph.steps.find((s) => s.key === "review");
  assert.ok(reviewStep);
  assert.equal(reviewStep?.config?.independent, true);
  // PR step is retained
  const prStep = transition.graph.steps.find((s) => s.key === "pr");
  assert.ok(prStep);
  assert.equal(prStep?.config?.mode, "approval");
});
