/**
 * Production error scans: the pure grouping/scoring helpers, and scans run end to end by a real platform-go process
 * (the only engine) through this process's internal gateway, against fake Splunk, SigNoz and Telegram servers.
 */
import { test as nodeTest, after, before } from "node:test";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { checkSpl, clearSplunkCookie, setSplunkCookie } from "../src/integrations/splunk.ts";
import { execution } from "../src/auth/execution.ts";
import { createUser } from "../src/auth/users.ts";
import { loadPersonalIntegrations } from "../src/integrations/loadPersonal.ts";
import { handle } from "../src/http/app.ts";
import { startPlatformGo } from "./fixtures/platformGo.ts";
import {
  assess,
  buildScanSpl,
  groupsForWorkItem,
  linkWorkItem,
  dayWindow,
  describeGroup,
  type GroupRow,
  imageInfo,
  investigate,
  listGroups,
  runScan,
  saveSettings,
  setIgnored,
  toGroups,
} from "../src/prodErrors/scan.ts";

// Scans run as an admin (manual) or the configured schedule user, each with their own Splunk/SigNoz integrations.
let admin = 0;
const test = (name: string, fn: () => unknown) =>
  nodeTest(name, () =>
    execution.run({ userId: admin, kind: "user" }, async () => {
      await loadPersonalIntegrations(true);
      await fn();
    }),
  );
let platform: Server;
let go: Awaited<ReturnType<typeof startPlatformGo>>;

// All values are fake.
const COOKIE = "splunkd_8000=SESSIONabc; splunkweb_csrf_token_8000=CSRF123";
let splunk: Server;
let tg: Server;
let rows: Array<ReturnType<typeof row>> = [];
let polls = 0;
let splunkFail = false;
const searches: URLSearchParams[] = [];
const telegrams: Array<{ text: string; parse_mode: string }> = [];

const row = (o: Partial<Record<string, string>>) => ({
  ns: "payment-prod",
  svc: "payment-zalopay",
  lv: "ERROR",
  sig: "failed to check sign, err=sign not match",
  today: "1290",
  yesterday: "0",
  first: "1793815884.344",
  last: "1793867358.555",
  sample: "failed to check sign, err=sign not match phone=0912345678",
  caller: "zalopay/zalopay.go:56",
  image: "ffm-harbor.example/payment/payment-zalopay:prod.2611051524.efd844a",
  request_id: "c2f33798-eeeb-401a-91af-a1304002994d",
  ...o,
});

before(async () => {
  await migrate();
  await seedTemplates();
  splunk = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (b: unknown) => (
      res.writeHead(200, { "content-type": "application/json" }),
      res.end(JSON.stringify(b))
    );
    if (url.pathname.endsWith("/authentication/current-context"))
      return json({ entry: [{ content: { username: "dev@example.vn", roles: ["dev"] } }] });
    // async search job: create → status (RUNNING once, then DONE) → results
    if (req.method === "GET" && url.pathname.endsWith("/search/jobs/job1")) {
      polls++;
      return json({
        entry: [
          {
            content:
              polls % 2
                ? {
                    dispatchState: "RUNNING",
                    doneProgress: 0.4,
                    scanCount: 1000,
                    eventCount: 10,
                    isDone: false,
                  }
                : {
                    dispatchState: "DONE",
                    doneProgress: 1,
                    scanCount: 2500,
                    eventCount: 30,
                    isDone: true,
                  },
          },
        ],
      });
    }
    if (req.method === "GET" && url.pathname.endsWith("/search/jobs/job1/results")) {
      if (splunkFail) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ messages: [{ type: "FATAL", text: "forbidden" }] }));
      }
      return json({ results: rows });
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      if (url.pathname.endsWith("/search/jobs")) searches.push(form);
      json({ sid: "job1" });
    });
  });
  tg = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      telegrams.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise<void>((r) => splunk.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => tg.listen(0, "127.0.0.1", r));
  config.splunk.baseUrl = `http://127.0.0.1:${(splunk.address() as AddressInfo).port}`;
  admin = (
    await createUser({
      username: `prod-admin-${Date.now()}`,
      password: "scan-password",
      role: "admin",
    })
  ).id;
  config.prodErrors.userId = admin;
  platform = createServer(handle);
  await new Promise<void>((r) => platform.listen(0, "127.0.0.1", r));
  go = await startPlatformGo({
    PROD_ERRORS_ENGINE: "go",
    PLATFORM_INTERNAL_URL: `http://127.0.0.1:${(platform.address() as AddressInfo).port}`,
    PROD_SCAN_POLL_MS: "1000",
  });
  Object.assign(config.telegram, {
    botToken: "TEST:TOKEN",
    chatId: "42",
    apiBase: `http://127.0.0.1:${(tg.address() as AddressInfo).port}`,
  });
});
after(async () => {
  go?.stop();
  platform?.close();
  splunk.close();
  tg.close();
  await pool.end();
});

