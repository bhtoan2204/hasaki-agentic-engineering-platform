import test from "node:test";
import assert from "node:assert/strict";
import { reconcile, inputsHash, causalityLevel, type EvidenceItem, type SourceRun } from "../src/incidents/reconcile.ts";

const loc = (file = "svc/order.go", line = 40, fn: string | null = "CreateOrder") => ({
  repository: "orders",
  file,
  line_start: line,
  line_end: line + 5,
  function: fn,
});
const finding = (o: Partial<EvidenceItem> = {}): EvidenceItem => ({
  ref: "bug_hunt:1:finding:1",
  source: "bug_hunt",
  run_id: 10,
  kind: "code_defect",
  statement: "nil_deref: shipment nil when partner returns 204",
  location: loc(),
  commit: "a".repeat(40),
  bug_verification: "CONFIRMED",
  causality: "UNKNOWN",
  refs: ["verify#1"],
  target: { hunt_id: 1, finding_id: 1 },
  valid: true,
  ...o,
});
const hyp = (o: Partial<EvidenceItem> = {}): EvidenceItem => ({
  ref: "run:20:hypothesis:H1",
  source: "runtime",
  run_id: 20,
  kind: "runtime_hypothesis",
  statement: "nil shipment dereference in CreateOrder after 204 from partner",
  location: { repository: "orders", file: "svc/order.go", line_start: 44, line_end: 44, function: null },
  commit: null,
  hypothesis_status: "SUPPORTED",
  hypothesis_kind: "causal_origin",
  run_outcome: "CONFIRMED",
  refs: ["splunk:1:3"],
  target: { run_id: 20 },
  valid: true,
  ...o,
});
const hunt: SourceRun = { run_id: 10, kind: "bug_hunt", run_status: "COMPLETED", outcome: "completed", missing: [] };
const runtime: SourceRun = { run_id: 20, kind: "runtime", run_status: "COMPLETED", outcome: "CONFIRMED", missing: [] };

test("a confirmed bug is not a confirmed root cause: UNKNOWN causality, listed as a verified defect", () => {
  const r = reconcile([finding()], [hunt]);
  assert.equal(r.status, "UNKNOWN");
  assert.equal(r.verified_defects.length, 1);
  assert.equal(r.causes[0].level, "unknown");
  assert.equal(r.causes[0].defect, "CONFIRMED");
  assert.ok(r.missing_evidence.some((m) => /caused this incident/.test(m)));
  assert.ok(r.next_actions.some((a) => a.kind === "run_runtime"), "suggests (never starts) a runtime RCA");
  // A verified defect may still be fixed, marked as such.
  assert.ok(r.next_actions.some((a) => a.kind === "create_fix" && /causality not proven/.test(a.detail)));
});

test("same cause from both workflows is deduplicated, and agreement does not raise the level", () => {
  const probableHunt = finding({ causality: "PROBABLE" });
  const probableRuntime = hyp({ run_outcome: "PROBABLE" });
  const r = reconcile([probableHunt, probableRuntime], [hunt, { ...runtime, outcome: "PROBABLE" }]);
  assert.equal(r.causes.length, 1, "one cause, two sources");
  assert.deepEqual(r.causes[0].sources.sort(), ["bug_hunt", "runtime"]);
  assert.equal(r.causes[0].level, "probable", "two PROBABLE never make a CONFIRMED");
  assert.equal(r.status, "PROBABLE");
});

test("runtime CONFIRMED causal origin + verified defect at the same location → CONFIRMED", () => {
  const r = reconcile([finding(), hyp()], [hunt, runtime]);
  assert.equal(r.status, "CONFIRMED");
  assert.equal(r.causes[0].defect, "CONFIRMED");
  assert.equal(r.causes[0].fix_target?.finding_id, 1, "the fix goes through the verified finding");
});

test("contradiction between workflows → CONFLICTED, not averaged", () => {
  const r = reconcile([finding({ causality: "NOT_SUPPORTED" }), hyp()], [hunt, runtime]);
  assert.equal(r.status, "CONFLICTED");
  assert.equal(r.conflicts.length, 1);
  assert.ok(r.next_actions.some((a) => a.kind === "resolve_conflict"));
});

test("two different causes each confirmed → CONFLICTED", () => {
  const other = finding({
    ref: "bug_hunt:1:finding:2",
    location: loc("svc/payment.go", 10, "Charge"),
    causality: "CONFIRMED",
    target: { hunt_id: 1, finding_id: 2 },
  });
  const r = reconcile([other, hyp()], [hunt, runtime]);
  assert.equal(r.status, "CONFLICTED");
  assert.match(r.conflicts[0].detail, /competing confirmed root causes/);
});

test("stale evidence cannot confirm; invalid evidence is excluded and reported", () => {
  assert.equal(causalityLevel(hyp({ stale: true })), "probable");
  const r = reconcile(
    [hyp({ stale: true }), finding({ ref: "bug_hunt:9:finding:9", valid: false, invalid_reason: "repository not accessible to the workspace owner" })],
    [runtime],
  );
  assert.equal(r.status, "PROBABLE");
  assert.deepEqual(r.excluded.map((x) => x.ref), ["bug_hunt:9:finding:9"]);
  assert.equal(r.verified_defects.length, 0, "an excluded finding never counts as a verified defect");
});

test("provider/config cause without a code location is never a code fix", () => {
  const provider = hyp({
    ref: "run:20:hypothesis:H2",
    statement: "partner API returned 503 during maintenance window",
    location: null,
    run_outcome: "PROBABLE",
  });
  const r = reconcile([provider], [{ ...runtime, outcome: "PROBABLE" }]);
  assert.equal(r.status, "PROBABLE");
  assert.equal(r.causes[0].code_fixable, false);
  assert.ok(!r.next_actions.some((a) => a.kind === "create_fix"));
});

test("all sources blocked or failed → BLOCKED; nothing finished → UNKNOWN", () => {
  assert.equal(reconcile([], [{ ...runtime, outcome: "BLOCKED" }, { ...hunt, run_status: "FAILED", outcome: "failed" }]).status, "BLOCKED");
  const r = reconcile([], [{ ...runtime, run_status: "RUNNING", outcome: null }]);
  assert.equal(r.status, "UNKNOWN");
  assert.match(r.reasons[0], /no investigation has finished/);
});

test("an existing fix run for a cause suppresses a second create_fix", () => {
  const items = [finding(), hyp()];
  const first = reconcile(items, [hunt, runtime]);
  const key = first.causes[0].key;
  const r = reconcile(items, [hunt, runtime, { run_id: 30, kind: "fix", run_status: "RUNNING", outcome: null, missing: [], cause_key: key }]);
  assert.ok(!r.next_actions.some((a) => a.kind === "create_fix" && a.cause === key));
});

test("inputs hash: order-independent, sensitive to verdicts, validity and run state", () => {
  const a = inputsHash([finding(), hyp()], [hunt, runtime]);
  assert.equal(a, inputsHash([hyp(), finding()], [runtime, hunt]));
  assert.notEqual(a, inputsHash([finding({ causality: "PROBABLE" }), hyp()], [hunt, runtime]));
  assert.notEqual(a, inputsHash([finding({ stale: true }), hyp()], [hunt, runtime]));
  assert.notEqual(a, inputsHash([finding(), hyp()], [hunt, { ...runtime, run_status: "RUNNING" }]));
});
