import { ID_FIELDS, type IdField, type Ids, type LogEvent } from "./events.ts";
import { coarser, formatDuration, type Precision } from "./time.ts";

/**
 * Evidence-based event correlation, timeline reconstruction and latency calculation. Pure and deterministic.
 *
 * Trust model: agents only LABEL stored log events by reference (`evidence_ref`). Everything factual — the timestamp,
 * its precision, the service, the identifiers — is read from the stored, sanitized event. A label that cites an
 * unknown reference is rejected, an identifier the agent claims is only used when it literally occurs in the event,
 * and events are related only through shared identifiers — never because they are close in time.
 */

export const EVENT_TYPES = [
  "OUTBOUND_MESSAGE_CREATED",
  "MESSAGE_PUBLISHED",
  "MESSAGE_CONSUMED",
  "PARTNER_REQUEST_SENT",
  "PARTNER_REQUEST_ACCEPTED",
  "PARTNER_RESPONSE_RECEIVED",
  "PARTNER_CALLBACK_RECEIVED",
  "TRACKING_NUMBER_RECEIVED",
  "TRACKING_NUMBER_PERSISTED",
  "SHIPPING_LABEL_REQUESTED",
  "SHIPPING_LABEL_URL_GENERATED",
  "SHIPPING_LABEL_URL_OBSERVED",
  "SHIPPING_LABEL_URL_PERSISTED",
  "STATE_CHANGED",
  "RETRY_SCHEDULED",
  "ERROR",
  "OTHER",
] as const;

export type Confidence = "confirmed" | "inferred" | "unknown";

export interface EventLabel {
  evidence_ref: string;
  event_type: string;
  /** Free-text interpretation by the agent (kept, never used as evidence). */
  note?: string;
  /** Identifiers the agent read in the event; accepted only when the value occurs in the stored event. */
  ids?: Partial<Record<IdField, string>>;
  /** Anything the agent asserts about time is ignored; kept only to report a conflict. */
  timestamp?: string;
  labeled_by?: string;
}

export interface TimelineEvent {
  event_type: string;
  timestamp: string | null;
  epoch_us: number | null;
  precision: Precision | null;
  time_original: string | null;
  assumed_timezone: boolean;
  service: string | null;
  index: string | null;
  source: string | null;
  order_code: string | null;
  shipment_code: string | null;
  shipment_id: string | null;
  tracking_no: string | null;
  request_id: string | null;
  trace_id: string | null;
  correlation_id: string | null;
  message_id: string | null;
  ids: Ids;
  evidence_ref: string;
  /** How the event is tied to the investigated entity. */
  confidence: Confidence;
  link: { kind: "direct" | "transitive" | "none"; via: string[] };
  excerpt: string;
  /** Sanitized full log line for message-bearing events (outbound request, responses, callbacks), bounded. */
  payload?: string;
  note?: string;
  labeled_by?: string;
  /** Same message id seen again (redelivery / duplicate processing): 1-based delivery number. */
  delivery?: { n: number; of: number; key: string };
  /** Exact duplicate log lines (same time and content) folded into this one. */
  duplicates?: string[];
  attempt?: number;
  conflicts?: string[];
}

export interface Rejection {
  evidence_ref: string;
  event_type?: string;
  reason: string;
  labeled_by?: string;
}

/** Strong identifiers that relate two log lines of the same request/message. */
const REQUEST_SCOPE: IdField[] = ["request_id", "correlation_id", "message_id", "trace_id"];
/** Business identifiers: tie events to the same entity, but not to the same request attempt. */
const ENTITY_SCOPE: IdField[] = ["order_code", "shipment_code", "shipment_id", "tracking_no"];
const MIN_KEY_LEN = 6;
const PAYLOAD_TYPES = new Set(["OUTBOUND_MESSAGE_CREATED", "MESSAGE_PUBLISHED", "PARTNER_REQUEST_SENT", "PARTNER_RESPONSE_RECEIVED", "PARTNER_CALLBACK_RECEIVED"]);

