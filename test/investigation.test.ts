import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRequest,
  extractIdentifiers,
  scoreTriggers,
  detectLanguage,
} from "../src/investigation/request.ts";
import {
  formatDuration,
  formatInZone,
  parseObservedTime,
  parseTimeModifier,
  zonedToEpochMs,
} from "../src/investigation/time.ts";
import {
  normalizeEvent,
  parsePastedResults,
  sanitizeText,
  compactEvent,
  type LogEvent,
} from "../src/investigation/events.ts";
import {
  computeLatencies,
  correlate,
  evaluateCompleteness,
  type EventLabel,
} from "../src/investigation/correlate.ts";
import { buildReport, validateFindings } from "../src/investigation/report.ts";
import { routeWorkflow } from "../src/investigation/service.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec } from "../src/workflow/graph.ts";
import * as F from "../src/investigation/fixtures.ts";

const TZ = "Asia/Ho_Chi_Minh";
const NOW = Date.parse("2026-11-10T10:00:00+07:00");
const opts = { timezone: TZ, maxMinutes: 7 * 24 * 60, now: NOW };

function fixtureEvents(searches = F.FIXTURE_SEARCHES) {
  const events = new Map<string, LogEvent>();
  for (const s of searches)
    s.rows.forEach((r, i) => {
      const e = normalizeEvent(r, i, s.id, TZ);
      events.set(e.ref, e);
    });
  return events;
}
const ev = (ref: string, time: string, raw: Record<string, unknown>, container = "svc") =>
  normalizeEvent(
    {
      _time: time,
      index: "k8s_prod",
      "kubernetes.container_name": container,
      _raw: JSON.stringify(raw),
    },
    Number(ref.split(":")[1]),
    ref.slice(1).split(":")[0],
    TZ,
  );
const mapOf = (...e: LogEvent[]) => new Map(e.map((x) => [x.ref, x]));

// ---------------------------------------------------------------- request parsing

test("Vietnamese request: order code, approximate time window in Asia/Ho_Chi_Minh, candidate service, objectives", () => {
  const p = parseRequest(F.REQUEST_VI, opts);
  assert.equal(p.language, "vi");
  assert.deepEqual(p.identifiers, [{ type: "order_code", value: F.ORDER, hint: "don hang" }]);
  assert.equal(p.time.anchor, "2026-11-10T08:48:00+07:00");
  assert.equal(p.time.earliest, "2026-11-10T08:33:00+07:00");
  assert.equal(p.time.latest, "2026-11-10T09:18:00+07:00");
  assert.equal(p.time.approximate, true);
  assert.deepEqual(
    p.services.map((s) => s.name),
    ["HasakiNOW"],
  );
  assert.deepEqual(p.objectives, [
    "outbound_message",
    "partner_response_latency",
    "tracking_info",
    "shipping_label_time",
  ]);
  assert.ok(p.questions.length >= 2);
});

test("English request parses the same entity, window and objectives", () => {
  const p = parseRequest(F.REQUEST_EN, opts);
  assert.equal(p.language, "en");
  assert.equal(p.anchors[0], F.ORDER);
  assert.equal(p.time.anchor, "2026-11-10T08:48:00+07:00");
  assert.deepEqual(p.objectives, parseRequest(F.REQUEST_VI, opts).objectives);
});

