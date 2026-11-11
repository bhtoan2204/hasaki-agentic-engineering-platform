/**
 * Read-only QC databases per project (migration 046), queried by agents through the platform tool bridge (the per-run
 * MCP server: call_tool → database.list / database.schema / database.query) for every agent provider.
 *
 * Read-only is enforced three times:
 *   1. the statement: one statement, first keyword SELECT / SHOW / DESCRIBE / EXPLAIN / WITH, no write, lock, file,
 *      session or sleep keyword anywhere outside literals, no MySQL executable comments (`/*! … *\/`);
 *   2. the session: every call runs inside START TRANSACTION READ ONLY with a server-side statement timeout, on a
 *      fresh connection without multi-statements, and is rolled back;
 *   3. the account: use a database user with SELECT only — the connection test warns when it can write.
 * Results are bounded (rows, cell size), binary values summarized, and credential-like columns masked.
 *
 * Who may query: the calling run's repository scope (already limited to the owner's current repository access and
 * re-checked on every tool call) must contain one of the database's `repositories`, or a repository mapped to its
 * `project`. The password lives only in shared_secrets ('database:<key>').
 */
import { z } from "zod";
import { pool, q, one } from "../db/pool.ts";
import { CacheAside } from "../cache/index.ts";
import { getSharedSecret, putSharedSecret } from "../auth/secrets.ts";
import { redactSecrets } from "./redact.ts";
import { HttpError } from "../http/error.ts";
import { repositories } from "../repos/service.ts";

export interface ProjectDatabase {
  id: number;
  key: string;
  project: string;
  repositories: string[];
  environment: "qc" | "dev" | "staging";
  engine: "mysql";
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl: boolean;
  description: string;
  max_rows: number;
  timeout_ms: number;
  enabled: boolean;
  updated_at?: string;
  last_status?: "ok" | "failed" | null;
  last_checked_at?: string | null;
  last_error_kind?: ErrorKind | null;
  last_error?: string | null;
  last_version?: string | null;
  last_account?: string | null;
  last_can_write?: boolean | null;
  last_latency_ms?: number | null;
  last_used_at?: string | null;
}

/**
 * Why a connection failed, in words a person can act on. Only connection-level failures count: a SQL error (unknown
 * column, syntax) means the database is reachable.
 */
export type ErrorKind =
  | "unreachable"
  | "timeout"
  | "auth"
  | "database"
  | "tls"
  | "no_password"
  | "unknown";
const CONNECTION_ERRORS: Record<string, ErrorKind> = {
  ECONNREFUSED: "unreachable",
  ENOTFOUND: "unreachable",
  EHOSTUNREACH: "unreachable",
  ENETUNREACH: "unreachable",
  EAI_AGAIN: "unreachable",
  ECONNRESET: "unreachable",
  PROTOCOL_CONNECTION_LOST: "unreachable",
  ETIMEDOUT: "timeout",
  PROTOCOL_SEQUENCE_TIMEOUT: "timeout",
  ER_ACCESS_DENIED_ERROR: "auth",
  ER_DBACCESS_DENIED_ERROR: "auth",
  ER_NOT_SUPPORTED_AUTH_MODE: "auth",
  ER_BAD_DB_ERROR: "database",
  HANDSHAKE_SSL_ERROR: "tls",
  HANDSHAKE_NO_SSL_SUPPORT: "tls",
};
export const connectionErrorKind = (code?: string): ErrorKind | null =>
  code ? (CONNECTION_ERRORS[code] ?? (/SSL|TLS|CERT/.test(code) ? "tls" : null)) : null;