test("dayWindow: local midnight in Asia/Ho_Chi_Minh and yesterday's same time-of-day window", () => {
  const w = dayWindow(new Date("2026-11-05T09:30:00Z"), "Asia/Ho_Chi_Minh"); // 16:30 local
  assert.equal(w.day, "2026-11-05");
  assert.equal(w.hm, "16:30");
  assert.equal(w.start, Date.parse("2026-11-04T17:00:00Z") / 1000);
  assert.equal(w.yesterdayEnd - w.yesterdayStart, w.now - w.start);
  const early = dayWindow(new Date("2026-11-05T16:30:00Z"), "Asia/Ho_Chi_Minh"); // 23:30 local, still the 5th
  assert.equal(early.day, "2026-11-05");
});

test("buildScanSpl: passes the read-only SPL guard and covers both log shapes", () => {
  const spl = buildScanSpl(dayWindow(new Date()));
  assert.equal(checkSpl(spl), spl);
  assert.match(
    spl,
    /^search \(\(index=k8s_prod kubernetes\.namespace_name IN \("oms-prod"\)\) OR \(index=k8s_payment kubernetes\.namespace_name IN \("payment-prod"\)\)\) /,
  );
  assert.match(
    buildScanSpl(dayWindow(new Date()), [{ namespace: "payment-prod", project: "Payment" }]),
    /^search \(index=k8s_payment kubernetes\.namespace_name IN \("payment-prod"\)\) /,
  );
  assert.match(spl, /spath input=log/);
  assert.match(spl, /count\(eval\(day="t"\)\) as today count\(eval\(day="y"\)\) as yesterday/);
});

test("assess: panic is critical; new or spiking errors rise; stable noise stays low/medium", () => {
  assert.equal(
    assess({ level: "PANIC", signature: "x", sample: "", today: 1, yesterday: 1 }).severity,
    "critical",
  );
  assert.equal(
    assess({
      level: "ERROR",
      signature: "runtime error: invalid memory address or nil pointer dereference",
      sample: "",
      today: 1,
      yesterday: 3,
    }).severity,
    "critical",
  );
  assert.equal(
    assess({ level: "ERROR", signature: "new thing", sample: "", today: 12, yesterday: 0 })
      .severity,
    "high",
  );
  assert.equal(
    assess({ level: "ERROR", signature: "new thing", sample: "", today: 2, yesterday: 0 }).severity,
    "medium",
  );
  assert.equal(
    assess({
      level: "ERROR",
      signature: "refund callback failed",
      sample: "",
      today: 80,
      yesterday: 0,
    }).severity,
    "critical",
  );
  assert.equal(
    assess({
      level: "ERROR",
      signature: "refund callback failed",
      sample: "",
      today: 8,
      yesterday: 0,
    }).severity,
    "high",
  );
  assert.equal(
    assess({ level: "ERROR", signature: "timeout", sample: "", today: 300, yesterday: 60 })
      .severity,
    "high",
  );
  assert.equal(
    assess({
      level: "ERROR",
      signature: "consumer process got error",
      sample: "",
      today: 15000,
      yesterday: 14000,
    }).severity,
    "medium",
  );
  assert.equal(
    assess({ level: "ERROR", signature: "ward unresolved", sample: "", today: 40, yesterday: 50 })
      .severity,
    "low",
  );
});

test("imageInfo: repository and commit from the image tag", () => {
  assert.deepEqual(
    imageInfo("ffm-harbor.example/payment/payment-zalopay:prod.2611051524.efd844a"),
    { repo: "payment-zalopay", commit: "efd844a" },
  );
  assert.deepEqual(imageInfo("registry/oms/oms-api:latest"), {
    repo: "oms-api",
    commit: undefined,
  });
  assert.deepEqual(imageInfo(undefined), {});
});

test("runScan: refuses without a Splunk session, records the failure", async () => {
  await clearSplunkCookie();
  await assert.rejects(runScan("manual"), /chưa kết nối Splunk/);
  const s = await one(pool, "SELECT * FROM prod_error_scans ORDER BY id DESC LIMIT 1");
  assert.equal(s.ok, false);
});