test("Vietnamese variants: tracking number, 'hôm qua', 14h30, giờ/phút, no time at all", () => {
  const a = parseRequest(
    "Truy vết mã vận đơn NOW-TRK-0091827 hôm qua lúc 14h30, xem callback",
    opts,
  );
  assert.deepEqual(
    a.identifiers.map((i) => [i.type, i.value]),
    [["tracking_no", "NOW-TRK-0091827"]],
  );
  assert.equal(a.time.anchor, "2026-11-09T14:30:00+07:00");
  assert.ok(a.objectives.includes("callback_time"));
  const b = parseRequest(
    "Kiểm tra log đơn hàng 2611095VL160RW01 lúc 8 giờ 48 phút sáng ngày 10 tháng 11 năm 2026",
    opts,
  );
  assert.equal(b.time.anchor, "2026-11-10T08:48:00+07:00");
  const c = parseRequest("Kiểm tra log đơn hàng 2611095VL160RW01", opts);
  assert.equal(c.time.assumed, true, "no time: last 24h, flagged as assumed");
  assert.equal(c.time.latest, "2026-11-10T10:00:00+07:00");
  const d = parseRequest("Đơn 2611095VL160RW01 ngày 10/11", opts);
  assert.equal(d.time.earliest, "2026-11-10T00:00:00+07:00", "dd/mm, year assumed, whole day");
  assert.ok(d.time.notes.some((n) => /năm/.test(n)));
  assert.equal(detectLanguage("Xem thời gian NOW phản hồi"), "vi");
  assert.deepEqual(
    extractIdentifiers("request id 3f2a9c1e-1111-4222-8333-444455556666 at 10:00").map(
      (i) => i.type,
    ),
    ["request_id"],
  );
  assert.deepEqual(
    extractIdentifiers("at 2026 and 08:48, 10h30"),
    [],
    "years and clock times are not identifiers",
  );
});

// ---------------------------------------------------------------- time

test("timestamps: offsets normalised to Asia/Ho_Chi_Minh, precision and original text preserved", () => {
  const z = parseObservedTime("2026-11-10T01:48:00.135Z", TZ)!;
  assert.equal(z.iso, "2026-11-10T08:48:00.135+07:00");
  assert.equal(z.precision, "ms");
  assert.equal(z.original, "2026-11-10T01:48:00.135Z");
  const us = parseObservedTime("2026-11-10T08:48:00.135123+07:00", TZ)!;
  assert.equal(us.precision, "us");
  assert.equal(us.iso, "2026-11-10T08:48:00.135123+07:00");
  const epoch = parseObservedTime("1794278880.5", TZ)!;
  assert.equal(epoch.iso, "2026-11-10T09:48:00.500+07:00");
  assert.equal(epoch.precision, "ms");
  const s = parseObservedTime("11/10/2026:08:48:00", TZ)!;
  assert.equal(s.assumed_timezone, true);
  assert.equal(s.precision, "s");
  assert.equal(s.iso, "2026-11-10T08:48:00+07:00");
  assert.equal(parseObservedTime("yesterday-ish", TZ), null, "unparseable time is never invented");
  assert.equal(
    zonedToEpochMs("Asia/Ho_Chi_Minh", 2026, 11, 10, 8, 48),
    Date.parse("2026-11-10T01:48:00Z"),
  );
  assert.equal(
    formatInZone(Date.parse("2026-11-10T01:48:00Z") * 1000, "UTC", "s"),
    "2026-11-10T01:48:00+00:00",
  );
  assert.equal(
    parseTimeModifier("-15m@m", TZ, Date.parse("2026-11-10T03:00:30Z")),
    Date.parse("2026-11-10T02:45:00Z"),
  );
  assert.equal(formatDuration(1_267_000, "ms"), "1.267 s");
  assert.equal(formatDuration(76_643_000, "ms"), "1 min 16.643 s");
  assert.equal(formatDuration(744_000, "ms"), "744 ms");
});

// ---------------------------------------------------------------- redaction

