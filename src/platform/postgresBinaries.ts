import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { config } from "../config.ts";
import { TEST_POSTGRES_BIN_ENV } from "../workflow/templates.ts";

// Resolved in the platform process: inside bubblewrap nix cannot build (read-only `/`, unwritable HOME).
export type PostgresBin =
  { dir: string; source: "path" | "cache" | "nix" } | { dir: null; reason: string };

export interface NixResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface PostgresResolveOptions {
  pathEnv?: string;
  outLink?: string;
  nix?: (args: string[], timeoutMs: number) => Promise<NixResult>;
  timeoutMs?: number;
}

export const nixPostgresArgs = (outLink: string) => [
  "build",
  "--extra-experimental-features",
  "nix-command flakes",
  "--out-link",
  outLink,
  "--print-out-paths",
  "nixpkgs#postgresql_17",
];
export const NIX_RETRY_MS = 5 * 60_000;

const executable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const runNix = (args: string[], timeoutMs: number) =>
  new Promise<NixResult>((resolve) =>
    execFile(
      "nix",
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          error: error
            ? error.killed
              ? `timed out after ${Math.round(timeoutMs / 1000)}s`
              : error.message.split("\n")[0]
            : undefined,
        }),
    ),
  );

const tail = (text: string, max = 1200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? "…" + flat.slice(-max) : flat;
};

const outLinkOf = (opts: PostgresResolveOptions) =>
  opts.outLink ?? join(config.dataDir, "postgres-17");

function linkedBin(outLink: string): string | null {
  try {
    const dir = join(realpathSync(outLink), "bin");
    return executable(join(dir, "initdb")) ? dir : null;
  } catch {
    return null;
  }
}

export function installedPostgresBin(opts: PostgresResolveOptions = {}): PostgresBin | null {
  for (const dir of (opts.pathEnv ?? process.env.PATH ?? "").split(delimiter))
    if (dir && executable(join(dir, "initdb"))) return { dir, source: "path" };
  const linked = linkedBin(outLinkOf(opts));
  return linked ? { dir: linked, source: "cache" } : null;
}

export async function buildPostgresBin(opts: PostgresResolveOptions = {}): Promise<PostgresBin> {
  const outLink = outLinkOf(opts);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const r = await (opts.nix ?? runNix)(nixPostgresArgs(outLink), timeoutMs);
  if (r.code === 0) {
    const dir = linkedBin(outLink);
    if (dir) return { dir, source: "nix" };
    return {
      dir: null,
      reason: `nix build nixpkgs#postgresql_17 left no bin/initdb at ${outLink}: ${tail(r.stdout)}`,
    };
  }
  if (/ENOENT/.test(r.error ?? ""))
    return { dir: null, reason: "initdb is not on PATH and nix is not installed" };
  return {
    dir: null,
    reason: `initdb is not on PATH and nix build nixpkgs#postgresql_17 failed (${r.error ?? `exit ${r.code}`}): ${tail(r.stderr) || "no stderr"}`,
  };
}

let lastNix: { at: number; reason: string } | null = null;
let inflight: Promise<PostgresBin> | null = null;
let override: PostgresBin | undefined;

/** PATH and the out-link are re-checked on every call; only the nix build is throttled after a failure. */
export async function postgresBinDir(opts: PostgresResolveOptions = {}): Promise<PostgresBin> {
  if (override) return override;
  const found = installedPostgresBin(opts);
  if (found) return found;
  if (lastNix && Date.now() - lastNix.at < NIX_RETRY_MS)
    return {
      dir: null,
      reason: `${lastNix.reason} (last nix attempt at ${new Date(lastNix.at).toISOString()}; tried again ${NIX_RETRY_MS / 60_000} min later)`,
    };
  const at = Date.now();
  inflight ??= buildPostgresBin(opts)
    .then((r) => {
      lastNix = r.dir === null ? { at, reason: r.reason } : null;
      return r;
    })
    .finally(() => (inflight = null));
  return inflight;
}

export function setPostgresBinForTests(value: PostgresBin | undefined) {
  override = value;
  lastNix = null;
}

export function needsTestPostgres(cwd: string): boolean {
  try {
    return /\binitdb\b/.test(readFileSync(join(cwd, "test", "setup.ts"), "utf8"));
  } catch {
    return false;
  }
}

// null once `signal` aborts or `timeoutMs` passes; a nix build in progress keeps running for the next command.
export async function testPostgresEnv(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = Infinity,
): Promise<Record<string, string> | null> {
  if (!needsTestPostgres(cwd)) return {};
  if (signal?.aborted) return null;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const pg = await Promise.race([postgresBinDir(), stop]);
    if (!pg) return null;
    return pg.dir === null
      ? { PLATFORM_POSTGRES_UNAVAILABLE: pg.reason }
      : { [TEST_POSTGRES_BIN_ENV]: pg.dir };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
