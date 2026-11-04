import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceVerdict, findingsFeedback, independentUpstream, normalizeVerdict, repairTargetFor, staleVerification } from "../src/agent/independentReview.ts";
import { backoff, classifyFailure } from "../src/workflow/failures.ts";
import { applyProfile } from "../src/workflow/profiles.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec } from "../src/workflow/graph.ts";

const graph = [
  { key: "analyze", type: "agent", depends_on: [] },
  { key: "plan", type: "agent", depends_on: ["analyze"] },
  { key: "implement", type: "coding_agent", depends_on: ["plan"] },
  { key: "test", type: "command", depends_on: ["implement"] },
  { key: "lint_review", type: "agent", depends_on: ["implement"] },
  { key: "review", type: "agent", depends_on: ["test", "lint_review"] },
] as any;

test("context isolation: the verifier never sees the author's claims, only requirements and platform evidence", () => {
  const up = {
    analyze: { output: { acceptance_criteria: ["refund per shipment"] } },
    plan: { output: { steps: ["x"] } },
    implement: { output: { summary: "I am sure it works", decisions: [{ title: "skip tests" }], verification: { status: "clean", passed: true } } },
    test: { output: { results: [{ repo: "svc", passed: true }] } },
    lint_review: { output: { approved: true, summary: "LGTM" } },
  };
  const f = independentUpstream(graph, up as any);
  assert.deepEqual(Object.keys(f).sort(), ["analyze", "implement", "plan", "test"]);
  assert.equal((f.implement.output as any).summary, undefined);
  assert.equal((f.implement.output as any).decisions, undefined);
  assert.deepEqual((f.implement.output as any).verification, { status: "clean", passed: true });
  assert.deepEqual(f.test.output, up.test.output, "real test evidence kept");
  assert.equal(JSON.stringify(f).includes("I am sure it works"), false);
});

test("verdicts: structured, legacy approved mapped, malformed or unactionable never silently pass", () => {
  assert.equal(normalizeVerdict({ verdict: "pass", findings: [] }).verdict, "PASS");
  assert.equal(normalizeVerdict({ approved: false, findings: [{ severity: "high", file: "a.go", line: 3, issue: "bug" }] }).verdict, "FAIL");
  assert.equal(normalizeVerdict({ approved: true }).verdict, "PASS");
  const junk = normalizeVerdict({ summary: "looks fine" });
  assert.equal(junk.verdict, "BLOCKED", "no verdict → BLOCKED, not PASS");
  assert.equal(normalizeVerdict({ verdict: "FAIL", findings: [] }).verdict, "BLOCKED", "FAIL without findings cannot drive a repair");
  assert.equal(normalizeVerdict({ verdict: "FAIL", findings: [{ severity: "low", file: "a", explanation: "naming" }] }).verdict, "PASS", "style-only findings do not fail");
  const f = normalizeVerdict({ verdict: "FAIL", findings: [{ severity: "weird", file: "a.go", line: "12", explanation: "e", evidence: "ev" }] }).findings[0];
  assert.deepEqual(f, { severity: "medium", file: "a.go", line: 12, explanation: "e", evidence: "ev" });
});

test("enforcement: PASS completes with the judged commits; FAIL repairs within budget, then fails; BLOCKED asks", () => {
  const fail = normalizeVerdict({ verdict: "FAIL", findings: [{ severity: "high", file: "a.go", line: 1, explanation: "wrong", evidence: "x" }] });
  const pass = enforceVerdict(normalizeVerdict({ verdict: "PASS" }), { repairsUsed: 0, maxRepairs: 2, repairTarget: "implement", heads: { svc: "abc" } }) as any;
  assert.deepEqual([pass.kind, pass.output.verified_heads, pass.output.approved], ["completed", { svc: "abc" }, true]);
  const r1 = enforceVerdict(fail, { repairsUsed: 1, maxRepairs: 2, repairTarget: "implement", heads: {} }) as any;
  assert.deepEqual([r1.kind, r1.target], ["reexecute", "implement"]);
  assert.match(r1.feedback, /repair 2 of 2/);
  const done = enforceVerdict(fail, { repairsUsed: 2, maxRepairs: 2, repairTarget: "implement", heads: {} }) as any;
  assert.deepEqual([done.kind, done.retryable], ["failed", false]);
  assert.equal(enforceVerdict(fail, { repairsUsed: 0, maxRepairs: 2, repairTarget: null, heads: {} }).kind, "failed", "no coding step to repair → fail");
  const blocked = enforceVerdict(normalizeVerdict({ verdict: "BLOCKED", blocked_reason: "need spec" }), { repairsUsed: 0, maxRepairs: 2, repairTarget: "implement", heads: {} }) as any;
  assert.equal(blocked.kind, "waiting_input");
  assert.match(blocked.questions[0].question, /need spec/);
  assert.match(findingsFeedback(fail, 1, 2), /a\.go:1 — wrong\n   evidence: x/);
});

