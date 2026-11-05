/**
 * Preloaded with `node --import ./test/setup.ts --test`. Creates a fresh `platform_test` database on the
 * PostgreSQL from docker-compose (override with TEST_DATABASE_ADMIN_URL) and an isolated config, BEFORE any
 * platform module is imported (config and pool are created at import time).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const admin = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://platform:platform@localhost:55432/platform";
const adminUrl = new URL(admin);
if (!["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname)) throw new Error("Tests require a local isolated PostgreSQL; remote database refused.");
const dbName = "platform_test";
const c = new pg.Client({ connectionString: admin });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${dbName}`);
await c.end();

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
