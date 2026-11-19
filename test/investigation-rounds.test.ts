import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageGaps,
  deployedVersions,
  evaluateHypotheses,
  impactCounts,
  planNextActions,
  progressSignature,
  rootCauseOutcome,
  searchCoverage,
  stopReason,
} from "../src/investigation/rounds.ts";
import { sanitizeText } from "../src/investigation/events.ts";
import type { TimelineEvent } from "../src/investigation/correlate.ts";

// Synthetic, sanitized fixture of an SPX-like incident: oms-background "shipOrderHasaki - ship shipment failed",
// provider code 13101 "invalid sender/receiver phone"; shipment SPX-A is retried three times, SPX-B once, a GHN
// rejection exists for SPX-C; one unrelated request logged at the same second carries no shipment id.
const ev = (ref: string, over: Partial<TimelineEvent>): TimelineEvent =>
  ({
    event_type: "ERROR",
    timestamp: "2026-11-18T10:00:00+07:00",
    epoch_us: 0,
    precision: "ms",
    time_original: null,
    assumed_timezone: false,
    service: "oms-background",
    index: "k8s_prod",
    source: null,
    order_code: null,
    shipment_code: null,
    shipment_id: null,
    tracking_no: null,
    request_id: null,
    trace_id: null,
    correlation_id: null,
    message_id: null,
    ids: {},
    evidence_ref: ref,
    confidence: "confirmed",
    link: { kind: "direct", via: [] },
    excerpt: "shipOrderHasaki - ship shipment failed: SPX 13101 invalid sender/receiver phone",
    ...over,
  }) as TimelineEvent;
const timeline = [
  ev("S1:0", { shipment_code: "SPX-A" }),
  ev("S1:1", { shipment_code: "SPX-A" }),
  ev("S1:2", { shipment_code: "SPX-A" }),
  ev("S1:3", { shipment_code: "SPX-B" }),
  ev("S2:0", { shipment_code: "SPX-C", excerpt: "GHN rejected: phone invalid" }),
  ev("S2:1", { event_type: "OTHER", excerpt: "GET /health 200", confidence: "unknown" }),
];
const searches = [
  {
    id: 1,
    status: "done",
    result_count: 4,
    truncated: false,
    earliest: "2026-11-18T09:00:00+07:00",
    latest: "2026-11-18T09:30:00+07:00",
  },
  {
    id: 2,
    status: "done",
    result_count: 200,
    truncated: true,
    earliest: "2026-11-18T09:00:00+07:00",
    latest: "2026-11-18T09:30:00+07:00",
  },
  {
    id: 3,
    status: "done",
    result_count: 0,
    truncated: false,
    earliest: "2026-11-18T09:00:00+07:00",
    latest: "2026-11-18T09:30:00+07:00",
  },
  {
    id: 4,
    status: "failed",
    result_count: null,
    error: "403 Forbidden: index not allowed",
    earliest: "2026-11-18T09:00:00+07:00",
    latest: "2026-11-18T09:30:00+07:00",
  },
  {
    id: 5,
    status: "manual_pending",
    result_count: null,
    earliest: "2026-11-18T09:00:00+07:00",
    latest: "2026-11-18T09:30:00+07:00",
  },
];
const known = new Set(timeline.map((t) => t.evidence_ref).concat(["A1:0"]));
const runtime = new Set(
  timeline.filter((t) => t.confidence !== "unknown").map((t) => t.evidence_ref),
);

test("query coverage classifies every empty or partial answer; a window that misses the latest request is a gap", () => {
  const cov = searchCoverage(searches);
  assert.deepEqual(
    cov.map((c) => c.reason),
    ["rows", "truncated", "no_rows", "permission", "manual_pending"],
  );
  const anchor = Date.parse("2026-11-18T10:05:00+07:00");
  assert.deepEqual(coverageGaps(cov, anchor), ["window_misses_anchor", "truncated", "permission"]);
  assert.deepEqual(coverageGaps(cov, Date.parse("2026-11-18T09:10:00+07:00")), [
    "truncated",
    "permission",
  ]);
  assert.ok(coverageGaps(searchCoverage([searches[3]]), null).includes("no_answered_search"));
});