test("stale verification: any commit after the PASS blocks the PR; unverified repos are not invented", () => {
  assert.deepEqual(staleVerification({ svc: "abc", api: "def" }, { svc: "abc", api: "999" }), ["api"]);
  assert.deepEqual(staleVerification({ svc: "abc" }, { svc: "abc", other: "x" }), []);
  assert.deepEqual(staleVerification(undefined, { svc: "abc" }), []);
});

test("repair target: feedback_step, else the nearest coding step upstream", () => {
  assert.equal(repairTargetFor({ feedback_step: "fix", steps: graph }, "review"), "fix");
  assert.equal(repairTargetFor({ steps: graph }, "review"), "implement");
  assert.equal(repairTargetFor({ steps: graph }, "plan"), null);
});

test("failure classification: policy per class, bounded backoff", () => {
  const c = (e: string, over: Partial<Parameters<typeof classifyFailure>[1]> = {}) => classifyFailure(e, { executorRetryable: true, attempt: 1, maxAttempts: 3, baseBackoff: 5, ...over });
  assert.deepEqual([c("HTTP 403 Forbidden").class, c("HTTP 403 Forbidden").action], ["auth", "stop"]);
  assert.deepEqual([c("429 Too Many Requests").class, c("429 Too Many Requests").action, c("429 Too Many Requests").delay_s], ["rate_limit", "retry", 30]);
  assert.equal(c("overloaded_error", { attempt: 3, maxAttempts: 3 }).action, "stop", "rate-limit retries are bounded too");
  assert.deepEqual([c("fetch failed: ECONNRESET").class, c("fetch failed: ECONNRESET", { attempt: 2 }).delay_s], ["transient", 10]);
  assert.equal(c("ECONNRESET", { attempt: 3 }).action, "stop", "budget exhausted");
  assert.deepEqual([c("push rejected (non-fast-forward)").class, c("CONFLICT (content): merge conflict in a.go").action], ["workspace", "human"]);
  assert.deepEqual([c("missing requirement: refund rule").action, c("verification made no progress (same failures twice)").class], ["human", "no_progress"]);
  assert.deepEqual([c("tests failed in svc").class, c("tests failed in svc", { executorRetryable: false }).action], ["code", "stop"]);
  assert.equal(c("something odd").class, "unknown");
  assert.equal(backoff(5, 10), 900, "capped");
});

test("profiles: STANDARD makes reviews independent (opt-out respected), DEEP requires it strictly, FAST still drops reviews", () => {
  const fi = validateSpec(TEMPLATES.find((t) => t.key === "feature-implementation")!.spec);
  const std = applyProfile(fi, "STANDARD");
  assert.equal(std.spec.steps.find((s) => s.key === "review")!.config.independent, true);
  assert.equal(std.spec.steps.find((s) => s.key === "plan")!.config.independent, undefined, "pre-implementation agents untouched");
  const optOut = applyProfile({ ...fi, steps: fi.steps.map((s) => (s.key === "review" ? { ...s, config: { ...s.config, independent: false } } : s)) }, "STANDARD");
  assert.equal(optOut.spec.steps.find((s) => s.key === "review")!.config.independent, false);
  const deep = applyProfile(fi, "DEEP");
  const r = deep.spec.steps.find((s) => s.key === "review")!.config;
  assert.deepEqual([r.independent, r.strict], [true, true]);
  assert.ok(deep.changes.some((x) => x.step === "review" && /required/.test(x.detail)));
  assert.equal(applyProfile(fi, "FAST").spec.steps.some((s) => s.key === "review"), false);
  assert.equal(fi.steps.find((s) => s.key === "review")!.config.independent, undefined, "the stored definition is not mutated");
});

test("model routing: step config > profile/role routing > '*' > global default; verifiers route separately", async () => {
  const { config } = await import("../src/config.ts");
  const { modelFor } = await import("../src/agent/claude.ts");
  const saved = { models: config.agent.models, model: config.model };
  try {
    config.agent.models = { FAST: { agent: "m-fast-agent" }, DEEP: { verifier: "m-deep-verifier" }, "*": { coding_agent: "m-any-coding" } };
    config.model = "m-global";
    assert.deepEqual(modelFor({ type: "agent", config: { model: "m-step" } }, "FAST"), { model: "m-step", source: "step config" });
    assert.deepEqual(modelFor({ type: "agent", config: {} }, "FAST"), { model: "m-fast-agent", source: "routing FAST/agent" });
    assert.deepEqual(modelFor({ type: "agent", config: { independent: true } }, "DEEP"), { model: "m-deep-verifier", source: "routing DEEP/verifier" });
    assert.deepEqual(modelFor({ type: "coding_agent", config: {} }, "STANDARD"), { model: "m-any-coding", source: "routing */coding_agent" });
    assert.deepEqual(modelFor({ type: "agent", config: {} }, "STANDARD"), { model: "m-global", source: "global default" });
    config.model = undefined as any;
    config.agent.models = undefined;
    assert.deepEqual(modelFor({ type: "agent", config: {} }, null), { model: "", source: "sdk default" });
  } finally {
    config.agent.models = saved.models;
    config.model = saved.model;
  }
});
