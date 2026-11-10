import { computeLatencies, correlate, evaluateCompleteness, type EventLabel } from "../investigation/correlate.ts";
import { normalizeEvent, type LogEvent } from "../investigation/events.ts";
import * as F from "../investigation/fixtures.ts";
import { buildReport } from "../investigation/report.ts";
import { parseRequest } from "../investigation/request.ts";
import { wilson } from "./scoring.ts";

/**
 * Production-investigation benchmark (offline, synthetic HasakiNOW logs). Each scenario feeds a set of agent event
 * labels — careful, adversarial, or incomplete — through the platform's deterministic pipeline (correlation, timeline,
 * latency, report) and checks the answers against the fixture's ground truth. `scoreTimelineScenario` grades labels
 * produced by a live agent for the same synthetic searches by passing them in place of the scripted ones.
 */

const TZ = "Asia/Ho_Chi_Minh";
const NOW = Date.parse("2026-11-10T10:00:00+07:00");

export interface TimelineScenario {
  id: string;
  title: string;
  locale: "vi" | "en";
  request: string;
  searches: number[];
  labels: () => EventLabel[];
  connected?: boolean;
  expect: {
    status: string;
    outbound_at?: string | null;
    sync_ms?: number | null;
    callback_ms?: number | null;
    label_at?: string | null;
    label_kind?: "generated" | "first_observed" | null;
    rejected?: string[];
    unrelated_excluded?: boolean;
  };
}

export const TIMELINE_SCENARIOS: TimelineScenario[] = [
  {
    id: "PII-01",
    title: "HasakiNOW: careful labels, Vietnamese request",
    locale: "vi",
    request: F.REQUEST_VI,
    searches: [101, 102],
    labels: F.goodLabels,
    expect: { status: "complete", outbound_at: F.EXPECTED.request_sent, sync_ms: F.EXPECTED.sync_latency_ms, callback_ms: F.EXPECTED.callback_latency_ms, label_at: F.EXPECTED.label_generated, label_kind: "generated" },
  },
  {
    id: "PII-02",
    title: "HasakiNOW: over-eager agent (fabricated ref, wrong time, another order's response)",
    locale: "en",
    request: F.REQUEST_EN,
    searches: [101, 102, 103],
    labels: () => [...F.adversarialLabels(), ...F.goodLabels()],
    expect: { status: "complete", outbound_at: F.EXPECTED.request_sent, sync_ms: F.EXPECTED.sync_latency_ms, callback_ms: F.EXPECTED.callback_latency_ms, rejected: ["S999:0"], unrelated_excluded: true },
  },
  {
    id: "PII-03",
    title: "HasakiNOW: callback and label never found (first search only)",
    locale: "vi",
    request: F.REQUEST_VI,
    searches: [101],
    labels: () => F.goodLabels().filter((l) => l.evidence_ref.startsWith("S101:") && l.event_type !== "SHIPPING_LABEL_URL_GENERATED"),
    expect: { status: "partial", outbound_at: F.EXPECTED.request_sent, sync_ms: F.EXPECTED.sync_latency_ms, callback_ms: null, label_at: null, label_kind: null },
  },
  {
    id: "PII-04",
    title: "Label URL only observed when persisted (no generation log)",
    locale: "en",
    request: F.REQUEST_EN,
    searches: [101, 102],
    labels: () => F.goodLabels().filter((l) => l.event_type !== "SHIPPING_LABEL_URL_GENERATED"),
    expect: { status: "partial", label_at: "2026-11-10T08:49:20.500+07:00", label_kind: "first_observed" },
  },
  {
    id: "PII-05",
    title: "No Splunk access and no pasted results",
    locale: "vi",
    request: F.REQUEST_VI,
    searches: [],
    labels: () => [],
    connected: false,
    expect: { status: "blocked", outbound_at: null, sync_ms: null, callback_ms: null, label_at: null },
  },
];

function eventsOf(ids: number[]) {
  const events = new Map<string, LogEvent>();
  for (const s of F.FIXTURE_SEARCHES.filter((x) => ids.includes(x.id))) s.rows.forEach((r, i) => { const e = normalizeEvent(r, i, s.id, TZ); events.set(e.ref, e); });
  return events;
}

