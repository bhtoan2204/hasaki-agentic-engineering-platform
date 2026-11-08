import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, one } from "../src/db/pool.ts";
import { analyticsFixtures } from "./analytics.fixtures.ts";
import { parseAnalyticsFilters } from "../src/api/analytics/filters.ts";
import { usageAnalytics, performanceAnalytics, workflowAnalytics } from "../src/api/analytics/execution.ts";
import { healthAnalytics, healthServiceAnalytics, updateIncidentLifecycle } from "../src/api/analytics/health.ts";
import { handle } from "../src/http/app.ts";
let fixture: Awaited<ReturnType<typeof analyticsFixtures>>;
let server: Server, base: string;
const params = "from=2026-11-01&to=2026-11-03&timezone=UTC";
const filters = (extra = "") => parseAnalyticsFilters(new URLSearchParams(params + extra));
const scope = () => ({ ownerId: fixture.owner.id, all: false });
before(async () => {
  fixture = await analyticsFixtures();
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server?.close();
  await pool.end();
});
test("SQL totals preserve partial sessions, provider models, reported zero and owner isolation", async () => {
  const data = await usageAnalytics(filters(), scope());
  assert.equal(data.summary.invocations, 4);
  assert.equal(Number(data.summary.input_tokens), 300);
  assert.equal(Number(data.summary.reported_cost_usd), 0.4);
  assert.equal(data.summary.missing_reported_cost_usd, 3);
  assert.equal(Number(data.summary.cost_per_successful_run), 0.2);
  assert.equal(Number(data.summary.cost_per_verified_task), 0.4);
  assert.ok(!data.details.some((r) => r.run_id === fixture.hidden.id));
  const codex = await usageAnalytics(filters("&provider=codex"), scope());
  assert.equal(codex.summary.reported_cost_usd, null);
  assert.equal(codex.summary.cache_creation_tokens, null);
  assert.equal(Number(codex.summary.reasoning_tokens), 10);
  const partial = await usageAnalytics(filters("&model=claude-alt"), scope());
  assert.equal(partial.summary.input_tokens, null);
  assert.equal(partial.summary.invocations, 1);
});
test("every dimension filters on the server without multiplying repository usage", async () => {
  for (const extra of [
    "&project=OMS",
    "&repository=oms-api",
    "&workflow=analytics-fixture",
    `&user=${fixture.owner.id}`,
  ]) {
    const data = await usageAnalytics(filters(extra), scope());
    assert.equal(Number(data.summary.input_tokens), 300);
  }
  const repo = await usageAnalytics(filters("&group_by=repository"), scope());
  assert.equal(repo.breakdown.length, 2);
  assert.equal(Number(repo.breakdown[0].input_tokens), 300);
  for (const extra of ["&repository=missing", "&project=Other", `&user=${fixture.other.id}`]) {
    const f = filters(extra);
    assert.equal((await usageAnalytics(f, scope())).summary.invocations, 0);
    assert.equal((await performanceAnalytics(f, scope())).summary.runs, 0);
    assert.equal((await workflowAnalytics(f, scope())).details.length, 0);
    assert.equal((await healthAnalytics(f, scope())).details.length, 0);
  }
});
test("date-only timezone boundaries are half-open and equivalent to explicit offsets", async () => {
  const a = parseAnalyticsFilters(new URLSearchParams("from=2026-11-01&to=2026-11-02&timezone=Asia/Bangkok"));
  const b = parseAnalyticsFilters(
    new URLSearchParams("from=2026-10-31T17:00:00Z&to=2026-11-01T17:00:00Z&timezone=UTC"),
  );
  const x = await usageAnalytics(a, scope()),
    y = await usageAnalytics(b, scope());
  assert.equal(x.summary.invocations, y.summary.invocations);
  assert.equal(x.summary.invocations, 3);
  assert.ok(!x.details.some((r) => [fixture.before.id, fixture.codex.id].includes(r.run_id)));
});
test("performance distinguishes completion from verified tasks and reports measured context", async () => {
  const p = await performanceAnalytics(filters(), scope());
  assert.equal(p.summary.runs, 3);
  assert.equal(p.summary.completed_runs, 2);
  assert.equal(p.summary.verified_runs, 1);
  assert.equal(p.summary.verified_tasks, 1);
  assert.equal(p.summary.execution_p50_ms, 1000);
  assert.equal(p.summary.queue_ms, null);
  assert.equal(p.failures[0].category, "RATE_LIMIT");
  const w = await workflowAnalytics(filters(), scope());
  assert.equal(w.steps[0].context_preparation_ms, 42);
  assert.equal(w.evidence.repository_accuracy, null);
  assert.equal(w.evidence.labeled_repositories, 0);
});
test("health deduplicates repeated scans, preserves unknown lifecycle and protects foreign links", async () => {
  const h = await healthAnalytics(filters(), scope());
  assert.equal(Number(h.summary.total_errors), 24);
  assert.equal(h.summary.recurring, 2);
  assert.equal(h.summary.unresolved, 2);
  assert.equal(h.summary.resolve_ms, null);
  assert.equal(h.summary.missing_resolved, 2);
  assert.equal(Number(h.trend[0].events), 24);
  assert.equal(h.details.find((r) => r.fingerprint === fixture.foreignFingerprint)?.work_item_id, null);
  assert.equal(h.details.find((r) => r.fingerprint === fixture.foreignFingerprint)?.runs.length, 0);
  assert.equal(h.details.find((r) => r.fingerprint === fixture.fingerprint)?.runs[0].status, "COMPLETED");
  assert.equal(h.details.find((r) => r.fingerprint === fixture.fingerprint)?.lifecycle_status, "open");
});
test("service partitions preserve unknown attribution, namespace identity, shares, filters and previous-period semantics", async () => {
  const base = Date.now().toString(16).padStart(18, "0").slice(-18), fp = `${base}01`, fp2 = `${base}02`, scanIds: number[] = [];
  try {
    await pool.query(`INSERT INTO prod_error_groups(fingerprint,namespace,service,level,signature,day,today_count,yesterday_count,severity,first_seen_at)
      VALUES($1,'test-ns','','ERROR','unknown-service fixture','2026-11-01',6,0,'critical','2026-11-01T02:00:00Z')`, [fp]);
    const scan = await one(pool, `INSERT INTO prod_error_scans(trigger,ok,finished_at,window_start,window_end)
      VALUES('manual',true,now(),'2026-11-01T00:00:00Z','2026-11-01T03:00:00Z') RETURNING id`);
    scanIds.push(scan.id);
    await pool.query(`INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,first_at,last_at,severity,hourly)
      VALUES($1,$2,6,0,'2026-11-01T02:01:00Z','2026-11-01T02:59:00Z','critical',$3)`,
      [scan.id, fp, JSON.stringify([{hour:"2026-11-01T02:00:00Z",count:6}])]);
    await pool.query(`INSERT INTO prod_error_groups(fingerprint,namespace,service,level,signature,day,today_count,yesterday_count,severity,first_seen_at)
      VALUES($1,'test-ns','oms-api','ERROR','same service in another namespace','2026-11-01',3,0,'medium','2026-11-01T02:00:00Z')`, [fp2]);
    await pool.query(`INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,first_at,last_at,severity,hourly)
      VALUES($1,$2,3,0,'2026-11-01T02:01:00Z','2026-11-01T02:59:00Z','medium',$3)`,
      [scan.id, fp2, JSON.stringify([{hour:"2026-11-01T02:00:00Z",count:3}])]);
    const h = await healthAnalytics(filters(), scope());
    assert.equal(Number(h.summary.total_errors), 33);
    assert.equal(h.services.reduce((n: number,r: any)=>n+Number(r.events),0),Number(h.summary.total_errors));
    assert.ok(Math.abs(h.services.reduce((n:number,r:any)=>n+Number(r.error_share_pct),0)-100)<0.001);
    assert.ok(h.services.some((r:any)=>r.namespace==="test-ns"&&r.service==="unknown"&&Number(r.events)===6));
    assert.equal(h.services.filter((r:any)=>r.service==="oms-api").length,2);
    assert.ok(h.services.some((r:any)=>r.namespace==="oms"&&r.service==="oms-api"&&Number(r.events)===24));
    const service = await healthServiceAnalytics(filters("&service=unknown&namespace=test-ns"),scope());
    assert.equal(service.services.length,1);
    assert.equal(Number(service.services[0].events),6);
    const critical = await healthAnalytics(filters("&severity=critical"),scope());
    assert.equal(Number(critical.summary.total_errors),6);
    assert.equal(critical.services.length,1);
    const previous = await healthAnalytics(filters("&from=2026-11-01T00:00:00Z&to=2026-11-01T03:00:00Z&bucket=hour"),scope());
    assert.equal(previous.summary.comparisons.total_errors.current,33);
    assert.equal(previous.summary.comparisons.total_errors.previous,null);
  } finally {
    await pool.query("DELETE FROM prod_error_observations WHERE fingerprint=ANY($1::text[])",[[fp,fp2]]);
    await pool.query("DELETE FROM prod_error_groups WHERE fingerprint=ANY($1::text[])",[[fp,fp2]]);
    if(scanIds.length) await pool.query("DELETE FROM prod_error_scans WHERE id=ANY($1::bigint[])",[scanIds]);
  }
});
test("pagination and invalid filters are bounded", async () => {
  const p = await usageAnalytics(filters("&page_size=1&page=2"), scope());
  assert.equal(p.details.length, 1);
  assert.equal(p.details[0].total_rows, 4);
  for (const input of [
    "page=0",
    "page_size=101",
    "group_by=drop_table",
    "timezone=Bad/Zone",
    "provider=wrong",
    "severity=urgent",
    "incident_status=unknown",
    "environment=staging",
    "from=2026-02-30",
    "from=2025-01-01&to=2026-11-01",
    "from=2026-01-01&to=2026-04-01&bucket=hour",
  ]) {
    assert.throws(() => parseAnalyticsFilters(new URLSearchParams(input)));
  }
});
async function client(username: string) {
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "analytics-password" }),
  });
  const j = await login.json();
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  return async (path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": j.csrf },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
}
test("HTTP analytics enforces owner scope and audits explicit admin team reads including cache hits", async () => {
  const a = await client("analytics-a"),
    admin = await client("analytics-admin");
  assert.equal((await fetch(base + "/api/analytics/usage")).status, 401);
  for (const tab of ["health", "usage", "performance", "workflows"]) {
    const own = await a(`/api/analytics/${tab}?${params}&scope=all`);
    assert.equal(own.status, 200);
    const data = JSON.stringify(own.body);
    assert.ok(!data.includes("private-model"));
    assert.ok(!data.includes('"reported_cost_usd":99'));
  }
  const service = await a(`/api/analytics/health-service?${params}&service=oms-api&namespace=oms`);
  assert.equal(service.status,200);
  assert.equal(service.body.services.length,1);
  assert.ok(!JSON.stringify(service.body).includes('"reported_cost_usd":99'));
  const first = await admin(`/api/analytics/usage?${params}&scope=all`);
  assert.equal(first.status, 200);
  assert.equal(Number(first.body.summary.reported_cost_usd), 99.4);
  assert.equal((await admin(`/api/analytics/usage?${params}&scope=all`)).status, 200);
  assert.equal(
    (
      await one(
        pool,
        "SELECT count(*)::int AS n FROM audit_log WHERE resource_type='analytics' AND resource_id='usage'",
      )
    ).n,
    2,
  );
  assert.equal((await admin(`/api/analytics/usage?${params}`)).body.summary.invocations, 0);
});
test("incident drilldown enforces owner-scoped related records", async () => {
  const a = await client("analytics-a");
  const owned = await a(`/api/prod-errors/${fixture.fingerprint}`);
  const foreign = await a(`/api/prod-errors/${fixture.foreignFingerprint}`);
  assert.equal(owned.status,200);
  assert.equal(owned.body.group.work_item_id,fixture.claude.work_item_id);
  assert.equal(owned.body.observations.length,2);
  assert.equal(foreign.status,200);
  assert.equal(foreign.body.group.work_item_id,null);
  assert.deepEqual(foreign.body.group.pull_requests,[]);
});
test("only explicit audited operator status resolves a production incident", async () => {
  const member = await client("analytics-a");
  assert.equal(
    (
      await member(`/api/prod-errors/${fixture.fingerprint}/lifecycle`, {
        action: "resolve",
        evidence: "agent said success",
      })
    ).status,
    403,
  );
  await assert.rejects(updateIncidentLifecycle(fixture.admin, fixture.fingerprint, { action: "resolve" }), /evidence/);
  await updateIncidentLifecycle(fixture.admin, fixture.fingerprint, { action: "acknowledge" });
  await updateIncidentLifecycle(fixture.admin, fixture.fingerprint, {
    action: "resolve",
    evidence: "Production deployment incident #123 verified by operator",
  });
  const data = await healthAnalytics(filters(), scope());
  assert.equal(data.summary.resolved, 1);
  assert.ok(Number(data.summary.resolve_ms) > 0);
  await updateIncidentLifecycle(fixture.admin, fixture.fingerprint, { action: "reopen", evidence: "Error returned" });
  assert.equal((await healthAnalytics(filters(), scope())).summary.resolved, 0);
});

