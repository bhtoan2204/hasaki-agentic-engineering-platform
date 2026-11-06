import { z } from "zod";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { execution } from "../auth/execution.ts";
import { pool, q, one } from "../db/pool.ts";
import { outputLocale } from "./language.ts";
import { prepareWorkspace, workspacesOf } from "../git/provider.ts";
import { scoreKnowledge } from "../context/plan.ts";
import { callTool, capResult, describeTool, listTools } from "./toolRegistry.ts";
import { isInside, type PolicyContext, type ToolMode } from "./toolPolicy.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";

/**
 * Platform tools shared by Claude's in-process MCP server, Cursor's per-run stdio bridge and Codex' per-attempt broker.
 * Every call is bound to one attempt. A fenced, stale, or canceled attempt cannot mutate.
 * After ask_user has open questions, further mutations are refused until the engine resumes.
 */
export interface PlatformToolEnv {
  runId: number;
  /** Run owner. Tool calls that touch credentials use this, not a process-global user. */
  ownerId?: number | null;
  stepId: number;
  attemptId: number;
  fencingToken: number | null;
  mode: ToolMode;
  branch: string;
  allowed: string[];
  selected: string[];
  prose: string;
  knowledge: Array<{ key: string; title: string; version: number; content: string; category: string; metadata?: any }>;
  disclosure: Array<{ key: string; disclosure?: string }>;
  upstream: Record<string, { output?: unknown; status?: string }>;
  stepType: string;
  policy?: PolicyContext;
  metrics?: {
    skills_loaded: string[];
    knowledge_searches: string[];
    integration_calls: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
  };
  log(kind: "agent" | "system", content: string, data?: unknown): Promise<void>;
  ask(questions: Array<{ question: string; context?: string; options?: string[] }>): Promise<number>;
  onSubmit?(output: Record<string, unknown>): void;
}

const MUTATING = new Set(["prepare_branch", "commit_changes", "submit_result", "call_tool"]);
const execGit = promisify(execFile);

export async function attemptIsLive(attemptId: number, fencingToken: number | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await one<{
    status: string;
    step_status: string;
    current_attempt_id: number | null;
    generation: number;
    attempt_generation: number;
    job_status: string | null;
    fencing_token: number | null;
  }>(
    pool,
    `SELECT a.status, s.status AS step_status, s.current_attempt_id, s.generation, a.generation AS attempt_generation,
            j.status AS job_status, j.fencing_token
       FROM workflow_step_attempts a
       JOIN workflow_steps s ON s.id = a.step_id
       LEFT JOIN workflow_jobs j ON j.id = a.job_id
      WHERE a.id = $1`,
    [attemptId],
  );
  if (!row) return { ok: false, reason: "attempt not found" };
  if (row.status !== "RUNNING") return { ok: false, reason: `attempt is ${row.status}` };
  if (row.step_status !== "RUNNING" || row.current_attempt_id !== attemptId || row.generation !== row.attempt_generation)
    return { ok: false, reason: "attempt is stale or the step was invalidated" };
  if (row.job_status !== "running") return { ok: false, reason: "attempt has no running job" };
  if (fencingToken != null && Number(row.fencing_token) !== Number(fencingToken)) return { ok: false, reason: "attempt was fenced out" };
  return { ok: true };
}

async function openQuestions(attemptId: number): Promise<number> {
  const row = await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'", [attemptId]);
  return row?.n ?? 0;
}

export async function dispatchPlatformTool(name: string, args: any, env: PlatformToolEnv): Promise<string> {
  if (env.ownerId) return execution.run({ userId: Number(env.ownerId), runId: env.runId, kind: "run" }, () => dispatchOwned(name, args, env));
  return dispatchOwned(name, args, env);
}

