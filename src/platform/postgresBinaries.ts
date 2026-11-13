import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { config } from "../config.ts";

/**
 * PostgreSQL binaries for a repository test harness that starts its own throwaway cluster (initdb/pg_ctl), resolved in
 * the platform process: commands may run inside bubblewrap, where nix cannot build (read-only `/`, unwritable HOME).
 */
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
  cacheFile?: string;
  nix?: (args: string[], timeoutMs: number) => Promise<NixResult>;
  timeoutMs?: number;
}

export const NIX_POSTGRES_ARGS = [
  "build",
  "--extra-experimental-features",
  "nix-command flakes",
  "--no-link",
  "--print-out-paths",
  "nixpkgs#postgresql_17",
];
const FAILURE_TTL_MS = 5 * 60_000;

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

/** 1) initdb on PATH, 2) cached nix store path, 3) `nix build nixpkgs#postgresql_17` (cached), otherwise the reason. */
export async function resolvePostgresBin(opts: PostgresResolveOptions = {}): Promise<PostgresBin> {
  for (const dir of (opts.pathEnv ?? process.env.PATH ?? "").split(delimiter))
    if (dir && executable(join(dir, "initdb"))) return { dir, source: "path" };
  const cacheFile = opts.cacheFile ?? join(config.dataDir, "postgres-bin.json");
  try {
    const cached = String(JSON.parse(readFileSync(cacheFile, "utf8")).dir ?? "");
    if (cached && executable(join(cached, "initdb"))) return { dir: cached, source: "cache" };
  } catch {
    /* no usable cache */
  }
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const r = await (opts.nix ?? runNix)(NIX_POSTGRES_ARGS, timeoutMs);
  if (r.code === 0) {
    const out = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((p) => p && existsSync(join(p, "bin", "initdb")));
    if (out) {
      const dir = join(out, "bin");
      try {
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify({ dir }));
      } catch {
        /* the next resolution builds again */
      }
      return { dir, source: "nix" };
    }
    return {
      dir: null,
      reason: `nix build nixpkgs#postgresql_17 printed no output with bin/initdb: ${tail(r.stdout)}`,
    };
  }
  if (/ENOENT/.test(r.error ?? ""))
    return { dir: null, reason: "initdb is not on PATH and nix is not installed" };
  return {
    dir: null,
    reason: `initdb is not on PATH and nix build nixpkgs#postgresql_17 failed (${r.error ?? `exit ${r.code}`}): ${tail(r.stderr) || "no stderr"}`,
  };
}

let memo: { at: number; value: PostgresBin } | null = null;
let inflight: Promise<PostgresBin> | null = null;
let override: PostgresBin | undefined;

/** Resolved once per process; a failure is retried after a few minutes, never on every command. */
export async function postgresBinDir(): Promise<PostgresBin> {
  if (override) return override;
  if (memo?.value.dir && executable(join(memo.value.dir, "initdb"))) return memo.value;
  if (memo && !memo.value.dir && Date.now() - memo.at < FAILURE_TTL_MS) return memo.value;
  inflight ??= resolvePostgresBin().finally(() => (inflight = null));
  const value = await inflight;
  memo = { at: Date.now(), value };
  return value;
}

/** `undefined` clears the override and the memo. */
export function setPostgresBinForTests(value: PostgresBin | undefined) {
  override = value;
  memo = null;
}

/** The repository's test preload starts its own PostgreSQL with initdb (this platform's test/setup.ts). */
export function needsTestPostgres(cwd: string): boolean {
  try {
    return /\binitdb\b/.test(readFileSync(join(cwd, "test", "setup.ts"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Environment additions for a command in `cwd`: the PostgreSQL bin dir in front of PATH, or
 * PLATFORM_POSTGRES_UNAVAILABLE with the reason, which the workflow test commands turn into a dedicated exit.
 */
export async function testPostgresEnv(
  cwd: string,
  basePath: string | undefined,
): Promise<Record<string, string>> {
  if (!needsTestPostgres(cwd)) return {};
  const pg = await postgresBinDir();
  if (pg.dir === null) return { PLATFORM_POSTGRES_UNAVAILABLE: pg.reason };
  if (pg.source === "path") return {};
  return { PATH: basePath ? `${pg.dir}${delimiter}${basePath}` : pg.dir };
}
