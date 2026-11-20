/**
 * Internal provider gateway for platform-go's production error scans (ADR 0004, contract
 * go/contracts/prod-errors-v1.schema.json). platform-go owns the scan job (claim, lease, retries, fan-out,
 * grouping, publication) but never holds provider credentials: every Splunk/SigNoz read goes through here, as the
 * user who requested the scan, with that user's personal integrations, audited like any other read.
 *
 * Every call re-checks, before touching a provider: the bearer token and a loopback peer, the job's fence (the
 * caller still holds the lease of a running Go job) and the requesting user (still active; still an admin for a
 * manual scan; still the configured user for a scheduled one). A revoked permission ends the scan, a lost lease
 * stops the caller; neither is retried.
 *
 *   POST /internal/v1/prod-errors/scans/{id}/{op}   op: sources | splunk | signoz-errors | signoz-slow |
 *                                                        signoz-trace-gaps | finalize
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.ts";
import { pool, one, q } from "../db/pool.ts";
import { execution } from "../auth/execution.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { splunkConnected, splunkExpired, splunkSearch } from "../integrations/splunk.ts";
import {
  SignozError,
  signozEnabled,
  signozErrorSpanGroups,
  signozSlowRequestGroups,
  signozTraceGaps,
} from "../integrations/signoz.ts";
import {
  buildScanSpl,
  finalizeScan,
  maskGaps,
  notifyFailure,
  scanNamespaces,
  signozRows,
  signozSlowRows,
  SIGNOZ_NO_BASELINE,
  SIGNOZ_TRUNCATED,
} from "./scan.ts";
import { windowOf, type ScanRequest, type ScanTrigger } from "./jobs.ts";

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
const fail = (
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): Reply => ({
  status,
  body: { error, code, retryable: false, ...extra },
});

/** Calls served since process start, by operation and outcome (diagnostics, tests, benchmarks). */
export const gatewayStats: Record<string, number> = {};
const count = (k: string) => (gatewayStats[k] = (gatewayStats[k] ?? 0) + 1);

function authorized(req: IncomingMessage) {
  const token = process.env.RETRIEVAL_INTERNAL_TOKEN ?? "";
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  const want = Buffer.from(`Bearer ${token}`);
  return token.length >= 32 && got.length === want.length && timingSafeEqual(got, want);
}

const loopback = (req: IncomingMessage) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

async function body(req: IncomingMessage, max = 65536) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** Provider failures as the contract's error codes: transient ones are retryable by the job, the rest are not. */
export function providerFailure(source: "splunk" | "signoz", e: unknown): Reply {
  const err = e as Error & { status?: number; retryAfterMs?: number };
  const label = source === "splunk" ? "Splunk" : "SigNoz";
  if (e instanceof SignozError) {
    if (e.kind === "rate_limited")
      return {
        status: 429,
        body: {
          error: e.message,
          code: "rate_limited",
          retryable: true,
          retry_after_ms: e.retryAfterMs ?? null,
        },
      };
    const transient = e.kind === "server_error" || e.kind === "connection_failed";
    return {
      status: transient ? 502 : 424,
      body: {
        error: e.message,
        code: transient ? "provider_unavailable" : "provider_rejected",
        retryable: transient,
      },
    };
  }
  if (err.status === 429)
    return {
      status: 429,
      body: {
        error: err.message,
        code: "rate_limited",
        retryable: true,
        retry_after_ms: err.retryAfterMs ?? null,
      },
    };
  const timeout = /không trả lời trong|timed out|timeout/i.test(err.message);
  const transient =
    timeout ||
    (err.status ?? 0) >= 500 ||
    /không kết nối được|ECONNRE|ENOTFOUND|fetch failed/i.test(err.message);
  return {
    status: timeout ? 504 : transient ? 502 : 424,
    body: {
      error: err.message || `${label} failed`,
      code: timeout ? "provider_timeout" : transient ? "provider_unavailable" : "provider_rejected",
      retryable: transient,
    },
  };
}

interface Job {
  id: number;
  trigger: ScanTrigger;
  requested_by: number | null;
  request: ScanRequest;
}

/** The job, if `fence` still holds its lease, and the user it runs as, if that user may still run it. */
async function admit(id: number, fence: number): Promise<{ job: Job } | Reply> {
  const job = await one<Job>(
    pool,
    `SELECT id, trigger, requested_by, request FROM prod_error_scans
     WHERE id=$1 AND fencing_token=$2 AND status='running' AND engine='go'`,
    [id, fence],
  );
  if (!job) return fail(409, "lease_lost", "the scan lease is no longer held by this worker");
  const user = job.requested_by
    ? await one<{ active: boolean; role: string }>(
        pool,
        "SELECT active, role FROM users WHERE id=$1",
        [job.requested_by],
      )
    : null;
  const allowed =
    !!user?.active &&
    (job.trigger === "schedule"
      ? job.requested_by === config.prodErrors.userId
      : user.role === "admin");
  if (!allowed)
    return fail(403, "revoked", "the user who requested this scan may no longer run it");
  return { job };
}

/** Splunk's progress, stored on the row while the fence holds (every instance's page reads it there). */
function progressWriter(id: number, fence: number) {
  let last = 0;
  return (p: { pct: number; state?: string; scanned: number; matched: number }) => {
    if (Date.now() - last < 200) return;
    last = Date.now();
    void q(
      pool,
      `UPDATE prod_error_scans SET progress = COALESCE(progress,'{}'::jsonb) || jsonb_build_object(
         'phase','search','searchPct',$3::int,'splunkState',$4::text,'scanned',$5::bigint,'matched',$6::bigint,
         'pct',GREATEST(COALESCE((progress->>'pct')::int,0), 5 + round($3 * 0.85)::int))
       WHERE id=$1 AND fencing_token=$2 AND status='running'`,
      [id, fence, Math.round(p.pct), p.state ?? null, p.scanned, p.matched],
    ).catch(() => {});
  };
}

