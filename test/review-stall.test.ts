/**
 * REQ-135 timeline: the implementer's repair rounds change no source while the independent reviewer keeps submitting a PASS
 * whose justification the Root Cause First gate cannot match to the platform's symptom-fix signal, so the gate keeps
 * returning the same FAIL finding and the loop kept sending it back for repair. The loop must stop on the repeat, say
 * exactly what is unresolved, and stay fail-closed (never a PASS, never a bypass of the gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceRootCauseReview } from "../src/agent/rootCause.ts";
import {
  enforceVerdict,
  normalizeVerdict,
  reviewEvidenceKey,
  reviewStall,
  type VerdictOutput,
} from "../src/agent/independentReview.ts";

const signal = {
  kind: "observability_removed",
  file: "app/usecases/invoice.go",
  line: 719,
  detail: "error log removed",
};
const upstream = {
  implement: {
    status: "COMPLETED",
    output: {
      verification: { passed: true },
      symptom_signals: { "oms-background": [signal] },
      remediation: {
        kind: "OBSERVABILITY_CORRECTION",
        root_cause: "client 4xx is expected input",
        causal_link: "the log was noise",
        regression_test: null,
        verification_limitations: "log-only change",
        unresolved_cause: "",
        risks: [],
        follow_ups: [],
        justifications: [{ signal: "observability_removed", reason: "expected", evidence: "spec" }],
        problems: [],
      },
    },
  },
};
const baseCheck = {
  remediation_kind: "OBSERVABILITY_CORRECTION",
  addresses_root_cause: true,
  symptom_only_changes: [],
  observability_reduced: false,
  regression_test_demonstrates_fix: null,
};
// What the reviewer submitted, round after round: a PASS whose justification names neither the file nor the line.
const vague = {
  ...baseCheck,
  justified_signals: [{ signal: "the removed error log", justification: "4xx is expected input" }],
};
const exact = {
  ...baseCheck,
  justified_signals: [
    {
      signal: "app/usecases/invoice.go:719 observability_removed",
      justification: "4xx is expected input",
    },
  ],
};
const review = (check: unknown): VerdictOutput =>
  enforceRootCauseReview(
    normalizeVerdict({ verdict: "PASS", findings: [], summary: "ok" }),
    check,
    upstream as never,
    "standard",
  );

const heads = { "oms-background": "a".repeat(40) };
const baseTips = { "oms-background": "b".repeat(40) };
const keyOf = (over: Partial<Parameters<typeof reviewEvidenceKey>[0]> = {}) =>
  reviewEvidenceKey({
    heads,
    baseTips,
    diffText: "diff --git a/x b/x",
    tests: [["test", [{ ok: true }]]],
    scope: null,
    ...over,
  });

/** The persisted output of a review attempt, as the step stores it. */
const stored = (v: VerdictOutput, over: { heads?: Record<string, string>; key?: string } = {}) => {
  const decided = enforceVerdict(v, {
    repairsUsed: 0,
    maxRepairs: 2,
    repairTarget: "implement",
    heads: over.heads ?? heads,
    baseTips,
    evidenceKey: over.key ?? keyOf(),
  });
  return { kind: decided.kind, output: (decided as { output: Record<string, unknown> }).output };
};

test("a valid justification that names the signal passes; the gate's finding tells the reviewer the exact string to list", () => {
  assert.equal(review(exact).verdict, "PASS");
  const failed = review(vague);
  assert.equal(failed.verdict, "FAIL");
  const finding = failed.findings[0];
  assert.equal(finding.file, "oms-background:app/usecases/invoice.go");
  assert.match(finding.explanation, /root_cause_check\.justified_signals/);
  assert.match(
    finding.explanation + finding.evidence,
    /app\/usecases\/invoice\.go:719 observability_removed/,
  );
});

test("REQ-135: an unchanged source with the same gate finding stops the repair loop with the precise reason", () => {
  // Round 1: PASS-with-vague-justification → gate FAIL → sent back to the implementer.
  const first = stored(review(vague));
  assert.equal(first.kind, "reexecute");
  // Round 2 (the repair changed nothing): the reviewer repeats the same PASS, the gate repeats the same FAIL.
  const second = review(vague);
  assert.equal(second.verdict, "FAIL");
  const stall = reviewStall({ output: first.output }, second, {
    heads,
    baseTips,
    evidenceKey: keyOf(),
  });
  assert.ok(stall, "the repeat is detected");
  assert.match(stall.reason, /no progress/i);
  assert.match(stall.reason, /source unchanged|no source change/i);
  assert.match(stall.reason, /oms-background:app\/usecases\/invoice\.go:719/);
  assert.match(
    stall.reason,
    /the removed error log/,
    "what the reviewer actually submitted is shown",
  );
  assert.match(
    stall.reason,
    /app\/usecases\/invoice\.go:719 observability_removed/,
    "and what would have matched",
  );
  // Fail-closed: the stalled verdict is BLOCKED for a human, never a PASS and never another automatic repair.
  const blocked = enforceVerdict(
    { ...second, verdict: "BLOCKED", blocked_reason: stall.reason },
    {
      repairsUsed: 1,
      maxRepairs: 2,
      repairTarget: "implement",
      heads,
      baseTips,
    },
  );
  assert.equal(blocked.kind, "waiting_input");
});

test("progress is never mistaken for a stall: new commits, different findings, changed tests or an unknown history", () => {
  const first = stored(review(vague));
  const again = review(vague);
  const now = { heads, baseTips, evidenceKey: keyOf() };
  assert.ok(reviewStall({ output: first.output }, again, now));
  // the repair committed something
  const moved = { "oms-background": "c".repeat(40) };
  assert.equal(
    reviewStall({ output: first.output }, again, {
      ...now,
      heads: moved,
      evidenceKey: keyOf({ heads: moved }),
    }),
    null,
  );
  // same commits, but the platform's test evidence changed
  assert.equal(
    reviewStall({ output: first.output }, again, {
      ...now,
      evidenceKey: keyOf({ tests: [["test", [{ ok: false }]]] }),
    }),
    null,
  );
  // a different finding
  const other: VerdictOutput = {
    verdict: "FAIL",
    summary: "",
    findings: [
      { severity: "high", file: "a.go", line: 3, explanation: "nil map write", evidence: "panic" },
    ],
  };
  assert.equal(reviewStall({ output: first.output }, other, now), null);
  // a prior attempt that recorded no evidence key (older rows) or was not a FAIL proves nothing
  assert.equal(
    reviewStall({ output: { ...first.output, review_evidence_key: undefined } }, again, now),
    null,
  );
  assert.equal(reviewStall({ output: { ...first.output, verdict: "PASS" } }, again, now), null);
  assert.equal(reviewStall(null, again, now), null);
  // and a PASS or BLOCKED is never turned into anything
  assert.equal(reviewStall({ output: first.output }, review(exact), now), null);
});
