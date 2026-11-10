/**
 * Project QC databases (migration 046, src/integrations/database.ts): read-only statement check, run-scope
 * authorization through the agent tool registry, admin API, and — when TEST_MYSQL_HOST is set — a real MySQL/MariaDB.
 *
 *   docker run -d --name ctp-mariadb -e MARIADB_ROOT_PASSWORD=root -p 127.0.0.1:53306:3306 mariadb:10.7
 *   TEST_MYSQL_HOST=127.0.0.1 TEST_MYSQL_PORT=53306 TEST_MYSQL_ROOT_PASSWORD=root npm test
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
import { assertReadOnlySql, databasesForRun, runQuery, saveDatabase, setDatabaseDriver, testDatabase, listDatabases } from "../src/integrations/database.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

let server: Server;
let base = "";
type Call = (path: string, body?: unknown) => Promise<{ status: number; body: any; text: string }>;
let admin: Call, A: Call, B: Call;
const ids: Record<string, number> = {};

async function login(username: string, password: string): Promise<Call> {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { csrf } = await r.json();
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrf }) },
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
  for (const [u, role] of [["db-admin", "admin"], ["db-a", "member"], ["db-b", "member"]] as const)
    ids[u] = Number((await createUser({ username: u, password: `${u}-password`, role })).id);
  for (const [name, project] of [["oms-api", "OMS"], ["warranty-api", "OMS"], ["payment-core", "Payment"]])
    await repositories.upsert(name, { projects: [project] });
  // A: OMS repositories only. B: nothing.
  for (const name of ["oms-api", "warranty-api"]) await setRepositoryAccess((await repositories.get(name))!, ids["db-a"], "read", ids["db-admin"]);
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
  assert.equal((await A("/api/integrations/databases", { key: "x", project: "OMS", host: "h", database_name: "d", username: "u", password: "p" })).status, 403);
  const noPw = await admin("/api/integrations/databases", { key: "oms-qc", project: "OMS", host: "oms-db.qc", database_name: "oms", username: "ro" });
  assert.equal(noPw.status, 400);
  for (const body of [
    { key: "oms-qc", project: "OMS", host: "oms-db.qc", database_name: "oms", username: "ro", password: "secret-oms-pw", description: "orders, shipments" },
    { key: "warranty-qc", repositories: ["warranty-api"], host: "w-db.qc", database_name: "warranty", username: "ro", password: "secret-w-pw" },
    { key: "payment-qc", project: "Payment", host: "p-db.qc", database_name: "payment", username: "ro", password: "secret-p-pw" },
  ]) {
    const r = await admin("/api/integrations/databases", body);
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(r.text, /secret-/);
    assert.equal(r.body.has_password, true);
  }
  assert.equal((await admin("/api/integrations/databases", { key: "bad", repositories: ["no-such-repo"], host: "h", database_name: "d", username: "u", password: "p" })).status, 400);
  assert.equal((await admin("/api/integrations/databases", { key: "evil", project: "OMS", host: "h; rm -rf /", database_name: "d", username: "u", password: "p" })).status, 400);
  // an update without a password keeps the stored one
  assert.equal((await admin("/api/integrations/databases", { key: "oms-qc", project: "OMS", host: "oms-db.qc", database_name: "oms", username: "ro", description: "orders" })).status, 200);
  const list = await admin("/api/integrations/databases");
  assert.doesNotMatch(list.text, /secret-/);
  assert.equal(list.body.find((d: any) => d.key === "oms-qc").has_password, true);
  assert.ok(await one(pool, "SELECT 1 FROM audit_log WHERE action = 'database.create' AND resource_id = 'payment-qc'"));
});

test("members see only databases their repository access covers; others see none", async () => {
  const a = (await A("/api/integrations/databases")).body.map((d: any) => d.key).sort();
  assert.deepEqual(a, ["oms-qc", "warranty-qc"]);
  assert.ok(!JSON.stringify((await A("/api/integrations/databases")).body).includes("oms-db.qc"), "members never see host or user");
  assert.deepEqual((await B("/api/integrations/databases")).body, []);
});

test("agent tools: the run scope decides which database can be listed, described or queried", async () => {
  const calls: string[] = [];
  setDatabaseDriver(async (db, sql) => {
    calls.push(`${db.key}:${db.password}:${sql}`);
    return { columns: ["id", "password_hash", "note"], rows: [{ id: 1, password_hash: "$2y$10$abc", note: "x".repeat(1500) }], truncated: false };
  });
  const omsRun = { runId: 1, allowedRepositories: ["oms-api"], mode: "analysis" as const };
  const listed = await callTool("database.list", {}, omsRun);
  assert.ok(listed.ok);
  assert.deepEqual((listed.result as any[]).map((d) => d.key), ["oms-qc"], "warranty-qc needs warranty-api in scope; payment-qc needs a Payment repository");
  assert.ok(!JSON.stringify(listed.result).includes("oms-db.qc"));
  const q = await callTool("database.query", { database: "oms-qc", sql: "SELECT id, password_hash, note FROM users LIMIT 1" }, omsRun);
  assert.ok(q.ok, q.error ?? "");
  const r = q.result as any;
  assert.deepEqual(r.columns, ["id", "password_hash", "note"]);
  assert.equal(r.rows[0][1], "[masked]", "credential-like columns are masked");
  assert.ok(String(r.rows[0][2]).length < 1100, "long values are cut");
  assert.equal(calls.at(-1), "oms-qc:secret-oms-pw:SELECT id, password_hash, note FROM users LIMIT 1");
  for (const [key, scope] of [["payment-qc", ["oms-api"]], ["warranty-qc", ["oms-api"]], ["oms-qc", []], ["missing", ["oms-api"]]] as const) {
    const refused = await callTool("database.query", { database: key, sql: "SELECT 1" }, { ...omsRun, allowedRepositories: [...scope] });
    assert.equal(refused.ok, false, key);
    assert.match(refused.error!, /not available to this run/);
  }
  // the statement that runs is exactly the one that was checked, literals included (not the stripped copy)
  const literal = "SELECT id FROM orders WHERE code = 'ORD-1' AND note <> \"it's; DELETE\";";
  assert.ok((await callTool("database.query", { database: "oms-qc", sql: literal }, omsRun)).ok);
  assert.equal(calls.at(-1), `oms-qc:secret-oms-pw:${literal.slice(0, -1)}`);
  const write = await callTool("database.query", { database: "oms-qc", sql: "DELETE FROM users" }, omsRun);
  assert.equal(write.ok, false);
  assert.match(write.error!, /only SELECT/);
  const warranty = await callTool("database.list", {}, { ...omsRun, allowedRepositories: ["warranty-api"] });
  assert.ok((warranty.result as any[]).some((d) => d.key === "warranty-qc"), "listed repositories bring a database into scope");
  const disabled = await admin("/api/integrations/databases", { key: "oms-qc", project: "OMS", host: "oms-db.qc", database_name: "oms", username: "ro", enabled: false });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await databasesForRun(["oms-api"]), []);
  await admin("/api/integrations/databases", { key: "oms-qc", project: "OMS", host: "oms-db.qc", database_name: "oms", username: "ro", enabled: true });
  setDatabaseDriver(null);
});

test("status is the last real connection: tests and agent queries record it, members get no technical details", async () => {
  const status = async (key: string) => (await one<any>(pool, "SELECT last_status, last_error_kind, last_error, last_used_at, last_version FROM project_databases WHERE key = $1", [key]))!;
  // unreachable server
  setDatabaseDriver(async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:3306"), { code: "ECONNREFUSED" }); });
  const down = (await admin("/api/integrations/databases/oms-qc/test", {})).body;
  assert.deepEqual([down.ok, down.kind], [false, "unreachable"], "a failed connection is a result, not an HTTP error");
  assert.equal((await status("oms-qc")).last_status, "failed");
  // wrong password
  setDatabaseDriver(async () => { throw Object.assign(new Error("Access denied for user 'ro'"), { code: "ER_ACCESS_DENIED_ERROR" }); });
  assert.equal((await admin("/api/integrations/databases/oms-qc/test", {})).body.kind, "auth");
  const member = (await A("/api/integrations/databases")).body.find((d: any) => d.key === "oms-qc");
  assert.equal(member.last_status, "failed");
  assert.equal(member.last_error_kind, "auth");
  assert.equal(member.last_error, undefined, "raw errors stay with admins");
  assert.match((await admin("/api/integrations/databases")).body.find((d: any) => d.key === "oms-qc").last_error, /Access denied/);
  // an SQL error proves the connection works
  setDatabaseDriver(async () => { throw Object.assign(new Error("Table 'oms.nope' doesn't exist"), { code: "ER_NO_SUCH_TABLE" }); });
  const sqlErr = await callTool("database.query", { database: "oms-qc", sql: "SELECT * FROM nope" }, { runId: 1, allowedRepositories: ["oms-api"], mode: "analysis" });
  assert.equal(sqlErr.ok, false);
  assert.equal((await status("oms-qc")).last_status, "ok");
  assert.ok((await status("oms-qc")).last_used_at, "agent use is recorded");
  // a successful test stores version and latency
  setDatabaseDriver(async (_db, sql) => sql.startsWith("SHOW GRANTS")
    ? { columns: ["g"], rows: [{ g: "GRANT SELECT ON `oms`.* TO `ro`@`%`" }], truncated: false }
    : { columns: ["version", "account"], rows: [{ version: "10.7.8-MariaDB", account: "ro@%" }], truncated: false });
  const up = (await admin("/api/integrations/databases/oms-qc/test", {})).body;
  assert.deepEqual([up.ok, up.version, up.can_write], [true, "10.7.8-MariaDB", false]);
  const s2 = await status("oms-qc");
  assert.deepEqual([s2.last_status, s2.last_error_kind, s2.last_error, s2.last_version], ["ok", null, null, "10.7.8-MariaDB"]);
  setDatabaseDriver(null);
});

test("deleting a database removes its stored password", async () => {
  await admin("/api/integrations/databases", { key: "temp-qc", project: "OMS", host: "t.qc", database_name: "t", username: "u", password: "temp-pw" });
  assert.ok(await one(pool, "SELECT 1 FROM shared_secrets WHERE kind = 'database:temp-qc'"));
  assert.equal((await admin("/api/integrations/databases/temp-qc/delete", {})).status, 200);
  assert.equal(await one(pool, "SELECT 1 FROM shared_secrets WHERE kind = 'database:temp-qc'"), undefined);
  assert.equal((await admin("/api/integrations/databases/temp-qc/delete", {})).status, 404);
});

const live = process.env.TEST_MYSQL_HOST;
test("real MySQL/MariaDB: rows, cap, masking, READ ONLY transaction and the write-privilege warning", { skip: !live && "set TEST_MYSQL_HOST to run against a real server" }, async () => {
  const mysql = (await import("mysql2/promise")).default;
  const root = await mysql.createConnection({ host: live, port: Number(process.env.TEST_MYSQL_PORT ?? 3306), user: "root", password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "" });
  await root.query("DROP DATABASE IF EXISTS ctp_qc");
  await root.query("CREATE DATABASE ctp_qc");
  await root.query("CREATE TABLE ctp_qc.orders (id INT PRIMARY KEY, code VARCHAR(20), api_token VARCHAR(40), INDEX code_idx (code))");
  await root.query("INSERT INTO ctp_qc.orders VALUES " + Array.from({ length: 30 }, (_, i) => `(${i + 1}, 'ORD${i + 1}', 'tok-${i}')`).join(","));
  await root.query("DROP USER IF EXISTS 'ctp_ro'@'%'");
  await root.query("CREATE USER 'ctp_ro'@'%' IDENTIFIED BY 'ro-pw'");
  await root.query("GRANT SELECT ON ctp_qc.* TO 'ctp_ro'@'%'");
  await root.end();
  const port = Number(process.env.TEST_MYSQL_PORT ?? 3306);
  await saveDatabase({ key: "live-ro", project: "OMS", host: live, port, database_name: "ctp_qc", username: "ctp_ro", password: "ro-pw", max_rows: 5 }, ids["db-admin"]);
  await saveDatabase({ key: "live-root", project: "OMS", host: live, port, database_name: "ctp_qc", username: "root", password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "" }, ids["db-admin"]);
  const ro = (await listDatabases()).find((d) => d.key === "live-ro")!;
  const rootDb = (await listDatabases()).find((d) => d.key === "live-root")!;

  const one_ = await runQuery(ro, "SELECT code FROM orders WHERE code = 'ORD7'");
  assert.deepEqual(one_.rows, [["ORD7"]], "string literals reach the server unchanged");
  const r = await runQuery(ro, "SELECT id, code, api_token FROM orders ORDER BY id");
  assert.equal(r.row_count, 5);
  assert.equal(r.truncated, true, "stopped at the database row cap");
  assert.deepEqual(r.rows[0], [1, "ORD1", "[masked]"]);
  const schema = await callTool("database.schema", { database: "live-ro", table: "orders" }, { runId: 1, allowedRepositories: ["oms-api"], mode: "analysis" });
  assert.ok(schema.ok, schema.error ?? "");
  assert.deepEqual((schema.result as any).columns.map((c: any) => c.name), ["id", "code", "api_token"]);
  assert.ok((schema.result as any).indexes.some((i: any) => i.name === "code_idx"));
  const tables = await callTool("database.schema", { database: "live-ro" }, { runId: 1, allowedRepositories: ["oms-api"], mode: "analysis" });
  assert.deepEqual((tables.result as any).tables.map((t: any) => t.name), ["orders"]);

  // Second layer, as the driver uses it: inside START TRANSACTION READ ONLY the server refuses a write even for a
  // write-capable account, should a statement ever get past the parser.
  const c = await mysql.createConnection({ host: live, port, user: "root", password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "", database: "ctp_qc" });
  await c.query("START TRANSACTION READ ONLY");
  await assert.rejects(c.query("UPDATE orders SET code = 'X' WHERE id = 1"), /READ ONLY|read-only|1792/i);
  await c.query("ROLLBACK");
  await c.end();

  assert.equal(((await testDatabase("live-ro")) as any).can_write, false);
  const t = (await testDatabase("live-root")) as any;
  assert.equal(t.can_write, true);
  assert.match(t.warning!, /write privileges/);
  await assert.rejects(runQuery(rootDb, "SELECT * FROM no_such_table"), /ER_NO_SUCH_TABLE|doesn't exist/);
});