test("runScan: stores groups (PII masked), keeps ignore/work item across scans, scheduled scans notify once a day", async () => {
  await setSplunkCookie(COOKIE);
  rows = [
    row({}),
    row({
      svc: "oms-background",
      ns: "oms-prod",
      sig: "consumer process got error",
      today: "15000",
      yesterday: "14000",
      caller: "kafka/consumer.go:148",
      sample: "consumer process got error",
    }),
  ];
  const r = await runScan("manual");
  assert.deepEqual(r, { ok: true, groups: 2 });
  const sent = searches.at(-1)!;
  assert.match(sent.get("search")!, /^search \(\(index=k8s_prod /);
  assert.equal(
    sent.get("exec_mode"),
    "normal",
    "scan runs as an async job so progress can be shown",
  );
  assert.equal(sent.get("max_time"), String(config.prodErrors.timeoutSeconds));
  const list = await listGroups();
  assert.equal(list.groups.length, 2);
  const zalo = list.groups.find((g) => g.service === "payment-zalopay");
  assert.equal(zalo.severity, "critical");
  assert.doesNotMatch(zalo.sample, /0912345678/);
  assert.equal(telegrams.length, 0, "manual scans do not notify");

  // a scheduled scan notifies the critical/high group once; a second scan the same day does not repeat it
  await runScan("schedule");
  assert.equal(telegrams.length, 1);
  assert.match(telegrams[0].text, /LỖI PRODUCTION/);
  assert.match(telegrams[0].text, /🔴 <b>CRITICAL<\/b> · <b>payment-zalopay<\/b>/);
  assert.match(telegrams[0].text, /1\.290 lần hôm nay · 🆕 mới xuất hiện hôm nay/);
  assert.match(telegrams[0].text, /Payment 1/);
  assert.equal(telegrams[0].parse_mode, "HTML");
  assert.doesNotMatch(telegrams[0].text, /consumer process/);
  await runScan("schedule");
  assert.equal(telegrams.length, 1);

  // ignore hides it from the default list and survives the next scan
  await setIgnored(zalo.fingerprint, true);
  await runScan("manual");
  assert.equal((await listGroups()).groups.length, 1);
  assert.equal((await listGroups({ all: true })).groups.length, 2);
  await setIgnored(zalo.fingerprint, false);
});

test("runScan: reports progress while Splunk searches, clears it when done", async () => {
  const seen: Array<NonNullable<Awaited<ReturnType<typeof listGroups>>["progress"]>> = [];
  const timer = setInterval(async () => {
    const p = (await listGroups()).progress;
    if (p) seen.push({ ...p });
  }, 100);
  await runScan("manual");
  clearInterval(timer);
  assert.ok(
    seen.some((p) => p.phase === "search" && p.searchPct === 40 && p.scanned === 1000),
    JSON.stringify(seen),
  );
  assert.ok(
    seen.every((p, i) => i === 0 || p.pct >= seen[i - 1].pct),
    "never goes backwards",
  );
  assert.equal((await listGroups()).progress, null);
});

test("investigate: creates a Bug Investigation work item in the namespace's project, once", async () => {
  const [g] = toGroups([row({})], dayWindow(new Date()).day);
  const r = await investigate(g.fingerprint);
  assert.equal(r.created, true);
  const wi = await one(pool, "SELECT * FROM work_items WHERE id = $1", [r.work_item_id]);
  assert.equal(wi.project, "Payment");
  assert.match(wi.title, /^\[Prod\] payment-zalopay: failed to check sign/);
  assert.match(wi.description, /commit `efd844a`/);
  assert.match(wi.description, /zalopay\/zalopay\.go:56/);
  const run = await one(pool, "SELECT * FROM workflow_runs WHERE work_item_id = $1", [
    r.work_item_id,
  ]);
  assert.ok(run, "workflow run started");
  const again = await investigate(g.fingerprint);
  assert.deepEqual(
    { created: again.created, id: again.work_item_id },
    { created: false, id: r.work_item_id },
  );
  const linked = await q(
    pool,
    "SELECT work_item_id FROM prod_error_groups WHERE fingerprint = $1",
    [g.fingerprint],
  );
  assert.equal(Number(linked[0].work_item_id), r.work_item_id);
});

test("buildFailureMessage: tells how to fix an expired Splunk session; buildAlertMessage caps the list", async () => {
  const { buildAlertMessage, buildFailureMessage } = await import("../src/prodErrors/scan.ts");
  const f = buildFailureMessage(
    "09:00",
    "phiên Splunk hết hạn — dán cookie mới ở trang Integrations",
  );
  assert.match(f.text, /KHÔNG QUÉT ĐƯỢC LỖI PRODUCTION · 09:00/);
  assert.match(f.text, /Dán cookie Splunk mới/);
  const many = toGroups(
    Array.from({ length: 9 }, (_, i) => row({ sig: `error ${"x".repeat(i + 1)} <b>` })),
    "2026-11-05",
  ).map((g): GroupRow => ({
    ...g,
    status: "open",
    work_item_id: null,
    notified_day: null,
    first_seen_at: "",
  }));
  const m = buildAlertMessage(many, "14:00");
  assert.match(m.text, /… và 3 nhóm khác/);
  assert.match(m.text, /&lt;b&gt;/, "signatures are HTML-escaped");
  assert.ok(m.text.length < 4096, "fits one Telegram message");
});

test("linkWorkItem: attach an existing work item by code, list it from the work item side, detach", async () => {
  const { workItems } = await import("../src/workitems/service.ts");
  const wi = await workItems.createManual({ title: "Bug đã báo từ trước", code: "HSK-777" });
  const [g] = toGroups(
    [row({ svc: "payment-vnpay", sig: "Invalid checksum. Expect=<hex>, Got=<hex>" })],
    dayWindow(new Date()).day,
  );
  rows = [row({ svc: "payment-vnpay", sig: "Invalid checksum. Expect=<hex>, Got=<hex>" })];
  await runScan("manual");
  await assert.rejects(linkWorkItem(g.fingerprint, "HSK-404"), /không có work item/);
  assert.equal((await linkWorkItem(g.fingerprint, " HSK-777 ")).code, "HSK-777");
  const listed = (await listGroups()).groups.find((x) => x.fingerprint === g.fingerprint);
  assert.equal(listed.work_item_code, "HSK-777");
  assert.equal(listed.work_item_title, "Bug đã báo từ trước");
  assert.deepEqual(listed.pull_requests, []);
  const back = await groupsForWorkItem(wi.id);
  assert.equal(back.length, 1);
  assert.equal(back[0].service, "payment-vnpay");
  assert.equal(back[0].day, back[0].latest_day);
  await linkWorkItem(g.fingerprint, "");
  assert.equal((await groupsForWorkItem(wi.id)).length, 0);
});

test("describeGroup: markdown with fenced log and the SPL to dig further", () => {
  const [g] = toGroups([row({ sample: "a ``` b" })], "2026-11-05");
  const md = describeGroup({
    ...g,
    status: "open",
    work_item_id: null,
    notified_day: null,
    first_seen_at: "",
  });
  assert.match(md, /```text\n/);
  assert.doesNotMatch(md, /a ``` b/);
  assert.match(
    md,
    /index=k8s_payment kubernetes\.namespace_name="payment-prod" kubernetes\.container_name="payment-zalopay" "zalopay\/zalopay\.go:56"/,
  );
});

test("saveSettings: normalizes times, rejects invalid ones", async () => {
  assert.deepEqual(await saveSettings({ schedule: "14:00, 9:00 9h30", notify: false }), {
    schedule: ["09:00", "09:30", "14:00"],
    notify: false,
  });
  await assert.rejects(saveSettings({ schedule: "25:00" }), /không hợp lệ/);
  assert.deepEqual(await saveSettings({ schedule: "" }), { schedule: [], notify: true });
});

test("scanWindow: presets, custom range, baseline and Splunk limits", async () => {
  const { scanWindow } = await import("../src/prodErrors/scan.ts");
  const now = new Date("2026-11-05T09:30:00Z"); // 16:30 local
  const t = Math.floor(now.getTime() / 1000);
  const h4 = scanWindow({ preset: "4h" }, now, "Asia/Ho_Chi_Minh");
  assert.deepEqual(
    [h4.start, h4.end, h4.baseStart, h4.baseEnd, h4.compare],
    [t - 4 * 3600, t, t - 4 * 3600 - 86400, t - 86400, "yesterday"],
  );
  const y = scanWindow({ preset: "yesterday" }, now, "Asia/Ho_Chi_Minh");
  assert.equal(y.day, "2026-11-04");
  assert.equal(y.end - y.start, 86400);
  assert.equal(y.start, Date.parse("2026-11-03T17:00:00Z") / 1000, "local midnight of the 4th");
  const c = scanWindow(
    { preset: "custom", from: "2026-11-03T00:00:00Z", to: "2026-11-05T00:00:00Z" },
    now,
    "Asia/Ho_Chi_Minh",
  );
  assert.equal(c.compare, "previous", "a 48h window is compared with the 48h before it");
  assert.equal(c.baseEnd, c.start);
  assert.ok(c.untilMinutes > 0, "a window ending in the past is bounded on the Splunk side too");
  assert.throws(
    () =>
      scanWindow(
        { preset: "custom", from: "2026-11-05T00:00:00Z", to: "2026-11-04T00:00:00Z" },
        now,
      ),
    /trước/,
  );
  assert.throws(
    () =>
      scanWindow(
        { preset: "custom", from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z" },
        now,
      ),
    /tối đa 72 giờ/,
  );
  assert.throws(
    () =>
      scanWindow(
        { preset: "custom", from: "2026-10-30T00:00:00Z", to: "2026-10-31T00:00:00Z" },
        now,
      ),
    /7 ngày/,
  );
  const invalid: { preset: string } = { preset: "2d" };
  assert.throws(() => scanWindow(invalid as Parameters<typeof scanWindow>[0], now), /không hợp lệ/);
});

test("runScan with options: only the chosen project, the chosen window; the page lists that scan", async () => {
  const { scanNamespaces } = await import("../src/prodErrors/scan.ts");
  assert.throws(() => scanNamespaces(["nope-prod"]), /không có trong cấu hình/);
  await setSplunkCookie(COOKIE);
  rows = [
    row({
      svc: "payment-vnpay",
      ns: "payment-prod",
      sig: "vnpay ipn checksum invalid",
      today: "12",
      yesterday: "0",
    }),
  ];
  await runScan("manual", new Date(), { namespaces: ["payment-prod"], preset: "1h" });
  const spl = searches.at(-1)!.get("search")!;
  assert.equal(checkSpl(spl), spl);
  assert.match(spl, /kubernetes\.namespace_name IN \("payment-prod"\)/, "only the chosen project");
  assert.doesNotMatch(spl, /oms-prod/);
  const list = await listGroups();
  assert.equal(list.shown.preset, "1h");
  assert.deepEqual(list.shown.namespaces, ["payment-prod"]);
  assert.equal(
    new Date(list.shown.window_end).getTime() - new Date(list.shown.window_start).getTime(),
    3600_000,
  );
  assert.deepEqual(
    list.groups.map((g) => g.service),
    ["payment-vnpay"],
    "groups of other scans are not mixed in",
  );
});

/** A fake SigNoz that answers every query of a scan with the given [labels, hourly counts] groups. */
async function startSignozFake(groups: Array<[string[], number[]]>, nowMs: number) {
  const hour = nowMs - (nowMs % 3_600_000);
  const queries: Array<{
    requestType?: string;
    start: number;
    end: number;
    compositeQuery: {
      queries: Array<{ spec: { signal: string; filter: { expression: string } } }>;
    };
  }> = [];
  const sz = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (!raw)
        return (
          res.writeHead(200, { "content-type": "application/json" }),
          res.end('{"status":"success","data":{"keys":{}}}')
        );
      queries.push(body);
      const spec = body.compositeQuery?.queries?.[0]?.spec ?? {};
      if (/parent_span_id = ''/.test(spec.filter?.expression ?? "")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            status: "success",
            data: { type: body.requestType, data: { results: [] } },
          }),
        );
      }
      const keys: string[] = (spec.groupBy ?? []).map((g: { name: string }) => g.name);
      const series = groups.map(([labels, counts]) => ({
        labels: keys.map((name, i) => ({ key: { name }, value: labels[i] })),
        values: counts.map((value) => ({ timestamp: hour, value })),
      }));
      const sample = {
        timestamp: new Date(nowMs - 60_000).toISOString(),
        data: {
          name: "POST /ipn",
          trace_id: "trace-abc",
          resources_string: { "service.name": "payment-vnpay" },
        },
      };
      // The scan window holds the groups; the baseline window holds other spans but no errors.
      const inWindow = body.start >= nowMs - 2 * 3_600_000;
      const scalar = keys.length
        ? inWindow
          ? groups.map(([labels, counts]) => [...labels, counts.reduce((a, b) => a + b, 0)])
          : []
        : [[12]];
      const data =
        body.requestType === "time_series"
          ? { results: [{ queryName: "A", aggregations: [{ index: 0, series }] }] }
          : body.requestType === "scalar"
            ? {
                results: [
                  {
                    queryName: "A",
                    columns: [...keys, "value"].map((name) => ({ name })),
                    data: scalar,
                  },
                ],
              }
            : { results: [{ queryName: "A", rows: [sample] }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { type: body.requestType, data } }));
    });
  });
  await new Promise<void>((r) => sz.listen(0, "127.0.0.1", r));
  return { sz, queries };
}

