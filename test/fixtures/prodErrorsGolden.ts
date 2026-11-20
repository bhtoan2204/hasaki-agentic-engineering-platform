/**
 * Golden cases for the Go port of production error grouping (go/internal/proderrors/merge.go): provider rows in the
 * shapes the gateway returns, and what TypeScript's mergeSourceRows + toGroups make of them. Regenerate after an
 * intended grouping change (both engines must change together):
 *
 *   node --import ./test/env.ts test/fixtures/prodErrorsGolden.ts --write
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeSourceRows, toGroups, type SourceRow } from "../../src/prodErrors/scan.ts";

export const GOLDEN_PATH = resolve(
  import.meta.dirname,
  "../../go/internal/proderrors/testdata/golden.json",
);

type Src = { source: "splunk" | "signoz"; rows: SourceRow[] };
const H = 1793815200;
const splunk = (o: Record<string, unknown>) =>
  ({
    ns: "payment-prod",
    svc: "payment-zalopay",
    lv: "ERROR",
    sig: "failed to check sign, err=sign not match",
    today: "1290",
    yesterday: "0",
    first: "1793815884.344",
    last: "1793867358.555",
    sample: "failed to check sign",
    caller: "zalopay/zalopay.go:56",
    image: "harbor/payment/payment-zalopay:prod.2611051524.efd844a",
    request_id: "c2f33798-eeeb-401a-91af-a1304002994d",
    analytics_hourly: [`${H}:700`, `${H + 3600}:590`],
    ...o,
  }) as unknown as SourceRow;

export function goldenCases(): Array<{ name: string; day: string; sources: Src[] }> {
  const many = Array.from(
    { length: 320 },
    (_, i) =>
      ({
        ns: "oms-prod",
        svc: "oms-api",
        lv: "ERROR",
        sig: `sig ${i % 310}`,
        today: String(1000 - (i % 7)),
      }) as unknown as SourceRow,
  );
  return [
    { name: "empty", day: "2026-11-02", sources: [{ source: "splunk", rows: [] }] },
    {
      name: "splunk shapes",
      day: "2026-11-02",
      sources: [
        {
          source: "splunk",
          rows: [
            splunk({}),
            splunk({ lv: "PANIC", sig: "runtime error: nil pointer", today: " 7 ", yesterday: "" }),
            splunk({
              lv: undefined,
              sig: "plain",
              today: ["5"],
              yesterday: ["1", "2"],
              first: "",
              last: null,
            }),
            splunk({
              lv: "fatal",
              sig: "lowercase level",
              today: "60",
              yesterday: "10",
              sample: "refund amount",
            }),
            splunk({
              sig: "spike money",
              today: "600",
              yesterday: "100",
              sample: "ipn callback failed",
            }),
            splunk({ sig: "down", today: "10", yesterday: "40", analytics_hourly: "garbage" }),
            splunk({
              sig: "hex",
              today: "0x10",
              yesterday: "1e1",
              analytics_hourly: [`${H}:3`, "x:1", "99999999999999:1"],
            }),
            splunk({
              sig: "long ".repeat(80),
              sample: "s".repeat(2100),
              stack: "🙂".repeat(1300),
              err: ["first err", "second"],
              pod: [],
              caller: 12.5,
            }),
            splunk({
              ns: "oms-prod",
              svc: "oms-api",
              sig: "SLOW-ish",
              lv: "SLOW",
              today: "8",
              yesterday: "0",
            }),
            splunk({ sig: "big", today: "1e21", yesterday: "0.0000001" }),
          ],
        },
      ],
    },
    {
      name: "per-source cap of 300 and stable order",
      day: "2026-11-02",
      sources: [{ source: "splunk", rows: many }],
    },
    {
      name: "splunk and signoz overlap",
      day: "2026-11-03",
      sources: [
        {
          source: "splunk",
          rows: [
            splunk({
              ns: "oms-prod",
              svc: "oms-api",
              sig: "POST /ipn [<n>] :: invalid sign",
              today: "12",
              yesterday: "3",
              analytics_hourly: [`${H}:5`, `${H + 3600}:7`],
            }),
            splunk({ ns: "oms-prod", svc: "oms-api", sig: "only splunk", today: "4" }),
          ],
        },
        {
          source: "signoz",
          rows: [
            {
              ns: "oms-prod",
              svc: "oms-api",
              lv: "ERROR",
              sig: "POST /ipn [<n>] :: invalid sign",
              today: 20,
              yesterday: 1,
              first: H + 60,
              last: H + 7000,
              sample: "POST /ipn [500]: invalid sign",
              trace_id: "trace-1",
              sources: ["signoz"],
              no_baseline: true,
              analytics_hourly: [`${H}:9`, `${H + 7200}:11`],
            } as unknown as SourceRow,
            {
              ns: "oms-prod",
              svc: "oms-api",
              lv: "ERROR",
              sig: "only signoz",
              today: 3,
              yesterday: 0,
              sources: ["signoz"],
              no_baseline: true,
              analytics_hourly: [],
            } as unknown as SourceRow,
          ],
        },
        {
          source: "signoz",
          rows: [
            {
              ns: "oms-prod",
              svc: "oms-api",
              lv: "SLOW",
              sig: "GET /orders/<n>",
              caller: "GET /orders/{id}",
              today: 30,
              yesterday: 2,
              sample: "30/900 request > 1000ms · p50 200ms · p95 1500ms",
              trace_id: "trace-slow",
              sources: ["signoz"],
              slow: {
                threshold_ms: 1000,
                total: 900,
                p50_ms: 200,
                p95_ms: 1500,
                max_ms: 4000,
                gaps: [{ in: "GET", after: null, before: "db", gap_ms: 900, share: 0.4 }],
              },
            } as unknown as SourceRow,
            {
              ns: "oms-prod",
              svc: "oms-api",
              lv: "SLOW",
              sig: "GET /new",
              today: 6,
              yesterday: 0,
              sources: ["signoz"],
              no_baseline: true,
              slow: { threshold_ms: 1000, total: 6, p50_ms: 1200, p95_ms: 1300 },
            } as unknown as SourceRow,
          ],
        },
      ],
    },
  ];
}

export function goldenOutput() {
  return goldenCases().map((c) => ({
    ...c,
    groups: toGroups(mergeSourceRows(...c.sources), c.day),
  }));
}

if (process.argv.includes("--write")) {
  writeFileSync(GOLDEN_PATH, JSON.stringify(goldenOutput(), null, 1) + "\n");
  console.log(`wrote ${GOLDEN_PATH}`);
}
