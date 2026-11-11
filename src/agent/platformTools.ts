import { toolAllowed } from "./toolPolicy.ts";
import {
  contextTool,
  CONTEXT_TOOLS,
  executeContextTool,
  boundedContextJson,
  visibleSnapshotKnowledge,
} from "./contextTools.ts";
import {
  validateToolBinding,
  journalToolCall,
  auditToolDenial,
  postClarification,
} from "./toolRuntime.ts";
import { redactContextText } from "../context/redact.ts";
import { safeDiagnostics } from "./telemetry.ts";
import { z } from "zod";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { config, codeIntelligenceEnabled } from "../config.ts";
import { execution } from "../auth/execution.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { repositories, repoPath } from "../repos/service.ts";
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
  contextPreparation?: boolean;
  attemptAllowedTools?: string[] | null;
  runId: number;
  snapshotId?: number;
  recordMetrics?: (m: Record<string, unknown>) => Promise<void>;
  independent?: boolean;
  /** Run owner. Tool calls that touch credentials use this, not a process-global user. */
  ownerId?: number | null;
  stepId: number;
  /** Step key, for audit records of integration calls. */
  stepKey?: string;
  attemptId: number;
  fencingToken: number | null;
  mode: ToolMode;
  branch: string;
  allowed: string[];
  selected: string[];
  prose: string;
  knowledge: Array<{
    id?: number;
    owner_id?: number | null;
    updated_at?: string | Date;
    key: string;
    title: string;
    version: number;
    content: string;
    category: string;
    metadata?: any;
  }>;
  disclosure: Array<{ key: string; disclosure?: string }>;
  upstream: Record<string, { output?: unknown; status?: string; attempt_id?: number | null }>;
  stepType: string;
  policy?: PolicyContext;
  metrics?: {
    skills_loaded: string[];
    knowledge_searches: string[];
    integration_calls: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
  };
  log(kind: "agent" | "system", content: string, data?: unknown): Promise<void>;
  ask(
    questions: Array<{ question: string; context?: string; options?: string[] }>,
  ): Promise<number>;
  onSubmit?(output: Record<string, unknown>): void;
}

const MUTATING = new Set(["prepare_branch", "commit_changes", "submit_result"]);
const execGit = promisify(execFile);

export async function attemptIsLive(
  attemptId: number,
  fencingToken: number | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await one<{
    status: string;
    step_status: string;
    current_attempt_id: number | null;
    generation: number;
    attempt_generation: number;
    job_status: string | null;
    fencing_token: number | null;
    lease_live: boolean;
    worker_instance: string | null;
  }>(
    pool,
    `SELECT a.status, s.status AS step_status, s.current_attempt_id, s.generation, a.generation AS attempt_generation,
            j.status AS job_status, j.fencing_token, j.lease_expires_at > clock_timestamp() AS lease_live, r.worker_instance
       FROM workflow_step_attempts a
       JOIN workflow_steps s ON s.id = a.step_id
       JOIN workflow_runs r ON r.id = a.run_id
       LEFT JOIN workflow_jobs j ON j.id = a.job_id
      WHERE a.id = $1`,
    [attemptId],
  );
  if (!row) return { ok: false, reason: "attempt not found" };
  if (row.worker_instance !== config.instanceId || !row.lease_live)
    return { ok: false, reason: "assigned worker mismatch or lease expired" };
  if (row.status !== "RUNNING") return { ok: false, reason: `attempt is ${row.status}` };
  if (
    row.step_status !== "RUNNING" ||
    row.current_attempt_id !== attemptId ||
    row.generation !== row.attempt_generation
  )
    return { ok: false, reason: "attempt is stale or the step was invalidated" };
  if (row.job_status !== "running") return { ok: false, reason: "attempt has no running job" };
  if (fencingToken != null && Number(row.fencing_token) !== Number(fencingToken))
    return { ok: false, reason: "attempt was fenced out" };
  return { ok: true };
}

async function openQuestions(attemptId: number): Promise<number> {
  const row = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'",
    [attemptId],
  );
  return row?.n ?? 0;
}

const activeContextReads = new Map<number, number>();