test("runScan: scans SigNoz error traces when Splunk is not connected and marks the groups' source", async () => {
  const { saveSignoz, disconnectSignoz } = await import("../src/integrations/signoz.ts");
  const nowMs = Date.now();
  // [deployment.environment, service.name, name, status_message, response_status_code] and today's hourly counts.
  const groups: Array<[string[], number[]]> = [
    [
      [
        "payment-prod",
        "payment-vnpay",
        "POST /ipn",
        "ipn order 100230056 rejected: invalid sign",
        "500",
      ],
      [1],
    ],
    [
      [
        "payment-prod",
        "payment-vnpay",
        "POST /ipn",
        "ipn order 100230057 rejected: invalid sign",
        "500",
      ],
      [1],
    ],
  ];
  const { sz, queries } = await startSignozFake(groups, nowMs);
  const hosts = config.signoz.allowedInternalHosts;
  config.signoz.allowedInternalHosts = ["127.0.0.1"];
  try {
    await clearSplunkCookie();
    await saveSignoz({
      baseUrl: `http://127.0.0.1:${(sz.address() as { port: number }).port}`,
      token: "sz-scan-key-0123456789",
      enabled: true,
    });
    queries.length = 0; // drop the connection test of saveSignoz
    const r = await runScan("manual", new Date(nowMs), { preset: "1h" });
    assert.deepEqual(r, { ok: true, groups: 1 });
    const slow = queries.filter((b) =>
      /parent_span_id = ''/.test(b.compositeQuery.queries[0].spec.filter.expression),
    );
    assert.deepEqual(
      queries.filter((b) => !slow.includes(b)).map((b) => b.requestType),
      ["scalar", "time_series", "scalar", "scalar", "raw"],
      "window counts, hourly points, baseline counts, baseline span check, newest trace samples",
    );
    assert.deepEqual(
      slow.map((b) => b.requestType),
      ["scalar", "scalar", "raw"],
      "slow requests: window, baseline, slowest samples",
    );
    for (const b of queries) {
      assert.equal(b.compositeQuery.queries[0].spec.signal, "traces");
      assert.match(
        b.compositeQuery.queries[0].spec.filter.expression,
        /deployment\.environment = 'payment-prod'/,
      );
    }
    const g = (await listGroups()).groups.find((x: GroupRow) => x.service === "payment-vnpay")!;
    assert.equal(g.today_count, 2, "span groups differing only in ids share one signature");
    assert.deepEqual(g.detail.sources, ["signoz"]);
    assert.equal(g.detail.trace_id, "trace-abc");
    assert.equal(
      g.detail.no_baseline,
      undefined,
      "the baseline window has spans: a real comparison",
    );
    assert.ok(
      g.reasons.some((r: string) => /^new\b|mới/.test(r)),
      "no errors in the baseline: new today",
    );
    assert.match(describeGroup(g), /phát hiện từ SigNoz/);
    assert.match(describeGroup(g), /signoz_search_traces/);
    assert.match(describeGroup(g), /trace-abc/);
    const s = await one(pool, "SELECT * FROM prod_error_scans ORDER BY id DESC LIMIT 1");
    assert.equal(s.ok, true);
    assert.match(String(s.error), /Splunk: chưa kết nối, chỉ quét SigNoz/);
  } finally {
    await disconnectSignoz();
    config.signoz.allowedInternalHosts = hosts;
    sz.close();
  }
});

