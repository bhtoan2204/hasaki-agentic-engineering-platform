import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { registerDefaultExecutors } from "../src/workflow/executors/index.ts";
import { settleBackground } from "../src/workflow/background.ts";
import type { Actor } from "../src/authz/access.ts";
import {
  getReport,
  listReports,
  saveReport,
  setEvaluationVisibility,
  setReportVisibility,
} from "../src/eval/reports.ts";
import {
  cancelEvaluation,
  createEvaluation,
  evaluationDetail,
  evaluationList,
  publishBuiltinSuite,
} from "../src/eval/service.ts";
import { listEvalResults } from "../src/eval/resultsRepository.ts";
import { evaluationFilters, loadEvaluationAnalytics } from "../src/eval/analytics.ts";
import {
  autonomyGate,
  computeAutonomyMetrics,
  AUTONOMY_EVAL_VERSION,
} from "../src/eval/autonomy.ts";
import { runAutonomySuite, suiteManifest, VARIANTS } from "../src/eval/autonomySuite.ts";

const run = promisify(execFile);
const tag = Date.now().toString(36);
let alice: Actor;
let bob: Actor;
let admin: Actor;

const actor = (u: { id: number; username: string; role: string; active: boolean }): Actor => ({
  id: u.id,
  username: u.username,
  role: u.role as Actor["role"],
  active: u.active,
});
const report = (commit: string) => {
  const manifest = suiteManifest();
  const results = VARIANTS.slice(0, 2).map((v) => {
    const episodes = runAutonomySuite(v);
    const metrics = computeAutonomyMetrics(episodes);
    return { variant: v, metrics, gate: autonomyGate(metrics), episodes };
  });
  return {
    suite: manifest.version,
    metrics_version: AUTONOMY_EVAL_VERSION,
    manifest_hash: manifest.hash,
    commit,
    generated_at: new Date().toISOString(),
    evidence_kind: "control_plane",
    results,
  };
};

before(async () => {
  await migrate();
  config.evaluation.enabled = true;
  registerDefaultExecutors();
  alice = actor(
    await createUser({
      username: `evr-alice-${tag}`,
      password: "local-test-password",
      role: "member",
    }),
  );
  bob = actor(
    await createUser({
      username: `evr-bob-${tag}`,
      password: "local-test-password",
      role: "member",
    }),
  );
  admin = actor(
    await createUser({
      username: `evr-admin-${tag}`,
      password: "local-test-password",
      role: "admin",
    }),
  );
});
after(async () => {
  await settleBackground();
  await pool.end();
});

test("a report is persisted with its provenance and rows, once: saving again or importing its exported file is a no-op", async () => {
  const raw = report("c0ffee1");
  const first = await saveReport(raw, { ownerId: alice.id, source: "cli" });
  assert.equal(first.created, true);
  const again = await saveReport(raw, { ownerId: alice.id, source: "cli" });
  const imported = await saveReport(JSON.parse(JSON.stringify(raw)), {
    ownerId: alice.id,
    source: "import",
  });
  assert.deepEqual(
    [again.created, again.id, imported.created, imported.id],
    [false, first.id, false, first.id],
  );

  const stored = await getReport(alice, first.id);
  assert.deepEqual(
    [
      stored.kind,
      stored.suite,
      stored.suite_version,
      stored.manifest_hash,
      stored.commit_sha,
      stored.visibility,
      stored.source,
    ],
    ["autonomy", raw.suite, AUTONOMY_EVAL_VERSION, raw.manifest_hash, "c0ffee1", "private", "cli"],
  );
  assert.equal(stored.results.length, first.rows);
  assert.equal(
    (await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM eval_results WHERE report_id = $1",
      [first.id],
    ))!.n,
    first.rows,
    "no duplicated rows",
  );
  assert.equal(
    stored.metrics[VARIANTS[0].name].policy_compliance.value,
    1,
    "metrics kept as computed",
  );
});

test("private by default; team sharing is read-only for teammates and changeable only by the owner; admins need the support scope", async () => {
  const saved = await saveReport(report("deadbee"), { ownerId: alice.id, source: "cli" });
  const visibleTo = async (a: Actor, all = false) =>
    (await listReports(a, { kind: "autonomy", all })).some((r) => r.id === saved.id);
  assert.equal(await visibleTo(bob), false);
  await assert.rejects(getReport(bob, saved.id), /not found/);
  assert.equal(
    await visibleTo(admin),
    false,
    "an administrator does not see private reports by default",
  );
  assert.equal(await visibleTo(admin, true), true, "…but can with the explicit support scope");
  await assert.rejects(
    setReportVisibility(bob, saved.id, "team"),
    /not found/,
    "only the owner shares",
  );

  await setReportVisibility(alice, saved.id, "team");
  assert.equal(await visibleTo(bob), true);
  const shared = await getReport(bob, saved.id);
  assert.equal(shared.mine, false);
  assert.ok(
    (await listEvalResults(bob.id, raw().suite)).some(
      (r) => (r as { report_id?: number }).report_id === saved.id,
    ),
    "its rows are shared too",
  );
  await assert.rejects(setReportVisibility(bob, saved.id, "private"), /not found/);
  await setReportVisibility(alice, saved.id, "private");
  assert.equal(await visibleTo(bob), false, "unsharing takes effect");
});
const raw = () => report("x");