test("DST day boundaries and hourly repeated wall times retain distinct instants", async () => {
  const a = parseAnalyticsFilters(new URLSearchParams("from=2026-11-01&to=2026-11-02&timezone=America/New_York"));
  const b = parseAnalyticsFilters(
    new URLSearchParams("from=2026-11-01T04:00:00Z&to=2026-11-02T05:00:00Z&timezone=UTC"),
  );
  assert.equal((await usageAnalytics(a, scope())).summary.invocations, 1);
  assert.equal((await usageAnalytics(b, scope())).summary.invocations, 1);
  const rows = await pool.query(
    `SELECT date_trunc('hour',x,'America/New_York') AS bucket FROM unnest(ARRAY['2026-11-01T05:30:00Z'::timestamptz,'2026-11-01T06:30:00Z'::timestamptz]) x`,
  );
  assert.notEqual(rows.rows[0].bucket.getTime(), rows.rows[1].bucket.getTime());
});
test("production partial-hour ranges do not reuse entire snapshot counts", async () => {
  const f = parseAnalyticsFilters(
    new URLSearchParams("from=2026-11-01T01:30:00Z&to=2026-11-01T02:30:00Z&timezone=UTC&bucket=hour"),
  );
  const h = await healthAnalytics(f, scope());
  assert.equal(h.summary.total_errors, null);
  assert.deepEqual(h.trend, []);
});
test("no scan coverage stays unknown instead of becoming zero error events", async () => {
  const f = parseAnalyticsFilters(new URLSearchParams("from=2026-10-30T00:00:00Z&to=2026-10-30T01:00:00Z&timezone=UTC&bucket=hour"));
  const h = await healthAnalytics(f,scope());
  assert.equal(h.summary.total_errors,null);
  assert.deepEqual(h.trend,[]);
  assert.equal(h.freshness.scans_in_range,0);
  assert.equal(h.freshness.status,"partial");
});
test("explicitly reported zero remains distinct from unknown cost", async () => {
  const old = (await one(pool, "SELECT metrics FROM workflow_step_attempts WHERE id=$1", [fixture.codex.attempt_id]))
    .metrics;
  try {
    await pool.query(
      `UPDATE workflow_step_attempts SET metrics=jsonb_set(metrics,'{provider_sessions,main,reported_cost_usd}','0') WHERE id=$1`,
      [fixture.codex.attempt_id],
    );
    const data = await usageAnalytics(filters("&provider=codex"), scope());
    assert.equal(Number(data.summary.reported_cost_usd), 0);
    assert.equal(data.summary.missing_reported_cost_usd, 0);
  } finally {
    await pool.query("UPDATE workflow_step_attempts SET metrics=$2 WHERE id=$1", [
      fixture.codex.attempt_id,
      JSON.stringify(old),
    ]);
  }
});

