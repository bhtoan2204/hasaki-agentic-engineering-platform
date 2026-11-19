/**
 * Read-only diagnostics for agent session storage.
 *
 * Reports:
 * - Session count
 * - Total disk usage (bytes and human-readable)
 * - File age distribution across standardized time buckets
 * - Storage usage broken down by provider where available
 *
 * Safety guarantees:
 * - Read-only: never deletes files, never alters session lifecycle or permissions.
 * - Missing directories, permission errors (EACCES/EPERM) and broken/cyclic symlinks are handled safely without throwing.
 * - Symbolic links are never followed into directory cycles or external escaping paths.
 * - Session contents and credentials are never opened, read or exposed; only filesystem metadata (size, mtime) is collected.
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";

export interface FileAgeBucket {
  count: number;
  bytes: number;
}

export interface FileAgeDistribution {
  /** Files modified in the last 24 hours (< 1 day) */
  under_24h: FileAgeBucket;
  /** Files modified between 1 day and 7 days ago */
  "1d_to_7d": FileAgeBucket;
  /** Files modified between 7 days and 30 days ago */
  "7d_to_30d": FileAgeBucket;
  /** Files modified between 30 days and 90 days ago */
  "30d_to_90d": FileAgeBucket;
  /** Files modified more than 90 days ago */
  over_90d: FileAgeBucket;
  /** Human-readable bucket labels matching the above */
  buckets: Record<string, FileAgeBucket>;
  total_files: number;
  total_bytes: number;
  oldest_file_age_days: number | null;
  newest_file_age_days: number | null;
  oldest_file_timestamp: string | null;
  newest_file_timestamp: string | null;
}

export interface ProviderStorageUsage {
  provider: AgentProvider | string;
  available: boolean;
  session_count: number;
  file_count: number;
  disk_usage_bytes: number;
  disk_usage_human: string;
  directories: string[];
  file_age_distribution: FileAgeDistribution;
  warnings?: string[];
}

export interface ScannedDirectoryInfo {
  path: string;
  exists: boolean;
  provider?: string | null;
  session_count: number;
  file_count: number;
  bytes: number;
  status: "ok" | "missing" | "permission_denied" | "error";
  error?: string;
}

export interface AgentSessionStorageDiagnostics {
  /** Total number of sessions identified across all scanned storage */
  session_count: number;
  /** Total disk usage in bytes across all session files */
  total_disk_usage_bytes: number;
  /** Human-readable representation of total disk usage (e.g. "12.4 MB") */
  total_disk_usage: string;
  /** Total number of files scanned */
  total_files: number;
  /** Overall file age distribution across all session files */
  file_age_distribution: FileAgeDistribution;
  /** Storage usage broken down by provider where available */
  by_provider: Record<string, ProviderStorageUsage>;
  /** Scanned directories and their individual status */
  scanned_directories: ScannedDirectoryInfo[];
  /** Any non-fatal warnings or permission errors encountered */
  warnings: string[];
  /** ISO timestamp when the diagnostics were collected */
  timestamp: string;
  /** Authoritative recorded sessions from the database if pool is reachable */
  database_sessions?: {
    total: number;
    by_provider: Record<string, number>;
  } | null;
}

