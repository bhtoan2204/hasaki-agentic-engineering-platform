import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { registerInstance } from "../src/instances.ts";
import { saveIntakePolicy } from "../src/workitems/intake.ts";
import { radarScan, listFindings } from "../src/radar/scan.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";

/** Seeded production-error observations (what the authorized prod-error scans store) → radar findings → intake. */
let ownerId = 0;

/** A successful scan covering `hours` hours up to `at`, with `count` events per hour (hourly array like the real scan). */
async function seedScan(
  at: Date,
  rows: Array<{ fp: string; count: number; baseline?: number }>,
  hours = 8,
) {
  const start = new Date(at.getTime() - hours * 3_600_000);
  const scan = (await one<{ id: number }>(
    pool,
    "INSERT INTO prod_error_scans(trigger,started_at,finished_at,ok,window_start,window_end) VALUES('manual',$1,$1,true,$2,$1) RETURNING id",
    [at, start],
  ))!;
  for (const r of rows) {
    const hourly = Array.from({ length: hours }, (_, i) => ({
      hour: new Date(start.getTime() + i * 3_600_000).toISOString(),
      count: r.count,
    }));
    await q(
      pool,
      "INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,severity,hourly) VALUES($1,$2,$3,$4,'low',$5)",
      [scan.id, r.fp, r.count * hours, r.baseline ?? r.count, JSON.stringify(hourly)],
    );
  }
  return scan.id;
}
async function group(
  fp: string,
  service: string,
  signature: string,
  firstSeen: Date,
  image?: string,
) {
  await q(
    pool,
    `INSERT INTO prod_error_groups(fingerprint,namespace,service,level,signature,day,first_seen_at,detail)
     VALUES($1,'prod',$2,'ERROR',$3,current_date,$4,$5) ON CONFLICT(fingerprint) DO UPDATE SET detail=$5`,
    [fp, service, signature, firstSeen, JSON.stringify(image ? { image } : {})],
  );
}

before(async () => {
  await migrate();
  await registerInstance();
  ownerId = (
    await createUser({ username: "radar-owner", password: "radar-test-password", role: "admin" })
  ).id;
  const now = Date.now();
  const old = new Date(now - 20 * 86_400_000);
  await group(
    "aaaaaaaaaaaaaaaaaaaa",
    "payment-api",
    "refund settle timeout",
    old,
    "reg/payment/pay:prod.1.aaaaaaa",
  );
  await group("bbbbbbbbbbbbbbbbbbbb", "oms-api", "order lookup not found", old);
  // 12 baseline scans (every 8h): stable volumes.
  for (let i = 12; i >= 1; i--)
    await seedScan(new Date(now - i * 8 * 3_600_000), [
      { fp: "aaaaaaaaaaaaaaaaaaaa", count: 40 + (i % 3) * 4 },
      { fp: "bbbbbbbbbbbbbbbbbbbb", count: 300 + (i % 4) * 20 },
    ]);
});
after(async () => {
  await settleBackground();
  await pool.end();
});

test("a seeded regression is detected with its evidence and timestamps; stable signals are not", async () => {
  // Deployment of a new image, then the latest scan: payment errors ×10, OMS unchanged, a brand-new signature.
  await radarScan(); // records the current version of every active series
  await group(
    "aaaaaaaaaaaaaaaaaaaa",
    "payment-api",
    "refund settle timeout",
    new Date(Date.now() - 20 * 86_400_000),
    "reg/payment/pay:prod.2.bbbbbbb",
  );
  await group(
    "cccccccccccccccccccc",
    "payment-api",
    "ledger write conflict",
    new Date(Date.now() - 3_600_000),
  );
  await seedScan(
    new Date(),
    [
      { fp: "aaaaaaaaaaaaaaaaaaaa", count: 450, baseline: 45 },
      { fp: "bbbbbbbbbbbbbbbbbbbb", count: 310 },
      { fp: "cccccccccccccccccccc", count: 120, baseline: 0 },
    ],
    1,
  );
  const report = (await radarScan())!;
  // Measured round-trips (every statement of the pass is counted): bounded by series and findings, not by events.
  assert.ok(report.queries > 6 && report.queries < 60, `bounded query volume (${report.queries})`);
  console.log(
    `radar scan: ${report.series} series, ${report.detected} detections, ${report.queries} queries, ${report.durationMs} ms`,
  );
  const findings = (await listFindings({ status: "open" })) as Array<Record<string, unknown>>;
  const pay = findings.find((f) => f.signature === "refund settle timeout")!;
  assert.ok(pay, "spike detected");
  assert.ok((pay.kinds as string[]).includes("error_spike"));
  assert.ok(
    (pay.kinds as string[]).includes("deploy_correlated"),
    "correlated with the image change",
  );
  assert.ok(["high", "critical"].includes(String(pay.severity)), "money path raises severity");
  const ev = pay.evidence as Array<{ ref: string; at: string; value: number }>;
  assert.ok(
    ev.some(
      (e) => e.ref.startsWith("prod_error:aaaaaaaaaaaaaaaaaaaa@scan:") && e.value === 450 && e.at,
    ),
  );
  assert.ok(
    findings.some(
      (f) =>
        f.signature === "ledger write conflict" && (f.kinds as string[]).includes("new_signature"),
    ),
  );
  assert.ok(
    !findings.some((f) => f.signature === "order lookup not found"),
    "stable volume is not a finding",
  );
  const audits = await q(
    pool,
    "SELECT action FROM audit_log WHERE resource_type='radar_finding' AND action='radar.finding.created'",
  );
  assert.equal(audits.length, findings.length, "every autonomous finding is audited");
});

