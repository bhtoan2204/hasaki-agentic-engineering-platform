/**
 * CodeAct effectiveness dataset (M2): ten read-only investigation tasks over one deterministic, fake incident window
 * of a payment platform (traces, logs, orders, service catalog). The fixture tools are ordinary read-only registry
 * integration tools, so both variants reach them through the platform's real dispatch path (Chat `tools.call` and
 * CodeAct nested calls). Each task has a reference solution (`plan`), used to compute the expected answer; a plan is a
 * self-contained async function of `call(name, args)` so it can also run, unchanged, as a CodeAct program.
 *
 * CodeAct-eligible (the definition the adoption metrics use): the task needs two or more deterministic read-only
 * lookups whose results must be combined, or one result whose useful content is an aggregate of a large payload.
 * A single small lookup is not eligible.
 */
import { z } from "zod";
import { registerIntegrationTool } from "../agent/toolRegistry.ts";

export const SERVICES = [
  "payment-gateway",
  "payment-provider",
  "refund-worker",
  "order-api",
] as const;
const OPERATIONS: Record<string, string[]> = {
  "payment-gateway": ["gateway.charge", "gateway.refund"],
  "payment-provider": ["provider.charge.http", "provider.refund.http"],
  "refund-worker": ["refund.db.update", "refund.provider.call"],
  "order-api": ["order.get"],
};
/** Refund calls to the provider stall for these orders (the real cause). */
const stalled = (o: number) => o % 12 === 5;
/** A slow but harmless DB write on these orders, plus pool warnings: the misleading signal. */
const dbNoise = (o: number) => o % 20 === 3;

export interface Span {
  trace_id: string;
  service: string;
  operation: string;
  order_id: string;
  duration_ms: number;
  attributes: Record<string, string>;
}
export interface LogEvent {
  time: string;
  service: string;
  level: "info" | "warn" | "error";
  order_id: string;
  message: string;
  raw: string;
}
/** One trace per order (150 orders) with a span for every operation of every service. */
export const SPANS: Span[] = Array.from({ length: 150 }, (_, o) =>
  SERVICES.flatMap((service) =>
    OPERATIONS[service].map((operation, k) => {
      const base = 20 + ((o * 7 + k * 5) % 30);
      const duration_ms = stalled(o)
        ? operation === "provider.refund.http"
          ? 8000 + o
          : operation === "refund.provider.call"
            ? 8020 + o
            : operation === "gateway.refund"
              ? 8050 + o
              : base
        : dbNoise(o) && operation === "refund.db.update"
          ? 900
          : base;
      return {
        trace_id: `tr-ORD-${o}`,
        service,
        operation,
        order_id: `ORD-${o}`,
        duration_ms,
        attributes: { "http.route": `/v1/${operation}`, padding: "x".repeat(100) },
      };
    }),
  ),
).flat();
/** 2000 events; every order logs in every service. */
export const EVENTS: LogEvent[] = Array.from({ length: 2000 }, (_, i) => {
  const o = i % 150;
  const service = SERVICES[Math.floor(i / 150) % 4];
  const [level, message]: [LogEvent["level"], string] =
    service === "payment-gateway" && stalled(o)
      ? ["error", "upstream timeout calling payment-provider /refund"]
      : service === "refund-worker" && dbNoise(o)
        ? ["warn", "db pool saturated"]
        : i % 13 === 0
          ? ["error", "card declined"]
          : i % 31 === 0
            ? ["error", "idempotency key conflict"]
            : ["info", "request completed"];
  return {
    time: new Date(Date.UTC(2026, 10, 20, 2, 0, 0) + i * 1500).toISOString(),
    service,
    level,
    order_id: `ORD-${o}`,
    message,
    raw: "r".repeat(140),
  };
});
const ORDERS = Object.fromEntries(
  Array.from({ length: 150 }, (_, i) => [
    `ORD-${i}`,
    {
      order_id: `ORD-${i}`,
      status: i % 9 === 0 ? "refund_pending" : i % 4 === 0 ? "refunded" : "paid",
      amount_vnd: 100000 + i * 1000,
    },
  ]),
);

/** Fixture integration failures, e.g. SigNoz down for one service (partial integration failure). */
const UNAVAILABLE_TRACES = new Set(["refund-worker"]);

let registered = false;
/** Register the fixture tools once (read-only; fake data; no network). */
/**
 * Bounded paging, available to both variants alike: a capable direct strategy can page or filter instead of receiving
 * one response the chat truncates. Without limit/offset the response is unchanged (the reference plans use none).
 */
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
  } as Record<K, T[]> & { total: number; next_offset: number | null };
}

