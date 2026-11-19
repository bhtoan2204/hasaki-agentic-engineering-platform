import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { execution } from "../auth/execution.ts";
import { audit } from "../authz/access.ts";
import { searchCodeExact, searchSymbols } from "../codeIntelligence/search.ts";
import { localScope } from "../codeIntelligence/indexer.ts";
import { listAccessibleRepositories } from "../repos/access.ts";
import { redactContextValue } from "../context/redact.ts";
import { isSecretPath } from "../agent/toolPolicy.ts";
import { investigationSearch } from "../integrations/splunk.ts";
import { searchLogs } from "../integrations/signoz.ts";
import { databaseForRun, databasesForRun, runQuery } from "../integrations/database.ts";
import { callTool, describeTool, integrationTools, listTools } from "../agent/toolRegistry.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { chatRepository } from "./repository.ts";
import { readKnowledge, searchKnowledge } from "./knowledge.ts";
import { proposeOperation, verifyOperation } from "./operations.ts";
import { learnProcedure } from "./memory.ts";
import { background } from "../workflow/background.ts";
import { LIMITS } from "./policy.ts";
import { MODE_GROUPS, type ToolGroup } from "./toolGroups.ts";
import type { ManualChatMode } from "./types.ts";

/**
 * Chat tool binding. Unlike workflow tools (bound to an attempt lease and fencing token), a chat tool call is bound
 * to the authenticated owner, the conversation, its single active turn and the conversation mode. Every call
 * re-reads all of them plus the owner's current repository permissions, so a revoked grant or a canceled turn
 * stops the next call. Integration tools come from the shared registry (src/agent/toolRegistry.ts) through
 * tools.search/describe/call; a mutating one is never executed here — it becomes an operation the owner confirms.
 */
export interface ChatBinding {
  userId: number;
  conversationId: number;
  turnId: number;
  /** Effective manual mode (AUTO is resolved before tools run). */
  mode: ManualChatMode;
  /** Repositories the conversation is scoped to (plus repositories explicitly mentioned in this turn). */
  repositories: string[];
}

export class ChatToolDenied extends Error {}

interface ToolContext {
  binding: ChatBinding;
  /** Readable ∩ conversation scope (or all readable when the conversation has no scope). Re-read per call. */
  readable: string[];
  scoped: string[];
  signal: AbortSignal;
}
interface ToolResult {
  data: unknown;
  repositories?: string[];
  label: string;
}
interface ToolDef {
  name: string;
  group: ToolGroup;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool binds its own zod-inferred args
  args: z.ZodType<any>;
  /** Argument shape shown to the model. */
  usage: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

const repoArg = z.array(z.string().min(1).max(200)).max(10).optional();

function pickRepositories(ctx: ToolContext, requested: string[] | undefined) {
  const wanted = requested?.length ? requested : ctx.scoped;
  if (!wanted.length)
    throw new ChatToolDenied(
      "no repository in scope: pass repositories (see repo.list) or set the conversation scope",
    );
  const outside = wanted.filter((r) => !ctx.readable.includes(r));
  // Same answer for unknown and not permitted: other repositories' existence is not revealed.
  if (outside.length) throw new ChatToolDenied(`repositories not accessible: ${outside.join(", ")}`);
  return wanted.slice(0, 10);
}

/** Knowledge applies to the conversation's repository scope (not every readable repository). */
const knowledgeScope = (ctx: ToolContext, text: string) => ({
  ownerId: ctx.binding.userId,
  repositories: ctx.scoped,
  text,
});

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);

/** Run-bound registry tools (this run's changes, step history) have no meaning in a conversation. */
const chatVisible = (name: string) => !name.startsWith("run.");