test("evidence redaction: customer PII, credentials and signed URL parameters never survive normalisation", () => {
  const e = fixtureEvents();
  const req = e.get(F.refOf(101, "2026-11-10T08:48:00.135+07:00"))!;
  assert.doesNotMatch(req.raw, /Nguyen Van A|0912345678|Ly Thuong Kiet|sk_live_/);
  assert.match(req.raw, /"receiver_phone":"\*\*\*"/);
  assert.match(req.raw, /"order_code":"2611095VL160RW01"/, "identifiers are kept");
  assert.equal(req.ids.request_id?.[0], "req-7f3a91");
  const label = e.get(F.refOf(101, "2026-11-10T08:49:18.044+07:00"))!;
  assert.match(label.raw, /X-Amz-Signature=\*\*\*/);
  assert.doesNotMatch(label.raw, /abcdef1234567890/);
  const cb = e.get(F.refOf(102, "2026-11-10T08:49:16.778+07:00"))!;
  assert.doesNotMatch(cb.raw, /0987654321/);
  assert.equal(cb.ids.tracking_no?.[0], F.TRACKING);
  assert.equal(
    sanitizeText("phone=0912345678 password=hunter22 order_code=ABC123456"),
    'phone="***" password="***" order_code=ABC123456',
  );
  const compact = compactEvent(req) as any;
  assert.equal(compact.raw, undefined, "model-facing view carries no raw text");
  // an id that would look like a card number is extracted before masking
  const card = ev("S1:0", "2026-11-10T08:00:00+07:00", {
    shipment_id: "4111111111111111",
    note: "ref 4111111111111111",
  });
  assert.equal(card.ids.shipment_id?.[0], "4111111111111111");
  assert.doesNotMatch(card.raw.replace(/"shipment_id":"4111111111111111"/, ""), /4111111111111111/);
});

test("pasted results: Splunk JSON, JSON lines (export) and CSV; garbage is refused", () => {
  assert.equal(
    parsePastedResults(JSON.stringify({ results: [{ _time: "1", _raw: "a" }] })).length,
    1,
  );
  assert.equal(
    parsePastedResults(
      '{"preview":false,"result":{"_time":"1","_raw":"a"}}\n{"preview":false,"result":{"_time":"2","_raw":"b"}}',
    ).length,
    2,
  );
  const csv = parsePastedResults('_time,_raw\n2026-11-10T08:48:00.135+07:00,"x, ""quoted"""\n');
  assert.equal(csv[0]._raw, 'x, "quoted"');
  assert.throws(() => parsePastedResults("hello world"), /CSV/);
});

// ---------------------------------------------------------------- correlation

test("cross-service correlation of the HasakiNOW case: timeline in time order, links by identifiers, duplicates folded", () => {
  const p = parseRequest(F.REQUEST_VI, opts);
  const c = correlate({ events: fixtureEvents(), labels: F.goodLabels(), anchors: p.anchors });
  const types = c.timeline.map((t) => t.event_type);
  assert.deepEqual(
    types,
    [
      "OUTBOUND_MESSAGE_CREATED",
      "MESSAGE_PUBLISHED",
      "MESSAGE_CONSUMED",
      "PARTNER_REQUEST_SENT",
      "PARTNER_RESPONSE_RECEIVED",
      "MESSAGE_CONSUMED",
      "PARTNER_CALLBACK_RECEIVED",
      "TRACKING_NUMBER_PERSISTED",
      "SHIPPING_LABEL_REQUESTED",
      "SHIPPING_LABEL_URL_GENERATED",
      "SHIPPING_LABEL_URL_PERSISTED",
    ],
    "out-of-order rows are sorted by the logged time",
  );
  const sorted = [...c.timeline].sort((a, b) => a.epoch_us! - b.epoch_us!);
  assert.deepEqual(
    c.timeline.map((t) => t.evidence_ref),
    sorted.map((t) => t.evidence_ref),
  );
  const cb = c.timeline.find((t) => t.event_type === "PARTNER_CALLBACK_RECEIVED")!;
  assert.equal(
    cb.confidence,
    "inferred",
    "the callback has no order code: tied through shipment_id only",
  );
  assert.equal(cb.link.kind, "transitive");
  const req = c.timeline.find((t) => t.event_type === "PARTNER_REQUEST_SENT")!;
  assert.equal(req.confidence, "confirmed");
  assert.equal(req.service, "hasakinow-connector");
  const gen = c.timeline.find((t) => t.event_type === "SHIPPING_LABEL_URL_GENERATED")!;
  assert.deepEqual(
    gen.duplicates,
    [F.refOf(102, "2026-11-10T08:49:18.044+07:00")],
    "same line from two overlapping searches is one event",
  );
  const consumed = c.timeline.filter((t) => t.event_type === "MESSAGE_CONSUMED");
  assert.deepEqual(
    consumed.map((t) => t.delivery?.n),
    [1, 2],
    "Kafka redelivery is numbered, not dropped",
  );
  assert.deepEqual(c.identifiers.tracking_no, [F.TRACKING]);
  assert.ok(evaluateCompleteness(c.timeline, p.objectives).complete);
});

