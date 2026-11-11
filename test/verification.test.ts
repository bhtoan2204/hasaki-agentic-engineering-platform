import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceVerdict,
  findingsFeedback,
  independentUpstream,
  normalizeVerdict,
  repairTargetFor,
  staleVerification,
  verificationGate,
} from "../src/agent/independentReview.ts";
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
    implement: {
      output: {
        summary: "I am sure it works",
        decisions: [{ title: "skip tests" }],
        verification: { status: "clean", passed: true },
      },
    },
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
  assert.equal(
    normalizeVerdict({
      approved: false,
      findings: [
        {
          severity: "high",
          file: "a.go",
          line: 3,
          issue: "bug",
          suggestion: "correct the validation",
        },
      ],
    }).verdict,
    "FAIL",
  );
  assert.equal(normalizeVerdict({ approved: true }).verdict, "PASS");
  const junk = normalizeVerdict({ summary: "looks fine" });
  assert.equal(junk.verdict, "BLOCKED", "no verdict → BLOCKED, not PASS");
  assert.equal(
    normalizeVerdict({ verdict: "FAIL", findings: [] }).verdict,
    "BLOCKED",
    "FAIL without findings cannot drive a repair",
  );
  const f = normalizeVerdict({
    verdict: "FAIL",
    findings: [{ severity: "weird", file: "a.go", line: "12", explanation: "e", evidence: "ev" }],
  }).findings[0];
  assert.deepEqual(
    f,
    { severity: "medium", file: "a.go", line: 12, explanation: "e", evidence: "ev" },
    "unknown severity is treated as medium, not low",
  );
});

test("verdicts: a FAIL is never converted into a PASS; low-severity-only findings have explicit handling", () => {
  const lowFail = normalizeVerdict({
    verdict: "FAIL",
    findings: [
      {
        severity: "low",
        file: "a.go",
        line: 4,
        explanation: "naming",
        evidence: "the exported name does not match the package convention",
      },
    ],
  });
  assert.equal(
    lowFail.verdict,
    "FAIL",
    "the verifier's FAIL stands even when every finding is low",
  );
  assert.match(
    findingsFeedback(lowFail, 1, 2),
    /\[low\] a\.go:4 — naming/,
    "low-only FAIL repair feedback lists those findings (not an empty request)",
  );
  const lowPass = normalizeVerdict({
    verdict: "PASS",
    findings: [{ severity: "low", file: "a.go", explanation: "nit" }],
  });
  assert.deepEqual(
    [lowPass.verdict, lowPass.findings.length],
    ["PASS", 1],
    "PASS with low findings: advisory notes kept",
  );
  for (const v of ["FAIL", "fail", "BLOCKED"])
    assert.notEqual(
      normalizeVerdict({ verdict: v, findings: [{ severity: "low", file: "x" }] }).verdict,
      "PASS",
    );
  assert.equal(
    normalizeVerdict({
      verdict: "FAIL",
      findings: [{ severity: "high", file: "a.go", issue: "bug" }],
    }).verdict,
    "BLOCKED",
    "findings without evidence or a repair suggestion cannot trigger code changes",
  );
});

test("verdicts: malformed or contradictory verifier output is BLOCKED, never success", () => {
  const cases: Array<[any, RegExp]> = [
    [
      {
        verdict: "PASS",
        findings: [{ severity: "high", file: "a.go", explanation: "sql injection" }],
      },
      /PASS with 1 high\/medium/,
    ],
    [{ verdict: "PASS", findings: [{ severity: "??", file: "a.go" }] }, /PASS with 1 high\/medium/],
    [{ verdict: "PASS", approved: false }, /contradictory/],
    [
      { verdict: "FAIL", approved: true, findings: [{ severity: "high", file: "a" }] },
      /contradictory/,
    ],
    [{ verdict: "LGTM", approved: true }, /unknown verdict/],
    [{ verdict: true }, /unknown verdict/],
    [{ verdict: "PASS", findings: "none" }, /malformed findings/],
    [{ verdict: "PASS", findings: { a: 1 } }, /malformed findings/],
    [null, /no PASS\/FAIL\/BLOCKED/],
    ["PASS", /no PASS\/FAIL\/BLOCKED/],
    [[{ verdict: "PASS" }], /no PASS\/FAIL\/BLOCKED/],
    [{ verdict: "BLOCKED" }, /could not decide/],
  ];
  for (const [raw, reason] of cases) {
    const v = normalizeVerdict(raw);
    assert.equal(v.verdict, "BLOCKED", JSON.stringify(raw));
    assert.match(String(v.blocked_reason), reason, JSON.stringify(raw));
    assert.notEqual(
      enforceVerdict(v, {
        repairsUsed: 0,
        maxRepairs: 2,
        repairTarget: "implement",
        heads: { svc: "abc" },
      }).kind,
      "completed",
    );
  }
});

