/**
 * Production error scans as durable jobs (ADR 0004). The `prod_error_scans` row is the job: queued here (API or
 * schedule), claimed by exactly one engine through a lease with a fencing token, heartbeated while it runs and
 * published only while its token is current. A unique index allows one queued/running scan across all instances, so
 * two instances (or a double click, or two schedule ticks) can never scan at once, and an expired lease (crash,
 * kill -9, lost network) is recovered by whichever instance notices first.
 *
 * Every job is claimed and run by platform-go (go/internal/proderrors), which reaches the providers only through
 * this process's internal gateway (src/prodErrors/gateway.ts), so credentials and authorization never leave
 * TypeScript. (The `engine` column is kept for old rows; new jobs are always `go`.)
 */
import { pool, one, q } from "../db/pool.ts";
import { retrievalService } from "../retrieval/semantic.ts";
import { scanNamespaces, scanWindow, type ScanOptions, type ScanWindow } from "./window.ts";

export type ScanTrigger = "manual" | "schedule";
export type ScanEngine = "typescript" | "go";

/** The window fixed at enqueue time: a retry or a late claim scans exactly what was asked. */
export interface ScanRequest {
  preset: ScanWindow["preset"];
  compare: ScanWindow["compare"];
  namespaces: string[];
  day: string;
  hm: string;
  start: number;
  end: number;
  baseStart: number;
  baseEnd: number;
}

export interface ScanJob {
  id: number;
  trigger: ScanTrigger;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  engine: ScanEngine;
  requested_by: number | null;
  request: ScanRequest;
  attempts: number;
  max_attempts: number;
  fencing_token: number;
  cancel_requested: boolean;
  stage: "collect" | "published";
  progress: Record<string, unknown> | null;
}

const ts = (e: number) => new Date(e * 1000).toISOString();

/** The scan window as the collectors need it now: relative Splunk bounds are recomputed from the fixed window. */
export function windowOf(r: ScanRequest, now = new Date()): ScanWindow {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  return {
    preset: r.preset,
    compare: r.compare,
    day: r.day,
    hm: r.hm,
    start: r.start,
    end: r.end,
    now: nowEpoch,
    baseStart: r.baseStart,
    baseEnd: r.baseEnd,
    minutes: Math.ceil((nowEpoch - r.baseStart) / 60) + 1,
    untilMinutes: Math.max(0, Math.floor((nowEpoch - r.end) / 60) - 1),
  };
}

/**
 * Queue a scan. Options are validated before anything is stored (400 on a bad window or namespace). Returns
 * `started: false` when another scan is queued or running anywhere, or when `dedupeKey` was already used.
 */
export async function enqueueScan(
  trigger: ScanTrigger,
  opts: ScanOptions,
  input: {
    requestedBy: number | null;
    now?: Date;
    dedupeKey?: string;
  },
): Promise<{ started: boolean; running: boolean; duplicate?: boolean; job?: ScanJob }> {
  const w = scanWindow(opts, input.now);
  const namespaces = scanNamespaces(opts.namespaces).map((n) => n.namespace);
  const request: ScanRequest = {
    preset: w.preset,
    compare: w.compare,
    namespaces,
    day: w.day,
    hm: w.hm,
    start: w.start,
    end: w.end,
    baseStart: w.baseStart,
    baseEnd: w.baseEnd,
  };
  try {
    const job = await one<ScanJob>(
      pool,
      `INSERT INTO prod_error_scans (trigger, preset, namespaces, window_start, window_end, baseline_start, baseline_end,
         status, engine, requested_by, request, dedupe_key, progress)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','go',$8,$9,$10,$11)
       RETURNING *`,
      [
        trigger,
        w.preset,
        namespaces,
        ts(w.start),
        ts(w.end),
        ts(w.baseStart),
        ts(w.baseEnd),
        input.requestedBy,
        JSON.stringify(request),
        input.dedupeKey ?? null,
        JSON.stringify(initialProgress()),
      ],
    );
    wakeGo();
    return { started: true, running: true, job: job! };
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code !== "23505") throw e;
    if (err.constraint === "prod_error_scans_dedupe_key_key")
      return { started: false, running: !!(await activeScan()), duplicate: true };
    return { started: false, running: true };
  }
}