test("restarts and repeated passes over the same data create no duplicates", async () => {
  const before = await q(pool, "SELECT id,occurrences FROM radar_findings ORDER BY id");
  await radarScan();
  await radarScan();
  const after = await q(pool, "SELECT id,occurrences FROM radar_findings ORDER BY id");
  assert.deepEqual(after, before);
  const scans = await q(
    pool,
    "SELECT detected,created,updated FROM radar_scans ORDER BY id DESC LIMIT 2",
  );
  assert.ok(scans.every((s) => s.created === 0 && s.updated === 0));
});

test("with a radar intake policy, findings become ONE deduplicated candidate work item each", async () => {
  // A source-wide default (no owner) must not disable owner-scoped radar intake.
  await saveIntakePolicy({ source: "radar", mode: "SHADOW", workflows: [] }, "test");
  await saveIntakePolicy(
    {
      source: "radar",
      owner_id: ownerId,
      mode: "SHADOW",
      workflows: ["production-incident-investigation"],
      min_severity: "medium",
    },
    "test",
  );
  // A new signal for the payment series (a further rise) re-triggers ingestion of that finding.
  await seedScan(
    new Date(Date.now() + 60_000),
    [
      { fp: "aaaaaaaaaaaaaaaaaaaa", count: 900, baseline: 45 },
      { fp: "cccccccccccccccccccc", count: 130, baseline: 0 },
    ],
    1,
  );
  const first = (await radarScan())!;
  assert.ok(first.ingested >= 1);
  const items = await q(pool, "SELECT * FROM intake_items WHERE source='radar'");
  const pay = (await one(
    pool,
    "SELECT * FROM radar_findings WHERE signature='refund settle timeout'",
  ))!;
  const item = items.find((i) => i.source_key === pay.fingerprint)!;
  assert.ok(item, "candidate in the intake queue");
  assert.equal(item.incident_fingerprint, "aaaaaaaaaaaaaaaaaaaa");
  const wi = (await one(pool, "SELECT code,description FROM work_items WHERE id=$1", [
    pay.work_item_id,
  ]))!;
  assert.match(String(wi.code), /^RADAR-/);
  for (const part of [
    "Proposed workflow: production-incident-investigation",
    "Recommended next action",
    "Evidence: prod_error:",
    "severity",
    "confidence",
    "root cause is NOT established",
  ])
    assert.ok(String(wi.description).includes(part), part);
  // Same incident again: no second intake item, no second work item.
  await seedScan(
    new Date(Date.now() + 120_000),
    [{ fp: "aaaaaaaaaaaaaaaaaaaa", count: 2000, baseline: 45 }],
    1,
  );
  await radarScan();
  assert.equal(
    (
      await q(pool, "SELECT 1 FROM intake_items WHERE source='radar' AND source_key=$1", [
        pay.fingerprint,
      ])
    ).length,
    1,
  );
  assert.equal((await q(pool, "SELECT 1 FROM work_items WHERE code=$1", [wi.code])).length, 1);
});

test("quiet findings resolve; persistent workflow failures are detected from run history", async () => {
  await q(pool, "UPDATE radar_findings SET last_detected_at = now() - interval '2 days'");
  const r = (await radarScan())!;
  assert.ok(r.resolved >= 1);
  assert.ok(
    (await q(pool, "SELECT 1 FROM audit_log WHERE action='radar.finding.resolved'")).length >= 1,
  );
  await definitions.create({
    key: "radar-flaky",
    spec: {
      name: "flaky",
      steps: [
        { key: "build", type: "command", requires_approval: true, config: { command: "true" } },
      ],
    },
  });
  for (let i = 0; i < 3; i++) {
    const run = await startRun({ definitionKey: "radar-flaky", title: `flaky ${i}`, ownerId });
    await q(
      pool,
      "UPDATE workflow_steps SET status='FAILED',error=$2,updated_at=now() WHERE run_id=$1",
      [(run as { id: number }).id, `go: module example.com/x@v1.${i} not found (attempt ${i + 7})`],
    );
  }
  await radarScan();
  const wf = (await listFindings({ status: "open" })) as Array<Record<string, unknown>>;
  const flaky = wf.find((f) => (f.kinds as string[]).includes("workflow_failures"))!;
  assert.ok(
    flaky,
    "three runs failing with the same normalized error are one persistent-failure finding",
  );
  assert.equal(flaky.service, "radar-flaky / build");
  assert.equal((flaky.evidence as unknown[]).length, 3);
});

test("a long manual scan over an unchanged hourly rate is not a spike and sends nothing", async () => {
  const notified = (await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM telegram_notifications",
  ))!.n;
  // 72-hour manual scan: event_count is 72× an hourly scan's, the hourly rate is the same as the baseline.
  await seedScan(new Date(Date.now() + 180_000), [{ fp: "bbbbbbbbbbbbbbbbbbbb", count: 310 }], 72);
  const r = (await radarScan())!;
  assert.ok(
    !(await listFindings({ status: "open" })).some(
      (f) => (f as { signature: string }).signature === "order lookup not found",
    ),
  );
  assert.equal(
    (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM telegram_notifications"))!.n,
    notified,
  );
  assert.ok(r.queries > 0);
});
