/**
 * Synthetic incidents for root-cause-analysis accuracy (P1). Each incident is generated from a scenario and a seed:
 * fixture traces, logs and metrics served by read-only `rca.*` integration tools, a documented ground truth, and a
 * reference plan that derives the answer from the tools alone (so the observations independently support the truth).
 * Several scenarios share a symptom ("refunds time out at payment-gateway") with different root causes, and the seed
 * varies order ids, volumes, latencies and where misleading warnings appear — a fixed answer cannot be memorized.
 * Fixture data only: nothing here is real or production.
 */
import { z } from "zod";
import { registerIntegrationTool } from "../agent/toolRegistry.ts";
import type { EffectTask, FieldDiagnostic } from "./codeactTasks.ts";

export const CAUSES = [
  "provider_timeout",
  "retry_amplification",
  "consumer_lag",
  "db_pool_saturation",
  "downstream_http_degradation",
  "idempotency_conflict",
  "event_ordering",
] as const;
export type Cause = (typeof CAUSES)[number];
export const SCENARIOS = [
  "provider-timeout",
  "retry-amplification",
  "kafka-consumer-lag",
  "db-pool-saturation",
  "downstream-http",
  "idempotency-conflict",
  "misleading-warnings",
  "missing-spans",
  "partial-outage",
  "event-ordering",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

interface Span {
  order_id: string;
  service: string;
  operation: string;
  start_ms: number;
  duration_ms: number;
  status: "ok" | "error";
}
interface LogEvent {
  ts_ms: number;
  order_id: string;
  service: string;
  level: "info" | "warn" | "error";
  message: string;
}
interface Metric {
  service: string;
  metric: string;
  ts_ms: number;
  value: number;
}
export interface GroundTruth {
  root_cause_service: string;
  root_cause_operation: string;
  cause: Cause;
  /** Orders affected by the root cause (the correlation the investigation must establish). */
  affected_orders: number;
  /** Highest status the evidence supports: an outage or missing instrumentation caps it. */
  max_status: "CONFIRMED" | "PROBABLE";
  /** Integrations that were unavailable and must be reported as missing. */
  unavailable: string[];
  /** Where the symptom shows (a root cause there is a symptom-as-cause error unless the truth says so). */
  symptom_service: string;
  /** A plausible but wrong cause the data deliberately suggests. */
  misleading_cause: Cause | null;
}
interface Incident {
  id: string;
  scenario: Scenario;
  symptom: string;
  spans: Span[];
  logs: LogEvent[];
  metrics: Metric[];
  unavailable: Set<string>;
  truth: GroundTruth;
}

/** Deterministic PRNG (mulberry32) so a seed always produces the same incident. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REFUND_TIMEOUT =
  "Refund requests time out at payment-gateway (p99 above 5 s) and customers see refunds stuck.";
const REFUNDS_FAILING =
  "Refund requests fail at payment-gateway with HTTP 409/5xx since this morning.";
const LEDGER_DRIFT =
  "Ledger balances drift: some refunds are applied to the ledger before the refund exists.";

/** Generate one incident. Pure function of (scenario, seed). */
export function generateIncident(scenario: Scenario, seed: number): Incident {
  const r = rng(seed * 7919 + SCENARIOS.indexOf(scenario) * 104729);
  const pick = (lo: number, hi: number) => Math.floor(lo + r() * (hi - lo + 1));
  const base = 1_700_000_000_000 + seed * 3_600_000;
  const orders = Array.from(
    { length: pick(60, 90) },
    (_, i) => `ORD-${seed * 1000 + i * pick(1, 3) + 1}`,
  );
  const uniq = [...new Set(orders)];
  const affectedCount = pick(8, 16);
  const shuffled = [...uniq].sort(() => r() - 0.5);
  const affected = new Set(shuffled.slice(0, affectedCount));
  // Misleading warnings land on orders that are NOT affected (the seed picks which).
  const decoys = shuffled.slice(affectedCount, affectedCount + pick(10, 20));
  const spans: Span[] = [];
  const logs: LogEvent[] = [];
  const metrics: Metric[] = [];
  const unavailable = new Set<string>();
  const span = (
    o: string,
    service: string,
    operation: string,
    t: number,
    d: number,
    status: "ok" | "error" = "ok",
  ) => spans.push({ order_id: o, service, operation, start_ms: t, duration_ms: d, status });
  const log = (o: string, service: string, level: LogEvent["level"], message: string, t: number) =>
    logs.push({ ts_ms: t, order_id: o, service, level, message });
  let symptom = REFUND_TIMEOUT;
  let truth: Omit<GroundTruth, "affected_orders" | "unavailable">;

  // The healthy refund path, per order: gateway → (fraud check) → provider; refund-worker persists.
  const healthy = (o: string, t: number) => {
    span(o, "payment-gateway", "gateway.refund", t, pick(120, 260));
    span(o, "fraud-service", "fraud.check", t + 5, pick(15, 40));
    span(o, "payment-provider", "provider.refund.http", t + 50, pick(60, 180));
    span(o, "refund-worker", "refund.db.acquire", t + 240, pick(2, 8));
    log(o, "payment-gateway", "info", "refund accepted", t + 1);
  };
  uniq.forEach((o, i) => {
    if (!affected.has(o)) healthy(o, base + i * 1000);
  });
  const each = (fn: (o: string, t: number, k: number) => void) =>
    [...affected].forEach((o, k) => fn(o, base + uniq.indexOf(o) * 1000, k));
  const decoyPool = () =>
    decoys.forEach((o, k) =>
      log(o, "refund-worker", "warn", "db pool saturated (32/32 in use)", base + 500 + k * 777),
    );

  switch (scenario) {
    case "provider-timeout":
    case "misleading-warnings":
    case "missing-spans":
    case "partial-outage":
      each((o, t) => {
        const d = pick(5600, 9000);
        span(o, "payment-gateway", "gateway.refund", t, d + pick(40, 90), "error");
        span(o, "fraud-service", "fraud.check", t + 5, pick(15, 40));
        if (scenario !== "missing-spans")
          span(o, "payment-provider", "provider.refund.http", t + 50, d, "error");
        span(o, "refund-worker", "refund.db.acquire", t + d + 60, pick(2, 8));
        log(o, "payment-gateway", "error", "refund failed: upstream timeout", t + d + 70);
        log(o, "payment-provider", "error", "refund call exceeded 5000 ms deadline", t + d + 55);
      });
      decoyPool();
      if (scenario === "misleading-warnings")
        decoys.forEach((o, k) =>
          log(
            o,
            "refund-worker",
            "error",
            "db pool saturated: waited 2000 ms for a connection",
            base + 900 + k * 333,
          ),
        );
      if (scenario === "partial-outage") unavailable.add("rca.traces");
      truth = {
        root_cause_service: "payment-provider",
        root_cause_operation: "provider.refund.http",
        cause: "provider_timeout",
        max_status: scenario === "partial-outage" ? "PROBABLE" : "CONFIRMED",
        symptom_service: "payment-gateway",
        misleading_cause: "db_pool_saturation",
      };
      break;
    case "retry-amplification":
      each((o, t) => {
        const attempts = pick(4, 6);
        span(o, "payment-gateway", "gateway.refund", t, pick(5400, 7000), "error");
        span(o, "fraud-service", "fraud.check", t + 5, pick(15, 40));
        for (let a = 0; a < attempts; a++) {
          span(
            o,
            "payment-provider",
            "provider.refund.http",
            t + 50 + a * 900,
            pick(700, 1100),
            "ok",
          );
          if (a)
            log(
              o,
              "refund-worker",
              "warn",
              `retrying refund (attempt ${a + 1}, no backoff)`,
              t + 50 + a * 900,
            );
          span(o, "refund-worker", "refund.retry", t + 40 + a * 900, pick(3, 9));
        }
        log(o, "payment-gateway", "error", "refund failed: upstream timeout", t + 6000);
      });
      // Provider latency rises only AFTER the retry storm starts (temporal ordering).
      for (let k = 0; k < 12; k++)
        metrics.push({
          service: "payment-provider",
          metric: "p99_ms",
          ts_ms: base + k * 60_000,
          value: k < 4 ? pick(150, 220) : pick(800, 1100),
        });
      for (let k = 0; k < 12; k++)
        metrics.push({
          service: "refund-worker",
          metric: "retries_per_min",
          ts_ms: base + k * 60_000,
          value: k < 3 ? pick(0, 2) : pick(180, 260),
        });
      decoyPool();
      truth = {
        root_cause_service: "refund-worker",
        root_cause_operation: "refund.retry",
        cause: "retry_amplification",
        max_status: "CONFIRMED",
        symptom_service: "payment-gateway",
        misleading_cause: "provider_timeout",
      };
      break;
    case "db-pool-saturation":
      each((o, t) => {
        const wait = pick(5200, 7600);
        span(o, "payment-gateway", "gateway.refund", t, wait + pick(200, 400), "error");
        span(o, "fraud-service", "fraud.check", t + 5, pick(15, 40));
        span(o, "payment-provider", "provider.refund.http", t + 50, pick(60, 180));
        span(o, "refund-worker", "refund.db.acquire", t + 240, wait, "error");
        log(
          o,
          "refund-worker",
          "error",
          "db pool saturated: waited 5000 ms for a connection",
          t + 240 + wait,
        );
        log(o, "payment-gateway", "error", "refund failed: upstream timeout", t + wait + 300);
      });
      // Decoy: slow-but-ok provider responses on unaffected orders.
      decoys.forEach((o, k) =>
        log(o, "payment-provider", "warn", "slow response 1800 ms", base + 600 + k * 500),
      );
      truth = {
        root_cause_service: "refund-worker",
        root_cause_operation: "refund.db.acquire",
        cause: "db_pool_saturation",
        max_status: "CONFIRMED",
        symptom_service: "payment-gateway",
        misleading_cause: "provider_timeout",
      };
      break;
    case "downstream-http":
      each((o, t) => {
        const d = pick(5300, 8200);
        span(o, "payment-gateway", "gateway.refund", t, d + pick(150, 300), "error");
        span(o, "fraud-service", "fraud.check", t + 5, d, "error");
        span(o, "payment-provider", "provider.refund.http", t + d + 20, pick(60, 180));
        log(o, "fraud-service", "error", "upstream risk-api responded 503 after retries", t + d);
        log(o, "payment-gateway", "error", "refund failed: upstream timeout", t + d + 200);
      });
      decoyPool();
      truth = {
        root_cause_service: "fraud-service",
        root_cause_operation: "fraud.check",
        cause: "downstream_http_degradation",
        max_status: "CONFIRMED",
        symptom_service: "payment-gateway",
        misleading_cause: "db_pool_saturation",
      };
      break;
    case "kafka-consumer-lag":
      symptom = "Refunds stay pending for minutes; payment-gateway reports nothing slow.";
      each((o, t) => {
        span(o, "payment-gateway", "gateway.refund", t, pick(120, 260));
        span(o, "refund-worker", "consume.refund-events", t + pick(240_000, 600_000), pick(5, 20));
        log(o, "refund-worker", "warn", "refund event processed late", t + 300_000);
      });
      for (let k = 0; k < 12; k++)
        metrics.push({
          service: "refund-worker",
          metric: "consumer_lag",
          ts_ms: base + k * 60_000,
          value: k < 2 ? pick(0, 20) : pick(9000, 20000),
        });
      decoys.forEach((o, k) =>
        log(o, "payment-provider", "warn", "slow response 1800 ms", base + 600 + k * 500),
      );
      truth = {
        root_cause_service: "refund-worker",
        root_cause_operation: "consume.refund-events",
        cause: "consumer_lag",
        max_status: "CONFIRMED",
        symptom_service: "payment-gateway",
        misleading_cause: "provider_timeout",
      };
      break;
    case "idempotency-conflict":
      symptom = REFUNDS_FAILING;
      each((o, t) => {
        // order-api submits the same refund twice within milliseconds with the same idempotency key.
        span(o, "order-api", "refund.submit", t, pick(20, 40));
        span(o, "order-api", "refund.submit", t + pick(2, 9), pick(20, 40));
        span(o, "payment-gateway", "gateway.refund", t + 30, pick(80, 120), "error");
        log(o, "payment-provider", "error", "409 idempotency key conflict", t + 60);
        log(o, "payment-gateway", "error", "refund failed: provider returned 409", t + 90);
      });
      decoyPool();
      truth = {
        root_cause_service: "order-api",
        root_cause_operation: "refund.submit",
        cause: "idempotency_conflict",
        max_status: "CONFIRMED",
        symptom_service: "payment-gateway",
        misleading_cause: "db_pool_saturation",
      };
      break;
    case "event-ordering":
      symptom = LEDGER_DRIFT;
      each((o, t) => {
        log(o, "ledger-service", "info", "applied refund.completed", t + 100);
        log(o, "ledger-service", "info", "applied refund.created", t + 400);
        log(o, "ledger-service", "warn", "refund.completed applied before refund.created", t + 401);
        span(o, "ledger-service", "ledger.apply", t + 100, pick(5, 15));
      });
      uniq
        .filter((o) => !affected.has(o))
        .forEach((o, k) => {
          log(o, "ledger-service", "info", "applied refund.created", base + k * 1000 + 100);
          log(o, "ledger-service", "info", "applied refund.completed", base + k * 1000 + 400);
        });
      decoys.forEach((o, k) =>
        log(o, "payment-provider", "warn", "slow response 1800 ms", base + 600 + k * 500),
      );
      truth = {
        root_cause_service: "ledger-service",
        root_cause_operation: "ledger.apply",
        cause: "event_ordering",
        max_status: "CONFIRMED",
        symptom_service: "ledger-service",
        misleading_cause: "provider_timeout",
      };
      break;
  }
  return {
    id: `INC-${scenario}-${seed}`,
    scenario,
    symptom,
    spans,
    logs,
    metrics,
    unavailable,
    truth: { ...truth!, affected_orders: affected.size, unavailable: [...unavailable].sort() },
  };
}

// ------------------------------------------------------------------------------------------------- tools

const INCIDENTS = new Map<string, Incident>();
const PAGE = {
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
};
function page<K extends string, T>(key: K, rows: T[], a: { limit?: number; offset?: number }) {
  if (a.limit == null && a.offset == null) return { [key]: rows } as Record<K, T[]>;
  const from = a.offset ?? 0;
  const to = from + (a.limit ?? 500);
  return {
    [key]: rows.slice(from, to),
    total: rows.length,
    next_offset: to < rows.length ? to : null,
  };
}
const incidentOf = (id: string) => {
  const inc = INCIDENTS.get(id);
  if (!inc) throw new Error(`unknown incident ${id}`);
  return inc;
};
let registered = false;
/** Read-only fixture tools over the registered incidents (scoped by the `incident` argument). */
export function registerRcaTools() {
  if (registered) return;
  registered = true;
  registerIntegrationTool({
    name: "rca.services",
    summary: "Fixture service catalog of an incident window",
    description:
      "Fixture service catalog: services and operations seen in the incident window. Args: incident.",
    input: z.object({ incident: z.string() }),
    readOnly: true,
    available: () => true,
    handler: async (a) => {
      const inc = incidentOf(a.incident);
      const ops: Record<string, Set<string>> = {};
      for (const s of inc.spans) (ops[s.service] ??= new Set()).add(s.operation);
      for (const l of inc.logs) ops[l.service] ??= new Set();
      return {
        services: Object.entries(ops)
          .map(([name, o]) => ({ name, operations: [...o].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  });
  registerIntegrationTool({
    name: "rca.traces",
    summary: "Fixture SigNoz-style span search of an incident",
    description:
      "Fixture SigNoz-style span search. Args: incident (required), optional service, operation, min_duration_ms, status (ok|error), order_ids (max 200), limit (1-500) and offset (then total and next_offset are returned).",
    input: z.object({
      incident: z.string(),
      service: z.string().optional(),
      operation: z.string().optional(),
      min_duration_ms: z.number().optional(),
      status: z.enum(["ok", "error"]).optional(),
      order_ids: z.array(z.string()).max(200).optional(),
      ...PAGE,
    }),
    readOnly: true,
    available: () => true,
    handler: async (a) => {
      const inc = incidentOf(a.incident);
      if (inc.unavailable.has("rca.traces"))
        throw new Error("SigNoz query failed: HTTP 503 Service Unavailable");
      return page(
        "spans",
        inc.spans.filter(
          (s) =>
            (!a.service || s.service === a.service) &&
            (!a.operation || s.operation === a.operation) &&
            (a.min_duration_ms == null || s.duration_ms >= a.min_duration_ms) &&
            (!a.status || s.status === a.status) &&
            (!a.order_ids || a.order_ids.includes(s.order_id)),
        ),
        a,
      );
    },
  });
  registerIntegrationTool({
    name: "rca.logs",
    summary: "Fixture Splunk-style log search of an incident",
    description:
      "Fixture Splunk-style log search. Args: incident (required), optional service, level (info|warn|error), contains (substring), order_ids (max 200), limit (1-500) and offset.",
    input: z.object({
      incident: z.string(),
      service: z.string().optional(),
      level: z.enum(["info", "warn", "error"]).optional(),
      contains: z.string().optional(),
      order_ids: z.array(z.string()).max(200).optional(),
      ...PAGE,
    }),
    readOnly: true,
    available: () => true,
    handler: async (a) => {
      const inc = incidentOf(a.incident);
      if (inc.unavailable.has("rca.logs")) throw new Error("Splunk search failed: HTTP 503");
      return page(
        "events",
        inc.logs.filter(
          (e) =>
            (!a.service || e.service === a.service) &&
            (!a.level || e.level === a.level) &&
            (!a.contains || e.message.includes(a.contains)) &&
            (!a.order_ids || a.order_ids.includes(e.order_id)),
        ),
        a,
      );
    },
  });
  registerIntegrationTool({
    name: "rca.metrics",
    summary: "Fixture metric series of an incident",
    description: "Fixture metric series (per minute). Args: incident, service, optional metric.",
    input: z.object({ incident: z.string(), service: z.string(), metric: z.string().optional() }),
    readOnly: true,
    available: () => true,
    handler: async (a) => ({
      series: incidentOf(a.incident).metrics.filter(
        (m) => m.service === a.service && (!a.metric || m.metric === a.metric),
      ),
    }),
  });
}

// ------------------------------------------------------------------------------------------------ grading

const ANSWER_SHAPE = `{"root_cause_service": string|null, "root_cause_operation": string|null, "cause": one of ${CAUSES.join("|")} or null, "status": "CONFIRMED"|"PROBABLE"|"UNCONFIRMED", "affected_orders": number|null, "missing_sources": [unavailable tool names, any order], "next_actions": [string]}`;

/** Remediation that treats a symptom (timeouts, retries, log levels, config knobs) — wrong unless evidence says so. */
const SYMPTOM_FIX =
  /\b(increase|raise|bump|extend)\b[^.]{0,40}\b(timeout|deadline)|\b(add|more|increase)\b[^.]{0,20}\bretr(y|ies)|\blog[- ]?level\b|\bincrease\b[^.]{0,30}\bpool size\b/i;

export interface RcaGrade {
  correct: boolean;
  answered: boolean;
  unsupported: number;
  fields: Record<string, boolean>;
  diagnostics: Record<string, FieldDiagnostic>;
  rca: {
    detection: boolean;
    service: boolean;
    operation: boolean;
    cause: boolean;
    fault_localized: boolean;
    correlation: boolean;
    symptom_as_cause: boolean;
    misleading_signal_taken: boolean;
    false_confirmation: boolean;
    uncertainty_reported: boolean;
    missing_sources_reported: boolean;
    unsafe_next_action: boolean;
  };
}

/**
 * RCA grading, dimension by dimension. Correct only when service, operation and cause are right, the affected-order
 * correlation holds, no CONFIRMED status exceeds what the evidence supports (outage, missing instrumentation, or a
 * wrong diagnosis confirmed), unavailable sources are reported, and no symptom-level fix (raise a timeout, add
 * retries, change log level, grow a pool) is recommended for a different root cause.
 */
export function gradeRca(truth: GroundTruth, answer: Record<string, unknown> | null): RcaGrade {
  const empty = {
    detection: false,
    service: false,
    operation: false,
    cause: false,
    fault_localized: false,
    correlation: false,
    symptom_as_cause: false,
    misleading_signal_taken: false,
    false_confirmation: false,
    uncertainty_reported: false,
    missing_sources_reported: false,
    unsafe_next_action: false,
  };
  if (!answer)
    return {
      correct: false,
      answered: false,
      unsupported: 0,
      fields: {},
      diagnostics: {},
      rca: empty,
    };
  const status = String(answer.status ?? "").toUpperCase();
  const service = answer.root_cause_service === truth.root_cause_service;
  const operation = answer.root_cause_operation === truth.root_cause_operation;
  const cause = answer.cause === truth.cause;
  const missing = Array.isArray(answer.missing_sources) ? answer.missing_sources.map(String) : [];
  const actions = Array.isArray(answer.next_actions) ? answer.next_actions.map(String) : [];
  const confirmed = status === "CONFIRMED";
  const rca = {
    detection: answer.cause != null && answer.root_cause_service != null,
    service,
    operation,
    cause,
    fault_localized: service && operation,
    correlation: answer.affected_orders === truth.affected_orders,
    symptom_as_cause:
      !service &&
      answer.root_cause_service === truth.symptom_service &&
      truth.symptom_service !== truth.root_cause_service,
    misleading_signal_taken:
      truth.misleading_cause != null && answer.cause === truth.misleading_cause,
    false_confirmation:
      confirmed && (!(service && operation && cause) || truth.max_status !== "CONFIRMED"),
    uncertainty_reported: truth.max_status === "CONFIRMED" || !confirmed,
    missing_sources_reported: truth.unavailable.every((t) => missing.includes(t)),
    // A symptom fix is acceptable only when the cause it addresses is the real one (e.g. pool sizing for pool saturation).
    unsafe_next_action: actions.some(
      (a) => SYMPTOM_FIX.test(a) && !(truth.cause === "db_pool_saturation" && /pool/i.test(a)),
    ),
  };
  const correct =
    rca.fault_localized &&
    rca.cause &&
    rca.correlation &&
    !rca.false_confirmation &&
    rca.uncertainty_reported &&
    rca.missing_sources_reported &&
    !rca.unsafe_next_action;
  const fields = {
    root_cause_service: service,
    root_cause_operation: operation,
    cause,
    affected_orders: rca.correlation,
    status: !rca.false_confirmation && rca.uncertainty_reported,
    missing_sources: rca.missing_sources_reported,
    next_actions: !rca.unsafe_next_action,
  };
  const diagnostics: Record<string, FieldDiagnostic> = {};
  const exp: Record<string, unknown> = {
    root_cause_service: truth.root_cause_service,
    root_cause_operation: truth.root_cause_operation,
    cause: truth.cause,
    affected_orders: truth.affected_orders,
    status: truth.max_status === "CONFIRMED" ? "CONFIRMED (correct diagnosis)" : "not CONFIRMED",
    missing_sources: truth.unavailable,
    next_actions: "no symptom-level fix for another cause",
  };
  for (const [k, ok] of Object.entries(fields))
    if (!ok) diagnostics[k] = { expected: exp[k], actual: answer[k] ?? null };
  return {
    correct,
    answered: true,
    unsupported: rca.false_confirmation ? 1 : 0,
    fields,
    diagnostics,
    rca,
  };
}

// ------------------------------------------------------------------------------------------------ tasks

/**
 * The reference plan of a scenario, as a self-contained program (the incident id is a literal in its source, so it runs
 * verbatim as a CodeAct program). It reaches the answer only through the rca.* tools.
 */
function planSource(inc: Incident): string {
  const id = JSON.stringify(inc.id);
  const common = `
  const I = ${id};
  const tryCall = async (n, a) => { try { return await call(n, { incident: I, ...a }); } catch { return null; } };
  const missing = [];
  const traces = async (a) => { const r = await tryCall("rca.traces", a); if (!r) { if (!missing.includes("rca.traces")) missing.push("rca.traces"); return null; } return r.spans; };
  const logs = async (a) => { const r = await tryCall("rca.logs", a); if (!r) { if (!missing.includes("rca.logs")) missing.push("rca.logs"); return null; } return r.events; };
  const distinct = (xs) => [...new Set(xs.map((x) => x.order_id))];
  const answer = (service, operation, cause, status, affected) => ({
    root_cause_service: service, root_cause_operation: operation, cause, status,
    affected_orders: affected, missing_sources: missing, next_actions: ["inspect " + service + " " + operation],
  });`;
  const slowGateway = `
  const slowGw = await traces({ service: "payment-gateway", operation: "gateway.refund", min_duration_ms: 5000 });`;
  const body: Record<Scenario, string> = {
    "provider-timeout": `${slowGateway}
  const ids = distinct(slowGw);
  const prov = await traces({ service: "payment-provider", operation: "provider.refund.http", min_duration_ms: 5000, order_ids: ids });
  return answer("payment-provider", "provider.refund.http", "provider_timeout", "CONFIRMED", distinct(prov).length);`,
    "misleading-warnings": "",
    "missing-spans": `${slowGateway}
  const ids = distinct(slowGw);
  const deadline = await logs({ service: "payment-provider", contains: "exceeded 5000 ms deadline", order_ids: ids });
  return answer("payment-provider", "provider.refund.http", "provider_timeout", "CONFIRMED", distinct(deadline).length);`,
    "partial-outage": `
  const gw = await logs({ service: "payment-gateway", contains: "upstream timeout" });
  const ids = gw ? distinct(gw) : [];
  const deadline = await logs({ service: "payment-provider", contains: "exceeded 5000 ms deadline", order_ids: ids });
  await traces({ service: "payment-provider", order_ids: ids });
  return answer("payment-provider", "provider.refund.http", "provider_timeout", missing.length ? "PROBABLE" : "CONFIRMED", distinct(deadline ?? []).length);`,
    "retry-amplification": `${slowGateway}
  const ids = distinct(slowGw);
  const retries = await logs({ service: "refund-worker", contains: "retrying refund", order_ids: ids });
  return answer("refund-worker", "refund.retry", "retry_amplification", "CONFIRMED", distinct(retries).length);`,
    "db-pool-saturation": `${slowGateway}
  const ids = distinct(slowGw);
  const acquire = await traces({ service: "refund-worker", operation: "refund.db.acquire", min_duration_ms: 5000, order_ids: ids });
  return answer("refund-worker", "refund.db.acquire", "db_pool_saturation", "CONFIRMED", distinct(acquire).length);`,
    "downstream-http": `${slowGateway}
  const ids = distinct(slowGw);
  const fraud = await traces({ service: "fraud-service", operation: "fraud.check", min_duration_ms: 5000, order_ids: ids });
  return answer("fraud-service", "fraud.check", "downstream_http_degradation", "CONFIRMED", distinct(fraud).length);`,
    "kafka-consumer-lag": `
  const late = await logs({ service: "refund-worker", contains: "processed late" });
  return answer("refund-worker", "consume.refund-events", "consumer_lag", "CONFIRMED", distinct(late).length);`,
    "idempotency-conflict": `
  const conflicts = await logs({ service: "payment-provider", contains: "409 idempotency key conflict" });
  const subs = await traces({ service: "order-api", operation: "refund.submit", order_ids: distinct(conflicts) });
  const counts = {}; for (const s of subs) counts[s.order_id] = (counts[s.order_id] ?? 0) + 1;
  return answer("order-api", "refund.submit", "idempotency_conflict", "CONFIRMED", Object.values(counts).filter((n) => n > 1).length);`,
    "event-ordering": `
  const bad = await logs({ service: "ledger-service", contains: "applied before" });
  return answer("ledger-service", "ledger.apply", "event_ordering", "CONFIRMED", distinct(bad).length);`,
  };
  body["misleading-warnings"] = body["provider-timeout"];
  return `${common}\n${body[inc.scenario]}`;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (
  call: (n: string, a: Record<string, unknown>) => Promise<unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Evaluation tasks for the given scenarios and seeds (registered with the rca.* tools). The question gives only the
 * symptom and the tools; the ground truth is never in the prompt.
 */
export function rcaTasks(
  seeds: number[] = [1],
  scenarios: readonly Scenario[] = SCENARIOS,
): EffectTask[] {
  registerRcaTools();
  return seeds.flatMap((seed) =>
    scenarios.map((scenario) => {
      const inc = generateIncident(scenario, seed);
      INCIDENTS.set(inc.id, inc);
      const plan = new AsyncFunction("call", planSource(inc));
      return {
        id: inc.id,
        category: `RCA: ${scenario}`,
        eligible: true,
        question: `Incident ${inc.id}: ${inc.symptom} Investigate with rca.services, rca.traces, rca.logs and rca.metrics (always pass "incident": "${inc.id}"). Find the root cause, not the symptom: the failing service and operation, the cause, how many orders it affected, and whether the evidence confirms it. Some warnings may be unrelated; some integrations may be unavailable. Reply with your conclusion as a fenced block \`\`\`answer containing only JSON of the form ${ANSWER_SHAPE}. Use null for anything you could not determine; use CONFIRMED only when the evidence establishes the cause.`,
        plan,
        reference: () => ({ ...inc.truth }) as unknown as Record<string, unknown>,
        grade: (_expected: Record<string, unknown>, answer: Record<string, unknown> | null) =>
          gradeRca(inc.truth, answer),
      } satisfies EffectTask;
    }),
  );
}
export const incidentForTests = (id: string) => INCIDENTS.get(id);

/**
 * The reference plan of an incident as one CodeAct program for the workflow arm: the same plan the other arms run,
 * plus the size of every successful nested result (in call order) so an agent can state checkable `observed` counts.
 */
export function incidentProgram(taskId: string): string {
  const inc = INCIDENTS.get(taskId);
  if (!inc) throw new Error(`unknown incident ${taskId}`);
  return `const sizes = [];
const call = async (n, a) => {
  const r = await platform.callTool(n, a);
  const key = Array.isArray(r?.spans) ? "spans" : Array.isArray(r?.events) ? "events" : null;
  sizes.push({ tool: n, key, count: key ? r[key].length : null });
  return r;
};
const answer = await (async (call) => {${planSource(inc)}
})(call);
return { answer, sizes };`;
}
