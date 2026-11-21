import { execution, currentUserId } from "../auth/execution.ts";
import { config, codeIntelligenceEnabled } from "../config.ts";
import { repositories } from "../repos/service.ts";
import { validateCheckout } from "../repos/paths.ts";
import { prepareRepository, checkoutForRun } from "../repos/workspaces.ts";
import { workspacesOf } from "../git/provider.ts";
import { ownsInstance, instanceSession } from "../instances.ts";
import { retrievalService } from "../retrieval/semantic.ts";
import { pool, one, q, type Db } from "../db/pool.ts";
import { realpath } from "node:fs/promises";
import { git, baseCommit } from "./git.ts";
import type { Snapshot } from "./store.ts";
import { parserVersion } from "./parser.ts";
import { backgroundDelegate, canSyncFor } from "../repos/backgroundGit.ts";

export async function enqueue(repoName: string, runId?: number) {
  if (!codeIntelligenceEnabled()) return null;
  const repo = await repositories.get(repoName);
  if (!repo?.enabled || !repo.allowed_actions.includes("read"))
    throw new Error("Repository unavailable or unauthorized");
  if (repo.provider === "benchmark") return null; // Evaluation steps refresh their own isolated snapshots synchronously.
  if (runId) {
    const run = await one(
      pool,
      "SELECT worker_instance,allowed_repositories FROM workflow_runs WHERE id=$1",
      [runId],
    );
    if (run?.worker_instance !== config.instanceId || !run.allowed_repositories.includes(repoName))
      throw new Error("Unauthorized index worktree");
  }
  // Nobody asked in person (startup, idle, search refresh): run as a user who consented to background Git sync.
  const requester = currentUserId() ?? (runId ? null : await backgroundDelegate(repo));
  const delegated = !currentUserId() && requester != null;
  return one(
    pool,
    `INSERT INTO code_intelligence.runs(repository_id,instance_id,run_id,scope_key,requested_by,delegated) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(repository_id,instance_id,scope_key) WHERE status IN ('queued','running') DO UPDATE SET requested_at=now(),
      requested_by=COALESCE(excluded.requested_by, code_intelligence.runs.requested_by),
      delegated=CASE WHEN excluded.requested_by IS NULL THEN code_intelligence.runs.delegated ELSE excluded.delegated END
    RETURNING id,status`,
    [repo.id, config.instanceId, runId ?? null, runId ? `run:${runId}` : "base", requester, delegated],
  );
}
export async function localScope(
  repoName: string,
  runId?: number,
  provision = false,
  workspacePath?: string,
) {
  const repo = await repositories.get(repoName);
  if (!repo?.enabled || !repo.allowed_actions.includes("read"))
    throw new Error("Repository unavailable or unauthorized");
  const existing = runId ? await checkoutForRun(repo, runId) : undefined;
  const primary = provision
    ? await prepareRepository(repo, false, existing)
    : await validateCheckout(repo, existing);
  if (!runId) return { repo, root: primary, primary };
  const run = await one(
    pool,
    "SELECT worker_instance,allowed_repositories FROM workflow_runs WHERE id=$1",
    [runId],
  );
  if (run?.worker_instance !== config.instanceId || !run.allowed_repositories.includes(repoName))
    throw new Error("Unauthorized index worktree");
  const listed = await workspacesOf(runId);
  const ws = workspacePath
    ? listed.find((w) => w.repo === repoName && w.path === workspacePath)
    : listed.find((w) => w.repo === repoName);
  if (!ws) throw new Error("Worktree unavailable");
  const root = await realpath(ws.path);
  const common = (
    await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  if (
    common !==
    (await git(primary, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  )
    throw new Error("Worktree repository mismatch");
  return { repo, root, primary };
}
export async function indexRepository(
  repoName: string,
  runId?: number,
  signal?: AbortSignal,
  fence?: { id: number; token: number },
  workspacePath?: string,
  /** false: index the checkout already in the platform workspace, without contacting the remote (no credentials). */
  provision = true,
): Promise<{ snapshot: Snapshot; metrics: Record<string, number> }> {
  const start = Date.now();
  const metrics: Record<string, number> = {
    indexed_files: 0,
    skipped_files: 0,
    parse_failures: 0,
    index_cache_hits: 0,
  };
  const scope = await localScope(repoName, runId, provision, workspacePath);
  const base = await baseCommit(scope.primary, scope.repo.default_branch || config.baseBranch);
  // Extraction, snapshots and publication run in platform-go (go/internal/codeintelligence); the lease, heartbeat,
  // authorization and checkout stay here, and the fence travels with the request.
  const out = await indexWithGo(scope.repo.id, scope.primary, scope.root, base, runId, signal, fence);
  return { ...out, metrics: { ...metrics, ...out.metrics, index_duration: Date.now() - start } };
}

/** The code-intelligence-v1 IndexRequest (go/contracts/code-intelligence-v1.schema.json). */
/** Indexing limits as platform-go reads them (indexing and search requests). */
export function goLimits() {
  const ci = config.codeIntelligence;
  return {
    max_file_bytes: ci.maxFileBytes,
    max_symbols: ci.maxSymbols,
    max_files: ci.maxFiles,
    max_scan_bytes: ci.maxScanBytes,
    timeout_ms: ci.timeoutMs,
    excludes: ci.excludes,
    include_generated: ci.includeGenerated,
    include_dependencies: ci.includeDependencies,
  };
}

export function goIndexRequest(
  repositoryId: number,
  primary: string,
  root: string,
  base: string,
  runId: number | undefined,
  fence: { id: number; token: number } | undefined,
) {
  return {
    repository_id: repositoryId,
    primary,
    root,
    base,
    run_id: runId ?? null,
    parser_version: parserVersion(),
    instance_id: config.instanceId,
    fence: fence
      ? { ...fence, instance_id: config.instanceId, instance_session: instanceSession }
      : null,
    limits: goLimits(),
  };
}

/**
 * The same job run by platform-go (go/internal/codeintelligence): identical extraction and index version, so its
 * snapshots and extraction cache are shared with this implementation. The lease, heartbeat and authorization stay
 * here; the fence travels with the request and is re-checked by Go when it publishes.
 */
async function indexWithGo(
  repositoryId: number,
  primary: string,
  root: string,
  base: string,
  runId: number | undefined,
  signal: AbortSignal | undefined,
  fence: { id: number; token: number } | undefined,
) {
  const res = await retrievalService(
    "/internal/v1/code-intelligence/index",
    goIndexRequest(repositoryId, primary, root, base, runId, fence),
    config.codeIntelligence.timeoutMs + 10_000,
    signal,
  );
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(String(body?.error ?? `platform-go index failed (HTTP ${res.status})`));
  return body as { snapshot: Snapshot; metrics: Record<string, number> };
}

interface IndexRunJob {
  id: number;
  repository_id: number;
  run_id: number | null;
  requested_by: number | null;
  delegated?: boolean;
  fencing_token: number;
  request_marker: string;
}

let active = 0;
/** Idle work in the existing scheduler; durable PostgreSQL leases survive process crashes. */
export async function runIndexOnce(signal?: AbortSignal) {
  if (!codeIntelligenceEnabled() || active >= config.codeIntelligence.concurrency) return false;
  active++;
  let job: IndexRunJob | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const ac = new AbortController();
  const abort = () => ac.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (!(await ownsInstance())) return false;
    if (signal?.aborted) return false;
    await q(
      pool,
      `UPDATE code_intelligence.runs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
      fencing_token=fencing_token+1,error='Index worker lease expired',updated_at=now() WHERE instance_id=$1 AND status='running' AND lease_expires_at<now()`,
      [config.instanceId],
    );
    const claimed = await one<IndexRunJob>(
      pool,
      `UPDATE code_intelligence.runs SET status='running',attempts=attempts+1,fencing_token=fencing_token+1,
      lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=(SELECT id FROM code_intelligence.runs
      WHERE instance_id=$1 AND status='queued' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *, requested_at::text AS request_marker`,
      [config.instanceId],
    );
    job = claimed;
    if (!claimed) return false;
    heartbeat = setInterval(() => {
      void (async () => {
        if (
          !(await ownsInstance()) ||
          !(await one(
            pool,
            `UPDATE code_intelligence.runs SET lease_expires_at=now()+interval '60 seconds' WHERE id=$1 AND fencing_token=$2 AND status='running' RETURNING id`,
            [claimed.id, claimed.fencing_token],
          ))
        )
          ac.abort();
      })().catch(() => ac.abort());
    }, 10000);
    const repo = await one(pool, "SELECT name FROM repositories WHERE id=$1", [
      claimed.repository_id,
    ]);
    let owner = claimed.run_id
      ? (await one(pool, "SELECT owner_id FROM workflow_runs WHERE id=$1", [claimed.run_id]))
          ?.owner_id
      : claimed.requested_by;
    if (owner && !(await one(pool, "SELECT id FROM users WHERE id=$1 AND active", [owner])))
      throw new Error("Index requester is inactive");
    // A delegated job uses the consent of then: still consented, token present and read access now, else no account.
    if (owner && claimed.delegated && !claimed.run_id) {
      const row = await repositories.get(repo!.name);
      if (!row || !(await canSyncFor(Number(owner), row))) owner = null;
    }
    // Without an account the remote is never contacted: the checkout already in the workspace is indexed as it is.
    const execute = () =>
      indexRepository(
        repo!.name,
        claimed.run_id ?? undefined,
        ac.signal,
        { id: claimed.id, token: claimed.fencing_token },
        undefined,
        !!owner,
      );
    const out = owner
      ? await execution.run(
          {
            userId: Number(owner),
            kind: claimed.run_id ? "run" : "user",
            runId: claimed.run_id ?? undefined,
          },
          execute,
        )
      : await execute();
    await q(
      pool,
      `UPDATE code_intelligence.runs SET status=CASE WHEN requested_at>$5::timestamptz THEN 'queued' ELSE 'done' END,attempts=CASE WHEN requested_at>$5::timestamptz THEN 0 ELSE attempts END,snapshot_id=$3,metrics=$4,error=NULL,updated_at=now() WHERE id=$1 AND fencing_token=$2 AND status='running'`,
      [
        claimed.id,
        claimed.fencing_token,
        out.snapshot.id,
        JSON.stringify(out.metrics),
        claimed.request_marker,
      ],
    );
    // Completed overlays only; never remove a snapshot that is still referenced as a base or by a live run.
    await q(
      pool,
      `DELETE FROM code_intelligence.snapshots s WHERE s.instance_id=$1 AND s.run_id IS NOT NULL
      AND s.created_at<now()-make_interval(days=>$2) AND NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.id=s.run_id AND r.status NOT IN ('COMPLETED','FAILED','CANCELED'))`,
      [config.instanceId, config.codeIntelligence.retentionDays],
    );
    return true;
  } catch (e) {
    if (job)
      await q(
        pool,
        `UPDATE code_intelligence.runs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
      error=$3,available_at=now()+interval '10 seconds',updated_at=now() WHERE id=$1 AND fencing_token=$2 AND status='running'`,
        [job.id, job.fencing_token, diagnostic(e)],
      );
    return !!job;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    active--;
    signal?.removeEventListener("abort", abort);
  }
}
export function diagnostic(e: unknown) {
  // Child-process errors may embed source or credentials. Persist categories only.
  if ((e as NodeJS.ErrnoException)?.code === "EACCES") return "Indexing source permission denied";
  const message = (e as Error)?.message ?? "";
  // A job without a requesting user has no Git credentials (another member's token is never borrowed).
  if (/authentication required|no .*credential/i.test(message))
    return "Indexing needs Git credentials: queue the reindex from the repository page so it runs with your Integrations token";
  if (/unavailable locally/i.test(message))
    return "Not in the platform workspace yet and no account for background sync: press Sync on the repository page, or enable background sync in Integrations";
  if (/GitLab host>|repository URL|Use https:\/\//i.test(message))
    return "Indexing needs a valid repository URL: fix it on the repository page";
  for (const name of [
    "limit exceeded",
    "timeout",
    "lease lost",
    "changed while indexing",
    "unauthorized",
    "unavailable",
    "mismatch",
  ])
    if (message.toLowerCase().includes(name)) return `Indexing ${name}`;
  return "Indexing failed; check local parser/database/Git availability";
}
interface IndexStatusRow {
  name: string;
  commit_sha: string | null;
  indexed_files: number | null;
  symbol_count: number | null;
  relation_count: number | null;
  last_indexed_at: Date | null;
  indexing_run_id: number | null;
  status: string | null;
  last_indexing_error: string | null;
  metrics: unknown;
  updated_at: Date | null;
}

export async function status() {
  return q<IndexStatusRow>(
    pool,
    `SELECT r.name, s.commit_sha,s.indexed_files,s.symbol_count,s.relation_count,s.created_at AS last_indexed_at,
    j.id AS indexing_run_id,j.status,j.error AS last_indexing_error,j.metrics,j.updated_at
    FROM repositories r
    LEFT JOIN LATERAL(SELECT * FROM code_intelligence.snapshots WHERE repository_id=r.id AND base_snapshot_id IS NULL AND index_version=$2 ORDER BY id DESC LIMIT 1)s ON true
    LEFT JOIN LATERAL(SELECT * FROM code_intelligence.runs WHERE repository_id=r.id AND instance_id=$1 AND run_id IS NULL ORDER BY id DESC LIMIT 1)j ON true ORDER BY r.name`,
    [config.instanceId, parserVersion()],
  );
}

export async function cancelLocalIndexRun(id: number, db: Db = pool) {
  await q(
    db,
    "UPDATE code_intelligence.runs SET status='canceled', fencing_token=fencing_token+1,updated_at=now() WHERE id=$1 AND instance_id=$2 AND status IN ('queued','running')",
    [id, config.instanceId],
  );
}
