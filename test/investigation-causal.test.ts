import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, type LogEvent } from "../src/investigation/events.ts";
import { correlate, type EventLabel } from "../src/investigation/correlate.ts";
import { analyzeCausality } from "../src/investigation/causal.ts";

const TZ = "Asia/Ho_Chi_Minh";

function build(rows: Array<Record<string, unknown>>, labels: Array<[number, string]>, anchors: string[]) {
  const events = new Map<string, LogEvent>();
  rows.forEach((r, i) => {
    const e = normalizeEvent(r, i + 1, 1, TZ);
    events.set(e.ref, e);
  });
  const ls: EventLabel[] = labels.map(([i, t]) => ({ evidence_ref: `S1:${i}`, event_type: t }));
  return correlate({ events, labels: ls, anchors });
}

// Synthetic data only: fake identifiers, mocked provider responses.
const row = (time: string, service: string, message: string, ids: Record<string, string>) => ({
  _time: time,
  service,
  message,
  _raw: JSON.stringify({ message, ...ids }),
});

const refundRows = [
  row("2026-11-10T09:00:00+07:00", "payment-api", "refund request sent to gateway", { request_id: "req-aaa111", business_ref: "RF-100200", idempotency_key: "idem-100200" }),
  row("2026-11-10T09:00:30+07:00", "payment-api", "refund call failed: context deadline exceeded", { request_id: "req-aaa111", business_ref: "RF-100200" }),
  row("2026-11-10T09:05:00+07:00", "payment-api", "retry refund request sent to gateway", { request_id: "req-bbb222", business_ref: "RF-100200" }),
  row("2026-11-10T09:05:02+07:00", "payment-api", "gateway rejected refund: Too many refund count (>0)", { request_id: "req-bbb222", business_ref: "RF-100200" }),
  // unrelated error close in time, different business identifier
  row("2026-11-10T09:05:01+07:00", "shipping-api", "label generation failed: context deadline exceeded", { request_id: "req-zzz999", business_ref: "RF-999888" }),
];

test("VNPay-style refund: attempts join one logical operation, outcome stays UNKNOWN", () => {
  const c = build(refundRows, [[1, "PARTNER_REQUEST_SENT"], [2, "REQUEST_TIMEOUT"], [3, "PARTNER_REQUEST_SENT"], [4, "PROVIDER_BUSINESS_REJECTION"], [5, "ERROR"]], ["RF-100200"]);
  const a = analyzeCausality(c.timeline);
  const op = a.operations.find((o) => o.attempts.length === 2)!;
  assert.ok(op, "attempts A and B share one logical operation");
  assert.deepEqual(op.attempts.map((x) => x.attempt_key), ["req-aaa111", "req-bbb222"]);
  assert.equal(op.attempts[0].outcome, "UNKNOWN");
  assert.equal(op.attempts[0].role, "initial");
  assert.equal(op.attempts[1].role, "retry");
  assert.equal(op.attempts[1].outcome, "failed");
  assert.equal(op.outcome, "UNKNOWN");
  assert.ok(op.missing_evidence.length >= 3);
  assert.ok(op.joined_by.some((j) => j.field === "business_ref" && j.evidence_refs.length >= 2));
});

test("VNPay-style refund: root cause is the retry design, not the provider; no unsafe advice", () => {
  const c = build(refundRows, [[1, "PARTNER_REQUEST_SENT"], [2, "REQUEST_TIMEOUT"], [3, "PARTNER_REQUEST_SENT"], [4, "PROVIDER_BUSINESS_REJECTION"]], ["RF-100200"]);
  const a = analyzeCausality(c.timeline);
  assert.match(a.chain.root_cause ?? "", /without first resolving the unknown outcome/);
  assert.doesNotMatch(a.chain.root_cause ?? "", /vnpay|provider (is|caused)/i);
  assert.match(a.chain.downstream_effects.join(" "), /not proof/);
  assert.ok(a.patterns.includes("client_timeout_unknown_outcome"));
  assert.ok(a.patterns.includes("duplicate_retry"));
  const rec = a.recommendations.join(" ");
  assert.match(rec, /authoritative provider status/);
  assert.match(rec, /Block creating another attempt/);
  assert.doesNotMatch(rec, /re-?issue the refund|set status to success/i);
  assert.ok(a.has_unknown_outcome);
});

test("unrelated error near the same time is not merged by proximity", () => {
  const c = build(refundRows, [[1, "PARTNER_REQUEST_SENT"], [2, "REQUEST_TIMEOUT"], [5, "ERROR"]], []);
  const a = analyzeCausality(c.timeline);
  assert.equal(a.operations.length, 2);
  for (const op of a.operations) assert.equal(op.attempts.length, 1);
});

test("engine is not payment-specific: shipment retries with different request ids join via shipment_id", () => {
  const rows = [
    row("2026-11-10T09:00:00+07:00", "wms", "carrier request sent", { request_id: "req-s-1111", shipment_id: "SHP-778899" }),
    row("2026-11-10T09:01:00+07:00", "wms", "carrier request sent again", { request_id: "req-s-2222", shipment_id: "SHP-778899" }),
  ];
  const c = build(rows, [[1, "PARTNER_REQUEST_SENT"], [2, "PARTNER_REQUEST_SENT"]], ["SHP-778899"]);
  const a = analyzeCausality(c.timeline);
  assert.equal(a.operations.length, 1);
  assert.equal(a.operations[0].attempts.length, 2);
});

test("a confirmed success on a later attempt after a failed first attempt is success, not UNKNOWN", () => {
  const rows = [
    row("2026-11-10T09:00:00+07:00", "pay", "charge request sent", { request_id: "req-c-1111", transaction_code: "TX-123456" }),
    row("2026-11-10T09:00:01+07:00", "pay", "gateway rejected: duplicate request", { request_id: "req-c-1111", transaction_code: "TX-123456" }),
    row("2026-11-10T09:01:00+07:00", "pay", "charge request sent", { request_id: "req-c-2222", transaction_code: "TX-123456" }),
    row("2026-11-10T09:01:01+07:00", "pay", "charge completed success", { request_id: "req-c-2222", transaction_code: "TX-123456" }),
  ];
  const c = build(rows, [[1, "PARTNER_REQUEST_SENT"], [2, "PROVIDER_BUSINESS_REJECTION"], [3, "PARTNER_REQUEST_SENT"], [4, "PARTNER_RESPONSE_RECEIVED"]], ["TX-123456"]);
  const a = analyzeCausality(c.timeline);
  assert.equal(a.operations[0].outcome, "success");
  assert.equal(a.has_unknown_outcome, false);
});
