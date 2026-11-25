/**
 * Question and suggested-answer generation. A BLOCKED verification used to ask one hard-coded question ("Provide the
 * missing information in your answer and re-verify") whatever had blocked it; the answer went back to a verifier whose
 * gates are deterministic over the upstream steps' outputs, so the same BLOCKED came back and the developer was asked
 * again. Every case below pins the replacement: distinct, actionable options per blocker, decisions the workflow
 * executes, manual input marked as such, and no repeated clarification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerProblem,
  cleanOptions,
  needsDetails,
  questionRow,
} from "../src/workflow/questionOptions.ts";
import {
  BLOCKED_ANSWERS,
  BLOCKED_PREFIX,
  blockedQuestion,
  blockedResolution,
  enforceScopeReview,
  enforceVerdict,
  evidenceTargetFor,
  normalizeVerdict,
  type BlockedKind,
  type VerdictOutput,
} from "../src/agent/independentReview.ts";
import { enforceRootCauseReview, normalizeRemediation } from "../src/agent/rootCause.ts";

const OLD =
  "Provide the missing information in your answer and re-verify (the PR still requires a PASS)";
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
      rca: { symptom: "GetByShipmentID error is swallowed", execution_path: ["Create"] },
    },
  },
});
const implement = (remediation: unknown, extra: Record<string, unknown> = {}) => ({
  implement: {
    status: "COMPLETED",
    output: {
      verification: { passed: true },
      ...(remediation ? { remediation: normalizeRemediation(remediation, "standard") } : {}),
      ...extra,
    },
  },
});
const fixed = {
  kind: "ROOT_CAUSE_FIX",
  root_cause: "Create swallows the lookup error",
  causal_link: "returns the error instead of nil",
  regression_test: { name: "TestCreateReturnsLookupError", fails_before: true, passes_after: true },
};
const check = {
  remediation_kind: "ROOT_CAUSE_FIX",
  addresses_root_cause: true,
  symptom_only_changes: [],
  justified_signals: [],
  observability_reduced: false,
  regression_test_demonstrates_fix: true,
};
const mitigation = {
  kind: "MITIGATION",
  unresolved_cause: "why the provider answers invalid param is unknown",
  risks: ["other fields can still fail"],
  follow_ups: ["trace the provider answer"],
};
const graph = {
  steps: [
    { key: "root_cause", type: "agent", depends_on: [], config: { evidence: "root_cause" } },
    { key: "implement", type: "coding_agent", depends_on: ["root_cause"], config: {} },
    { key: "review", type: "agent", depends_on: ["implement"], config: { independent: true } },
  ],
};
const ask = (
  v: VerdictOutput,
  over: { evidenceTarget?: string | null; repeated?: boolean; repairTarget?: string | null } = {},
) => {
  const r = enforceVerdict(v, {
    repairsUsed: 0,
    maxRepairs: 2,
    repairTarget: "repairTarget" in over ? over.repairTarget! : "implement",
    evidenceTarget: "evidenceTarget" in over ? over.evidenceTarget : "root_cause",
    repeated: over.repeated,
    heads: {},
  });
  assert.equal(r.kind, "waiting_input", JSON.stringify(r));
  return (r as { questions: Array<ReturnType<typeof blockedQuestion>> }).questions[0];
};
const blockedBy = (reason: string, kind: BlockedKind): VerdictOutput => ({
  verdict: "BLOCKED",
  findings: [],
  summary: "the diff was reviewed",
  blocked_reason: reason,
  blocked_kind: kind,
});
/** What the engine would hand back for an answer to the question. */
const answerTo = (q: { question: string }, answer: string) => ({ question: q.question, answer });
const targets = { repairTarget: "implement", evidenceTarget: "root_cause" };

// ---------------------------------------------------------------- the option contract

test("options: restatements, requests to the developer and duplicates are dropped; details options are kept", () => {
  const question = "Which timeout should the retry use?";
  assert.deepEqual(
    cleanOptions(question, [
      "Which timeout should the retry use",
      OLD,
      "Please provide more details in your reply",
      "Use 30 seconds",
      "use 30 seconds",
      "Use the SPL window you have:",
      "  ",
    ]),
    ["Use 30 seconds", "Use the SPL window you have:"],
  );
  assert.deepEqual(cleanOptions("q", undefined), []);
});

