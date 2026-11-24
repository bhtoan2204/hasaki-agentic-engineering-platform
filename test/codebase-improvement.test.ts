import { test } from "node:test";
import assert from "node:assert/strict";
import { blastRadiusOf, proposedTargets } from "../src/impact/step.ts";
import {
  assessBlastRadius,
  evidenceGate,
  normalizeInvestigationOutput,
} from "../src/agent/evidence.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec } from "../src/workflow/graph.ts";

const analysed = (over: Record<string, unknown> = {}) => ({
  repository: "svc",
  analysis: {
    status: "partial",
    limitations: ["only file names were given: removed or renamed contracts cannot be detected"],
  },
  impacts: [],
  ...over,
});

test("proposal targets come from `target` or proposal `changes`, merged per repository", () => {
  assert.deepEqual(
    proposedTargets({
      target: { repo: "svc", files: ["a.go"], symbols: ["A"] },
      changes: [
        { repo: "svc", files: "b.go" },
        { repo: "web", files: ["x.ts"] },
        { files: ["no-repo"] },
      ],
    }),
    [
      { repo: "svc", files: ["a.go", "b.go"], symbols: ["A"] },
      { repo: "web", files: ["x.ts"], symbols: [] },
    ],
  );
  assert.deepEqual(proposedTargets(null), []);
});

test("a proposed change's blast radius is established only when nothing but its file-name limitation remains", () => {
  const ok = blastRadiusOf([
    analysed({
      impacts: [
        { repo: "web", kind: "http_route", key: "GET /a", relation: "r", confidence: "static" },
        { repo: "ops", kind: "shared_enum", key: "A", relation: "r", confidence: "inferred" },
      ],
    }),
  ]);
  assert.equal(ok.established, true);
  assert.deepEqual(
    [ok.confirmed.length, ok.uncertain.length],
    [1, 1],
    "static = confirmed, inferred = uncertain",
  );
  for (const [why, result] of [
    ["nothing named", []],
    ["stale index", [analysed({ analysis: { status: "stale", limitations: [] } })]],
    [
      "runtime-built keys",
      [
        analysed({
          analysis: {
            status: "partial",
            limitations: ["2 changed contract site(s) build their key at runtime"],
          },
        }),
      ],
    ],
    ["analysis error", [{ repository: "svc", error: "repository not found or not accessible" }]],
  ] as const) {
    const b = blastRadiusOf(result as unknown as Array<Record<string, unknown>>);
    assert.equal(b.established, false, why);
    assert.ok(b.reasons.length > 0, why);
  }
});

const fix = {
  risk: "LOW" as const,
  declared_risk: "LOW" as const,
  detected_risk: "LOW" as const,
  risk_reasons: [],
  confidence: "high" as const,
  explanation: "independently correct",
  side_effects: "",
  rollback: "",
  business_invariants: null,
};

test("an unestablished blast radius is an unmet evidence gate, whatever the declared status", () => {
  const notes: string[] = [];
  const platformGap = {
    impact: { blast_radius: { established: false, reasons: ["svc: analysis stale"] } },
  };
  const claimed = assessBlastRadius({ status: "ESTABLISHED" }, platformGap, notes);
  assert.equal(
    claimed?.established,
    false,
    "the platform's incomplete analysis wins over the claim",
  );
  assert.ok(notes.some((n) => n.includes("platform analysis was incomplete")));
  const gate = evidenceGate("CONFIRMED", fix, claimed);
  assert.equal(gate.satisfied, false);
  assert.match(gate.missing[0], /blast radius not established/);
  const partial = assessBlastRadius({ status: "PARTIAL" }, {}, []);
  assert.equal(evidenceGate("CONFIRMED", fix, partial).satisfied, false);
  const known = assessBlastRadius(
    { status: "ESTABLISHED" },
    { impact: { blast_radius: { established: true, reasons: [] } } },
    [],
  );
  assert.equal(evidenceGate("CONFIRMED", fix, known).satisfied, true);
});

test("workflows that do not assess a blast radius keep their evidence gate unchanged", () => {
  assert.equal(assessBlastRadius(undefined, { analyze: { summary: "x" } }, []), null);
  const out = normalizeInvestigationOutput("fix_proposal", {
    summary: "s",
    changes: [{ repo: "svc", files: ["a.go"], description: "log the error" }],
    root_cause_assessment: {
      status: "CONFIRMED",
      confidence: "high",
      explanation: "e",
      supporting_claims: [],
    },
    fix_assessment: { risk: "LOW", confidence: "high", explanation: "independently correct" },
  });
  assert.equal(out.blast_radius, undefined);
  assert.ok(!out.evidence_gate.missing.some((m) => m.includes("blast radius")));
});

test("codebase-improvement: valid graph, everything after the assessment is conditional, publication needs a verified proof", () => {
  const t = TEMPLATES.find((x) => x.key === "codebase-improvement")!;
  const spec = validateSpec(t.spec);
  const conditional = spec.steps.filter((s) => s.run_if?.step === "assess").map((s) => s.key);
  assert.deepEqual(conditional, [
    "blast_radius",
    "proposal",
    "approve",
    "implement",
    "regression_test",
    "impact",
    "review",
    "proof",
    "pr",
  ]);
  const step = (k: string) => spec.steps.find((s) => s.key === k)!;
  assert.equal(step("assess").config.evidence, "root_cause");
  assert.equal(step("proposal").config.evidence, "fix_proposal");
  assert.equal(step("approve").config.approve_scope_from, "proposal");
  assert.equal(step("implement").config.root_cause_depth, "strict");
  assert.equal(step("review").config.independent, true);
  assert.equal(step("review").config.root_cause_depth, "strict");
  assert.deepEqual(step("proof").config.block_on, ["FAILED", "INCONCLUSIVE", "PARTIAL"]);
  assert.equal(step("pr").config.mode, "approval");
});