/** Persist the last known status. Successful agent queries are recorded at most once a minute per database. */
async function recordStatus(
  key: string,
  s:
    | {
        ok: true;
        latency?: number;
        version?: string;
        account?: string;
        can_write?: boolean | null;
        used?: boolean;
      }
    | { ok: false; kind: ErrorKind; error: string },
) {
  if (s.ok)
    await q(
      pool,
      `UPDATE project_databases SET last_status = 'ok', last_checked_at = now(), last_error_kind = NULL, last_error = NULL,
         last_latency_ms = COALESCE($2, last_latency_ms), last_version = COALESCE($3, last_version), last_account = COALESCE($4, last_account),
         last_can_write = CASE WHEN $6 THEN $5 ELSE last_can_write END, last_used_at = CASE WHEN $7 THEN now() ELSE last_used_at END
       WHERE key = $1 AND ($7 = false OR last_status IS DISTINCT FROM 'ok' OR last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [
        key,
        s.latency ?? null,
        s.version ?? null,
        s.account ?? null,
        s.can_write ?? null,
        s.can_write !== undefined,
        !!s.used,
      ],
    ).catch(() => {});
  else
    await q(
      pool,
      "UPDATE project_databases SET last_status = 'failed', last_checked_at = now(), last_error_kind = $2, last_error = $3 WHERE key = $1",
      [key, s.kind, s.error.slice(0, 500)],
    ).catch(() => {});
}

const secretKind = (key: string) => `database:${key}`;
const cache = new CacheAside<ProjectDatabase[]>(
  "project_databases",
  ["project_databases"],
  60_000,
  1,
);
export const listDatabases = () =>
  cache.get("all", () => q<ProjectDatabase>(pool, "SELECT * FROM project_databases ORDER BY key"));

// ---------------------------------------------------------------- administration

const Host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, "host name or IP address only");
export const DatabaseInput = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "lower-case letters, digits, - and _"),
    project: z.string().trim().max(100).default(""),
    repositories: z
      .array(z.string().regex(/^[A-Za-z0-9._-]+$/))
      .max(50)
      .default([]),
    environment: z.enum(["qc", "dev", "staging"]).default("qc"),
    engine: z.literal("mysql").default("mysql"),
    host: Host,
    port: z.number().int().min(1).max(65535).default(3306),
    database_name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_$-]+$/),
    username: z.string().trim().min(1).max(80),
    password: z.string().max(500).optional(),
    ssl: z.boolean().default(false),
    description: z.string().max(1000).default(""),
    max_rows: z.number().int().min(1).max(1000).default(200),
    timeout_ms: z.number().int().min(1000).max(120000).default(15000),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine(
    (d) => d.project.trim() !== "" || d.repositories.length > 0,
    "set a project or at least one repository",
  );

/** Create or replace a database. The password is kept when omitted on an update; required on creation. */
export async function saveDatabase(input: unknown, actorId: number) {
  const d = DatabaseInput.parse(input);
  const existing = await one<ProjectDatabase>(
    pool,
    "SELECT * FROM project_databases WHERE key = $1",
    [d.key],
  );
  if (!existing && !d.password) throw new HttpError(400, "password is required for a new database");
  const known = new Set((await repositories.list()).map((r) => r.name));
  const unknown = d.repositories.filter((r) => !known.has(r));
  if (unknown.length) throw new HttpError(400, `unknown repositories: ${unknown.join(", ")}`);
  await q(
    pool,
    `INSERT INTO project_databases (key, project, repositories, environment, engine, host, port, database_name, username, ssl, description, max_rows, timeout_ms, enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (key) DO UPDATE SET project=EXCLUDED.project, repositories=EXCLUDED.repositories, environment=EXCLUDED.environment,
       engine=EXCLUDED.engine, host=EXCLUDED.host, port=EXCLUDED.port, database_name=EXCLUDED.database_name, username=EXCLUDED.username,
       ssl=EXCLUDED.ssl, description=EXCLUDED.description, max_rows=EXCLUDED.max_rows, timeout_ms=EXCLUDED.timeout_ms,
       enabled=EXCLUDED.enabled, updated_at=now()`,
    [
      d.key,
      d.project.trim(),
      d.repositories,
      d.environment,
      d.engine,
      d.host,
      d.port,
      d.database_name,
      d.username,
      d.ssl,
      d.description,
      d.max_rows,
      d.timeout_ms,
      d.enabled,
      actorId,
    ],
  );
  if (d.password) await putSharedSecret(secretKind(d.key), d.password);
  return { ...(await publicDatabase(d.key)), created: !existing };
}

export async function deleteDatabase(key: string) {
  const r = await q(pool, "DELETE FROM project_databases WHERE key = $1 RETURNING id", [key]);
  await q(pool, "DELETE FROM shared_secrets WHERE kind = $1", [secretKind(key)]);
  return r.length > 0;
}

/** Without the password; `has_password` tells whether one is stored. */
export async function publicDatabase(key: string) {
  const d = (await listDatabases()).find((x) => x.key === key);
  if (!d) throw new HttpError(404, "database not found");
  return { ...d, has_password: !!(await getSharedSecret(secretKind(key))) };
}
export async function publicDatabases() {
  return Promise.all((await listDatabases()).map((d) => publicDatabase(d.key)));
}

// ---------------------------------------------------------------- read-only statement check

const FIRST = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH"]);
const FORBIDDEN = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",
  "UPSERT",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
  "LOCK",
  "UNLOCK",
  "CALL",
  "DO",
  "HANDLER",
  "LOAD",
  "SET",
  "INTO",
  "OUTFILE",
  "DUMPFILE",
  "PREPARE",
  "EXECUTE",
  "DEALLOCATE",
  "KILL",
  "SHUTDOWN",
  "FLUSH",
  "RESET",
  "PURGE",
  "INSTALL",
  "UNINSTALL",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "START",
  "SAVEPOINT",
  "RELEASE",
  "XA",
  "OPTIMIZE",
  "REPAIR",
  "SLEEP",
  "BENCHMARK",
  "GET_LOCK",
  "RELEASE_LOCK",
  "RELEASE_ALL_LOCKS",
  "LOAD_FILE",
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join("|")})\\b`, "i");

/**
 * Checks a copy with literals, quoted identifiers and comments removed; throws on anything that is not a single read
 * statement. Returns the ORIGINAL statement (trimmed, without a trailing semicolon) — the one that is executed.
 */
export function assertReadOnlySql(sql: string): string {
  if (typeof sql !== "string" || !sql.trim()) throw new HttpError(400, "empty statement");
  if (sql.length > 20_000) throw new HttpError(400, "statement too long (20,000 characters max)");
  if (/\/\*!/.test(sql))
    throw new HttpError(400, "MySQL executable comments (/*! … */) are not allowed");
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i],
      n = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      // literal or quoted identifier: skip to the matching quote (doubled quote and backslash escapes)
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === "\\" && c !== "`") {
          j++;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j++;
            continue;
          }
          break;
        }
      }
      if (j >= sql.length) throw new HttpError(400, "unterminated quote");
      out += c === "`" ? " ident " : " 'lit' ";
      i = j + 1;
    } else if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new HttpError(400, "unterminated comment");
      out += " ";
      i = end + 2;
    } else if ((c === "-" && n === "-" && /\s/.test(sql[i + 2] ?? " ")) || c === "#") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  const body = out.trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw new HttpError(400, "only one statement per call");
  const first = body.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (!first || !FIRST.has(first))
    throw new HttpError(
      400,
      "only SELECT, SHOW, DESCRIBE, EXPLAIN or WITH … SELECT statements are allowed",
    );
  const bad = body.match(FORBIDDEN_RE);
  if (bad)
    throw new HttpError(
      400,
      `"${bad[1].toUpperCase()}" is not allowed: this database is read-only for agents`,
    );
  if (/@@|@[A-Za-z_]/.test(body)) throw new HttpError(400, "session variables are not allowed");
  return sql.trim().replace(/;\s*$/, "");
}

