/**
 * Synthetic production logs for the HasakiNOW shipping example (order 2611095VL160RW01, 10 Nov 2026 ~08:48 +07:00).
 * Entirely invented: no real customer, payload or URL. Used by the automated tests and the offline evaluation.
 *
 * What the case exercises:
 *  - an outbound request with a synchronous "accepted" HTTP response (same request_id) and a later asynchronous
 *    callback carrying the tracking number (no request_id: paired only through shipment_id → inferred);
 *  - a Kafka redelivery of the same message id (duplicate processing), rows returned out of time order;
 *  - a busy connector logging a request/response of ANOTHER order a few hundred ms later (must never be paired);
 *  - the same log line returned by two overlapping searches (folded);
 *  - customer PII and a signed label URL that must be redacted;
 *  - the label URL generation event plus a later "persisted" observation.
 */

const J = (o: unknown) => JSON.stringify(o);
export const ORDER = "2611095VL160RW01";
export const SHIPMENT = "98765001";
export const TRACKING = "NOW-TRK-0091827";

const row = (time: string, container: string, raw: unknown) => ({
  _time: time,
  index: "k8s_prod",
  source: `/var/log/containers/${container}.log`,
  sourcetype: "kube:container",
  host: "node-7",
  "kubernetes.container_name": container,
  _raw: typeof raw === "string" ? raw : J(raw),
});

/** Search 1: index=k8s_prod "2611095VL160RW01" (out of time order on purpose). */
export const SEARCH_BY_ORDER = [
  row("2026-11-10T08:48:01.402+07:00", "hasakinow-connector", {
    level: "info",
    message: "hasakinow response",
    order_code: ORDER,
    request_id: "req-7f3a91",
    shipment_id: SHIPMENT,
    http_status: 200,
    body: { status: "accepted", partner_ref: "NOWREF-1188" },
  }),
  row("2026-11-10T08:47:59.812+07:00", "oms-background", {
    level: "info",
    message: "outbound shipment created",
    order_code: ORDER,
    shipment_id: SHIPMENT,
    message_id: "msg-55aa01",
    carrier: "HASAKI_NOW",
  }),
  row("2026-11-10T08:48:00.135+07:00", "hasakinow-connector", {
    level: "info",
    message: "hasakinow request POST /v1/orders",
    order_code: ORDER,
    request_id: "req-7f3a91",
    shipment_id: SHIPMENT,
    body: {
      order_code: ORDER,
      receiver_name: "Nguyen Van A",
      receiver_phone: "0912345678",
      address: "12 Ly Thuong Kiet, Q.10",
      cod_amount: 350000,
      items: [{ sku: "SKU-1", qty: 2 }],
    },
    headers: { Authorization: "Bearer sk_live_abcdefghijklmnop123456" },
  }),
  row("2026-11-10T08:47:59.840+07:00", "oms-background", {
    level: "info",
    message: "kafka publish topic=shipment.outbound",
    order_code: ORDER,
    message_id: "msg-55aa01",
  }),
  row("2026-11-10T08:49:18.044+07:00", "oms-background", {
    level: "info",
    message: `shipping label url generated url=https://cdn.example.invalid/labels/${SHIPMENT}.pdf?X-Amz-Signature=abcdef1234567890&X-Amz-Expires=600`,
    order_code: ORDER,
    shipment_id: SHIPMENT,
  }),
];

/** Search 2 (refinement): index=k8s_prod "98765001" — overlaps search 1 on purpose. */
export const SEARCH_BY_SHIPMENT = [
  row("2026-11-10T08:49:16.778+07:00", "oms-api", {
    level: "info",
    message: "hasakinow callback received",
    shipment_id: SHIPMENT,
    tracking_no: TRACKING,
    partner_order_code: TRACKING,
    status: "assigned",
    driver_phone: "0987654321",
  }),
  row("2026-11-10T08:48:00.120+07:00", "hasakinow-connector", {
    level: "info",
    message: "consumed shipment.outbound",
    shipment_id: SHIPMENT,
    message_id: "msg-55aa01",
    partition: 3,
    offset: 99120,
  }),
  row("2026-11-10T08:48:05.010+07:00", "hasakinow-connector", {
    level: "warn",
    message: "consumed shipment.outbound (redelivery after rebalance), skipped duplicate",
    shipment_id: SHIPMENT,
    message_id: "msg-55aa01",
    partition: 3,
    offset: 99120,
  }),
  row("2026-11-10T08:49:16.950+07:00", "oms-api", {
    level: "info",
    message: "tracking number persisted",
    shipment_id: SHIPMENT,
    tracking_no: TRACKING,
  }),
  row("2026-11-10T08:49:17.300+07:00", "oms-background", {
    level: "info",
    message: "generating shipping label",
    shipment_id: SHIPMENT,
    tracking_no: TRACKING,
  }),
  row("2026-11-10T08:49:18.044+07:00", "oms-background", {
    level: "info",
    message: `shipping label url generated url=https://cdn.example.invalid/labels/${SHIPMENT}.pdf?X-Amz-Signature=abcdef1234567890&X-Amz-Expires=600`,
    order_code: ORDER,
    shipment_id: SHIPMENT,
  }),
  row("2026-11-10T08:49:20.500+07:00", "oms-api", {
    level: "info",
    message: "label persisted",
    shipment_id: SHIPMENT,
    label_url: `https://cdn.example.invalid/labels/${SHIPMENT}.pdf`,
  }),
];