test("impact counts distinct shipments, not log lines; retries are separated; truncation makes it a lower bound; state stays UNKNOWN", () => {
  const impact = impactCounts(timeline, searchCoverage(searches));
  assert.deepEqual(impact.objects, [
    { field: "shipment_code", distinct: 3, failure_events: 5, lower_bound: true },
  ]);
  assert.equal(impact.repeats, 2);
  assert.equal(impact.state_money, "UNKNOWN", "no DB/state evidence: never assumed safe");
  const complete = impactCounts(timeline, searchCoverage([searches[0]]));
  assert.equal(complete.objects[0].lower_bound, false);
  const withState = impactCounts(
    [...timeline, ev("D1:0", { event_type: "STATE_CHANGED", shipment_code: "SPX-A" })],
    [],
  );
  assert.equal(withState.state_money, "EVIDENCED");
});

const proposals = {
  hypotheses: [
    {
      id: "H1",
      kind: "causal_origin",
      service: "oms-background",
      statement: "sender phone built from the store profile without normalisation",
      supporting_refs: ["S1:0"],
      contradicting_refs: [],
      code_location: "oms-background:app/shipping/spx.go:142",
      predicted_observations: ["the same 13101 for every shipment of that store"],
    },
    {
      id: "H2",
      kind: "causal_origin",
      statement: "deploy regression",
      status: "SUPPORTED",
      supporting_refs: ["S1:3"],
      predicted_observations: ["errors start at the rollout time"],
    },
    {
      id: "H3",
      kind: "contributing_factor",
      statement: "SPX changed its phone contract",
      supporting_refs: [],
      contradicting_refs: ["S2:0"],
    },
    {
      id: "H4",
      kind: "systemic_recurrence",
      statement: "retries amplify the failure",
      supporting_refs: ["S1:1"],
      contradicting_refs: ["S1:3"],
      code_location: "oms-background:app/shipping/retry.go:30",
    },
    {
      id: "H5",
      kind: "causal_origin",
      statement: "fabricated",
      status: "CONFIRMED",
      supporting_refs: ["S404:0", "made-up"],
      code_location: "other-repo:x.go:1",
    },
  ],
  deployed: [
    { service: "oms-background", commit: "9f8e7d6c", evidence_ref: "S404:2" },
    { service: "oms-api", commit: "not-a-sha", evidence_ref: "A1:0" },
  ],
};

test("hypotheses: SUPPORTED needs runtime evidence and a code location; contradictions and fabricated refs never support", () => {
  const h = Object.fromEntries(
    evaluateHypotheses(proposals, {
      knownRefs: known,
      runtimeRefs: runtime,
      repositories: new Set(["oms-background"]),
    }).map((x) => [x.id, x]),
  );
  assert.equal(h.H1.status, "SUPPORTED");
  assert.equal(h.H2.status, "OPEN", "no code location: the deploy hypothesis is not cross-checked");
  assert.match(h.H2.notes.join(), /not supported by the evidence/);
  assert.equal(h.H3.status, "DISPROVED");
  assert.equal(h.H4.status, "UNRESOLVED");
  assert.equal(h.H5.status, "OPEN");
  assert.deepEqual(h.H5.supporting_refs, []);
  assert.equal(h.H5.code_location, null);
  assert.match(h.H5.notes.join(), /unresolvable evidence references dropped: S404:0, made-up/);
});

test("root-cause outcome: CONFIRMED only with a verified deployed commit and counted impact; budget never promotes", () => {
  const hypotheses = evaluateHypotheses(proposals, {
    knownRefs: known,
    runtimeRefs: runtime,
    repositories: new Set(["oms-background"]),
  });
  const impact = impactCounts(timeline, searchCoverage(searches));
  const deployed = deployedVersions(proposals, known);
  assert.deepEqual(
    deployed.map((d) => d.verified),
    [false, false],
    "commit without a stored record, or not a SHA",
  );
  const probable = rootCauseOutcome({ hypotheses, impact, deployed, blocked: false });
  assert.equal(probable.outcome, "PROBABLE");
  assert.match(probable.reasons.join(), /deployed commit/);
  const verified = deployedVersions(
    { deployed: [{ service: "oms-background", commit: "9f8e7d6c", evidence_ref: "A1:0" }] },
    known,
  );
  assert.equal(
    rootCauseOutcome({ hypotheses, impact, deployed: verified, blocked: false }).outcome,
    "CONFIRMED",
  );
  assert.equal(
    rootCauseOutcome({ hypotheses: [], impact, deployed: verified, blocked: false }).outcome,
    "UNKNOWN",
  );
  assert.equal(
    rootCauseOutcome({ hypotheses, impact, deployed: verified, blocked: true }).outcome,
    "BLOCKED",
  );
  const stop = stopReason({
    enabled: true,
    round: 3,
    maxRounds: 3,
    queriesUsed: 1,
    queryBudget: 25,
    outcome: "PROBABLE",
    signature: "a",
    previousSignature: "b",
    actions: [],
  });
  assert.equal(stop, "max_rounds");
});

