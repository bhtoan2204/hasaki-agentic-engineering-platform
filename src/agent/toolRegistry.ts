import { z } from "zod";
import { config } from "../config.ts";
import { pool, q } from "../db/pool.ts";
import { listPullRequests } from "../bitbucket.ts";
import { workApi } from "../hasakiAuth.ts";
import { normalizeJiraIssue } from "../integrations/jira.ts";
import { rankRepositories, repositories, tokens } from "../repos/service.ts";
import { runChanges } from "../git/changes.ts";

/**
 * Dynamic tool registry for domain integrations. The agent sees three meta tools (list_tools, describe_tool,
 * call_tool) instead of every integration schema up front: discovery returns one-line summaries ranked by relevance,
 * the full contract is loaded on demand, and calls are validated and permission-checked here — in code, not in the
 * prompt. Native Claude Code tools and the PreToolUse/canUseTool policy are unaffected.
 */

export interface ToolCallContext {
  runId: number;
  allowedRepositories: string[];
  /** analysis = read-only step (or a subagent); coding = may use tools that change external state. */
  mode: "analysis" | "coding";
}

export interface IntegrationTool<S extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  summary: string;
  description: string;
  input: S;
  readOnly: boolean;
  /** true when usable; otherwise the reason (e.g. missing credentials). */
  available: () => true | string;
  handler: (args: z.infer<S>, ctx: ToolCallContext) => Promise<unknown>;
}

const registry = new Map<string, IntegrationTool>();
export function registerIntegrationTool<S extends z.ZodObject<any>>(t: IntegrationTool<S>) {
  registry.set(t.name, t as unknown as IntegrationTool);
}
export const integrationTools = () => [...registry.values()];

const MAX_RESULT = 40_000;