test("suggested answer: the first complete option; never one that needs details or one the filter rejects", () => {
  assert.deepEqual(
    questionRow({
      question: "How to proceed with the merge?",
      options: ["Paste the log here:", "Rebase onto release/qc", "Stop"],
    }),
    {
      options: ["Paste the log here:", "Rebase onto release/qc", "Stop"],
      suggested: "Rebase onto release/qc",
    },
  );
  assert.equal(questionRow({ question: "q?", options: ["Add details:"] }).suggested, null);
  assert.equal(
    questionRow({ question: "q?", options: [OLD] }).suggested,
    null,
    "the old default is not an answer",
  );
  assert.equal(
    questionRow({ question: "q?", options: ["A", "B"], suggested_answer: "B" }).suggested,
    "B",
    "an explicit acceptable suggestion wins",
  );
  assert.equal(
    questionRow({ question: "q?", options: ["A", "B"], suggested_answer: OLD }).suggested,
    "A",
    "an explicit suggestion that is itself non-informative is replaced",
  );
  assert.equal(questionRow({ question: "free text?" }).suggested, null);
});

test("manual input: an option ending with a colon is not an answer by itself", () => {
  const options = ["Use this window:", "Stop"];
  assert.match(answerProblem(options, "use this window:")!, /needs your details/);
  assert.equal(answerProblem(options, "Use this window: last 24h"), null);
  assert.equal(answerProblem(options, "Stop"), null);
  assert.equal(answerProblem(undefined, "anything"), null);
  assert.equal(needsDetails("Add evidence:  "), true);
  assert.equal(needsDetails("Re-run"), false);
});

// ---------------------------------------------------------------- verification blockers

test("verification blocker (strict proof missing): options fix the proof or reclassify, never 'provide information'", () => {
  const upstream = {
    ...rootCause("CONFIRMED"),
    ...implement(fixed, { tested_heads: { r: "h1" } }),
  };
  const v = enforceRootCauseReview(pass, check, upstream as never, "strict");
  assert.equal(v.verdict, "BLOCKED");
  assert.equal(v.blocked_kind, "proof");
  const q = ask(v);
  assert.deepEqual(q.options, [
    BLOCKED_ANSWERS.fixProof,
    BLOCKED_ANSWERS.reclassifyPartial,
    BLOCKED_ANSWERS.instructions,
    BLOCKED_ANSWERS.stop,
  ]);
  assert.equal(
    q.suggested_answer,
    BLOCKED_ANSWERS.fixProof,
    "the recommended answer is a complete decision",
  );
  assert.ok(!(q.options as string[]).includes(OLD));
  assert.match(q.question, /no platform-run regression proof/);
  const sent = blockedResolution(answerTo(q, BLOCKED_ANSWERS.fixProof), targets);
  assert.equal(sent?.kind, "reexecute");
  assert.equal((sent as { target: string }).target, "implement");
  assert.match(
    (sent as { feedback: string }).feedback,
    /fails on the pre-fix source and passes on the fixed commit/,
  );
});

test("verification blockers by kind each get their own executable options", () => {
  const cases: Array<[BlockedKind, string[], { repair?: boolean; investigate?: boolean }]> = [
    ["scope", [BLOCKED_ANSWERS.fixScope, BLOCKED_ANSWERS.instructions, BLOCKED_ANSWERS.stop], {}],
    ["uncommitted", [BLOCKED_ANSWERS.commit, BLOCKED_ANSWERS.stop], {}],
    ["stale", [BLOCKED_ANSWERS.rerun, BLOCKED_ANSWERS.stop], {}],
    [
      "verifier_output",
      [BLOCKED_ANSWERS.rerun, BLOCKED_ANSWERS.guidance, BLOCKED_ANSWERS.stop],
      {},
    ],
    ["no_progress", [BLOCKED_ANSWERS.instructions, BLOCKED_ANSWERS.stop], {}],
    ["test_evidence", [BLOCKED_ANSWERS.rerun, BLOCKED_ANSWERS.stop], {}],
    [
      "other",
      [
        BLOCKED_ANSWERS.rerun,
        BLOCKED_ANSWERS.guidance,
        BLOCKED_ANSWERS.instructions,
        BLOCKED_ANSWERS.stop,
      ],
      {},
    ],
  ];
  for (const [kind, expected] of cases)
    assert.deepEqual(ask(blockedBy("why", kind)).options, expected, kind);
  // A workflow with no coding step cannot send anything back: only what it can carry out is offered.
  assert.deepEqual(ask(blockedBy("why", "scope"), { repairTarget: null }).options, [
    BLOCKED_ANSWERS.stop,
  ]);
});

// ---------------------------------------------------------------- missing evidence