export function registerEvaluationTools() {
  if (registered) return;
  registered = true;
  registerIntegrationTool({
    name: "eval.orders",
    summary: "Fixture order lookup by id",
    description: "Fixture order service: one order by id (status, amount).",
    input: z.object({ order_id: z.string() }),
    readOnly: true,
    available: () => true,
    handler: async (a) => {
      const o = ORDERS[a.order_id];
      if (!o) throw new Error(`order ${a.order_id} not found`);
      return o;
    },
  });
  registerIntegrationTool({
    name: "eval.services",
    summary: "Fixture service catalog",
    description: "Fixture service catalog: registered services and their operations.",
    input: z.object({}),
    readOnly: true,
    available: () => true,
    handler: async () => ({
      services: SERVICES.map((s) => ({ name: s, operations: OPERATIONS[s] })),
    }),
  });
  registerIntegrationTool({
    name: "eval.traces",
    summary: "Fixture SigNoz-style span search",
    description:
      "Fixture SigNoz-style span search. Args: service (required), optional operation, min_duration_ms, order_ids (max 200); optional limit (1-500) and offset page the result (then `total` and `next_offset` are returned).",
    input: z.object({
      service: z.string(),
      operation: z.string().optional(),
      min_duration_ms: z.number().optional(),
      order_ids: z.array(z.string()).max(200).optional(),
      ...PAGE,
    }),
    readOnly: true,
    available: () => true,
    handler: async (a) => {
      if (UNAVAILABLE_TRACES.has(a.service))
        throw new Error(`SigNoz unavailable for ${a.service} (HTTP 503)`);
      return page(
        "spans",
        SPANS.filter(
          (s) =>
            s.service === a.service &&
            (!a.operation || s.operation === a.operation) &&
            (a.min_duration_ms == null || s.duration_ms >= a.min_duration_ms) &&
            (!a.order_ids || a.order_ids.includes(s.order_id)),
        ),
        a,
      );
    },
  });
  registerIntegrationTool({
    name: "eval.logs",
    summary: "Fixture Splunk-style log search",
    description:
      "Fixture Splunk-style log search. Optional args: service, level, contains (substring of message), order_ids (max 200); optional limit (1-500) and offset page the result (then `total` and `next_offset` are returned).",
    input: z.object({
      service: z.string().optional(),
      level: z.enum(["info", "warn", "error"]).optional(),
      contains: z.string().optional(),
      order_ids: z.array(z.string()).max(200).optional(),
      ...PAGE,
    }),
    readOnly: true,
    available: () => true,
    handler: async (a) =>
      page(
        "events",
        EVENTS.filter(
          (e) =>
            (!a.service || e.service === a.service) &&
            (!a.level || e.level === a.level) &&
            (!a.contains || e.message.includes(a.contains)) &&
            (!a.order_ids || a.order_ids.includes(e.order_id)),
        ),
        a,
      ),
  });
}

// Plans also run as sandboxed JavaScript, so tool results are untyped there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = (name: string, args: Record<string, unknown>) => Promise<any>;
export interface EffectTask {
  id: string;
  category: string;
  eligible: boolean;
  question: string;
  /** Reference solution: self-contained (no closures), so it also runs verbatim as a CodeAct program. */
  plan: (call: Call) => Promise<Record<string, unknown>>;
  /**
   * How each answer field is compared (default `exact`). `set`: an identifier list whose order carries no meaning —
   * same members, no duplicates. `ordered`: a ranking — same items in the same order. `count`: a number that must
   * equal the reference and is also checked against the answer's own list (`of`). The question states the same
   * semantics, and both variants are graded by them.
   */
  grading?: Record<string, FieldRule>;
  /** A documented ground truth (instead of running `plan`); the plan must still derive it from the tools. */
  reference?: () => Record<string, unknown>;
  /** A task-specific grader (e.g. RCA dimensions); otherwise `gradeAnswer` with `grading`. */
  grade?: (
    expected: Record<string, unknown>,
    answer: Record<string, unknown> | null,
  ) => {
    correct: boolean;
    fields: Record<string, boolean>;
    unsupported: number;
    answered: boolean;
    diagnostics: Record<string, FieldDiagnostic>;
    rca?: Record<string, boolean>;
  };
}
export type FieldRule =
  { kind: "exact" } | { kind: "set" } | { kind: "ordered" } | { kind: "count"; of: string };
