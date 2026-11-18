import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSourceRows, signatureOf, signozRows, toGroups } from "../src/prodErrors/scan.ts";
import type { SpanErrorGroup } from "../src/integrations/signoz.ts";

const at = (iso: string) => ({ iso, epoch: Math.floor(Date.parse(iso) / 1000) });
const T1 = at("2026-11-18T03:10:00Z");
const T2 = at("2026-11-18T04:20:00Z");

const H1 = T1.epoch - (T1.epoch % 3600);
const H2 = T2.epoch - (T2.epoch % 3600);
const span = (over: Partial<SpanErrorGroup> = {}): SpanErrorGroup => ({
  ns: "payment-prod",
  service: "payment-zalopay",
  name: "POST /callback",
  status: "callback order 100230056 failed: sign not match",
  code: "500",
  count: 1,
  hourly: [],
  ...over,
});

test("signatures replace ids and numbers the same way as the SPL search", () => {
  assert.equal(
    signatureOf(
      "order 100230056 failed for 3f2a9c1e-1111-2222-3333-444455556666",
      "timeout after 30s",
    ),
    "order <n> failed for <uuid> :: timeout after <n>",
  );
});

test("SigNoz error span groups merge by namespace, service and signature, with baseline counts, hourly points, a trace sample and masked text", () => {
  const rows = signozRows(
    [
      span({
        count: 3,
        hourly: [
          [H1, 1],
          [H2, 2],
        ],
      }),
      span({
        status: "callback order 100230057 failed: sign not match",
        count: 1,
        hourly: [[H2, 1]],
      }),
      span({
        ns: "oms-prod",
        service: "oms-api",
        name: "GET /order",
        status: "Forbidden",
        code: "403",
        count: 4,
        hourly: [[H1, 4]],
      }),
    ],
    [
      span({ status: "callback order 99 failed: sign not match", count: 2 }),
      span({ service: "gone", count: 9 }),
    ],
    [
      {
        timestamp: T2.iso,
        data: { "service.name": "payment-zalopay", name: "POST /callback", trace_id: "trace-new" },
      },
      {
        timestamp: T1.iso,
        data: { "service.name": "payment-zalopay", name: "POST /callback", trace_id: "trace-old" },
      },
    ],
  );
  assert.equal(rows.length, 2, "baseline-only groups are not listed");
  const zalo = rows.find((r) => r.svc === "payment-zalopay")!;
  assert.equal(zalo.sig, "POST /callback [<n>] :: callback order <n> failed: sign not match");
  assert.equal(zalo.today, 4);
  assert.equal(zalo.yesterday, 2);
  assert.equal(zalo.first, H1);
  assert.equal(zalo.last, T2.epoch, "the newest trace sample refines the last time");
  assert.equal(zalo.trace_id, "trace-new");
  assert.equal(zalo.lv, "ERROR");
  assert.deepEqual(zalo.sources, ["signoz"]);
  assert.deepEqual(zalo.analytics_hourly, [`${H1}:1`, `${H2}:3`]);
  const [group] = toGroups([zalo], "2026-11-18");
  assert.equal(group.today_count, 4);
  assert.ok(group.reasons.includes("money"));
  assert.equal(rows[0].svc, "payment-zalopay", "sorted by today's count");

  const masked = signozRows(
    [span({ status: "lookup failed for 0912345678", hourly: [[H1, 1]] })],
    [],
  );
  assert.doesNotMatch(JSON.stringify(masked), /0912345678/);
});

test("a group seen by Splunk and SigNoz keeps the larger counts and both sources, not the sum", () => {
  const key = {
    ns: "payment-prod",
    svc: "payment-zalopay",
    lv: "ERROR",
    sig: "callback order <n> failed",
  };
  const merged = mergeSourceRows(
    {
      source: "splunk",
      rows: [
        {
          ...key,
          today: "40",
          yesterday: "3",
          first: String(T1.epoch),
          last: String(T2.epoch),
          analytics_hourly: [`${T1.epoch - (T1.epoch % 3600)}:30`],
        },
      ],
    },
    {
      source: "signoz",
      rows: [
        {
          ...key,
          today: 35,
          yesterday: 5,
          first: T1.epoch - 60,
          last: T2.epoch,
          analytics_hourly: [`${T1.epoch - (T1.epoch % 3600)}:35`],
        },
        { ...key, svc: "oms-api", ns: "oms-prod", today: 2, yesterday: 0 },
      ],
    },
  );
  assert.equal(merged.length, 2);
  const both = merged.find((r) => r.svc === "payment-zalopay")!;
  assert.equal(both.today, 40);
  assert.equal(both.yesterday, 5);
  assert.equal(Number(both.first), T1.epoch - 60);
  assert.deepEqual(both.sources, ["splunk", "signoz"]);
  assert.deepEqual(both.analytics_hourly, [`${T1.epoch - (T1.epoch % 3600)}:35`]);
  const [g] = toGroups([both], "2026-11-18");
  assert.deepEqual(g.detail.sources, ["splunk", "signoz"]);
  assert.deepEqual(merged.find((r) => r.svc === "oms-api")?.sources, ["signoz"]);
});

test("without SigNoz data for the comparison window a group is not judged new, and a Splunk baseline still counts", () => {
  const [row] = signozRows([span({ count: 30, hourly: [[H1, 30]] })], [], [], false);
  assert.equal(row.no_baseline, true);
  const [group] = toGroups([row], "2026-11-18");
  assert.equal(group.detail.no_baseline, true);
  assert.ok(!group.reasons.includes("new"));
  assert.ok(group.reasons.includes("money"));
  const [merged] = mergeSourceRows(
    {
      source: "splunk",
      rows: [{ ...row, no_baseline: undefined, today: 30, yesterday: 0, sources: undefined }],
    },
    { source: "signoz", rows: [row] },
  );
  assert.equal(merged.no_baseline, undefined, "Splunk has yesterday's data for this group");
  assert.ok(toGroups([merged], "2026-11-18")[0].reasons.includes("new"));
});
