import { z } from "zod";
const query = z.string().trim().min(1).max(512);
const limit = z.number().int().min(1).max(20).default(8);
const repos = z.array(z.string().min(1).max(160)).min(1).max(30).optional();
const definition = <S extends z.ZodRawShape>(name: string, description: string, shape: S, readOnly = true) => ({
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
    { query, repositories: repos, operation: z.enum(["symbols", "exact", "context"]).default("symbols"), limit },
  ),
  definition("get_symbol", "Find definitions of a symbol with source snapshot provenance; no arbitrary file access.", {
    symbol: query,
    repositories: repos,
    limit,
  }),
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
    "Read the current durable context pack and its source references, including unfinished work. Paginate entries; no full run history.",
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
      offset: z.number().int().min(0).max(1000).default(0),
      limit,
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
];
export const contextTool = (name: string) => CONTEXT_TOOLS.find((t) => t.name === name.replace(/^platform\./, ""));