export interface SessionStorageDiagnosticsOptions {
  /**
   * Root data directory for the platform (defaults to config.dataDir).
   */
  dataDir?: string;
  /**
   * Custom session directory to scan directly.
   */
  sessionDir?: string;
  /**
   * Additional or override directories to scan for specific providers.
   */
  providerDirs?: Partial<Record<AgentProvider | string, string | string[]>>;
  /**
   * Fixed reference time (ms since epoch) for computing file age buckets. Defaults to Date.now().
   */
  now?: number;
  /**
   * Whether to query the database agent_sessions table if pool is available. Defaults to true.
   */
  includeDatabase?: boolean;
  /**
   * Maximum directory recursion depth to guard against deeply nested structures. Defaults to 20.
   */
  maxDepth?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BUCKET_LABEL_UNDER_24H = "< 1 day";
const BUCKET_LABEL_1D_7D = "1-7 days";
const BUCKET_LABEL_7D_30D = "7-30 days";
const BUCKET_LABEL_30D_90D = "30-90 days";
const BUCKET_LABEL_OVER_90D = "> 90 days";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

export function emptyAgeDistribution(): FileAgeDistribution {
  const under_24h = { count: 0, bytes: 0 };
  const d1_to_7d = { count: 0, bytes: 0 };
  const d7_to_30d = { count: 0, bytes: 0 };
  const d30_to_90d = { count: 0, bytes: 0 };
  const over_90d = { count: 0, bytes: 0 };

  return {
    under_24h,
    "1d_to_7d": d1_to_7d,
    "7d_to_30d": d7_to_30d,
    "30d_to_90d": d30_to_90d,
    over_90d,
    buckets: {
      [BUCKET_LABEL_UNDER_24H]: under_24h,
      [BUCKET_LABEL_1D_7D]: d1_to_7d,
      [BUCKET_LABEL_7D_30D]: d7_to_30d,
      [BUCKET_LABEL_30D_90D]: d30_to_90d,
      [BUCKET_LABEL_OVER_90D]: over_90d,
    },
    total_files: 0,
    total_bytes: 0,
    oldest_file_age_days: null,
    newest_file_age_days: null,
    oldest_file_timestamp: null,
    newest_file_timestamp: null,
  };
}

export function recordFileInAgeDistribution(
  dist: FileAgeDistribution,
  bytes: number,
  mtimeMs: number,
  now: number,
): void {
  const ageMs = Math.max(0, now - mtimeMs);
  const ageDays = ageMs / MS_PER_DAY;

  dist.total_files++;
  dist.total_bytes += bytes;

  if (ageMs < 1 * MS_PER_DAY) {
    dist.under_24h.count++;
    dist.under_24h.bytes += bytes;
  } else if (ageMs < 7 * MS_PER_DAY) {
    dist["1d_to_7d"].count++;
    dist["1d_to_7d"].bytes += bytes;
  } else if (ageMs < 30 * MS_PER_DAY) {
    dist["7d_to_30d"].count++;
    dist["7d_to_30d"].bytes += bytes;
  } else if (ageMs < 90 * MS_PER_DAY) {
    dist["30d_to_90d"].count++;
    dist["30d_to_90d"].bytes += bytes;
  } else {
    dist.over_90d.count++;
    dist.over_90d.bytes += bytes;
  }

  if (dist.oldest_file_age_days === null || ageDays > dist.oldest_file_age_days) {
    dist.oldest_file_age_days = Number(ageDays.toFixed(2));
    dist.oldest_file_timestamp = new Date(mtimeMs).toISOString();
  }

  if (dist.newest_file_age_days === null || ageDays < dist.newest_file_age_days) {
    dist.newest_file_age_days = Number(ageDays.toFixed(2));
    dist.newest_file_timestamp = new Date(mtimeMs).toISOString();
  }
}

export function mergeAgeDistributions(
  target: FileAgeDistribution,
  source: FileAgeDistribution,
): void {
  target.total_files += source.total_files;
  target.total_bytes += source.total_bytes;

  target.under_24h.count += source.under_24h.count;
  target.under_24h.bytes += source.under_24h.bytes;

  target["1d_to_7d"].count += source["1d_to_7d"].count;
  target["1d_to_7d"].bytes += source["1d_to_7d"].bytes;

  target["7d_to_30d"].count += source["7d_to_30d"].count;
  target["7d_to_30d"].bytes += source["7d_to_30d"].bytes;

  target["30d_to_90d"].count += source["30d_to_90d"].count;
  target["30d_to_90d"].bytes += source["30d_to_90d"].bytes;

  target.over_90d.count += source.over_90d.count;
  target.over_90d.bytes += source.over_90d.bytes;

  if (source.oldest_file_age_days !== null) {
    if (
      target.oldest_file_age_days === null ||
      source.oldest_file_age_days > target.oldest_file_age_days
    ) {
      target.oldest_file_age_days = source.oldest_file_age_days;
      target.oldest_file_timestamp = source.oldest_file_timestamp;
    }
  }

  if (source.newest_file_age_days !== null) {
    if (
      target.newest_file_age_days === null ||
      source.newest_file_age_days < target.newest_file_age_days
    ) {
      target.newest_file_age_days = source.newest_file_age_days;
      target.newest_file_timestamp = source.newest_file_timestamp;
    }
  }
}

interface WalkResult {
  fileCount: number;
  totalBytes: number;
  ageDist: FileAgeDistribution;
  warnings: string[];
  status: "ok" | "missing" | "permission_denied" | "error";
  error?: string;
}

/**
 * Safely inspects a filesystem path and recursively collects size and age metadata.
 *
 * Rules:
 * - Uses lstat, never stat, to inspect symlinks without dereferencing.
 * - Does NOT follow symbolic links into directories (avoids loops, cycles, and foreign path escapes).
 * - Broken symlinks are handled gracefully using lstat metadata without throwing.
 * - Permission errors (EACCES/EPERM) are caught and returned as warnings.
 * - File contents and credentials are NEVER read.
 */
async function walkDirectory(
  dirPath: string,
  now: number,
  visitedInodes: Set<string>,
  maxDepth = 20,
  currentDepth = 0,
): Promise<WalkResult> {
  const warnings: string[] = [];
  const ageDist = emptyAgeDistribution();

  let st;
  try {
    st = await lstat(dirPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error?.code === "ENOENT") {
      return {
        fileCount: 0,
        totalBytes: 0,
        ageDist,
        warnings: [],
        status: "missing",
      };
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return {
        fileCount: 0,
        totalBytes: 0,
        ageDist,
        warnings: [`Permission denied accessing ${dirPath}`],
        status: "permission_denied",
        error: error.message,
      };
    }
    return {
      fileCount: 0,
      totalBytes: 0,
      ageDist,
      warnings: [`Error accessing ${dirPath}: ${error?.message ?? String(err)}`],
      status: "error",
      error: error?.message ?? String(err),
    };
  }

  // Symbolic link at the root of the check: count its entry metadata, do not recurse
  if (st.isSymbolicLink()) {
    recordFileInAgeDistribution(ageDist, st.size, st.mtimeMs, now);
    return {
      fileCount: 1,
      totalBytes: st.size,
      ageDist,
      warnings,
      status: "ok",
    };
  }

  // Regular file
  if (st.isFile()) {
    recordFileInAgeDistribution(ageDist, st.size, st.mtimeMs, now);
    return {
      fileCount: 1,
      totalBytes: st.size,
      ageDist,
      warnings,
      status: "ok",
    };
  }

  // Directory handling
  if (!st.isDirectory()) {
    return {
      fileCount: 0,
      totalBytes: 0,
      ageDist,
      warnings,
      status: "ok",
    };
  }

  // Inode cycle tracking (bind mounts, directory hardlinks)
  const inodeKey = `${st.dev}:${st.ino}`;
  if (visitedInodes.has(inodeKey)) {
    return {
      fileCount: 0,
      totalBytes: 0,
      ageDist,
      warnings,
      status: "ok",
    };
  }
  visitedInodes.add(inodeKey);

  if (currentDepth >= maxDepth) {
    warnings.push(`Maximum recursion depth reached at ${dirPath}`);
    return {
      fileCount: 0,
      totalBytes: 0,
      ageDist,
      warnings,
      status: "ok",
    };
  }

  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return {
        fileCount: 0,
        totalBytes: 0,
        ageDist,
        warnings: [`Permission denied reading directory: ${dirPath}`],
        status: "permission_denied",
        error: error.message,
      };
    }
    return {
      fileCount: 0,
      totalBytes: 0,
      ageDist,
      warnings: [`Error reading directory ${dirPath}: ${error?.message ?? String(err)}`],
      status: "error",
      error: error?.message ?? String(err),
    };
  }

  let fileCount = 0;
  let totalBytes = 0;

  for (const dirent of dirents) {
    const childPath = join(dirPath, dirent.name);
    let childSt;
    try {
      childSt = await lstat(childPath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error?.code === "EACCES" || error?.code === "EPERM") {
        warnings.push(`Permission denied accessing ${childPath}`);
      }
      // If file disappeared or broken in a way lstat fails, skip safely
      continue;
    }

    if (childSt.isSymbolicLink()) {
      // Safely count symbolic link entry without traversing its target
      fileCount++;
      totalBytes += childSt.size;
      recordFileInAgeDistribution(ageDist, childSt.size, childSt.mtimeMs, now);
    } else if (childSt.isDirectory()) {
      const sub = await walkDirectory(childPath, now, visitedInodes, maxDepth, currentDepth + 1);
      fileCount += sub.fileCount;
      totalBytes += sub.totalBytes;
      mergeAgeDistributions(ageDist, sub.ageDist);
      warnings.push(...sub.warnings);
    } else if (childSt.isFile()) {
      fileCount++;
      totalBytes += childSt.size;
      recordFileInAgeDistribution(ageDist, childSt.size, childSt.mtimeMs, now);
    }
  }

  return {
    fileCount,
    totalBytes,
    ageDist,
    warnings,
    status: "ok",
  };
}