// ---------------------------------------------------------------- Phase 1 hardening (docs/prod-errors-hardening)

const sourcesOfLastScan = () =>
  one(pool, "SELECT ok, partial, sources FROM prod_error_scans ORDER BY id DESC LIMIT 1");

test("T3/T4: a search cut at the cap keeps the crash group and records truncated", async () => {
  await setSplunkCookie(COOKIE);
  const many = Array.from({ length: 300 }, (_, i) =>
    row({ svc: "cap-svc", sig: `cap sig ${i}`, today: String(1000 - i), yesterday: "1000" }),
  );
  rows = [
    ...many,
    row({
      svc: "cap-svc",
      sig: "cap rare panic",
      today: "1",
      yesterday: "0",
      sample: "panic: boom",
      is_crash: "1",
    }),
  ];
  const r = await runScan("manual");
  assert.deepEqual(r, { ok: true, groups: 300 });
  assert.match(
    searches.at(-1)!.get("search")!,
    /head 301$/,
    "one row more than the cap tells a cut",
  );
  const rare = (await listGroups()).groups.find((g: GroupRow) => g.signature === "cap rare panic");
  assert.equal(rare?.severity, "critical", "the crash group is not cut for 300 bigger ones");
  const s = await sourcesOfLastScan();
  assert.equal(s.sources.splunk.truncated, true);
  assert.equal(s.partial, false, "a cut is shown, it does not make the scan partial");
});

