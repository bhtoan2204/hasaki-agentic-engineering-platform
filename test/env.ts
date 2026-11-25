/**
 * Preloaded by every test run (`node --import ./test/env.ts --test`, and by test/setup.ts). Points config at a
 * temporary root and strips developer credentials BEFORE any platform module is imported (config and pool are
 * created at import time). DATABASE_URL names a socket that does not exist: unit tests never reach a database.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real system temp directory, fixed once for the whole run (nested test processes inherit it): the PostgreSQL test
// cluster lives there (test/pg-cluster.ts) and the orphan sweep scans it, whatever TMPDIR is redirected to below.
process.env.CTP_SYSTEM_TMPDIR ||= tmpdir();
const systemTmp = process.env.CTP_SYSTEM_TMPDIR;
export const root = mkdtempSync(join(systemTmp, "ctp-test-"));
mkdirSync(join(root, "repos"));
writeFileSync(join(root, ".owner-pid"), String(process.pid));

// /tmp is often a small tmpfs. Everything a test (or a process it starts) puts in os.tmpdir() lands inside this root,
// and the root is removed when the process exits (KEEP_TEST_ROOT=1 keeps it for debugging).
mkdirSync(join(root, "tmp"));
process.env.TMPDIR = join(root, "tmp");
const removeTree = (dir: string) => {
  // Go's module cache is read-only: make it writable first, or removal stops half-way.
  spawnSync("chmod", ["-R", "u+w", dir], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
};
if (process.env.KEEP_TEST_ROOT !== "1")
  process.once("exit", () => {
    try {
      removeTree(root);
    } catch {
      /* best effort: the next run's sweep removes it */
    }
  });

/**
 * Once per test run (the orchestrating `node --test` process, not each test file's process): remove temporary
 * directories left by killed test processes. Only this user's platform-owned prefixes; a directory is removed only when
 * the process that owns it (.owner-pid) is gone, or — unmarked, from older versions — when untouched for 24 h.
 */
function sweepOrphans() {
  const PREFIX = /^(?:ctp-test-|ctp-verification-cache-|ctp-mask-)/;
  const uid = process.getuid?.();
  for (const name of readdirSync(systemTmp)) {
    if (!PREFIX.test(name)) continue;
    const dir = join(systemTmp, name);
    if (dir === root) continue;
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || (uid != null && st.uid !== uid)) continue;
      let owner: number | null = null;
      try {
        owner = Number(readFileSync(join(dir, ".owner-pid"), "utf8")) || null;
      } catch {
        owner = null;
      }
      let alive = false;
      if (owner)
        try {
          process.kill(owner, 0);
          alive = true;
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      const stale = owner ? !alive : Date.now() - st.mtimeMs > 24 * 3_600_000;
      if (stale) removeTree(dir);
    } catch {
      /* another run removed it, or it is not ours */
    }
  }
}
if (!process.env.NODE_TEST_CONTEXT && process.env.KEEP_TEST_ROOT !== "1") sweepOrphans();
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
// Company endpoints come from .env in a real installation; tests use fixed placeholder domains, never the developer's.
process.env.FILE_BASE_URL = "https://hr-media.example.vn/production/hr";
process.env.BITBUCKET_WORKSPACE = "example-tech";
process.env.HASAKI_WORK_API_URL = "https://wshr.example.vn/api";
process.env.HASAKI_WORK_WEB_URL = "https://work.example.vn";
process.env.ARGOCD_BASE_URL = "https://argocd-qc-v2.example.dev";
process.env.VAULT_BASE_URL = "https://vault-qc-v2.example.dev";
process.env.KAFKA_BASE_URL = "https://kafka-ui-qc-v2.example.dev";
process.env.SPLUNK_BASE_URL = "https://siem.example.work";
process.env.PRODUCTION_DOMAINS = "example.vn";
delete process.env.NOTIFY_WEBHOOK;
// Budget limits from the developer shell would change cost assertions; tests set budgets explicitly.
for (const k of Object.keys(process.env)) if (k.startsWith("COST_BUDGET_")) delete process.env[k];
process.env.TEST_ROOT = root;
// Never reach a developer's running platform-go (default 127.0.0.1:4646) or reuse its token: suites that need the
// service start their own (test/fixtures/platformGo.ts), everything else sees it as unreachable.
process.env.RETRIEVAL_SEMANTIC_URL = "http://127.0.0.1:9";
delete process.env.RETRIEVAL_INTERNAL_TOKEN;
process.env.PLATFORM_DEPENDENCY_EVIDENCE_DIR = join(root, "data", "dependency-evidence");
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
// Go's build and module caches are content-addressed and safe to share: with a writable home, tests use the
// developer's (a fresh pair per test process re-downloaded and recompiled ~800 MB into the temporary root every
// time platform-go was built, and filled tmpfs). Only an unwritable home gets private caches.
if (!homeWritable) {
  const testGoCache = join(root, "gocache");
  mkdirSync(testGoCache, { recursive: true });
  process.env.GOCACHE = testGoCache;
  const testGoPath = join(root, "gopath");
  mkdirSync(testGoPath, { recursive: true });
  process.env.GOPATH = testGoPath;
}