async function dispatchOwned(name: string, args: any, env: PlatformToolEnv): Promise<string> {
  const live = await attemptIsLive(env.attemptId, env.fencingToken);
  if (!live.ok) return `ERROR: refused ${name}: ${live.reason}`;
  if (MUTATING.has(name) && (await openQuestions(env.attemptId)) > 0)
    return "ERROR: this attempt is waiting for answers. Stop. Do not change files, branches, or submit a result.";
  switch (name) {
    case "ask_user":
      return askUser(args, env);
    case "post_update":
      return postUpdate(args, env);
    case "submit_result":
      return submitResult(args, env);
    case "prepare_branch":
      return prepareBranch(args, env);
    case "commit_changes":
      return commitChanges(args, env);
    case "read_knowledge":
      return readKnowledge(args, env);
    case "search_knowledge":
      return searchKnowledge(args, env);
    case "read_step_output":
      return readStepOutput(args, env);
    case "list_tools":
      return JSON.stringify(listTools(args?.query, { mode: env.mode }), null, 2);
    case "describe_tool":
      try {
        return JSON.stringify(describeTool(String(args?.name ?? "")), null, 2);
      } catch (e) {
        return (e as Error).message;
      }
    case "call_tool":
      return callIntegration(args, env);
    default:
      return `ERROR: unknown platform tool ${name}`;
  }
}

async function askUser(args: any, env: PlatformToolEnv): Promise<string> {
  const questions = z
    .array(z.object({ question: z.string(), context: z.string().optional(), options: z.array(z.string()).optional() }))
    .min(1)
    .parse(args?.questions ?? args);
  const n = await env.ask(questions);
  await env.log("system", `${n} question(s) posted`);
  return "Questions posted. Stop now and end your turn without further tool calls.";
}

async function postUpdate(args: any, env: PlatformToolEnv): Promise<string> {
  const message = String(args?.message ?? "");
  await env.log("agent", message);
  await q(pool, "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'progress', $4)", [
    env.runId,
    env.stepId,
    env.attemptId,
    JSON.stringify({ note: message }),
  ]);
  return "ok";
}

async function submitResult(args: any, env: PlatformToolEnv): Promise<string> {
  const output = (args?.output ?? {}) as Record<string, unknown>;
  if (!output || typeof output !== "object" || Array.isArray(output)) return "ERROR: submit_result.output must be an object";
  env.onSubmit?.(output);
  await q(pool, "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'submit_result', $4)", [
    env.runId,
    env.stepId,
    env.attemptId,
    JSON.stringify({ output }),
  ]);
  return "Result recorded. End your turn now.";
}

async function prepareBranch(args: any, env: PlatformToolEnv): Promise<string> {
  const repo = String(args?.repo ?? "");
  const editable = env.selected.length ? env.selected : env.allowed;
  if (!editable.includes(repo)) return `Repo "${repo}" is not selected for this run. Allowed: ${editable.join(", ")}`;
  const run = await one<any>(pool, "SELECT * FROM workflow_runs WHERE id = $1", [env.runId]);
  const w = await prepareWorkspace(run, repo);
  if (env.policy && !env.policy.workspaces.includes(w.path)) env.policy.workspaces.push(w.path);
  await env.log("system", `branch ${w.branch} in ${repo} (${w.created_from}) -> ${w.path}`);
  return `Ready. Work ONLY in: ${w.path}\nBranch: ${w.branch} (from ${w.created_from})`;
}

/**
 * Commit inside one of the run's worktrees on behalf of an agent whose sandbox keeps .git read-only (Codex).
 * Runs in the worker, outside the agent sandbox, so it is deliberately narrow: coding mode only, an existing run
 * worktree only (never a primary checkout), optional paths must stay inside that worktree, and repository git hooks
 * are disabled (no code from the repository runs outside the sandbox).
 */