export function scoreTimelineScenario(s: TimelineScenario, labels = s.labels()) {
  const checks: Array<{ metric: string; passed: boolean; detail: string }> = [];
  const check = (metric: string, passed: boolean, detail: string) => checks.push({ metric, passed, detail });
  const parsed = parseRequest(s.request, { timezone: TZ, maxMinutes: 7 * 24 * 60, now: NOW });
  check("request_parsing", parsed.anchors[0] === F.ORDER && parsed.time.anchor === "2026-11-10T08:48:00+07:00", `anchor ${parsed.anchors[0]} at ${parsed.time.anchor}`);
  const c = correlate({ events: eventsOf(s.searches), labels, anchors: parsed.anchors });
  const latencies = computeLatencies(c.timeline, s.locale);
  const completeness = evaluateCompleteness(c.timeline, parsed.objectives, s.locale);
  const searches = s.searches.map((id) => ({ id, query: F.FIXTURE_SEARCHES.find((x) => x.id === id)!.query, earliest: parsed.time.earliest, latest: parsed.time.latest, status: "done", mode: "job", result_count: 1, duration_ms: 1, splunk_url: "https://splunk.example/x" }));
  const r = buildReport({ locale: s.locale, parsed, ...c, latencies, completeness, searches, access: { connected: s.connected ?? true, manual_pending: 0 } });
  const e = s.expect;
  check("report_status", r.status === e.status, `${r.status} (expected ${e.status})`);
  if (e.outbound_at !== undefined) check("timeline_accuracy", r.summary.outbound_at === e.outbound_at, `outbound ${r.summary.outbound_at} (expected ${e.outbound_at})`);
  const lat = (k: string) => latencies.find((l) => l.key === k)?.latency_ms ?? null;
  if (e.sync_ms !== undefined) check("latency_accuracy", lat("partner_sync_response") === e.sync_ms, `sync ${lat("partner_sync_response")} ms (expected ${e.sync_ms})`);
  if (e.callback_ms !== undefined) check("latency_accuracy", lat("partner_callback") === e.callback_ms, `callback ${lat("partner_callback")} ms (expected ${e.callback_ms})`);
  if (e.label_at !== undefined) check("timeline_accuracy", (r.summary.shipping_label?.at ?? null) === e.label_at, `label ${r.summary.shipping_label?.at ?? null} (expected ${e.label_at})`);
  if (e.label_kind !== undefined) check("generation_vs_observation", (r.summary.shipping_label?.kind ?? null) === e.label_kind, `label kind ${r.summary.shipping_label?.kind ?? null}`);
  if (e.rejected) check("evidence_rejection", JSON.stringify(c.rejected.map((x) => x.evidence_ref)) === JSON.stringify(e.rejected), `rejected ${c.rejected.map((x) => x.evidence_ref).join(", ")}`);
  if (e.unrelated_excluded)
    check("incorrect_pairing", !latencies.some((l) => [l.from.evidence_ref, l.to.evidence_ref].includes(F.EXPECTED.unrelated_ref)) && c.uncorrelated.some((t) => t.evidence_ref === F.EXPECTED.unrelated_ref), "another order's response not correlated or paired");
  // no-hallucination: every timestamp in the report belongs to a stored event
  const stored = new Set([...eventsOf(s.searches).values()].map((x) => x.time?.iso).filter(Boolean));
  const stamps = [...r.markdown.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+07:00/g)].map((m) => m[0]);
  const invented = stamps.filter((x) => !stored.has(x));
  check("no_hallucination", invented.length === 0, invented.length ? `timestamps without evidence: ${invented.join(", ")}` : `${stamps.length} timestamps, all evidenced`);
  check("redaction", !/0912345678|Nguyen Van A|sk_live_|abcdef1234567890|0987654321/.test(r.markdown), "no customer PII, credentials or URL signatures in the report");
  return { id: s.id, title: s.title, checks };
}

export function runTimelineBenchmark(scenarios = TIMELINE_SCENARIOS) {
  const results = scenarios.map((s) => scoreTimelineScenario(s));
  const metrics: Record<string, { passed: number; total: number; rate: number; ci95: [number, number] }> = {};
  for (const c of results.flatMap((r) => r.checks)) {
    const m = (metrics[c.metric] ??= { passed: 0, total: 0, rate: 0, ci95: [0, 0] });
    m.total++;
    if (c.passed) m.passed++;
  }
  for (const m of Object.values(metrics)) {
    m.rate = m.total ? m.passed / m.total : 0;
    const w = wilson(m.passed, m.total) as any;
    m.ci95 = Array.isArray(w) ? [w[0], w[1]] : [w.low ?? 0, w.high ?? 0];
  }
  return {
    scenarios: results.length,
    passed: results.filter((r) => r.checks.every((c) => c.passed)).length,
    metrics,
    failures: results.flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => `${r.id} ${c.metric}: ${c.detail}`)),
    results,
  };
}