// ---------------------------------------------------------------- execution

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  ms: number;
};
type Connection = { password: string } & ProjectDatabase;
type Driver = (
  db: Connection,
  sql: string,
  maxRows: number,
) => Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }>;

/** mysql2 on a fresh connection: READ ONLY transaction, server-side timeout, streamed rows stopped at the cap. */
const mysqlDriver: Driver = async (db, sql, maxRows) => {
  const mysql = (await import("mysql2")).default;
  const conn = mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.username,
    password: db.password,
    database: db.database_name,
    ssl: db.ssl ? {} : undefined,
    connectTimeout: Math.min(db.timeout_ms, 10_000),
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  // A dropped or destroyed connection emits "error": without a listener that would crash the whole server.
  conn.on("error", () => {});
  const run = (s: string) =>
    new Promise<void>((res, rej) => conn.query(s, (e: unknown) => (e ? rej(e) : res())));
  try {
    await new Promise<void>((res, rej) => conn.connect((e: unknown) => (e ? rej(e) : res())));
    // MySQL (milliseconds, SELECT only) and MariaDB (seconds) name the statement timeout differently.
    await run(`SET SESSION MAX_EXECUTION_TIME = ${Math.floor(db.timeout_ms)}`).catch(() => {});
    await run(`SET SESSION max_statement_time = ${Math.ceil(db.timeout_ms / 1000)}`).catch(
      () => {},
    );
    await run("START TRANSACTION READ ONLY");
    return await new Promise((res, rej) => {
      const rows: Record<string, unknown>[] = [];
      let columns: string[] = [];
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        res({ columns, rows, truncated });
      };
      const query = conn.query({ sql, timeout: db.timeout_ms });
      query
        .on("fields", (f: Array<{ name: string }>) => (columns = (f ?? []).map((x) => x.name)))
        .on("result", (row: any) => {
          if (done) return;
          if (rows.length >= maxRows) {
            // Enough: stop reading instead of buffering the rest of a large result.
            conn.destroy();
            return finish(true);
          }
          rows.push(row);
        })
        .on("error", (e: unknown) => (done ? undefined : ((done = true), rej(e))))
        .on("end", () => finish(false));
    });
  } finally {
    // Rolled back (a read-only transaction has nothing to commit) and closed; a destroyed connection is just closed.
    try {
      conn.query("ROLLBACK", () => conn.end(() => {}));
    } catch {
      conn.destroy();
    }
  }
};

