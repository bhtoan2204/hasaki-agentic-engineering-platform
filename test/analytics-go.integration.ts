/**
 * Analytics in platform-go (ADR 0003; the only engine): an unavailable platform-go answers 503 (no TypeScript
 * fallback), plus timeout, cancellation, authentication and validation behaviour.
 *
 * A missing Go toolchain fails this file. Set PLATFORM_ALLOW_MISSING_GO=1 to skip it explicitly on a machine
 * without Go (never in CI).
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
  requireGoToolchain("analytics Go engine parity");
} else {
  const { config } = await import("../src/config.ts");
  const { pool, one } = await import("../src/db/pool.ts");
  const { analyticsFixtures } = await import("./analytics.fixtures.ts");
  const { parseAnalyticsFilters } = await import("../src/api/analytics/filters.ts");
  const { loadDashboard, analyticsEngineStats } = await import("../src/api/analytics/engine.ts");
  const { retrievalService } = await import("../src/retrieval/semantic.ts");
  const { handle } = await import("../src/http/app.ts");
  const { flushAllCaches } = await import("../src/cache/index.ts");

  let fixture: Awaited<ReturnType<typeof analyticsFixtures>>;
  let go: Awaited<ReturnType<typeof startPlatformGo>>;
  let server: Server, base: string;
  const goUrl = () => config.retrieval.semantic.url;
  let realGoUrl = "";

  before(async () => {
    fixture = await analyticsFixtures();
    await extraFixtures();
    go = await startPlatformGo();
    realGoUrl = goUrl();
    server = createServer(handle);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server?.close();
    go?.stop();
    await pool.end();
  });

  /** A retried step whose first attempt was invalidated, a resumed attempt, a reopened incident, a failed scan. */
  async function extraFixtures() {
    const run = fixture.claude;
    const first = await one(
      pool,
      `INSERT INTO workflow_step_attempts(run_id,step_id,number,generation,status,started_at,finished_at,metrics,invalidated_at)
       VALUES($1,$2,2,1,'FAILED','2026-11-01T05:30:00Z','2026-11-01T05:40:00Z',$3,'2026-11-01T06:00:00Z') RETURNING id`,
      [
        run.id,
        run.step_id,
        JSON.stringify({
          provider: "claude",
          provider_sessions: {
            retry: {
              provider: "claude",
              model: "claude-test",
              tokens: { input: 70, output: 7 },
              reported_cost_usd: 0.1,
              provider_execution_ms: 900,
              complete: true,
              start_time: "2026-11-01T05:30:00Z",
              normalized_failure_category: "TIMEOUT",
            },
          },
          verification: { passed: false },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO workflow_step_attempts(run_id,step_id,number,generation,status,started_at,finished_at,metrics,input)
       VALUES($1,$2,3,1,'COMPLETED','2026-11-01T06:30:00Z','2026-11-01T06:45:00Z',$3,'{"pending":{"resume":true}}')`,
      [
        run.id,
        run.step_id,
        JSON.stringify({
          provider: "codex",
          provider_sessions: {
            resumed: {
              provider: "codex",
              model: "codex-test",
              tokens: { input: 40, output: 4, reasoning_output: 2 },
              reported_cost_usd: 0,
              provider_execution_ms: 400,
              complete: true,
              start_time: "2026-11-01T06:30:00Z",
            },
          },
          verification: { passed: true, evidence: { hits: 1, misses: 0, invalidations: ["x"] } },
        }),
      ],
    );
    assert.ok(first.id);
    await pool.query(
      `INSERT INTO prod_error_lifecycle_events(fingerprint,action,actor_id,evidence)
       VALUES($1,'acknowledge',$2,'ack'),($1,'reopen',$2,'again')`,
      [fixture.fingerprint, fixture.admin.id],
    );
    await pool.query(
      `INSERT INTO prod_error_scans(trigger,ok,error,finished_at,window_start,window_end)
       VALUES('manual',false,'Splunk 503 token=sk-abcdefghijklmnop','2026-11-02T00:00:00Z','2026-11-02T00:00:00Z','2026-11-02T01:00:00Z')`,
    );
  }

  const canon = (x: unknown) => JSON.parse(JSON.stringify(x));
  /**
   * Deep equality where JSON numbers may differ in the last bits: float8 sums and averages depend on row order, so
   * the TypeScript engine itself varies with the plan, and Go sums decimal costs exactly. Everything else, numeric
   * strings, nulls, ordering and keys included, must be identical.
   */
  const fixtureBase = "from=2026-11-01&to=2026-11-03&timezone=UTC";
  test("the internal contract holds for requests, every dashboard response and errors", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          resolve(import.meta.dirname, "../go/contracts/analytics-v1.schema.json"),
          "utf8",
        ),
      ),
    );
    const f = parseAnalyticsFilters(
      new URLSearchParams(fixtureBase + "&service=oms-api&namespace=oms"),
    );
    const body = {
      scope: { owner_id: fixture.owner.id, all: false },
      filters: {
        ...f,
        incident_status: f.incidentStatus,
        group_by: f.groupBy,
        page_size: f.pageSize,
        incidentStatus: undefined,
        groupBy: undefined,
        pageSize: undefined,
      },
      prod_namespaces: config.prodErrors.namespaces.map((n) => ({
        namespace: n.namespace,
        project: n.project,
      })),
    };
    const request = canon(body);
    assert.ok(ajv.validate("analytics-v1#/$defs/Request", request), ajv.errorsText());
    for (const [d, def] of [
      ["usage", "UsageData"],
      ["performance", "PerformanceData"],
      ["workflows", "WorkflowsData"],
      ["health", "HealthData"],
      ["health-service", "HealthServiceData"],
      ["options", "OptionsData"],
    ]) {
      const res = await retrievalService(`/internal/v1/analytics/${d}`, request, 10_000);
      assert.equal(res.status, 200, d);
      const json = await res.json();
      assert.ok(ajv.validate("analytics-v1#/$defs/Response", json), `${d}: ${ajv.errorsText()}`);
      assert.ok(ajv.validate(`analytics-v1#/$defs/${def}`, json.data), `${d}: ${ajv.errorsText()}`);
      assert.ok(json.statements >= 1);
    }
    const usage = await (
      await retrievalService("/internal/v1/analytics/usage", request, 10_000)
    ).json();
    assert.equal(usage.statements, 1, "usage is one statement in Go (four in TypeScript)");
    const svc = await (
      await retrievalService("/internal/v1/analytics/health-service", request, 10_000)
    ).json();
    assert.equal(
      svc.statements,
      1,
      "a selected service needs one health statement in Go (two in TypeScript)",
    );
    for (const [path, payload, status] of [
      ["usage", { ...request, scope: { owner_id: 0, all: false } }, 400],
      ["usage", { ...request, extra: true }, 400],
      ["usage", { ...request, filters: { ...request.filters, page_size: 1000 } }, 400],
      ["nope", request, 400],
      ["health-service", { ...request, filters: { ...request.filters, service: null } }, 400],
    ] as const) {
      const res = await retrievalService(`/internal/v1/analytics/${path}`, payload, 10_000);
      assert.equal(res.status, status, `${path} ${JSON.stringify(payload).slice(0, 80)}`);
      assert.ok(ajv.validate("analytics-v1#/$defs/Error", await res.json()), ajv.errorsText());
    }
    const stats = await (await retrievalService("/internal/v1/analytics/stats")).json();
    assert.ok(ajv.validate("analytics-v1#/$defs/Stats", stats), ajv.errorsText());
    // Analytics has its own read-only pool: one connection per dashboard slot plus one for the options lane, so it never
    // takes a retrieval/indexing connection and the filter options never wait behind slow dashboards.
    assert.equal(stats.pool.max, stats.max_concurrent + 1);
    const ro = await retrievalService("/internal/v1/analytics/usage", request, 10_000);
    assert.equal(ro.status, 200);
  });

  test("the scan error is redacted by TypeScript on the Go path too", async () => {
    const scan = await one(
      pool,
      `INSERT INTO prod_error_scans(trigger,ok,error,finished_at,window_start,window_end)
       VALUES('manual',false,'Splunk 503 token=sk-abcdefghijklmnop',now(),now()-interval '1 hour',now()) RETURNING id`,
    );
    try {
      const f = parseAnalyticsFilters(new URLSearchParams(fixtureBase));
      const h = (await loadDashboard("health", f, { ownerId: fixture.owner.id, all: false })) as {
        freshness: { latest_scan: { id: number; error: string }; status: string };
      };
      assert.equal(h.freshness.latest_scan.id, scan.id);
      assert.equal(h.freshness.status, "latest_scan_failed");
      const { safeDiagnostics } = await import("../src/agent/telemetry.ts");
      assert.equal(
        h.freshness.latest_scan.error,
        safeDiagnostics("Splunk 503 token=sk-abcdefghijklmnop"),
      );
      assert.ok(!h.freshness.latest_scan.error.includes("sk-abcdefghijklmnop"));
    } finally {
      await pool.query("DELETE FROM prod_error_scans WHERE id=$1", [scan.id]);
    }
  });

  test("validation and authentication failures are raised as such", async () => {
    const f = parseAnalyticsFilters(new URLSearchParams(fixtureBase));
    await assert.rejects(
      loadDashboard("usage", { ...f, pageSize: 1000 }, { ownerId: fixture.owner.id, all: false }),
      (e: { status?: number }) => e.status === 400,
    );
    await assert.rejects(
      loadDashboard("usage", f, { ownerId: 0, all: false }),
      (e: { status?: number }) => e.status === 400,
    );
    const token = appConfig.retrieval.internalToken;
    process.env.RETRIEVAL_INTERNAL_TOKEN = "x".repeat(64);
    appConfig.retrieval.internalToken = "x".repeat(64);
    try {
      await assert.rejects(
        loadDashboard("usage", f, { ownerId: fixture.owner.id, all: false }),
        (e: { status?: number }) => e.status === 502,
      );
    } finally {
      process.env.RETRIEVAL_INTERNAL_TOKEN = token;
      appConfig.retrieval.internalToken = token;
    }
  });

  test("an unreachable platform-go is a 503, counted by reason", async () => {
    const f = parseAnalyticsFilters(new URLSearchParams(fixtureBase));
    const scope = { ownerId: fixture.owner.id, all: false };
    config.retrieval.semantic.url = "http://127.0.0.1:9"; // nothing listens on discard
    try {
      const unreachable = analyticsEngineStats.failures.unreachable ?? 0;
      await assert.rejects(
        loadDashboard("usage", f, scope),
        (e: { status?: number }) => e.status === 503,
      );
      assert.equal(analyticsEngineStats.failures.unreachable, unreachable + 1);
    } finally {
      config.retrieval.semantic.url = realGoUrl;
    }
  });

  test("a Go deadline is a 503, and a disconnected client cancels the Go statement", async () => {
    const f = parseAnalyticsFilters(new URLSearchParams(fixtureBase));
    const scope = { ownerId: fixture.owner.id, all: false };
    const old = config.analytics.timeoutMs;
    config.analytics.timeoutMs = 1;
    try {
      const timeouts = analyticsEngineStats.failures.timeout ?? 0;
      await assert.rejects(
        loadDashboard("workflows", f, scope),
        (e: { status?: number }) => e.status === 503,
      );
      assert.equal(analyticsEngineStats.failures.timeout, timeouts + 1);
    } finally {
      config.analytics.timeoutMs = old;
    }
    // Hold PostgreSQL inside the statement with a lock, abort the caller, and the backend must go away.
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE prod_error_groups IN ACCESS EXCLUSIVE MODE");
      const ac = new AbortController();
      const pending = loadDashboard("health", f, scope, ac.signal);
      const waiting = async () =>
        (
          await one(
            pool,
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%visible_groups%'",
          )
        ).n;
      for (let i = 0; i < 100 && (await waiting()) === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(await waiting(), 1, "the Go statement is blocked on the lock");
      ac.abort();
      await assert.rejects(pending, (e: Error) => e.name === "AbortError");
      for (let i = 0; i < 100 && (await waiting()) > 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(await waiting(), 0, "the canceled statement left PostgreSQL");
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });

  test("HTTP keeps owner scope and audits support reads", async () => {
    flushAllCaches();
    const login = async (username: string) => {
      const res = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "analytics-password" }),
      });
      const cookie = res.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; ");
      return async (path: string) => {
        const r = await fetch(base + path, { headers: { cookie } });
        return { status: r.status, body: await r.json() };
      };
    };
    const member = await login("analytics-a");
    const admin = await login("analytics-admin");
    const goCalls = analyticsEngineStats.go;
    const own = await member(`/api/analytics/usage?${fixtureBase}&scope=all`);
    assert.equal(own.status, 200);
    assert.ok(
      !JSON.stringify(own.body).includes("private-model"),
      "member scope=all stays owner-scoped",
    );
    const audits = async () =>
      (
        await one(
          pool,
          "SELECT count(*)::int AS n FROM audit_log WHERE resource_type='analytics' AND resource_id='performance'",
        )
      ).n;
    const auditsBefore = await audits();
    const team = await admin(`/api/analytics/performance?${fixtureBase}&scope=all`);
    assert.equal(team.status, 200);
    await admin(`/api/analytics/performance?${fixtureBase}&scope=all`); // cache hit, still audited
    assert.equal(await audits(), auditsBefore + 2);
    assert.ok(analyticsEngineStats.go > goCalls, "served by platform-go");
    const opts = await member(`/api/analytics/options?${fixtureBase}`);
    assert.equal(opts.body.can_manage_incidents, false);
    assert.equal((await member(`/api/analytics/nope?${fixtureBase}`)).status, 404);
    assert.equal((await member(`/api/analytics/usage?from=bad`)).status, 400);
  });
}