const TOOLS: ToolDef[] = [
  {
    name: "tools.search",
    group: "integrations",
    description:
      "Find platform integration tools (Kafka QC, Argo CD, Vault, Jira, SigNoz, Splunk, QC databases, Git hosting…) by keywords; shows availability and whether a tool changes state.",
    usage: '{"query": "kafka publish topic"}',
    args: z.object({ query: z.string().max(200).optional() }).strict(),
    async run(a) {
      await loadPersonalIntegrations();
      return {
        label: `tools "${cut(a.query ?? "", 40)}"`,
        data: listTools(a.query, { mode: "coding" })
          .filter((t) => chatVisible(t.name))
          .slice(0, 20)
          .map(({ score: _s, ...t }) => t),
      };
    },
  },
  {
    name: "tools.describe",
    group: "integrations",
    description: "Full description and JSON input schema of one integration tool (read it before tools.call).",
    usage: '{"name": "kafka.read_messages"}',
    args: z.object({ name: z.string().min(1).max(100) }).strict(),
    async run(a) {
      if (!chatVisible(a.name)) throw new ChatToolDenied(`${a.name} is only available inside a workflow run`);
      await loadPersonalIntegrations();
      return { label: `tool ${a.name}`, data: describeTool(a.name) };
    },
  },
  {
    name: "operations.verify",
    group: "integrations",
    description:
      "Verify an operation's business outcome: after reading it back with a read-only tool in this turn, pass that tool call's #seq and an identifier from the operation's payload/response (e.g. the order code). The platform checks the evidence itself.",
    usage: '{"operation_id": 12, "evidence_seq": 4, "match": "SO-123"}',
    args: z
      .object({
        operation_id: z.number().int().positive(),
        evidence_seq: z.number().int().positive(),
        match: z.string().min(3).max(200),
      })
      .strict(),
    async run(a, ctx) {
      return {
        label: `verify operation #${a.operation_id}`,
        data: await verifyOperation(ctx.binding, a, (op) =>
          background(`chat procedure ${op.id}`, () => learnProcedure(op)),
        ),
      };
    },
  },
  {
    name: "tools.call",
    group: "integrations",
    description:
      "Call one integration tool. Read-only tools run now. A tool that changes state (e.g. kafka.publish) does NOT run: it becomes an operation the user must confirm in the UI.",
    usage: '{"name": "kafka.read_messages", "arguments": {"topic": "orders", "limit": 5}}',
    args: z.object({ name: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).optional() }).strict(),
    async run(a, ctx) {
      if (!chatVisible(a.name)) throw new ChatToolDenied(`${a.name} is only available inside a workflow run`);
      const tool = integrationTools().find((t) => t.name === a.name);
      if (!tool) throw new ChatToolDenied(`unknown tool ${a.name} — use tools.search`);
      await loadPersonalIntegrations();
      if (!tool.readOnly)
        return {
          label: `operation ${a.name}`,
          data: await proposeOperation(ctx.binding, a.name, a.arguments ?? {}),
        };
      await audit(ctx.binding.userId, "chat.integration.call", "chat_conversation", String(ctx.binding.conversationId), {
        turn_id: ctx.binding.turnId,
        tool: a.name,
      });
      const r = await callTool(a.name, a.arguments ?? {}, {
        runId: null,
        allowedRepositories: ctx.scoped.length ? ctx.scoped : ctx.readable,
        mode: "analysis",
        stepKey: `chat:${ctx.binding.conversationId}`,
      });
      if (!r.ok) throw new Error(r.error ?? `${a.name} failed`);
      return { label: a.name, data: r.result };
    },
  },
  {
    name: "repo.list",
    group: "repo",
    description: "Repositories you may read in this conversation.",
    usage: "{}",
    args: z.object({}).strict(),
    async run(_a, ctx) {
      const all = await listAccessibleRepositories(ctx.binding.userId);
      const names = new Set(ctx.scoped.length ? ctx.scoped : ctx.readable);
      return {
        label: "repositories",
        data: all
          .filter((r) => names.has(r.repository.name))
          .map((r) => ({
            name: r.repository.name,
            projects: r.repository.projects,
            default_branch: r.repository.default_branch,
          })),
      };
    },
  },
  {
    name: "code.search",
    group: "repo",
    description:
      "Search source code: symbol/definition search by default, exact text search with exact=true (any non-secret file).",
    usage: '{"query": "OrderService.create", "repositories?": ["repo"], "exact?": false, "limit?": 20}',
    args: z
      .object({
        query: z.string().min(2).max(256),
        repositories: repoArg,
        exact: z.boolean().optional(),
        limit: z.number().int().min(1).max(30).optional(),
      })
      .strict(),
    async run(a, ctx) {
      const repositories = pickRepositories(ctx, a.repositories);
      const scope = { repositories, allowed: ctx.readable, provision: false };
      const limit = a.limit ?? 15;
      const hits = a.exact
        ? await searchCodeExact(a.query, scope, limit, { anyFile: true })
        : (await searchSymbols(a.query, scope, limit)).hits;
      return {
        label: `code search "${cut(a.query, 60)}"`,
        repositories,
        data: hits.slice(0, limit).map((h) => ({
          repository: h.repository,
          file: h.file_path,
          lines: h.line_range,
          symbol: h.qualified_name ?? h.symbol_name,
          snippet: h.snippet ? cut(h.snippet, 400) : undefined,
        })),
      };
    },
  },
  {
    name: "code.read_file",
    group: "repo",
    description: "Read a bounded line range of one file in a readable repository (secret files are refused).",
    usage: '{"repository": "repo", "path": "src/app.ts", "start_line?": 1, "end_line?": 200}',
    args: z
      .object({
        repository: z.string().min(1).max(200),
        path: z.string().min(1).max(500),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      })
      .strict(),
    async run(a, ctx) {
      const [repository] = pickRepositories(ctx, [a.repository]);
      return {
        label: `${repository}/${a.path}`,
        repositories: [repository],
        data: await readRepositoryFile(repository, a.path, a.start_line, a.end_line),
      };
    },
  },
  {
    name: "knowledge.search",
    group: "knowledge",
    description:
      "Search the Knowledge & Skills registry that applies here (business rules, domain knowledge, architecture guidelines, runbooks, conventions, agent skills; Vietnamese or English). Use category \"agent_skill\" to find skills. Check this before searching code.",
    usage: '{"query": "hoàn tiền platform_price", "category?": "business_rule", "limit?": 8}',
    args: z
      .object({
        query: z.string().min(2).max(300),
        category: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    async run(a, ctx) {
      return {
        label: `knowledge "${cut(a.query, 60)}"`,
        data: await searchKnowledge(knowledgeScope(ctx, a.query), a.query, a.category, a.limit ?? 8),
      };
    },
  },
  {
    name: "knowledge.get",
    group: "knowledge",
    description:
      "Read the full current version of one knowledge item or skill by key (paged with offset). Reading a skill activates it and lists its supporting documents, readable with this tool.",
    usage: '{"key": "conventions/api", "offset?": 0}',
    args: z.object({ key: z.string().min(1).max(200), offset: z.number().int().min(0).optional() }).strict(),
    async run(a, ctx) {
      const item = await readKnowledge(knowledgeScope(ctx, a.key), a.key, a.offset ?? 0);
      if (!item) throw new ChatToolDenied(`knowledge "${a.key}" not found`);
      return { label: "version" in item ? `knowledge ${a.key} v${item.version}` : `knowledge ${a.key}`, data: item };
    },
  },
  {
    name: "work_items.search",
    group: "platform",
    description: "Search your work items by text (code, title, description).",
    usage: '{"query?": "checkout", "limit?": 10}',
    args: z
      .object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() })
      .strict(),
    async run(a, ctx) {
      return {
        label: "work items",
        data: await chatRepository.searchWorkItems(ctx.binding.userId, (a.query ?? "").trim(), a.limit ?? 10),
      };
    },
  },
  {
    name: "runs.get",
    group: "platform",
    description: "Status and steps of one of your workflow runs.",
    usage: '{"run_id": 123}',
    args: z.object({ run_id: z.number().int().positive() }).strict(),
    async run(a, ctx) {
      const run = await chatRepository.ownedRun(a.run_id, ctx.binding.userId);
      if (!run) throw new ChatToolDenied(`run ${a.run_id} not found`);
      return { label: `run #${run.id}`, data: { ...run, steps: await chatRepository.runSteps(run.id) } };
    },
  },
  {
    name: "incidents.search",
    group: "platform",
    description: "Production error groups detected by the platform scan (signature, service, severity, counts).",
    usage: '{"query?": "NullPointerException", "limit?": 10}',
    args: z
      .object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() })
      .strict(),
    async run(a) {
      return {
        label: "production incidents",
        data: await chatRepository.searchIncidents((a.query ?? "").trim(), a.limit ?? 10),
      };
    },
  },
  {
    name: "splunk.search",
    group: "observability",
    description:
      "Read-only Splunk search with your own Splunk credentials (validated investigation SPL, bounded results).",
    usage: '{"query": "index=app error checkout", "earliest?": "-60m", "latest?": "now", "max_results?": 50}',
    args: z
      .object({
        query: z.string().min(3).max(4000),
        earliest: z.string().max(40).optional(),
        latest: z.string().max(40).optional(),
        max_results: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    async run(a) {
      const r = await investigationSearch({ ...a, max_results: a.max_results ?? 50, page_size: 50 }, {});
      return { label: `splunk "${cut(a.query, 60)}"`, data: r };
    },
  },
  {
    name: "signoz.logs",
    group: "observability",
    description: "Read-only SigNoz log search with your own SigNoz credentials.",
    usage: '{"service?": "checkout", "severity?": "error", "expression?": "body contains \'timeout\'", "since_minutes?": 60, "limit?": 50}',
    args: z
      .object({
        service: z.string().max(200).optional(),
        environment: z.string().max(100).optional(),
        severity: z.string().max(20).optional(),
        trace_id: z.string().max(64).optional(),
        expression: z.string().max(1000).optional(),
        since_minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    async run(a) {
      const r = await searchLogs({ ...a, limit: a.limit ?? 50 }, {});
      return { label: "signoz logs", data: r };
    },
  },
  {
    name: "database.list",
    group: "database",
    description: "Read-only project databases available for the repositories in scope.",
    usage: "{}",
    args: z.object({}).strict(),
    async run(_a, ctx) {
      const dbs = await databasesForRun(ctx.scoped.length ? ctx.scoped : ctx.readable);
      return {
        label: "databases",
        data: dbs.map((d) => ({ key: d.key, project: d.project, engine: d.engine, max_rows: d.max_rows })),
      };
    },
  },
  {
    name: "database.query",
    group: "database",
    description:
      "One read-only SELECT on a project database in scope (validated, row-capped, timeout-bounded, audited; sensitive columns masked).",
    usage: '{"database": "orders", "sql": "SELECT id, status FROM orders ORDER BY id DESC LIMIT 20", "max_rows?": 50}',
    args: z
      .object({
        database: z.string().min(1).max(100),
        sql: z.string().min(6).max(20_000),
        max_rows: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    async run(a, ctx) {
      const allowed = ctx.scoped.length ? ctx.scoped : ctx.readable;
      const db = await databaseForRun(a.database, allowed);
      await audit(ctx.binding.userId, "chat.database.query", "chat_conversation", String(ctx.binding.conversationId), {
        turn_id: ctx.binding.turnId,
        database: db.key,
        sql: cut(a.sql, 2000),
      });
      const r = await runQuery(db, a.sql, Math.min(a.max_rows ?? 50, 200));
      return {
        label: `database ${db.key}`,
        repositories: db.repositories.filter((r) => allowed.includes(r)),
        data: r,
      };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolsForMode(mode: ManualChatMode) {
  const groups = MODE_GROUPS[mode];
  return TOOLS.filter((t) => groups.includes(t.group));
}

/** The catalog text placed in the prompt (no schema internals, just names, purpose and argument examples). */
export function toolCatalog(mode: ManualChatMode) {
  return toolsForMode(mode)
    .map((t) => `- ${t.name}: ${t.description} Arguments: ${t.usage}`)
    .join("\n");
}

export async function readRepositoryFile(repository: string, path: string, start?: number, end?: number) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new ChatToolDenied("path must be relative to the repository");
  if (isSecretPath(path)) throw new ChatToolDenied("secret files are not readable from chat");
  const { root } = await localScope(repository, undefined, false);
  const base = await realpath(root);
  const abs = await realpath(join(base, path)).catch(() => null);
  if (!abs) throw new ChatToolDenied(`file not found: ${path}`);
  const rel = relative(base, abs);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/)[0] === ".git" || isSecretPath(abs))
    throw new ChatToolDenied("path is outside the readable repository files");
  const info = await stat(abs);
  if (!info.isFile()) throw new ChatToolDenied("not a file");
  if (info.size > 2_000_000) throw new ChatToolDenied("file too large for chat (2 MB)");
  const lines = (await readFile(abs, "utf8")).split("\n");
  const from = Math.max(1, start ?? 1);
  const to = Math.min(lines.length, end ?? from + 199, from + 399);
  return {
    repository,
    path: rel,
    lines: [from, to],
    total_lines: lines.length,
    content: lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}: ${l}`)
      .join("\n"),
  };
}

/** Readable repositories now, for this user — never cached across calls (revocation applies to the next call). */
export async function readableRepositories(userId: number) {
  return (await listAccessibleRepositories(userId)).map((r) => r.repository.name);
}

export async function assertBinding(b: ChatBinding) {
  const user = await chatRepository.userActive(b.userId);
  if (!user?.active) throw new ChatToolDenied("user is not active");
  const conversation = await chatRepository.getConversation(b.conversationId, b.userId);
  if (!conversation) throw new ChatToolDenied("conversation not found");
  const turn = await chatRepository.getTurn(b.turnId);
  if (!turn || turn.conversation_id !== b.conversationId || turn.owner_id !== b.userId)
    throw new ChatToolDenied("turn does not belong to this conversation");
  if (turn.status !== "running") throw new ChatToolDenied(`turn is ${turn.status}`);
  // Effective mode is frozen on the turn (AUTO resolves once); conversation.mode may stay AUTO.
  const effective = (turn.effective_mode || turn.mode) as ManualChatMode;
  if (effective !== b.mode && conversation.mode !== "AUTO")
    throw new ChatToolDenied("conversation mode changed during the turn");
  if (effective !== b.mode && conversation.mode === "AUTO" && turn.effective_mode && turn.effective_mode !== b.mode)
    throw new ChatToolDenied("effective mode changed during the turn");
}

export interface ToolOutcome {
  status: "ok" | "error" | "denied" | "timeout";
  result: unknown;
  repositories: string[];
  label: string;
}

/** Validate the binding, mode, arguments and repository scope, then run one tool with a deadline. */
export async function executeChatTool(
  binding: ChatBinding,
  name: string,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const def = BY_NAME.get(name);
  if (!def) return { status: "denied", result: { error: `unknown tool ${name}` }, repositories: [], label: name };
  if (!MODE_GROUPS[binding.mode].includes(def.group))
    return {
      status: "denied",
      result: { error: `${name} is not available in ${binding.mode} mode` },
      repositories: [],
      label: name,
    };
  try {
    await assertBinding(binding);
    const args = def.args.safeParse(rawArgs ?? {});
    if (!args.success)
      return {
        status: "error",
        result: { error: `invalid arguments: ${args.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` },
        repositories: [],
        label: name,
      };
    const readable = await readableRepositories(binding.userId);
    const scoped = binding.repositories.filter((r) => readable.includes(r));
    const deadline = AbortSignal.timeout(LIMITS.toolTimeoutMs);
    const both = AbortSignal.any([signal, deadline]);
    const run = execution.run({ userId: binding.userId, kind: "user" }, () =>
      def.run(args.data, { binding, readable, scoped, signal: both }),
    );
    const aborted = new Promise<never>((_, reject) => {
      both.addEventListener("abort", () => reject(both.reason ?? new Error("aborted")), { once: true });
    });
    const out = await Promise.race([run, aborted]);
    return {
      status: "ok",
      result: redactContextValue(out.data),
      repositories: out.repositories ?? [],
      label: out.label,
    };
  } catch (e) {
    if (signal.aborted) throw e;
    const err = e as Error;
    if (err?.name === "TimeoutError")
      return { status: "timeout", result: { error: `timed out after ${LIMITS.toolTimeoutMs} ms` }, repositories: [], label: name };
    const denied = e instanceof ChatToolDenied || /not found|not accessible|unauthorized|not available/i.test(err?.message ?? "");
    return {
      status: denied ? "denied" : "error",
      result: { error: cut(String(err?.message ?? e), 500) },
      repositories: [],
      label: name,
    };
  }
}
