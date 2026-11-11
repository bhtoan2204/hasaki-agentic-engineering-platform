import test from "node:test";
import assert from "node:assert/strict";
import {
  approvedScopeFrom,
  approvedScopeIn,
  assessRootCause,
  detectRisk,
  evidenceGate,
  evidenceSummary,
  normalizeClaims,
  normalizeInvestigationOutput,
  scopeCheck,
  summaryTokens,
  unavailableSources,
  INVARIANT_FIELDS,
} from "../src/agent/evidence.ts";
import {
  enforceScopeReview,
  independentUpstream,
  normalizeVerdict,
} from "../src/agent/independentReview.ts";
import { contractKeys, missingContractKeys } from "../src/agent/contract.ts";
import { runInvestigationBenchmark } from "../src/eval/investigation.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec } from "../src/workflow/graph.ts";
import { catalog } from "../web/src/i18n/catalog.ts";

const verifiedLog = {
  id: "C1",
  claim: "Provider returned a validation error",
  classification: "OBSERVED_FACT",
  source_type: "production_log",
  source_ref: "req-1",
  verification_status: "verified",
};
const verifiedCode = {
  id: "C2",
  claim: "Client does not check package_id",
  classification: "CODE_FACT",
  repository: "svc",
  file_path: "a.go",
  line_range: "1-9",
  commit: "abc1234",
  verification_status: "verified",
};

test("evidence classification: observations and code facts need usable provenance", () => {
  const notes: string[] = [];
  const c = normalizeClaims(
    [
      verifiedLog,
      { ...verifiedLog, id: "C3", claim: "Splunk shows errors since Monday", source_ref: null },
      { ...verifiedLog, id: "C4", claim: "Error happens on retries", source_type: "previous_step" },
      { ...verifiedCode, id: "C5", claim: "Handler skips the guard", file_path: null },
      { ...verifiedCode, id: "C6", claim: "Guard exists", commit: null },
      {
        id: "C7",
        claim: "Maybe stale id",
        classification: "HYPOTHESIS",
        verification_status: "verified",
        confidence: 0.9,
      },
      { id: "C8", claim: "Something", classification: "PROVEN" },
    ],
    notes,
  );
  const cls = Object.fromEntries(
    c.map((x) => [x.id, `${x.classification}/${x.verification_status}`]),
  );
  assert.deepEqual(cls, {
    C1: "OBSERVED_FACT/verified",
    C3: "HYPOTHESIS/unverified",
    C4: "HYPOTHESIS/unverified",
    C5: "HYPOTHESIS/unverified",
    C6: "CODE_FACT/unverified",
    C7: "HYPOTHESIS/unverified",
    C8: "HYPOTHESIS/unverified",
  });
  assert.ok(notes.some((n) => n.includes("numeric confidence discarded")));
  assert.ok(
    notes.some((n) => n.includes("not independent evidence")),
    "agent opinions are never facts",
  );
  assert.ok(notes.length >= 6, "every downgrade is recorded, never silent");
});

test("repeated claims are merged, not counted as corroboration; secrets are redacted", () => {
  const notes: string[] = [];
  const c = normalizeClaims(
    [
      { id: "H1", claim: "The package id is stale", classification: "HYPOTHESIS" },
      { id: "H2", claim: "the package ID is stale!", classification: "HYPOTHESIS" },
      {
        id: "S1",
        claim: "Request failed with Authorization: Bearer sk-abcdefgh12345678",
        classification: "HYPOTHESIS",
      },
    ],
    notes,
  );
  assert.equal(c.length, 2);
  assert.ok(notes.some((n) => n.includes("duplicate claim H2 merged into H1")));
  assert.ok(!JSON.stringify(c).includes("sk-abcdefgh12345678"));
});