const ANSWER = (shape: string) =>
  `Reply with your conclusion as a fenced block \`\`\`answer containing only JSON of the form ${shape}. Use null for anything you could not determine.`;

export const TASKS: EffectTask[] = [
  {
    id: "T01-single-lookup",
    category: "single read-only lookup",
    eligible: false,
    question: `Investigate order ORD-7 with the eval.orders tool: what is its status? ${ANSWER('{"status": string}')}`,
    plan: async (call) => ({ status: (await call("eval.orders", { order_id: "ORD-7" })).status }),
  },
  {
    id: "T02-independent-lookups",
    category: "multiple independent lookups",
    eligible: true,
    question: `Investigate orders ORD-3, ORD-11, ORD-42 and ORD-99 with eval.orders: what is each status? ${ANSWER('{"statuses": {"ORD-3": string, ...}}')}`,
    plan: async (call) => {
      const ids = ["ORD-3", "ORD-11", "ORD-42", "ORD-99"];
      const rows = await Promise.all(ids.map((id) => call("eval.orders", { order_id: id })));
      return { statuses: Object.fromEntries(rows.map((r) => [r.order_id, r.status])) };
    },
  },
  {
    id: "T03-trace-log-correlation",
    grading: { order_ids: { kind: "set" }, count: { kind: "count", of: "order_ids" } },
    category: "SigNoz trace and Splunk log correlation",
    eligible: true,
    question: `Investigate with eval.traces and eval.logs: which orders have a payment-gateway span of at least 5000 ms AND a payment-gateway log containing "upstream timeout"? ${ANSWER('{"order_ids": [order ids, each once, any order], "count": number}')}`,
    plan: async (call) => {
      const { spans } = await call("eval.traces", {
        service: "payment-gateway",
        min_duration_ms: 5000,
      });
      const slow = [...new Set(spans.map((s: { order_id: string }) => s.order_id))];
      const { events } = await call("eval.logs", {
        service: "payment-gateway",
        contains: "upstream timeout",
        order_ids: slow,
      });
      const ids = [...new Set(events.map((e: { order_id: string }) => e.order_id))].sort();
      return { order_ids: ids, count: ids.length };
    },
  },
  {
    id: "T04-slow-operations",
    category: "searching slow operations across services",
    eligible: true,
    question: `Investigate with eval.traces: for payment-gateway, payment-provider and order-api, which operation has the highest maximum span duration in each, and which is slowest overall? ${ANSWER('{"per_service": {"<service>": "<operation>"}, "slowest_operation": string}')}`,
    plan: async (call) => {
      const services = ["payment-gateway", "payment-provider", "order-api"];
      const per: Record<string, string> = {};
      let best = { op: "", ms: -1 };
      for (const service of services) {
        const { spans } = await call("eval.traces", { service });
        const top = spans.reduce(
          (
            a: { operation: string; duration_ms: number },
            s: { operation: string; duration_ms: number },
          ) => (s.duration_ms > a.duration_ms ? s : a),
        );
        per[service] = top.operation;
        if (top.duration_ms > best.ms) best = { op: top.operation, ms: top.duration_ms };
      }
      return { per_service: per, slowest_operation: best.op };
    },
  },
  {
    id: "T05-common-failures",
    grading: { top: { kind: "ordered" } },
    category: "extracting common failures from structured logs",
    eligible: true,
    question: `Investigate with eval.logs: what are the three most frequent error-level log messages across all services, with counts? ${ANSWER('{"top": [{"message": string, "count": number}] ordered by count descending, ties by message ascending}')}`,
    plan: async (call) => {
      const { events } = await call("eval.logs", { level: "error" });
      const counts: Record<string, number> = {};
      for (const e of events) counts[e.message] = (counts[e.message] ?? 0) + 1;
      const top = Object.entries(counts)
        .map(([message, count]) => ({ message, count }))
        .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
        .slice(0, 3);
      return { top };
    },
  },
  {
    id: "T06-refund-timeout",
    category: "payment/refund timeout investigation",
    eligible: true,
    question: `Refunds time out at payment-gateway. Investigate with eval.traces and eval.logs: which downstream operation accounts for the latency of gateway.refund spans of at least 5000 ms, how many such slow refund orders are there, and how many of them also have a refund-worker "db pool saturated" warning? ${ANSWER('{"root_operation": string, "slow_refund_orders": number, "db_pool_warning_overlap": number}')}`,
    plan: async (call) => {
      const slow = (
        await call("eval.traces", {
          service: "payment-gateway",
          operation: "gateway.refund",
          min_duration_ms: 5000,
        })
      ).spans.map((s: { order_id: string }) => s.order_id);
      const orders = [...new Set(slow)] as string[];
      const { spans } = await call("eval.traces", {
        service: "payment-provider",
        min_duration_ms: 5000,
        order_ids: orders,
      });
      const byOp: Record<string, number> = {};
      for (const s of spans) byOp[s.operation] = (byOp[s.operation] ?? 0) + 1;
      const root = Object.entries(byOp).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const { events } = await call("eval.logs", {
        service: "refund-worker",
        contains: "db pool saturated",
        order_ids: orders,
      });
      const overlap = new Set(events.map((e: { order_id: string }) => e.order_id)).size;
      return {
        root_operation: root,
        slow_refund_orders: orders.length,
        db_pool_warning_overlap: overlap,
      };
    },
  },
  {
    id: "T07-cross-source-evidence",
    grading: { errors: { kind: "set" } },
    category: "related evidence across several sources",
    eligible: true,
    question: `Investigate order ORD-25 across eval.orders, eval.traces (payment-gateway and payment-provider) and eval.logs: its status, its slowest operation, and its distinct error messages. ${ANSWER('{"status": string, "slowest_operation": string, "errors": [distinct messages, any order]}')}`,
    plan: async (call) => {
      const id = "ORD-25";
      const [o, gw, pv, logs] = await Promise.all([
        call("eval.orders", { order_id: id }),
        call("eval.traces", { service: "payment-gateway", order_ids: [id] }),
        call("eval.traces", { service: "payment-provider", order_ids: [id] }),
        call("eval.logs", { order_ids: [id], level: "error" }),
      ]);
      const spans = [...gw.spans, ...pv.spans];
      const top = spans.reduce(
        (
          a: { operation: string; duration_ms: number },
          s: { operation: string; duration_ms: number },
        ) => (s.duration_ms > a.duration_ms ? s : a),
      );
      const errors = [...new Set(logs.events.map((e: { message: string }) => e.message))].sort();
      return { status: o.status, slowest_operation: top.operation, errors };
    },
  },
  {
    id: "T08-large-aggregation",
    category: "large tool response requiring aggregation",
    eligible: true,
    question: `Investigate with eval.logs: how many distinct orders logged "card declined", and how many such events are there? ${ANSWER('{"distinct_orders": number, "events": number}')}`,
    plan: async (call) => {
      const { events } = await call("eval.logs", { contains: "card declined" });
      return {
        distinct_orders: new Set(events.map((e: { order_id: string }) => e.order_id)).size,
        events: events.length,
      };
    },
  },
  {
    id: "T09-partial-failure",
    grading: { unavailable: { kind: "set" } },
    category: "tool timeout or partial integration failure",
    eligible: true,
    question: `Investigate refund-worker: how many distinct orders have a "db pool saturated" warning (eval.logs), and what is refund-worker's slowest operation (eval.traces)? If a source is unavailable, say which. ${ANSWER('{"db_pool_warning_orders": number, "slowest_operation": string|null, "unavailable": [tool names, any order]}')}`,
    plan: async (call) => {
      const { events } = await call("eval.logs", {
        service: "refund-worker",
        contains: "db pool saturated",
      });
      let slowest = null;
      const unavailable: string[] = [];
      try {
        const { spans } = await call("eval.traces", { service: "refund-worker" });
        slowest = spans.reduce(
          (
            a: { operation: string; duration_ms: number },
            s: { operation: string; duration_ms: number },
          ) => (s.duration_ms > a.duration_ms ? s : a),
        ).operation;
      } catch {
        unavailable.push("eval.traces");
      }
      return {
        db_pool_warning_orders: new Set(events.map((e: { order_id: string }) => e.order_id)).size,
        slowest_operation: slowest,
        unavailable,
      };
    },
  },
  {
    id: "T10-codeact-unnecessary",
    grading: { services: { kind: "set" } },
    category: "CodeAct unnecessary",
    eligible: false,
    question: `Investigate with eval.services: which services are registered? ${ANSWER('{"services": [names, any order]}')}`,
    plan: async (call) => ({
      services: (await call("eval.services", {})).services
        .map((s: { name: string }) => s.name)
        .sort(),
    }),
  },
];

