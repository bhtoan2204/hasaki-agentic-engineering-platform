import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { checkSpl, clearSplunkCookie, setSplunkCookie } from "../src/integrations/splunk.ts";
import {
  assess,
  buildScanSpl,
  groupsForWorkItem,
  linkWorkItem,
  dayWindow,
  describeGroup,
  imageInfo,
  investigate,
  listGroups,
  runScan,
  saveSettings,
  setIgnored,
  toGroups,
} from "../src/prodErrors/scan.ts";

// All values are fake.
const COOKIE = "splunkd_8000=SESSIONabc; splunkweb_csrf_token_8000=CSRF123";
let splunk: Server;
let tg: Server;
let rows: any[] = [];
let polls = 0;
const searches: URLSearchParams[] = [];
const telegrams: any[] = [];

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
    if (req.method === "GET" && url.pathname.endsWith("/search/jobs/job1/results"))
      return json({ results: rows });
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
  config.splunk.baseUrl = `http://127.0.0.1:${(splunk.address() as any).port}`;
  Object.assign(config.telegram, {
    botToken: "TEST:TOKEN",
    chatId: "42",
    apiBase: `http://127.0.0.1:${(tg.address() as any).port}`,
  });
});
after(async () => {
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
  assert.match(spl, /kubernetes\.namespace_name IN \("oms-prod","payment-prod"\)/);
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
  assert.match(sent.get("search")!, /^search index=k8s_prod/);
  assert.equal(
    sent.get("exec_mode"),
    "normal",
    "scan runs as an async job so progress can be shown",
  );
  assert.equal(sent.get("max_time"), String(config.prodErrors.timeoutSeconds));
  const list = await listGroups();
  assert.equal(list.groups.length, 2);
  const zalo = list.groups.find((g: any) => g.service === "payment-zalopay");
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
  const seen: any[] = [];
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
  ).map((g) => ({ ...g, status: "open" }) as any);
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
  const listed = (await listGroups()).groups.find((x: any) => x.fingerprint === g.fingerprint);
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
  } as any);
  assert.match(md, /```text\n/);
  assert.doesNotMatch(md, /a ``` b/);
  assert.match(
    md,
    /index=k8s_prod kubernetes\.namespace_name="payment-prod" kubernetes\.container_name="payment-zalopay" "zalopay\/zalopay\.go:56"/,
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
  assert.throws(() => scanWindow({ preset: "2d" as any }, now), /không hợp lệ/);
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
    list.groups.map((g: any) => g.service),
    ["payment-vnpay"],
    "groups of other scans are not mixed in",
  );
});