test("next actions: highest information gain first, equivalent actions of earlier rounds are not planned again", () => {
  const hypotheses = evaluateHypotheses(proposals, {
    knownRefs: known,
    runtimeRefs: runtime,
    repositories: new Set(["oms-background"]),
  });
  const input = {
    gaps: ["window_misses_anchor", "truncated"],
    anchor: "2026-11-18T10:05:00+07:00",
    identifiers: { shipment_code: ["SPX-A", "SPX-D"] },
    searchedText: 'index=k8s_prod "SPX-A"',
    missing: [{ objective: "partner_callback", needed: "the SPX callback" }],
    hypotheses,
    deployed: [],
    done: new Set<string>(),
  };
  const first = planNextActions({ ...input, max: 10 });
  assert.deepEqual(
    first.slice(0, 3).map((a) => a.kind),
    ["widen_window", "cross_check_contradiction", "search_identifier"],
  );
  assert.equal(
    first.find((a) => a.kind === "search_identifier")!.detail,
    "shipment_code=SPX-D",
    "an identifier already searched is not planned",
  );
  assert.ok(first.some((a) => a.kind === "resolve_deployed_version"));
  const second = planNextActions({
    ...input,
    max: 10,
    done: new Set(first.map((a) => a.fingerprint)),
  });
  assert.deepEqual(second, []);
});

test("stop rule: disabled (shadow), sufficient, blocked, budget, no progress; the signature ignores order", () => {
  const base = {
    enabled: true,
    round: 1,
    maxRounds: 3,
    queriesUsed: 2,
    queryBudget: 25,
    outcome: "PROBABLE" as const,
    signature: "x",
    previousSignature: null,
    actions: [{ kind: "find_event" as const, detail: "d", fingerprint: "f" }],
  };
  assert.equal(stopReason(base), null);
  assert.equal(stopReason({ ...base, enabled: false }), "disabled");
  assert.equal(stopReason({ ...base, outcome: "CONFIRMED" }), "sufficient_evidence");
  assert.equal(stopReason({ ...base, outcome: "BLOCKED" }), "blocked");
  assert.equal(stopReason({ ...base, queriesUsed: 25 }), "query_budget");
  assert.equal(stopReason({ ...base, previousSignature: "x" }), "no_progress");
  assert.equal(stopReason({ ...base, actions: [] }), "no_remaining_actions");
  const hs = evaluateHypotheses(proposals, {
    knownRefs: known,
    runtimeRefs: runtime,
    repositories: new Set(["oms-background"]),
  });
  assert.equal(
    progressSignature({ refs: ["b", "a"], hypotheses: hs, missing: ["y", "x"] }),
    progressSignature({
      refs: ["a", "b", "a"],
      hypotheses: [...hs].reverse(),
      missing: ["x", "y"],
    }),
  );
});

test("one-pass vs iterative on the fixture: the second round closes the gap without inflating the conclusion", () => {
  const ctx = { knownRefs: known, runtimeRefs: runtime, repositories: new Set(["oms-background"]) };
  // one pass: the findings cite events only by narrative and fabricated refs, the window misses the latest request
  const onePass = evaluateHypotheses(
    {
      hypotheses: [
        {
          id: "H1",
          kind: "causal_origin",
          statement: "phone not normalised",
          supporting_refs: ["S9:9"],
        },
      ],
    },
    ctx,
  );
  const r1 = rootCauseOutcome({
    hypotheses: onePass,
    impact: impactCounts([], []),
    deployed: [],
    blocked: false,
  });
  // iterative: round 2 resolved the refs, the code path and the impact; the deployed commit is still unknown
  const r2 = rootCauseOutcome({
    hypotheses: evaluateHypotheses(proposals, ctx),
    impact: impactCounts(timeline, searchCoverage(searches)),
    deployed: [],
    blocked: false,
  });
  assert.deepEqual([r1.outcome, r2.outcome], ["UNKNOWN", "PROBABLE"]);
});

test("PII in agent text is redacted before it is persisted or rendered", () => {
  const s = sanitizeText("receiver phone 0912345678 rejected by SPX 13101");
  assert.doesNotMatch(s, /0912345678/);
});