test("contradictory evidence marks both claims and caps the root cause", () => {
  const notes: string[] = [];
  const claims = normalizeClaims(
    [
      verifiedLog,
      { ...verifiedLog, id: "C9", claim: "Provider accepted the call", contradicts: ["C1"] },
      { id: "R", claim: "id is stale", classification: "CONFIRMED_ROOT_CAUSE", supports: ["C1"] },
    ],
    notes,
  );
  assert.equal(claims.find((c) => c.id === "C1")!.verification_status, "contradicted");
  assert.equal(claims.find((c) => c.id === "C9")!.verification_status, "contradicted");
  const a = assessRootCause({ status: "CONFIRMED", explanation: "x" }, claims, null, [], notes);
  assert.notEqual(a.status, "CONFIRMED");
});

test("root cause confidence: CONFIRMED needs a supported claim and an explanation", () => {
  const notes: string[] = [];
  const supported = normalizeClaims(
    [
      verifiedLog,
      verifiedCode,
      { id: "R", claim: "empty id sent", classification: "CONFIRMED_ROOT_CAUSE", supports: ["C2"] },
    ],
    notes,
  );
  assert.equal(
    assessRootCause(
      { status: "CONFIRMED", explanation: "code and log agree" },
      supported,
      null,
      [],
      notes,
    ).status,
    "CONFIRMED",
  );
  assert.equal(
    assessRootCause({ status: "CONFIRMED", explanation: "" }, supported, null, [], notes).status,
    "UNCONFIRMED",
  );
  const unsupported = normalizeClaims(
    [
      verifiedLog,
      { id: "R", claim: "id is stale", classification: "CONFIRMED_ROOT_CAUSE", supports: [] },
    ],
    notes,
  );
  assert.equal(unsupported.find((c) => c.id === "R")!.classification, "HYPOTHESIS");
  assert.equal(
    assessRootCause({ status: "CONFIRMED", explanation: "x" }, unsupported, null, [], notes).status,
    "PROBABLE",
  );
  assert.equal(
    assessRootCause({ status: "CONFIRMED", explanation: "x" }, [], null, [], notes).status,
    "UNCONFIRMED",
  );
  assert.equal(
    assessRootCause({ status: "certain" }, [], null, [], notes).status,
    "INSUFFICIENT_EVIDENCE",
  );
});

test("hypothesis promotion: confidence never rises between steps without new verified evidence", () => {
  const upstream = {
    root_cause: {
      claims: [verifiedLog],
      root_cause_assessment: {
        status: "UNCONFIRMED",
        explanation: "plausible",
        supporting_claims: [],
      },
    },
  };
  const repeated = normalizeInvestigationOutput(
    "fix_proposal",
    {
      summary: "s",
      changes: [],
      claims: [
        verifiedLog,
        { id: "R", claim: "id is stale", classification: "CONFIRMED_ROOT_CAUSE", supports: ["C1"] },
      ],
      root_cause_assessment: { status: "CONFIRMED", explanation: "the root cause step said so" },
    },
    upstream,
  );
  assert.equal(repeated.root_cause_assessment.status, "UNCONFIRMED");
  assert.ok(
    repeated.evidence_validation.notes.some((n: string) =>
      n.includes("without new verified evidence"),
    ),
  );
  const withNew = normalizeInvestigationOutput(
    "fix_proposal",
    {
      summary: "s",
      changes: [],
      claims: [
        verifiedLog,
        verifiedCode,
        {
          id: "R",
          claim: "empty id sent",
          classification: "CONFIRMED_ROOT_CAUSE",
          supports: ["C2"],
        },
      ],
      root_cause_assessment: { status: "CONFIRMED", explanation: "new code evidence" },
    },
    upstream,
  );
  assert.equal(withNew.root_cause_assessment.status, "CONFIRMED");
  // A fix proposal that does not restate the assessment inherits the earlier, more cautious one.
  const inherited = normalizeInvestigationOutput(
    "fix_proposal",
    { summary: "s", changes: [] },
    upstream,
  );
  assert.equal(inherited.root_cause_assessment.status, "UNCONFIRMED");
});

