import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config, instanceIdentityExplicit } from "./config.ts";
import { pool, one, q, withTx, type Db } from "./db/pool.ts";
import { localJobs } from "./workflow/local.ts";

export const instanceSession = randomUUID();
let started = false;

export class InstanceConflictError extends Error {
  readonly retrySeconds: number;
  constructor(id: string, retrySeconds: number) {
    super(
      `Instance identity conflict: ${id} has a live registration. Stop the other installation or use its own dataDir and PLATFORM_INSTANCE. If the previous process just exited, retry in ${retrySeconds} seconds; a continuing heartbeat will keep the registration protected.`,
    );
    this.name = "InstanceConflictError";
    this.retrySeconds = retrySeconds;
  }
}

/**
 * True only when the recorded registration is provably dead: it was made on this same host by a process that no
 * longer exists (or whose PID now belongs to a non-Node process). Any doubt — another host, no PID recorded, the PID
 * alive, permission to signal it denied — keeps the registration protected.
 */
export function previousProcessGone(
  meta: { host?: unknown; pid?: unknown; started?: unknown } | null | undefined,
  me: { host: string; pid: number },
  alive: (pid: number) => boolean = processAlive,
  startedOf: (pid: number) => string | null = processStartTime,
): boolean {
  const pid = Number(meta?.pid);
  if (meta?.host !== me.host || !Number.isInteger(pid) || pid <= 0) return false;
  // A recorded start time tells a recycled PID (even our own, after a container restart) from the recorder.
  if (typeof meta?.started === "string") {
    const current = startedOf(pid);
    if (current !== null) return current !== meta.started;
  }
  if (pid === me.pid) return false;
  return !alive(pid);
}

/** Kernel start time of `pid` (clock ticks since boot), or null without /proc or when the process is gone. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number, command = "node"): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but owned by someone else
  }
  try {
    // A recycled PID: alive, but not running `command`, so not the recorded process.
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(command);
  } catch {
    return true; // no /proc (macOS): trust the signal check
  }
}

/** Serializes duplicate startup using the registry row, with database time throughout. */
export async function registerInstance(id = config.instanceId, session = instanceSession) {
  await withTx(async (c) => {
    if (!instanceIdentityExplicit && id !== hostname().replace(/:/g, "-")) {
      const legacy = await one(
        c,
        "SELECT id FROM workflow_runs WHERE worker_instance = $1 LIMIT 1",
        [hostname().replace(/:/g, "-")],
      );
      if (legacy)
        throw new Error(
          "Legacy hostname-owned runs exist. Set PLATFORM_INSTANCE to the old hostname after verifying this is their original installation; ownership will not be migrated automatically.",
        );
    }
    if (!instanceIdentityExplicit) {
      const prefix = join(config.dataDir, "worktrees") + sep;
      const owners = await q(
        c,
        `SELECT DISTINCT r.worker_instance FROM workflow_runs r JOIN execution_workspaces w ON w.run_id = r.id
        WHERE left(w.path, length($1)) = $1 AND r.worker_instance IS DISTINCT FROM $2`,
        [prefix, id],
      );
      if (owners.length)
        throw new Error(
          "Local dataDir has workspaces owned by another or unassigned instance identity. Verify the original ID and set PLATFORM_INSTANCE explicitly; ownership cannot be inferred safely.",
        );
    }
    const me = { host: hostname(), pid: process.pid };
    const registration = { ...me, started: processStartTime(process.pid) };
    let row = await one(
      c,
      `INSERT INTO platform_instances (instance_id, session_id, metadata) VALUES ($1, $2, $4)
      ON CONFLICT (instance_id) DO UPDATE SET session_id = excluded.session_id, started_at = now(), last_seen_at = now(), stopped_at = NULL,
        metadata = coalesce(platform_instances.metadata, '{}'::jsonb) || excluded.metadata
      WHERE platform_instances.stopped_at IS NOT NULL OR platform_instances.last_seen_at < now() - make_interval(secs => $3)
      RETURNING instance_id`,
      [id, session, config.instance.offlineSeconds, JSON.stringify(registration)],
    );
    if (!row) {
      // The live-looking registration may belong to a process of THIS machine that already exited without marking
      // itself stopped (killed, terminal closed). Its PID proves it: take over at once instead of waiting it out.
      const prev = await one<{ metadata: any }>(
        c,
        "SELECT metadata FROM platform_instances WHERE instance_id = $1 FOR UPDATE",
        [id],
      );
      if (previousProcessGone(prev?.metadata, me))
        row = await one(
          c,
          `UPDATE platform_instances SET session_id = $2, started_at = now(), last_seen_at = now(), stopped_at = NULL,
             metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb
           WHERE instance_id = $1 RETURNING instance_id`,
          [id, session, JSON.stringify(registration)],
        );
    }
    if (!row) {
      const live = await one(
        c,
        `SELECT GREATEST(1, ceil($2 - extract(epoch FROM now()-last_seen_at)))::int AS retry_seconds
        FROM platform_instances WHERE instance_id=$1`,
        [id, config.instance.offlineSeconds],
      );
      throw new InstanceConflictError(id, live?.retry_seconds ?? config.instance.offlineSeconds);
    }
    // Replaced session may still have unexpired job leases. Expire and fence them before the new scheduler starts.
    await q(
      c,
      `UPDATE workflow_jobs j SET lease_expires_at = now() - interval '1 second', fencing_token = fencing_token + 1
      FROM workflow_runs r WHERE j.run_id = r.id AND r.worker_instance = $1 AND j.status = 'running'`,
      [id],
    );
  });
}

