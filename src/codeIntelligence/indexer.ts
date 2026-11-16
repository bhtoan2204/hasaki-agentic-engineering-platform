import { execution, currentUserId } from "../auth/execution.ts";
import { config, codeIntelligenceEnabled } from "../config.ts";
import { repositories } from "../repos/service.ts";
import { validateCheckout } from "../repos/paths.ts";
import { prepareRepository, checkoutForRun } from "../repos/workspaces.ts";
import { workspacesOf } from "../git/provider.ts";
import { ownsInstance } from "../instances.ts";
import { pool, one, q } from "../db/pool.ts";
import { realpath } from "node:fs/promises";
import {
  git,
  baseCommit,
  treeFiles,
  changes,
  readBlobs,
  hash,
  languageOf,
} from "./git.ts";
import {
  snapshot,
  filesOf,
  extractionBatch,
  publish,
  type FileRecord,
} from "./store.ts";
import { parserVersion, ParserLoadError } from "./parser.ts";

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
    if (
      run?.worker_instance !== config.instanceId ||
      !run.allowed_repositories.includes(repoName)
    )
      throw new Error("Unauthorized index worktree");
  }
  return one(
    pool,
    `INSERT INTO code_intelligence.runs(repository_id,instance_id,run_id,scope_key,requested_by) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(repository_id,instance_id,scope_key) WHERE status IN ('queued','running') DO UPDATE SET requested_at=now(),requested_by=excluded.requested_by RETURNING id,status`,
    [
      repo.id,
      config.instanceId,
      runId ?? null,
      runId ? `run:${runId}` : "base",
      currentUserId(),
    ],
  );
}
export async function localScope(repoName: string, runId?: number, provision = false) {
  const repo = await repositories.get(repoName);
  if (!repo?.enabled || !repo.allowed_actions.includes("read"))
    throw new Error("Repository unavailable or unauthorized");
  const existing = runId ? await checkoutForRun(repo, runId) : undefined;
  const primary = provision ? await prepareRepository(repo, false, existing) : await validateCheckout(repo, existing);
  if (!runId) return { repo, root: primary, primary };
  const run = await one(
    pool,
    "SELECT worker_instance,allowed_repositories FROM workflow_runs WHERE id=$1",
    [runId],
  );
  if (
    run?.worker_instance !== config.instanceId ||
    !run.allowed_repositories.includes(repoName)
  )
    throw new Error("Unauthorized index worktree");
  const ws = (await workspacesOf(runId)).find((w) => w.repo === repoName);
  if (!ws) throw new Error("Worktree unavailable");
  const root = await realpath(ws.path);
  const common = (
    await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  if (
    common !==
    (
      await git(primary, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim()
  )
    throw new Error("Worktree repository mismatch");
  return { repo, root, primary };
}
export async function indexRepository(
  repoName: string,
  runId?: number,
  signal?: AbortSignal,
  fence?: { id: number; token: number },
) {
  const start = Date.now();
  const metrics: Record<string, number> = {
    indexed_files: 0,
    skipped_files: 0,
    parse_failures: 0,
    index_cache_hits: 0,
  };
  const scope = await localScope(repoName, runId, true);
  const progress = async (processed: number, total: number) => {
    if (!fence) return;
    const row = await one(
      pool,
      `UPDATE code_intelligence.runs SET metrics=$3,updated_at=now()
      WHERE id=$1 AND fencing_token=$2 AND status='running' RETURNING id`,
      [
        fence.id,
        fence.token,
        JSON.stringify({
          ...metrics,
          processed_files: processed,
          total_files: total,
        }),
      ],
    );
    if (!row) throw new Error("Index lease lost");
  };
  const base = await baseCommit(scope.primary, scope.repo.default_branch || config.baseBranch);
  let baseline = await snapshot(scope.repo.id, `base:${base}`);
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() - start > config.codeIntelligence.timeoutMs)
      throw new Error("Index timeout");
  };
  if (!baseline) {
    const manifest = await treeFiles(scope.primary, base, metrics);
    const prior = await one(
      pool,
      `SELECT id FROM code_intelligence.snapshots WHERE repository_id=$1 AND base_snapshot_id IS NULL AND index_version=$2 ORDER BY id DESC LIMIT 1`,
      [scope.repo.id, parserVersion()],
    );
    const previous = new Map(
      (prior ? await filesOf(prior.id) : []).map((f) => [f.file_path, f]),
    );
    const files: FileRecord[] = [];
    const byBlob = new Map(
      [...previous.values()].map((f) => [
        `${languageOf(f.file_path)}:${f.blob_hash}`,
        f.extraction_id,
      ]),
    );
    for (let offset = 0; offset < manifest.length; offset += 100) {
      check();
      await progress(offset, manifest.length);
      const batch = manifest.slice(offset, offset + 100);
      const pending = batch.filter(
        (f) => !byBlob.has(`${languageOf(f.path)}:${f.blob}`),
      );
      const sources = pending.length
        ? await readBlobs(
          scope.primary,
          pending.map((f) => f.blob),
          signal,
        )
        : [];
      const ids = await extractionBatch(
        pending.map((f, i) => ({ path: f.path, source: sources[i] })),
        metrics,
        signal,
        start + config.codeIntelligence.timeoutMs,
      );
      for (const f of batch) {
        const at = pending.indexOf(f);
        const id = byBlob.has(`${languageOf(f.path)}:${f.blob}`)
          ? byBlob.get(`${languageOf(f.path)}:${f.blob}`)!
          : (ids.get(`${languageOf(f.path)}:${hash(sources[at])}`) ?? null);
        if (byBlob.has(`${languageOf(f.path)}:${f.blob}`))
          metrics.index_cache_hits++;
        files.push({
          file_path: f.path,
          blob_hash: f.blob,
          extraction_id: id,
          deleted: false,
        });
      }
    }
    baseline = await publish(
      {
        repository_id: scope.repo.id,
        commit_sha: base,
        identity: `base:${base}`,
      },
      files,
      fence,
    );
  }
  let result = baseline;
  if (runId) {
    const state = await changes(scope.root, base);
    const identity = `overlay:${config.instanceId}:${runId}:${baseline.id}:${state.generation}`;
    result = (await snapshot(scope.repo.id, identity)) ?? null!;
    if (!result) {
      const files: FileRecord[] = [];
      for (let offset = 0; offset < state.files.length; offset += 100) {
        check();
        await progress(offset, state.files.length);
        const batch = state.files.slice(offset, offset + 100);
        const ids = await extractionBatch(
          batch
            .filter((f) => f.content !== null)
            .map((f) => ({ path: f.path, source: f.content! })),
          metrics,
          signal,
          start + config.codeIntelligence.timeoutMs,
        );
        for (const f of batch)
          files.push({
            file_path: f.path,
            blob_hash: f.hash,
            extraction_id:
              f.content === null
                ? null
                : (ids.get(`${languageOf(f.path)}:${f.hash}`) ?? null),
            deleted: f.content === null,
          });
      }
      result = await publish(
        {
          repository_id: scope.repo.id,
          commit_sha: state.head,
          identity,
          base_snapshot_id: baseline.id,
          instance_id: config.instanceId,
          run_id: runId,
          generation: state.generation,
        },
        files,
        fence,
        async () => {
          check();
          if ((await changes(scope.root, base)).generation !== state.generation)
            throw new Error("Worktree changed while indexing");
        },
      );
    }
  }
  metrics.indexed_files = (await one(
    pool,
    "SELECT indexed_files FROM code_intelligence.snapshots WHERE id=$1",
    [result.id],
  ))!.indexed_files;
  metrics.index_duration = Date.now() - start;
  return { snapshot: result, metrics };
}

let active = 0;
/** Idle work in the existing scheduler; durable PostgreSQL leases survive process crashes. */
export async function runIndexOnce(signal?: AbortSignal) {
  if (
    !codeIntelligenceEnabled() ||
    active >= config.codeIntelligence.concurrency
  )
    return false;
  active++;
  let job: any;
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
    job = await one(
      pool,
      `UPDATE code_intelligence.runs SET status='running',attempts=attempts+1,fencing_token=fencing_token+1,
      lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=(SELECT id FROM code_intelligence.runs
      WHERE instance_id=$1 AND status='queued' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *, requested_at::text AS request_marker`,
      [config.instanceId],
    );
    if (!job) return false;
    heartbeat = setInterval(() => {
      void (async () => {
        if (
          !(await ownsInstance()) ||
          !(await one(
            pool,
            `UPDATE code_intelligence.runs SET lease_expires_at=now()+interval '60 seconds' WHERE id=$1 AND fencing_token=$2 AND status='running' RETURNING id`,
            [job.id, job.fencing_token],
          ))
        )
          ac.abort();
      })().catch(() => ac.abort());
    }, 10000);
    const repo = await one(pool, "SELECT name FROM repositories WHERE id=$1", [
      job.repository_id,
    ]);
    const owner = job.run_id ? (await one(pool, "SELECT owner_id FROM workflow_runs WHERE id=$1", [job.run_id]))?.owner_id : job.requested_by;
    if (owner && !(await one(pool, "SELECT id FROM users WHERE id=$1 AND active", [owner]))) throw new Error("Index requester is inactive");
    const execute = () => indexRepository(repo!.name, job.run_id ?? undefined, ac.signal, { id: job.id, token: job.fencing_token });
    const out = owner ? await execution.run({ userId: Number(owner), kind: job.run_id ? "run" : "user", runId: job.run_id ?? undefined }, execute) : await execute();
    await q(
      pool,
      `UPDATE code_intelligence.runs SET status=CASE WHEN requested_at>$5::timestamptz THEN 'queued' ELSE 'done' END,attempts=CASE WHEN requested_at>$5::timestamptz THEN 0 ELSE attempts END,snapshot_id=$3,metrics=$4,error=NULL,updated_at=now() WHERE id=$1 AND fencing_token=$2 AND status='running'`,
      [
        job.id,
        job.fencing_token,
        out.snapshot.id,
        JSON.stringify(out.metrics),
        job.request_marker,
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
  if (e instanceof ParserLoadError)
    return `${e.message}; check installed WASM assets`;
  if ((e as NodeJS.ErrnoException)?.code === "EACCES")
    return "Indexing source permission denied";
  const message = (e as Error)?.message ?? "";
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
export async function status() {
  return q(
    pool,
    `SELECT r.name, s.commit_sha,s.indexed_files,s.symbol_count,s.relation_count,s.created_at AS last_indexed_at,
    j.id AS indexing_run_id,j.status,j.error AS last_indexing_error,j.metrics,j.updated_at
    FROM repositories r
    LEFT JOIN LATERAL(SELECT * FROM code_intelligence.snapshots WHERE repository_id=r.id AND base_snapshot_id IS NULL AND index_version=$2 ORDER BY id DESC LIMIT 1)s ON true
    LEFT JOIN LATERAL(SELECT * FROM code_intelligence.runs WHERE repository_id=r.id AND instance_id=$1 AND run_id IS NULL ORDER BY id DESC LIMIT 1)j ON true ORDER BY r.name`,
    [config.instanceId, parserVersion()],
  );
}