const norm = (s: string) => s.trim().toLowerCase();

function occurs(e: LogEvent, value: string) {
  const v = value.toLowerCase();
  return e.raw.toLowerCase().includes(v) || e.message.toLowerCase().includes(v) || Object.values(e.fields).some((x) => x.toLowerCase().includes(v));
}

const say = (locale: "vi" | "en", vi: string, en: string) => (locale === "vi" ? vi : en);

function mergedIds(e: LogEvent, label: EventLabel, conflicts: string[], locale: "vi" | "en"): Ids {
  const ids: Ids = {};
  for (const f of ID_FIELDS) if (e.ids[f]?.length) ids[f] = [...e.ids[f]!];
  for (const [f, v] of Object.entries(label.ids ?? {}) as Array<[IdField, string]>) {
    if (!v || !ID_FIELDS.includes(f)) continue;
    if (!occurs(e, String(v))) {
      conflicts.push(say(locale, `${f}=${v} do agent khai báo không có trong ${e.ref}; bỏ qua`, `${f}=${v} claimed by the agent does not occur in ${e.ref}; ignored`));
      continue;
    }
    const list = (ids[f] ??= []);
    if (!list.includes(String(v))) list.push(String(v));
  }
  return ids;
}

const eventType = (t: string) => {
  const u = String(t ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return /^[A-Z][A-Z0-9_]{2,40}$/.test(u) ? u : "OTHER";
};

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

const valueKeys = (ids: Ids) => {
  const out: string[] = [];
  for (const f of ID_FIELDS) for (const v of ids[f] ?? []) if (v.length >= MIN_KEY_LEN) out.push(`v:${norm(v)}`);
  return [...new Set(out)];
};

export interface CorrelationInput {
  events: Map<string, LogEvent>;
  labels: EventLabel[];
  /** Identifiers named in the request (the investigated entity). */
  anchors: string[];
  /** Language of reasons/conflicts (the run's output locale). */
  locale?: "vi" | "en";
}

export interface CorrelationResult {
  timeline: TimelineEvent[];
  uncorrelated: TimelineEvent[];
  rejected: Rejection[];
  identifiers: Partial<Record<IdField, string[]>>;
  /** Events that matched an anchor but nobody labeled yet (to guide the next search/label round). */
  unlabeled_refs: string[];
}

/** Validate labels against stored evidence, fold duplicates, relate events through shared identifiers. */
export function correlate(input: CorrelationInput): CorrelationResult {
  const rejected: Rejection[] = [];
  const locale = input.locale ?? "en";
  const anchors = input.anchors.filter(Boolean).map(norm);
  const seen = new Map<string, TimelineEvent>(); // by evidence ref
  const byFingerprint = new Map<string, TimelineEvent>();
  for (const label of input.labels) {
    const ref = String(label.evidence_ref ?? "").trim();
    const e = input.events.get(ref);
    if (!e) {
      rejected.push({ evidence_ref: ref, event_type: label.event_type, reason: say(locale, "mã bằng chứng không tồn tại — không có trong kết quả tìm kiếm đã lưu; không dùng", "unknown evidence reference — no stored search result has it; not used"), labeled_by: label.labeled_by });
      continue;
    }
    const conflicts: string[] = [];
    if (!e.time) conflicts.push(say(locale, "sự kiện không có thời điểm đọc được", "event has no parseable timestamp"));
    if (label.timestamp && e.time && label.timestamp !== e.time.iso && label.timestamp !== e.time.original)
      conflicts.push(say(locale, `agent ghi thời điểm ${label.timestamp} khác log (${e.time.iso}); dùng thời điểm trong log`, `agent-stated time ${label.timestamp} differs from the log (${e.time.iso}); the log time is used`));
    const type = eventType(label.event_type);
    const prior = seen.get(ref);
    if (prior) {
      if (prior.event_type !== type) prior.conflicts = [...(prior.conflicts ?? []), say(locale, `${label.labeled_by ?? "agent"} còn gắn nhãn ${type}; giữ nhãn đầu tiên`, `also labeled ${type} by ${label.labeled_by ?? "an agent"}; first label kept`)];
      continue;
    }
    const ids = mergedIds(e, label, conflicts, locale);
    const first = (f: IdField) => ids[f]?.[0] ?? null;
    const t: TimelineEvent = {
      event_type: type,
      timestamp: e.time?.iso ?? null,
      epoch_us: e.time?.epoch_us ?? null,
      precision: e.time?.precision ?? null,
      time_original: e.time?.original ?? null,
      assumed_timezone: e.time?.assumed_timezone ?? false,
      service: e.service,
      index: e.index,
      source: e.source,
      order_code: first("order_code"),
      shipment_code: first("shipment_code"),
      shipment_id: first("shipment_id"),
      tracking_no: first("tracking_no"),
      request_id: first("request_id"),
      trace_id: first("trace_id"),
      correlation_id: first("correlation_id"),
      message_id: first("message_id"),
      ids,
      evidence_ref: ref,
      confidence: "unknown",
      link: { kind: "none", via: [] },
      excerpt: e.message.slice(0, 600),
      ...(PAYLOAD_TYPES.has(type) ? { payload: e.raw.slice(0, 3000) } : {}),
      ...(label.note ? { note: String(label.note).slice(0, 500) } : {}),
      ...(label.labeled_by ? { labeled_by: label.labeled_by } : {}),
      ...(conflicts.length ? { conflicts } : {}),
    };
    // The same log line returned by two overlapping searches: fold it.
    const dup = byFingerprint.get(e.fingerprint + "|" + type);
    if (dup) {
      dup.duplicates = [...(dup.duplicates ?? []), ref];
      seen.set(ref, dup);
      continue;
    }
    byFingerprint.set(e.fingerprint + "|" + type, t);
    seen.set(ref, t);
  }
  const all = [...new Set(seen.values())];

  // Relate events: union over identifier values (long enough to be meaningful), never over time.
  const uf = new UnionFind();
  for (const t of all) {
    const keys = valueKeys(t.ids);
    uf.find(`e:${t.evidence_ref}`);
    for (const k of keys) uf.union(`e:${t.evidence_ref}`, k);
  }
  const anchorKeys = anchors.filter((a) => a.length >= 3).map((a) => `v:${a}`);
  const anchorRoots = new Set(anchorKeys.filter((k) => uf.parent.has(k)).map((k) => uf.find(k)));
  for (const t of all) {
    const e = input.events.get(t.evidence_ref)!;
    const direct = anchors.filter((a) => valueKeys(t.ids).includes(`v:${a}`) || occurs(e, a));
    if (direct.length) {
      t.link = { kind: "direct", via: direct };
      t.confidence = "confirmed";
    } else if (anchorRoots.has(uf.find(`e:${t.evidence_ref}`))) {
      const shared = valueKeys(t.ids).map((k) => k.slice(2));
      t.link = { kind: "transitive", via: shared };
      t.confidence = "inferred";
    } else if (!anchors.length) {
      t.link = { kind: "none", via: [] };
      t.confidence = "inferred";
    }
  }
  const sortKey = (t: TimelineEvent) => t.epoch_us ?? Number.MAX_SAFE_INTEGER;
  const timeline = all.filter((t) => t.confidence !== "unknown").sort((a, b) => sortKey(a) - sortKey(b) || a.evidence_ref.localeCompare(b.evidence_ref));
  const uncorrelated = all.filter((t) => t.confidence === "unknown").sort((a, b) => sortKey(a) - sortKey(b));

  // Redelivery: the same message id processed more than once (by type) — numbered in time order.
  const groups = new Map<string, TimelineEvent[]>();
  for (const t of timeline) if (t.message_id) groups.set(`${t.event_type}|${t.message_id}`, [...(groups.get(`${t.event_type}|${t.message_id}`) ?? []), t]);
  for (const [key, g] of groups) if (g.length > 1) g.forEach((t, i) => (t.delivery = { n: i + 1, of: g.length, key }));

  // Attempts: outbound partner requests numbered in time order.
  timeline.filter((t) => t.event_type === "PARTNER_REQUEST_SENT").forEach((t, i) => (t.attempt = i + 1));

  const identifiers: Partial<Record<IdField, string[]>> = {};
  for (const t of timeline) for (const f of ID_FIELDS) for (const v of t.ids[f] ?? []) if (!(identifiers[f] ??= []).includes(v)) identifiers[f]!.push(v);

  const labeled = new Set(seen.keys());
  const unlabeled_refs = [...input.events.values()].filter((e) => !labeled.has(e.ref) && anchors.some((a) => occurs(e, a))).map((e) => e.ref).slice(0, 100);
  return { timeline, uncorrelated, rejected, identifiers, unlabeled_refs };
}

// ---------------------------------------------------------------- latency

export interface LatencyDefinition {
  key: string;
  from: string[];
  to: string[];
  /** Prefer the earliest-listed `from` type over the closest preceding event (stage-to-stage spans). */
  fromPriority?: boolean;
  /** Measure only the first matching `to` type (by list order), not every `to` event. */
  single?: boolean;
  /**
   * The pair is one request and its own response: a different request_id/correlation_id on the two sides means they
   * belong to different attempts and must not be paired. Off for asynchronous stages (a callback carries its own ids).
   */
  sameRequest?: boolean;
  label: { vi: string; en: string };
  qualification: { vi: string; en: string };
}

export const LATENCY_DEFINITIONS: LatencyDefinition[] = [
  {
    key: "partner_sync_response",
    from: ["PARTNER_REQUEST_SENT"],
    to: ["PARTNER_RESPONSE_RECEIVED", "PARTNER_REQUEST_ACCEPTED"],
    sameRequest: true,
    label: { vi: "Phản hồi đồng bộ của đối tác (HTTP)", en: "Partner synchronous response (HTTP)" },
    qualification: {
      vi: "Thời gian khứ hồi của request HTTP nhìn từ service của mình: gồm mạng và thời gian xử lý của đối tác.",
      en: "Round trip of the HTTP request as seen by our service: network plus partner processing.",
    },
  },
  {
    key: "partner_callback",
    from: ["PARTNER_REQUEST_SENT"],
    to: ["PARTNER_CALLBACK_RECEIVED"],
    label: { vi: "Đối tác gọi callback (bất đồng bộ)", en: "Partner asynchronous callback" },
    qualification: {
      vi: "Từ lúc gửi request tới lúc callback của đối tác tới hệ thống: gồm xử lý, hàng đợi và gửi lại phía đối tác — không phải thời gian xử lý thuần của đối tác.",
      en: "From our request to the partner's callback reaching us: includes partner processing, partner-side queueing and delivery — not the partner's pure processing time.",
    },
  },
  {
    key: "tracking_available",
    from: ["PARTNER_REQUEST_SENT"],
    to: ["TRACKING_NUMBER_RECEIVED"],
    label: { vi: "Có thông tin vận đơn / tracking", en: "Shipping / tracking information available" },
    qualification: {
      vi: "Từ lúc gửi request tới lần đầu log ghi nhận mã tracking.",
      en: "From our request to the first log line that holds the tracking number.",
    },
  },
  {
    key: "label_generation",
    from: ["SHIPPING_LABEL_REQUESTED"],
    to: ["SHIPPING_LABEL_URL_GENERATED"],
    label: { vi: "Sinh shipping label", en: "Shipping label generation" },
    qualification: { vi: "Từ yêu cầu tạo label tới lúc URL label được sinh.", en: "From the label request to the label URL being generated." },
  },
  {
    key: "internal_dispatch",
    from: ["OUTBOUND_MESSAGE_CREATED", "MESSAGE_PUBLISHED"],
    fromPriority: true,
    to: ["PARTNER_REQUEST_SENT"],
    label: { vi: "Xử lý nội bộ trước khi gọi đối tác", en: "Internal processing before the partner call" },
    qualification: {
      vi: "Nội bộ: broker + consumer + xử lý trước khi gửi request; không thuộc về đối tác.",
      en: "Internal: broker, consumer and processing before the request is sent; not attributable to the partner.",
    },
  },
  {
    key: "broker_delivery",
    from: ["MESSAGE_PUBLISHED"],
    to: ["MESSAGE_CONSUMED"],
    label: { vi: "Broker: publish → consume", en: "Broker: publish → consume" },
    qualification: { vi: "Độ trễ hàng đợi/broker nội bộ.", en: "Internal broker/queue delay." },
  },
  {
    key: "end_to_end_label",
    from: ["OUTBOUND_MESSAGE_CREATED", "PARTNER_REQUEST_SENT"],
    fromPriority: true,
    single: true,
    to: ["SHIPPING_LABEL_URL_GENERATED", "SHIPPING_LABEL_URL_OBSERVED", "SHIPPING_LABEL_URL_PERSISTED"],
    label: { vi: "Đầu-cuối tới khi có URL label", en: "End to end until the label URL" },
    qualification: {
      vi: "Đầu-cuối gồm cả xử lý nội bộ và đối tác; không dùng làm thời gian xử lý của đối tác. Nếu chỉ có thời điểm 'thấy URL lần đầu' thì đó là cận trên.",
      en: "End to end including internal and partner work; not the partner's processing time. When only the first observation of the URL is known, it is an upper bound.",
    },
  },
];

export interface LatencyResult {
  key: string;
  label: string;
  qualification: string;
  from: { evidence_ref: string; event_type: string; timestamp: string | null; service: string | null };
  to: { evidence_ref: string; event_type: string; timestamp: string | null; service: string | null };
  latency_us: number | null;
  latency_ms: number | null;
  latency_text: string | null;
  precision: Precision | null;
  /** How the pair was matched. */
  pairing: "request_scope_id" | "entity_id" | "none";
  shared_ids: string[];
  confidence: Confidence;
  attempt?: number;
  notes: string[];
}

function sharedValues(a: TimelineEvent, b: TimelineEvent, fields: IdField[]) {
  const out: string[] = [];
  for (const f of fields) for (const v of a.ids[f] ?? []) for (const fb of fields) if ((b.ids[fb] ?? []).some((x) => norm(x) === norm(v))) out.push(`${f}=${v}`);
  return [...new Set(out)];
}

/** A request/correlation id present on both sides that differs → they belong to different attempts. */
function conflictingRequestIds(a: TimelineEvent, b: TimelineEvent) {
  for (const f of ["request_id", "correlation_id"] as IdField[]) {
    const x = a.ids[f] ?? [];
    const y = b.ids[f] ?? [];
    if (x.length && y.length && !x.some((v) => y.some((w) => norm(v) === norm(w)))) return f;
  }
  return null;
}

/**
 * Pair each "to" event with its "from" event and measure. Order of preference: a shared request-scope id
 * (request_id / correlation_id / message_id / trace_id); otherwise a shared business id with the closest preceding
 * request, as "inferred", flagged when several attempts are possible; never across conflicting request ids.
 */
export function computeLatencies(timeline: TimelineEvent[], locale: "vi" | "en" = "vi", defs = LATENCY_DEFINITIONS): LatencyResult[] {
  const usable = timeline.filter((t) => t.epoch_us !== null && (!t.delivery || t.delivery.n === 1));
  const out: LatencyResult[] = [];
  for (const d of defs) {
    let tos = usable.filter((t) => d.to.includes(t.event_type));
    if (d.single && tos.length) {
      const firstType = d.to.find((x) => tos.some((t) => t.event_type === x));
      tos = tos.filter((t) => t.event_type === firstType).slice(0, 1);
    }
    const priority = (t: TimelineEvent) => (d.fromPriority ? d.from.indexOf(t.event_type) : 0);
    const froms = usable.filter((t) => d.from.includes(t.event_type));
    if (!tos.length || !froms.length) continue;
    // one result per "to" event, but a single "from" may only be measured once per definition
    const usedTo = new Set<string>();
    for (const to of tos) {
      if (usedTo.has(to.evidence_ref)) continue;
      const notes: string[] = [];
      let from: TimelineEvent | undefined;
      let pairing: LatencyResult["pairing"] = "none";
      let shared: string[] = [];
      const strong = froms.filter((f) => sharedValues(f, to, REQUEST_SCOPE).length);
      if (strong.length) {
        from = strong.sort((a, b) => priority(a) - priority(b) || b.epoch_us! - a.epoch_us!).find((f) => f.epoch_us! <= to.epoch_us!) ?? strong[0];
        pairing = "request_scope_id";
        shared = sharedValues(from, to, REQUEST_SCOPE);
        if (strong.length > 1) notes.push(locale === "vi" ? `${strong.length} request cùng mã; chọn request gần nhất trước sự kiện` : `${strong.length} requests share the id; the closest preceding one is used`);
      } else {
        const candidates = froms.filter((f) => sharedValues(f, to, ENTITY_SCOPE).length && !(d.sameRequest && conflictingRequestIds(f, to)) && f.epoch_us! <= to.epoch_us!);
        if (candidates.length) {
          from = candidates.sort((a, b) => priority(a) - priority(b) || b.epoch_us! - a.epoch_us!)[0];
          pairing = "entity_id";
          shared = sharedValues(from, to, ENTITY_SCOPE);
          notes.push(locale === "vi" ? "ghép theo mã nghiệp vụ chung, không có request id chung" : "paired through a shared business id; no shared request id");
          const same = candidates.filter((c) => c.event_type === from!.event_type);
          if (same.length > 1)
            notes.push(
              locale === "vi"
                ? `mơ hồ: ${same.length} lần gửi có thể ứng với sự kiện này; dùng lần gần nhất trước nó (lần đầu: ${same.at(-1)!.timestamp})`
                : `ambiguous: ${same.length} attempts could match this event; the closest preceding one is used (first attempt: ${same.at(-1)!.timestamp})`,
            );
        }
      }
      if (!from) continue;
      usedTo.add(to.evidence_ref);
      const us = to.epoch_us! - from.epoch_us!;
      const precision = coarser(from.precision ?? "s", to.precision ?? "s");
      let confidence: Confidence = pairing === "request_scope_id" && from.confidence === "confirmed" && to.confidence === "confirmed" ? "confirmed" : "inferred";
      if (us < 0) {
        notes.push(locale === "vi" ? "thời điểm đích sớm hơn nguồn (lệch đồng hồ giữa các service hoặc ghép sai) — không tính độ trễ" : "the later event is timestamped before the earlier one (clock skew or wrong pairing) — latency not computed");
        confidence = "unknown";
      }
      if (from.assumed_timezone || to.assumed_timezone) notes.push(locale === "vi" ? "múi giờ của log được giả định" : "log timezone was assumed");
      if (precision === "s") notes.push(locale === "vi" ? "độ chính xác chỉ tới giây" : "second precision only");
      if (d.key === "end_to_end_label" && to.event_type !== "SHIPPING_LABEL_URL_GENERATED")
        notes.push(locale === "vi" ? "chỉ biết lúc thấy URL lần đầu, không phải lúc sinh — cận trên" : "only the first observation of the URL is known, not its creation — upper bound");
      out.push({
        key: d.key,
        label: d.label[locale],
        qualification: d.qualification[locale],
        from: { evidence_ref: from.evidence_ref, event_type: from.event_type, timestamp: from.timestamp, service: from.service },
        to: { evidence_ref: to.evidence_ref, event_type: to.event_type, timestamp: to.timestamp, service: to.service },
        latency_us: us >= 0 ? us : null,
        latency_ms: us >= 0 ? Math.round(us / 100) / 10 : null,
        latency_text: us >= 0 ? formatDuration(us, precision) : null,
        precision,
        pairing,
        shared_ids: shared,
        confidence,
        ...(from.attempt ? { attempt: from.attempt } : {}),
        notes,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- evidence completeness

export const OBJECTIVES = ["outbound_message", "partner_response_latency", "tracking_info", "shipping_label_time", "callback_time", "error_cause", "timeline"] as const;
export type Objective = (typeof OBJECTIVES)[number];

const NEEDS: Record<Objective, { any: string[][]; describe: { vi: string; en: string } }> = {
  outbound_message: { any: [["PARTNER_REQUEST_SENT", "OUTBOUND_MESSAGE_CREATED", "MESSAGE_PUBLISHED"]], describe: { vi: "log của message/request gửi đi (payload)", en: "the log line of the outbound message/request (payload)" } },
  partner_response_latency: {
    any: [["PARTNER_REQUEST_SENT"], ["PARTNER_RESPONSE_RECEIVED", "PARTNER_CALLBACK_RECEIVED", "TRACKING_NUMBER_RECEIVED", "PARTNER_REQUEST_ACCEPTED"]],
    describe: { vi: "cặp log request gửi đi và phản hồi/callback của đối tác", en: "the request log and the partner's response/callback log" },
  },
  tracking_info: { any: [["TRACKING_NUMBER_RECEIVED", "TRACKING_NUMBER_PERSISTED", "PARTNER_CALLBACK_RECEIVED"]], describe: { vi: "log có mã tracking/vận đơn", en: "a log line holding the tracking number" } },
  shipping_label_time: { any: [["SHIPPING_LABEL_URL_GENERATED", "SHIPPING_LABEL_URL_OBSERVED", "SHIPPING_LABEL_URL_PERSISTED"]], describe: { vi: "log sinh hoặc lưu URL shipping label", en: "a log line generating or persisting the shipping label URL" } },
  callback_time: { any: [["PARTNER_CALLBACK_RECEIVED"]], describe: { vi: "log nhận callback/webhook", en: "the callback/webhook receipt log" } },
  error_cause: { any: [["ERROR"]], describe: { vi: "log lỗi liên quan", en: "the related error log" } },
  timeline: { any: [], describe: { vi: "ít nhất một sự kiện được xác nhận", en: "at least one confirmed event" } },
};

export function evaluateCompleteness(timeline: TimelineEvent[], objectives: string[], locale: "vi" | "en" = "vi") {
  const types = new Set(timeline.filter((t) => t.confidence !== "unknown").map((t) => t.event_type));
  const missing: Array<{ objective: string; needed: string }> = [];
  const satisfied: string[] = [];
  const objs = (objectives.length ? objectives : ["timeline"]).filter((o): o is Objective => (OBJECTIVES as readonly string[]).includes(o));
  for (const o of objs) {
    const need = NEEDS[o];
    const ok = o === "timeline" ? timeline.some((t) => t.confidence === "confirmed") : need.any.every((group) => group.some((g) => types.has(g)));
    // A URL that was only seen later (persisted/returned) does not tell when it was generated: keep looking once.
    if (o === "shipping_label_time" && ok && !types.has("SHIPPING_LABEL_URL_GENERATED"))
      missing.push({ objective: o, needed: locale === "vi" ? "log sinh URL label (hiện chỉ thấy URL lần đầu, chưa rõ lúc sinh)" : "the label URL generation log (only the first observation is known)" });
    else if (ok) satisfied.push(o);
    else missing.push({ objective: o, needed: need.describe[locale] });
  }
  return { complete: missing.length === 0, satisfied, missing };
}
