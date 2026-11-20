/**
 * Read-only diagnostics for agent session storage: session count, logical size, allocated disk usage and file age,
 * overall and per provider.
 *
 * Sessions are counted from where each provider CLI actually keeps its transcripts, not from arbitrary directory
 * entries. Only filesystem metadata (lstat) is read: file contents are never opened, nothing is modified, and symbolic
 * links are never followed, neither while discovering directories nor while scanning them. A file or session reachable
 * through two paths (hard link, overlapping roots) is counted once.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool, q } from "../db/pool.ts";
import { formatBytes } from "../db/storageDiagnostics.ts";
import { AGENT_PROVIDERS, parseAgentProvider, type AgentProvider } from "./provider.ts";

export interface AgeBucket {
  count: number;
  disk_usage_bytes: number;
}

export interface FileAgeDistribution {
  under_24h: AgeBucket;
  "1d_to_7d": AgeBucket;
  "7d_to_30d": AgeBucket;
  "30d_to_90d": AgeBucket;
  over_90d: AgeBucket;
  oldest_file_timestamp: string | null;
  newest_file_timestamp: string | null;
}

export interface StorageUsage {
  session_count: number;
  file_count: number;
  /** Sum of file sizes (st_size). */
  logical_bytes: number;
  /** Blocks actually allocated on disk (st_blocks * 512): differs for sparse files and block rounding. */
  disk_usage_bytes: number;
  disk_usage: string;
  file_age_distribution: FileAgeDistribution;
}

export interface ProviderStorageUsage extends StorageUsage {
  available: boolean;
}

export type ScanStatus = "ok" | "missing" | "symlink" | "permission_denied" | "error";

export interface AgentSessionStorageDiagnostics extends StorageUsage {
  by_provider: Record<AgentProvider, ProviderStorageUsage>;
  scanned_directories: Array<{ path: string; provider: AgentProvider | null; status: ScanStatus }>;
  warnings: string[];
  /** Sessions recorded in agent_sessions; null when the database could not be queried. */
  database_sessions: { total: number; by_provider: Record<string, number> } | null;
  timestamp: string;
}

export interface SessionStorageDiagnosticsOptions {
  /** Platform data directory (defaults to config.dataDir). */
  dataDir?: string;
  /** Home of the platform process, where Claude keeps the completion sessions (defaults to os.homedir()). */
  homeDir?: string;
  /** Reference time for file ages (defaults to Date.now()). */
  now?: number;
  /** Also count agent_sessions rows (defaults to true). */
  includeDatabase?: boolean;
}

type Layout = Array<string | RegExp>;

/** Path from a provider's private HOME to its session entries: literal directory names, then name patterns. */
const SESSION_LAYOUTS: Record<AgentProvider, Layout> = {
  claude: [".claude", "projects", /./, /\.jsonl$/],
  codex: [".codex", "sessions", /^\d{4}$/, /^\d{2}$/, /^\d{2}$/, /^rollout-.*\.jsonl$/],
  copilot: [".copilot", "session-state", /./],
  cursor: [".cursor", "chats", /./, /./],
  antigravity: [".gemini", "antigravity-cli", "brain", /^[0-9a-f-]{36}$/],
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface ScanContext {
  now: number;
  warnings: Set<string>;
  dirs: Set<string>;
  files: Set<string>;
  sessions: Set<string>;
}

const emptyUsage = (): StorageUsage => ({
  session_count: 0,
  file_count: 0,
  logical_bytes: 0,
  disk_usage_bytes: 0,
  disk_usage: formatBytes(0),
  file_age_distribution: {
    under_24h: { count: 0, disk_usage_bytes: 0 },
    "1d_to_7d": { count: 0, disk_usage_bytes: 0 },
    "7d_to_30d": { count: 0, disk_usage_bytes: 0 },
    "30d_to_90d": { count: 0, disk_usage_bytes: 0 },
    over_90d: { count: 0, disk_usage_bytes: 0 },
    oldest_file_timestamp: null,
    newest_file_timestamp: null,
  },
});

const inode = (st: Stats) => `${st.dev}:${st.ino}`;

function errorStatus(e: unknown): ScanStatus {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "missing";
  return code === "EACCES" || code === "EPERM" ? "permission_denied" : "error";
}

/** Entries of a real directory; a symbolic link at `dir` itself is reported, never followed. */
async function listDir(
  dir: string,
  ctx: ScanContext,
): Promise<{ status: ScanStatus; entries: Dirent[]; st?: Stats }> {
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) return { status: "symlink", entries: [] };
    if (!st.isDirectory()) return { status: "error", entries: [] };
    return { status: "ok", entries: await readdir(dir, { withFileTypes: true }), st };
  } catch (e) {
    const status = errorStatus(e);
    if (status !== "missing") ctx.warnings.add(`${dir}: ${(e as Error).message}`);
    return { status, entries: [] };
  }
}

async function fileStat(path: string, ctx: ScanContext): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (e) {
    if (errorStatus(e) !== "missing") ctx.warnings.add(`${path}: ${(e as Error).message}`);
    return null;
  }
}

