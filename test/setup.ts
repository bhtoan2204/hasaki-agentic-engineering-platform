/**
 * Preloaded with `node --import ./test/setup.ts --test`. Creates a uniquely named `platform_test_<uuid>` database on the
 * PostgreSQL from docker-compose (override with TEST_DATABASE_ADMIN_URL) and an isolated config, BEFORE any
 * platform module is imported (config and pool are created at import time).
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const admin =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://platform:platform@localhost:55432/platform";
const adminUrl = new URL(admin);
if (!["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname))
  throw new Error("Tests require a local isolated PostgreSQL; remote database refused.");
const dbName = `platform_test_${randomUUID().replaceAll("-", "")}`;
if (!/^platform_test_[0-9a-f]+$/.test(dbName))
  throw new Error("Refusing unexpected test database name");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = "platform_test_tpl";

function migrationChecksum() {
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const hash = createHash("sha256");
  for (const name of readdirSync(dir)
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest("hex");
}

/** These files apply a prefix of the migrations themselves and must start from an empty database. */
function needsEmptyDatabase() {
  return process.argv.some((arg) =>
    /(?:^|\/)(?:migrations|repository-remotes|bootstrap)\.test\.ts$/.test(arg),
  );
}

function retryable(error: unknown) {
  const err = error as { code?: string; message?: string };
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "40P01",
      "53300",
      "55006",
      "55P03",
      "57P03",
      "08000",
      "08001",
      "08006",
    ].includes(err.code ?? "")
  )
    return true;
  return /too many clients|being accessed by other users|deadlock|starting up|Connection terminated/i.test(
    err.message ?? "",
  );
}

const root = mkdtempSync(join(tmpdir(), "ctp-test-"));
mkdirSync(join(root, "repos"));
const cfgPath = join(root, "config.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    reposRoot: join(root, "repos"),
    dataDir: join(root, "data"),
    projects: { OMS: ["oms-api", "oms-background"], Payment: ["payment-src"] },
    scheduler: { workers: 1, leaseSeconds: 30, heartbeatSeconds: 5, pollMs: 50 },
    notifyWebhook: "",
  }),
);

if (!needsEmptyDatabase()) await ensureMigratedTemplate(migrationChecksum(), cfgPath);

for (let attempt = 0; ; attempt++) {
  const client = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query(
      needsEmptyDatabase()
        ? `CREATE DATABASE ${dbName}`
        : `CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE}`,
    );
    await client.end();
    break;
  } catch (error) {
    await client.end().catch(() => {});
    const code = (error as { code?: string }).code;
    if (code === "42P04") break;
    if (!retryable(error) || attempt >= 7) throw error;
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
}

async function ensureMigratedTemplate(checksum: string, configPath: string) {
  const client = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 5000 });
  await client.connect();
  await client.query("SELECT pg_advisory_lock(727002)");
  try {
    const current = await client.query(
      `SELECT pg_catalog.shobj_description(oid, 'pg_database') AS comment
       FROM pg_database WHERE datname = $1`,
      [TEMPLATE],
    );
    if (current.rows[0]?.comment === checksum) return;
    if (current.rowCount) await client.query(`DROP DATABASE ${TEMPLATE} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TEMPLATE}`);
    const url = new URL(admin);
    url.pathname = `/${TEMPLATE}`;
    const child = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `import { pool } from "./src/db/pool.ts";
import { migrate } from "./src/db/migrate.ts";
await migrate();
await pool.end();`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          PLATFORM_CONFIG: configPath,
          PLATFORM_TEST: "1",
          AUTH_SECRET: "test-auth-secret-not-for-production",
        },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`).catch(() => {});
      throw new Error(
        `test template migration failed (${child.status}): ${child.stderr || child.stdout}`,
      );
    }
    const comment = await client.query(
      "SELECT format('COMMENT ON DATABASE %I IS %L', $1::text, $2::text) AS sql",
      [TEMPLATE, checksum],
    );
    await client.query(comment.rows[0].sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(727002)").catch(() => {});
    await client.end().catch(() => {});
  }
}
const u = new URL(admin);
u.pathname = "/" + dbName;
process.env.DATABASE_URL = u.toString();
process.env.PLATFORM_CONFIG = cfgPath;
process.env.PLATFORM_TEST = "1";
process.env.AUTH_SECRET = "test-auth-secret-not-for-production";
process.env.COOKIE_SECURE = "0";
delete process.env.NOTIFY_WEBHOOK;
// Budget limits from the developer shell would change cost assertions; tests set budgets explicitly.
for (const k of Object.keys(process.env)) if (k.startsWith("COST_BUDGET_")) delete process.env[k];
process.env.TEST_ROOT = root;
mkdirSync(join(root, "empty-user-skills"));
process.env.CLAUDE_USER_SKILLS_DIR = join(root, "empty-user-skills"); // never read the developer's real ~/.claude

// Tests must never inherit a developer's live Telegram bot or receiver settings. Individual Telegram tests
// explicitly point config at their local mocked Bot API after the isolated database is ready.
for (const key of [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_MODE",
  "TELEGRAM_API_BASE",
  "TELEGRAM_WEBHOOK_URL",
  "TELEGRAM_WEBHOOK_SECRET",
  "BITBUCKET_USER",
  "BITBUCKET_TOKEN",
  "GITHUB_TOKEN",
  "HASAKI_WORK_BROWSER_MODE",
  "HASAKI_WORK_CHROME_PROFILE",
  "HASAKI_WORK_CHROME_PATH",
  "HASAKI_WORK_EXISTING_CHROME_USER",
  "PLATFORM_INSTANCE",
])
  delete process.env[key];

// Each file gets its own database. Drop it when the process is otherwise finished so catalogs do not
// accumulate (hundreds of leftover databases make the next CREATE DATABASE collide on template1).
let dropping = false;
process.on("beforeExit", () => {
  if (dropping) return;
  dropping = true;
  const client = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 5000 });
  void client
    .connect()
    .then(() => client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`))
    .then(() => client.end())
    .catch(() => client.end().catch(() => {}));
});
