import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { canonicalizeDetectedUrl } from "../repos/remote.ts";

const exec = promisify(execFile);

/**
 * The checkout that is actually running this process. Workflows may read it and must not write it.
 * Identity is the package plus its git directory, not a hardcoded path.
 */
let liveRoot: string | null | undefined;
export function liveApplicationRoot(): string | null {
  if (liveRoot !== undefined) return liveRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && existsSync(join(dir, ".git"))) {
      try {
        const name = JSON.parse(readFileSync(pkg, "utf8")).name;
        if (name === "claude-task-platform") {
          liveRoot = realpathSync(dir);
          return liveRoot;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  liveRoot = null;
  return null;
}

export function resetSelfRepositoryCache() {
  detectedOriginCache = undefined;
  bwrapOverride = undefined;
  bwrapCached = undefined;
}

let detectedOriginCache: string | null | undefined;
async function detectedOrigin(): Promise<string | null> {
  if (detectedOriginCache !== undefined) return detectedOriginCache;
  const root = liveApplicationRoot();
  if (!root) {
    detectedOriginCache = null;
    return null;
  }
  try {
    const remote = (
      await exec(
        "git",
        [
          "-C",
          root,
          "-c",
          "core.hooksPath=/dev/null",
          "config",
          "--no-includes",
          "--get",
          "remote.origin.url",
        ],
        { timeout: 5000 },
      )
    ).stdout.trim();
    detectedOriginCache = canonicalizeDetectedUrl(remote);
  } catch {
    detectedOriginCache = null;
  }
  return detectedOriginCache;
}

/** Configured installation URL, otherwise the live checkout's origin. */
export async function installationRepositoryUrl(): Promise<string | null> {
  const configured = config.platform.repositoryUrl?.trim();
  if (configured) return canonicalizeDetectedUrl(configured);
  return detectedOrigin();
}

export async function isSelfRepository(repo: { repository_url?: string | null }): Promise<boolean> {
  if (!repo.repository_url) return false;
  const self = await installationRepositoryUrl();
  const url = canonicalizeDetectedUrl(repo.repository_url);
  return !!self && !!url && self === url;
}

/** True when `path` is the live checkout, is inside it, or contains it. Missing suffixes are planned paths. */
export function overlapsLiveApplication(path: string): boolean {
  const live = liveApplicationRoot();
  if (!live || !path) return false;
  const abs = resolve(path);
  if (abs === live || abs.startsWith(live + sep) || live.startsWith(abs + sep)) return true;
  let current = abs;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return false;
    suffix.unshift(basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    return false;
  }
  const full = suffix.length ? join(real, ...suffix) : real;
  return full === live || full.startsWith(live + sep) || live.startsWith(full + sep);
}

export function protectedRootsFor(paths: string[]): string[] {
  const live = liveApplicationRoot();
  return [...new Set([...paths.filter(Boolean), ...(live ? [live] : [])])];
}

/**
 * dataDir must sit outside the live checkout. Codex coding has no OS write sandbox; the tool-policy hook is its
 * write boundary. Other providers are enforced by tool policy only.
 */
export function assertSelfCodingIsolation(provider: string) {
  if (overlapsLiveApplication(config.dataDir))
    throw new Error(
      "Self-development is refused: dataDir overlaps the running application checkout. Move dataDir outside that tree.",
    );
  if (provider === "codex") return;
  if (config.platform.trustedOperatorIsolation) return;
  throw new Error(
    "Self-development coding with this provider is refused. Codex coding is allowed on this workstation without an OS sandbox. " +
      "Claude, Cursor and Antigravity are enforced by tool policy only. On a single-operator workstation set " +
      "platform.trustedOperatorIsolation (or PLATFORM_TRUSTED_OPERATOR_ISOLATION=1). Do not enable that for untrusted users.",
  );
}

let bwrapOverride: string | null | undefined;
let bwrapCached: string | null | undefined;
/** `undefined` clears the test override. `null` forces bubblewrap off. */
export function setBwrapForTests(path: string | null | undefined) {
  bwrapOverride = path;
  bwrapCached = undefined;
}

export async function bwrapAvailable(): Promise<string | null> {
  if (bwrapOverride !== undefined) return bwrapOverride;
  if (bwrapCached !== undefined) return bwrapCached;
  try {
    const found = (await exec("which", ["bwrap"], { timeout: 2000 })).stdout.trim();
    bwrapCached = found || null;
  } catch {
    bwrapCached = null;
  }
  return bwrapCached;
}

export function bwrapArguments(cwd: string, live: string | null): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--bind",
    cwd,
    cwd,
    "--bind",
    "/tmp",
    "/tmp",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    cwd,
  ];
  if (live) args.push("--ro-bind", live, live);
  return args;
}

