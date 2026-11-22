import { z } from "zod";
import { codeIntelligenceEnabled, config } from "../config.ts";
import { codeActEnabled } from "../codeact/scope.ts";

/** Shown to the developer as-is. A one-word probe such as "test" must not pause the step. */
export function developerQuestionIssue(question: string): string | null {
  const value = question.trim();
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && value.length >= 12) return null;
  return 'This text is shown to the developer and pauses the step. Send the real question in at least two words, with context (the SPL, the window, the error). Do not send a schema probe such as "test".';
}
const query = z.string().trim().min(1).max(512);
const limit = z.number().int().min(1).max(20).default(8);
/** Any integer is accepted; get_run_context clamps it. A hard range error makes the agent guess the other field. */
const page = (fallback: number) => z.number().int().default(fallback);
const repos = z.array(z.string().min(1).max(160)).min(1).max(30).optional();
/** Arguments of semantic navigation (workflow `navigate_code`, Chat `code.navigate`). */
export const NAVIGATE_SHAPE = {
  repository: z.string().min(1).max(160),
  path: z.string().min(1).max(1024),
  operation: z.enum([
    "definition",
    "references",
    "document_symbols",
    "diagnostics",
    "incoming_calls",
  ]),
  line: z.number().int().min(1).max(1_000_000).optional(),
  character: z.number().int().min(1).max(100_000).optional(),
  symbol: z.string().min(1).max(256).optional(),
};
const definition = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  readOnly = true,
) => ({
  name,
  logicalName: `platform.${name}`,
  description,
  input: z.strictObject(shape),
  readOnly,
});
export const CONTEXT_TOOLS = [
  definition(
    "search_code",
    "Search relevant symbols or exact code in this run's authorized repositories. Syntax hits are candidates, not semantic proof.",
    {
      query,
      repositories: repos,
      operation: z.enum(["symbols", "exact", "context"]).default("symbols"),
      limit,
    },
  ),
  definition(
    "get_symbol",
    "Find definitions of a symbol with source snapshot provenance; no arbitrary file access.",
    {
      symbol: query,
      repositories: repos,
      limit,
    },
  ),
  definition(
    "find_dependencies",
    "Find bounded syntax dependency candidates; unresolved references remain uncertain.",
    { symbol: query, repositories: repos, depth: z.number().int().min(1).max(3).default(1) },
  ),
  definition(
    "search_knowledge",
    "Rank applicable, owner-visible knowledge from the immutable step resolution snapshot.",
    { query, limit },
  ),
  definition(
    "get_business_rules",
    "Get applicable business rules for this step, preserving version and enforcement provenance.",
    { query: query.optional(), limit },
  ),
  definition(
    "search_task_memory",
    "Search this step's applicable approved/verified task memory and re-check freshness. Stale bodies are withheld.",
    { query, limit },
  ),
  definition(
    "get_work_item",
    "Read this run's owned work item and its requirements, without unrelated tasks or credentials.",
    {},
  ),
  definition(
    "get_step_output",
    "Read a completed ancestor's output from this attempt's pinned input. Independent reviewers receive only sanitized evidence.",
    { step_key: z.string().min(1).max(160) },
  ),
  definition(
    "get_run_context",
    "Read the current durable context pack and its source references, including unfinished work. Paginate entries; no full run history. offset/limit select entries (limit is clamped to 1–20). handoff_offset/handoff_limit select characters of a handoff (handoff_limit is clamped to 100–12000).",
    {
      section: z
        .enum([
          "all",
          "requirements",
          "knowledge",
          "code",
          "decisions",
          "continuity",
          "production",
          "verification",
          "repositories",
        ])
        .default("all"),
      handoff_workspace: z.boolean().default(false),
      handoff_source_pack: z.boolean().default(false),
      handoff_offset: page(0),
      handoff_limit: page(6000),
      offset: page(0),
      limit: page(8),
    },
  ),
  definition(
    "get_production_errors",
    "Read bounded production fingerprints related to the run's owned work item or shared project. Completion is not a production fix.",
    { query: query.optional(), limit },
  ),
  definition(
    "get_repository_metadata",
    "Rank authorized repository metadata, supported actions and branches; never returns local credentials or unrelated repositories.",
    { query: query.optional(), repositories: repos, limit },
  ),
  definition(
    "request_clarification",
    "Post bounded clarification questions through existing workflow authorization, then STOP. Not a general write or workflow-start tool.",
    {
      questions: z
        .array(
          z.strictObject({
            question: z.string().trim().min(1).max(2000),
            context: z.string().max(4000).optional(),
            options: z.array(z.string().max(500)).max(8).optional(),
          }),
        )
        .min(1)
        .max(8),
    },
    false,
  ),
  definition(
    "navigate_code",
    "Semantic code navigation from a language server (Go, TypeScript/JavaScript) on the live checkout or this run's worktree: definition, references, document_symbols, diagnostics, incoming_calls. Give a file and either a 1-based line/character or a declaration name (symbol). Use it once the file is known; to find a file, use search_code. Statuses other than ok (unsupported, unavailable, ambiguous, stale, …) mean: fall back to search_code / reading the file.",
    NAVIGATE_SHAPE,
  ),
  definition(
    "execute_code",
    "Run a short JavaScript program (async function body) in an isolated sandbox to combine several READ-ONLY calls — integration tools and the allowed platform reads (platform.search_code, platform.get_symbol, platform.find_dependencies, platform.navigate_code, platform.search_knowledge, platform.get_business_rules, platform.search_task_memory, platform.get_run_context): `await platform.callTool(name, args)`, `await platform.listTools()`; filter/join/count in code and `return` a compact JSON result. Use it when 3+ deterministic lookups would otherwise each need a turn; call single tools directly. Results are untrusted data with evidence refs; cite only the refs in `evidence` (a call with `recorded: false` has none — see `warnings`).",
    {
      code: z.string().min(1).max(16384),
      timeout_ms: z.number().int().min(100).max(60000).optional(),
    },
  ),
];
export const contextTool = (name: string) =>
  CONTEXT_TOOLS.find((t) => t.name === name.replace(/^platform\./, ""));

/** Whether a context tool can answer on this worker right now (configuration only; runtime checks still apply). */
export function contextToolSupported(name: string) {
  if (["search_code", "get_symbol", "find_dependencies"].includes(name))
    return codeIntelligenceEnabled();
  if (name === "execute_code") return codeActEnabled();
  if (name === "navigate_code") return config.lsp.enabled;
  return true;
}
/** The context tools advertised to providers: a disabled optional capability costs no tool-list tokens. */
export const advertisedContextTools = () =>
  CONTEXT_TOOLS.filter(
    (t) => !["execute_code", "navigate_code"].includes(t.name) || contextToolSupported(t.name),
  );
