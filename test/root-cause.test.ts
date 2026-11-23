import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceRootCauseReview,
  normalizeRemediation,
  policyRole,
  rootCauseDepth,
  rootCausePolicy,
  signalAccepted,
  symptomFixSignals,
} from "../src/agent/rootCause.ts";
import { evidenceSummary } from "../src/agent/evidence.ts";
import { independentUpstream, type VerdictOutput } from "../src/agent/independentReview.ts";

const featureGraph = {
  steps: [{ key: "implement", type: "coding_agent", depends_on: [], config: {} }],
};
const bugGraph = {
  steps: [
    { key: "root_cause", type: "agent", depends_on: [], config: { evidence: "root_cause" } },
    { key: "implement", type: "coding_agent", depends_on: ["root_cause"], config: {} },
  ],
};
const run = (over: Record<string, unknown>) =>
  ({
    graph: featureGraph,
    inputs: {},
    title: "Add export button",
    profile: "STANDARD",
    ...over,
  }) as never;

test("depth: features are light, defect workflows standard, payment/concurrency/security strict, pinning wins", () => {
  assert.equal(rootCauseDepth(run({})), "light");
  assert.equal(
    rootCauseDepth(run({ graph: bugGraph, title: "Order list shows wrong date" })),
    "standard",
  );
  assert.equal(rootCauseDepth(run({ graph: bugGraph, title: "Refund created twice" })), "strict");
  assert.equal(
    rootCauseDepth(run({ inputs: { investigation: {} }, title: "Lỗi hoàn tiền" })),
    "strict",
  );
  assert.equal(rootCauseDepth(run({ graph: bugGraph, profile: "MICRO" })), "light");
  assert.equal(
    rootCauseDepth(run({ graph: bugGraph }), { config: { root_cause_depth: "light" } } as never),
    "light",
  );
});

test("policy: one source per role and depth; light adds guardrails only; no RCA for feature planning", () => {
  assert.equal(policyRole("coding", {}), "implement");
  assert.equal(policyRole("analysis", { independent: true }), "review");
  assert.equal(policyRole("analysis", { evidence: "root_cause" }), "investigate");
  assert.equal(policyRole("analysis", {}), null);
  assert.deepEqual(rootCausePolicy("light", "investigate"), []);
  assert.deepEqual(rootCausePolicy("strict", null), []);
  const light = rootCausePolicy("light", "implement").join("\n");
  assert.match(light, /lowering a log level/);
  assert.doesNotMatch(light, /remediation:/);
  assert.match(rootCausePolicy("standard", "investigate").join("\n"), /rca: \{ symptom/);
  assert.match(rootCausePolicy("standard", "implement").join("\n"), /remediation: \{ kind/);
  assert.match(
    rootCausePolicy("standard", "review").join("\n"),
    /root_cause_check: \{ remediation_kind/,
  );
  assert.match(rootCausePolicy("strict", "implement").join("\n"), /failure scenarios/);
});

const goDiff = (body: string, file = "app/usecases/invoice.go") =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -10,6 +10,6 @@ func Issue() error {\n${body}`;

test("signals: an error log lowered to WARN is flagged; a new WARN log or a reworded ERROR log is not", () => {
  const lowered = symptomFixSignals(
    goDiff(
      `-\t\tlog.Errorw("IssueInvoice failed", zap.Error(err))\n+\t\tlog.Warnw("IssueInvoice failed", zap.Error(err))\n \t\treturn err\n`,
    ),
  );
  assert.deepEqual(
    lowered.map((s) => [s.kind, s.file, s.line]),
    [["log_downgrade", "app/usecases/invoice.go", 10]],
  );
  assert.deepEqual(
    symptomFixSignals(goDiff(`+\t\tlog.Warnw("cache miss", zap.String("k", k))\n`)),
    [],
  );
  assert.deepEqual(
    symptomFixSignals(
      goDiff(
        `-\t\tlog.Errorw("issue failed", zap.Error(err))\n+\t\tlog.Errorw("IssueInvoice failed", zap.Int64("id", id), zap.Error(err))\n`,
      ),
    ),
    [],
  );
});

test("signals: removed error log/telemetry, raised limits, suppressions and removed checks; tests ignored", () => {
  const kinds = (d: string) => symptomFixSignals(d).map((s) => s.kind);
  assert.deepEqual(
    kinds(goDiff(`-\t\tlog.Errorw("sync failed", zap.Error(err))\n \t\treturn nil\n`)),
    ["observability_removed"],
  );
  assert.deepEqual(kinds(goDiff(`-\tmetrics.FailedSync.Inc()\n`)), ["observability_removed"]);
  assert.deepEqual(
    kinds(
      goDiff(
        `-\tctx, cancel := context.WithTimeout(ctx, 5*time.Second)\n+\tctx, cancel := context.WithTimeout(ctx, 30*time.Second)\n`,
      ),
    ),
    ["limit_raised"],
  );
  assert.deepEqual(
    kinds(goDiff(`-\tconst maxRetries = 5\n+\tconst maxRetries = 3\n`)),
    [],
    "a lowered limit is not a symptom fix",
  );
  assert.deepEqual(kinds(goDiff(`+  // @ts-ignore\n+  const x = y as any;\n`, "web/src/a.ts")), [
    "suppression_added",
  ]);
  assert.deepEqual(
    kinds(goDiff(`-\tif err := input.Validate(); err != nil {\n-\t\treturn err\n-\t}\n`)),
    ["check_removed"],
  );
  assert.deepEqual(
    kinds(
      goDiff(
        `-\t\tlog.Errorw("x failed", zap.Error(err))\n+\t\tlog.Infow("x failed")\n`,
        "app/x_test.go",
      ),
    ),
    [],
  );
});