test("missing evidence: an unconfirmed root cause offers reclassify, re-investigate and evidence; each is distinct and actionable", () => {
  const upstream = { ...rootCause("UNCONFIRMED"), ...implement(fixed) };
  const v = enforceRootCauseReview(pass, check, upstream as never, "standard");
  assert.equal(v.verdict, "BLOCKED");
  assert.equal(v.blocked_kind, "root_cause");
  const q = ask(v);
  assert.deepEqual(q.options, [
    BLOCKED_ANSWERS.reclassifyPartial,
    BLOCKED_ANSWERS.reinvestigate,
    BLOCKED_ANSWERS.evidence,
    BLOCKED_ANSWERS.reclassifyMitigation,
    BLOCKED_ANSWERS.stop,
  ]);
  assert.equal(new Set(q.options!.map((o) => o.toLowerCase())).size, q.options!.length, "distinct");
  assert.equal(q.suggested_answer, BLOCKED_ANSWERS.reclassifyPartial);
  assert.match(q.context ?? "", /Options ending with ":" need your details/);
  assert.match(q.question, /assessed the root cause as UNCONFIRMED/);
  // Without an investigation step there is nothing to re-investigate and no evidence step to give evidence to.
  assert.deepEqual(ask(v, { evidenceTarget: null }).options, [
    BLOCKED_ANSWERS.reclassifyPartial,
    BLOCKED_ANSWERS.reclassifyMitigation,
    BLOCKED_ANSWERS.stop,
  ]);
});

test("missing evidence is never fabricated: developer evidence goes to the investigation as UNVERIFIED, the gate is untouched", () => {
  const q = ask(
    enforceRootCauseReview(
      pass,
      check,
      { ...rootCause("UNCONFIRMED"), ...implement(fixed) } as never,
      "standard",
    ),
  );
  const typed =
    BLOCKED_ANSWERS.evidence + " the provider returned 'invalid param' for SID-1 at 10:46";
  const r = blockedResolution(answerTo(q, typed), targets) as {
    kind: string;
    target: string;
    feedback: string;
  };
  assert.equal(r.kind, "reexecute");
  assert.equal(
    r.target,
    "root_cause",
    "evidence is checked by the step that owns the root-cause assessment",
  );
  assert.match(r.feedback, /UNVERIFIED until you check it/);
  assert.match(r.feedback, /OBSERVED_FACT only with a source you actually saw/);
  assert.match(r.feedback, /invalid param/);
  assert.doesNotMatch(r.feedback, /CONFIRMED_ROOT_CAUSE/);
  // The verdict gate reads the upstream outputs, not the answer: the same inputs are blocked the same way.
  const again = enforceRootCauseReview(
    pass,
    check,
    { ...rootCause("UNCONFIRMED"), ...implement(fixed) } as never,
    "standard",
  );
  assert.equal(again.verdict, "BLOCKED");
  const re = blockedResolution(answerTo(q, BLOCKED_ANSWERS.reinvestigate), targets) as {
    target: string;
    feedback: string;
  };
  assert.equal(re.target, "root_cause");
  assert.match(re.feedback, /Never raise the status without new verified evidence/);
});

// ---------------------------------------------------------------- reclassification decisions

test("reclassification: PARTIAL_FIX / MITIGATION go back to the implementer to be recorded honestly, then the gate passes", () => {
  const q = ask(
    enforceRootCauseReview(
      pass,
      check,
      { ...rootCause("UNCONFIRMED"), ...implement(fixed) } as never,
      "strict",
    ),
  );
  for (const [key, kind] of [
    ["reclassifyPartial", "PARTIAL_FIX"],
    ["reclassifyMitigation", "MITIGATION"],
  ] as const) {
    const r = blockedResolution(answerTo(q, BLOCKED_ANSWERS[key]), targets) as {
      kind: string;
      target: string;
      feedback: string;
      reason: string;
    };
    assert.equal(r.kind, "reexecute");
    assert.equal(r.target, "implement");
    assert.match(r.feedback, new RegExp("Set remediation.kind to " + kind));
    assert.match(r.feedback, /unresolved_cause/);
    assert.match(r.feedback, /Do not claim .* that the root cause is fixed/);
    assert.match(r.feedback, /root cause assessed|assessed the root cause as UNCONFIRMED/);
    assert.match(r.reason, /developer decision after a blocked verification/);
  }
  // What the implementer then records is what the gate judges: honest mitigation of an unconfirmed cause passes
  // and is never upgraded.
  const after = enforceRootCauseReview(
    pass,
    { ...check, remediation_kind: "ROOT_CAUSE_FIX" },
    { ...rootCause("UNCONFIRMED"), ...implement(mitigation) } as never,
    "strict",
  );
  assert.equal(after.verdict, "PASS");
  assert.equal(after.remediation_kind, "MITIGATION");
});

test("stopping ends the run; verifying again and free text stay with the verifier", () => {
  const q = ask(blockedBy("why", "other"));
  const stop = blockedResolution(answerTo(q, BLOCKED_ANSWERS.stop), targets);
  assert.equal(stop?.kind, "failed");
  assert.equal((stop as { retryable: boolean }).retryable, false);
  assert.match((stop as { error: string }).error, /Stopped by the developer/);
  assert.equal(blockedResolution(answerTo(q, BLOCKED_ANSWERS.rerun), targets), null);
  assert.equal(
    blockedResolution(answerTo(q, "the config key is on the Integrations page"), targets),
    null,
  );
  assert.equal(
    blockedResolution(answerTo(q, BLOCKED_ANSWERS.guidance + " check the retry path"), targets),
    null,
    "guidance is read by the verifier",
  );
  assert.equal(
    blockedResolution({ question: "Some other question?", answer: BLOCKED_ANSWERS.stop }, targets),
    null,
  );
});

