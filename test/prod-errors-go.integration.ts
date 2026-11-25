/**
 * Production error scans (ADR 0004) claimed and run by real platform-go processes, which reach fake Splunk and
 * SigNoz servers only through this process's internal gateway. Covers what a scan stores, two platform-go
 * instances competing for one job, duplicate submissions and schedule ticks, stale leases and fencing, a crashed
 * worker, restart recovery, HTTP 429 with Retry-After, partial provider failure, provider timeouts, cancellation,
 * permission revocation and the contract. Fails without a Go toolchain (PLATFORM_ALLOW_MISSING_GO=1 skips it).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { goToolchain, requireGoToolchain, startPlatformGo } from "./fixtures/platformGo.ts";
import { config as appConfig } from "../src/config.ts";

if (!goToolchain()) {
  requireGoToolchain("production error scans with the Go engine");
} else {
  appConfig.polling.splunkMs = "50";
  const { config } = await import("../src/config.ts");
  const { pool, one, q } = await import("../src/db/pool.ts");
  const { migrate } = await import("../src/db/migrate.ts");
  const { execution } = await import("../src/auth/execution.ts");
  const { createUser } = await import("../src/auth/users.ts");
  const { setSplunkCookie, clearSplunkCookie } = await import("../src/integrations/splunk.ts");
  const { saveSignoz, disconnectSignoz } = await import("../src/integrations/signoz.ts");
  const { loadPersonalIntegrations } = await import("../src/integrations/loadPersonal.ts");
  const { handle } = await import("../src/http/app.ts");
  const scan = await import("../src/prodErrors/scan.ts");
  const jobs = await import("../src/prodErrors/jobs.ts");
  const { gatewayStats } = await import("../src/prodErrors/gateway.ts");

  // ---------------------------------------------------------------- fake providers (all values fake)
  const H = Math.floor(Date.now() / 3_600_000) * 3600 - 7200;
  const splunkRows = [
    {
      ns: "payment-prod",
      svc: "payment-zalopay",
      lv: "ERROR",
      sig: "failed to check sign, err=sign not match",
      today: "1290",
      yesterday: "0",
      first: String(H + 84.344),
      last: String(H + 3558.555),
      sample: "failed to check sign phone=0912345678",
      caller: "zalopay/zalopay.go:56",
      image: "harbor.example/payment/payment-zalopay:prod.2611051524.efd844a",
      analytics_hourly: [`${H}:700`, `${H + 3600}:590`],
    },
    {
      ns: "oms-prod",
      svc: "oms-api",
      lv: "ERROR",
      sig: "POST /ipn [<n>] :: invalid sign",
      today: "12",
      yesterday: "3",
      analytics_hourly: [`${H}:12`],
    },
  ];
  const splunk = {
    searches: 0,
    statusCalls: 0,
    /** Answer the next N job creations with 429 + Retry-After: 1. */
    rateLimit: 0,
    /** Keep the search RUNNING until released. */
    hold: false,
    /** Answer job creation with 504 this many times. */
    timeouts: 0,
  };
  const splunkServer = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => (
      res.writeHead(status, { "content-type": "application/json", ...headers }),
      res.end(JSON.stringify(b))
    );
    if (url.pathname.endsWith("/authentication/current-context"))
      return json({ entry: [{ content: { username: "dev@example.vn", roles: ["dev"] } }] });
    if (req.method === "GET" && url.pathname.endsWith("/search/jobs/job1")) {
      splunk.statusCalls++;
      const done = !splunk.hold;
      return json({
        entry: [
          {
            content: {
              dispatchState: done ? "DONE" : "RUNNING",
              doneProgress: done ? 1 : 0.4,
              scanCount: 1000,
              eventCount: 10,
              isDone: done,
            },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/search/jobs/job1/results")) return json({ results: splunkRows });
    if (url.pathname.endsWith("/control")) return json({});
    req.resume();
    req.on("end", () => {
      if (!url.pathname.endsWith("/search/jobs")) return json({ sid: "job1" });
      splunk.searches++;
      if (splunk.rateLimit > 0) {
        splunk.rateLimit--;
        return json({ messages: [{ text: "too many searches" }] }, 429, { "retry-after": "1" });
      }
      if (splunk.timeouts > 0) {
        splunk.timeouts--;
        return json({ messages: [{ text: "gateway timeout" }] }, 504);
      }
      json({ sid: "job1" });
    });
  });

  const signoz = { requests: 0, fail: false };
  const signozServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (b: unknown, status = 200) => (
        res.writeHead(status, { "content-type": "application/json" }),
        res.end(JSON.stringify(b))
      );
      if (!raw) return send({ status: "success", data: { keys: {} } });
      signoz.requests++;
      if (signoz.fail) return send({ status: "error", error: "boom" }, 500);
      const body = JSON.parse(raw);
      const spec = body.compositeQuery?.queries?.[0]?.spec ?? {};
      const keys: string[] = (spec.groupBy ?? []).map((g: { name: string }) => g.name);
      if (/parent_span_id = ''/.test(spec.filter?.expression ?? ""))
        return send({ status: "success", data: { type: body.requestType, data: { results: [] } } });
      const labels = [
        "oms-prod",
        "oms-api",
        "POST /ipn",
        "ipn order 100230056 rejected: invalid sign",
        "500",
      ];
      const inWindow = body.start >= (H - 3600) * 1000;
      const data =
        body.requestType === "time_series"
          ? {
              results: [
                {
                  queryName: "A",
                  aggregations: [
                    {
                      index: 0,
                      series: [
                        {
                          labels: keys.map((name, i) => ({ key: { name }, value: labels[i] })),
                          values: [{ timestamp: H * 1000, value: 20 }],
                        },
                      ],
                    },
                  ],
                },
              ],
            }
          : body.requestType === "scalar"
            ? {
                results: [
                  {
                    queryName: "A",
                    columns: [...keys, "value"].map((name) => ({ name })),
                    data: keys.length ? (inWindow ? [[...labels, 20]] : []) : [[12]],
                  },
                ],
              }
            : { results: [{ queryName: "A", rows: [] }] };
      send({ status: "success", data: { type: body.requestType, data } });
    });
  });

  let platform: Server;
  let base = "";
  let admin: { id: number };
  let member: { id: number };
  const gos: Array<Awaited<ReturnType<typeof startPlatformGo>>> = [];
  const goEnv = () => ({
    PROD_ERRORS_ENGINE: "go",
    PLATFORM_INTERNAL_URL: base,
    PROD_SCAN_POLL_MS: "1000",
  });
  const asAdmin = <T>(fn: () => Promise<T>) =>
    execution.run({ userId: admin.id, kind: "user" }, async () => {
      await loadPersonalIntegrations(true);
      return fn();
    });
  const custom = (h: number) => ({
    preset: "custom" as const,
    from: new Date((H - 3600) * 1000).toISOString(),
    to: new Date((H + h * 3600) * 1000).toISOString(),
  });
  const waitFor = async <T>(
    what: string,
    fn: () => Promise<T | null | undefined | false>,
    ms = 30_000,
  ) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const row = (id: number) => one(pool, "SELECT * FROM prod_error_scans WHERE id=$1", [id]);
  const finished = (id: number, ms?: number) =>
    waitFor(
      `scan ${id}`,
      async () => {
        const r = await row(id);
        return ["succeeded", "failed", "canceled"].includes(r.status) && r;
      },
      ms,
    );
  const enqueue = (opts = custom(2)) =>
    asAdmin(() => jobs.enqueueScan("manual", opts, { requestedBy: admin.id }));

  before(async () => {
    await migrate();
    admin = await createUser({ username: "scan-admin", password: "scan-password", role: "admin" });
    member = await createUser({
      username: "scan-member",
      password: "scan-password",
      role: "member",
    });
    await new Promise<void>((r) => splunkServer.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => signozServer.listen(0, "127.0.0.1", r));
    config.splunk.baseUrl = `http://127.0.0.1:${(splunkServer.address() as AddressInfo).port}`;
    config.signoz.allowedInternalHosts = ["127.0.0.1"];
    config.signoz.maxRetries = 1;
    platform = createServer(handle);
    await new Promise<void>((r) => platform.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
    await asAdmin(async () => {
      await setSplunkCookie("splunkd_8000=SESSIONabc; splunkweb_csrf_token_8000=CSRF123");
      await saveSignoz({
        baseUrl: `http://127.0.0.1:${(signozServer.address() as AddressInfo).port}`,
        token: "sz-scan-key-0123456789",
        enabled: true,
      });
    });
    gos.push(await startPlatformGo(goEnv()));
  });
  after(async () => {
    for (const g of gos) g.stop();
    splunkServer.close();
    signozServer.close();
    platform.close();
    await pool.end();
  });

  const snapshot = async (scanId: number) => ({
    observations: (
      await q(
        pool,
        `SELECT fingerprint,event_count,baseline_count,first_at,last_at,severity,hourly FROM prod_error_observations
         WHERE scan_id=$1 ORDER BY fingerprint`,
        [scanId],
      )
    ).map((r) => JSON.parse(JSON.stringify(r))),
    groups: (
      await q(
        pool,
        `SELECT fingerprint,namespace,service,level,caller,signature,sample,detail,day::text,today_count,yesterday_count,
           first_at,last_at,severity,score,reasons FROM prod_error_groups WHERE last_scan_id=$1 ORDER BY fingerprint`,
        [scanId],
      )
    ).map((r) => JSON.parse(JSON.stringify(r))),
    scan: await one(
      pool,
      "SELECT ok,status,groups,events,error,notified,engine,attempts FROM prod_error_scans WHERE id=$1",
      [scanId],
    ),
  });

  test("a scan stores the merged Splunk and SigNoz groups, PII masked", async () => {
    const r = await enqueue();
    const done = await finished(r.job!.id);
    assert.equal(done.status, "succeeded", done.error);
    const b = await snapshot(r.job!.id);
    assert.ok(b.groups.length >= 3, "splunk, signoz and their merged group");
    assert.equal(b.scan.ok, true);
    assert.equal(b.scan.engine, "go");
    assert.equal(b.scan.groups, b.groups.length);
    assert.ok(b.observations.length >= b.groups.length);
    const g = await one(
      pool,
      "SELECT sample, detail FROM prod_error_groups WHERE service='payment-zalopay'",
    );
    assert.doesNotMatch(g.sample, /0912345678/, "PII is masked by TypeScript before Go sees it");
  });

  test("one job, one owner: two platform-go instances, duplicate submissions", async () => {
    gos.push(await startPlatformGo(goEnv()));
    const searches = splunk.searches;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        asAdmin(() => scan.startScan("manual", custom(2), { requestedBy: admin.id })),
      ),
    );
    assert.equal(results.filter((x) => x.started).length, 1, JSON.stringify(results));
    const id = results.find((x) => x.started)!.scan_id!;
    const done = await finished(id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.engine, "go");
    assert.equal(done.attempts, 1, "claimed exactly once by one of the two instances");
    assert.equal(splunk.searches - searches, 1, "one provider search");
    gos.pop()!.stop();
  });

  test("schedule ticks of one slot from several instances queue one scan", async () => {
    const userId = config.prodErrors.userId;
    const schedule = await scan.getSettings();
    config.prodErrors.userId = admin.id;
    const now = new Date();
    const z = scan.zoned(now, config.prodErrors.timezone);
    await scan.saveSettings({ schedule: [z.hm], notify: false });
    try {
      const before = (
        await one(pool, "SELECT count(*)::int AS n FROM prod_error_scans WHERE trigger='schedule'")
      ).n;
      await Promise.all([scan.scheduleTick(now), scan.scheduleTick(now), scan.scheduleTick(now)]);
      await waitFor("idle", async () => !(await jobs.activeScan()));
      await scan.scheduleTick(now);
      const after = (
        await one(pool, "SELECT count(*)::int AS n FROM prod_error_scans WHERE trigger='schedule'")
      ).n;
      assert.equal(after - before, 1);
    } finally {
      config.prodErrors.userId = userId;
      await scan.saveSettings(schedule);
    }
  });

  test("a stale worker cannot publish or notify, and an expired lease is recovered and finished", async () => {
    // A job held by a dead worker: running, lease expired.
    const r = await enqueue();
    const id = r.job!.id;
    gos[0].stop();
    gos.length = 0;
    await q(
      pool,
      `UPDATE prod_error_scans SET status='running', attempts=1, fencing_token=fencing_token+1, lease_owner='ghost',
         lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [id],
    );
    const stale = (await row(id)).fencing_token;
    // The ghost's fence is refused by the gateway once recovery bumped it.
    assert.equal((await jobs.recoverScans()).recovered, 1);
    const res = await fetch(`${base}/internal/v1/prod-errors/scans/${id}/finalize`, {
      method: "POST",
      headers: { authorization: `Bearer ${appConfig.retrieval.internalToken}` },
      body: JSON.stringify({ fence: Number(stale), outcome: "succeeded" }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "lease_lost");
    await q(pool, "UPDATE prod_error_scans SET available_at=now() WHERE id=$1", [id]);
    gos.push(await startPlatformGo(goEnv()));
    const done = await finished(id);
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.equal(done.attempts, 2);
    // A scan that lost its lease cannot overwrite groups a newer scan wrote.
    const fp = (
      await one(pool, "SELECT fingerprint FROM prod_error_groups WHERE service='payment-zalopay'")
    ).fingerprint;
    const older = (await one(pool, "SELECT max(id) AS id FROM prod_error_scans WHERE id<$1", [id]))
      .id;
    await scan.publishGroups(pool, Number(older), [
      {
        ...(await one<Record<string, unknown>>(
          pool,
          "SELECT * FROM prod_error_groups WHERE fingerprint=$1",
          [fp],
        ))!,
        today_count: 1,
        hourly: [],
      },
    ] as never);
    assert.notEqual(
      (await one(pool, "SELECT today_count FROM prod_error_groups WHERE fingerprint=$1", [fp]))
        .today_count,
      1,
    );
  });

  test("a killed worker's scan is recovered by another instance; SIGTERM hands a scan back", async () => {
    splunk.hold = true;
    try {
      const r = await enqueue();
      const id = r.job!.id;
      await waitFor(
        "search started",
        async () => (await row(id)).status === "running" && splunk.statusCalls > 0,
      );
      // kill -9: no release, the lease just stops being renewed.
      process.kill(gos[0].pid, "SIGKILL");
      gos.length = 0;
      await q(
        pool,
        "UPDATE prod_error_scans SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [id],
      );
      await jobs.recoverScans();
      await q(pool, "UPDATE prod_error_scans SET available_at=now() WHERE id=$1", [id]);
      assert.equal((await row(id)).status, "queued");
      gos.push(await startPlatformGo(goEnv()));
      await waitFor("reclaimed", async () => (await row(id)).attempts === 2);
      // Graceful shutdown releases the running scan instead of keeping its lease.
      gos[0].stop();
      gos.length = 0;
      await waitFor("released", async () => (await row(id)).status === "queued", 20_000);
      splunk.hold = false;
      gos.push(await startPlatformGo(goEnv()));
      const done = await finished(id);
      assert.equal(done.status, "succeeded");
    } finally {
      splunk.hold = false;
    }
  });

  test("HTTP 429 with Retry-After and provider timeouts are retried within the job's budget", async () => {
    splunk.rateLimit = 2;
    const before = splunk.searches;
    const start = Date.now();
    const r = await enqueue();
    const done = await finished(r.job!.id);
    assert.equal(done.status, "succeeded", done.error);
    assert.equal(splunk.searches - before, 3, "two rate-limited attempts, then success");
    assert.ok(Date.now() - start >= 1000, "Retry-After was honoured");
    splunk.timeouts = 10; // more than the per-call attempts: Splunk is given up, SigNoz still scanned
    const r2 = await enqueue();
    const d2 = await finished(r2.job!.id, 60_000);
    splunk.timeouts = 0;
    assert.equal(d2.status, "succeeded", "partial provider failure keeps the other source");
    assert.match(d2.error, /^Splunk: /m);
  });

  test("a failing SigNoz is a note, not a failed scan; the retry budget bounds extra requests", async () => {
    signoz.fail = true;
    try {
      const calls = () => gatewayStats["signoz-errors:502"] ?? 0;
      const before = calls();
      const requests = signoz.requests;
      const r = await enqueue();
      const done = await finished(r.job!.id);
      assert.equal(done.status, "succeeded");
      assert.match(done.error, /SigNoz: /);
      // Go retries the failing read MaxAttempts (3) times in all; each read is bounded by the SigNoz client's own
      // retries, so the provider sees a fixed multiple of three reads, never an open-ended retry storm.
      assert.equal(calls() - before, 3);
      assert.ok(signoz.requests - requests >= 3, String(signoz.requests - requests));
    } finally {
      signoz.fail = false;
    }
  });

  test("cancellation stops a running scan at its next heartbeat; a queued scan is canceled at once", async () => {
    splunk.hold = true;
    try {
      const r = await enqueue();
      const id = r.job!.id;
      await waitFor("running", async () => (await row(id)).status === "running");
      assert.deepEqual(await jobs.cancelScan(id), { id, status: "canceling" });
      const done = await finished(id, 30_000);
      assert.equal(done.status, "canceled");
      assert.equal(done.ok, false);
    } finally {
      splunk.hold = false;
    }
    // A queued job no worker takes (an old TypeScript row, which platform-go never claims) is canceled at once.
    const queued = await one(
      pool,
      `INSERT INTO prod_error_scans (trigger, preset, namespaces, window_start, window_end, baseline_start,
         baseline_end, status, engine, requested_by, request, progress)
       SELECT trigger, preset, namespaces, window_start, window_end, baseline_start, baseline_end, 'queued',
         'typescript', requested_by, request, progress FROM prod_error_scans WHERE id=$1 RETURNING id`,
      [(await one(pool, "SELECT max(id) AS id FROM prod_error_scans")).id],
    );
    assert.deepEqual(await jobs.cancelScan(queued.id), {
      id: queued.id,
      status: "canceled",
    });
  });

  test("a revoked permission ends the scan without retrying", async () => {
    splunk.hold = true;
    try {
      const r = await enqueue();
      const id = r.job!.id;
      await waitFor(
        "running",
        async () => (await row(id)).status === "running" && splunk.statusCalls > 0,
      );
      await q(pool, "UPDATE users SET role='member' WHERE id=$1", [admin.id]);
      splunk.hold = false;
      const done = await finished(id);
      assert.equal(done.status, "failed");
      assert.match(done.error, /may no longer run it/);
      assert.ok(
        (gatewayStats["finalize:revoked"] ?? 0) +
          (gatewayStats["signoz-errors:revoked"] ?? 0) +
          (gatewayStats["splunk:revoked"] ?? 0) >=
          1,
      );
    } finally {
      splunk.hold = false;
      await q(pool, "UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
    }
    void member;
  });

  test("the gateway contract: auth, loopback, fence, errors", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          resolve(import.meta.dirname, "../go/contracts/prod-errors-v1.schema.json"),
          "utf8",
        ),
      ),
    );
    const post = (path: string, body: unknown, token = appConfig.retrieval.internalToken) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const unauthorized = await post(
      "/internal/v1/prod-errors/scans/1/sources",
      { fence: 1 },
      "x".repeat(64),
    );
    assert.equal(unauthorized.status, 401);
    assert.ok(
      ajv.validate("prod-errors-v1#/$defs/Error", await unauthorized.json()),
      ajv.errorsText(),
    );
    const noFence = await post("/internal/v1/prod-errors/scans/1/sources", {});
    assert.equal(noFence.status, 400);
    const lost = await post("/internal/v1/prod-errors/scans/1/sources", { fence: 999 });
    assert.equal(lost.status, 409);
    assert.ok(ajv.validate("prod-errors-v1#/$defs/Error", await lost.json()), ajv.errorsText());
    // A running Go job admits its own fence and answers with the contract's shapes.
    gos[0].stop();
    gos.length = 0;
    const r = await enqueue();
    const job = (await one(
      pool,
      `UPDATE prod_error_scans SET status='running', attempts=1, fencing_token=fencing_token+1, lease_owner='t',
         lease_expires_at=now()+interval '1 minute' WHERE id=$1 RETURNING id, fencing_token`,
      [r.job!.id],
    ))!;
    try {
      for (const [op, def, input] of [
        ["sources", "SourcesResponse", {}],
        ["splunk", "SplunkResponse", {}],
        ["signoz-errors", "SignozErrorsResponse", {}],
        ["signoz-slow", "SignozSlowResponse", { has_baseline: true }],
      ] as const) {
        const res = await post(`/internal/v1/prod-errors/scans/${job.id}/${op}`, {
          fence: Number(job.fencing_token),
          ...input,
        });
        assert.equal(res.status, 200, op);
        assert.ok(
          ajv.validate(`prod-errors-v1#/$defs/${def}`, await res.json()),
          `${op}: ${ajv.errorsText()}`,
        );
      }
      const bad = await post(`/internal/v1/prod-errors/scans/${job.id}/signoz-trace-gaps`, {
        fence: Number(job.fencing_token),
        trace_id: "../../etc",
      });
      assert.equal(bad.status, 400);
    } finally {
      await q(
        pool,
        "UPDATE prod_error_scans SET status='failed', ok=false, finished_at=now() WHERE id=$1",
        [job.id],
      );
      gos.push(await startPlatformGo(goEnv()));
    }
    void clearSplunkCookie;
    void disconnectSignoz;
  });
}
