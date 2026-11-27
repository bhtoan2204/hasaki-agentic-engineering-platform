/** Phase 2 of docs/prod-errors-hardening/PLAN.md: pure parts (rates, shadow severity, Radar, SigNoz). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { SourceRow } from "../src/prodErrors/scan.ts";

const scan = () => import("../src/prodErrors/scan.ts");
const sev = () => import("../src/prodErrors/severity.ts");

const row = (o: Record<string, unknown> = {}) =>
  ({
    ns: "oms-prod",
    svc: "oms-api",
    lv: "ERROR",
    sig: "order failed",
    today: "10",
    yesterday: "10",
    sample: "order failed",
    ...o,
  }) as unknown as SourceRow;

async function ctx(over: Record<string, unknown> = {}) {
  const { DEFAULT_THRESHOLDS } = await sev();
  return {
    windowHours: 24,
    baselineHours: 24,
    windowEnd: 1_793_000_000,
    known: {} as Record<string, number>,
    thresholds: DEFAULT_THRESHOLDS,
    v2: false,
    ...over,
  };
}

test("T25: without a context toGroups is what it was; with the flag off v2 only rides along in the detail", async () => {
  const { toGroups } = await scan();
  const plain = toGroups([row({ today: "1000", yesterday: "1000" })], "2026-11-27")[0];
  assert.equal(plain.severity, "medium");
  assert.equal((plain.detail as Record<string, unknown>).severity_v2, undefined);

  const shadow = toGroups(
    [row({ today: "50", yesterday: "50" })],
    "2026-11-27",
    await ctx({ windowHours: 1, baselineHours: 1 }),
  )[0];
  assert.equal(shadow.severity, "low", "v1 is still the severity");
  const v2 = (
    shadow.detail as { severity_v2?: { severity: string; score: number; reasons: string[] } }
  ).severity_v2;
  assert.equal(v2?.severity, "medium", "v2 is computed beside it");
  assert.deepEqual(v2?.reasons, ["many|50"]);
  assert.equal(typeof v2?.score, "number");
});

test("T25: with the flag on v2 is the severity and v1 rides along", async () => {
  const { toGroups } = await scan();
  const g = toGroups(
    [row({ today: "50", yesterday: "50" })],
    "2026-11-27",
    await ctx({ windowHours: 1, baselineHours: 1, v2: true }),
  )[0];
  assert.equal(g.severity, "medium");
  assert.deepEqual(g.reasons, ["many|50"]);
  const v1 = (g.detail as { severity_v1?: { severity: string } }).severity_v1;
  assert.equal(v1?.severity, "low");
});

test("T14: a 30 minute window with a small sample is not high; a panic still is critical", async () => {
  const { toGroups } = await scan();
  const c = await ctx({ windowHours: 0.5, baselineHours: 0.5, v2: true });
  assert.equal(
    toGroups([row({ today: "8", yesterday: "0" })], "2026-11-27", c)[0].severity,
    "medium",
  );
  assert.equal(
    toGroups([row({ today: "8", yesterday: "0", lv: "PANIC" })], "2026-11-27", c)[0].severity,
    "critical",
  );
});

test("T15: the same rate per hour gives the same severity for a 1h, 4h and 24h window", async () => {
  const { toGroups } = await scan();
  for (const hours of [1, 4, 24]) {
    const c = await ctx({ windowHours: hours, baselineHours: hours, v2: true });
    const today = String(50 * hours);
    const g = toGroups([row({ today, yesterday: today })], "2026-11-27", c)[0];
    assert.equal(g.severity, "medium", `${hours}h`);
  }
});

test("T16: a chronic high-volume error is high even though it did not change", async () => {
  const { toGroups } = await scan();
  const c = await ctx({ v2: true });
  const g = toGroups([row({ today: "6000", yesterday: "6000" })], "2026-11-27", c)[0];
  assert.equal(g.severity, "high");
  assert.ok(g.reasons.some((r) => r.startsWith("chronic|")));
});

test("T17: new uses first_seen_at: an old row with nothing yesterday has returned, an unknown one is new", async () => {
  const { toGroups, fingerprint } = await scan();
  const r = row({ today: "10", yesterday: "0" });
  const fp = fingerprint("oms-prod", "oms-api", "ERROR", "order failed");
  const fresh = toGroups([r], "2026-11-27", await ctx({ v2: true }))[0];
  assert.deepEqual(fresh.reasons, ["new"]);
  assert.equal(fresh.severity, "high");
  const windowEnd = 1_793_000_000;
  const old = toGroups(
    [r],
    "2026-11-27",
    await ctx({ v2: true, known: { [fp]: windowEnd - 10 * 86400 } }),
  )[0];
  assert.deepEqual(old.reasons, ["returned"]);
  assert.equal(old.severity, "medium");
});

test("T18: Radar fills zero hours only where a complete scan really saw none", async () => {
  const { coveredHours, zeroFill } = await import("../src/radar/coverage.ts");
  const { detectSeries } = await import("../src/radar/detect.ts");
  const start = new Date("2026-11-20T00:00:00Z");
  const end = new Date("2026-11-21T00:00:00Z");
  const scanOf = (over: Record<string, unknown> = {}) => ({
    windowStart: start,
    windowEnd: end,
    namespaces: ["oms-prod"],
    partial: false,
    sources: { splunk: { status: "ok" } },
    ...over,
  });
  const group = { namespace: "oms-prod", sources: ["splunk"] };
  assert.equal(coveredHours(group, [scanOf()]).length, 24);
  assert.equal(coveredHours(group, [scanOf({ partial: true })]).length, 0, "partial");
  assert.equal(
    coveredHours(group, [scanOf({ sources: { splunk: { status: "ok", truncated: true } } })])
      .length,
    0,
    "truncated",
  );
  assert.equal(
    coveredHours(group, [scanOf({ sources: { splunk: { status: "skipped" } } })]).length,
    0,
    "source skipped",
  );
  assert.equal(
    coveredHours(group, [scanOf({ namespaces: ["payment-prod"] })]).length,
    0,
    "another namespace",
  );
  assert.equal(
    coveredHours(group, [scanOf({ windowEnd: new Date("2026-11-20T10:30:00Z") })]).length,
    10,
    "only complete hours",
  );

  // a sparse error (3 events in 3 of 24 hours), then a burst: only the zero-filled baseline sees the spike
  const at = (h: number) => new Date(start.getTime() + h * 3_600_000);
  const sparse = [1, 5, 9].map((h) => ({ at: at(h), count: 3 }));
  const recentFrom = new Date("2026-11-21T00:00:00Z");
  const burst = [{ at: recentFrom, count: 60 }];
  const series = (points: Array<{ at: Date; count: number }>) => ({
    fingerprint: "f".repeat(20),
    service: "oms-api",
    environment: "oms-prod",
    level: "ERROR",
    signature: "sparse",
    points,
    recentFrom,
    coveredDays: ["2026-11-20", "2026-11-21"],
    firstSeenAt: new Date("2026-11-01T00:00:00Z"),
  });
  const kinds = (s: ReturnType<typeof series>) =>
    detectSeries(s, undefined, new Date("2026-11-21T01:00:00Z")).map((d) => d.kind);
  assert.ok(
    !kinds(series([...sparse, ...burst])).includes("error_spike"),
    "without zero hours the baseline is 3 hours",
  );
  const filled = zeroFill(sparse, coveredHours(group, [scanOf()]));
  assert.equal(filled.length, 24);
  assert.ok(kinds(series([...filled, ...burst])).includes("error_spike"));
});

test("T19: Radar and the scan agree on what is a crash or money", async () => {
  const { severityOf } = await import("../src/radar/detect.ts");
  const { isCrash, isMoney } = await sev();
  const vectors = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../go/internal/proderrors/testdata/classify-vectors.json"),
      "utf8",
    ),
  ) as Array<{ name: string; text: string; crash: boolean; money: boolean }>;
  for (const v of vectors) {
    assert.equal(isCrash(v.text) || isMoney(v.text), v.crash || v.money, v.name);
    assert.equal(
      severityOf(1, 1, "ERROR", v.text) !== "low",
      v.crash || v.money,
      `radar: ${v.name}`,
    );
  }
  assert.equal(severityOf(1, 1, "FATAL", "x") !== "low", true);
});

test("T20: SigNoz error counting: off is the old query; trace counts distinct traces; root keeps entry spans; codes are excluded", async () => {
  const { errorSpanQuery } = await import("../src/integrations/signoz.ts");
  const off = errorSpanQuery(["payment-prod"], {
    count: "off",
    ignoreStatusCodes: [400, 404],
    serverKind: "kind_string = 'Server'",
  });
  assert.equal(off.expression, "has_error = true AND (deployment.environment = 'payment-prod')");
  assert.equal(off.aggregation, "count()");

  const trace = errorSpanQuery(["payment-prod"], {
    count: "trace",
    ignoreStatusCodes: [400, 404],
    serverKind: "kind_string = 'Server'",
  });
  assert.equal(trace.aggregation, "count_distinct(trace_id)");
  assert.match(
    trace.expression,
    /NOT \(response_status_code = '400' OR response_status_code = '404'\)/,
  );
  assert.doesNotMatch(trace.expression, /parent_span_id/);

  const root = errorSpanQuery(["payment-prod"], {
    count: "root",
    ignoreStatusCodes: [],
    serverKind: "kind_string = 'Server'",
  });
  assert.equal(root.aggregation, "count()");
  assert.match(root.expression, /\(parent_span_id = '' OR kind_string = 'Server'\)/);
  assert.doesNotMatch(root.expression, /response_status_code/);
});

test("T21: a trace sample goes to the group whose status message and code it has", async () => {
  const { signozRows } = await scan();
  const g = (status: string, code: string) => ({
    ns: "payment-prod",
    service: "pay",
    name: "POST /x",
    status,
    code,
    count: 4,
    hourly: [] as Array<[number, number]>,
  });
  const sample = (status: string, code: string, trace: string) => ({
    timestamp: "2026-11-27T10:00:00Z",
    data: {
      "service.name": "pay",
      name: "POST /x",
      status_message: status,
      response_status_code: code,
      trace_id: trace,
    },
  });
  const rows = signozRows(
    [g("db down", "500"), g("bad request", "422")],
    [],
    [sample("bad request", "422", "trace-422"), sample("db down", "500", "trace-500")],
  );
  const by = (s: string) => rows.find((r) => String(r.err) === s)!;
  assert.equal(by("db down").trace_id, "trace-500");
  assert.equal(by("bad request").trace_id, "trace-422");
  // a sample without those fields keeps matching on service and span name
  const legacy = signozRows(
    [g("db down", "500")],
    [],
    [
      {
        timestamp: "2026-11-27T10:00:00Z",
        data: { "service.name": "pay", name: "POST /x", trace_id: "trace-old" },
      },
    ],
  );
  assert.equal(legacy[0].trace_id, "trace-old");
});

test("T22: namespace values SigNoz reports that match no configured namespace are flagged, never remapped", async () => {
  const { namespaceMapping, signozRows } = await scan();
  assert.deepEqual(namespaceMapping(["prod", "staging"], ["oms-prod", "payment-prod"]), {
    degraded: true,
    unknown: ["prod", "staging"],
  });
  assert.deepEqual(namespaceMapping(["oms-prod", "other"], ["oms-prod"]), {
    degraded: false,
    unknown: ["other"],
  });
  assert.deepEqual(namespaceMapping([], ["oms-prod"]), { degraded: false, unknown: [] });
  const rows = signozRows(
    [
      {
        ns: "prod",
        service: "pay",
        name: "POST /x",
        status: "boom",
        code: "500",
        count: 3,
        hourly: [],
      },
    ],
    [],
  );
  assert.equal(rows[0].ns, "prod", "the value, and so the fingerprint, is untouched");
});