// ---------------------------------------------------------------- manual input

test("manual input: instructions reach the implementer with the developer's words; a bare label does nothing", () => {
  const q = ask(blockedBy("the diff leaves the approved scope", "scope"));
  const r = blockedResolution(
    answerTo(q, BLOCKED_ANSWERS.instructions + " drop the log-level change in common.go"),
    targets,
  ) as { target: string; feedback: string };
  assert.equal(r.target, "implement");
  assert.match(r.feedback, /the diff leaves the approved scope/);
  assert.match(
    r.feedback,
    /Developer instructions \(binding\): drop the log-level change in common\.go/,
  );
  assert.equal(blockedResolution(answerTo(q, BLOCKED_ANSWERS.instructions), targets), null);
  assert.match(answerProblem(q.options, BLOCKED_ANSWERS.instructions)!, /needs your details/);
  assert.equal(
    answerProblem(q.options, BLOCKED_ANSWERS.fixScope),
    null,
    "a complete option needs nothing more",
  );
});

// ---------------------------------------------------------------- clarification loops

test("a repeated blocker never offers to verify again unchanged", () => {
  for (const kind of ["verifier_output", "stale", "other"] as const) {
    const q = ask(blockedBy("same reason", kind), { repeated: true });
    assert.ok(!q.options!.includes(BLOCKED_ANSWERS.rerun), kind);
    assert.match(q.context ?? "", /same blocker came back/);
    assert.notEqual(q.suggested_answer, BLOCKED_ANSWERS.rerun);
  }
  assert.deepEqual(ask(blockedBy("same", "stale"), { repeated: true }).options, [
    BLOCKED_ANSWERS.stop,
  ]);
});

test("every blocker, every workflow shape: all options survive the filter, are distinct, and the suggestion is complete", () => {
  const kinds: BlockedKind[] = [
    "verifier_output",
    "scope",
    "root_cause",
    "proof",
    "stale",
    "uncommitted",
    "no_progress",
    "test_evidence",
    "other",
  ];
  for (const kind of kinds)
    for (const repair of [true, false])
      for (const investigate of [true, false])
        for (const repeated of [true, false]) {
          const q = blockedQuestion(blockedBy("a reason", kind), { repair, investigate, repeated });
          const options = q.options!;
          assert.deepEqual(
            cleanOptions(q.question, options),
            options,
            JSON.stringify({ kind, repair, investigate, repeated }),
          );
          assert.ok(options.length >= 1 && options.at(-1) === BLOCKED_ANSWERS.stop);
          assert.ok(
            options.some((o) => !needsDetails(o)),
            "something can be sent as it is",
          );
          assert.equal(
            q.suggested_answer,
            options.find((o) => !needsDetails(o)),
          );
          assert.ok(!options.includes(OLD));
          assert.equal(
            questionRow(q).suggested,
            q.suggested_answer,
            "what the engine stores is what was meant",
          );
        }
});

// ---------------------------------------------------------------- where the blockers come from

test("blockers are classified where they are produced", () => {
  assert.equal(normalizeVerdict({ verdict: "MAYBE" }).blocked_kind, "verifier_output");
  assert.equal(normalizeVerdict({ verdict: "FAIL", findings: [] }).blocked_kind, "verifier_output");
  assert.equal(
    normalizeVerdict({ verdict: "BLOCKED", blocked_reason: "need the spec" }).blocked_kind,
    "other",
  );
  const upstream = {
    plan: { status: "COMPLETED", output: { approved_scope: { risk: "LOW", proposal_hash: "h" } } },
  };
  const missing = enforceScopeReview(pass, undefined, upstream as never);
  if (missing.verdict === "BLOCKED") assert.equal(missing.blocked_kind, "verifier_output");
  const noCheck = enforceRootCauseReview(
    pass,
    undefined,
    { ...rootCause("CONFIRMED"), ...implement(fixed) } as never,
    "standard",
  );
  assert.equal(noCheck.blocked_kind, "verifier_output");
  assert.equal(
    enforceRootCauseReview(
      pass,
      check,
      { ...rootCause("CONFIRMED"), ...implement(fixed) } as never,
      "strict",
    ).blocked_kind,
    "proof",
  );
  assert.equal(evidenceTargetFor(graph, "review"), "root_cause");
  assert.equal(evidenceTargetFor({ steps: [graph.steps[1], graph.steps[2]] }, "review"), null);
  assert.ok(BLOCKED_PREFIX.endsWith(": "));
});