test("T5/T6: a failing source keeps its groups on the page as stale and does not announce them", async () => {
  const { saveSignoz, disconnectSignoz } = await import("../src/integrations/signoz.ts");
  await setSplunkCookie(COOKIE);
  rows = [
    row({
      svc: "part-svc",
      sig: "part sig",
      today: "900",
      yesterday: "900",
      sample: "panic: stale",
    }),
  ];
  await runScan("manual");
  assert.equal((await sourcesOfLastScan()).partial, false);

  splunkFail = true;
  const nowMs = Date.now();
  const { sz } = await startSignozFake(
    [[["payment-prod", "part-signoz", "GET /x", "boom", "500"], [3]]],
    nowMs,
  );
  const hosts = config.signoz.allowedInternalHosts;
  config.signoz.allowedInternalHosts = ["127.0.0.1"];
  try {
    await saveSignoz({
      baseUrl: `http://127.0.0.1:${(sz.address() as { port: number }).port}`,
      token: "sz-scan-key-0123456789",
      enabled: true,
    });
    const before = telegrams.length;
    const r = await runScan("schedule", new Date(nowMs), { preset: "1h" });
    assert.equal(r.ok, true);
    const s = await sourcesOfLastScan();
    assert.equal(s.ok, true);
    assert.equal(s.partial, true);
    assert.equal(s.sources.splunk.status, "failed");
    assert.match(s.sources.splunk.error, /403|quyền/);
    assert.equal(s.sources.signoz.status, "ok");

    const list = await listGroups();
    const stale = list.groups.find((g: GroupRow) => g.service === "part-svc");
    assert.ok(stale, "the Splunk group from the last complete scan is still listed");
    assert.equal((stale as unknown as { stale_source: string }).stale_source, "splunk");
    assert.ok(list.groups.some((g: GroupRow) => g.service === "part-signoz"));
    assert.equal((list as unknown as { partial: boolean }).partial, true);
    assert.ok(
      telegrams.slice(before).every((m) => !m.text.includes("part-svc")),
      "a stale group is not announced as new",
    );
  } finally {
    splunkFail = false;
    await disconnectSignoz();
    config.signoz.allowedInternalHosts = hosts;
    sz.close();
  }
  await runScan("manual");
  const after = await listGroups();
  assert.ok(
    after.groups.every((g: GroupRow) => !(g as unknown as { stale_source?: string }).stale_source),
  );
});