test("remediation: missing parts become problems; light runs need none; nothing is upgraded", () => {
  assert.equal(normalizeRemediation(undefined, "light"), null);
  assert.deepEqual(normalizeRemediation(undefined, "standard")!.problems, [
    "remediation classification missing",
  ]);
  assert.match(
    normalizeRemediation({ kind: "MITIGATION", risks: ["x"] }, "standard")!.problems.join(),
    /unresolved cause, its risks and the follow-up/,
  );
  assert.match(
    normalizeRemediation(
      { kind: "ROOT_CAUSE_FIX", root_cause: "a", causal_link: "b" },
      "standard",
    )!.problems.join(),
    /no regression test/,
  );
  assert.deepEqual(
    normalizeRemediation(
      {
        kind: "ROOT_CAUSE_FIX",
        root_cause: "tag value too long",
        causal_link: "truncate at the source",
        regression_test: { name: "TestIssue", fails_before: true, passes_after: true },
        problems: [],
      },
      "standard",
    )!.problems,
    [],
  );
});

const pass: VerdictOutput = { verdict: "PASS", findings: [], summary: "looks right" };
const rootCause = (status: string) => ({
  root_cause: {
    status: "COMPLETED",
    output: {
      root_cause_assessment: {
        status,
        confidence: "high",
        explanation: "x",
        supporting_claims: [],
      },
      claims: [],
      rca: { symptom: "IssueInvoice failed", execution_path: ["IssueInvoice", "buildTag"] },
    },
  },
});
const implement = (remediation: unknown, signals?: unknown) => ({
  implement: {
    status: "COMPLETED",
    output: {
      verification: { passed: true },
      ...(signals ? { symptom_signals: signals } : {}),
      ...(remediation ? { remediation: normalizeRemediation(remediation, "standard") } : {}),
    },
  },
});
const fixed = {
  kind: "ROOT_CAUSE_FIX",
  root_cause: "HVTNMHang longer than allowed",
  causal_link: "builds the tag within the limit",
  regression_test: { name: "TestIssueInvoiceLongName", fails_before: true, passes_after: true },
};
const check = {
  remediation_kind: "ROOT_CAUSE_FIX",
  addresses_root_cause: true,
  symptom_only_changes: [],
  justified_signals: [],
  observability_reduced: false,
  regression_test_demonstrates_fix: true,
};
const downgrade = {
  "oms-invoice": [
    { kind: "log_downgrade", file: "app/invoice.go", line: 42, detail: "error-level log lowered" },
  ],
};

test("gate: an evidenced root-cause fix keeps its PASS and records the remediation kind", () => {
  const v = enforceRootCauseReview(
    pass,
    check,
    { ...rootCause("CONFIRMED"), ...implement(fixed) },
    "standard",
  );
  assert.equal(v.verdict, "PASS");
  assert.equal(v.remediation_kind, "ROOT_CAUSE_FIX");
});