async function operate(
  op: string,
  job: Job,
  fence: number,
  input: Record<string, unknown>,
): Promise<Reply> {
  const w = windowOf(job.request);
  const ns = scanNamespaces(job.request.namespaces);
  const win = { start: w.start * 1000, end: w.end * 1000 };
  const base = { start: w.baseStart * 1000, end: w.baseEnd * 1000 };
  switch (op) {
    case "sources":
      return {
        status: 200,
        body: {
          splunk: { connected: splunkConnected(), expired: splunkExpired() },
          signoz: { enabled: signozEnabled() },
          slow_threshold_ms: config.prodErrors.slowThresholdMs,
        },
      };
    case "splunk": {
      if (!splunkConnected())
        return fail(
          424,
          "provider_rejected",
          splunkExpired() ? "phiên Splunk hết hạn" : "chưa kết nối Splunk",
        );
      try {
        const r = await splunkSearch(
          {
            query: buildScanSpl(w, ns),
            since_minutes: w.minutes,
            until_minutes: w.untilMinutes,
            max_results: 300,
            timeout_seconds: config.prodErrors.timeoutSeconds,
          },
          progressWriter(job.id, fence),
        );
        return { status: 200, body: { results: r.results ?? [], messages: r.messages ?? [] } };
      } catch (e) {
        return providerFailure("splunk", e);
      }
    }
    case "signoz-errors": {
      if (!signozEnabled()) return fail(424, "provider_rejected", "SigNoz is not connected");
      try {
        const spans = await signozErrorSpanGroups(
          win,
          base,
          ns.map((n) => n.namespace),
        );
        const notes = [
          ...(spans.truncated ? [SIGNOZ_TRUNCATED] : []),
          ...(spans.hasBaseline ? [] : [SIGNOZ_NO_BASELINE]),
        ];
        return {
          status: 200,
          body: {
            rows: signozRows(spans.today, spans.yesterday, spans.samples, spans.hasBaseline),
            has_baseline: spans.hasBaseline,
            notes,
          },
        };
      } catch (e) {
        return providerFailure("signoz", e);
      }
    }
    case "signoz-slow": {
      const threshold = config.prodErrors.slowThresholdMs;
      if (!threshold) return { status: 200, body: { rows: [] } };
      try {
        const slow = await signozSlowRequestGroups(
          win,
          base,
          ns.map((n) => n.namespace),
          threshold,
        );
        const rows = signozSlowRows(slow.today, slow.yesterday, slow.samples, threshold);
        if (input.has_baseline === false) for (const r of rows) r.no_baseline = true;
        return { status: 200, body: { rows } };
      } catch (e) {
        return providerFailure("signoz", e);
      }
    }
    case "signoz-trace-gaps": {
      const trace = String(input.trace_id ?? "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(trace))
        return fail(400, "invalid_request", "invalid trace_id");
      try {
        return { status: 200, body: { gaps: maskGaps(await signozTraceGaps(win, trace)) } };
      } catch (e) {
        return providerFailure("signoz", e);
      }
    }
    case "finalize": {
      if (input.outcome === "failed") {
        if (job.trigger === "schedule")
          await notifyFailure(w.day, w.hm, String(input.error ?? "").slice(0, 2000));
        return { status: 200, body: { notified: 0 } };
      }
      const published = await one(
        pool,
        "SELECT 1 FROM prod_error_scans WHERE id=$1 AND stage='published'",
        [job.id],
      );
      if (!published)
        return fail(409, "not_published", "finalize before the groups were published");
      return { status: 200, body: { notified: await finalizeScan(job.id, job.trigger, w) } };
    }
  }
  return fail(404, "not_found", "unknown operation");
}

/** Handles /internal/* on the platform server. Returns false for any other path. */
export async function handleInternal(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!url.pathname.startsWith("/internal/")) return false;
  const send = (r: Reply) => {
    res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", ...r.headers });
    res.end(JSON.stringify(r.body));
  };
  if (!loopback(req)) return (send(fail(403, "forbidden", "internal API is loopback only")), true);
  if (!authorized(req))
    return (send(fail(401, "unauthorized", "missing or invalid bearer token")), true);
  const m = /^\/internal\/v1\/prod-errors\/scans\/(\d+)\/([a-z-]+)$/.exec(url.pathname);
  if (req.method !== "POST" || !m) return (send(fail(404, "not_found", "not found")), true);
  let input: Record<string, unknown>;
  try {
    input = await body(req);
  } catch {
    return (send(fail(400, "invalid_request", "invalid JSON body")), true);
  }
  const fence = Number(input.fence);
  if (!Number.isSafeInteger(fence) || fence < 1)
    return (send(fail(400, "invalid_request", "fence is required")), true);
  const admitted = await admit(Number(m[1]), fence);
  if (!("job" in admitted)) {
    count(`${m[2]}:${(admitted.body as { code: string }).code}`);
    return (send(admitted), true);
  }
  const { job } = admitted;
  const reply = await execution.run({ userId: job.requested_by!, kind: "user" }, async () => {
    await loadPersonalIntegrations();
    return operate(m[2], job, fence, input);
  });
  count(`${m[2]}:${reply.status}`);
  send(reply);
  return true;
}