test("T10: a critical group is announced once, not every day; a rise in level is announced again", async () => {
  await setSplunkCookie(COOKIE);
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);
  const ours = (from: number) => telegrams.slice(from).filter((m) => m.text.includes("notify-svc"));
  const high = row({
    svc: "notify-svc",
    sig: "notify sig",
    today: "60",
    yesterday: "0",
    sample: "plain failure",
  });
  rows = [high];
  const before = telegrams.length;
  await runScan("schedule", day(3));
  await runScan("schedule", day(2));
  await runScan("schedule", day(1));
  assert.equal(ours(before).length, 1, "the same level on three days is one announcement");
  rows = [{ ...high, sample: "panic: boom" }];
  await runScan("schedule", day(0));
  const rise = ours(before);
  assert.equal(rise.length, 2, "a higher level is announced again");
  assert.match(rise[1].text, /CRITICAL/);
  assert.match(rise[1].text, /tăng bậc/);
});

test("T11: the migration backfills notified_severity, so deploying it does not announce everything again", async () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../migrations/114_prod_errors_hardening.sql"),
    "utf8",
  );
  const backfill = /UPDATE prod_error_groups[\s\S]*?;/.exec(sql);
  assert.ok(backfill, "the migration backfills the announced level");
  const ins = (fp: string, notified: string | null) =>
    q(
      pool,
      `INSERT INTO prod_error_groups (fingerprint, namespace, service, level, signature, day, severity, notified_day)
       VALUES ($1, 'oms-prod', 'backfill-svc', 'ERROR', $1, '2026-11-01', 'high', $2) ON CONFLICT (fingerprint) DO NOTHING`,
      [fp, notified],
    );
  await q(pool, "DELETE FROM prod_error_groups WHERE service = 'backfill-svc'");
  await ins("b0b0b0b0b0b0b0b0b0b1", "2026-11-01");
  await ins("b0b0b0b0b0b0b0b0b0b2", null);
  await q(pool, backfill[0]);
  const rowsAfter = await q<{ fingerprint: string; notified_severity: string | null }>(
    pool,
    "SELECT fingerprint, notified_severity FROM prod_error_groups WHERE service = 'backfill-svc' ORDER BY fingerprint",
  );
  assert.deepEqual(
    rowsAfter.map((r) => r.notified_severity),
    ["high", null],
  );
  await q(pool, "DELETE FROM prod_error_groups WHERE service = 'backfill-svc'");
});

test("T12: ignore has a TTL, a spike or the end of the TTL reopens the group and re-arms its announcement", async () => {
  await setSplunkCookie(COOKIE);
  const find = async () =>
    (await listGroups({ all: true })).groups.find((g: GroupRow) => g.service === "ign-svc")!;
  const state = (fp: string) =>
    one(
      pool,
      "SELECT status, ignored_until, ignored_rate, notified_severity FROM prod_error_groups WHERE fingerprint = $1",
      [fp],
    );
  const events = (fp: string) =>
    one(pool, "SELECT count(*)::int AS n FROM prod_error_lifecycle_events WHERE fingerprint = $1", [
      fp,
    ]);
  const base = row({
    svc: "ign-svc",
    sig: "ign sig",
    today: "60",
    yesterday: "0",
    sample: "plain failure",
  });
  rows = [base];
  await runScan("manual");
  const fp = (await find()).fingerprint;
  await setIgnored(fp, true);
  let st = await state(fp);
  assert.equal(st.status, "ignored");
  const days = (new Date(st.ignored_until).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days <= 14.01, `default TTL is 14 days (${days})`);

  await runScan("manual");
  assert.equal((await state(fp)).status, "ignored", "the same volume does not wake it");

  // a spike well above the wake threshold reopens it and re-arms the announcement
  await q(
    pool,
    "UPDATE prod_error_groups SET ignored_rate = 1, notified_severity = 'high' WHERE fingerprint = $1",
    [fp],
  );
  rows = [{ ...base, today: "2000" }];
  const before = telegrams.length;
  await runScan("schedule");
  st = await state(fp);
  assert.equal(st.status, "open");
  assert.equal(st.ignored_until, null);
  assert.ok(
    telegrams.slice(before).some((m) => m.text.includes("ign-svc")),
    "notified_severity was reset, so a high group is announced again",
  );

  // the end of the TTL reopens it as well, and clears what was announced
  await setIgnored(fp, true);
  await q(
    pool,
    "UPDATE prod_error_groups SET ignored_until = now() - interval '1 minute', notified_severity = 'critical' WHERE fingerprint = $1",
    [fp],
  );
  rows = [base];
  await runScan("manual");
  st = await state(fp);
  assert.equal(st.status, "open");
  assert.equal(st.notified_severity, null);

  assert.equal((await events(fp)).n, 0, "no lifecycle reopen: Radar reads those as recurrence");
  const audited = await one(
    pool,
    "SELECT count(*)::int AS n FROM audit_log WHERE action = 'prod_errors.group.auto_reopen' AND resource_id = $1",
    [fp],
  );
  assert.ok(audited.n >= 2);
});

