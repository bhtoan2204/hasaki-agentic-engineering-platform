import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockedDestinationError, classifyAddress, validateBaseUrl } from "../src/integrations/safeHttp.ts";
import {
  checkExpression,
  clampLimit,
  filterExpression,
  listServicesQuery,
  logsAggregate,
  logsSearch,
  metricsQuery,
  parseRaw,
  parseScalar,
  parseTimeSeries,
  resolveWindow,
  SignozError,
  traceById,
  traceGaps,
  tracesSearch,
} from "../src/integrations/signoz.ts";
import { idFieldOf } from "../src/investigation/events.ts";

const W = { start: 1_000_000, end: 1_900_000 };
type QuerySpec = Record<string, unknown> & {
  filter: { expression: string };
  order: Array<{ direction: string }>;
  groupBy: Array<{ name: string }>;
};
const specOf = (body: ReturnType<typeof logsSearch>) => body.compositeQuery.queries[0].spec as QuerySpec;

test("addresses are classified: metadata always blocked, private ranges internal, the rest public", () => {
  for (const ip of ["169.254.169.254", "fd00:ec2::254", "::ffff:169.254.169.254"]) assert.equal(classifyAddress(ip), "metadata", ip);
  for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "100.64.0.1", "::1", "fd12::1", "fe80::1", "0.0.0.0", "::ffff:10.0.0.1"])
    assert.equal(classifyAddress(ip), "internal", ip);
  for (const ip of ["8.8.8.8", "2606:4700::1111"]) assert.equal(classifyAddress(ip), "public", ip);
});

test("base URLs: https only, no credentials/query, internal and metadata hosts need approval or are refused", () => {
  assert.equal(validateBaseUrl("https://signoz.example.com/", []).href, "https://signoz.example.com/");
  const bad = [
    "http://signoz.example.com",
    "ftp://signoz.example.com",
    "https://user:pw@signoz.example.com",
    "https://signoz.example.com/?x=1",
    "https://10.0.0.5",
    "https://[::1]:8080",
    "https://169.254.169.254",
    "https://metadata.google.internal",
    "not a url",
  ];
  for (const u of bad) assert.throws(() => validateBaseUrl(u, []), BlockedDestinationError, u);
  assert.equal(validateBaseUrl("http://10.0.0.5:3301", ["10.0.0.5"]).host, "10.0.0.5:3301", "approved internal host, http allowed");
  assert.throws(() => validateBaseUrl("https://169.254.169.254", ["169.254.169.254"]), BlockedDestinationError, "metadata never approvable");
});

test("structured filters compile to a quoted, escaped expression per signal", () => {
  const e = filterExpression("logs", { service: "oms-api", severity: "error", trace_id: "abc", operation: "ignored for logs" });
  assert.equal(e, "service.name = 'oms-api' AND severity_text = 'ERROR' AND trace_id = 'abc'");
  assert.equal(filterExpression("traces", { service: "a'b\\c", has_error: true, status_code: 500 }),
    "service.name = 'a\\'b\\\\c' AND has_error = true AND response_status_code = '500'");
  assert.equal(filterExpression("logs", { expression: "body CONTAINS 'x'" }), "(body CONTAINS 'x')");
  for (const bad of ["a = 'b'; drop", "a = `b`", "a = 'b", "x".repeat(1001)]) assert.throws(() => checkExpression(bad), SignozError, bad);
});

test("windows default to the configured minutes, honour ISO bounds and are capped", () => {
  const now = Date.parse("2026-11-17T10:00:00Z");
  assert.deepEqual(resolveWindow({}, 15, now), { start: now - 15 * 60_000, end: now });
  assert.deepEqual(resolveWindow({ since_minutes: 5 }, 15, now), { start: now - 5 * 60_000, end: now });
  const w = resolveWindow({ earliest: "2026-11-17T08:00:00+07:00", latest: "2026-11-17T08:30:00+07:00" }, 15, now);
  assert.equal(w.end - w.start, 30 * 60_000);
  assert.equal(resolveWindow({ since_minutes: 10 * 24 * 60 }, 15, now).start, now - 7 * 24 * 60 * 60_000, "capped at 7 days");
  assert.throws(() => resolveWindow({ earliest: "2026-11-17T09:00:00Z", latest: "2026-11-17T08:00:00Z" }, 15, now), SignozError);
  assert.throws(() => resolveWindow({ earliest: "yesterday" }, 15, now), SignozError);
  assert.equal(clampLimit(), 100);
  assert.equal(clampLimit(5000), 1000);
  assert.equal(clampLimit(0), 1);
});

test("request builders produce the documented v5 query_range bodies", () => {
  const logs = logsSearch(W, { severity: "ERROR" }, 50, 100);
  assert.equal(logs.requestType, "raw");
  assert.deepEqual({ ...specOf(logs) }, {
    name: "A",
    disabled: false,
    signal: "logs",
    filter: { expression: "severity_text = 'ERROR'" },
    order: [{ key: { name: "timestamp" }, direction: "desc" }],
    limit: 50,
    offset: 100,
  });
  const agg = logsAggregate(W, {}, ["service.name"]);
  assert.equal(agg.requestType, "scalar");
  assert.deepEqual(specOf(agg).aggregations, [{ expression: "count()", alias: "value" }]);
  assert.deepEqual(specOf(agg).groupBy, [{ name: "service.name", fieldContext: "resource" }]);
  assert.equal(logsAggregate(W, {}, [], "count()", 20, true).requestType, "time_series");
  assert.throws(() => logsAggregate(W, {}, [], "count() ; x"), SignozError);
  assert.equal(specOf(tracesSearch(W, { has_error: true })).signal, "traces");
  const trace = traceById(W, "t1");
  assert.equal(specOf(trace).filter.expression, "trace_id = 't1'");
  assert.equal(specOf(trace).order[0].direction, "asc");
  const m = metricsQuery(W, { metric: "signoz_calls_total", time_aggregation: "rate", group_by: ["service.name"] }, { service: "oms" });
  assert.equal(m.requestType, "time_series");
  assert.deepEqual(specOf(m).aggregations, [{ metricName: "signoz_calls_total", timeAggregation: "rate", spaceAggregation: "sum" }]);
  assert.throws(() => metricsQuery(W, { metric: "bad metric!" }, {}), SignozError);
  assert.equal(specOf(listServicesQuery(W)).groupBy[0].name, "service.name");
  for (const b of [logs, agg, trace, m]) assert.deepEqual([b.start, b.end], [W.start, W.end]);
});