test("fix risk classification has a deterministic floor (generic, EN + VI)", () => {
  assert.equal(
    detectRisk([
      "Enrich the ReadyToShip error with the provider response code; return a validation error when package_id is empty.",
    ]).risk,
    "LOW",
  );
  assert.equal(detectRisk(["Add a debug log with the request id"]).risk, "LOW");
  assert.equal(
    detectRisk([
      "If TrackingNo is not empty, treat the package as successfully shipped and update the business state.",
    ]).risk,
    "HIGH",
  );
  assert.equal(detectRisk(["Set status = DELIVERED after 48h"]).risk, "HIGH");
  assert.equal(detectRisk(["Recalculate the refund amount"]).risk, "HIGH");
  assert.equal(detectRisk(["Skip the authorization check for internal calls"]).risk, "HIGH");
  assert.equal(detectRisk(["Cập nhật trạng thái đơn hàng khi có mã vận đơn"]).risk, "HIGH");
  assert.equal(detectRisk(["Retry the callback with backoff"]).risk, "MEDIUM");
  assert.equal(detectRisk(["Increase the HTTP timeout"]).risk, "MEDIUM");
  const out = normalizeInvestigationOutput("fix_proposal", {
    summary: "Mark shipped when tracking exists",
    changes: [
      {
        repo: "svc",
        files: ["a.go"],
        description: "Mark the package as shipped when TrackingNo is set",
      },
    ],
    fix_assessment: { risk: "LOW", explanation: "x" },
  });
  assert.equal(out.fix_assessment.risk, "HIGH", "a declared LOW never hides a detected HIGH");
  assert.equal(out.fix_assessment.declared_risk, "LOW");
});

test("root cause and fix safety are separate: a LOW fix may proceed with an UNCONFIRMED root cause", () => {
  const out = normalizeInvestigationOutput("fix_proposal", {
    summary: "Enrich error; reject empty package id",
    changes: [
      {
        repo: "svc",
        files: ["a.go"],
        description:
          "Enrich the error message and return a validation error for an empty package_id",
      },
    ],
    root_cause_assessment: { status: "UNCONFIRMED", explanation: "provider reason unknown" },
    fix_assessment: {
      risk: "LOW",
      confidence: "high",
      explanation: "correct whatever the root cause",
    },
  });
  assert.equal(out.root_cause_assessment.status, "UNCONFIRMED");
  assert.equal(out.fix_assessment.confidence, "high");
  assert.equal(out.evidence_gate.satisfied, true);
});

test("business-state invariants: HIGH risk needs every invariant answered and a non-hypothetical root cause", () => {
  const fix = (inv: Record<string, string> | null) => ({
    risk: "HIGH" as const,
    declared_risk: "HIGH" as const,
    detected_risk: "HIGH" as const,
    risk_reasons: [],
    confidence: null,
    explanation: "x",
    side_effects: "events",
    rollback: "flag",
    business_invariants: inv,
  });
  const full = Object.fromEntries(INVARIANT_FIELDS.map((k) => [k, `answered ${k}`]));
  assert.equal(evidenceGate("CONFIRMED", fix(full)).satisfied, true);
  const g = evidenceGate(
    "CONFIRMED",
    fix({ ...full, source_of_truth: "unknown", idempotency: "chưa kiểm tra" }),
  );
  assert.deepEqual(g.missing, [
    "business_invariants.source_of_truth",
    "business_invariants.idempotency",
  ]);
  assert.ok(
    evidenceGate("UNCONFIRMED", fix(full)).missing.some((m) => m.includes("unproven hypothesis")),
  );
  assert.equal(
    evidenceGate("CONFIRMED", {
      ...fix(null),
      risk: "MEDIUM",
      side_effects: "",
      rollback: "n/a",
    }).missing.join(","),
    "side_effects,rollback",
  );
});