test("anomalies require labeled provider/model peers and empty pages retain total counts", async () => {
  const old = (await one(pool, "SELECT metrics FROM workflow_step_attempts WHERE id=$1", [fixture.claude.attempt_id]))
    .metrics;
  const metrics = structuredClone(old);
  for (let i = 0; i < 5; i++)
    metrics.provider_sessions[`anomaly-peer-${i}`] = {
      provider: "claude",
      model: "claude-test",
      tokens: { input: i === 4 ? 50000 : 100, output: 10 },
      reported_cost_usd: null,
      complete: true,
    };
  try {
    await pool.query("UPDATE workflow_step_attempts SET metrics=$2 WHERE id=$1", [
      fixture.claude.attempt_id,
      JSON.stringify(metrics),
    ]);
    const data = await usageAnalytics(filters(), scope());
    assert.equal(data.details.filter((r) => r.token_anomaly).length, 1);
    const empty = await usageAnalytics(filters("&page=999"), scope());
    assert.equal(empty.details.length, 0);
    assert.equal(empty.summary.invocations, 9);
  } finally {
    await pool.query("UPDATE workflow_step_attempts SET metrics=$2 WHERE id=$1", [
      fixture.claude.attempt_id,
      JSON.stringify(old),
    ]);
  }
});

test("new scan histograms retain actual reported hours without inventing legacy buckets", async () => {
  const { toGroups } = await import("../src/prodErrors/scan.ts");
  const groups = toGroups(
    [
      {
        ns: "oms",
        svc: "api",
        lv: "ERROR",
        sig: "timeout",
        today: 7,
        yesterday: 1,
        analytics_hourly: ["1793491200:7", "not-a-point", "999999999999999999999:1"],
      },
    ],
    "2026-11-01",
  );
  assert.equal(groups[0].hourly.length, 1);
  assert.equal(groups[0].hourly[0].count, 7);
  assert.deepEqual(toGroups([{ ns: "oms", svc: "api", sig: "old", today: 7 }], "2026-11-01")[0].hourly, []);
});

test("human resume is separated from a failed-attempt retry", async () => {
  const old = await one(pool, "SELECT number,input FROM workflow_step_attempts WHERE id=$1", [
    fixture.codex.attempt_id,
  ]);
  try {
    await pool.query(
      `UPDATE workflow_step_attempts SET number=3,input='{"pending":{"resume":{"from_attempt_id":1}}}' WHERE id=$1`,
      [fixture.codex.attempt_id],
    );
    assert.equal((await performanceAnalytics(filters(), scope())).summary.retried_attempts, 0);
    await pool.query("UPDATE workflow_step_attempts SET input='{}' WHERE id=$1", [fixture.codex.attempt_id]);
    assert.equal((await performanceAnalytics(filters(), scope())).summary.retried_attempts, 1);
  } finally {
    await pool.query("UPDATE workflow_step_attempts SET number=$2,input=$3 WHERE id=$1", [
      fixture.codex.attempt_id,
      old.number,
      JSON.stringify(old.input),
    ]);
  }
});
