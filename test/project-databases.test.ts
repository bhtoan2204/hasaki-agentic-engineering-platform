/**
 * Project QC databases (migration 046, src/integrations/database.ts): read-only statement check, run-scope
 * authorization through the agent tool registry and admin API. MySQL uses the existing driver fake;
 * platform persistence uses PostgreSQL started by the test preload. No external service is required.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { setRepositoryAccess } from "../src/repos/access.ts";
import {
  assertReadOnlySql,
  databasesForRun,
  runQuery,
  saveDatabase,
  setDatabaseDriver,
  testDatabase,
  listDatabases,
} from "../src/integrations/database.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

let server: Server;
let base = "";
type Call = (path: string, body?: unknown) => Promise<{ status: number; body: any; text: string }>;
let admin: Call, A: Call, B: Call;
const ids: Record<string, number> = {};

async function login(username: string, password: string): Promise<Call> {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const { csrf } = await r.json();
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrf }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {}, text };
  };
}

before(async () => {
  await migrate();
  await seedTemplates();
  registerBuiltinTools();
  for (const [u, role] of [
    ["db-admin", "admin"],
    ["db-a", "member"],
    ["db-b", "member"],
  ] as const)
    ids[u] = Number((await createUser({ username: u, password: `${u}-password`, role })).id);
  for (const [name, project] of [
    ["oms-api", "OMS"],
    ["warranty-api", "OMS"],
    ["payment-core", "Payment"],
  ])
    await repositories.upsert(name, { projects: [project] });
  // A: OMS repositories only. B: nothing.
  for (const name of ["oms-api", "warranty-api"])
    await setRepositoryAccess(
      (await repositories.get(name))!,
      ids["db-a"],
      "read",
      ids["db-admin"],
    );
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  admin = await login("db-admin", "db-admin-password");
  A = await login("db-a", "db-a-password");
  B = await login("db-b", "db-b-password");
});

after(async () => {
  setDatabaseDriver(null);
  server.close();
  await pool.end();
});

test("read-only statement check: reads pass, writes / locks / files / sessions / tricks are refused", () => {
  for (const ok of [
    "SELECT id, status FROM orders WHERE code = 'DELETE ME; DROP TABLE x' LIMIT 10",
    "select * from `update` where `insert` = 1;",
    "WITH t AS (SELECT 1 AS a) SELECT a FROM t",
    "SHOW TABLES",
    "DESCRIBE orders",
    "EXPLAIN SELECT * FROM orders WHERE id = 1",
    "SELECT /* a comment with DELETE */ 1 -- trailing UPDATE\n",
    "SELECT updated_at, deleted_at, created_by FROM orders",
  ])
    assert.doesNotThrow(() => assertReadOnlySql(ok), ok);
  for (const [bad, why] of [
    ["UPDATE orders SET status = 1", /only SELECT/],
    ["DELETE FROM orders", /only SELECT/],
    ["INSERT INTO t VALUES (1)", /only SELECT/],
    ["DROP TABLE orders", /only SELECT/],
    ["SELECT 1; DELETE FROM orders", /one statement/],
    ["SELECT * FROM orders INTO OUTFILE '/tmp/x'", /INTO/],
    ["SELECT * FROM orders FOR UPDATE", /UPDATE/],
    ["SELECT * FROM orders LOCK IN SHARE MODE", /LOCK/],
    ["SELECT SLEEP(100)", /SLEEP/],
    ["SELECT BENCHMARK(1e9, MD5('x'))", /BENCHMARK/],
    ["SELECT LOAD_FILE('/etc/passwd')", /LOAD_FILE/],
    ["SELECT 1 /*!50000 , (DELETE FROM orders) */", /executable comments/],
    ["SELECT @@hostname", /session variables/],
    ["WITH d AS (SELECT 1) DELETE FROM orders", /DELETE/],
    ["SET SESSION sql_mode = ''", /only SELECT/],
    ["SELECT 'unterminated", /unterminated/],
    ["", /empty/],
  ] as const)
    assert.throws(() => assertReadOnlySql(bad), why, bad);
});