function addFile(usage: StorageUsage, st: Stats, now: number) {
  const disk = st.blocks * 512;
  const age = now - st.mtimeMs;
  const dist = usage.file_age_distribution;
  const bucket =
    dist[
      age < DAY_MS
        ? "under_24h"
        : age < 7 * DAY_MS
          ? "1d_to_7d"
          : age < 30 * DAY_MS
            ? "7d_to_30d"
            : age < 90 * DAY_MS
              ? "30d_to_90d"
              : "over_90d"
    ];
  usage.file_count++;
  usage.logical_bytes += st.size;
  usage.disk_usage_bytes += disk;
  bucket.count++;
  bucket.disk_usage_bytes += disk;
  const mtime = new Date(st.mtimeMs).toISOString();
  if (!dist.oldest_file_timestamp || mtime < dist.oldest_file_timestamp)
    dist.oldest_file_timestamp = mtime;
  if (!dist.newest_file_timestamp || mtime > dist.newest_file_timestamp)
    dist.newest_file_timestamp = mtime;
}

/** Adds every regular file under `dir` to `targets`, skipping symbolic links and anything already counted. */
async function walk(dir: string, targets: StorageUsage[], ctx: ScanContext): Promise<ScanStatus> {
  const { status, entries, st } = await listDir(dir, ctx);
  if (!st || ctx.dirs.has(inode(st))) return status;
  ctx.dirs.add(inode(st));
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) await walk(path, targets, ctx);
    else if (e.isFile()) {
      const fst = await fileStat(path, ctx);
      if (!fst?.isFile() || ctx.files.has(inode(fst))) continue;
      ctx.files.add(inode(fst));
      for (const t of targets) addFile(t, fst, ctx.now);
    }
  }
  return status;
}

async function countSessions(dir: string, layout: Layout, ctx: ScanContext): Promise<number> {
  const [segment, ...rest] = layout;
  let n = 0;
  for (const e of (await listDir(dir, ctx)).entries) {
    if (e.isSymbolicLink()) continue;
    if (typeof segment === "string" ? e.name !== segment : !segment.test(e.name)) continue;
    const path = join(dir, e.name);
    if (rest.length) {
      if (e.isDirectory()) n += await countSessions(path, rest, ctx);
      continue;
    }
    const st = await fileStat(path, ctx);
    if (!st || ctx.sessions.has(inode(st))) continue;
    ctx.sessions.add(inode(st));
    n++;
  }
  return n;
}

/** Claude Code keeps a working directory's sessions under ~/.claude/projects/<cwd with non-alphanumerics as "-">. */
async function claudeProjectDir(home: string, cwd: string) {
  const real = await realpath(cwd).catch(() => cwd);
  return join(home, ".claude", "projects", real.replace(/[^a-zA-Z0-9]/g, "-"));
}

export async function agentSessionStorageDiagnostics(
  options: SessionStorageDiagnosticsOptions = {},
): Promise<AgentSessionStorageDiagnostics> {
  const dataDir = options.dataDir ?? config.dataDir;
  const ctx: ScanContext = {
    now: options.now ?? Date.now(),
    warnings: new Set(),
    dirs: new Set(),
    files: new Set(),
    sessions: new Set(),
  };
  const total = emptyUsage();
  const byProvider = Object.fromEntries(
    AGENT_PROVIDERS.map((p) => [p, { available: false, ...emptyUsage() }]),
  ) as Record<AgentProvider, ProviderStorageUsage>;
  const scanned: AgentSessionStorageDiagnostics["scanned_directories"] = [];

  const scan = async (path: string, provider: AgentProvider, layout: Layout) => {
    const usage = byProvider[provider];
    const status = await walk(path, [usage, total], ctx);
    scanned.push({ path, provider, status });
    if (status !== "ok") return;
    usage.available = true;
    const sessions = await countSessions(path, layout, ctx);
    usage.session_count += sessions;
    total.session_count += sessions;
  };

  // Per-run private provider homes: dataDir/sandbox/run-<id>/<provider> (see prepareAgentSandbox).
  const sandbox = join(dataDir, "sandbox");
  const runs = await listDir(sandbox, ctx);
  scanned.push({ path: sandbox, provider: null, status: runs.status });
  for (const run of runs.entries) {
    if (!run.isDirectory() || !/^run-\d+$/.test(run.name)) continue;
    const runDir = join(sandbox, run.name);
    for (const e of (await listDir(runDir, ctx)).entries) {
      const provider = parseAgentProvider(e.name);
      if (!provider) continue;
      if (e.isDirectory()) await scan(join(runDir, e.name), provider, SESSION_LAYOUTS[provider]);
      else if (e.isSymbolicLink())
        scanned.push({ path: join(runDir, e.name), provider, status: "symlink" });
    }
  }

  // Kept chat completion sessions: Claude runs with cwd dataDir/completion-sessions under the platform's own HOME.
  await scan(
    await claudeProjectDir(options.homeDir ?? homedir(), join(dataDir, "completion-sessions")),
    "claude",
    [/\.jsonl$/],
  );

  let databaseSessions: AgentSessionStorageDiagnostics["database_sessions"] = null;
  if (options.includeDatabase !== false) {
    try {
      const rows = await q<{ provider: string; count: number }>(
        pool,
        "SELECT provider, count(*)::int AS count FROM agent_sessions GROUP BY provider",
      );
      databaseSessions = {
        total: rows.reduce((n, r) => n + r.count, 0),
        by_provider: Object.fromEntries(rows.map((r) => [r.provider, r.count])),
      };
    } catch (e) {
      ctx.warnings.add(`agent_sessions: ${(e as Error).message}`);
    }
  }

  for (const u of [total, ...Object.values(byProvider)])
    u.disk_usage = formatBytes(u.disk_usage_bytes);
  return {
    ...total,
    by_provider: byProvider,
    scanned_directories: scanned,
    warnings: [...ctx.warnings],
    database_sessions: databaseSessions,
    timestamp: new Date(ctx.now).toISOString(),
  };
}