let driver: Driver = mysqlDriver;
/** Test seam. */
export function setDatabaseDriver(d: Driver | null) {
  driver = d ?? mysqlDriver;
}

const SENSITIVE =
  /(pass(word|wd)?|secret|token|api_?key|private_?key|otp|cvv|card_?(number|no)|pin_?code|salt|hash)$/i;
function cell(column: string, v: unknown): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean")
    return SENSITIVE.test(column) && v != null ? "[masked]" : v;
  if (SENSITIVE.test(column)) return "[masked]";
  if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const red = redactSecrets(s);
  return red.length > 1000 ? red.slice(0, 1000) + `… (${red.length - 1000} more chars)` : red;
}

async function connectionOf(db: ProjectDatabase): Promise<Connection> {
  const password = await getSharedSecret(secretKind(db.key));
  if (password == null) throw new HttpError(409, `database "${db.key}" has no stored password`);
  return { ...db, password };
}

export async function runQuery(
  db: ProjectDatabase,
  sql: string,
  maxRows?: number,
  options: { used?: boolean } = { used: true },
): Promise<QueryResult> {
  const statement = assertReadOnlySql(sql);
  const cap = Math.max(1, Math.min(maxRows ?? db.max_rows, db.max_rows));
  const t0 = Date.now();
  let r;
  try {
    r = await driver(await connectionOf(db), statement, cap);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 409)
        await recordStatus(db.key, { ok: false, kind: "no_password", error: e.message });
      throw e;
    }
    // Driver errors carry the server message (useful: unknown column…) but never the connection settings.
    const err = e as { code?: string; sqlMessage?: string; message?: string };
    const message = redactSecrets(String(err.sqlMessage ?? err.message ?? e)).slice(0, 500);
    const kind = connectionErrorKind(err.code);
    await recordStatus(
      db.key,
      kind
        ? { ok: false, kind, error: `${err.code}: ${message}` }
        : { ok: true, used: options.used },
    );
    throw new Error(`database ${db.key}: ${err.code ?? "error"}: ${message}`);
  }
  await recordStatus(db.key, { ok: true, latency: Date.now() - t0, used: options.used });
  const columns = r.columns.length ? r.columns : Object.keys(r.rows[0] ?? {});
  return {
    columns,
    rows: r.rows.map((row) => columns.map((c) => cell(c, row[c]))),
    row_count: r.rows.length,
    truncated: r.truncated,
    ms: Date.now() - t0,
  };
}