test("enforcement: PASS completes with the judged commits; FAIL repairs within budget, then fails; BLOCKED asks", () => {
  const fail = normalizeVerdict({
    verdict: "FAIL",
    findings: [{ severity: "high", file: "a.go", line: 1, explanation: "wrong", evidence: "x" }],
  });
  const pass = enforceVerdict(normalizeVerdict({ verdict: "PASS" }), {
    repairsUsed: 0,
    maxRepairs: 2,
    repairTarget: "implement",
    heads: { svc: "abc" },
  }) as any;
  assert.deepEqual(
    [pass.kind, pass.output.verified_heads, pass.output.approved],
    ["completed", { svc: "abc" }, true],
  );
  const r1 = enforceVerdict(fail, {
    repairsUsed: 1,
    maxRepairs: 2,
    repairTarget: "implement",
    heads: {},
  }) as any;
  assert.deepEqual([r1.kind, r1.target], ["reexecute", "implement"]);
  assert.match(r1.feedback, /repair 2 of 2/);
  const done = enforceVerdict(fail, {
    repairsUsed: 2,
    maxRepairs: 2,
    repairTarget: "implement",
    heads: {},
  }) as any;
  assert.deepEqual([done.kind, done.retryable], ["failed", false]);
  assert.equal(
    enforceVerdict(fail, { repairsUsed: 0, maxRepairs: 2, repairTarget: null, heads: {} }).kind,
    "failed",
    "no coding step to repair → fail",
  );
  const blocked = enforceVerdict(
    normalizeVerdict({ verdict: "BLOCKED", blocked_reason: "need spec" }),
    { repairsUsed: 0, maxRepairs: 2, repairTarget: "implement", heads: {} },
  ) as any;
  assert.equal(blocked.kind, "waiting_input");
  assert.match(blocked.questions[0].question, /need spec/);
  assert.match(findingsFeedback(fail, 1, 2), /a\.go:1 — wrong\n   evidence: x/);
});

test("stale verification: any commit after the PASS, or a repo the PASS never judged, is stale", () => {
  assert.deepEqual(staleVerification({ svc: "abc", api: "def" }, { svc: "abc", api: "999" }), [
    "api",
  ]);
  assert.deepEqual(
    staleVerification({ svc: "abc" }, { svc: "abc", other: "x" }),
    ["other"],
    "an unverified repo is not covered",
  );
  assert.deepEqual(
    staleVerification(undefined, { svc: "abc" }),
    ["svc"],
    "no verified commits → nothing is covered",
  );
  assert.deepEqual(
    staleVerification({ svc: "abc" }, { svc: "" }),
    ["svc"],
    "unreadable current commit is never treated as matching",
  );
  assert.deepEqual(
    staleVerification({ svc: "abc", gone: "x" }, { svc: "abc" }),
    [],
    "verified repos that publish nothing are fine",
  );
});