// ---------------------------------------------------------------- Phase 2 (docs/prod-errors-hardening)

test("T15/T17 (Go engine): thresholds come from the TS config, v2 rides along until its flag is on, first_seen_at decides new", async () => {
  await setSplunkCookie(COOKIE);
  const sevCfg = config.prodErrors.severity;
  const saved = { ...sevCfg };
  assert.ok(sevCfg, "config.prodErrors.severity exists");
  const one1h = (rowsNow: Array<ReturnType<typeof row>>) => {
    rows = rowsNow;
    return runScan("manual", new Date(), { preset: "1h" });
  };
  const find = async (svc: string) =>
    (await listGroups()).groups.find((g: GroupRow) => g.service === svc)!;
  try {
    sevCfg.heavyRate = 5;
    sevCfg.v2 = false;
    await one1h([
      row({ svc: "v2-svc", sig: "v2 sig", today: "30", yesterday: "30", sample: "plain" }),
    ]);
    let g = await find("v2-svc");
    assert.equal(g.severity, "low", "v1 is still the severity");
    assert.equal(
      g.detail.severity_v2.severity,
      "medium",
      "30/h is over the heavy rate the TS config set",
    );

    sevCfg.v2 = true;
    await one1h([
      row({ svc: "v2-svc", sig: "v2 sig", today: "30", yesterday: "30", sample: "plain" }),
    ]);
    g = await find("v2-svc");
    assert.equal(g.severity, "medium");
    assert.deepEqual(g.reasons, ["many|30"]);
    assert.equal(g.detail.severity_v1.severity, "low");

    sevCfg.heavyRate = saved.heavyRate;
    const ret = row({
      svc: "ret-svc",
      sig: "ret sig",
      today: "10",
      yesterday: "0",
      sample: "plain",
    });
    await one1h([ret]);
    assert.deepEqual((await find("ret-svc")).reasons, ["new"]);
    await q(
      pool,
      "UPDATE prod_error_groups SET first_seen_at = now() - interval '10 days' WHERE service = 'ret-svc'",
    );
    await one1h([ret]);
    const again = await find("ret-svc");
    assert.deepEqual(again.reasons, ["returned"]);
    assert.equal(again.severity, "medium");
  } finally {
    Object.assign(sevCfg, saved);
  }
});

test("T20/T22 (Go engine): SigNoz counts distinct traces with the same filter in both windows; foreign namespaces make it degraded", async () => {
  const { saveSignoz, disconnectSignoz } = await import("../src/integrations/signoz.ts");
  await clearSplunkCookie();
  const nowMs = Date.now();
  const { sz, queries } = await startSignozFake(
    [[["prod", "deg-svc", "GET /x", "boom", "500"], [3]]],
    nowMs,
  );
  const hosts = config.signoz.allowedInternalHosts;
  config.signoz.allowedInternalHosts = ["127.0.0.1"];
  const cfg = config.prodErrors.signoz;
  const saved = { ...cfg };
  try {
    await saveSignoz({
      baseUrl: `http://127.0.0.1:${(sz.address() as { port: number }).port}`,
      token: "sz-scan-key-0123456789",
      enabled: true,
    });
    cfg.count = "trace";
    queries.length = 0;
    await runScan("manual", new Date(nowMs), { preset: "1h" });
    const grouped = queries.filter(
      (b) =>
        b.requestType === "scalar" &&
        (b.compositeQuery.queries[0].spec as { groupBy?: unknown[] }).groupBy?.length &&
        !/parent_span_id/.test(b.compositeQuery.queries[0].spec.filter.expression),
    );
    assert.equal(grouped.length, 2, "window and baseline");
    const specOf = (b: (typeof grouped)[number]) =>
      b.compositeQuery.queries[0].spec as unknown as {
        filter: { expression: string };
        aggregations: Array<{ expression: string }>;
      };
    assert.equal(specOf(grouped[0]).filter.expression, specOf(grouped[1]).filter.expression);
    assert.equal(specOf(grouped[0]).aggregations[0].expression, "count_distinct(trace_id)");
    assert.match(specOf(grouped[0]).filter.expression, /NOT \(response_status_code = '400'/);
    assert.doesNotMatch(
      specOf(grouped[0]).filter.expression,
      /'429'/,
      "429 is not excluded by default",
    );

    const s = await sourcesOfLastScan();
    assert.equal(s.sources.signoz.status, "degraded");
    assert.equal(s.partial, false, "degraded is a warning, not a missing source");
    const g = (await listGroups()).groups.find((x: GroupRow) => x.service === "deg-svc")!;
    assert.equal(g.namespace, "prod", "the namespace value is not remapped");
    assert.match(
      String(
        (await one(pool, "SELECT error FROM prod_error_scans ORDER BY id DESC LIMIT 1")).error,
      ),
      /deployment\.environment|namespace/i,
    );
  } finally {
    sz.close();
    await disconnectSignoz();
    config.signoz.allowedInternalHosts = hosts;
    Object.assign(cfg ?? {}, saved);
  }
});
