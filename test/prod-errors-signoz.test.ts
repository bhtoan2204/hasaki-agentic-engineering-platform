import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSourceRows, signatureOf, signozRows, toGroups } from "../src/prodErrors/scan.ts";

const at = (iso: string) => ({ iso, epoch: Math.floor(Date.parse(iso) / 1000) });
const T1 = at("2026-11-18T03:10:00Z");
const T2 = at("2026-11-18T04:20:00Z");
const Y1 = at("2026-11-17T03:15:00Z");

const log = (ts: string, body: string, extra: Record<string, unknown> = {}) => ({
  timestamp: ts,
  data: {
    body,
    severity_text: "ERROR",
    "k8s.namespace.name": "payment-prod",
    "k8s.container.name": "payment-zalopay",
    "k8s.pod.name": "payment-zalopay-7d9",
    ...extra,
  },
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

test("SigNoz rows group by namespace, service, level and signature, with baseline counts, hourly points and masked samples", () => {
  const rows = signozRows(
    [
      log(
        T2.iso,
        JSON.stringify({
          message: "callback order 100230057 failed",
          error: "sign not match",
          caller: "zalopay/callback.go:88",
        }),
      ),
      log(
        T1.iso,
        JSON.stringify({
          message: "callback order 100230056 failed",
          error: "sign not match",
        }),
      ),
      log(T1.iso, "unrelated", {
        "k8s.namespace.name": "oms-prod",
        "k8s.container.name": "oms-api",
      }),
    ],
    [log(Y1.iso, JSON.stringify({ message: "callback order 99 failed", error: "sign not match" }))],
  );
  const zalo = rows.find((r) => r.svc === "payment-zalopay")!;
  assert.equal(zalo.sig, "callback order <n> failed :: sign not match");
  assert.equal(zalo.today, 2);
  assert.equal(zalo.yesterday, 1);
  assert.equal(zalo.first, T1.epoch);
  assert.equal(zalo.last, T2.epoch);
  assert.equal(zalo.caller, "zalopay/callback.go:88", "the newest row is the sample");
  assert.deepEqual(zalo.sources, ["signoz"]);
  assert.equal(zalo.analytics_hourly?.length, 2);
  const [group] = toGroups([zalo], "2026-11-18");
  assert.equal(group.today_count, 2);
  assert.ok(group.reasons.includes("money"));

  const masked = signozRows(
    [log(T1.iso, JSON.stringify({ message: "lookup failed for 0912345678" }))],
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
