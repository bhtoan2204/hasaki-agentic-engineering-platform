/**
 * RCA benchmark correctness (P1): incidents are deterministic per seed but vary across seeds, several share a symptom
 * with different root causes, the question never carries the answer, and the RCA grader separates a valid diagnosis
 * from symptom-as-cause, misleading-signal, false-confirmation, missing-source, wrong-correlation and symptom-fix
 * answers. Pure (no database).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateIncident,
  gradeRca,
  rcaTasks,
  SCENARIOS,
  type GroundTruth,
} from "../src/eval/rcaIncidents.ts";

const right = (t: GroundTruth, over: Record<string, unknown> = {}) => ({
  root_cause_service: t.root_cause_service,
  root_cause_operation: t.root_cause_operation,
  cause: t.cause,
  status: t.max_status,
  affected_orders: t.affected_orders,
  missing_sources: t.unavailable,
  next_actions: [`inspect ${t.root_cause_service}`],
  ...over,
});

test("incidents are deterministic per seed and vary across seeds", () => {
  for (const s of SCENARIOS) {
    assert.deepEqual(generateIncident(s, 3), generateIncident(s, 3), s);
    const a = generateIncident(s, 1);
    const b = generateIncident(s, 2);
    assert.notDeepEqual(
      a.logs.map((l) => l.order_id),
      b.logs.map((l) => l.order_id),
      `${s}: different orders`,
    );
  }
  const counts = new Set(
    [1, 2, 3, 4, 5].map((seed) => generateIncident("provider-timeout", seed).truth.affected_orders),
  );
  assert.ok(counts.size > 1, "the affected count is not a constant to memorize");
});

test("the same symptom has different root causes across scenarios", () => {
  const sameSymptom = SCENARIOS.map((s) => generateIncident(s, 1)).filter((i) =>
    /time out at payment-gateway/.test(i.symptom),
  );
  const causes = new Set(sameSymptom.map((i) => `${i.truth.root_cause_service}/${i.truth.cause}`));
  assert.ok(sameSymptom.length >= 5);
  assert.ok(causes.size >= 4, [...causes].join(", "));
});

test("questions never contain the root-cause operation or cause", () => {
  for (const t of rcaTasks([1, 2])) {
    const truth = t.reference!() as unknown as GroundTruth;
    assert.ok(!t.question.includes(truth.root_cause_operation), `${t.id} leaks the operation`);
    assert.ok(!t.question.includes(`"${truth.cause}"`), `${t.id} leaks the cause`);
  }
});

test("a valid diagnosis passes every dimension", () => {
  for (const s of SCENARIOS) {
    const t = generateIncident(s, 1).truth;
    const g = gradeRca(t, right(t));
    assert.equal(g.correct, true, `${s}: ${JSON.stringify(g.diagnostics)}`);
  }
});

test("invalid diagnoses are rejected, each for its own reason", () => {
  const t = generateIncident("misleading-warnings", 1).truth;
  const symptom = gradeRca(
    t,
    right(t, { root_cause_service: "payment-gateway", root_cause_operation: "gateway.refund" }),
  );
  assert.equal(symptom.correct, false);
  assert.equal(symptom.rca.symptom_as_cause, true);
  const misled = gradeRca(
    t,
    right(t, {
      root_cause_service: "refund-worker",
      root_cause_operation: "refund.db.acquire",
      cause: "db_pool_saturation",
    }),
  );
  assert.equal(misled.correct, false);
  assert.equal(misled.rca.misleading_signal_taken, true);
  assert.equal(misled.rca.false_confirmation, true, "a wrong diagnosis stated as CONFIRMED");
  const count = gradeRca(t, right(t, { affected_orders: t.affected_orders + 1 }));
  assert.equal(count.correct, false);
  assert.equal(count.rca.correlation, false);
  const fix = gradeRca(t, right(t, { next_actions: ["increase the provider timeout to 30 s"] }));
  assert.equal(fix.correct, false);
  assert.equal(fix.rca.unsafe_next_action, true);
  assert.equal(gradeRca(t, null).answered, false);
});

test("an outage caps confirmation and must be reported", () => {
  const t = generateIncident("partial-outage", 1).truth;
  assert.deepEqual(t.unavailable, ["rca.traces"]);
  assert.equal(t.max_status, "PROBABLE");
  const confirmed = gradeRca(t, right(t, { status: "CONFIRMED" }));
  assert.equal(confirmed.correct, false);
  assert.equal(confirmed.rca.false_confirmation, true);
  const unreported = gradeRca(t, right(t, { missing_sources: [] }));
  assert.equal(unreported.correct, false);
  assert.equal(unreported.rca.missing_sources_reported, false);
  assert.equal(gradeRca(t, right(t)).correct, true);
});

test("a pool-size action is acceptable only when pool saturation is the real cause", () => {
  const pool = generateIncident("db-pool-saturation", 1).truth;
  assert.equal(
    gradeRca(pool, right(pool, { next_actions: ["increase the pool size of refund-worker"] }))
      .correct,
    true,
  );
  const prov = generateIncident("provider-timeout", 1).truth;
  assert.equal(
    gradeRca(prov, right(prov, { next_actions: ["increase the pool size of refund-worker"] }))
      .correct,
    false,
  );
});