/**
 * Adds or updates provider storage usage in the breakdown map.
 */
function ensureProviderEntry(
  byProvider: Record<string, ProviderStorageUsage>,
  provider: string,
): ProviderStorageUsage {
  if (!byProvider[provider]) {
    byProvider[provider] = {
      provider,
      available: false,
      session_count: 0,
      file_count: 0,
      disk_usage_bytes: 0,
      disk_usage_human: "0 B",
      directories: [],
      file_age_distribution: emptyAgeDistribution(),
      warnings: [],
    };
  }
  return byProvider[provider];
}

/**
 * Read-only diagnostics for agent session storage.
 *
 * Collects session counts, disk usage, file age distribution and provider-level breakdown.
 */
export async function agentSessionStorageDiagnostics(
  options: SessionStorageDiagnosticsOptions = {},
): Promise<AgentSessionStorageDiagnostics> {
  const now = options.now ?? Date.now();
  const maxDepth = options.maxDepth ?? 20;
  const dataDir = options.dataDir ?? config.dataDir;

  const scannedDirectories: ScannedDirectoryInfo[] = [];
  const allWarnings: string[] = [];
  const visitedInodes = new Set<string>();
  const seenSessions = new Set<string>();

  // Initialize known providers so callers always get predictable provider keys
  const byProvider: Record<string, ProviderStorageUsage> = {};
  for (const p of AGENT_PROVIDERS) {
    ensureProviderEntry(byProvider, p);
  }

  const overallAgeDist = emptyAgeDistribution();
  let totalFiles = 0;
  let totalDiskUsageBytes = 0;

  // Helper to record a scanned directory and accumulate into provider / overall totals
  const recordDirectoryScan = (
    dirPath: string,
    provider: string | null,
    walk: WalkResult,
    sessionsFound: number,
  ) => {
    scannedDirectories.push({
      path: dirPath,
      exists: walk.status !== "missing",
      provider,
      session_count: sessionsFound,
      file_count: walk.fileCount,
      bytes: walk.totalBytes,
      status: walk.status,
      error: walk.error,
    });

    if (walk.warnings.length) {
      allWarnings.push(...walk.warnings);
    }

    totalFiles += walk.fileCount;
    totalDiskUsageBytes += walk.totalBytes;
    mergeAgeDistributions(overallAgeDist, walk.ageDist);

    if (provider) {
      const pEntry = ensureProviderEntry(byProvider, provider);
      if (walk.status === "ok" || walk.fileCount > 0 || sessionsFound > 0) {
        pEntry.available = true;
      }
      pEntry.session_count += sessionsFound;
      pEntry.file_count += walk.fileCount;
      pEntry.disk_usage_bytes += walk.totalBytes;
      pEntry.disk_usage_human = formatBytes(pEntry.disk_usage_bytes);
      if (!pEntry.directories.includes(dirPath)) {
        pEntry.directories.push(dirPath);
      }
      mergeAgeDistributions(pEntry.file_age_distribution, walk.ageDist);
      if (walk.warnings.length) {
        pEntry.warnings = [...(pEntry.warnings ?? []), ...walk.warnings];
      }
    }
  };

  // 1. Completion sessions (chat completion session store; attributed to claude by default)
  const completionSessionsDir = join(dataDir, "completion-sessions");
  let completionTopEntries: string[] = [];
  try {
    const list = await readdir(completionSessionsDir);
    completionTopEntries = list;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error?.code !== "ENOENT") {
      allWarnings.push(
        `Could not read completion-sessions directory: ${error?.message ?? String(err)}`,
      );
    }
  }

  let completionSessionsCount = 0;
  for (const entry of completionTopEntries) {
    const sId = `completion:${entry}`;
    if (!seenSessions.has(sId)) {
      seenSessions.add(sId);
      completionSessionsCount++;
    }
  }

  const completionWalk = await walkDirectory(completionSessionsDir, now, visitedInodes, maxDepth);
  recordDirectoryScan(completionSessionsDir, "claude", completionWalk, completionSessionsCount);

  // 2. Sandbox sessions (dataDir/sandbox/run-<id>/<provider>)
  const sandboxDir = join(dataDir, "sandbox");
  let sandboxEntries: string[] = [];
  try {
    sandboxEntries = await readdir(sandboxDir);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error?.code !== "ENOENT") {
      allWarnings.push(`Could not read sandbox directory: ${error?.message ?? String(err)}`);
    }
  }

  if (sandboxEntries.length) {
    for (const runName of sandboxEntries) {
      const runPath = join(sandboxDir, runName);
      let runProviders: string[] = [];
      try {
        const sub = await readdir(runPath);
        runProviders = sub;
      } catch {
        // Run folder might be unreadable or a file
        continue;
      }

      for (const provName of runProviders) {
        const provPath = join(runPath, provName);
        const resolvedProvider = (AGENT_PROVIDERS as readonly string[]).includes(provName)
          ? provName
          : "other";

        const sId = `sandbox:${runName}:${provName}`;
        let isNewSession = false;
        if (!seenSessions.has(sId)) {
          seenSessions.add(sId);
          isNewSession = true;
        }

        const walk = await walkDirectory(provPath, now, visitedInodes, maxDepth);
        recordDirectoryScan(provPath, resolvedProvider, walk, isNewSession ? 1 : 0);
      }
    }
  } else {
    // Check if sandbox dir itself exists or is missing/denied
    const sWalk = await walkDirectory(sandboxDir, now, visitedInodes, maxDepth);
    if (sWalk.status !== "ok" || sWalk.fileCount > 0) {
      recordDirectoryScan(sandboxDir, null, sWalk, 0);
    }
  }

  // 3. General sessions directory (dataDir/sessions and dataDir/agent-sessions)
  for (const subName of ["sessions", "agent-sessions"]) {
    const sessionsDir = join(dataDir, subName);
    let sEntries: string[] = [];
    try {
      sEntries = await readdir(sessionsDir);
    } catch {
      // missing or unreadable; walkDirectory will record status if called
      continue;
    }

    if (sEntries.length) {
      for (const entry of sEntries) {
        const entryPath = join(sessionsDir, entry);
        if ((AGENT_PROVIDERS as readonly string[]).includes(entry)) {
          // Provider subfolder: sessions/<provider>/<sessionId>
          let subSessionList: string[] = [];
          try {
            subSessionList = await readdir(entryPath);
          } catch {
            subSessionList = [];
          }

          let pSessionCount = 0;
          for (const sName of subSessionList) {
            const key = `sessions:${entry}:${sName}`;
            if (!seenSessions.has(key)) {
              seenSessions.add(key);
              pSessionCount++;
            }
          }

          const walk = await walkDirectory(entryPath, now, visitedInodes, maxDepth);
          recordDirectoryScan(entryPath, entry, walk, pSessionCount);
        } else {
          // Top-level session entry
          const key = `sessions:${subName}:${entry}`;
          let isNew = false;
          if (!seenSessions.has(key)) {
            seenSessions.add(key);
            isNew = true;
          }
          const walk = await walkDirectory(entryPath, now, visitedInodes, maxDepth);
          recordDirectoryScan(entryPath, null, walk, isNew ? 1 : 0);
        }
      }
    }
  }

  // 4. Provider subfolders directly under dataDir (e.g. dataDir/claude, dataDir/codex)
  for (const prov of AGENT_PROVIDERS) {
    const pDir = join(dataDir, prov);
    let entries: string[] = [];
    try {
      entries = await readdir(pDir);
    } catch {
      continue;
    }

    let pSessions = 0;
    for (const e of entries) {
      const key = `providerDir:${prov}:${e}`;
      if (!seenSessions.has(key)) {
        seenSessions.add(key);
        pSessions++;
      }
    }

    const walk = await walkDirectory(pDir, now, visitedInodes, maxDepth);
    recordDirectoryScan(pDir, prov, walk, pSessions);
  }

  // 5. Explicit custom session directory (if provided)
  if (options.sessionDir) {
    const customDir = options.sessionDir;
    let customEntries: string[] = [];
    try {
      customEntries = await readdir(customDir);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      allWarnings.push(
        `Could not read custom session directory ${customDir}: ${error?.message ?? String(err)}`,
      );
    }

    let customSessionCount = 0;
    // Check if subdirectories are provider names
    const providerSubdirs = customEntries.filter((e) =>
      (AGENT_PROVIDERS as readonly string[]).includes(e),
    );

    if (providerSubdirs.length) {
      for (const pName of providerSubdirs) {
        const pPath = join(customDir, pName);
        let subItems: string[] = [];
        try {
          subItems = await readdir(pPath);
        } catch {
          subItems = [];
        }

        let pCount = 0;
        for (const item of subItems) {
          const key = `custom:${pName}:${item}`;
          if (!seenSessions.has(key)) {
            seenSessions.add(key);
            pCount++;
          }
        }

        const walk = await walkDirectory(pPath, now, visitedInodes, maxDepth);
        recordDirectoryScan(pPath, pName, walk, pCount);
      }
      // Non-provider entries
      const nonProvider = customEntries.filter(
        (e) => !(AGENT_PROVIDERS as readonly string[]).includes(e),
      );
      for (const item of nonProvider) {
        const itemPath = join(customDir, item);
        const key = `custom:unassigned:${item}`;
        let isNew = false;
        if (!seenSessions.has(key)) {
          seenSessions.add(key);
          isNew = true;
        }
        const walk = await walkDirectory(itemPath, now, visitedInodes, maxDepth);
        recordDirectoryScan(itemPath, null, walk, isNew ? 1 : 0);
      }
    } else {
      // Every entry in customDir is a session
      for (const entry of customEntries) {
        const key = `customDir:${entry}`;
        if (!seenSessions.has(key)) {
          seenSessions.add(key);
          customSessionCount++;
        }
      }

      const walk = await walkDirectory(customDir, now, visitedInodes, maxDepth);
      recordDirectoryScan(customDir, null, walk, customSessionCount);
    }
  }

  // 6. Explicit provider directories override / additions
  if (options.providerDirs) {
    for (const [provName, paths] of Object.entries(options.providerDirs)) {
      const pathList = Array.isArray(paths) ? paths : [paths];
      for (const p of pathList) {
        if (!p) continue;
        let pEntries: string[] = [];
        try {
          pEntries = await readdir(p);
        } catch {
          pEntries = [];
        }

        let pCount = 0;
        for (const entry of pEntries) {
          const key = `explicitProvider:${provName}:${entry}`;
          if (!seenSessions.has(key)) {
            seenSessions.add(key);
            pCount++;
          }
        }

        const walk = await walkDirectory(p, now, visitedInodes, maxDepth);
        recordDirectoryScan(p, provName, walk, pCount);
      }
    }
  }

  // 7. Authoritative database sessions check (read-only query on agent_sessions table if pool is available)
  let databaseSessions: {
    total: number;
    by_provider: Record<string, number>;
  } | null = null;

  if (options.includeDatabase !== false) {
    try {
      const { pool, q } = await import("../db/pool.ts");
      const rows = await q<{ provider: string; count: string }>(
        pool,
        "SELECT provider, count(*)::text AS count FROM agent_sessions GROUP BY provider",
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const byProv: Record<string, number> = {};
        let total = 0;
        for (const r of rows) {
          const cnt = parseInt(r.count, 10) || 0;
          byProv[r.provider] = cnt;
          total += cnt;
        }
        databaseSessions = {
          total,
          by_provider: byProv,
        };
      }
    } catch {
      // Ignored: unit tests or offline DB
    }
  }

  // Session count on disk
  const sessionCount = seenSessions.size;

  return {
    session_count: sessionCount,
    total_disk_usage_bytes: totalDiskUsageBytes,
    total_disk_usage: formatBytes(totalDiskUsageBytes),
    total_files: totalFiles,
    file_age_distribution: overallAgeDist,
    by_provider: byProvider,
    scanned_directories: scannedDirectories,
    warnings: allWarnings,
    timestamp: new Date(now).toISOString(),
    ...(databaseSessions ? { database_sessions: databaseSessions } : {}),
  };
}

/** Alias for agentSessionStorageDiagnostics */
export const sessionStorageDiagnostics = agentSessionStorageDiagnostics;