test("gate: a symptom-only fix (unjustified log downgrade) turns PASS into a repairable FAIL", () => {
  const v = enforceRootCauseReview(
    pass,
    check,
    { ...rootCause("CONFIRMED"), ...implement(fixed, downgrade) },
    "standard",
  );
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.findings[0].file, "oms-invoice:app/invoice.go");
  assert.equal(v.findings[0].line, 42);
  assert.match(v.findings[0].explanation, /log_downgrade/);
  // Light depth (feature work) applies the same signal check.
  assert.equal(
    enforceRootCauseReview(pass, {}, implement(null, downgrade), "light").verdict,
    "FAIL",
  );
  const reported = enforceRootCauseReview(
    pass,
    { ...check, symptom_only_changes: [{ file: "a.go", line: 3, explanation: "error swallowed" }] },
    { ...rootCause("CONFIRMED"), ...implement(fixed) },
    "standard",
  );
  assert.equal(reported.verdict, "FAIL");
  assert.match(reported.findings[0].explanation, /error swallowed/);
});

test("gate: a justified observability correction passes", () => {
  const v = enforceRootCauseReview(
    pass,
    {
      ...check,
      remediation_kind: "OBSERVABILITY_CORRECTION",
      justified_signals: [
        {
          signal: "log_downgrade app/invoice.go:42",
          justification: "client 4xx is expected input, not a server error",
        },
      ],
      regression_test_demonstrates_fix: null,
    },
    {
      ...rootCause("CONFIRMED"),
      ...implement(
        {
          kind: "OBSERVABILITY_CORRECTION",
          justifications: [
            {
              signal: "log_downgrade app/invoice.go:42",
              reason: "4xx is a client error",
              evidence: "spec",
            },
          ],
        },
        downgrade,
      ),
    },
    "standard",
  );
  assert.equal(v.verdict, "PASS");
  assert.equal(v.remediation_kind, "OBSERVABILITY_CORRECTION");
});

test("gate: the reviewer's accepted signal may name the file by its short name with line and kind (run 167)", () => {
  // Recorded on run 167: the platform signal and the reviewer's acceptance text, verbatim.
  const signal = {
    file: "app/usecases/invoice.go",
    line: 719,
    kind: "observability_removed" as const,
  };
  const reviewer = [{ signal: "observability_removed: log.Errorf tại invoice.go:719 bị gỡ" }];
  assert.equal(
    signalAccepted(signal, reviewer),
    true,
    "previously rejected: the full path was not in the text",
  );
  const v = enforceRootCauseReview(
    pass,
    {
      ...check,
      remediation_kind: "OBSERVABILITY_CORRECTION",
      justified_signals: reviewer,
      regression_test_demonstrates_fix: null,
    },
    {
      ...rootCause("CONFIRMED"),
      ...implement(
        {
          kind: "OBSERVABILITY_CORRECTION",
          justifications: [{ signal: "observability_removed", reason: "r", evidence: "e" }],
        },
        { "oms-background": [{ ...signal, detail: "error log removed" }] },
      ),
    },
    "standard",
  );
  assert.equal(v.verdict, "PASS");
  // Still specific: a short name needs its line AND the kind; another file, line or kind is not accepted.
  for (const text of [
    "invoice.go:719 bị gỡ", // no kind
    "observability_removed invoice.go:71", // other line
    "observability_removed invoice.go:7190", // other line (prefix)
    "observability_removed shipment_invoice.go:719", // other file with the same suffix
    "log_downgrade invoice.go:719", // other kind
  ])
    assert.equal(signalAccepted(signal, [{ signal: text }]), false, text);
  // The full path keeps working with the kind or the line, also as repo:path.
  assert.equal(
    signalAccepted(signal, [{ signal: "app/usecases/invoice.go observability_removed" }]),
    true,
  );
  assert.equal(
    signalAccepted(signal, [{ signal: "oms-background:app/usecases/invoice.go:719" }]),
    true,
  );
});