test("investigation coverage: unavailable sources become missing evidence; one log event never fixes the blast radius", () => {
  const out = normalizeInvestigationOutput(
    "analysis",
    {
      symptoms: "x",
      missing_evidence: ["error rate"],
      impact_assessment: { summary: "one order", exact: true, affected_count: 1 },
    },
    {},
    unavailableSources({
      entries: [{ id: "unavailable:get_production_errors" }, { id: "search_code" }],
    }),
  );
  assert.ok(
    out.missing_evidence.some(
      (m: string) => m.includes("production logs") && m.includes("not inspected"),
    ),
  );
  assert.equal(out.impact_assessment.scope, "unknown");
  assert.equal(out.impact_assessment.exact, false);
  for (const k of [
    "verified_observations",
    "code_paths_inspected",
    "hypotheses",
    "evidence_suggestions",
    "safe_next_actions",
  ])
    assert.ok(Array.isArray(out[k]), k);
});

test("approval scope preservation: frozen hash, deviations recorded, riskier deviation needs re-approval", () => {
  const proposal = normalizeInvestigationOutput("fix_proposal", {
    summary: "Enrich error; reject empty package id",
    changes: [
      {
        repo: "svc",
        files: ["app/client.go"],
        description: "Enrich the error message and validate package_id",
      },
    ],
    claims: [{ id: "H", claim: "id may be stale", classification: "HYPOTHESIS" }],
    root_cause_assessment: { status: "UNCONFIRMED", explanation: "x" },
    fix_assessment: { risk: "LOW", explanation: "safe" },
  });
  const scope = approvedScopeFrom("fix_proposal", proposal)!;
  assert.equal(
    scope.proposal_hash,
    approvedScopeFrom("fix_proposal", { ...proposal, claims: [] })!.proposal_hash,
    "hash covers the approved change, not commentary",
  );
  assert.notEqual(
    scope.proposal_hash,
    approvedScopeFrom("fix_proposal", { ...proposal, summary: "other" })!.proposal_hash,
  );
  assert.deepEqual(scope.assumptions, ["id may be stale"]);
  const ok = scopeCheck(scope, { svc: ["app/client.go", "app/client_test.go"] }, []);
  assert.deepEqual([ok.out_of_scope_files, ok.requires_reapproval], [[], false]);
  const drift = scopeCheck(scope, { svc: ["app/client.go", "app/rts.go"], other: ["x.go"] }, [
    { description: "Mark package shipped when TrackingNo is set", risk: "LOW" },
  ]);
  assert.deepEqual(drift.out_of_scope_files, ["svc:app/rts.go", "other:x.go"]);
  assert.deepEqual(drift.unauthorized_repos, ["other"]);
  assert.equal(drift.deviations[0].risk, "HIGH");
  assert.equal(drift.requires_reapproval, true);
  assert.equal(
    approvedScopeIn({
      approve_fix: { output: { approved: true, approved_scope: scope }, status: "COMPLETED" },
    })?.proposal_hash,
    scope.proposal_hash,
  );
  assert.equal(
    approvedScopeIn({ approve_fix: { output: { approved: true } } }),
    null,
    "legacy approvals carry no scope",
  );
});

