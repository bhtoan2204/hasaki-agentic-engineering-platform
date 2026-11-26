import { test } from "node:test";
import assert from "node:assert/strict";
import {
  age,
  canForce,
  newerNote,
  resultCount,
  runner,
  sharedState,
  sharedTone,
  staleReasons,
  type SharedView,
} from "../web/src/sharedAnalysis.ts";
import { messages } from "../shared/i18n/messages.ts";

const view = (over: Partial<SharedView> = {}): SharedView => ({
  outcome: "read",
  analysis_id: 1,
  kind: "code_assessment",
  version: 1,
  status: "valid",
  freshness: {
    analysed_at: "2026-11-26T10:00:00Z",
    age_seconds: 7200,
    valid_until: "2026-12-26T10:00:00Z",
    expired: false,
    stale_reason: null,
  },
  run_by: { id: 2, name: "alice", is_you: false },
  provenance: {
    trigger: "manual",
    started_at: null,
    finished_at: null,
    duration_ms: null,
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
  },
  reuse: { count: 3, last_at: null },
  ...over,
});

test("state: valid, someone else running, you running, failed, superseded", () => {
  assert.equal(sharedState(view()), "valid");
  assert.equal(sharedState(view({ status: "running" })), "running_other");
  assert.equal(
    sharedState(view({ status: "running", run_by: { id: 1, name: "me", is_you: true } })),
    "running_you",
  );
  assert.equal(sharedState(view({ status: "failed" })), "failed");
  assert.equal(sharedState(view({ status: "superseded" })), "superseded");
  assert.deepEqual(
    ["valid", "running_other", "failed", "stale"].map((s) => sharedTone(s as never)),
    ["ok", "run", "err", "wait"],
  );
});

test("stale is shown, never hidden: a stale row, and a valid row past its end, both read as stale with their reasons", () => {
  const stale = view({
    status: "stale",
    freshness: {
      ...view().freshness,
      stale_reason: "commit_changed:oms-api,payment;model_changed",
    },
  });
  assert.equal(sharedState(stale), "stale");
  assert.deepEqual(staleReasons(stale), [
    { key: "sr.reason.commit_changed", repos: "oms-api, payment" },
    { key: "sr.reason.model_changed" },
  ]);
  const expired = view({ freshness: { ...view().freshness, expired: true } });
  assert.equal(sharedState(expired), "stale");
  assert.deepEqual(staleReasons(expired), [{ key: "sr.reason.ttl" }]);
  for (const r of [
    "ttl",
    "commit_changed",
    "definition_changed",
    "rubric_changed",
    "model_changed",
    "contract_changed",
  ])
    assert.ok(messages.vi[`sr.reason.${r}`] && messages.en[`sr.reason.${r}`], r);
});

test("re-run is offered for a settled result (valid, stale, failed), never beside a running one", () => {
  assert.equal(canForce(view()), true);
  assert.equal(canForce(view({ status: "stale" })), true);
  assert.equal(canForce(view({ status: "failed" })), true);
  assert.equal(canForce(view({ status: "running" })), false);
});

test("the runner: a name only when the API gives one; 'you' for the reader's own; otherwise no one is named", () => {
  assert.deepEqual(runner(view()), { key: "sr.runBy", name: "alice" });
  assert.deepEqual(runner(view({ run_by: { id: 1, name: "me", is_you: true } })), {
    key: "sr.runByYou",
  });
  assert.deepEqual(runner(view({ run_by: { id: null, name: null } })), { key: "sr.runByMember" });
});

test("age and result size", () => {
  assert.deepEqual(age(42), { n: 42, unit: "s" });
  assert.deepEqual(age(7200), { n: 2, unit: "h" });
  assert.deepEqual(age(3 * 86_400 + 5), { n: 3, unit: "d" });
  assert.equal(age(null), null);
  assert.equal(resultCount({ findings: [1, 2] }), 2);
  assert.equal(resultCount({ report: "x" }), null);
  assert.equal(resultCount(null), null);
});

test("every state label exists in both locales", () => {
  for (const s of ["running_other", "running_you", "valid", "stale", "failed", "superseded"])
    for (const l of ["vi", "en"] as const) assert.ok(messages[l][`sr.state.${s}`], `${l} ${s}`);
});

test("a re-run beside the last valid result: the note says whether it is running or failed, and both labels exist", () => {
  assert.equal(newerNote(view()), null);
  assert.equal(
    newerNote(view({ newer_version: { version: 2, status: "running" } })),
    "sr.newer.running",
  );
  assert.equal(
    newerNote(view({ newer_version: { version: 2, status: "failed" } })),
    "sr.newer.failed",
  );
  for (const l of ["vi", "en"] as const)
    for (const k of ["sr.newer.running", "sr.newer.failed"]) assert.ok(messages[l][k], `${l} ${k}`);
  assert.equal(
    sharedState(view({ newer_version: { version: 2, status: "running" } })),
    "valid",
    "still a valid result",
  );
});
