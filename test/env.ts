/**
 * Preloaded by every test run (`node --import ./test/env.ts --test`, and by test/setup.ts). Points config at a
 * temporary root and strips developer credentials BEFORE any platform module is imported (config and pool are
 * created at import time). DATABASE_URL names a socket that does not exist: unit tests never reach a database.
 */
import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = mkdtempSync(join(tmpdir(), "ctp-test-"));
mkdirSync(join(root, "repos"));
export const cfgPath = join(root, "config.json");
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
process.env.DATABASE_URL = `postgres://platform_test@localhost/platform_test_unit?host=${encodeURIComponent(join(root, "no-postgres"))}`;
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

// Isolate test build caches and user home directory so subprocess tests (e.g. go test, git) do not fail when
// the execution environment lacks a writable $HOME or GOCACHE.
const testHome = join(root, "home");
mkdirSync(testHome, { recursive: true });
let homeWritable = false;
if (process.env.HOME) {
  try {
    accessSync(process.env.HOME, constants.W_OK);
    homeWritable = true;
  } catch {
    homeWritable = false;
  }
}
if (!homeWritable) {
  process.env.HOME = testHome;
}
const testGoCache = join(root, "gocache");
mkdirSync(testGoCache, { recursive: true });
process.env.GOCACHE = testGoCache;
const testGoPath = join(root, "gopath");
mkdirSync(testGoPath, { recursive: true });
process.env.GOPATH = testGoPath;

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

// Verification environments may set GIT_CONFIG_GLOBAL=/dev/null; commits made by tests still need an identity.
process.env.GIT_AUTHOR_NAME ||= "Test";
process.env.GIT_AUTHOR_EMAIL ||= "test@example.invalid";
process.env.GIT_COMMITTER_NAME ||= "Test";
process.env.GIT_COMMITTER_EMAIL ||= "test@example.invalid";