test("PR gate: every required verifier needs a valid PASS bound to the exact, clean commits of every published repo", () => {
  const pass = (heads: Record<string, string>, over: Record<string, unknown> = {}) => ({
    key: "review",
    status: "COMPLETED",
    output: { verdict: "PASS", approved: true, independent: true, verified_heads: heads, ...over },
  });
  const clean = (sha: string) => ({ head: sha, branchTip: sha, dirty: "" });
  assert.deepEqual(
    verificationGate([], { svc: clean("a") }),
    [],
    "no independent step → verification optional, gate open",
  );
  assert.deepEqual(
    verificationGate([pass({ svc: "a", api: "b" })], { svc: clean("a"), api: clean("b") }),
    [],
  );
  const g = (v: any[], p: any) => verificationGate(v, p).join(" | ");
  assert.match(
    g([pass({ svc: "a" })], { svc: clean("b") }),
    /svc: changed after independent verification "review" \(verified a, now b\)/,
  );
  assert.match(
    g([pass({ svc: "a" })], { svc: clean("a"), api: clean("b") }),
    /api: not covered/,
    "every published repo must be verified",
  );
  assert.match(
    g([pass({ svc: "a" })], { svc: { head: "a", branchTip: "a", dirty: " M x.go" } }),
    /uncommitted changes/,
  );
  assert.match(
    g([pass({ svc: "a" })], { svc: { head: "a", branchTip: "c", dirty: "" } }),
    /not the tip of the pushed branch/,
  );
  assert.match(
    g([pass({ svc: "a" })], { svc: { head: "", branchTip: "", dirty: "" } }),
    /cannot read the commit/,
  );
  assert.match(g([pass({})], { svc: clean("a") }), /svc: not covered/);
  assert.match(
    g([pass({ svc: "a" }, { verified_heads: undefined })], { svc: clean("a") }),
    /recorded no verified commits/,
  );
  for (const bad of [
    { key: "review", status: "SKIPPED", output: { skipped: true } },
    { key: "review", status: "FAILED", output: { verdict: "FAIL", independent: true } },
    { key: "review", status: "WAITING_INPUT", output: { verdict: "BLOCKED", independent: true } },
    { key: "review", status: "PENDING", output: null },
    pass({ svc: "a" }, { approved: false }),
    pass({ svc: "a" }, { independent: undefined }),
    { key: "review", status: "COMPLETED", output: { approved: true, findings: [] } }, // legacy non-independent output
  ])
    assert.match(g([bad], { svc: clean("a") }), /has no valid PASS/, JSON.stringify(bad));
  assert.match(
    g([pass({ svc: "a" }), { key: "audit", status: "SKIPPED", output: {} }], { svc: clean("a") }),
    /"audit" has no valid PASS/,
    "every required verifier counts",
  );
});

test("repair target: feedback_step, else the nearest coding step upstream", () => {
  assert.equal(repairTargetFor({ feedback_step: "fix", steps: graph }, "review"), "fix");
  assert.equal(repairTargetFor({ steps: graph }, "review"), "implement");
  assert.equal(repairTargetFor({ steps: graph }, "plan"), null);
});

test("failure classification: policy per class, bounded backoff", () => {
  const c = (e: string, over: Partial<Parameters<typeof classifyFailure>[1]> = {}) =>
    classifyFailure(e, {
      executorRetryable: true,
      attempt: 1,
      maxAttempts: 3,
      baseBackoff: 5,
      ...over,
    });
  assert.deepEqual(
    [c("HTTP 403 Forbidden").class, c("HTTP 403 Forbidden").action],
    ["auth", "stop"],
  );
  assert.deepEqual(
    [
      c("429 Too Many Requests").class,
      c("429 Too Many Requests").action,
      c("429 Too Many Requests").delay_s,
    ],
    ["rate_limit", "retry", 30],
  );
  assert.equal(
    c("overloaded_error", { attempt: 3, maxAttempts: 3 }).action,
    "stop",
    "rate-limit retries are bounded too",
  );
  assert.deepEqual(
    [c("fetch failed: ECONNRESET").class, c("fetch failed: ECONNRESET", { attempt: 2 }).delay_s],
    ["transient", 10],
  );
  assert.equal(c("ECONNRESET", { attempt: 3 }).action, "stop", "budget exhausted");
  assert.deepEqual(
    [
      c("push rejected (non-fast-forward)").class,
      c("CONFLICT (content): merge conflict in a.go").action,
    ],
    ["workspace", "human"],
  );
  assert.deepEqual(
    [
      c("missing requirement: refund rule").action,
      c("verification made no progress (same failures twice)").class,
    ],
    ["human", "no_progress"],
  );
  assert.deepEqual(
    [c("tests failed in svc").class, c("tests failed in svc", { executorRetryable: false }).action],
    ["code", "stop"],
  );
  assert.equal(c("something odd").class, "unknown");
  assert.equal(backoff(5, 10), 900, "capped");
});

