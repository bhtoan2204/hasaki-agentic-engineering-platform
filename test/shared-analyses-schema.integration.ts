import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { installationId, resetInstallationIdForTests } from "../src/sharing/scope.ts";
import { assessKeyForTest } from "./fixtures/sharedKeys.ts";

const ROLLBACK = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "docs",
    "shared-results",
    "rollback",
    "112_shared_analyses.down.sql",
  ),
  "utf8",
);
let userId = 0;
before(async () => {
  await migrate();
  userId = (
    await createUser({
      username: "shared-schema",
      password: "shared-schema-password",
      role: "member",
    })
  ).id;
});
after(() => pool.end());

const KEY = (n: number) => String(n).padStart(64, "0");
const insert = (over: Record<string, unknown> = {}) => {
  const row = {
    kind: "code_assessment",
    key: KEY(1),
    version: 1,
    status: "valid",
    key_parts: {},
    result: { findings: [] },
    trigger: "manual",
    error_key: null,
    ...over,
  };
  return q(
    pool,
    `INSERT INTO shared_analyses (kind, key, version, status, key_parts, result, trigger, error_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      row.kind,
      row.key,
      row.version,
      row.status,
      JSON.stringify(row.key_parts),
      row.result === null ? null : JSON.stringify(row.result),
      row.trigger,
      row.error_key,
      userId,
    ],
  );
};
const rejects = (p: Promise<unknown>, constraint: RegExp) =>
  assert.rejects(p, (e: Error & { constraint?: string }) =>
    constraint.test(String(e.constraint ?? e.message)),
  );

test("the installation id is created once by the migration and is a UUID; every instance reads the same", async () => {
  resetInstallationIdForTests();
  const id = await installationId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(await installationId(), id);
  assert.equal((await assessKeyForTest(id)) !== "", true, "usable as the scope of a key");
  await migrate();
  resetInstallationIdForTests();
  assert.equal(await installationId(), id, "migrating again does not change it");
});

test("a published analysis is stored once per (kind, key, version); a force re-run is the next version", async () => {
  await insert({ key: KEY(10) });
  await rejects(insert({ key: KEY(10) }), /shared_analyses_kind_key_version_key/);
  await insert({ key: KEY(10), version: 2 });
  await insert({ key: KEY(10), kind: "prod_error.bug_hunt", error_key: "87d5edbc020d1f804eb9" });
});

test("single-flight in the database: one running analysis per key, however many instances try", async () => {
  await insert({ key: KEY(20), status: "running", result: null });
  await rejects(
    insert({ key: KEY(20), version: 2, status: "running", result: null }),
    /shared_analyses_one_running/,
  );
  await insert({ key: KEY(21), status: "running", result: null });
  await insert({ key: KEY(20), version: 3, status: "failed", result: null });
  const done = await q(
    pool,
    "UPDATE shared_analyses SET status = 'valid', result = '{}' WHERE kind = 'code_assessment' AND key = $1 AND status = 'running' RETURNING id",
    [KEY(20)],
  );
  assert.equal(done.length, 1);
  await insert({ key: KEY(20), version: 4, status: "running", result: null });
});

test("integrity: key and error key formats, kind and error key agree, a served result is never empty", async () => {
  await rejects(insert({ key: "not-a-hash" }), /shared_analyses_key_check/);
  await rejects(insert({ key: KEY(30), kind: "nonsense" }), /shared_analyses_kind_check/);
  await rejects(insert({ key: KEY(31), status: "nonsense" }), /shared_analyses_status_check/);
  await rejects(insert({ key: KEY(32), version: 0 }), /shared_analyses_version_check/);
  await rejects(insert({ key: KEY(33), trigger: "cron" }), /shared_analyses_trigger_check/);
  await rejects(
    insert({ key: KEY(34), kind: "prod_error.runtime_rca", error_key: null }),
    /shared_analyses_error_key_kind/,
  );
  await rejects(
    insert({ key: KEY(35), kind: "code_assessment", error_key: "87d5edbc020d1f804eb9" }),
    /shared_analyses_error_key_kind/,
  );
  await rejects(
    insert({ key: KEY(36), kind: "prod_error.bug_hunt", error_key: "too-short" }),
    /shared_analyses_error_key_check/,
  );
  await rejects(
    insert({ key: KEY(37), status: "valid", result: null }),
    /shared_analyses_result_present/,
  );
  await rejects(
    insert({ key: KEY(38), status: "stale", result: null }),
    /shared_analyses_result_present/,
  );
  await insert({ key: KEY(39), status: "failed", result: null });
  await insert({ key: KEY(40), status: "running", result: null });
});

test("lookup is one index probe on (kind, key) returning the highest version", async () => {
  for (const v of [1, 2, 3])
    await insert({ key: KEY(50), version: v, status: v === 3 ? "valid" : "superseded" });
  const latest = await one<{ version: number }>(
    pool,
    "SELECT version FROM shared_analyses WHERE kind = $1 AND key = $2 ORDER BY version DESC LIMIT 1",
    ["code_assessment", KEY(50)],
  );
  assert.equal(latest!.version, 3);
  const client = await pool.connect();
  try {
    await client.query("SET enable_seqscan = off");
    const plan = (
      await client.query(
        "EXPLAIN SELECT version, status FROM shared_analyses WHERE kind = $1 AND key = $2 ORDER BY version DESC LIMIT 1",
        ["code_assessment", KEY(50)],
      )
    ).rows
      .map((r) => r["QUERY PLAN"])
      .join("\n");
    assert.match(plan, /Index (Only )?Scan.*shared_analyses_(lookup|kind_key_version_key)/);
    const byError = (
      await client.query(
        "EXPLAIN SELECT 1 FROM shared_analyses WHERE error_key = $1 AND kind = $2",
        ["87d5edbc020d1f804eb9", "prod_error.bug_hunt"],
      )
    ).rows
      .map((r) => r["QUERY PLAN"])
      .join("\n");
    assert.match(byError, /shared_analyses_error/);
  } finally {
    client.release();
  }
});

test("uses are checked, and are deleted together with their analysis", async () => {
  const [{ id }] = await insert({ key: KEY(60) });
  await q(
    pool,
    "INSERT INTO shared_analysis_uses (analysis_id, user_id, outcome, tokens_saved) VALUES ($1, $2, 'hit', 1200)",
    [id, userId],
  );
  await rejects(
    q(
      pool,
      "INSERT INTO shared_analysis_uses (analysis_id, user_id, outcome) VALUES ($1, $2, 'peek')",
      [id, userId],
    ),
    /shared_analysis_uses_outcome_check/,
  );
  await rejects(
    q(
      pool,
      "INSERT INTO shared_analysis_uses (analysis_id, user_id, outcome, tokens_saved) VALUES ($1, $2, 'hit', -1)",
      [id, userId],
    ),
    /tokens_saved_check/,
  );
  await q(pool, "DELETE FROM shared_analyses WHERE id = $1", [id]);
  assert.equal(
    (await q(pool, "SELECT 1 FROM shared_analysis_uses WHERE analysis_id = $1", [id])).length,
    0,
  );
});

test("rollback: the down script removes the tables, keeps the installation id, and the migrator applies 112 again", async () => {
  resetInstallationIdForTests();
  const id = await installationId();
  await pool.query(ROLLBACK);
  assert.equal(
    (await one<{ t: string | null }>(pool, "SELECT to_regclass('public.shared_analyses') AS t"))!.t,
    null,
  );
  assert.equal(
    (await one<{ t: string | null }>(
      pool,
      "SELECT to_regclass('public.shared_analysis_uses') AS t",
    ))!.t,
    null,
  );
  assert.equal((await q(pool, "SELECT 1 FROM schema_migrations WHERE version = 112")).length, 0);
  assert.equal(
    (await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM schema_migrations WHERE version = 111",
    ))!.n,
    1,
    "earlier migrations are untouched",
  );
  await migrate();
  assert.ok(
    (await one<{ t: string | null }>(pool, "SELECT to_regclass('public.shared_analyses') AS t"))!.t,
  );
  resetInstallationIdForTests();
  assert.equal(await installationId(), id, "the same scope after re-applying, so no key changed");
  await insert({ key: KEY(70) });
});
