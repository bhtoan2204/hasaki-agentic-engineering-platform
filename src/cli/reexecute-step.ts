/**
 * `npm run step:reexecute -- --run=<id> --step=<key> [--feedback="…"] [--once] [--skill=<key> …] [--by=<name>]`
 *
 * Re-execute one step of a run from the terminal, exactly like the "Re-execute" button: the step and everything
 * downstream are invalidated and re-queued; the running platform server's scheduler executes them.
 *   --feedback  instructions for the agent. Kept for the whole run as a developer decision (later steps and the
 *               automatic review → implement loop receive it) unless --once is given.
 *   --once      the feedback applies to this re-execution only.
 *   --skill     extra skill key pinned for this re-execution (repeatable).
 * Without --feedback the step simply re-runs with the run's existing developer decisions.
 */
import { pool, one } from "../db/pool.ts";
import { migrate } from "../db/migrate.ts";
import { config } from "../config.ts";
import { reexecuteStep, getRun } from "../workflow/engine.ts";
import { instanceHealth } from "../instances.ts";

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const all = (name: string) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const runId = Number(arg("run"));
const step = arg("step");
if (!Number.isInteger(runId) || runId <= 0 || !step) {
  console.error('usage: npm run step:reexecute -- --run=<id> --step=<key> [--feedback="…"] [--once] [--skill=<key>]');
  process.exit(2);
}

try {
  await migrate();
  const before = await one<{ worker_instance: string | null; status: string }>(
    pool,
    "SELECT worker_instance, status FROM workflow_runs WHERE id = $1",
    [runId],
  );
  if (!before) throw new Error(`run ${runId} not found`);
  const decisionsBefore = ((await getRun(runId)).inputs?.developer_decisions ?? []) as unknown[];
  const feedback = arg("feedback");
  await reexecuteStep(runId, step, {
    feedback,
    skills: all("skill"),
    by: arg("by") ?? process.env.USER ?? "cli",
    persist: !args.includes("--once"),
  });
  const run = await getRun(runId);
  const steps = (run.steps as any[]).map((s) => `${s.key}=${s.status}`).join("  ");
  const decisions = (run.inputs?.developer_decisions ?? []) as unknown[];
  console.log(`run #${runId} re-executed from "${step}" → run ${run.status}`);
  console.log(`steps: ${steps}`);
  console.log(
    `developer decisions on this run: ${decisions.length}${decisions.length > decisionsBefore.length ? " (this feedback was added)" : feedback ? " (feedback used for this re-execution only)" : ""}`,
  );
  // The work runs on the installation that owns the run; say so when nobody is there to pick it up.
  const health = await instanceHealth(before.worker_instance);
  if (health.health !== "ONLINE")
    console.warn(
      `note: the owning installation ${before.worker_instance ?? "(none)"} is ${health.health}; the step starts when its server (\`npm start\`) is running.`,
    );
  else console.log(`queued on ${before.worker_instance} (this machine: ${config.instanceId}); follow it in the UI: #/runs/${runId}/${step}`);
} catch (e) {
  console.error(`re-execute failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