test("profiles: STANDARD makes reviews independent (opt-out respected), DEEP requires it strictly, FAST still drops reviews", () => {
  const fi = validateSpec(TEMPLATES.find((t) => t.key === "feature-implementation")!.spec);
  const std = applyProfile(fi, "STANDARD");
  assert.equal(std.spec.steps.find((s) => s.key === "review")!.config.independent, true);
  assert.equal(
    std.spec.steps.find((s) => s.key === "plan")!.config.independent,
    undefined,
    "pre-implementation agents untouched",
  );
  const optOut = applyProfile(
    {
      ...fi,
      steps: fi.steps.map((s) =>
        s.key === "review" ? { ...s, config: { ...s.config, independent: false } } : s,
      ),
    },
    "STANDARD",
  );
  assert.equal(optOut.spec.steps.find((s) => s.key === "review")!.config.independent, false);
  const deep = applyProfile(fi, "DEEP");
  const r = deep.spec.steps.find((s) => s.key === "review")!.config;
  assert.deepEqual([r.independent, r.strict], [true, true]);
  assert.ok(deep.changes.some((x) => x.step === "review" && /required/.test(x.detail)));
  assert.equal(
    applyProfile(fi, "FAST").spec.steps.some((s) => s.key === "review"),
    false,
  );
  assert.equal(
    fi.steps.find((s) => s.key === "review")!.config.independent,
    true,
    "profile application leaves the explicitly published setting unchanged",
  );
});

test("published feature and bug templates enable a bounded independent review repair loop; review-only templates stay read-only", () => {
  const feature = validateSpec(TEMPLATES.find((t) => t.key === "feature-implementation")!.spec);
  const review = feature.steps.find((s) => s.key === "review")!;
  assert.equal(review.config.independent, true);
  assert.equal(review.config.max_repairs, 2);
  assert.equal(feature.feedback_step, "implement");

  // Bug fixes get the same bounded review → repair loop as features before the PR.
  const bug = validateSpec(TEMPLATES.find((t) => t.key === "bug-investigation")!.spec);
  const bugReview = bug.steps.find((s) => s.key === "review")!;
  assert.equal(bugReview.config.independent, true);
  assert.equal(bugReview.config.max_repairs, 2);
  assert.deepEqual(bugReview.depends_on, ["regression_test"]);
  assert.equal(bug.feedback_step, "implement");

  for (const key of ["refactoring", "code-review"]) {
    const spec = validateSpec(TEMPLATES.find((t) => t.key === key)!.spec);
    const verifiers = spec.steps.filter((s) => s.config.independent === true);
    assert.deepEqual(verifiers, [], `${key} must not get an implicit repair loop`);
  }
  const codeReview = validateSpec(TEMPLATES.find((t) => t.key === "code-review")!.spec);
  assert.ok(
    codeReview.steps.some((s) => s.type === "human_approval"),
    "code-review fixes remain behind explicit approval",
  );
});

test("model routing: step config > profile/role routing > '*' > global default; verifiers route separately", async () => {
  const { config } = await import("../src/config.ts");
  const { modelFor } = await import("../src/agent/claude.ts");
  const saved = { models: config.agent.models, model: config.model };
  try {
    config.agent.models = {
      FAST: { agent: "m-fast-agent" },
      DEEP: { verifier: "m-deep-verifier" },
      "*": { coding_agent: "m-any-coding" },
    };
    config.model = "m-global";
    assert.deepEqual(modelFor({ type: "agent", config: { model: "m-step" } }, "FAST"), {
      model: "m-step",
      source: "step config",
    });
    assert.deepEqual(modelFor({ type: "agent", config: {} }, "FAST"), {
      model: "m-fast-agent",
      source: "routing FAST/agent",
    });
    assert.deepEqual(modelFor({ type: "agent", config: { independent: true } }, "DEEP"), {
      model: "m-deep-verifier",
      source: "routing DEEP/verifier",
    });
    assert.deepEqual(modelFor({ type: "coding_agent", config: {} }, "STANDARD"), {
      model: "m-any-coding",
      source: "routing */coding_agent",
    });
    assert.deepEqual(modelFor({ type: "agent", config: {} }, "STANDARD"), {
      model: "m-global",
      source: "global default",
    });
    config.model = undefined as any;
    config.agent.models = undefined;
    assert.deepEqual(modelFor({ type: "agent", config: {} }, null), {
      model: "",
      source: "sdk default",
    });
  } finally {
    config.agent.models = saved.models;
    config.model = saved.model;
  }
});
