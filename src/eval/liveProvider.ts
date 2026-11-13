import { mkdir, rm, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { z } from "zod";
import { one, pool } from "../db/pool.ts";
import { execution } from "../auth/execution.ts";
import { repositories } from "../repos/service.ts";
import { effectivePermissions } from "../repos/access.ts";
import { resolveRepoPath } from "../repos/paths.ts";
import { recordWorkspace } from "../git/provider.ts";
import { claudeExecutor } from "../agent/claude.ts";
import { isSecretPath } from "../agent/toolPolicy.ts";
import { CaseSchema } from "./dataset.ts";
import { fixtureGit, fixtureName, fixtureRoot } from "./fixtures.ts";
import { livePrerequisites } from "./livePrerequisites.ts";
import { cleanupLiveWork, liveWorkRoot, stopPostmaster } from "./liveCase.ts";
import { LiveBudget, liveRuntime, remainingLiveBudgets } from "./liveRuntime.ts";
import type { ConfigurationSchema } from "./configuration.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";
const exec = promisify(execFile);
const LIVE_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash",
  "TodoWrite",
  "platform.read_knowledge",
  "platform.search_knowledge",
  "platform.submit_result",
  "platform.report_progress",
  "platform.get_run_context",
  "platform.search_code",
  "platform.get_symbol",
  "platform.find_references",
];
// Wider than the agent tool policy: archives of real repositories also carry build/deploy credentials.
const EVALUATION_SECRET =
  /^(credentials|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.pypirc|\.dockercfg|secrets?\..+|application[^/]*\.(ya?ml|properties))$|\.(p12|pfx|jks|keystore)$/i;
export const liveAllowedTools = (requested?: string[] | null) =>
  requested ? LIVE_ALLOWED_TOOLS.filter((t) => requested.includes(t)) : LIVE_ALLOWED_TOOLS;
export const unsupportedLiveTools = (requested: string[]) =>
  requested.filter((t) => !LIVE_ALLOWED_TOOLS.includes(t));
export const isEvaluationSecretPath = (name: string) =>
  isSecretPath(name) || EVALUATION_SECRET.test(name);
