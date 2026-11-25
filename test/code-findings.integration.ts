import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { one, pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { createUser } from "../src/auth/users.ts";
import {
  findingDetail,
  ingestPendingScans,
  listFindings,
  setFindingStatus,
} from "../src/workflow/codeFindings.ts";

/**
 * Findings across assessments: scans are written the way the engine leaves them (a codebase-assessment run whose
 * assess step completed with findings), then ingested; no agent runs.
 */
before(async () => {
  await migrate();
  await seedTemplates();
});
after(async () => {
  await pool.end();
});

let n = 0;
async function owner() {
  const u = await createUser({
    username: `findings-${Date.now()}-${n++}`,
    password: "secret-password-1",
    role: "member",
  });
  return u.id;
}

async function run(
  ownerId: number,
  key: string,
  repos: string[],
  createdAt: string,
  inputs: Record<string, unknown> = {},
  status = "COMPLETED",
) {
  const version = await one<{ id: number }>(
    pool,
    `SELECT v.id FROM workflow_definition_versions v JOIN workflow_definitions d ON d.id = v.definition_id
      WHERE d.key = $1 ORDER BY v.version DESC LIMIT 1`,
    [key],
  );
  return (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_runs (definition_key, definition_version_id, title, graph, branch, status, worker_instance,
            allowed_repositories, selected_repositories, inputs, owner_id, created_at)
     VALUES ($1, $2, 't', '[]'::jsonb, 'b', $3, $4, $5, $5, $6, $7, $8) RETURNING id`,
    [
      key,
      version!.id,
      status,
      config.instanceId,
      repos,
      JSON.stringify(inputs),
      ownerId,
      createdAt,
    ],
  ))!.id;
}

async function step(
  runId: number,
  key: string,
  status: string,
  output: unknown = null,
  position = 0,
) {
  await q(
    pool,
    `INSERT INTO workflow_steps (run_id, key, type, name, position, status, output) VALUES ($1, $2, 'agent', $2, $3, $4, $5)`,
    [runId, key, position, status, output == null ? null : JSON.stringify(output)],
  );
}

async function scan(ownerId: number, repos: string[], at: string, findings: unknown[]) {
  const id = await run(ownerId, "codebase-assessment", repos, at);
  await step(id, "assess", "COMPLETED", {
    decision: findings.length ? "FINDINGS" : "NO_CHANGES_NEEDED",
    findings,
  });
  return id;
}

const N1 = {
  id: "P1",
  kind: "PERFORMANCE",
  severity: "high",
  title: "N+1 line item queries",
  repo: "oms-api",
  file: "app/order/create.go",
  line: 214,
  symbol: "CreateOrder",
  issue: "Line items are loaded once per item inside the loop.",
  evidence: "create.go:208-221 at 9f3c2e1",
  implementable: true,
};

test("a finding reported by repeated scans is one finding with every scan's evidence", async () => {
  const me = await owner();
  const s1 = await scan(me, ["oms-api"], "2026-11-01T00:00:00Z", [N1]);
  const s2 = await scan(me, ["oms-api"], "2026-11-02T00:00:00Z", [
    {
      ...N1,
      id: "F7",
      line: 230,
      severity: "medium",
      issue: "Reworded: per-item query in loop.",
      evidence: "create.go:224 at a1b2c3d",
    },
  ]);
  assert.equal(await ingestPendingScans(me), 2);
  assert.equal(await ingestPendingScans(me), 0, "ingestion runs once per scan");

  const list = await listFindings({ ownerId: me });
  assert.equal(list.total, 1);
  const f = list.items[0] as Record<string, unknown>;
  assert.equal(f.occurrences, 2);
  assert.equal(f.severity, "medium", "the newest scan's description wins");
  assert.equal(f.line, 230);
  assert.equal(f.last_scan_run_id, s2);
  assert.equal(new Date(f.first_seen_at as string).toISOString(), "2026-11-01T00:00:00.000Z");

  const d = (await findingDetail(Number(f.id), { ownerId: me }))!;
  const sightings = d.sightings as Array<{
    scan_run_id: number;
    evidence: string;
    finding_key: string;
  }>;
  assert.deepEqual(
    sightings.map((s) => [Number(s.scan_run_id), s.finding_key, s.evidence]),
    [
      [s2, "F7", "create.go:224 at a1b2c3d"],
      [s1, "P1", "create.go:208-221 at 9f3c2e1"],
    ],
  );
});

test("lifecycle: not reported is not resolved; resolved reopens when reported again; dismissed stays", async () => {
  const me = await owner();
  const other = {
    ...N1,
    id: "D2",
    kind: "RELIABILITY",
    symbol: "Handle",
    file: "app/http/order.go",
    title: "nil address panics",
  };
  await scan(me, ["oms-api"], "2026-11-01T00:00:00Z", [N1, other]);
  await ingestPendingScans(me);
  await scan(me, ["oms-api"], "2026-11-02T00:00:00Z", []);
  await ingestPendingScans(me);
  let list = await listFindings({ ownerId: me });
  assert.equal(list.total, 2);
  assert.ok(
    list.items.every((x) => (x as { status: string }).status === "open"),
    "a scan that does not report a finding leaves it open",
  );

  const byTitle = (t: string) =>
    Number((list.items as Array<{ id: number; title: string }>).find((x) => x.title === t)!.id);
  const n1 = byTitle(N1.title);
  const d2 = byTitle("nil address panics");
  await setFindingStatus(n1, { id: me }, "resolved", "fixed in PR 12");
  await setFindingStatus(d2, { id: me }, "dismissed", "accepted risk");

  await scan(me, ["oms-api"], new Date(Date.now() + 60_000).toISOString(), [N1, other]);
  await ingestPendingScans(me);
  list = await listFindings({ ownerId: me });
  const st = Object.fromEntries(
    (list.items as Array<{ id: number; status: string; reopened_count: number }>).map((x) => [
      Number(x.id),
      [x.status, x.reopened_count],
    ]),
  );
  assert.deepEqual(st[n1], ["open", 1], "resolved, then reported again: reopened");
  assert.deepEqual(st[d2], ["dismissed", 0], "a person's dismissal is kept");
  assert.equal(list.total, 2, "no duplicate created");
});

test("fix runs started from a scan before findings were managed stay attached", async () => {
  const me = await owner();
  const s1 = await scan(me, ["oms-api"], "2026-11-01T00:00:00Z", [N1]);
  const fix = await run(
    me,
    "codebase-improvement",
    ["oms-api"],
    "2026-11-01T01:00:00Z",
    {
      finding: { ...N1, scan_run_id: s1 },
      decision: "batch the query",
    },
    "RUNNING",
  );
  await step(fix, "implement", "RUNNING");
  await scan(me, ["oms-api"], "2026-11-03T00:00:00Z", [{ ...N1, id: "Z9" }]);
  await ingestPendingScans(me);
  const list = await listFindings({ ownerId: me });
  assert.equal(list.total, 1);
  const f = list.items[0] as { id: number; display_status: string; fix_run_id: number };
  assert.equal(f.display_status, "in_progress");
  assert.equal(Number(f.fix_run_id), fix);
  const d = (await findingDetail(Number(f.id), { ownerId: me }))!;
  assert.deepEqual(
    (d.fixes as Array<{ id: number; decision: string }>).map((x) => [Number(x.id), x.decision]),
    [[fix, "batch the query"]],
  );
  // A fix run started from the managed finding links by fingerprint.
  const fp = (await one<{ fingerprint: string }>(
    pool,
    "SELECT fingerprint FROM code_findings WHERE id = $1",
    [f.id],
  ))!;
  const fix2 = await run(me, "codebase-improvement", ["oms-api"], "2026-11-04T00:00:00Z", {
    finding: { ...N1, id: "Z9", fingerprint: fp.fingerprint, scan_run_id: 0 },
  });
  await step(fix2, "implement", "COMPLETED");
  const after = (await listFindings({ ownerId: me })).items[0] as {
    display_status: string;
    fix_run_id: number;
  };
  assert.equal(Number(after.fix_run_id), fix2);
  assert.equal(after.display_status, "fixed");
});

test("filters (repo incl. related, severity, category, status, search, scan, project) and pagination", async () => {
  const me = await owner();
  const findings = Array.from({ length: 7 }, (_, i) => ({
    id: `F${i}`,
    kind: i % 2 ? "SECURITY" : "PERFORMANCE",
    severity: ["high", "medium", "low"][i % 3],
    title: `finding ${i}`,
    repo: i < 5 ? "pay-api" : "pay-worker",
    related_repos: i === 0 ? ["pay-worker"] : [],
    file: `f${i}.go`,
    symbol: `S${i}`,
    issue: i === 3 ? "token leaks into logs" : `issue ${i}`,
    evidence: "e",
    implementable: i !== 4,
    code_evidence:
      i === 6 ? { status: "missing", reason: "x" } : { status: "verified", calls: [1] },
  }));
  const s = await scan(me, ["pay-api", "pay-worker"], "2026-11-01T00:00:00Z", findings);
  await ingestPendingScans(me);
  const count = async (f: Parameters<typeof listFindings>[0]) =>
    (await listFindings({ ownerId: me, ...f })).total;
  assert.equal(await count({}), 7);
  assert.equal(await count({ repo: "pay-worker" }), 3, "own repo or related");
  assert.equal(await count({ severity: "high" }), 3);
  assert.equal(await count({ kind: "SECURITY" }), 3);
  assert.equal(await count({ status: "report_only" }), 1);
  assert.equal(await count({ status: "unverified" }), 1);
  assert.equal(await count({ status: "needs_look" }), 5);
  assert.equal(await count({ q: "token" }), 1);
  assert.equal(await count({ q: "100%" }), 0, "LIKE wildcards are literal");
  assert.equal(await count({ scan: s }), 7);
  assert.equal(await count({ scan: s + 100000 }), 0);
  assert.equal(await count({ ownerId: await owner() }), 0, "another owner sees none");

  await q(
    pool,
    "INSERT INTO repositories (name, path, projects) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET projects = $3",
    ["pay-worker", "/tmp/pay-worker", ["PayTest"]],
  );
  assert.equal(await count({ project: "paytest" }), 3);

  const p1 = await listFindings({ ownerId: me, pageSize: 3, page: 1 });
  const p3 = await listFindings({ ownerId: me, pageSize: 3, page: 3 });
  assert.equal(p1.items.length, 3);
  assert.equal(p3.items.length, 1);
  assert.equal(p1.total, 7);
  assert.equal((p1.items[0] as { severity: string }).severity, "high", "most severe first");
  assert.deepEqual(p1.facets.repos, ["pay-api", "pay-worker"]);
  assert.equal(p1.facets.statuses.needs_look, 5);
});