export const initialProgress = () => ({
  phase: "connect",
  pct: 2,
  searchPct: 0,
  scanned: 0,
  matched: 0,
  startedAt: new Date().toISOString(),
});

/** Tell platform-go a job is waiting (best effort: its own poll picks the job up anyway). */
function wakeGo() {
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) return;
  void retrievalService("/internal/v1/jobs/wake", { kind: "prod_error_scan" }, 2000)
    .then((r) => r.body?.cancel())
    .catch(() => {});
}

/**
 * Expired leases (crashed or partitioned workers, any engine): requeue with capped exponential backoff and full
 * jitter while attempts remain, otherwise fail.
 */
export async function recoverScans() {
  const failed = await q<{ id: number; trigger: ScanTrigger; request: ScanRequest }>(
    pool,
    `UPDATE prod_error_scans SET
       status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'failed' END,
       available_at=now()+make_interval(secs => floor(random()*least(300, 5*power(2, attempts)))),
       fencing_token=fencing_token+1, lease_owner=NULL, lease_expires_at=NULL,
       ok=CASE WHEN attempts<max_attempts THEN NULL ELSE false END,
       finished_at=CASE WHEN attempts<max_attempts THEN NULL ELSE now() END,
       error=CASE WHEN attempts<max_attempts THEN error ELSE 'interrupted: the worker lease expired '||attempts||' times' END
     WHERE status='running' AND lease_expires_at<now() RETURNING id, trigger, request, status`,
  );
  return { recovered: failed.length };
}

/** Fenced terminal update. False when the lease was lost: nothing is written. */
export async function finishScan(
  job: Pick<ScanJob, "id" | "fencing_token">,
  r: {
    status: "succeeded" | "failed" | "canceled";
    error: string | null;
    groups?: number;
    events?: number;
    notified?: number;
  },
) {
  const row = await one(
    pool,
    `UPDATE prod_error_scans SET status=$3, ok=($3='succeeded'), finished_at=now(), error=$4,
       groups=COALESCE($5, groups), events=COALESCE($6, events), notified=COALESCE($7, notified),
       lease_owner=NULL, lease_expires_at=NULL, progress=NULL
     WHERE id=$1 AND fencing_token=$2 AND status='running' RETURNING id`,
    [
      job.id,
      job.fencing_token,
      r.status,
      r.error,
      r.groups ?? null,
      r.events ?? null,
      r.notified ?? null,
    ],
  );
  return !!row;
}

/** Request cancellation: a queued scan is canceled at once, a running one by its worker at its next heartbeat. */
export async function cancelScan(id: number) {
  const row = await one<{ status: string }>(
    pool,
    `UPDATE prod_error_scans SET
       cancel_requested=true,
       status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,
       ok=CASE WHEN status='queued' THEN false ELSE ok END,
       finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,
       error=CASE WHEN status='queued' THEN 'canceled' ELSE error END
     WHERE id=$1 AND status IN ('queued','running') RETURNING status`,
    [id],
  );
  if (!row)
    throw Object.assign(new Error("không có lượt quét đang chạy với id này"), { status: 404 });
  return { id, status: row.status === "running" ? "canceling" : "canceled" };
}

/** The queued or running scan, if any (every instance sees the same one). */
export function activeScan() {
  return one<ScanJob & { started_at: string }>(
    pool,
    "SELECT * FROM prod_error_scans WHERE status IN ('queued','running') LIMIT 1",
  );
}

/**
 * Once per local day across all instances: true for the first caller of `day` (failure notices). Atomic: the
 * conditional upsert succeeds for exactly one of concurrent callers.
 */
export async function firstToday(key: string, day: string) {
  const row = await one(
    pool,
    `INSERT INTO settings(key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value=excluded.value WHERE settings.value IS DISTINCT FROM excluded.value
     RETURNING key`,
    [key, day],
  );
  return !!row;
}