/** The reference answer of a task, computed by its plan against the fixture tools (in process, no dispatch). */
export async function referenceAnswer(task: EffectTask) {
  registerEvaluationTools();
  const { callTool } = await import("../agent/toolRegistry.ts");
  return task.plan(async (name, args) => {
    const r = await callTool(name, args, {
      runId: null,
      allowedRepositories: [],
      mode: "analysis",
    });
    if (!r.ok) throw new Error(r.error ?? `${name} failed`);
    return r.result;
  });
}

/** The ```answer JSON block of a final reply, or null. */
export function parseAnswer(text: string): Record<string, unknown> | null {
  const m = /```answer\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v ?? null);

export interface FieldDiagnostic {
  expected: unknown;
  actual: unknown;
  /** Lists: members of the reference absent from the answer, and members the reference does not have. */
  missing?: unknown[];
  unexpected?: unknown[];
  duplicates?: unknown[];
  /** Same members in a different order (only an error for `ordered` fields). */
  order_differs?: boolean;
  /** `count` fields: whether the number agrees with the answer's own list. */
  consistent_with?: { field: string; distinct: number | null; consistent: boolean };
}

/** Members of `xs` that occur more than once (by canonical JSON), each reported once. */
function duplicatesOf(xs: unknown[]) {
  const seen = new Set<string>();
  const dup = new Map<string, unknown>();
  for (const x of xs) {
    const k = canonical(x);
    if (seen.has(k)) dup.set(k, x);
    seen.add(k);
  }
  return [...dup.values()];
}
function listDiagnostic(expected: unknown, actual: unknown): FieldDiagnostic {
  const d: FieldDiagnostic = { expected, actual };
  if (!Array.isArray(expected) || !Array.isArray(actual)) return d;
  const exp = new Set(expected.map(canonical));
  const act = new Set(actual.map(canonical));
  d.missing = expected.filter((x) => !act.has(canonical(x)));
  d.unexpected = [
    ...new Map(actual.filter((x) => !exp.has(canonical(x))).map((x) => [canonical(x), x])).values(),
  ];
  d.duplicates = duplicatesOf(actual);
  d.order_differs =
    !d.missing.length &&
    !d.unexpected.length &&
    canonical(expected) !== canonical([...new Map(actual.map((x) => [canonical(x), x])).values()]);
  return d;
}

/**
 * Deterministic grading, field by field, under the task's declared rules (`exact` unless stated): identifier sets
 * compare members and reject duplicates, rankings compare order, counts must match the reference. Each field gets a
 * diagnosis so a mismatch is inspectable (missing / unexpected / duplicate ids, ordering, count consistency).
 * `unsupported` counts fields the answer asserts (non-null) that are null in the reference — a conclusion the evidence
 * does not support. The same rules apply to every variant.
 */
export function gradeAnswer(
  expected: Record<string, unknown>,
  answer: Record<string, unknown> | null,
  rules: Record<string, FieldRule> = {},
) {
  if (!answer)
    return { correct: false, fields: {}, unsupported: 0, answered: false, diagnostics: {} };
  const fields: Record<string, boolean> = {};
  const diagnostics: Record<string, FieldDiagnostic> = {};
  let unsupported = 0;
  for (const [k, v] of Object.entries(expected)) {
    const got = answer[k];
    const rule = rules[k] ?? { kind: "exact" };
    if (rule.kind === "set" || rule.kind === "ordered") {
      const d = listDiagnostic(v, got);
      diagnostics[k] = d;
      fields[k] =
        Array.isArray(v) &&
        Array.isArray(got) &&
        !d.missing!.length &&
        !d.unexpected!.length &&
        !d.duplicates!.length &&
        (rule.kind === "set" || canonical(v) === canonical(got));
    } else if (rule.kind === "count") {
      const list = answer[rule.of];
      const distinct = Array.isArray(list) ? new Set(list.map(canonical)).size : null;
      diagnostics[k] = {
        expected: v,
        actual: got ?? null,
        consistent_with: {
          field: rule.of,
          distinct,
          consistent: distinct != null && got === distinct,
        },
      };
      fields[k] = canonical(got) === canonical(v);
    } else {
      fields[k] = canonical(got) === canonical(v);
      if (!fields[k]) diagnostics[k] = { expected: v, actual: got ?? null };
    }
    if (v == null && got != null) unsupported++;
  }
  return {
    correct: Object.values(fields).every(Boolean),
    fields,
    unsupported,
    answered: true,
    diagnostics,
  };
}