export function listTools(query: string | undefined, ctx: Pick<ToolCallContext, "mode">) {
  const want = new Set(tokens(query ?? ""));
  return integrationTools()
    .map((t) => {
      const avail = t.available();
      const hay = tokens(`${t.name.replace(/[._]/g, " ")} ${t.summary}`);
      const score = want.size ? hay.filter((x) => want.has(x)).length : 0;
      return {
        name: t.name,
        summary: t.summary,
        read_only: t.readOnly,
        available: avail === true,
        ...(avail === true ? {} : { unavailable_reason: avail }),
        ...(ctx.mode === "analysis" && !t.readOnly ? { note: "not callable in this read-only step" } : {}),
        score,
      };
    })
    .filter((t) => !want.size || t.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function describeTool(name: string) {
  const t = registry.get(name);
  if (!t) throw new Error(`unknown tool "${name}" — use list_tools`);
  return { name: t.name, description: t.description, read_only: t.readOnly, input_schema: z.toJSONSchema(t.input), available: t.available() };
}

export async function callTool(name: string, args: unknown, ctx: ToolCallContext): Promise<{ ok: boolean; result?: unknown; error?: string; ms: number }> {
  const t0 = Date.now();
  const t = registry.get(name);
  if (!t) return { ok: false, error: `unknown tool "${name}" — use list_tools`, ms: 0 };
  if (ctx.mode === "analysis" && !t.readOnly) return { ok: false, error: `${name} changes external state and is not allowed in a read-only step`, ms: 0 };
  const avail = t.available();
  if (avail !== true) return { ok: false, error: `${name} is unavailable: ${avail}`, ms: 0 };
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, ms: 0 };
  try {
    const result = await t.handler(parsed.data, ctx);
    return { ok: true, result, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message, ms: Date.now() - t0 };
  }
}

export function capResult(v: unknown) {
  const s = JSON.stringify(v, null, 2) ?? "null";
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + `\n… (truncated, ${s.length - MAX_RESULT} more chars)` : s;
}

const allowedRepo = (repo: string, ctx: ToolCallContext) => {
  if (!ctx.allowedRepositories.includes(repo)) throw new Error(`repository "${repo}" is outside this run's allowed set: ${ctx.allowedRepositories.join(", ")}`);
};

// ---------------------------------------------------------------- built-in integrations (all read-only)

export function registerBuiltinTools() {
  registerIntegrationTool({
    name: "hasaki_work.get_task",
    summary: "Fetch a Hasaki Work task (description, assignees, attachments, AI hints) by numeric task id.",
    description: "Read-only. Returns the task detail from Hasaki Work (wshr API) for a numeric task id (the number in the task URL). Requires the platform to be logged in to Hasaki Work.",
    input: z.object({ task_id: z.number().int().positive() }),
    readOnly: true,
    available: () => true,
    handler: async ({ task_id }) => {
      const j: any = await workApi("GET", config.hasakiWork.detailPath.replace("{id}", String(task_id)));
      const d = j?.data ?? j;
      return { id: d.id, code: d.code, name: d.name, project: d.project?.name, note: d.note, status: d.status, date_end: d.date_end, note_files: d.note_files, parent: d.parent && { code: d.parent.code, name: d.parent.name }, assignees: (d.assign_to_user ?? []).map((u: any) => u.staff_name), ai_hint: d.task_ai?.ai_suggest?.reasoning };
    },
  });
  registerIntegrationTool({
    name: "hasaki_work.my_tasks",
    summary: "List the developer's current Hasaki Work tasks (code, name, project).",
    description: "Read-only. The task list of the logged-in developer, using the platform's configured list endpoint and filters.",
    input: z.object({}),
    readOnly: true,
    available: () => true,
    handler: async () => {
      const j: any = await workApi("GET", config.hasakiWork.listPath, { ...config.hasakiWork.listQuery, to_date: new Date().toLocaleDateString("sv-SE") });
      const rows: any[] = Array.isArray(j?.data) ? j.data : (j?.data?.rows ?? []);
      return rows.map((t) => ({ id: t.id, code: t.code, name: t.name, project: t.project?.name ?? t.project_name }));
    },
  });
  registerIntegrationTool({
    name: "jira.get_issue",
    summary: "Fetch a Jira issue (summary, description, status, labels) by key, e.g. OMS-123.",
    description: "Read-only. Jira Cloud REST v3 issue lookup; the description is flattened to text.",
    input: z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/) }),
    readOnly: true,
    available: () => (config.jira.baseUrl && config.jira.user && config.jira.token ? true : "Jira not configured (jira.baseUrl, JIRA_USER, JIRA_TOKEN)"),
    handler: async ({ key }) => {
      const res = await fetch(`${config.jira.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${key}?fields=summary,description,project,status,issuetype,priority,labels`, {
        headers: { Authorization: "Basic " + Buffer.from(`${config.jira.user}:${config.jira.token}`).toString("base64"), Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Jira ${res.status}`);
      return normalizeJiraIssue(await res.json());
    },
  });
  registerIntegrationTool({
    name: "bitbucket.list_pull_requests",
    summary: "List Bitbucket pull requests of an allowed repository, optionally by source branch and state.",
    description: "Read-only. Bitbucket Cloud pull requests of `repo` (repository registry name; must be in the run's allowed set). state: OPEN | MERGED | DECLINED | SUPERSEDED (default OPEN).",
    input: z.object({ repo: z.string(), branch: z.string().optional(), state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional() }),
    readOnly: true,
    available: () => (config.bitbucket.user && config.bitbucket.token ? true : "Bitbucket credentials not configured"),
    handler: async ({ repo, branch, state }, ctx) => {
      allowedRepo(repo, ctx);
      const slug = (await repositories.get(repo))?.remote_slug || repo;
      return listPullRequests(slug, { branch, state });
    },
  });
  registerIntegrationTool({
    name: "repositories.search",
    summary: "Rank this run's allowed repositories for a description, with explanations (services, tags, project).",
    description: "Read-only. Deterministic, explainable ranking over the repository registry, restricted to the run's allowed repositories.",
    input: z.object({ query: z.string().min(2), project: z.string().optional() }),
    readOnly: true,
    available: () => true,
    handler: async ({ query, project }, ctx) => {
      const rows = (await repositories.list()).filter((r) => ctx.allowedRepositories.includes(r.name));
      return rankRepositories(rows, { text: query, project }).slice(0, 10);
    },
  });
  registerIntegrationTool({
    name: "run.changes",
    summary: "This run's git changes per worktree: commits, changed files and diff stats (diff optional).",
    description: "Read-only. Commits ahead of the base branch, changed files, uncommitted status for every worktree of this run. Set include_diff for the unified diff (capped).",
    input: z.object({ include_diff: z.boolean().optional() }),
    readOnly: true,
    available: () => true,
    handler: async ({ include_diff }, ctx) => {
      const c = await runChanges(ctx.runId);
      return c.repos.map((r: any) => ({ repo: r.repo, branch: r.branch, commits: r.commits, files: r.files, uncommitted: r.status, ...(include_diff ? { diff: r.diff?.slice(0, 30000) } : {}) }));
    },
  });
  registerIntegrationTool({
    name: "run.step_history",
    summary: "Full history of a step in this run: every attempt with status, error and complete output.",
    description: "Read-only. All attempts (including invalidated ones from earlier generations) of `step_key` in this run, oldest first, with full outputs — use when an earlier result was summarized or superseded.",
    input: z.object({ step_key: z.string() }),
    readOnly: true,
    available: () => true,
    handler: async ({ step_key }, ctx) =>
      q(
        pool,
        `SELECT a.number, a.generation, a.status, a.output, a.error, a.started_at, a.finished_at, a.invalidated_at
           FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = $2 ORDER BY a.number`,
        [ctx.runId, step_key],
      ),
  });
}