test("spans carry tree fields and request ids; request_id filters every request id attribute", () => {
  const spec = specOf(tracesSearch(W, {}, 10, 0, false, ["request.id", "request_id"]));
  const fields = (spec.selectFields as Array<{ name: string }>).map((f) => f.name);
  for (const f of ["span_id", "parent_span_id", "duration_nano", "has_error", "request.id", "request_id"]) assert.ok(fields.includes(f), f);
  assert.equal(
    filterExpression("traces", { request_id: "4d67'x" }, ["request.id", "request_id"]),
    "(request.id = '4d67\\'x' OR request_id = '4d67\\'x')",
  );
  assert.throws(() => filterExpression("traces", { request_id: "r1" }), SignozError);
  assert.equal(idFieldOf("request.id"), "request_id");
  assert.equal(idFieldOf("attributes.request_id"), "request_id");
});

test("trace gaps: time inside a span with no child running, attributed to the siblings around it", () => {
  const span = (id: string, parent: string, startMs: number, durMs: number) => ({
    timestamp: new Date(Date.UTC(2026, 10, 20, 6, 59, 33) + startMs).toISOString().replace("Z", "123456Z"),
    data: { span_id: id, parent_span_id: parent, duration_nano: durMs * 1e6 },
  });
  // gateway → CancelOrder (2050 ms): writes until 38 ms, nothing for ~2 s, reads from 2040 ms.
  const rows = [
    span("root", "", 0, 2057),
    span("rpc", "root", 1, 2050),
    span("del", "rpc", 30, 8),
    span("get", "rpc", 2040, 1),
    span("create", "rpc", 2045, 4),
  ];
  const gaps = traceGaps(rows, ["r0", "r1", "r2", "r3", "r4"]);
  assert.equal(gaps.length, 1);
  assert.deepEqual({ ...gaps[0], gap_ms: Math.round(gaps[0].gap_ms) }, { in: "r1", after: "r2", before: "r3", gap_ms: 2002, at_ms: 38, share: 0.98 });
  assert.deepEqual(traceGaps([span("a", "", 0, 10), span("b", "a", 1, 8)], ["x", "y"]), [], "short gaps are ignored");
});

test("responses parse into compact, deduplicated structures", () => {
  const raw = parseRaw({
    status: "success",
    data: {
      type: "raw",
      data: {
        results: [
          {
            queryName: "A",
            nextCursor: "c1",
            rows: [
              { timestamp: "2026-11-17T03:00:00Z", data: { id: "1", body: "boom", resources_string: { "service.name": "oms" } } },
              { timestamp: "2026-11-17T03:00:00Z", data: { id: "1", body: "boom" } },
              { timestamp: "2026-11-17T03:00:01Z", data: { id: "2", body: "x".repeat(3000) } },
            ],
          },
        ],
      },
    },
  });
  assert.equal(raw.rows.length, 2, "duplicate id dropped");
  assert.equal(raw.rows[0].data["service.name"], "oms", "nested attribute maps flattened");
  assert.ok(String(raw.rows[1].data.body).length < 2100, "long strings truncated");
  assert.equal(raw.nextCursor, "c1");

  const ts = parseTimeSeries({
    data: { data: { results: [{ aggregations: [{ series: [{ labels: [{ key: { name: "service.name" }, value: "oms" }], values: [{ timestamp: 1, value: 2 }, { timestamp: 2, value: 6 }] }] }] }] } },
  });
  assert.deepEqual(ts.series[0].labels, { "service.name": "oms" });
  assert.deepEqual(ts.series[0].stats, { min: 2, max: 6, avg: 4, last: 6 });

  const sc = parseScalar({ data: { data: { results: [{ columns: [{ name: "service.name" }, { name: "value" }], data: [["oms", 3], ["pay", 1]] }] } } });
  assert.deepEqual(sc.columns, ["service.name", "value"]);
  assert.deepEqual(sc.rows, [["oms", 3], ["pay", 1]]);
  assert.equal(parseScalar({}).rows.length, 0);
});

test("investigation source selection: auto keeps Splunk when nothing is connected; explicit choices report what is missing", async () => {
  const { selectProviders } = await import("../src/investigation/observability.ts");
  assert.deepEqual(selectProviders(undefined), { providers: ["splunk"], missing: ["splunk"] });
  assert.deepEqual(selectProviders("signoz"), { providers: ["signoz"], missing: ["signoz"] });
  assert.deepEqual(selectProviders("BOTH").providers, ["splunk", "signoz"]);
  assert.deepEqual(selectProviders("nonsense").providers, ["splunk"]);
});