type Phase = {
  case_run_id: number;
  evaluation_id: number;
  ordinal: number;
  provider: string;
  definition: unknown;
  configuration: z.infer<typeof ConfigurationSchema> & {
    blocked?: string | null;
    paid_approval?: unknown;
    estimated_usd_per_million: number;
  };
};
export async function removeEvaluationSecrets(root: string) {
  for (const name of await readdir(root)) {
    if (name === ".git") continue;
    const path = join(root, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || isEvaluationSecretPath(name))
      await rm(path, { recursive: true, force: true });
    else if (stat.isDirectory()) await removeEvaluationSecrets(path);
  }
}
async function stopIsolatedDatabase(data: string) {
  await stopPostmaster(data);
  await rm(data, { recursive: true, force: true });
}
export async function isolatedDatabase(root: string) {
  const data = join(root, `database-${randomUUID()}`);
  const socket = join(data, "socket");
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" };
  await exec(
    "initdb",
    ["-D", data, "-U", "platform_eval", "-A", "trust", "--no-locale", "--encoding=UTF8"],
    { env, timeout: 30000 },
  );
  try {
    await mkdir(socket, { mode: 0o700 });
    await exec(
      "pg_ctl",
      [
        "-D",
        data,
        "-l",
        join(data, "server.log"),
        "-o",
        `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
        "-w",
        "start",
      ],
      { env, timeout: 30000 },
    );
    const url = `postgres://platform_eval@localhost/postgres?host=${encodeURIComponent(socket)}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const name = `platform_eval_${randomUUID().replaceAll("-", "")}`;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    return {
      url: `postgres://platform_eval@localhost/${name}?host=${encodeURIComponent(socket)}`,
      dispose: () => stopIsolatedDatabase(data),
    };
  } catch (error) {
    await stopIsolatedDatabase(data).catch((cleanup) =>
      console.error(`isolated database cleanup failed: ${(cleanup as Error).message}`),
    );
    throw error;
  }
}
export async function executeLiveProviderPhase(
  ctx: ExecutionContext,
  phase: Phase,
): Promise<ExecResult> {
  const connection = await pool.connect();
  const group = `eval-budget:${ctx.run.owner_id}:${phase.configuration.budget_group ?? phase.evaluation_id}`;
  let locked = false,
    result: ExecResult | undefined;
  try {
    for (let delay = 100; ; delay = Math.min(delay * 2, 5000)) {
      const { rows } = await connection.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
        [group],
      );
      if ((locked = rows[0].ok)) break;
      if (ctx.signal.aborted)
        return (result = {
          kind: "failed",
          retryable: false,
          error: "Aborted while waiting for the evaluation budget lock",
        });
      await sleep(delay, undefined, { signal: ctx.signal }).catch(() => {});
    }
    return (result = await executeLiveProviderPhaseLocked(ctx, phase));
  } finally {
    // An abort may be a lease loss whose re-execution still needs the workspace.
    if ((!result || result.kind === "failed") && !ctx.signal.aborted)
      await cleanupLiveWork(ctx.run.id, liveWorkRoot(phase.evaluation_id, phase.case_run_id)).catch(
        (error) => console.error(`live evaluation cleanup failed: ${(error as Error).message}`),
      );
    if (locked)
      await connection
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [group])
        .catch(() => {});
    connection.release();
  }
}
async function executeLiveProviderPhaseLocked(
  ctx: ExecutionContext,
  phase: Phase,
): Promise<ExecResult> {
  const cfg = phase.configuration;
  const blocked = cfg.blocked ?? (await livePrerequisites(cfg));
  if (blocked || !cfg.paid_approval)
    return {
      kind: "completed",
      output: {
        evidence_kind: "blocked",
        blocked: blocked ?? "Paid administrator approval missing",
      },
    };
  const task = CaseSchema.parse(phase.definition);
  const registered = task.validation.type === "commands";
  const access = registered ? await effectivePermissions(Number(ctx.run.owner_id)) : null;
  for (const name of registered ? task.repositories : []) {
    const permissions = access!.get(name);
    if (!permissions)
      return {
        kind: "failed",
        retryable: false,
        error: `Evaluation repository unavailable: ${name}`,
      };
    if (!permissions.effective.read || permissions.platform.source === "benchmark")
      return {
        kind: "failed",
        retryable: false,
        error: `Evaluation owner has no read access to repository ${name}`,
      };
  }
  const root = liveWorkRoot(phase.evaluation_id, phase.case_run_id);
  const workspaces: Array<{ repo: string; path: string }> = [];
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const logical of task.repositories) {
    const name = registered ? logical : fixtureName(logical);
    const row = await repositories.get(name);
    if (!row?.enabled) throw new Error(`Evaluation repository unavailable: ${name}`);
    const primary = registered ? resolveRepoPath(row) : fixtureRoot(name);
    const path = join(root, logical);
    if (phase.ordinal === 0) {
      await rm(path, { recursive: true, force: true });
      await mkdir(path, { recursive: true, mode: 0o700 });
      const archive = await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          primary,
          "archive",
          task.repository_commits?.[logical] ?? task.base_commit,
        ],
        { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, timeout: 10000 },
      );
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          "tar",
          ["--extract", "--no-same-owner", "--no-same-permissions", "-C", path],
          { timeout: 10000 },
          (error) => (error ? reject(error) : resolve()),
        );
        child.stdin!.end(archive.stdout);
      });
      await removeEvaluationSecrets(path);
      await fixtureGit(path, ["init", "--quiet", "--initial-branch", "main"]);
      await fixtureGit(path, ["add", "."]);
      await fixtureGit(path, [
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Sanitized pinned evaluation base",
      ]);
      await recordWorkspace(ctx.run.id, {
        repo: name,
        path,
        branch: "main",
        created_from: await fixtureGit(path, ["rev-parse", "HEAD"]),
      });
    } else if (!(await lstat(path).catch(() => null)))
      return {
        kind: "failed",
        retryable: false,
        error: `Live case workspace missing for ${logical}; rerun the case from its first phase`,
      };
    workspaces.push({ repo: name, path });
  }
  const totals = await one(
    pool,
    `SELECT COALESCE(sum(COALESCE((a.metrics->'evaluation_live'->>'cost_usd')::numeric,0)),0)::float AS cost,
    COALESCE(sum(COALESCE((a.metrics->'evaluation_live'->>'cost_usd')::numeric,0)) FILTER(WHERE p.case_run_id=$3),0)::float AS case_cost,
    COALESCE(sum(COALESCE((a.metrics->'evaluation_live'->>'tokens')::numeric,0)) FILTER(WHERE p.case_run_id=$3),0)::float AS case_tokens,
    min(a.started_at) FILTER(WHERE p.case_run_id=$3) AS case_started FROM evaluation_provider_phases p JOIN evaluation_case_runs cr ON cr.id=p.case_run_id JOIN evaluation_runs e ON e.id=cr.evaluation_id JOIN workflow_steps s ON s.key=p.step_key AND s.run_id=e.workflow_run_id JOIN workflow_step_attempts a ON a.step_id=s.id WHERE (cr.evaluation_id=$1 OR ($4::text IS NOT NULL AND e.configuration->>'budget_group'=$4)) AND e.owner_id=$2`,
    [phase.evaluation_id, ctx.run.owner_id, phase.case_run_id, cfg.budget_group ?? null],
  );
  const remaining = remainingLiveBudgets(cfg, {
    caseTokens: Number(totals?.case_tokens ?? 0),
    caseCost: Number(totals?.case_cost ?? 0),
    suiteCost: Number(totals?.cost ?? 0),
  });
  if (remaining.costUsd <= 0)
    return { kind: "failed", retryable: false, error: "Suite or case cost budget exhausted" };
  const controller = new AbortController();
  const remainingTokens = remaining.tokens;
  const remainingMs =
    cfg.max_case_seconds * 1000 -
    (Date.now() - new Date(totals?.case_started ?? Date.now()).getTime());
  if (remainingTokens <= 0 || remainingMs <= 0)
    return { kind: "failed", retryable: false, error: "Case token or wall-clock budget exhausted" };
  const budget = new LiveBudget(
    remainingTokens,
    remaining.costUsd,
    () => controller.abort(),
    cfg.estimated_usd_per_million,
  );
  const signal = AbortSignal.any([
    ctx.signal,
    controller.signal,
    AbortSignal.timeout(Math.max(1, remainingMs)),
  ]);
  const principal = execution.getStore();
  if (!principal) throw new Error("Authenticated evaluation owner required");
  const db = await isolatedDatabase(root);
  const started = Date.now();
  const allowedTools = liveAllowedTools(cfg.allowed_tools);
  let observed: Record<string, unknown> = {};
  let persisted = 0,
    persisting: Promise<unknown> = Promise.resolve();
  try {
    const runtime = {
      cwd: workspaces[0].path,
      root,
      databaseUrl: db.url,
      observe: (tokens: number, cost: number | null, key?: object) => {
        budget.observe(tokens, cost, key);
        // Spend must survive a worker crash: the suite budget sums these rows.
        if (Date.now() - persisted < 5000) return;
        persisted = Date.now();
        persisting = persisting
          .then(() =>
            ctx.recordMetrics({
              evaluation_live: {
                tokens: budget.tokens,
                cost_usd: budget.costUsd,
                duration_ms: Date.now() - started,
                partial: true,
              },
            }),
          )
          .catch(() => {});
      },
    };
    const agent = ctx.step.config.agent ?? {};
    const result = await execution.run(
      {
        ...principal,
        evaluation: {
          codeIntelligence: cfg.code_intelligence,
          contextMode: cfg.context_variant,
          allowedTools,
        },
      },
      () =>
        liveRuntime.run(runtime, () =>
          claudeExecutor.execute({
            ...ctx,
            signal,
            attempt: {
              ...ctx.attempt,
              effective_agent: ctx.attempt.effective_agent
                ? {
                    ...ctx.attempt.effective_agent,
                    allowed_tools: allowedTools,
                  }
                : ctx.attempt.effective_agent,
            },
            run: { ...ctx.run, selected_repositories: workspaces.map((w) => w.repo) },
            step: {
              ...ctx.step,
              config: {
                ...ctx.step.config,
                agent: {
                  ...agent,
                  allowed_tools: allowedTools,
                },
              },
            },
            context: { ...ctx.context, repoPaths: workspaces.map((w) => ({ ...w, name: w.repo })) },
            recordMetrics: async (metrics) => {
              observed = { ...observed, ...metrics };
              await ctx.recordMetrics(metrics);
            },
          }),
        ),
    );
    if (budget.reason) return { kind: "failed", retryable: false, error: budget.reason };
    if (!budget.tokens)
      return {
        kind: "failed",
        retryable: false,
        error: "Live provider did not report usage; result cannot be accepted",
      };
    return {
      ...result,
      ...(result.kind === "completed"
        ? {
            output: {
              ...(result.output && typeof result.output === "object" ? result.output : {}),
              evidence_kind: "live_provider",
              evaluation_live: {
                tokens: budget.tokens,
                cost_usd: budget.costUsd,
                duration_ms: Date.now() - started,
              },
            },
          }
        : {}),
    };
  } finally {
    await persisting;
    try {
      await ctx.recordMetrics({
        evaluation_live: {
          tokens: budget.tokens,
          cost_usd: budget.costUsd,
          duration_ms: Date.now() - started,
          budget_error: budget.reason,
          skills: observed.skills ?? [],
          verification: observed.verification ?? null,
        },
      });
    } finally {
      await db.dispose();
    }
  }
}