/** Search 3: index=k8s_prod kubernetes.container_name=hasakinow-connector "hasakinow response" — includes another order. */
export const SEARCH_CONNECTOR = [
  row("2026-11-10T08:48:00.610+07:00", "hasakinow-connector", {
    level: "info",
    message: "hasakinow response",
    order_code: "2611095ZZ000AA99",
    request_id: "req-0000ff",
    shipment_id: "98760042",
    http_status: 200,
    body: { status: "accepted" },
  }),
  row("2026-11-10T08:48:01.402+07:00", "hasakinow-connector", {
    level: "info",
    message: "hasakinow response",
    order_code: ORDER,
    request_id: "req-7f3a91",
    shipment_id: SHIPMENT,
    http_status: 200,
    body: { status: "accepted", partner_ref: "NOWREF-1188" },
  }),
];

export const FIXTURE_SEARCHES = [
  { id: 101, query: `search index=k8s_prod "${ORDER}"`, rows: SEARCH_BY_ORDER },
  { id: 102, query: `search index=k8s_prod "${SHIPMENT}"`, rows: SEARCH_BY_SHIPMENT },
  {
    id: 103,
    query: `search index=k8s_prod kubernetes.container_name=hasakinow-connector "hasakinow response"`,
    rows: SEARCH_CONNECTOR,
  },
];

/** Reference of a fixture row by its time and container (event refs depend on row order within each search). */
export function refOf(searchId: number, time: string, container?: string) {
  const s = FIXTURE_SEARCHES.find((x) => x.id === searchId)!;
  const i = s.rows.findIndex(
    (r) => r._time === time && (!container || r["kubernetes.container_name"] === container),
  );
  if (i < 0) throw new Error(`no fixture row ${searchId} ${time}`);
  return `S${searchId}:${i}`;
}

/** What a careful agent would label. */
export function goodLabels() {
  return [
    {
      evidence_ref: refOf(101, "2026-11-10T08:47:59.812+07:00"),
      event_type: "OUTBOUND_MESSAGE_CREATED",
    },
    { evidence_ref: refOf(101, "2026-11-10T08:47:59.840+07:00"), event_type: "MESSAGE_PUBLISHED" },
    {
      evidence_ref: refOf(101, "2026-11-10T08:48:00.135+07:00"),
      event_type: "PARTNER_REQUEST_SENT",
    },
    {
      evidence_ref: refOf(101, "2026-11-10T08:48:01.402+07:00"),
      event_type: "PARTNER_RESPONSE_RECEIVED",
    },
    { evidence_ref: refOf(102, "2026-11-10T08:48:00.120+07:00"), event_type: "MESSAGE_CONSUMED" },
    { evidence_ref: refOf(102, "2026-11-10T08:48:05.010+07:00"), event_type: "MESSAGE_CONSUMED" },
    {
      evidence_ref: refOf(102, "2026-11-10T08:49:16.778+07:00"),
      event_type: "PARTNER_CALLBACK_RECEIVED",
    },
    {
      evidence_ref: refOf(102, "2026-11-10T08:49:16.950+07:00"),
      event_type: "TRACKING_NUMBER_PERSISTED",
    },
    {
      evidence_ref: refOf(102, "2026-11-10T08:49:17.300+07:00"),
      event_type: "SHIPPING_LABEL_REQUESTED",
    },
    {
      evidence_ref: refOf(101, "2026-11-10T08:49:18.044+07:00"),
      event_type: "SHIPPING_LABEL_URL_GENERATED",
    },
    // the same line again from the overlapping refinement search
    {
      evidence_ref: refOf(102, "2026-11-10T08:49:18.044+07:00"),
      event_type: "SHIPPING_LABEL_URL_GENERATED",
    },
    {
      evidence_ref: refOf(102, "2026-11-10T08:49:20.500+07:00"),
      event_type: "SHIPPING_LABEL_URL_PERSISTED",
    },
  ];
}

/** What an over-eager agent adds: a fabricated ref, a wrong time, a claimed id that is not in the log, another order's response. */
export function adversarialLabels() {
  return [
    {
      evidence_ref: "S999:0",
      event_type: "PARTNER_CALLBACK_RECEIVED",
      note: "callback at 08:48:30",
    },
    {
      evidence_ref: refOf(103, "2026-11-10T08:48:00.610+07:00"),
      event_type: "PARTNER_RESPONSE_RECEIVED",
      note: "fast response right after our request",
    },
    {
      evidence_ref: refOf(101, "2026-11-10T08:48:00.135+07:00"),
      event_type: "PARTNER_REQUEST_SENT",
      timestamp: "2026-11-10T08:48:00+07:00",
      ids: { tracking_no: "NOW-TRK-FAKE" },
    },
  ];
}

/** Expected answers (from the synthetic data above; never production facts). */
export const EXPECTED = {
  request_sent: "2026-11-10T08:48:00.135+07:00",
  sync_response: "2026-11-10T08:48:01.402+07:00",
  sync_latency_ms: 1267,
  callback: "2026-11-10T08:49:16.778+07:00",
  callback_latency_ms: 76643,
  label_generated: "2026-11-10T08:49:18.044+07:00",
  unrelated_ref: "S103:0",
};

export const REQUEST_VI =
  "Đơn hàng 2611095VL160RW01: lấy chính xác message gửi sang HasakiNOW lúc khoảng 08:48 ngày 10/11/2026. HasakiNOW mất bao lâu để phản hồi thông tin vận chuyển/tracking? Tìm thời điểm sinh shipping label URL.";
export const REQUEST_EN =
  "Order 2611095VL160RW01. Retrieve the exact message sent to HasakiNOW around 08:48 on November 10, 2026. Determine how long HasakiNOW took to respond with the shipping/tracking information. Also find the timestamp when the shipping label URL was generated.";
