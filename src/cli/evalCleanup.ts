/**
 * Lists live-evaluation leftovers under <dataDir>/evaluation-work and, with --yes, removes those of COMPLETED or
 * CANCELED runs (never FAILED: it can be retried). --case=<case_run_id> --yes removes that one case regardless.
 */
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool, q } from "../db/pool.ts";
import { cleanupLiveWork, postmasterRunning } from "../eval/liveCase.ts";

const exec = promisify(execFile);
const subdirectories = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
const sizeKb = async (path: string) =>
  Number((await exec("du", ["-sk", path]).catch(() => ({ stdout: "" }))).stdout.split("\t")[0]) ||
  0;

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
    const databases = (await subdirectories(live))
      .filter((n) => /^database-[0-9a-f-]{36}$/.test(n))
      .map((n) => join(live, n));
    const entry = {
      path: live,
      evaluation_id: evaluation,
      case_run_id: caseRun,
      run_status: row?.run_status ?? null,
      case_status: row?.case_status ?? null,
      size_kb: await sizeKb(live),
      databases: [] as Array<{ path: string; postmaster: boolean; size_kb: number }>,
      removed: false,
      note: null as string | null,
    };
    for (const path of databases)
      entry.databases.push({
        path,
        postmaster: await postmasterRunning(path),
        size_kb: await sizeKb(path),
      });
    report.push(entry);
    const selected = options.caseRunId
      ? options.caseRunId === caseRun
      : ["COMPLETED", "CANCELED"].includes(entry.run_status);
    if (!options.yes || !selected) continue;
    for (const db of entry.databases.filter((d) => d.postmaster))
      await exec("pg_ctl", ["stop", "-D", db.path, "-m", "fast", "-w"], { timeout: 60000 }).catch(
        () => {},
      );
    const serving = [];
    for (const db of entry.databases) if (await postmasterRunning(db.path)) serving.push(db.path);
    if (serving.length) {
      entry.note = `postmaster still running: ${serving.join(", ")}`;
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
  const caseRunId = process.argv.find((a) => a.startsWith("--case="))?.slice(7);
  try {
    const report = await evalCleanup({ yes: process.argv.includes("--yes"), caseRunId });
    console.log(JSON.stringify(report, null, 2));
    if (!process.argv.includes("--yes"))
      console.log(
        "Dry run: nothing removed. Re-run with --yes (COMPLETED/CANCELED runs) or --case=<id> --yes.",
      );
  } finally {
    await pool.end();
  }
}