export async function dispatchPlatformTool(
  name: string,
  args: any,
  env: PlatformToolEnv,
): Promise<string> {
  const started = performance.now();
  try {
    await validateToolBinding(env);
  } catch (error) {
    await auditToolDenial(env, name, error);
    return `ERROR: refused ${name}: ${safeDiagnostics(error)}`;
  }
  return execution.run(
    { ...execution.getStore(), userId: Number(env.ownerId), runId: env.runId, kind: "run" },
    async () => {
      const nativeName =
        name === "call_tool" && String(args?.name ?? "").startsWith("platform.")
          ? String(args.name)
          : name;
      const nativeArgs = nativeName !== name ? (args.arguments ?? {}) : args;
      const native =
        nativeName.startsWith("platform.") || !["search_knowledge"].includes(nativeName)
          ? contextTool(nativeName)
          : undefined;
      let status: "ok" | "error" | "denied" | "timeout" = "ok",
        result: string;
      const readOnly =
        native?.readOnly ??
        (name === "call_tool"
          ? describeToolSafe(String(args?.name ?? ""))?.read_only === true
          : !MUTATING.has(name) && name !== "ask_user" && name !== "post_update");
      try {
        const target =
          native?.logicalName ??
          (name === "call_tool" ? `integration:${String(args?.name ?? "")}` : `platform.${name}`);
        const experiment = execution.getStore()?.evaluation;
        if (!env.contextPreparation && experiment?.contextMode) {
          const control = [
            "platform.submit_result",
            "platform.ask_user",
            "platform.request_clarification",
            "platform.post_update",
          ].includes(target);
          if (!control && experiment.contextMode !== "tools")
            throw new Error("Platform tools are disabled by the frozen benchmark context variant");
          if (!toolAllowed(target, experiment.allowedTools))
            throw new Error("Tool excluded by frozen benchmark permissions");
        }
        if (!env.contextPreparation && !toolAllowed(target, env.attemptAllowedTools))
          throw new Error(`Tool ${target} is excluded by this attempt's allowed_tools`);
        if (["read_knowledge", "search_knowledge"].includes(name) && !native)
          env = { ...env, knowledge: await visibleSnapshotKnowledge(env) };
        if (JSON.stringify(args ?? {}).length > 128000)
          throw new Error("Tool arguments exceed 128000 characters");
        if (!native) {
          const legacy = legacyInputs[name];
          if (!legacy)
            throw new Error(
              "Unknown tool; starting arbitrary workflows is not a supported capability",
            );
          args = legacy.parse(args ?? {});
        }
        if (native) {
          const parsed = native.input.safeParse(nativeArgs ?? {});
          if (!parsed.success)
            throw new Error(
              `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
            );
          const timeout = Math.min(
            60000,
            Math.max(1000, Number(config.agent.contextToolTimeoutMs) || 10000),
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (readOnly && (activeContextReads.get(env.attemptId) ?? 0) >= 4)
              throw new Error(
                "Context retrieval concurrency limit reached; wait for existing reads",
              );
            if (readOnly)
              activeContextReads.set(
                env.attemptId,
                (activeContextReads.get(env.attemptId) ?? 0) + 1,
              );
            const operation = executeContextTool(native.name, parsed.data, env);
            if (readOnly) {
              const release = () => {
                const n = (activeContextReads.get(env.attemptId) ?? 1) - 1;
                if (n) activeContextReads.set(env.attemptId, n);
                else activeContextReads.delete(env.attemptId);
              };
              void operation.then(release, release);
            }
            const value = readOnly
              ? await Promise.race([
                  operation,
                  new Promise((_, reject) => {
                    timer = setTimeout(
                      () => reject(new Error("Context tool deadline exceeded")),
                      timeout,
                    );
                  }),
                ])
              : await operation;
            if (readOnly) await validateToolBinding(env);
            result = boundedContextJson(value);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } else {
          if (nativeName.startsWith("platform."))
            throw new Error("Unsupported platform capability");
          if (["call_tool", "list_tools"].includes(name)) await loadPersonalIntegrations();
          result = await dispatchOwned(name, args, env);
        }
        if (result.startsWith("ERROR:")) status = "denied";
      } catch (error) {
        result = `ERROR: ${safeDiagnostics(error)}`;
        status = result.includes("deadline") ? "timeout" : "error";
      }
      result = redactToolText(result);
      if (result.length > 64000)
        result = boundedContextJson({
          truncated: true,
          original_chars: result.length,
          summary: result.slice(0, 20000),
          next: "Narrow the request or paginate the source tool",
        });
      await journalToolCall(
        env,
        native?.logicalName ?? name,
        readOnly,
        status,
        started,
        nativeArgs,
        result,
      ).catch((error) => console.error(`tool audit persistence failed: ${safeDiagnostics(error)}`));
      return result;
    },
  );
}
function redactToolText(text: string) {
  return redactContextText(text);
}

async function dispatchOwned(name: string, args: any, env: PlatformToolEnv): Promise<string> {
  const live = await attemptIsLive(env.attemptId, env.fencingToken);
  if (!live.ok) return `ERROR: refused ${name}: ${live.reason}`;
  if (MUTATING.has(name) && (await openQuestions(env.attemptId)) > 0)
    return "ERROR: this attempt is waiting for answers. Stop. Do not change files, branches, or submit a result.";
  if (name === "prepare_branch" && env.mode !== "coding")
    return "ERROR: prepare_branch is only available in coding steps";
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
      return JSON.stringify(
        [
          ...listTools(args?.query, { mode: env.mode }),
          ...CONTEXT_TOOLS.map((t) => ({
            name: t.logicalName,
            summary: t.description,
            read_only: t.readOnly,
            available:
              !["search_code", "get_symbol", "find_dependencies"].includes(t.name) ||
              codeIntelligenceEnabled(),
          })),
        ],
        null,
        2,
      );
    case "describe_tool":
      try {
        const native = contextTool(String(args?.name ?? ""));
        return JSON.stringify(
          native
            ? {
                name: native.logicalName,
                description: native.description,
                read_only: native.readOnly,
                available:
                  !["search_code", "get_symbol", "find_dependencies"].includes(native.name) ||
                  codeIntelligenceEnabled(),
                input_schema: z.toJSONSchema(native.input),
              }
            : describeTool(String(args?.name ?? "")),
          null,
          2,
        );
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
    .array(
      z.object({
        question: z.string(),
        context: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .parse(args?.questions ?? args);
  const n = await postClarification(env, questions);
  await env.log("system", `${n} question(s) posted`);
  return "Questions posted. Stop now and end your turn without further tool calls.";
}

async function postUpdate(args: any, env: PlatformToolEnv): Promise<string> {
  const message = String(args?.message ?? "");
  await env.log("agent", message);
  await q(
    pool,
    "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'progress', $4)",
    [env.runId, env.stepId, env.attemptId, JSON.stringify({ note: message })],
  );
  return "ok";
}

async function submitResult(args: any, env: PlatformToolEnv): Promise<string> {
  const output = (args?.output ?? {}) as Record<string, unknown>;
  if (!output || typeof output !== "object" || Array.isArray(output))
    return "ERROR: submit_result.output must be an object";
  env.onSubmit?.(output);
  await q(
    pool,
    "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'submit_result', $4)",
    [env.runId, env.stepId, env.attemptId, JSON.stringify({ output })],
  );
  return "Result recorded. End your turn now.";
}

async function prepareBranch(args: any, env: PlatformToolEnv): Promise<string> {
  const repo = String(args?.repo ?? "");
  const editable = env.selected.length ? env.selected : env.allowed;
  if (!editable.includes(repo))
    return `Repo "${repo}" is not selected for this run. Allowed: ${editable.join(", ")}`;
  const run = await one<any>(pool, "SELECT * FROM workflow_runs WHERE id = $1", [env.runId]);
  const w = await prepareWorkspace(run, repo, async () => {
    const live = await attemptIsLive(env.attemptId, env.fencingToken);
    if (!live.ok) throw new Error(live.reason);
  });
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
  const registered = await repositories.get(repo);
  if (registered && (!registered.enabled || !registered.allowed_actions.includes("write")))
    return "ERROR: repository write permission required";
  const primaryRoots = [config.reposRoot, ...(registered ? [repoPath(registered)] : [])];
  if (isInside(w.path, primaryRoots)) return "ERROR: refusing to commit in a primary checkout";
  const paths = Array.isArray(args?.paths) ? args.paths.map(String).filter(Boolean) : [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(w.path, p);
    if (!isInside(abs, [w.path]) || relative(w.path, abs).split(/[\\/]/)[0] === ".git")
      return `ERROR: path ${p} is outside the worktree ${w.path}`;
  }
  const git = (...a: string[]) =>
    execGit("git", ["-C", w.path, "-c", "core.hooksPath=/dev/null", ...a], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
  try {
    await git("add", "-A", "--", ...(paths.length ? paths : ["."]));
    const staged = (await git("diff", "--cached", "--name-only")).stdout.trim();
    if (!staged) return "Nothing to commit: the worktree has no staged changes.";
    await git("commit", "--no-verify", "-m", message);
    const head = (await git("log", "-1", "--format=%h %s")).stdout.trim();
    await env.log("system", `commit ${head} in ${repo} (${staged.split("\n").length} file(s))`, {
      repo,
      commit: head.split(" ")[0],
    });
    return `Committed ${head} on ${w.branch} in ${w.path}\nFiles:\n${staged}`;
  } catch (e: any) {
    return `ERROR: git commit failed: ${String(e?.stderr || e?.message || e).slice(0, 1000)}`;
  }
}

async function readKnowledge(args: any, env: PlatformToolEnv): Promise<string> {
  const key = String(args?.key ?? "");
  const k = env.knowledge.find((x) => x.key === key);
  if (!k)
    return `"${key}" is not available to this step. Use search_knowledge to find applicable items.`;
  await env.log("system", `loaded knowledge ${key} v${k.version}`, {
    knowledge: key,
    version: k.version,
  });
  if (env.metrics && !env.metrics.skills_loaded.includes(key)) env.metrics.skills_loaded.push(key);
  const offset = Number(args.offset ?? 0),
    limit = Number(args.limit ?? 18000);
  const body = k.content.slice(offset, offset + limit);
  return `# ${k.title} (${k.key} v${k.version})\n\n${body}${offset + limit < k.content.length ? `\n[truncated: read_knowledge key=${k.key} offset=${offset + limit} for the next page]` : ""}`;
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
  await env.log(
    "system",
    `search_knowledge "${query}" → ${hits.map((h) => h.key).join(", ") || "no match"}`,
    {
      query,
      hits: hits.map((h) => h.key),
    },
  );
  return hits.length
    ? JSON.stringify(hits, null, 2)
    : "No applicable knowledge matches. Try other words.";
}

async function readStepOutput(args: any, env: PlatformToolEnv): Promise<string> {
  const stepKey = String(args?.step_key ?? "");
  if (env.independent) {
    const u = env.upstream[stepKey];
    return u
      ? capResult(u.output)
      : "ERROR: independent review only exposes sanitized pinned ancestors";
  }
  const attempt = args?.attempt != null ? Number(args.attempt) : undefined;
  if (attempt) {
    const row = await one(
      pool,
      "SELECT a.number, a.generation, a.status, a.output, a.invalidated_at FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = $2 AND a.number = $3",
      [env.runId, stepKey, attempt],
    );
    return row ? capResult(row) : `No attempt #${attempt} of "${stepKey}".`;
  }
  const u = env.upstream[stepKey];
  return u
    ? capResult(u.output)
    : `No completed upstream step "${stepKey}". Available: ${Object.keys(env.upstream).join(", ")}`;
}

async function callIntegration(args: any, env: PlatformToolEnv): Promise<string> {
  const toolName = String(args?.name ?? "");
  if (env.independent && toolName === "run.step_history")
    return readStepOutput({ step_key: args?.arguments?.step_key }, env);
  if ((await openQuestions(env.attemptId)) > 0) {
    const desc = describeToolSafe(toolName);
    if (desc && desc.read_only === false)
      return "ERROR: this attempt is waiting for answers. Stop. Do not call tools that change state.";
  }
  const r = await callTool(toolName, args?.arguments ?? {}, {
    runId: env.runId,
    allowedRepositories: env.allowed,
    mode: env.mode,
    stepKey: env.stepKey,
  });
  env.metrics?.integration_calls.push({
    name: toolName,
    ok: r.ok,
    ms: r.ms,
    ...(r.error ? { error: r.error.slice(0, 200) } : {}),
  });
  await env.log(
    "system",
    `integration ${toolName} ${r.ok ? "ok" : "failed"} (${r.ms}ms)${r.error ? `: ${r.error}` : ""}`,
    { integration: toolName, ok: r.ok, ms: r.ms },
  );
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
  metrics: {
    skills_loaded: string[];
    knowledge_searches: string[];
    integration_calls: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
  },
  onSubmit: (output: Record<string, unknown>) => void,
): PlatformToolEnv {
  return {
    runId: ctx.run.id,
    snapshotId: ctx.context?.snapshot_id,
    recordMetrics: (m) => ctx.recordMetrics(m),
    independent: ctx.step.config.independent === true,
    ownerId: ctx.run.owner_id ?? null,
    stepId: ctx.step.id,
    stepKey: ctx.step.key,
    attemptId: ctx.attempt.id,
    fencingToken: ctx.attempt.fencing_token,
    mode,
    branch: ctx.run.branch,
    allowed: ctx.run.allowed_repositories,
    selected: ctx.run.selected_repositories,
    prose: outputLocale(ctx.run) === "vi" ? "Vietnamese" : "English",
    knowledge: (ctx.context?.knowledge ?? []) as PlatformToolEnv["knowledge"],
    disclosure: ctx.context?.disclosure ?? [],
    upstream: ctx.input?.upstream ?? {},
    stepType: ctx.step.type,
    policy,
    metrics,
    log: (kind, content, data) => ctx.log(kind, content, data),
    ask: (qs) => ctx.ask(qs),
    onSubmit,
  };
}

/** Rebuild the env inside the Cursor bridge process. The snapshot is the source of knowledge text. */
export async function envFromDatabase(
  ids: { runId: number; stepId: number; attemptId: number },
  onSubmit?: (o: Record<string, unknown>) => void,
): Promise<PlatformToolEnv> {
  const attempt = await one<any>(pool, "SELECT * FROM workflow_step_attempts WHERE id = $1", [
    ids.attemptId,
  ]);
  const step = await one<any>(pool, "SELECT * FROM workflow_steps WHERE id = $1", [ids.stepId]);
  const run = await one<any>(pool, "SELECT * FROM workflow_runs WHERE id = $1", [ids.runId]);
  if (
    !attempt ||
    !step ||
    !run ||
    attempt.run_id !== run.id ||
    attempt.step_id !== step.id ||
    step.run_id !== run.id ||
    run.worker_instance !== config.instanceId
  )
    throw new Error("bridge attempt not found or assigned to another instance");
  const snap = attempt.context_snapshot_id
    ? await one<any>(pool, "SELECT content FROM context_snapshots WHERE id = $1", [
        attempt.context_snapshot_id,
      ])
    : null;
  const content = snap?.content ?? {};
  const input = attempt.input ?? {};
  const mode: ToolMode = step.type === "coding_agent" ? "coding" : "analysis";
  const ws = await workspacesOf(run.id);
  const localPaths = (await repositories.list())
    .filter((r) => run.allowed_repositories.includes(r.name))
    .map((r) => repoPath(r));
  const { runEvents } = await import("../workflow/events.ts");
  return {
    runId: run.id,
    snapshotId: attempt.context_snapshot_id,
    independent: step.config?.independent === true,
    ownerId: run.owner_id ?? null,
    stepId: step.id,
    stepKey: step.key,
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
    policy: {
      allowedTools: attempt.effective_agent?.allowed_tools,
      mode,
      workspaces: ws.map((w: { path: string }) => w.path),
      baseBranch: config.baseBranch,
      protectedRoots: [config.reposRoot, ...localPaths],
    },
    log: (kind, text, data) =>
      runEvents.add(pool, run.id, kind, text, step.id, attempt.id, data ?? null),
    ask: async (questions) => {
      for (const x of questions)
        await q(
          pool,
          "INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options, suggested_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [
            run.id,
            step.id,
            attempt.id,
            x.question,
            x.context ?? "",
            JSON.stringify(x.options ?? []),
            x.options?.[0] ?? null,
          ],
        );
      return questions.length;
    },
    onSubmit,
  };
}

const legacyInputs: Record<string, z.ZodType> = {
  ask_user: z.strictObject({
    questions: z
      .array(
        z.strictObject({
          question: z.string().min(1).max(2000),
          context: z.string().max(4000).optional(),
          options: z.array(z.string().max(500)).max(8).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  post_update: z.strictObject({ message: z.string().min(1).max(12000) }),
  submit_result: z.strictObject({ output: z.record(z.string(), z.unknown()) }),
  prepare_branch: z.strictObject({ repo: z.string().min(1).max(160) }),
  commit_changes: z.strictObject({
    repo: z.string().min(1).max(160),
    message: z.string().min(1).max(4000),
    paths: z.array(z.string().max(1000)).max(100).optional(),
  }),
  read_knowledge: z.strictObject({
    key: z.string().min(1).max(200),
    offset: z.number().int().min(0).max(1000000).optional(),
    limit: z.number().int().min(1).max(24000).optional(),
  }),
  search_knowledge: z.strictObject({
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  read_step_output: z.strictObject({
    step_key: z.string().min(1).max(160),
    attempt: z.number().int().positive().optional(),
  }),
  list_tools: z.strictObject({ query: z.string().max(512).optional() }),
  describe_tool: z.strictObject({ name: z.string().min(1).max(200) }),
  call_tool: z.strictObject({
    name: z.string().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
};