/** Unregistered CLI/test workers remain compatible; registered servers must hold their process session. */
export async function ownsInstance(db: Db = pool): Promise<boolean> {
  return !(await one(
    db,
    "SELECT 1 FROM platform_instances WHERE instance_id = $1 AND (session_id <> $2 OR stopped_at IS NOT NULL)",
    [config.instanceId, instanceSession],
  ));
}

export async function instanceHealth(id: string | null, db: Db = pool) {
  if (!id) return { instance_id: null, health: "UNKNOWN", last_seen_at: null };
  const row = await one(
    db,
    `SELECT instance_id, last_seen_at, stopped_at,
    CASE WHEN stopped_at IS NOT NULL THEN 'OFFLINE'
      WHEN last_seen_at < now() - make_interval(secs => $2) THEN 'OFFLINE'
      WHEN last_seen_at < now() - make_interval(secs => $3) THEN 'STALE' ELSE 'ONLINE' END AS health
    FROM platform_instances WHERE instance_id = $1`,
    [id, config.instance.offlineSeconds, config.instance.heartbeatSeconds * 2],
  );
  return row ?? { instance_id: id, health: "UNKNOWN", last_seen_at: null };
}

export async function startInstanceHeartbeat(
  options: { waitForPrevious?: boolean; onWait?: (seconds: number) => void } = {},
) {
  if (started) throw new Error("Instance heartbeat already started");
  started = true;
  try {
    try {
      await registerInstance();
    } catch (e) {
      if (!options.waitForPrevious || !(e instanceof InstanceConflictError)) throw e;
      // One bounded wait covers an unclean exit; a renewed heartbeat still blocks takeover.
      const seconds = Math.min(config.instance.offlineSeconds, e.retrySeconds);
      options.onWait?.(seconds);
      await delay(seconds * 1000);
      await registerInstance();
    }
  } catch (e) {
    started = false;
    throw e;
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let pending: Promise<void> = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      pending = beat();
    }, config.instance.heartbeatSeconds * 1000);
    timer.unref();
  };
  const beat = async () => {
    try {
      const r = await q(
        pool,
        "UPDATE platform_instances SET last_seen_at = now() WHERE instance_id = $1 AND session_id = $2 AND stopped_at IS NULL RETURNING instance_id",
        [config.instanceId, instanceSession],
      );
      if (!r.length) {
        localJobs.abortAll();
        stopped = true;
        console.error(
          "Instance registration lost; workers fenced. Restart with a unique PLATFORM_INSTANCE.",
        );
      }
    } catch (e) {
      console.warn("Instance heartbeat unavailable:", (e as Error).message);
    }
    if (!stopped) schedule();
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pending;
      await q(
        pool,
        "UPDATE platform_instances SET stopped_at = now() WHERE instance_id = $1 AND session_id = $2",
        [config.instanceId, instanceSession],
      );
      started = false;
    },
  };
}
