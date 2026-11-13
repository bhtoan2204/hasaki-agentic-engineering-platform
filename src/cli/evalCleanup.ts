/**
 * Lists live-evaluation leftovers under <dataDir>/evaluation-work and, with --yes, removes those of COMPLETED or
 * CANCELED runs (never FAILED: it can be retried). --case=<case_run_id> --yes removes that one case regardless.
 */
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool, q } from "../db/pool.ts";
import {
  cleanupLiveWork,
  liveDatabases,
  postmasterRunning,
  stopPostmaster,
} from "../eval/liveCase.ts";

const exec = promisify(execFile);
const subdirectories = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
const sizesKb = async (path: string) =>
  new Map(
    (await exec("du", ["-k", "--max-depth=1", path]).catch(() => ({ stdout: "" }))).stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [size, ...name] = line.split("\t");
        return [name.join("\t"), Number(size) || 0];
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
const runActive = async (runId: unknown) =>
  !!(
    await q(
      pool,
      `SELECT 1 FROM workflow_jobs j WHERE j.run_id=$1 AND (j.status IN ('queued','running')
       OR (j.lease_expires_at>now() AND EXISTS (SELECT 1 FROM workflow_step_attempts a WHERE a.job_id=j.id AND a.executor_stopped_at IS NULL)))
     UNION ALL SELECT 1 FROM workflow_step_attempts WHERE run_id=$1 AND status='RUNNING' LIMIT 1`,
      [runId],
    )
  )[0];

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
      size_kb: sizes.get(live) ?? 0,
      databases: [] as Array<{ path: string; postmaster: boolean; size_kb: number }>,
      removed: false,
      note: null as string | null,
    };
    for (const path of await liveDatabases(live))
      entry.databases.push({
        path,
        postmaster: await postmasterRunning(path),
        size_kb: sizes.get(path) ?? 0,
      });
    report.push(entry);
    const selected = options.caseRunId
      ? options.caseRunId === caseRun
      : ["COMPLETED", "CANCELED"].includes(entry.run_status);
    if (!options.yes || !selected) continue;
    // Cancel flips jobs and attempts at once; the executor may still be writing until it records its stop.
    if (row && (await runActive(row.workflow_run_id))) {
      entry.note = "still active; retry later";
      continue;
    }
    try {
      for (const db of entry.databases) await stopPostmaster(db.path);
    } catch (error) {
      entry.note = (error as Error).message;
      continue;
    }
    if (row) await cleanupLiveWork(Number(row.workflow_run_id), live);
    else await rm(live, { recursive: true, force: true });
    entry.removed = true;
    for (const dir of [join(root, evaluation, caseRun), join(root, evaluation)])
      await rmdir(dir).catch(() => {});
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
      if (!options.yes)
        console.log(
          "Dry run: nothing removed. Re-run with --yes (COMPLETED/CANCELED runs) or --case=<id> --yes.",
        );
    }
  } finally {
    await pool.end();
  }
}