test("independent review: a speculative state change never passes on green tests alone", () => {
  const scope = approvedScopeFrom("fix_proposal", {
    summary: "s",
    changes: [{ repo: "svc", files: ["a.go"], description: "enrich error" }],
    fix_assessment: { risk: "LOW" },
  })!;
  const upstream = {
    approve_fix: { output: { approved: true, approved_scope: scope }, status: "COMPLETED" },
  };
  const pass = normalizeVerdict({ verdict: "PASS", findings: [], summary: "tests pass" });
  assert.equal(
    enforceScopeReview(pass, undefined, upstream).verdict,
    "BLOCKED",
    "PASS without a scope check",
  );
  assert.equal(
    enforceScopeReview(
      pass,
      { in_scope: true, unsupported_assumptions: ["tracking number means shipped"] },
      upstream,
    ).verdict,
    "BLOCKED",
  );
  assert.equal(
    enforceScopeReview(
      pass,
      { in_scope: true, unintended_state_transitions: ["marks shipped"] },
      upstream,
    ).verdict,
    "BLOCKED",
  );
  assert.equal(enforceScopeReview(pass, { in_scope: false }, upstream).verdict, "BLOCKED");
  assert.equal(
    enforceScopeReview(
      pass,
      { in_scope: true, unsupported_assumptions: [], unintended_state_transitions: [] },
      upstream,
    ).verdict,
    "PASS",
  );
  const drifted = {
    ...upstream,
    implement: {
      output: {
        scope_check: { requires_reapproval: true, reapproved: null, reasons: ["HIGH deviation"] },
      },
      status: "COMPLETED",
    },
  };
  assert.equal(enforceScopeReview(pass, { in_scope: true }, drifted).verdict, "BLOCKED");
  const high = {
    approve_fix: {
      output: { approved: true, approved_scope: { ...scope, risk: "HIGH" } },
      status: "COMPLETED",
    },
  };
  assert.equal(
    enforceScopeReview(pass, { in_scope: true, invariants_preserved: null }, high).verdict,
    "BLOCKED",
  );
  const fail = normalizeVerdict({
    verdict: "FAIL",
    findings: [
      {
        severity: "high",
        file: "a.go",
        line: 3,
        explanation: "marks shipped",
        evidence: "diff line 3",
      },
    ],
    summary: "",
  });
  assert.equal(
    enforceScopeReview(fail, undefined, upstream).verdict,
    "FAIL",
    "FAIL keeps the bounded repair loop",
  );
  assert.equal(
    enforceScopeReview(pass, undefined, {}).verdict,
    "PASS",
    "legacy runs (no approved scope) are unchanged",
  );
  // The verifier sees the platform scope check of the coding step, never the author's summary.
  const graph = [
    { key: "implement", type: "coding_agent", depends_on: [] },
    { key: "review", type: "agent", depends_on: ["implement"] },
  ] as any;
  const seen = independentUpstream(graph, {
    implement: {
      output: {
        summary: "trust me",
        verification: { passed: true },
        scope_check: { requires_reapproval: false },
      },
    },
  });
  assert.deepEqual(Object.keys(seen.implement.output).sort(), [
    "note",
    "scope_check",
    "verification",
  ]);
});

test("context propagation: compact summary keeps uncertainty and never amplifies claims", () => {
  const big = "lorem ipsum ".repeat(4000);
  const upstream: Record<string, any> = {
    analyze: {
      status: "COMPLETED",
      output: {
        symptoms: big,
        claims: [verifiedLog, { id: "H", claim: "id is stale", classification: "HYPOTHESIS" }],
        missing_evidence: ["Splunk access"],
      },
    },
    root_cause: {
      status: "COMPLETED",
      output: {
        root_cause: big,
        claims: [
          {
            id: "H",
            claim: "id is stale",
            classification: "OBSERVED_FACT",
            source_type: "previous_step",
            source_ref: "analyze",
            verification_status: "verified",
          },
        ],
        root_cause_assessment: { status: "UNCONFIRMED", explanation: "plausible" },
      },
    },
    fix_proposal: {
      status: "COMPLETED",
      output: {
        claims: Array.from({ length: 80 }, (_, i) => ({
          id: `X${i}`,
          claim: `extra hypothesis ${i}`,
          classification: "HYPOTHESIS",
        })),
        root_cause_assessment: { status: "CONFIRMED", explanation: "repeated" },
        fix_assessment: { risk: "LOW" },
        required_tests: ["empty package id is rejected"],
      },
    },
  };
  const s = evidenceSummary(upstream)!;
  assert.equal(s.verified_facts.length, 1);
  assert.ok(
    s.open_hypotheses.some((h) => h.includes("id is stale")),
    "a repeated hypothesis stays a hypothesis",
  );
  assert.ok(!s.verified_facts.some((f) => f.includes("id is stale")));
  assert.equal(s.root_cause!.status, "UNCONFIRMED", "the most cautious verdict binds");
  assert.deepEqual(s.missing_evidence, ["Splunk access"]);
  assert.ok(s.prohibited_assumptions.some((p) => p.includes("does not prove")));
  assert.deepEqual(s.required_tests, ["empty package id is rejected"]);
  assert.ok(s.truncated_items! > 0 && s.open_hypotheses.length <= 12);
  assert.ok(summaryTokens(s) < 2500, `summary is bounded: ${summaryTokens(s)} tokens`);
  assert.ok(
    summaryTokens(s) * 10 < summaryTokens(upstream),
    "summary is far smaller than the raw outputs",
  );
  assert.equal(
    evidenceSummary({ plan: { status: "COMPLETED", output: { summary: "legacy" } } }),
    null,
    "legacy workflows get no summary",
  );
});