async function commitChanges(args: any, env: PlatformToolEnv): Promise<string> {
  if (env.mode !== "coding") return "ERROR: commit_changes is only available in coding steps";
  const repo = String(args?.repo ?? "");
  const message = String(args?.message ?? "").trim();
  if (!message) return "ERROR: commit_changes needs a commit message";
  const w = (await workspacesOf(env.runId)).find((x) => x.repo === repo);
  if (!w) return `ERROR: no worktree for "${repo}" in this run. Call prepare_branch first.`;
  if (isInside(w.path, [config.reposRoot])) return "ERROR: refusing to commit in a primary checkout";
  const paths = Array.isArray(args?.paths) ? args.paths.map(String).filter(Boolean) : [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(w.path, p);
    if (!isInside(abs, [w.path]) || relative(w.path, abs).split(/[\\/]/)[0] === ".git") return `ERROR: path ${p} is outside the worktree ${w.path}`;
  }
  const git = (...a: string[]) => execGit("git", ["-C", w.path, "-c", "core.hooksPath=/dev/null", ...a], { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  try {
    await git("add", "-A", "--", ...(paths.length ? paths : ["."]));
    const staged = (await git("diff", "--cached", "--name-only")).stdout.trim();
    if (!staged) return "Nothing to commit: the worktree has no staged changes.";
    await git("commit", "--no-verify", "-m", message);
    const head = (await git("log", "-1", "--format=%h %s")).stdout.trim();
    await env.log("system", `commit ${head} in ${repo} (${staged.split("\n").length} file(s))`, { repo, commit: head.split(" ")[0] });
    return `Committed ${head} on ${w.branch} in ${w.path}\nFiles:\n${staged}`;
  } catch (e: any) {
    return `ERROR: git commit failed: ${String(e?.stderr || e?.message || e).slice(0, 1000)}`;
  }
}

async function readKnowledge(args: any, env: PlatformToolEnv): Promise<string> {
  const key = String(args?.key ?? "");
  const k = env.knowledge.find((x) => x.key === key);
  if (!k) return `"${key}" is not available to this step. Use search_knowledge to find applicable items.`;
  await env.log("system", `loaded knowledge ${key} v${k.version}`, { knowledge: key, version: k.version });
  if (env.metrics && !env.metrics.skills_loaded.includes(key)) env.metrics.skills_loaded.push(key);
  return `# ${k.title} (${k.key} v${k.version})\n\n${k.content}`;
}

async function searchKnowledge(args: any, env: PlatformToolEnv): Promise<string> {
  const query = String(args?.query ?? "");
  const limit = Number(args?.limit ?? 8);
  if (query.length < 2) return "query must be at least 2 characters";
  env.metrics?.knowledge_searches.push(query);
  const tier = new Map(env.disclosure.map((d) => [d.key, d.disclosure]));
  const hits = env.knowledge
    .map((k) => ({ k, ...scoreKnowledge(k as any, query, env.stepType) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(20, Math.max(1, limit)))
    .map((x) => ({
      key: x.k.key,
      title: x.k.title,
      category: x.k.category,
      description: String((x.k.metadata as any)?.description ?? "").slice(0, 300),
      score: x.score,
      already_in_prompt: tier.get(x.k.key) === "inline",
    }));
  await env.log("system", `search_knowledge "${query}" → ${hits.map((h) => h.key).join(", ") || "no match"}`, { query, hits: hits.map((h) => h.key) });
  return hits.length ? JSON.stringify(hits, null, 2) : "No applicable knowledge matches. Try other words.";
}

async function readStepOutput(args: any, env: PlatformToolEnv): Promise<string> {
  const stepKey = String(args?.step_key ?? "");
  const attempt = args?.attempt != null ? Number(args.attempt) : undefined;
  if (attempt) {
    const row = await one(pool, "SELECT a.number, a.generation, a.status, a.output, a.invalidated_at FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = $2 AND a.number = $3", [
      env.runId,
      stepKey,
      attempt,
    ]);
    return row ? capResult(row) : `No attempt #${attempt} of "${stepKey}".`;
  }
  const u = env.upstream[stepKey];
  return u ? capResult(u.output) : `No completed upstream step "${stepKey}". Available: ${Object.keys(env.upstream).join(", ")}`;
}

async function callIntegration(args: any, env: PlatformToolEnv): Promise<string> {
  const toolName = String(args?.name ?? "");
  if ((await openQuestions(env.attemptId)) > 0) {
    const desc = describeToolSafe(toolName);
    if (desc && desc.read_only === false) return "ERROR: this attempt is waiting for answers. Stop. Do not call tools that change state.";
  }
  const r = await callTool(toolName, args?.arguments ?? {}, { runId: env.runId, allowedRepositories: env.allowed, mode: env.mode });
  env.metrics?.integration_calls.push({ name: toolName, ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error.slice(0, 200) } : {}) });
  await env.log("system", `integration ${toolName} ${r.ok ? "ok" : "failed"} (${r.ms}ms)${r.error ? `: ${r.error}` : ""}`, { integration: toolName, ok: r.ok, ms: r.ms });
  return r.ok ? capResult(r.result) : `ERROR: ${r.error}`;
}

function describeToolSafe(name: string): { read_only?: boolean } | null {
  try {
    return describeTool(name);
  } catch {
    return null;
  }
}

/** Build the shared env from the in-process executor context (Claude). */
export function envFromExecution(
  ctx: ExecutionContext,
  mode: ToolMode,
  policy: PolicyContext,
  metrics: { skills_loaded: string[]; knowledge_searches: string[]; integration_calls: Array<{ name: string; ok: boolean; ms: number; error?: string }> },
  onSubmit: (output: Record<string, unknown>) => void,
): PlatformToolEnv {
  return {
    runId: ctx.run.id,
    ownerId: ctx.run.owner_id ?? null,
    stepId: ctx.step.id,
    attemptId: ctx.attempt.id,
    fencingToken: ctx.attempt.fencing_token,
    mode,
    branch: ctx.run.branch,
    allowed: ctx.run.allowed_repositories,
    selected: ctx.run.selected_repositories,
    prose: outputLocale(ctx.run) === "vi" ? "Vietnamese" : "English",
    knowledge: ctx.context.knowledge as PlatformToolEnv["knowledge"],
    disclosure: ctx.context.disclosure,
    upstream: ctx.input.upstream,
    stepType: ctx.step.type,
    policy,
    metrics,
    log: (kind, content, data) => ctx.log(kind, content, data),
    ask: (qs) => ctx.ask(qs),
    onSubmit,
  };
}

/** Rebuild the env inside the Cursor bridge process. The snapshot is the source of knowledge text. */
export async function envFromDatabase(ids: { runId: number; stepId: number; attemptId: number }, onSubmit?: (o: Record<string, unknown>) => void): Promise<PlatformToolEnv> {
  const attempt = await one<any>(pool, "SELECT * FROM workflow_step_attempts WHERE id = $1", [ids.attemptId]);
  const step = await one<any>(pool, "SELECT * FROM workflow_steps WHERE id = $1", [ids.stepId]);
  const run = await one<any>(pool, "SELECT * FROM workflow_runs WHERE id = $1", [ids.runId]);
  if (!attempt || !step || !run) throw new Error("bridge attempt not found");
  const snap = attempt.context_snapshot_id
    ? await one<any>(pool, "SELECT content FROM context_snapshots WHERE id = $1", [attempt.context_snapshot_id])
    : null;
  const content = snap?.content ?? {};
  const input = attempt.input ?? {};
  const mode: ToolMode = step.type === "coding_agent" ? "coding" : "analysis";
  const ws = await workspacesOf(run.id);
  const { runEvents } = await import("../workflow/events.ts");
  return {
    runId: run.id,
    ownerId: run.owner_id ?? null,
    stepId: step.id,
    attemptId: attempt.id,
    fencingToken: attempt.fencing_token,
    mode,
    branch: run.branch,
    allowed: run.allowed_repositories,
    selected: run.selected_repositories,
    prose: outputLocale(run) === "vi" ? "Vietnamese" : "English",
    knowledge: content.knowledge ?? [],
    disclosure: content.prompt_plan?.knowledge ?? [],
    upstream: input.upstream ?? {},
    stepType: step.type,
    policy: { mode, workspaces: ws.map((w: { path: string }) => w.path), baseBranch: config.baseBranch, protectedRoots: [config.reposRoot] },
    log: (kind, text, data) => runEvents.add(pool, run.id, kind, text, step.id, attempt.id, data ?? null),
    ask: async (questions) => {
      for (const x of questions)
        await q(pool, "INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options, suggested_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
          run.id,
          step.id,
          attempt.id,
          x.question,
          x.context ?? "",
          JSON.stringify(x.options ?? []),
          x.options?.[0] ?? null,
        ]);
      return questions.length;
    },
    onSubmit,
  };
}
