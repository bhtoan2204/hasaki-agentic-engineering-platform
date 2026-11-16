import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);

import { pool, one, q } from "../db/pool.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import { allWorkspacesOf, workspacesOf } from "../git/provider.ts";
import { worktreeFingerprint } from "./scopeGuard.ts";

export async function executionWorkspaces(ctx: ExecutionContext) {
  const repos =
    (ctx.step.config.scope as { repositories?: string[] } | undefined)?.repositories ??
    (ctx.input.execution_contract?.authorization?.mode === "workflow"
      ? ctx.run.selected_repositories
      : ctx.input.execution_contract?.selected_repositories) ??
    ctx.run.selected_repositories;
  const isolated = ctx.step.config.isolated_workspace === true;
  const subtask = ctx.step.subtask_id;
  if (isolated && !subtask) throw new Error("Isolated execution requires a subtask identity");
  return (
    isolated
      ? (await allWorkspacesOf(ctx.run.id)).filter((w) => w.subtask_id === subtask)
      : await workspacesOf(ctx.run.id)
  ).filter((w) => !repos.length || repos.includes(w.repo));
}
type Observation = Record<
  string,
  { path: string; head: string; fingerprint: string; content: string }
>;
/** Observe contents at lifecycle boundaries only; commits/index movements alone are not implementation. */
async function contentIdentity(path: string) {
  const { stdout } = await exec(
    "git",
    ["-C", path, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { maxBuffer: 64 << 20 },
  );
  const hash = createHash("sha256");
  for (const file of [...new Set(stdout.split("\0").filter(Boolean))].sort()) {
    const full = join(path, file),
      st = await lstat(full).catch(() => null);
    if (!st) continue;
    hash.update(file).update("\0").update(String(st.mode)).update("\0");
    if (st.isSymbolicLink()) hash.update(await readlink(full));
    else if (st.isFile()) hash.update(await readFile(full));
    else if (!st.isDirectory()) throw new Error("Unsupported implementation entry");
  }
  return hash.digest("hex");
}
export async function observeImplementation(ctx: ExecutionContext): Promise<Observation> {
  return Object.fromEntries(
    await Promise.all(
      (await executionWorkspaces(ctx)).map(async (w) => [
        w.repo,
        {
          path: w.path,
          ...(await worktreeFingerprint(w.path)),
          content: await contentIdentity(w.path),
        },
      ]),
    ),
  );
}

/** The first worker observation in this generation survives waiting, retries and provider handoffs. */
export async function implementationBaseline(ctx: ExecutionContext): Promise<Observation> {
  const prior = await loadImplementationBaseline(ctx.step.id, ctx.step.generation);
  if (prior) return prior;
  const source = ctx.input.execution_evidence_source;
  const baseline =
    (source ? await loadImplementationBaseline(ctx.step.id, source.generation) : null) ??
    (await observeImplementation(ctx));
  await ctx.artifact(
    "implementation_baseline",
    "initial implementation state",
    JSON.stringify(baseline),
    baseline,
  );
  return baseline;
}

export async function loadImplementationBaseline(
  stepId: number,
  generation: number,
): Promise<Observation | null> {
  const rows = await q<{ data: Observation }>(
    pool,
    `SELECT r.data FROM workflow_artifacts r JOIN workflow_step_attempts a ON a.id=r.attempt_id
     WHERE a.step_id=$1 AND a.generation=$2 AND r.kind='implementation_baseline' ORDER BY r.id`,
    [stepId, generation],
  );
  if (!rows.length) return null;
  const baseline: Observation = {};
  for (const row of rows)
    for (const [repo, state] of Object.entries(row.data)) baseline[repo] ??= state;
  return baseline;
}

/** Capture a newly allocated worktree before the preparation tool returns it to the agent. */
export async function recordPreparedBaseline(
  env: { runId: number; stepId: number; attemptId: number },
  workspace: { repo: string; path: string },
) {
  const attempt = await one<{ generation: number }>(
    pool,
    "SELECT generation FROM workflow_step_attempts WHERE id=$1",
    [env.attemptId],
  );
  if (
    !attempt ||
    (await loadImplementationBaseline(env.stepId, attempt.generation))?.[workspace.repo]
  )
    return;
  const observed = {
    [workspace.repo]: {
      path: workspace.path,
      ...(await worktreeFingerprint(workspace.path)),
      content: await contentIdentity(workspace.path),
    },
  };
  await q(
    pool,
    "INSERT INTO workflow_artifacts(run_id,step_id,attempt_id,kind,name,content,data) VALUES($1,$2,$3,'implementation_baseline','prepared implementation state',$4,$5)",
    [env.runId, env.stepId, env.attemptId, JSON.stringify(observed), JSON.stringify(observed)],
  );
}

export function implementationChanged(before: Observation, after: Observation): boolean {
  return Object.entries(after).some(
    ([repo, state]) => before[repo]?.path === state.path && before[repo].content !== state.content,
  );
}
