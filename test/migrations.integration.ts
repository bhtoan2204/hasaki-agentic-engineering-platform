import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { loadMigrations, migrate } from "../src/db/migrate.ts";

after(() => pool.end());

test("legacy data survives the upgrade and is backfilled into work items / pull requests", async () => {
  const all = loadMigrations();
  // An existing install: only the legacy schema, with real rows.
  await migrate(pool, all.slice(0, 1));
  await pool.query(`INSERT INTO tasks (code, work_id, name, project, payload, status) VALUES
      ('TASK-1', 42, 'Fix stock', 'OMS', '{"code":"TASK-1","name":"Fix stock","note":"WMS timeout"}', 'review'),
      ('TASK-2', NULL, 'Manual one', '', '{"code":"TASK-2","name":"Manual one"}', 'idle')`);
  await pool.query(
    `INSERT INTO questions (task_code, question, answer) VALUES ('TASK-1', 'Retry how often?', '3 times')`,
  );
  await pool.query(
    `INSERT INTO events (task_code, kind, content) VALUES ('TASK-1', 'status', 'review')`,
  );
  await pool.query(`INSERT INTO prs (task_code, repo, branch, url, title, decisions) VALUES
      ('TASK-1', 'oms-api', 'TASK-1', 'https://bitbucket.org/hasaki-tech/oms-api/pull-requests/7', 'fix(stock): retry', '[{"title":"a","detail":"b"}]')`);

  const applied = await migrate(pool, all);
  assert.deepEqual(
    applied,
    all.slice(1).map((m) => m.name),
  );

  const wi = (await pool.query("SELECT * FROM work_items ORDER BY code")).rows;
  assert.equal(wi.length, 2);
  assert.equal(wi[0].source, "hasaki_work");
  assert.equal(wi[0].external_id, "42");
  assert.equal(wi[0].description, "WMS timeout");
  assert.equal(wi[0].legacy_task_code, "TASK-1");
  assert.equal(wi[1].source, "legacy");

  const pr = (await pool.query("SELECT * FROM pull_requests")).rows;
  assert.equal(pr.length, 1);
  assert.equal(pr[0].work_item_id, wi[0].id);
  assert.equal(pr[0].target_branch, "release/prod");
  assert.equal(pr[0].created, true);
  assert.deepEqual(pr[0].decisions, [{ title: "a", detail: "b" }]);

  // Legacy tables are untouched.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM questions")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n, 1);
  assert.equal(
    (await pool.query("SELECT status FROM tasks WHERE code = 'TASK-1'")).rows[0].status,
    "review",
  );
});

test("migrations are idempotent and refuse edited history", async () => {
  await migrate(pool);
  assert.deepEqual(await migrate(pool), []);
  const edited = loadMigrations().map((m, i) => (i === 1 ? { ...m, checksum: "tampered" } : m));
  await assert.rejects(migrate(pool, edited), /checksum mismatch/);
});

test("schema constraints reject invalid keys and statuses", async () => {
  await migrate(pool);
  await assert.rejects(
    pool.query(`INSERT INTO workflow_definitions (key, name) VALUES ('Bad Key', 'x')`),
    /check constraint/,
  );
  await assert.rejects(
    pool.query(`INSERT INTO work_items (code, source, title) VALUES ('X-1', 'email', 't')`),
    /check constraint/,
  );
});