test("legacy compatibility: optional contract keys, templates validate, old outputs untouched", () => {
  assert.deepEqual(contractKeys("{ a, b?: string[], c?, d: { e } }"), ["a", "d"]);
  assert.deepEqual(missingContractKeys("{ summary, scope_deviations?: [] }", { summary: "x" }), []);
  for (const t of TEMPLATES) assert.doesNotThrow(() => validateSpec(t.spec), t.key);
  const bug = TEMPLATES.find((t) => t.key === "bug-investigation")!.spec as any;
  const by = Object.fromEntries(bug.steps.map((s: any) => [s.key, s.config]));
  assert.deepEqual(
    [
      by.analyze.evidence,
      by.root_cause.evidence,
      by.fix_proposal.evidence,
      by.approve_fix.approve_scope_from,
      by.review.scope_review,
    ],
    ["analysis", "root_cause", "fix_proposal", "fix_proposal", true],
  );
  assert.deepEqual(
    contractKeys(by.implement.output_contract),
    ["summary", "pull_requests", "verification"],
    "Codex is never failed for a missing optional evidence field",
  );
  const feature = TEMPLATES.find((t) => t.key === "feature-implementation")!.spec as any;
  assert.ok(
    !feature.steps.some((s: any) => s.config?.evidence || s.config?.scope_review),
    "other templates are unchanged",
  );
});

test("VI/EN: every evidence UI string exists in both locales", () => {
  const keys = Object.keys(catalog.en).filter((k) => k.startsWith("ev."));
  assert.ok(keys.length >= 20);
  for (const k of keys) assert.ok(catalog.vi[k], `missing vi ${k}`);
  for (const s of ["CONFIRMED", "PROBABLE", "UNCONFIRMED", "INSUFFICIENT_EVIDENCE"])
    assert.ok(catalog.vi[`ev.rc.${s}`] && catalog.en[`ev.rc.${s}`]);
  for (const r of ["LOW", "MEDIUM", "HIGH"])
    assert.ok(catalog.vi[`ev.risk.${r}`] && catalog.en[`ev.risk.${r}`]);
});

test("investigation benchmark: all scenarios and controls pass", () => {
  const r = runInvestigationBenchmark();
  assert.deepEqual(r.failures, []);
  assert.equal(r.scenarios, 12);
  for (const m of [
    "evidence_classification",
    "unsupported_claim",
    "root_cause_calibration",
    "fix_safety",
    "invariant_preservation",
    "missing_evidence_reporting",
    "scope_compliance",
    "reviewer_detection",
  ])
    assert.ok(r.metrics[m]?.total > 0, m);
  assert.ok(r.token_overhead.max_summary_tokens < 1500);
});