// Mock claude, codex, and copilot CLIs in PATH so probeAgentHealth confirms readiness in test runs without remote auth.
const testBin = join(root, "bin");
mkdirSync(testBin, { recursive: true });
const claudeScript = join(testBin, "claude");
writeFileSync(
  claudeScript,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
if (args[0] === "--version") {
  console.log("2.0.0");
  process.exit(0);
}
console.log(JSON.stringify({ ok: true }));
`,
  { mode: 0o755 },
);

const fakeCodex = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const codexScript = join(testBin, "codex");
writeFileSync(
  codexScript,
  `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "--version") {
  console.log("codex-cli 0.164.0-fake");
  process.exit(0);
}
if (args[0] === "exec" && args.includes("--help")) {
  console.log("--json --strict-config --ignore-user-config --ignore-rules --dangerously-bypass-hook-trust --skip-git-repo-check --config --sandbox");
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "models") {
  console.log(JSON.stringify({
    models: [
      { slug: "gpt-test", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low" },
      { slug: "gpt-5-codex", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }], default_reasoning_level: "medium" }
    ]
  }));
  process.exit(0);
}
const res = spawnSync(process.execPath, [${JSON.stringify(fakeCodex)}, ...args], {
  stdio: "inherit",
  env: process.env,
});
process.exit(res.status ?? (res.error ? 1 : 0));
`,
  { mode: 0o755 },
);

const fakeCopilot = join(import.meta.dirname, "fixtures", "fake-copilot.mjs");
const copilotScript = join(testBin, "copilot");
writeFileSync(
  copilotScript,
  `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("GitHub Copilot CLI 1.0.0-fake");
  process.exit(0);
}
if (args.includes("--help") && !args.includes("-p") && !args.includes("--prompt")) {
  console.log("GitHub Copilot CLI 1.0.0-fake\\nOptions:\\n  -p, --prompt <text>\\n  --output-format <format>\\n  --model <model>\\n  --silent\\n  --reasoning-effort <level>\\n  --resume <id>\\n  --additional-mcp-config <json>\\n  --allow-all-tools\\n  --add-dir <path>\\n");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("gpt-4o\\no1-preview\\no1-mini\\nclaude-3.5-sonnet\\nclaude-3.5-haiku\\ngpt-4o-mini");
  process.exit(0);
}
const res = spawnSync(process.execPath, [${JSON.stringify(fakeCopilot)}, ...args], {
  stdio: "inherit",
  env: process.env,
});
process.exit(res.status ?? (res.error ? 1 : 0));
`,
  { mode: 0o755 },
);

process.env.PATH = `${testBin}:${process.env.PATH || ""}`;

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