test("benchmark evaluations: a team-shared run is readable by teammates (and its results reach their analytics), never cancelable by them", async () => {
  const suite = await publishBuiltinSuite();
  const e = (await createEvaluation(alice.id, {
    suite_id: suite.id,
    request_key: `share-${tag}`,
    configuration: { adapter: "reference" },
  })) as { id: number };
  await assert.rejects(evaluationDetail(e.id, bob.id), /not found/);
  assert.ok(!(await evaluationList(bob.id)).some((x) => x.id === e.id));
  await assert.rejects(setEvaluationVisibility(bob, e.id, "team"), /not found/);
  const inBobsAnalytics = async () =>
    (
      await loadEvaluationAnalytics(
        evaluationFilters(
          bob,
          new URL(
            `http://x/?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`,
          ),
        ),
      )
    ).details.some((d) => Number(d.evaluation_id) === e.id);
  assert.equal(await inBobsAnalytics(), false);
  await setEvaluationVisibility(alice, e.id, "team");
  assert.equal(
    await inBobsAnalytics(),
    true,
    "shared evidence feeds teammates' analytics and recommendations",
  );
  assert.equal((await evaluationDetail(e.id, bob.id)).id, e.id);
  assert.ok((await evaluationList(bob.id)).some((x) => x.id === e.id && x.mine === false));
  await assert.rejects(
    cancelEvaluation(e.id, bob.id),
    /not found/,
    "write access stays with the owner",
  );
  const shared = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM evaluation_runs WHERE id = $1 AND visibility = 'team'",
    [e.id],
  );
  assert.equal(shared!.n, 1);
});

test("migration keeps legacy rows: results without an owner stay visible as before, new columns default to private", async () => {
  await q(
    pool,
    "INSERT INTO eval_results (suite, scenario, candidate, status) VALUES ($1, 's', 'platform', 'COMPLETED')",
    [`legacy-${tag}`],
  );
  const legacy = await listEvalResults(bob.id, `legacy-${tag}`);
  assert.equal(legacy.length, 1);
  const cols = await q<{ table_name: string; column_default: string }>(
    pool,
    "SELECT table_name, column_default FROM information_schema.columns WHERE column_name = 'visibility' AND table_name IN ('eval_results', 'evaluation_runs', 'evaluation_reports') ORDER BY table_name",
  );
  assert.equal(cols.length, 3);
  assert.ok(cols.every((c) => c.column_default.includes("private")));
});

test("eval:import brings local report files into PostgreSQL once, and refuses unknown files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evr-import-"));
  const autonomy = join(dir, "autonomy-feed.json");
  const bench = join(dir, "bench-results.json");
  const junk = join(dir, "junk.json");
  writeFileSync(autonomy, JSON.stringify(report("feed123")));
  writeFileSync(bench, JSON.stringify([{ scenario: "s1", status: "COMPLETED", correct: true }]));
  writeFileSync(junk, JSON.stringify({ hello: 1 }));
  const cli = (...args: string[]) =>
    run(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "src/cli/evalImport.ts",
        "--owner",
        alice.username,
        ...args,
      ],
      { env: process.env },
    ).catch((e: { stdout: string; stderr: string; code: number }) => ({
      stdout: e.stdout,
      stderr: e.stderr,
      code: e.code,
    }));
  const firstRun = await cli("--share", autonomy, bench);
  assert.match(firstRun.stdout, /autonomy-feed\.json: imported as #\d+ \(autonomy/);
  assert.match(firstRun.stdout, /bench-results\.json: imported as #\d+ \(bench, 1 results\)/);
  const second = await cli(autonomy, junk);
  assert.match(second.stdout, /autonomy-feed\.json: already stored as #\d+/);
  assert.match(second.stderr, /junk\.json: unrecognized/);
  assert.equal((second as { code?: number }).code, 1);
  const rows = await listReports(bob, {});
  assert.ok(
    rows.some(
      (r) => r.commit_sha === "feed123" && r.visibility === "team" && r.source === "import",
    ),
    "shared import visible to teammates",
  );
});