test("no hallucination: fabricated refs rejected, agent times ignored, unverifiable ids ignored, unrelated orders never correlated", () => {
  const p = parseRequest(F.REQUEST_EN, opts);
  const adversarialFirst = [...F.adversarialLabels(), ...F.goodLabels()];
  const c = correlate({ events: fixtureEvents(), labels: adversarialFirst, anchors: p.anchors });
  assert.deepEqual(
    c.rejected.map((r) => r.evidence_ref),
    ["S999:0"],
  );
  const req = c.timeline.find((t) => t.event_type === "PARTNER_REQUEST_SENT")!;
  assert.equal(
    req.timestamp,
    F.EXPECTED.request_sent,
    "the log time, not the agent's rounded 08:48:00",
  );
  assert.ok(req.conflicts!.some((x) => /differs from the log/.test(x)));
  assert.ok(req.conflicts!.some((x) => /NOW-TRK-FAKE/.test(x)));
  assert.equal(req.tracking_no, null, "an id the log does not contain is not attached");
  assert.deepEqual(
    c.uncorrelated.map((t) => t.evidence_ref),
    [F.EXPECTED.unrelated_ref],
  );
  const lat = computeLatencies(c.timeline, "en");
  assert.ok(
    lat.every(
      (l) =>
        l.to.evidence_ref !== F.EXPECTED.unrelated_ref &&
        l.from.evidence_ref !== F.EXPECTED.unrelated_ref,
    ),
    "another order's response 475 ms later is never paired",
  );
});