/** Schema without reading data: tables of the database, or the columns and indexes of one table. */
export async function describeSchema(db: ProjectDatabase, table?: string) {
  if (!table) {
    const r = await runQuery(
      db,
      `SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
      1000,
    );
    return {
      database: db.key,
      tables: r.rows.map(([name, rows, comment]) => ({ name, approx_rows: rows, comment })),
      truncated: r.truncated,
    };
  }
  if (!/^[A-Za-z0-9_$]{1,64}$/.test(table)) throw new HttpError(400, "invalid table name");
  const columns = await runQuery(
    db,
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`,
    1000,
  );
  if (!columns.rows.length) throw new HttpError(404, `table "${table}" not found in ${db.key}`);
  const indexes = await runQuery(
    db,
    `SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS COLUMNS FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' GROUP BY INDEX_NAME, NON_UNIQUE`,
    200,
  );
  return {
    database: db.key,
    table,
    columns: columns.rows.map(([name, type, nullable, key, dflt, comment]) => ({
      name,
      type,
      nullable: nullable === "YES",
      key,
      default: dflt,
      comment,
    })),
    indexes: indexes.rows.map(([name, nonUnique, cols]) => ({
      name,
      unique: String(nonUnique) === "0",
      columns: String(cols).split(","),
    })),
  };
}

/**
 * Connection test (admin): server version, account, latency and whether the account can write. A failure is a result
 * (ok: false, kind, error), not an exception, and is stored as the database's status either way.
 */
export async function testDatabase(key: string) {
  const db = (await listDatabases()).find((d) => d.key === key);
  if (!db) throw new HttpError(404, "database not found");
  const t0 = Date.now();
  try {
    const version = await runQuery(
      db,
      "SELECT VERSION() AS version, CURRENT_USER() AS account",
      1,
      { used: false },
    );
    const latency = Date.now() - t0;
    const grants = await runQuery(db, "SHOW GRANTS", 100, { used: false }).catch(() => null);
    const text = grants ? grants.rows.map((r) => String(r[0])).join("\n") : "";
    const can_write = grants
      ? /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(text)
      : null;
    const result = {
      ok: true as const,
      version: String(version.rows[0]?.[0] ?? ""),
      account: String(version.rows[0]?.[1] ?? ""),
      latency_ms: latency,
      can_write,
    };
    await recordStatus(key, {
      ok: true,
      latency,
      version: result.version,
      account: result.account,
      can_write,
    });
    return {
      ...result,
      warning: can_write
        ? "This account has write privileges. Agents are limited to read statements in read-only transactions, but a SELECT-only database user is safer."
        : null,
    };
  } catch (e) {
    const fresh = (
      await q<ProjectDatabase>(pool, "SELECT * FROM project_databases WHERE key = $1", [key])
    )[0];
    return {
      ok: false as const,
      kind: (fresh?.last_error_kind ?? "unknown") as ErrorKind,
      error: fresh?.last_error ?? (e as Error).message,
      latency_ms: Date.now() - t0,
    };
  }
}

// ---------------------------------------------------------------- run authorization

/** Databases a run may query: its repository scope contains one of their repositories, or a repository of their project. */
export async function databasesForRun(allowedRepositories: string[]) {
  if (!allowedRepositories.length) return [];
  const registry = await repositories.list();
  const inScope = new Set(allowedRepositories);
  const projectsInScope = new Set(
    registry
      .filter((r) => inScope.has(r.name))
      .flatMap((r) => r.projects.map((p) => p.toLowerCase())),
  );
  return (await listDatabases()).filter(
    (d) =>
      d.enabled &&
      (d.repositories.some((r) => inScope.has(r)) ||
        (d.project !== "" && projectsInScope.has(d.project.toLowerCase()))),
  );
}

export async function databaseForRun(key: string, allowedRepositories: string[]) {
  const d = (await databasesForRun(allowedRepositories)).find((x) => x.key === key);
  // Same answer for unknown and not permitted: the existence of other projects' databases is not revealed.
  if (!d) throw new Error(`database "${key}" is not available to this run — use database.list`);
  return d;
}
