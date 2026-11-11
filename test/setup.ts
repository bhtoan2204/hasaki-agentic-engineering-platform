/**
 * Preloaded with `node --import ./test/setup.ts --test`. Creates a uniquely named `platform_test_<uuid>` database on the
 * PostgreSQL from docker-compose (override with TEST_DATABASE_ADMIN_URL) and an isolated config, BEFORE any
 * platform module is imported (config and pool are created at import time).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const admin =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://platform:platform@localhost:55432/platform";
const adminUrl = new URL(admin);
if (!["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname))
  throw new Error("Tests require a local isolated PostgreSQL; remote database refused.");
const dbName = `platform_test_${randomUUID().replaceAll("-", "")}`;
if (!/^platform_test_[0-9a-f]+$/.test(dbName))
  throw new Error("Refusing unexpected test database name");

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

for (let attempt = 0; ; attempt++) {
  const client = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE ${dbName}`);
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
const u = new URL(admin);
u.pathname = "/" + dbName;
process.env.DATABASE_URL = u.toString();
process.env.PLATFORM_CONFIG = cfgPath;
process.env.PLATFORM_TEST = "1";
process.env.AUTH_SECRET = "test-auth-secret-not-for-production";
process.env.COOKIE_SECURE = "0";
delete process.env.NOTIFY_WEBHOOK;
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
])
  delete process.env[key];

// process.exit (including --test-force-exit) skips beforeExit, so drop from the exit hook.
process.on("exit", () => {
  spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import pg from "pg";
       const client = new pg.Client({ connectionString: process.env.TEST_SETUP_ADMIN, connectionTimeoutMillis: 5000 });
       await client.connect();
       await client.query("DROP DATABASE IF EXISTS " + process.env.TEST_SETUP_DB + " WITH (FORCE)");
       await client.end();`,
    ],
    {
      env: { ...process.env, TEST_SETUP_ADMIN: admin, TEST_SETUP_DB: dbName },
      timeout: 15000,
      stdio: "ignore",
    },
  );
});