test("latency: sync response vs async callback reported separately with the compared events and qualification", () => {
  const p = parseRequest(F.REQUEST_EN, opts);
  const c = correlate({
    events: fixtureEvents(),
    labels: [...F.goodLabels(), ...F.adversarialLabels()],
    anchors: p.anchors,
  });
  const lat = computeLatencies(c.timeline, "en");
  const sync = lat.find((l) => l.key === "partner_sync_response")!;
  assert.equal(sync.latency_ms, F.EXPECTED.sync_latency_ms);
  assert.equal(sync.pairing, "request_scope_id");
  assert.deepEqual(sync.shared_ids, ["request_id=req-7f3a91"]);
  assert.equal(sync.confidence, "confirmed");
  assert.equal(sync.from.timestamp, F.EXPECTED.request_sent);
  assert.equal(sync.to.timestamp, F.EXPECTED.sync_response);
  const cbk = lat.find((l) => l.key === "partner_callback")!;
  assert.equal(cbk.latency_ms, F.EXPECTED.callback_latency_ms);
  assert.equal(cbk.pairing, "entity_id");
  assert.equal(cbk.confidence, "inferred");
  assert.match(cbk.qualification, /not the partner's pure processing time/);
  const e2e = lat.find((l) => l.key === "end_to_end_label")!;
  assert.equal(
    e2e.from.event_type,
    "OUTBOUND_MESSAGE_CREATED",
    "end to end starts at the earliest stage",
  );
  assert.match(e2e.qualification, /not the partner's processing time/);
  const broker = lat.find((l) => l.key === "broker_delivery")!;
  assert.equal(
    broker.to.evidence_ref,
    F.refOf(102, "2026-11-10T08:48:00.120+07:00"),
    "the redelivery is not measured as the broker delay",
  );
});

test("retries: each response pairs with its own attempt by request id; without ids the pairing is inferred and flagged ambiguous", () => {
  const anchors = ["ORD12345678"];
  const r1 = ev("S1:0", "2026-11-10T08:48:00.000+07:00", {
    order_code: "ORD12345678",
    request_id: "req-aaaaaa1",
  });
  const t1 = ev("S1:1", "2026-11-10T08:48:30.000+07:00", {
    order_code: "ORD12345678",
    request_id: "req-aaaaaa1",
    error: "timeout",
  });
  const r2 = ev("S1:2", "2026-11-10T08:48:35.000+07:00", {
    order_code: "ORD12345678",
    request_id: "req-bbbbbb2",
  });
  const ok2 = ev("S1:3", "2026-11-10T08:48:36.250+07:00", {
    order_code: "ORD12345678",
    request_id: "req-bbbbbb2",
    status: "ok",
  });
  const labels: EventLabel[] = [
    { evidence_ref: "S1:0", event_type: "PARTNER_REQUEST_SENT" },
    { evidence_ref: "S1:1", event_type: "ERROR" },
    { evidence_ref: "S1:2", event_type: "PARTNER_REQUEST_SENT" },
    { evidence_ref: "S1:3", event_type: "PARTNER_RESPONSE_RECEIVED" },
  ];
  const c = correlate({ events: mapOf(r1, t1, r2, ok2), labels, anchors });
  assert.deepEqual(
    c.timeline.filter((t) => t.event_type === "PARTNER_REQUEST_SENT").map((t) => t.attempt),
    [1, 2],
  );
  const [sync] = computeLatencies(c.timeline, "en");
  assert.equal(sync.from.evidence_ref, "S1:2", "the response belongs to attempt 2");
  assert.equal(sync.latency_ms, 1250);
  assert.equal(sync.attempt, 2);
  // incorrect pairing guard: a response carrying attempt 1's id is never paired with attempt 2 even though it is closer
  const late1 = ev("S1:4", "2026-11-10T08:48:40.000+07:00", {
    order_code: "ORD12345678",
    request_id: "req-aaaaaa1",
    status: "ok",
  });
  const c2 = correlate({
    events: mapOf(r1, r2, late1),
    labels: [
      labels[0],
      labels[2],
      { evidence_ref: "S1:4", event_type: "PARTNER_RESPONSE_RECEIVED" },
    ],
    anchors,
  });
  const [p2] = computeLatencies(c2.timeline, "en");
  assert.equal(p2.from.evidence_ref, "S1:0");
  assert.equal(p2.latency_ms, 40000);
  // no request ids anywhere: closest preceding attempt, inferred, ambiguity stated
  const a = ev("S2:0", "2026-11-10T09:00:00+07:00", { order_code: "ORD12345678", msg: "send" });
  const b = ev("S2:1", "2026-11-10T09:00:10+07:00", {
    order_code: "ORD12345678",
    msg: "send again",
  });
  const cb = ev("S2:2", "2026-11-10T09:01:00+07:00", {
    order_code: "ORD12345678",
    msg: "callback",
  });
  const c3 = correlate({
    events: mapOf(a, b, cb),
    labels: [
      { evidence_ref: "S2:0", event_type: "PARTNER_REQUEST_SENT" },
      { evidence_ref: "S2:1", event_type: "PARTNER_REQUEST_SENT" },
      { evidence_ref: "S2:2", event_type: "PARTNER_CALLBACK_RECEIVED" },
    ],
    anchors,
  });
  const [amb] = computeLatencies(c3.timeline, "en");
  assert.equal(amb.from.evidence_ref, "S2:1");
  assert.equal(amb.confidence, "inferred");
  assert.ok(amb.notes.some((n) => /ambiguous: 2 attempts/.test(n)));
});

test("duplicate callbacks: the first delivery is measured; clock skew and second precision are reported, never hidden", () => {
  const anchors = ["SHP99887766"];
  const req = ev("S1:0", "2026-11-10T08:00:00+07:00", {
    shipment_code: "SHP99887766",
    message_id: "m-1111111",
  });
  const cb1 = ev("S1:1", "2026-11-10T08:00:20+07:00", {
    shipment_code: "SHP99887766",
    message_id: "cb-777777",
    event: "callback",
  });
  const cb2 = ev("S1:2", "2026-11-10T08:00:50+07:00", {
    shipment_code: "SHP99887766",
    message_id: "cb-777777",
    event: "callback (retry)",
  });
  const labels: EventLabel[] = [
    { evidence_ref: "S1:0", event_type: "PARTNER_REQUEST_SENT" },
    { evidence_ref: "S1:1", event_type: "PARTNER_CALLBACK_RECEIVED" },
    { evidence_ref: "S1:2", event_type: "PARTNER_CALLBACK_RECEIVED" },
  ];
  const c = correlate({ events: mapOf(req, cb1, cb2), labels, anchors });
  const lat = computeLatencies(c.timeline, "en");
  assert.equal(lat.length, 1, "only the first delivery of a duplicated callback is measured");
  assert.equal(lat[0].latency_text, "20 s");
  assert.ok(lat[0].notes.includes("second precision only"));
  const skew = ev("S3:1", "2026-11-10T07:59:58+07:00", {
    shipment_code: "SHP99887766",
    request_id: "rq-123456",
  });
  const req2 = ev("S3:0", "2026-11-10T08:00:00+07:00", {
    shipment_code: "SHP99887766",
    request_id: "rq-123456",
  });
  const c2 = correlate({
    events: mapOf(req2, skew),
    labels: [
      { evidence_ref: "S3:0", event_type: "PARTNER_REQUEST_SENT" },
      { evidence_ref: "S3:1", event_type: "PARTNER_RESPONSE_RECEIVED" },
    ],
    anchors,
  });
  const [s] = computeLatencies(c2.timeline, "en");
  assert.equal(s.latency_ms, null);
  assert.equal(s.confidence, "unknown");
  assert.ok(s.notes.some((n) => /clock skew/.test(n)));
});

test("empty and incomplete evidence: missing objectives named with the evidence needed; label URL only observed is not a creation time", () => {
  const p = parseRequest(F.REQUEST_EN, opts);
  const none = correlate({ events: new Map(), labels: [], anchors: p.anchors });
  const comp = evaluateCompleteness(none.timeline, p.objectives, "en");
  assert.equal(comp.complete, false);
  assert.deepEqual(
    comp.missing.map((m) => m.objective),
    p.objectives,
  );
  const events = fixtureEvents();
  const bridge = {
    evidence_ref: F.refOf(101, "2026-11-10T08:47:59.812+07:00"),
    event_type: "OUTBOUND_MESSAGE_CREATED",
  };
  const lone = correlate({
    events,
    labels: [
      {
        evidence_ref: F.refOf(102, "2026-11-10T08:49:20.500+07:00"),
        event_type: "SHIPPING_LABEL_URL_PERSISTED",
      },
    ],
    anchors: p.anchors,
  });
  assert.equal(
    lone.timeline.length,
    0,
    "without an identifier path to the order the event is not correlated",
  );
  assert.equal(lone.uncorrelated.length, 1);
  const onlySeen = correlate({
    events,
    labels: [
      bridge,
      {
        evidence_ref: F.refOf(102, "2026-11-10T08:49:20.500+07:00"),
        event_type: "SHIPPING_LABEL_URL_PERSISTED",
      },
    ],
    anchors: p.anchors,
  });
  const c2 = evaluateCompleteness(onlySeen.timeline, ["shipping_label_time"], "en");
  assert.equal(c2.complete, false);
  assert.match(c2.missing[0].needed, /generation/);
});

// ---------------------------------------------------------------- report

test("report (vi): business summary answers every question from evidence; unknowns name the evidence needed", () => {
  const p = parseRequest(F.REQUEST_VI, opts);
  const c = correlate({ events: fixtureEvents(), labels: F.goodLabels(), anchors: p.anchors });
  const latencies = computeLatencies(c.timeline, "vi");
  const r = buildReport({
    locale: "vi",
    parsed: p,
    ...c,
    latencies,
    completeness: evaluateCompleteness(c.timeline, p.objectives, "vi"),
    searches: [],
    access: { connected: true, manual_pending: 0 },
  });
  assert.equal(r.status, "complete");
  assert.equal(r.summary.outbound_at, F.EXPECTED.request_sent);
  assert.match(r.summary.outbound_message!.payload!, /POST \/v1\/orders/);
  assert.doesNotMatch(r.markdown, /0912345678|Nguyen Van A|sk_live_|abcdef1234567890/);
  assert.equal(r.summary.shipping_label!.kind, "generated");
  assert.equal(r.summary.shipping_label!.at, F.EXPECTED.label_generated);
  assert.deepEqual(
    r.summary.partner_response.map((x) => [x.key, x.latency_ms]),
    [
      ["partner_sync_response", 1267],
      ["partner_callback", 76643],
    ],
  );
  assert.match(r.business_summary, /Trạng thái: Đủ bằng chứng/);
  assert.match(r.markdown, /## Dòng thời gian/);

  const empty = buildReport({
    locale: "vi",
    parsed: p,
    timeline: [],
    uncorrelated: [],
    rejected: [],
    latencies: [],
    completeness: evaluateCompleteness([], p.objectives, "vi"),
    searches: [],
    access: { connected: false, manual_pending: 1 },
  });
  assert.equal(empty.status, "blocked");
  assert.equal(empty.summary.outbound_at, null);
  assert.equal(empty.summary.shipping_label, null);
  assert.match(empty.markdown, /Không xác định — cần: log của message\/request gửi đi/);
  assert.doesNotMatch(
    empty.markdown,
    /\d{2}:\d{2}:\d{2}\.\d{3}/,
    "no timestamp appears without evidence",
  );
});

test("findings are capped by their evidence: unknown refs dropped, 'confirmed' lowered when the cited events are only inferred", () => {
  const p = parseRequest(F.REQUEST_EN, opts);
  const c = correlate({ events: fixtureEvents(), labels: F.goodLabels(), anchors: p.anchors });
  const known = new Set(c.timeline.flatMap((t) => [t.evidence_ref, ...(t.duplicates ?? [])]));
  const cbRef = F.refOf(102, "2026-11-10T08:49:16.778+07:00");
  const v = validateFindings(
    {
      findings: [
        {
          statement: "HasakiNOW called back after 76 s",
          classification: "confirmed",
          evidence_refs: [cbRef],
        },
        {
          statement: "The label was generated at 08:49:00",
          classification: "confirmed",
          evidence_refs: ["S404:1"],
        },
        {
          statement: "Request sent at 08:48:00.135",
          classification: "confirmed",
          evidence_refs: [F.refOf(101, "2026-11-10T08:48:00.135+07:00")],
        },
      ],
      hypotheses: [{ hypothesis: "driver assignment is slow", supporting_refs: ["S404:2", cbRef] }],
    },
    c.timeline,
    known,
  );
  assert.deepEqual(
    v.findings.map((f) => f.classification),
    ["inferred", "unknown", "confirmed"],
  );
  assert.deepEqual(v.findings[1].evidence_refs, []);
  assert.deepEqual(v.dropped.length, 1);
  assert.deepEqual(v.hypotheses[0].supporting_refs, [cbRef]);
});

// ---------------------------------------------------------------- workflow template & routing

test("template: registered read-only with category and triggers; read-only mode refuses state-changing steps", () => {
  const t = TEMPLATES.find((x) => x.key === "production-incident-investigation")!;
  const spec = validateSpec(t.spec);
  assert.equal(spec.name, "Production Incident Investigation");
  assert.equal(spec.category, "Operations / Debugging");
  assert.equal(spec.execution_mode, "read_only");
  assert.ok(spec.steps.every((s) => ["agent", "integration"].includes(s.type)));
  const refine = spec.steps.find((s) => s.key === "refine_search")!;
  assert.deepEqual(refine.run_if, { step: "correlate", path: "complete", equals: false });
  assert.throws(
    () =>
      validateSpec({
        ...t.spec,
        steps: [
          ...(t.spec as any).steps,
          { key: "fix", type: "coding_agent", depends_on: ["report"] },
        ],
      }),
    /read-only workflow/,
  );
});

test("intent routing: production log requests route to the investigation, ordinary coding tasks do not", () => {
  const t = (TEMPLATES.find((x) => x.key === "production-incident-investigation")!.spec as any)
    .triggers;
  const defs = [
    { key: "production-incident-investigation", name: "PII", triggers: t },
    { key: "feature-implementation", name: "FI", triggers: null },
  ];
  for (const text of [
    "Debug production issue: order 2611095VL160RW01 stuck",
    "Check Splunk logs for shipment 98765001",
    "Trace this order 2611095VL160RW01",
    "Find when the callback happened for tracking NOW-TRK-0091827",
    "Check why shipment creation was slow yesterday",
    "Kiểm tra log đơn hàng 2611095VL160RW01",
    "Truy vết vận đơn NOW-TRK-0091827",
    "Xem thời gian NOW phản hồi cho đơn 2611095VL160RW01",
    "Tìm thời điểm sinh shipping label của đơn 2611095VL160RW01",
  ])
    assert.equal(routeWorkflow(text, defs).workflow, "production-incident-investigation", text);
  for (const text of [
    "Implement a refund button on the order page",
    "Refactor the shipment repository",
    "Thêm tính năng xuất Excel đơn hàng",
    "Write tests for the label service",
    "Add a feature: retry on callback failure",
  ])
    assert.equal(routeWorkflow(text, defs).workflow, null, text);
  assert.equal(
    scoreTriggers("Implement the fix after checking splunk logs for order X", t).score > 0,
    true,
    "explicit Splunk request still routes",
  );
});

test("evaluation: synthetic HasakiNOW production-investigation benchmark passes every scenario", async () => {
  const { runTimelineBenchmark } = await import("../src/eval/investigationTimeline.ts");
  const r = runTimelineBenchmark();
  assert.deepEqual(r.failures, []);
  assert.equal(r.passed, r.scenarios);
});

test("language follows the run's chosen output locale, not the language of the request text", () => {
  // English request, Vietnamese run: notes, rejection reasons, conflicts and finding notes are Vietnamese
  const p = parseRequest("Check logs for order 2611095VL160RW01", { ...opts, locale: "vi" });
  assert.equal(p.language, "en");
  assert.match(p.time.notes.join(" "), /24 giờ gần nhất/);
  const c = correlate({
    events: fixtureEvents(),
    labels: [...F.adversarialLabels(), ...F.goodLabels()],
    anchors: p.anchors,
    locale: "vi",
  });
  assert.match(c.rejected[0].reason, /mã bằng chứng không tồn tại/);
  const req = c.timeline.find((t) => t.event_type === "PARTNER_REQUEST_SENT")!;
  assert.ok(
    req.conflicts!.every((x) => /khác log|do agent khai báo/.test(x)),
    req.conflicts!.join(" | "),
  );
  const v = validateFindings(
    { findings: [{ statement: "x", classification: "confirmed", evidence_refs: ["S404:0"] }] },
    c.timeline,
    new Set(),
    "vi",
  );
  assert.match(v.findings[0].notes!.join(" "), /bỏ mã bằng chứng không tồn tại/);
  // and the other way round
  const e = parseRequest("Kiểm tra log đơn hàng 2611095VL160RW01", { ...opts, locale: "en" });
  assert.match(e.time.notes.join(" "), /last 24 hours/);
});