test("gate: the author's own justification never accepts a signal (only the reviewer's root_cause_check counts)", () => {
  const v = enforceRootCauseReview(
    pass,
    {
      ...check,
      remediation_kind: "OBSERVABILITY_CORRECTION",
      justified_signals: [],
      regression_test_demonstrates_fix: null,
    },
    {
      ...rootCause("CONFIRMED"),
      ...implement(
        {
          kind: "OBSERVABILITY_CORRECTION",
          justifications: [
            {
              signal: "observability_removed app/usecases/invoice.go:719",
              reason: "r",
              evidence: "e",
            },
          ],
        },
        {
          "oms-background": [
            {
              file: "app/usecases/invoice.go",
              line: 719,
              kind: "observability_removed",
              detail: "d",
            },
          ],
        },
      ),
    },
    "standard",
  );
  assert.equal(v.verdict, "FAIL");
});

test("gate: a documented mitigation passes as MITIGATION and is never upgraded; an undocumented one fails", () => {
  const mitigation = {
    kind: "MITIGATION",
    unresolved_cause: "provider rejects long tags; source of the long value unknown",
    risks: ["invoices still fail for other fields"],
    follow_ups: ["trace the tag source in oms-api"],
  };
  const v = enforceRootCauseReview(
    pass,
    { ...check, remediation_kind: "ROOT_CAUSE_FIX" },
    { ...rootCause("UNCONFIRMED"), ...implement(mitigation) },
    "strict",
  );
  assert.equal(v.verdict, "PASS");
  assert.equal(v.remediation_kind, "MITIGATION");
  const bare = enforceRootCauseReview(
    pass,
    check,
    { ...rootCause("UNCONFIRMED"), ...implement({ kind: "MITIGATION" }) },
    "standard",
  );
  assert.equal(bare.verdict, "FAIL");
  assert.match(bare.findings.map((f) => f.explanation).join(), /unresolved cause/);
});

test("gate: insufficient evidence never yields a PASS for a root-cause fix", () => {
  const unproven = enforceRootCauseReview(
    pass,
    check,
    { ...rootCause("INSUFFICIENT_EVIDENCE"), ...implement(fixed) },
    "standard",
  );
  assert.equal(unproven.verdict, "BLOCKED");
  assert.match(unproven.blocked_reason!, /INSUFFICIENT_EVIDENCE/);
  assert.equal(
    enforceRootCauseReview(
      pass,
      undefined,
      { ...rootCause("CONFIRMED"), ...implement(fixed) },
      "standard",
    ).verdict,
    "BLOCKED",
    "a defect PASS without root_cause_check",
  );
  assert.equal(
    enforceRootCauseReview(
      pass,
      check,
      { ...rootCause("CONFIRMED"), ...implement(undefined) },
      "standard",
    ).verdict,
    "FAIL",
    "missing remediation is repairable",
  );
  const noRegression = enforceRootCauseReview(
    pass,
    { ...check, regression_test_demonstrates_fix: false },
    {
      ...rootCause("CONFIRMED"),
      ...implement({ ...fixed, regression_test: undefined, verification_limitations: "" }),
    },
    "standard",
  );
  assert.equal(noRegression.verdict, "FAIL");
});

test("gate: only a PASS is examined, and light runs without signals are unchanged", () => {
  const fail: VerdictOutput = {
    verdict: "FAIL",
    findings: [{ severity: "high", file: "a", line: 1, explanation: "x", evidence: "y" }],
    summary: "",
  };
  assert.equal(
    enforceRootCauseReview(fail, undefined, implement(null, downgrade), "strict").verdict,
    "FAIL",
  );
  assert.equal(enforceRootCauseReview(pass, undefined, implement(null), "light").verdict, "PASS");
  assert.equal(
    enforceRootCauseReview(pass, undefined, {}, "standard").verdict,
    "PASS",
    "nothing was coded",
  );
});

test("evidence: the RCA artifact reaches downstream steps; the independent reviewer sees signals and remediation", () => {
  const s = evidenceSummary(rootCause("PROBABLE")) as unknown as {
    investigation: { symptom: string; execution_path: string[] };
  };
  assert.equal(s.investigation.symptom, "IssueInvoice failed");
  assert.deepEqual(s.investigation.execution_path, ["IssueInvoice", "buildTag"]);
  const up = independentUpstream(bugGraph.steps as never, implement(fixed, downgrade));
  assert.deepEqual(Object.keys(up.implement.output).sort(), [
    "note",
    "remediation",
    "symptom_signals",
    "verification",
  ]);
});
