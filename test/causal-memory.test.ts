import { test } from "node:test";
import assert from "node:assert/strict";
import {
  causalFromProof,
  jaccard,
  normalizeSignature,
  renderCausal,
} from "../src/memory/causal.ts";
import { buildFixProof } from "../src/agent/proofOfFix.ts";

const claim = {
  id: "c1",
  claim: "settlement reads the balance outside the transaction",
  classification: "CODE_FACT",
  source_type: "code",
  source_ref: "payment-src@abc",
  repository: "payment-src",
  commit: "abc",
  file_path: "internal/settle.go",
  line_range: "10-20",
  confidence: "high",
  verification_status: "verified",
  provenance: {
    by: "platform",
    status: "VERIFIED_BY_PLATFORM",
    verifies: "location",
    reason: null,
  },
};
const proof = (impl: Record<string, unknown>, review = "PASS") =>
  buildFixProof({
    upstream: {
      root_cause: {
        output: {
          root_cause_assessment: {
            status: "CONFIRMED",
            confidence: "high",
            explanation: "balance read outside the settlement transaction",
          },
          claims: [claim],
        },
      },
      implement: {
        output: {
          verification: { passed: true, last: [] },
          tested_heads: { "payment-src": "h1" },
          regression_proof: {
            status: "verified",
            reason: "fails before",
            repo: "payment-src",
            test_id: "TestSettleTwice",
            head_sha: "h1",
          },
          remediation: {
            kind: "ROOT_CAUSE_FIX",
            root_cause: "x",
            causal_link: "read the balance inside the transaction",
            justifications: [],
          },
          ...impl,
        },
      },
      review: { output: { verdict: review } },
    },
    rootCauseFrom: "root_cause",
    implementFrom: "implement",
    reviewFrom: "review",
    reviewIndependent: true,
    incident: { title: "Settlement paid twice", request: "customers charged twice on retry" },
  });
const capture = (r: ReturnType<typeof proof>) =>
  causalFromProof({
    report: r,
    repositories: ["payment-src"],
    testedHeads: { "payment-src": "h1" },
    errorSignatures: ["duplicate settlement for order 123456"],
    services: ["payment-api"],
    runId: 7,
    fixProofId: 3,
  });

test("status comes from the Proof-of-Fix verdict, never from a model", () => {
  const verified = capture(proof({}));
  assert.equal(verified.status, "verified");
  assert.equal(verified.negative, false);
  assert.equal(verified.confidence, "high");
  assert.deepEqual(verified.regression_tests, ["TestSettleTwice"]);
  // Repository-qualified: invalidation checks each repository only for its own files.
  assert.deepEqual(verified.files, ["payment-src:internal/settle.go"]);
  assert.equal(verified.error_signatures[0], "duplicate settlement for order #");
  assert.deepEqual(verified.validity.commits, { "payment-src": "h1" });
  const failed = capture(proof({ verification: { passed: false } }));
  assert.equal(failed.status, "rejected");
  assert.equal(failed.negative, true, "a failed approach is negative knowledge");
  assert.equal(failed.fix_approach, "");
  assert.match(failed.failed_approaches[0].why, /implementation tests fail/);
  const partial = capture(proof({}, "BLOCKED"));
  assert.equal(partial.status, "proposed");
  assert.notEqual(partial.memory_key, "", "the same incident keeps one identity across verdicts");
  assert.equal(partial.memory_key, verified.memory_key);
});

test("unjustified symptom-only changes are kept as failed approaches of the record", () => {
  const r = capture(
    proof({
      symptom_signals: {
        "payment-src": [
          { kind: "retry_added", file: "internal/client.go", line: 9, detail: "retry added" },
        ],
      },
    }),
  );
  assert.equal(r.status, "proposed");
  assert.match(r.failed_approaches[0].approach, /retry_added in internal\/client.go:9/);
  assert.match(renderCausal({ ...r, verification: r.verification }), /Did NOT work: retry_added/);
});

test("text helpers: volatile ids normalize away; overlap is symmetric", () => {
  assert.equal(
    normalizeSignature("Timeout after 3000ms for order 9f8e7d6c5b"),
    "timeout after #ms for order #",
  );
  assert.equal(
    jaccard("refund settle timeout", "timeout on refund settle"),
    jaccard("timeout on refund settle", "refund settle timeout"),
  );
  assert.equal(jaccard("", "x"), 0);
});
