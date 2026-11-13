/**
 * Lists live-evaluation leftovers under <dataDir>/evaluation-work and, with --yes, removes those of COMPLETED or
 * CANCELED runs (never FAILED: it can be retried). --case=<case_run_id> --yes removes that one case regardless.
 */
import { lstat, rmdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool, q } from "../db/pool.ts";
import {
  cleanupLiveWork,
  liveDatabases,
  postmasterState,
  subdirectories,
} from "../eval/liveCase.ts";

const exec = promisify(execFile);
const sizesKb = async (path: string) =>
  new Map(
    (await exec("du", ["-k", "--max-depth=1", path]).catch(() => ({ stdout: "" }))).stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [size, ...name] = line.split("\t");
        return [name.join("\t"), Number.isFinite(Number(size)) ? Number(size) : null];
      }),
  );
const USAGE = "Usage: eval:cleanup [--yes] [--case <case_run_id>]";
export function parseCleanupArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { yes: { type: "boolean" }, case: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.case !== undefined && !/^\d+$/.test(values.case))
    throw new Error(`invalid --case ${values.case}`);
  return { yes: values.yes ?? false, caseRunId: values.case };
}
// Cancel bumps the fencing token so leases stop renewing: give a stopping executor one more lease.
const caseActive = async (caseRunId: string): Promise<"running" | "stopping" | undefined> =>
  (
    await q(
      pool,
      `SELECT CASE WHEN j.status='queued' OR (j.status='running' AND j.lease_expires_at>now())
         THEN 'running' ELSE 'stopping' END AS state
       FROM evaluation_case_runs cr JOIN evaluation_runs e ON e.id=cr.evaluation_id
       JOIN workflow_steps s ON s.run_id=e.workflow_run_id AND (s.key=cr.workflow_step_key
         OR s.key IN (SELECT step_key FROM evaluation_provider_phases WHERE case_run_id=cr.id))
       JOIN workflow_jobs j ON j.step_id=s.id
       WHERE cr.id=$1 AND (j.status='queued' OR (j.status='running' AND j.lease_expires_at>now())
         OR (j.lease_expires_at>now()-make_interval(secs=>$2)
           AND EXISTS (SELECT 1 FROM workflow_step_attempts a WHERE a.job_id=j.id AND a.executor_stopped_at IS NULL)))
       ORDER BY 1 LIMIT 1`,
      [caseRunId, config.scheduler.leaseSeconds],
    )
  )[0]?.state;

export async function evalCleanup(
  options: { yes?: boolean; caseRunId?: string } = {},
  root = join(config.dataDir, "evaluation-work"),
) {
  const found = [];
  for (const evaluation of (await subdirectories(root)).filter((n) => /^\d+$/.test(n)))
    for (const caseRun of (await subdirectories(join(root, evaluation))).filter((n) =>
      /^\d+$/.test(n),
    )) {
      const live = join(root, evaluation, caseRun, "live");
      if ((await lstat(live).catch(() => null))?.isDirectory())
        found.push({ evaluation, caseRun, live });
    }
  const rows = await q(
    pool,
    `SELECT cr.id::text AS case_run_id, cr.evaluation_id::text AS evaluation_id, e.workflow_run_id,
       r.status AS run_status, s.status AS case_status
     FROM evaluation_case_runs cr JOIN evaluation_runs e ON e.id=cr.evaluation_id
     JOIN workflow_runs r ON r.id=e.workflow_run_id
     LEFT JOIN workflow_steps s ON s.run_id=r.id AND s.key=cr.workflow_step_key
     WHERE cr.id=ANY($1::bigint[])`,
    [found.map((f) => f.caseRun)],
  );
  const report = [];
  for (const { evaluation, caseRun, live } of found) {
    const row = rows.find((r) => r.case_run_id === caseRun && r.evaluation_id === evaluation);
    const sizes = await sizesKb(live);
    const entry = {
      path: live,
      evaluation_id: evaluation,
      case_run_id: caseRun,
      run_status: row?.run_status ?? null,
      case_status: row?.case_status ?? null,
      size_kb: sizes.get(live) ?? null,
      databases: [] as Array<{ path: string; postmaster: string; size_kb: number | null }>,
      removed: false,
      failed: false,
      note: null as string | null,
    };
    for (const path of await liveDatabases(live))
      entry.databases.push({
        path,
        postmaster: await postmasterState(path),
        size_kb: sizes.get(path) ?? null,
      });
    report.push(entry);
    const selected = options.caseRunId
      ? options.caseRunId === caseRun
      : ["COMPLETED", "CANCELED"].includes(entry.run_status);
    if (!options.yes || !selected) continue;
    try {
      const active = row ? await caseActive(caseRun) : undefined;
      if (active === "running" || (active && !options.caseRunId)) {
        entry.note = "still active; retry later";
        entry.failed = true;
        continue;
      }
      if (active) entry.note = "warning: run may still be active";
      await cleanupLiveWork(row ? Number(row.workflow_run_id) : null, live);
      entry.removed = true;
      for (const dir of [join(root, evaluation, caseRun), join(root, evaluation)])
        await rmdir(dir).catch(() => {});
    } catch (error) {
      entry.note = [entry.note, (error as Error).message].filter(Boolean).join("; ");
      entry.failed = true;
    }
    for (const db of entry.databases) db.postmaster = await postmasterState(db.path);
  }
  return report;
}

if (process.argv[1]?.endsWith("evalCleanup.ts")) {
  let options: ReturnType<typeof parseCleanupArgs> | undefined;
  try {
    options = parseCleanupArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    process.exitCode = 2;
  }
  try {
    if (options) {
      const report = await evalCleanup(options);
      console.log(JSON.stringify(report, null, 2));
      if (report.some((e) => e.failed)) process.exitCode = 1;
      if (!options.yes)
        console.log(
          "Dry run: nothing removed. Re-run with --yes (COMPLETED/CANCELED runs) or --case=<id> --yes.",
        );
    }
  } finally {
    await pool.end();
  }
}