test("admin API: create needs a password, it is never returned; members cannot manage", async () => {
  assert.equal(
    (
      await A("/api/integrations/databases", {
        key: "x",
        project: "OMS",
        host: "h",
        database_name: "d",
        username: "u",
        password: "p",
      })
    ).status,
    403,
  );
  const noPw = await admin("/api/integrations/databases", {
    key: "oms-qc",
    project: "OMS",
    host: "oms-db.qc",
    database_name: "oms",
    username: "ro",
  });
  assert.equal(noPw.status, 400);
  for (const body of [
    {
      key: "oms-qc",
      project: "OMS",
      host: "oms-db.qc",
      database_name: "oms",
      username: "ro",
      password: "secret-oms-pw",
      description: "orders, shipments",
    },
    {
      key: "warranty-qc",
      repositories: ["warranty-api"],
      host: "w-db.qc",
      database_name: "warranty",
      username: "ro",
      password: "secret-w-pw",
    },
    {
      key: "payment-qc",
      project: "Payment",
      host: "p-db.qc",
      database_name: "payment",
      username: "ro",
      password: "secret-p-pw",
    },
  ]) {
    const r = await admin("/api/integrations/databases", body);
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(r.text, /secret-/);
    assert.equal(r.body.has_password, true);
  }
  assert.equal(
    (
      await admin("/api/integrations/databases", {
        key: "bad",
        repositories: ["no-such-repo"],
        host: "h",
        database_name: "d",
        username: "u",
        password: "p",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await admin("/api/integrations/databases", {
        key: "evil",
        project: "OMS",
        host: "h; rm -rf /",
        database_name: "d",
        username: "u",
        password: "p",
      })
    ).status,
    400,
  );
  // an update without a password keeps the stored one
  assert.equal(
    (
      await admin("/api/integrations/databases", {
        key: "oms-qc",
        project: "OMS",
        host: "oms-db.qc",
        database_name: "oms",
        username: "ro",
        description: "orders",
      })
    ).status,
    200,
  );
  const list = await admin("/api/integrations/databases");
  assert.doesNotMatch(list.text, /secret-/);
  assert.equal(list.body.find((d: any) => d.key === "oms-qc").has_password, true);
  assert.ok(
    await one(
      pool,
      "SELECT 1 FROM audit_log WHERE action = 'database.create' AND resource_id = 'payment-qc'",
    ),
  );
});

test("members see only databases their repository access covers; others see none", async () => {
  const a = (await A("/api/integrations/databases")).body.map((d: any) => d.key).sort();
  assert.deepEqual(a, ["oms-qc", "warranty-qc"]);
  assert.ok(
    !JSON.stringify((await A("/api/integrations/databases")).body).includes("oms-db.qc"),
    "members never see host or user",
  );
  assert.deepEqual((await B("/api/integrations/databases")).body, []);
});

test("agent tools: the run scope decides which database can be listed, described or queried", async () => {
  const calls: string[] = [];
  setDatabaseDriver(async (db, sql) => {
    calls.push(`${db.key}:${db.password}:${sql}`);
    return {
      columns: ["id", "password_hash", "note"],
      rows: [{ id: 1, password_hash: "$2y$10$abc", note: "x".repeat(1500) }],
      truncated: false,
    };
  });
  const omsRun = { runId: 1, allowedRepositories: ["oms-api"], mode: "analysis" as const };
  const listed = await callTool("database.list", {}, omsRun);
  assert.ok(listed.ok);
  assert.deepEqual(
    (listed.result as any[]).map((d) => d.key),
    ["oms-qc"],
    "warranty-qc needs warranty-api in scope; payment-qc needs a Payment repository",
  );
  assert.ok(!JSON.stringify(listed.result).includes("oms-db.qc"));
  const q = await callTool(
    "database.query",
    { database: "oms-qc", sql: "SELECT id, password_hash, note FROM users LIMIT 1" },
    omsRun,
  );
  assert.ok(q.ok, q.error ?? "");
  const r = q.result as any;
  assert.deepEqual(r.columns, ["id", "password_hash", "note"]);
  assert.equal(r.rows[0][1], "[masked]", "credential-like columns are masked");
  assert.ok(String(r.rows[0][2]).length < 1100, "long values are cut");
  assert.equal(
    calls.at(-1),
    "oms-qc:secret-oms-pw:SELECT id, password_hash, note FROM users LIMIT 1",
  );
  for (const [key, scope] of [
    ["payment-qc", ["oms-api"]],
    ["warranty-qc", ["oms-api"]],
    ["oms-qc", []],
    ["missing", ["oms-api"]],
  ] as const) {
    const refused = await callTool(
      "database.query",
      { database: key, sql: "SELECT 1" },
      { ...omsRun, allowedRepositories: [...scope] },
    );
    assert.equal(refused.ok, false, key);
    assert.match(refused.error!, /not available to this run/);
  }
  // the statement that runs is exactly the one that was checked, literals included (not the stripped copy)
  const literal = "SELECT id FROM orders WHERE code = 'ORD-1' AND note <> \"it's; DELETE\";";
  assert.ok((await callTool("database.query", { database: "oms-qc", sql: literal }, omsRun)).ok);
  assert.equal(calls.at(-1), `oms-qc:secret-oms-pw:${literal.slice(0, -1)}`);
  const write = await callTool(
    "database.query",
    { database: "oms-qc", sql: "DELETE FROM users" },
    omsRun,
  );
  assert.equal(write.ok, false);
  assert.match(write.error!, /only SELECT/);
  const warranty = await callTool(
    "database.list",
    {},
    { ...omsRun, allowedRepositories: ["warranty-api"] },
  );
  assert.ok(
    (warranty.result as any[]).some((d) => d.key === "warranty-qc"),
    "listed repositories bring a database into scope",
  );
  const disabled = await admin("/api/integrations/databases", {
    key: "oms-qc",
    project: "OMS",
    host: "oms-db.qc",
    database_name: "oms",
    username: "ro",
    enabled: false,
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await databasesForRun(["oms-api"]), []);
  await admin("/api/integrations/databases", {
    key: "oms-qc",
    project: "OMS",
    host: "oms-db.qc",
    database_name: "oms",
    username: "ro",
    enabled: true,
  });
  setDatabaseDriver(null);
});

test("status is the last real connection: tests and agent queries record it, members get no technical details", async () => {
  const status = async (key: string) =>
    (await one<any>(
      pool,
      "SELECT last_status, last_error_kind, last_error, last_used_at, last_version FROM project_databases WHERE key = $1",
      [key],
    ))!;
  // unreachable server
  setDatabaseDriver(async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:3306"), { code: "ECONNREFUSED" });
  });
  const down = (await admin("/api/integrations/databases/oms-qc/test", {})).body;
  assert.deepEqual(
    [down.ok, down.kind],
    [false, "unreachable"],
    "a failed connection is a result, not an HTTP error",
  );
  assert.equal((await status("oms-qc")).last_status, "failed");
  // wrong password
  setDatabaseDriver(async () => {
    throw Object.assign(new Error("Access denied for user 'ro'"), {
      code: "ER_ACCESS_DENIED_ERROR",
    });
  });
  assert.equal((await admin("/api/integrations/databases/oms-qc/test", {})).body.kind, "auth");
  const member = (await A("/api/integrations/databases")).body.find((d: any) => d.key === "oms-qc");
  assert.equal(member.last_status, "failed");
  assert.equal(member.last_error_kind, "auth");
  assert.equal(member.last_error, undefined, "raw errors stay with admins");
  assert.match(
    (await admin("/api/integrations/databases")).body.find((d: any) => d.key === "oms-qc")
      .last_error,
    /Access denied/,
  );
  // an SQL error proves the connection works
  setDatabaseDriver(async () => {
    throw Object.assign(new Error("Table 'oms.nope' doesn't exist"), { code: "ER_NO_SUCH_TABLE" });
  });
  const sqlErr = await callTool(
    "database.query",
    { database: "oms-qc", sql: "SELECT * FROM nope" },
    { runId: 1, allowedRepositories: ["oms-api"], mode: "analysis" },
  );
  assert.equal(sqlErr.ok, false);
  assert.equal((await status("oms-qc")).last_status, "ok");
  assert.ok((await status("oms-qc")).last_used_at, "agent use is recorded");
  // a successful test stores version and latency
  setDatabaseDriver(async (_db, sql) =>
    sql.startsWith("SHOW GRANTS")
      ? { columns: ["g"], rows: [{ g: "GRANT SELECT ON `oms`.* TO `ro`@`%`" }], truncated: false }
      : {
          columns: ["version", "account"],
          rows: [{ version: "10.7.8-MariaDB", account: "ro@%" }],
          truncated: false,
        },
  );
  const up = (await admin("/api/integrations/databases/oms-qc/test", {})).body;
  assert.deepEqual([up.ok, up.version, up.can_write], [true, "10.7.8-MariaDB", false]);
  const s2 = await status("oms-qc");
  assert.deepEqual(
    [s2.last_status, s2.last_error_kind, s2.last_error, s2.last_version],
    ["ok", null, null, "10.7.8-MariaDB"],
  );
  setDatabaseDriver(null);
});

test("deleting a database removes its stored password", async () => {
  await admin("/api/integrations/databases", {
    key: "temp-qc",
    project: "OMS",
    host: "t.qc",
    database_name: "t",
    username: "u",
    password: "temp-pw",
  });
  assert.ok(await one(pool, "SELECT 1 FROM shared_secrets WHERE kind = 'database:temp-qc'"));
  assert.equal((await admin("/api/integrations/databases/temp-qc/delete", {})).status, 200);
  assert.equal(
    await one(pool, "SELECT 1 FROM shared_secrets WHERE kind = 'database:temp-qc'"),
    undefined,
  );
  assert.equal((await admin("/api/integrations/databases/temp-qc/delete", {})).status, 404);
});

test("database results preserve literals, mask credentials, propagate caps and warn on write privileges", async () => {
  await saveDatabase({
    key: "fake-results", project: "OMS", host: "unused.invalid", database_name: "orders",
    username: "fixture", password: "fixture-only", max_rows: 5,
  }, ids["db-admin"]);
  const db = (await listDatabases()).find((d) => d.key === "fake-results")!;
  const statements: Array<{ sql: string; cap: number }> = [];
  let writable = false;
  setDatabaseDriver(async (_db, sql, cap) => {
    statements.push({ sql, cap });
    if (sql === "SHOW GRANTS") return {
      columns: ["grant"], rows: [{ grant: writable
        ? "GRANT SELECT, UPDATE ON orders.* TO fixture"
        : "GRANT SELECT ON orders.* TO fixture" }], truncated: false,
    };
    if (sql.startsWith("SELECT VERSION()")) return {
      columns: ["version", "account"], rows: [{ version: "fixture", account: "fixture@local" }], truncated: false,
    };
    if (sql === "SELECT * FROM no_such_table")
      throw Object.assign(new Error("Table does not exist"), { code: "ER_NO_SUCH_TABLE" });
    return {
      columns: ["id", "code", "api_token"],
      rows: [{ id: 7, code: "ORD7", api_token: "fixture-token" }], truncated: true,
    };
  });
  try {
    const result = await runQuery(db, "SELECT id, code, api_token FROM orders WHERE code = 'ORD7';", 50);
    assert.deepEqual(statements[0], {
      sql: "SELECT id, code, api_token FROM orders WHERE code = 'ORD7'", cap: 5,
    });
    assert.deepEqual(result.rows, [[7, "ORD7", "[masked]"]]);
    assert.equal(result.row_count, 1);
    assert.equal(result.truncated, true);
    const readOnly = await testDatabase(db.key);
    assert.equal(readOnly.ok, true);
    if (!readOnly.ok) throw new Error("fixture connection failed");
    assert.equal(readOnly.can_write, false);
    assert.equal(readOnly.warning, null);
    writable = true;
    const writeCapable = await testDatabase(db.key);
    assert.equal(writeCapable.ok, true);
    if (!writeCapable.ok) throw new Error("fixture connection failed");
    assert.equal(writeCapable.can_write, true);
    assert.match(writeCapable.warning!, /write privileges/);
    const callsBeforeWrite = statements.length;
    await assert.rejects(runQuery(db, "UPDATE orders SET code = 'X'"), /read|SELECT/i);
    assert.equal(statements.length, callsBeforeWrite, "writes never reach the driver");
    await assert.rejects(runQuery(db, "SELECT * FROM no_such_table"), /ER_NO_SUCH_TABLE/);
  } finally {
    setDatabaseDriver(null);
  }
});

test("the step prompt tells the agent which integrations THIS run can use, and which it cannot", async () => {
  const { integrationCatalog } = await import("../src/agent/toolRegistry.ts");
  const { buildSystemAppend } = await import("../src/agent/stepPrompt.ts");
  const oms = await integrationCatalog({ allowedRepositories: ["oms-api"], mode: "analysis" });
  const line = (key: string) => oms.available.find((l) => l.startsWith(`- ${key}:`));
  assert.ok(line("database"), JSON.stringify(oms));
  assert.match(line("database")!, /oms-qc \(OMS/);
  assert.doesNotMatch(
    line("database")!,
    /payment-qc|warranty-qc/,
    "only databases covered by this run's repositories",
  );
  assert.match(line("database")!, /database\.query/);
  // personal integrations that nobody connected in this test are listed as unusable, with the reason
  // (splunk_search stays available without a connection: it falls back to manual results pasted by the user)
  for (const f of ["kafka", "vault", "argocd"])
    assert.ok(
      oms.unavailable.some((u) => u.startsWith(`${f} (`)),
      `${f}: ${JSON.stringify(oms.unavailable)}`,
    );
  const none = await integrationCatalog({ allowedRepositories: [], mode: "analysis" });
  assert.ok(none.unavailable.some((u) => /^database \(no project QC database/.test(u)));

  const run: any = {
    id: 1,
    definition_key: "bug-investigation",
    output_locale: "en",
    allowed_repositories: ["oms-api"],
    selected_repositories: ["oms-api"],
    inputs: {},
    branch: "wf/x",
  };
  const step: any = { key: "analyze", name: "Analyze", type: "agent", config: {} };
  const ctx: any = { knowledge: [], repositories: [], repoPaths: [], upstream: [], fileRefs: [] };
  const prompt = buildSystemAppend(run, step, ctx, "analysis", oms);
  assert.match(prompt, /Integrations available to THIS run/);
  assert.match(prompt, /- database: project QC databases/);
  assert.match(prompt, /Not usable in this run: .*kafka \(Kafka UI not connected/);
  const generic = buildSystemAppend(run, step, ctx, "analysis");
  assert.match(
    generic,
    /Splunk, project QC databases, Kafka, Vault, Argo CD/,
    "without a catalog the section still names every integration",
  );
});
