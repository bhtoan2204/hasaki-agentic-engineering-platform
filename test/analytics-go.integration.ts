/**
 * ANALYTICS_ENGINE=go parity and safety (ADR 0003): every dashboard loaded through a real platform-go, built from
 * go/, must equal the TypeScript engine on identical database state, across filters, scopes, time zones (including
 * the 2026-11-01 America/New_York DST end), pagination and empty ranges; plus fallback, timeout, cancellation,
 * authentication, validation and rollback behaviour.
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

if (!goToolchain()) {
  requireGoToolchain("analytics Go engine parity");
} else {
  const { config } = await import("../src/config.ts");
  const { pool, one } = await import("../src/db/pool.ts");
  const { analyticsFixtures } = await import("./analytics.fixtures.ts");
  const { seedAnalyticsDataset } = await import("./fixtures/analyticsDataset.ts");
  const { parseAnalyticsFilters } = await import("../src/api/analytics/filters.ts");
  const { loadDashboard, typescriptLoaders, analyticsEngineStats, resetAnalyticsEngine } =
    await import("../src/api/analytics/engine.ts");
  const { retrievalService } = await import("../src/retrieval/semantic.ts");
  const { handle } = await import("../src/http/app.ts");
  const { flushAllCaches } = await import("../src/cache/index.ts");
  type Dashboard = Parameters<typeof loadDashboard>[0];

  let fixture: Awaited<ReturnType<typeof analyticsFixtures>>;
  let go: Awaited<ReturnType<typeof startPlatformGo>>;
  let server: Server, base: string;
  let bench: { owner: number; admin: number };
  const goUrl = () => config.retrieval.semantic.url;
  let realGoUrl = "";

  before(async () => {
    fixture = await analyticsFixtures();
    await extraFixtures();
    await seedAnalyticsDataset({ users: 4, runs: 400, days: 10, groups: 60 });
    const users = await pool.query<{ id: number; username: string }>(
      "SELECT id,username FROM users WHERE username IN ('bench-user-1','bench-user-2')",
    );
    bench = {
      admin: users.rows.find((u) => u.username === "bench-user-1")!.id,
      owner: users.rows.find((u) => u.username === "bench-user-2")!.id,
    };
    go = await startPlatformGo();
    realGoUrl = goUrl();
    config.analytics.engine = "go";
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
  const nowDependent = /\.(human_wait_ms|wall_duration_ms|approval_wait_ms|approval_ms)$/;
  function assertSame(actual: unknown, expected: unknown, path: string) {
    if (typeof actual === "number" && typeof expected === "number") {
      // Open waits and running attempts are measured up to now(): the two engines read at different instants.
      if (nowDependent.test(path)) {
        assert.ok(Math.abs(actual - expected) <= 60_000, `${path}: ${actual} != ${expected}`);
        return;
      }
      const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
      assert.ok(Math.abs(actual - expected) <= 1e-9 * scale, `${path}: ${actual} != ${expected}`);
      return;
    }
    if (Array.isArray(actual) && Array.isArray(expected)) {
      assert.equal(actual.length, expected.length, `${path}: length`);
      actual.forEach((v, i) => assertSame(v, expected[i], `${path}[${i}]`));
      return;
    }
    if (actual && expected && typeof actual === "object" && typeof expected === "object") {
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys`);
      for (const k of Object.keys(expected))
        assertSame(
          (actual as Record<string, unknown>)[k],
          (expected as Record<string, unknown>)[k],
          `${path}.${k}`,
        );
      return;
    }
    assert.deepEqual(actual, expected, path);
  }
  /** Volatile or intentionally unordered fields: compared separately where it matters. */
  function normalize(dashboard: Dashboard, data: Record<string, unknown>) {
    const out = canon(data);
    if (dashboard === "options")
      out.users.sort((a: { id: number }, b: { id: number }) => a.id - b.id);
    return out;
  }

  async function both(
    dashboard: Dashboard,
    query: string,
    scope: { ownerId: number; all: boolean },
  ) {
    const f = parseAnalyticsFilters(new URLSearchParams(query));
    const ts = await typescriptLoaders[dashboard](f, scope);
    const before = JSON.stringify(analyticsEngineStats.fallbacks);
    const viaGo = await loadDashboard(dashboard, f, scope);
    assert.equal(
      JSON.stringify(analyticsEngineStats.fallbacks),
      before,
      `${dashboard}?${query}: fell back to TypeScript`,
    );
    return { ts: normalize(dashboard, ts as never), go: normalize(dashboard, viaGo as never) };
  }

  const fixtureBase = "from=2026-11-01&to=2026-11-03&timezone=UTC";
  const fixtureCases = [
    "",
    "&provider=codex",
    "&provider=claude&model=claude-alt",
    "&model=claude-test",
    "&group_by=repository",
    "&group_by=model",
    "&group_by=user",
    "&group_by=workflow",
    "&group_by=project",
    "&project=OMS",
    "&project=Other",
    "&repository=oms-api",
    "&workflow=analytics-fixture",
    "&service=oms-api&namespace=oms",
    "&service=oms-api&namespace=oms&provider=claude",
    "&service=unknown&namespace=oms",
    "&namespace=oms",
    "&severity=high",
    "&severity=low",
    "&incident_status=recurring",
    "&incident_status=open",
    "&environment=production",
    "&bucket=hour",
    "&page=2&page_size=1",
    "&page=999",
  ];
  const zones = [
    "from=2026-11-01&to=2026-11-02&timezone=America/New_York",
    "from=2026-11-01&to=2026-11-02&timezone=America/New_York&bucket=hour",
    "from=2026-11-01&to=2026-11-03&timezone=Asia/Bangkok",
    "from=2026-10-31T17:00:00Z&to=2026-11-01T17:00:00Z&timezone=UTC",
    "from=2026-11-01T01:30:00Z&to=2026-11-01T02:30:00Z&timezone=UTC&bucket=hour",
    "from=2026-10-30T00:00:00Z&to=2026-10-30T01:00:00Z&timezone=UTC&bucket=hour",
    "from=2020-01-01&to=2020-01-05&timezone=UTC",
  ];

  for (const [name, scope] of [
    ["owner", () => ({ ownerId: fixture.owner.id, all: false })],
    ["other owner", () => ({ ownerId: fixture.other.id, all: false })],
    ["admin support", () => ({ ownerId: fixture.admin.id, all: true })],
  ] as const)
    test(`fixture parity: every dashboard and filter (${name})`, async () => {
      for (const q of [...fixtureCases.map((c) => fixtureBase + c), ...zones])
        for (const d of ["usage", "performance", "workflows", "health"] as const) {
          const { ts, go: g } = await both(d, q, scope());
          assertSame(g, ts, `${d}?${q}`);
        }
      for (const q of [
        "&service=oms-api&namespace=oms",
        "&service=oms-api&namespace=oms&provider=claude",
      ]) {
        const { ts, go: g } = await both("health-service", fixtureBase + q, scope());
        assertSame(g, ts, `health-service${q}`);
      }
      const { ts, go: g } = await both("options", fixtureBase, scope());
      assertSame(g, ts, "options");
    });

  test("dataset parity: retries, invalidations, resumes, multi-repository runs and overlapping scans", async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const range = `from=${day(-11)}&to=${day(1)}`;
    const cases = [
      `${range}&timezone=UTC`,
      `${range}&timezone=Asia/Bangkok&group_by=repository`,
      `${range}&timezone=UTC&group_by=user&page=2&page_size=5`,
      `${range}&timezone=UTC&provider=codex`,
      `${range}&timezone=UTC&model=claude-model-1`,
      `${range}&timezone=UTC&repository=oms-api`,
      `${range}&timezone=UTC&project=WMS`,
      `${range}&timezone=UTC&workflow=bench-bugfix`,
      `${range}&timezone=UTC&service=api&namespace=oms`,
      `${range}&timezone=UTC&service=api&namespace=oms&user=${bench.owner}`,
      `${range}&timezone=UTC&severity=critical&incident_status=resolved`,
      `from=${day(-3)}&to=${day(0)}&timezone=Europe/Berlin&bucket=hour`,
    ];
    for (const scope of [
      { ownerId: bench.owner, all: false },
      { ownerId: bench.admin, all: true },
    ]) {
      for (const q of cases)
        for (const d of ["usage", "performance", "workflows", "health"] as const) {
          const { ts, go: g } = await both(d, q, scope);
          assertSame(g, ts, `${d}?${q} (all=${scope.all})`);
        }
      const svc = await both("health-service", cases[8], scope);
      assertSame(svc.go, svc.ts, "health-service");
      const opts = await both("options", cases[0], scope);
      assertSame(opts.go, opts.ts, "options");
    }
  });

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
    // Analytics has its own read-only pool, as large as its slots: it never takes a retrieval/indexing connection.
    assert.equal(stats.pool.max, stats.max_concurrent);
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

  test("validation and authentication failures are raised, never retried in TypeScript", async () => {
    resetAnalyticsEngine();
    const before = analyticsEngineStats.typescript;
    const f = parseAnalyticsFilters(new URLSearchParams(fixtureBase));
    await assert.rejects(
      loadDashboard("usage", { ...f, pageSize: 1000 }, { ownerId: fixture.owner.id, all: false }),
      (e: { status?: number }) => e.status === 400,
    );
    await assert.rejects(
      loadDashboard("usage", f, { ownerId: 0, all: false }),
      (e: { status?: number }) => e.status === 400,
    );
    const token = process.env.RETRIEVAL_INTERNAL_TOKEN;
    process.env.RETRIEVAL_INTERNAL_TOKEN = "x".repeat(64);
    try {
      await assert.rejects(
        loadDashboard("usage", f, { ownerId: fixture.owner.id, all: false }),
        (e: { status?: number }) => e.status === 502,
      );
    } finally {
      process.env.RETRIEVAL_INTERNAL_TOKEN = token;
    }
    assert.equal(analyticsEngineStats.typescript, before, "no TypeScript fallback ran");
  });

  test("availability failures fall back to TypeScript, bounded and observable", async () => {
    const f = parseAnalyticsFilters(new URLSearchParams(fixtureBase));
    const scope = { ownerId: fixture.owner.id, all: false };
    const expected = canon(await typescriptLoaders.usage(f, scope));
    resetAnalyticsEngine();
    config.retrieval.semantic.url = "http://127.0.0.1:9"; // nothing listens on discard
    try {
      const unreachable = analyticsEngineStats.fallbacks.unreachable ?? 0;
      assert.deepEqual(canon(await loadDashboard("usage", f, scope)), expected);
      assert.equal(analyticsEngineStats.fallbacks.unreachable, unreachable + 1);
      // During the cool-down Go is not called again.
      const coolDown = analyticsEngineStats.fallbacks.cool_down ?? 0;
      await loadDashboard("usage", f, scope);
      assert.equal(analyticsEngineStats.fallbacks.cool_down, coolDown + 1);
      // At most maxFallbackConcurrency TypeScript loads run at once; the rest are rejected with 503.
      const old = config.analytics.maxFallbackConcurrency;
      config.analytics.maxFallbackConcurrency = 1;
      try {
        const results = await Promise.allSettled(
          [1, 2, 3].map(() => loadDashboard("usage", f, scope)),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (const r of results.filter((x) => x.status === "rejected"))
          assert.equal((r as PromiseRejectedResult).reason.status, 503);
      } finally {
        config.analytics.maxFallbackConcurrency = old;
      }
    } finally {
      config.retrieval.semantic.url = realGoUrl;
      resetAnalyticsEngine();
    }
  });

  test("a Go deadline becomes a bounded fallback, and a disconnected client cancels the Go statement", async () => {
    const f = parseAnalyticsFilters(new URLSearchParams(fixtureBase));
    const scope = { ownerId: fixture.owner.id, all: false };
    resetAnalyticsEngine();
    const old = config.analytics.timeoutMs;
    config.analytics.timeoutMs = 1;
    try {
      const timeouts = analyticsEngineStats.fallbacks.timeout ?? 0;
      await loadDashboard("workflows", f, scope);
      assert.equal(analyticsEngineStats.fallbacks.timeout, timeouts + 1);
    } finally {
      config.analytics.timeoutMs = old;
      resetAnalyticsEngine();
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

  test("HTTP with the Go engine keeps owner scope and audits support reads, then rolls back by flag", async () => {
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
    // Rollback: flip the flag, stop nothing else; the same request returns the same data from TypeScript.
    flushAllCaches();
    const viaGo = await admin(`/api/analytics/performance?${fixtureBase}&scope=all`);
    config.analytics.engine = "typescript";
    try {
      flushAllCaches();
      const goCount = analyticsEngineStats.go;
      const viaTs = await admin(`/api/analytics/performance?${fixtureBase}&scope=all`);
      assert.equal(analyticsEngineStats.go, goCount);
      const strip = (b: Record<string, unknown>) => ({ ...b, generated_at: undefined });
      assert.deepEqual(canon(strip(viaTs.body)), canon(strip(viaGo.body)));
    } finally {
      config.analytics.engine = "go";
    }
  });
}