const SECRET_ENV =
  /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|COOKIE|PRIVATE_KEY|_API_KEY|ACCESS_KEY_ID|CONNECTION_STRING|^PG|^DATABASE_URL$)/i;

/** Admin URL used only so the repository's own test/setup.ts can CREATE DATABASE. Never the application database. */
export function isolatedAdminUrl(): string {
  const raw = config.platform.testDatabaseAdminUrl?.trim() || config.databaseUrl;
  let admin: URL;
  let app: URL;
  try {
    admin = new URL(raw);
    app = new URL(config.databaseUrl);
  } catch {
    throw new Error("Self-development tests need a local PostgreSQL admin URL");
  }
  if (!config.platform.testDatabaseAdminUrl?.trim()) admin.pathname = "/postgres";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(admin.hostname))
    throw new Error(
      "Self-development tests require a local PostgreSQL admin URL; a remote database was refused",
    );
  const adminName = admin.pathname.replace(/^\//, "");
  const appName = app.pathname.replace(/^\//, "");
  if (!adminName || adminName === appName)
    throw new Error(
      "Self-development test admin URL must not name the application database. Set platform.testDatabaseAdminUrl to a local maintenance database.",
    );
  admin.search = "";
  admin.hash = "";
  return admin.toString();
}

export function selfTestEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const home = join(config.dataDir, "self-test-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    TMPDIR: "/tmp",
    TEST_DATABASE_ADMIN_URL: isolatedAdminUrl(),
    PLATFORM_SELF_TEST: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  // TLS-intercepting proxies (corporate WARP) need their CA, or npm/npx cannot reach the registry.
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
  for (const [key, value] of Object.entries(extra)) {
    if (!key || SECRET_ENV.test(key) || key.startsWith("PLATFORM_") || key.startsWith("GIT_"))
      continue;
    env[key] = value;
  }
  env.PLATFORM_SELF_TEST = "1";
  env.TEST_DATABASE_ADMIN_URL = isolatedAdminUrl();
  delete env.DATABASE_URL;
  delete env.AUTH_SECRET;
  return env;
}

async function originOf(cwd: string): Promise<string | null> {
  if (!existsSync(join(cwd, ".git"))) return null;
  try {
    const remote = (
      await exec(
        "git",
        [
          "-C",
          cwd,
          "-c",
          "core.hooksPath=/dev/null",
          "config",
          "--no-includes",
          "--get",
          "remote.origin.url",
        ],
        { timeout: 5000 },
      )
    ).stdout.trim();
    return canonicalizeDetectedUrl(remote);
  } catch {
    return null;
  }
}

export async function directoryIsSelfRepository(cwd: string): Promise<boolean> {
  const self = await installationRepositoryUrl();
  if (!self) return false;
  const origin = await originOf(cwd);
  return origin === self;
}

export interface CommandIsolation {
  env: NodeJS.ProcessEnv;
  /** Set when the cwd is this installation's own source. `replaceEnv` drops the worker environment. */
  isolation?: { replaceEnv: true; mode: "bwrap" | "trusted"; liveRoot: string | null };
}

/**
 * Commands in any other repository keep the worker environment. Commands in this installation's repository get a
 * scrubbed environment and, when bubblewrap is installed, an OS mount that makes the live checkout read-only.
 */
export async function commandProcessEnv(
  cwd: string,
  extra: Record<string, string>,
): Promise<CommandIsolation> {
  if (overlapsLiveApplication(cwd))
    throw new Error("Refusing to run a command in the running application checkout");
  if (!(await directoryIsSelfRepository(cwd))) return { env: { ...process.env, ...extra } };
  const bwrap = await bwrapAvailable();
  if (!bwrap && !config.platform.trustedOperatorIsolation)
    throw new Error(
      "Self-development commands need bubblewrap (bwrap), or platform.trustedOperatorIsolation on a single-operator workstation. " +
        "The application database and runtime secrets are not passed through either way. Without bubblewrap the command still runs as the worker user.",
    );
  return {
    env: selfTestEnvironment(extra),
    isolation: {
      replaceEnv: true,
      mode: bwrap ? "bwrap" : "trusted",
      liveRoot: liveApplicationRoot(),
    },
  };
}
