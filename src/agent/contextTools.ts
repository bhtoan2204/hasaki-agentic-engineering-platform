import { postClarification } from "./toolRuntime.ts";
import { codeIntelligenceEnabled, config } from "../config.ts";
import {
  searchSymbols,
  searchCodeExact,
  findDefinitions,
  findDependencies,
  buildCodeContext,
} from "../codeIntelligence/search.ts";
import { pool, q, one } from "../db/pool.ts";
import { repositories, rankRepositories } from "../repos/service.ts";
import { scoreKnowledge, summarizeValue } from "../context/plan.ts";
import { memoryFreshness } from "../knowledge/memory.ts";
import { repoPath } from "../repos/service.ts";
import { redactContextValue } from "../context/redact.ts";
import type { PlatformToolEnv } from "./platformTools.ts";

import { CONTEXT_TOOLS } from "./contextToolSchemas.ts";
export { CONTEXT_TOOLS, contextTool } from "./contextToolSchemas.ts";
export const MAX_CONTEXT_RESULT_CHARS = 24000;
export function boundedContextJson(value: unknown): string {
  const text = JSON.stringify(redactContextValue(value)) ?? "null";
  if (text.length <= MAX_CONTEXT_RESULT_CHARS) return text;
  return JSON.stringify({
    truncated: true,
    original_chars: text.length,
    summary: summarizeValue(JSON.parse(text), MAX_CONTEXT_RESULT_CHARS - 1000),
    next: "Narrow the query or paginate get_run_context; do not assume omitted constraints are absent.",
  });
}
export function source(
  id: string | number,
  version: string | number | null,
  timestamp: unknown,
  visibility: "owner" | "shared",
  relevance: string,
  state = "snapshot",
) {
  return {
    source_id: String(id),
    version,
    timestamp: timestamp == null ? null : new Date(String(timestamp)).toISOString(),
    visibility,
    relevance,
    state,
  };
}
export async function authorizedRepositoryRows(env: PlatformToolEnv, requested?: string[]) {
  const names = requested ?? (env.selected.length ? env.selected : env.allowed).slice(0, 30);
  if (names.some((name) => !env.allowed.includes(name)))
    throw new Error("Repository outside authorized run scope");
  const rows = (await repositories.list()).filter((r) => names.includes(r.name));
  if (
    rows.length !== new Set(names).size ||
    rows.some((r) => !r.enabled || !r.allowed_actions.includes("read"))
  )
    throw new Error("Repository unavailable or read permission revoked");
  return rows;
}

export async function relatedProductionErrors(env: PlatformToolEnv, text = "", max = 8) {
  const run = await one(
    pool,
    `SELECT r.work_item_id,COALESCE(NULLIF(w.project,''),r.inputs->>'project') AS project FROM workflow_runs r LEFT JOIN work_items w ON w.id=r.work_item_id WHERE r.id=$1 AND r.owner_id=$2`,
    [env.runId, env.ownerId],
  );
  if (!run) throw new Error("Run ownership unavailable");
  const namespaces = config.prodErrors.namespaces
    .filter((n) => n.project === run.project)
    .map((n) => n.namespace);
  const rows = await q(
    pool,
    `SELECT g.fingerprint,g.namespace,g.service,g.signature,g.severity,g.today_count,g.first_at,g.last_at,g.lifecycle_status,g.updated_at
    FROM prod_error_groups g WHERE g.work_item_id=$1 OR (g.work_item_id IS NULL AND g.namespace=ANY($2::text[]))
    ORDER BY CASE WHEN $3='' THEN 0 WHEN g.signature ILIKE '%'||$3||'%' THEN 1 ELSE 0 END DESC,g.score DESC,g.fingerprint LIMIT $4`,
    [run.work_item_id, namespaces, text.slice(0, 128), max],
  );
  return rows.map((r) => ({
    ...r,
    provenance: source(
      `production:${r.fingerprint}`,
      null,
      r.updated_at,
      "shared",
      "owned work item or unlinked configured project incident; resolution requires supported lifecycle status",
    ),
    uncertain: true,
  }));
}

/** Re-check visibility against the live registry, while serving the exact snapshot version/body. */
export async function visibleSnapshotKnowledge(env: PlatformToolEnv) {
  if (!env.knowledge.length) return [];
  const rows = await q(
    pool,
    `SELECT i.id,i.key,i.owner_id,v.version,v.content FROM knowledge_items i JOIN knowledge_versions v ON v.item_id=i.id
    WHERE i.enabled AND (i.owner_id IS NULL OR i.owner_id=$1) AND i.key=ANY($2::text[]) AND v.version=ANY($3::int[]) LIMIT 2000`,
    [
      env.ownerId,
      env.knowledge.map((k) => k.key),
      [...new Set(env.knowledge.map((k) => k.version))],
    ],
  );
  return env.knowledge.filter((k) =>
    rows.some(
      (r) =>
        (k.id == null ? r.key === k.key : r.id === k.id) &&
        r.version === k.version &&
        r.content === k.content,
    ),
  );
}
/** Per-attempt code-intelligence usage (index hit / fallback rate, latency), persisted as metrics.code_intelligence_usage. */
export interface CodeIntelligenceUsage {
  calls: Record<string, number>;
  index_hits: number;
  fallbacks: number;
  ripgrep_exact: number;
  empty_results: number;
  unavailable_repos: string[];
  latency_ms_total: number;
  latency_ms_max: number;
}
const usage = new Map<unknown, CodeIntelligenceUsage>();
function usageOf(env: { attemptId?: number | null }) {
  const k = env.attemptId ?? env; // one accumulator per attempt, whichever bridge builds the env
  let u = usage.get(k);
  if (!u) {
    if (usage.size > 500) usage.delete(usage.keys().next().value);
    usage.set(
      k,
      (u = {
        calls: {},
        index_hits: 0,
        fallbacks: 0,
        ripgrep_exact: 0,
        empty_results: 0,
        unavailable_repos: [],
        latency_ms_total: 0,
        latency_ms_max: 0,
      }),
    );
  }
  return u;
}
export async function executeContextTool(
  name: string,
  args: any,
  env: PlatformToolEnv,
): Promise<unknown> {
  switch (name) {
    case "search_code":
    case "get_symbol":
    case "find_dependencies": {
      const rows = await authorizedRepositoryRows(env, args.repositories);
      if (!codeIntelligenceEnabled())
        return { supported: false, reason: "Code intelligence disabled on this worker", hits: [] };
      const scope = {
        repositories: rows.map((r) => r.name),
        allowed: env.allowed,
        runId: env.runId,
        provision: false,
      };
      const started = Date.now();
      const op = name === "search_code" ? `search_code:${args.operation ?? "symbols"}` : name;
      const note = async (r: {
        fallback: number;
        unavailable?: string[];
        empty: boolean;
        ripgrep?: boolean;
      }) => {
        const u = usageOf(env);
        u.calls[op] = (u.calls[op] ?? 0) + 1;
        if (r.ripgrep) u.ripgrep_exact++;
        else if (r.fallback || r.unavailable?.length) u.fallbacks++;
        else u.index_hits++;
        if (r.empty) u.empty_results++;
        for (const x of r.unavailable ?? [])
          if (!u.unavailable_repos.includes(x) && u.unavailable_repos.length < 20)
            u.unavailable_repos.push(x);
        const ms = Date.now() - started;
        u.latency_ms_total += ms;
        u.latency_ms_max = Math.max(u.latency_ms_max, ms);
        await env.recordMetrics?.({ code_intelligence_usage: u }).catch(() => {});
      };
      if (name === "search_code" && args.operation === "context") {
        const context = await buildCodeContext(args.query, scope);
        await env.recordMetrics?.({ code_intelligence: context.metrics });
        await note({
          fallback: Number((context.metrics as any)?.fallback_count ?? 0),
          empty: !(context as any).hits?.length && !(context as any).entries?.length,
        });
        return context;
      }
      if (name === "get_symbol") {
        const r = await findDefinitions(args.symbol, scope);
        const definitions = r.hits.slice(0, args.limit);
        await note({ fallback: r.fallback_count, empty: !definitions.length });
        return {
          definitions,
          ...(r.fallback_count
            ? {
                index_fallback: {
                  repositories_without_fresh_index: r.fallback_count,
                  text_candidates: r.text_candidates,
                },
                warning:
                  "the symbol index was stale or unavailable for some repositories: text matches are listed as candidates only — they are NOT resolved definitions; verify in live files",
              }
            : {}),
          uncertainty: "syntax candidates; check live files and snapshot freshness",
        };
      }
      if (name === "find_dependencies") {
        const report = { unavailable: [] as string[] };
        const dependencies = await findDependencies(args.symbol, scope, args.depth, "out", report);
        await note({ fallback: 0, unavailable: report.unavailable, empty: !dependencies.length });
        return {
          dependencies,
          ...(report.unavailable.length
            ? {
                unavailable_repositories: report.unavailable,
                warning:
                  "no fresh dependency index for these repositories: their edges are missing from this result (not proof of no dependency) — fall back to search_code exact / targeted reads",
              }
            : {}),
          uncertainty: "candidate edges are not semantic resolution",
        };
      }
      if (args.operation === "exact") {
        // Exact strings, config and logs: bounded ripgrep over any non-secret file (never forced through Tree-sitter).
        const hits = (
          await searchCodeExact(args.query, scope, args.limit, { anyFile: true })
        ).slice(0, args.limit);
        await note({ fallback: 0, empty: !hits.length, ripgrep: true });
        return { hits, uncertainty: "text matches are not semantic proof" };
      }
      const r = await searchSymbols(args.query, scope, args.limit);
      await note({ fallback: r.fallback_count, empty: !r.hits.length });
      return r.fallback_count
        ? {
            ...r,
            warning:
              "index stale/unavailable for some repositories: those hits are bounded live text matches (match_type text), not indexed symbols",
          }
        : r;
    }
    case "search_knowledge":
    case "get_business_rules":
    case "search_task_memory": {
      const candidates = (await visibleSnapshotKnowledge(env)).filter((k) =>
        name === "get_business_rules"
          ? k.category === "business_rule"
          : name === "search_task_memory"
            ? k.category === "task_memory"
            : true,
      );
      const ranked = candidates
        .map((k) => ({
          k,
          ...scoreKnowledge(
            { ...k, reason: "resolved step knowledge" },
            args.query ?? "",
            env.stepType,
          ),
        }))
        .filter((x) => !args.query || x.score > 0)
        .sort((a, b) => b.score - a.score || a.k.key.localeCompare(b.k.key))
        .slice(0, args.limit);
      const hits = [];
      for (const { k, score, why } of ranked) {
        let freshness: { state: string; reason: string } = {
          state: "SNAPSHOT",
          reason: "pinned applicable version",
        };
        if (k.category === "task_memory") {
          const memory = k.metadata?.memory;
          const repo =
            memory?.repo && env.allowed.includes(memory.repo)
              ? await repositories.get(memory.repo)
              : null;
          freshness =
            memory && ["verified", "approved"].includes(memory.trust)
              ? await memoryFreshness(memory, repo ? repoPath(repo) : null)
              : { state: "UNKNOWN", reason: "not approved or verified" };
        }
        const visible = k.category !== "task_memory" || freshness.state === "FRESH";
        hits.push({
          key: k.key,
          title: k.title,
          category: k.category,
          content: visible ? k.content : null,
          score,
          freshness,
          provenance: source(
            `knowledge:${k.id ?? k.key}`,
            k.version,
            k.updated_at ?? null,
            k.owner_id == null ? "shared" : "owner",
            why,
            freshness.state,
          ),
        });
      }
      return hits;
    }
    case "get_work_item": {
      const row = await one(
        pool,
        `SELECT w.id,w.code,w.title,COALESCE(NULLIF(w.description,''),w.payload->>'note','') AS description,w.payload->'business_requirements' AS business_requirements,w.payload->'acceptance_criteria' AS acceptance_criteria,w.project,w.source,w.updated_at FROM workflow_runs r JOIN work_items w ON w.id=r.work_item_id AND w.owner_id=r.owner_id WHERE r.id=$1 AND r.owner_id=$2`,
        [env.runId, env.ownerId],
      );
      return row
        ? {
            ...row,
            provenance: source(
              `work_item:${row.id}`,
              null,
              row.updated_at,
              "owner",
              "current run's work item",
            ),
          }
        : { available: false, reason: "Run has no accessible linked work item" };
    }
    case "get_step_output": {
      const u = env.upstream[args.step_key];
      if (!u || u.status !== "COMPLETED")
        throw new Error("Only pinned completed ancestor outputs are available");
      return {
        step_key: args.step_key,
        ...u,
        provenance: source(
          `attempt:${u.attempt_id ?? args.step_key}`,
          null,
          null,
          "owner",
          "ancestor pinned in this attempt; agent output is untrusted evidence",
        ),
      };
    }
    case "get_run_context": {
      const pack = await one(
        pool,
        "SELECT id,snapshot_id,content_hash,content,created_at FROM agent_context_packs WHERE attempt_id=$1 AND run_id=$2 AND step_id=$3 AND owner_id=$4",
        [env.attemptId, env.runId, env.stepId, env.ownerId],
      );
      if (!pack)
        return {
          available: false,
          reason: "Pack has not been built; existing immutable step snapshot remains available",
          snapshot_id: env.snapshotId ?? null,
        };
      const entries = pack.content.entries.filter(
        (e: any) => args.section === "all" || e.section === args.section,
      );
      const clamp = (n: number, min: number, max: number) =>
        Math.min(max, Math.max(min, n));
      const offset = clamp(args.offset, 0, 1000);
      const entryLimit = clamp(args.limit, 1, 20);
      return {
        pack_id: pack.id,
        snapshot_id: pack.snapshot_id,
        content_hash: pack.content_hash,
        created_at: pack.created_at,
        estimated_tokens: pack.content.estimated_tokens,
        budget_tokens: pack.content.budget_tokens,
        entries: entries.slice(offset, offset + entryLimit),
        total: entries.length,
        omitted: pack.content.omitted,
        provider_handoff:
          args.section === "all" || args.section === "continuity"
            ? await (async () => {
                const h = await one(
                  pool,
                  "SELECT id,source_attempt_id,package FROM provider_handoffs WHERE target_attempt_id=$1 AND run_id=$2 AND step_id=$3 AND status='RESUMED'",
                  [env.attemptId, env.runId, env.stepId],
                );
                if (!h) return null;
                const details =
                  args.handoff_workspace && h.package?.workspace_artifact_id
                    ? await one(
                        pool,
                        "SELECT content FROM workflow_artifacts WHERE id=$1 AND run_id=$2 AND kind='provider_handoff'",
                        [h.package.workspace_artifact_id, env.runId],
                      )
                    : null;
                const original = args.handoff_source_pack
                  ? await one(
                      pool,
                      "SELECT content FROM agent_context_packs WHERE attempt_id=$1 AND run_id=$2 AND step_id=$3 AND owner_id=$4",
                      [h.source_attempt_id, env.runId, env.stepId, env.ownerId],
                    )
                  : null;
                const text = original
                    ? JSON.stringify(original.content)
                    : (details?.content ?? JSON.stringify(h.package)),
                  offset = clamp(args.handoff_offset, 0, 1000000),
                  limit = clamp(args.handoff_limit, 100, 12000);
                return {
                  id: h.id,
                  content: text.slice(offset, offset + limit),
                  total_chars: text.length,
                  next_offset: offset + limit < text.length ? offset + limit : null,
                };
              })()
            : null,
        capabilities: CONTEXT_TOOLS.map((t) => ({
          name: t.logicalName,
          read_only: t.readOnly,
          supported:
            !["search_code", "get_symbol", "find_dependencies"].includes(t.name) ||
            codeIntelligenceEnabled(),
        })),
      };
    }
    case "get_production_errors":
      return relatedProductionErrors(env, args.query, args.limit);
    case "get_repository_metadata": {
      const rows = await authorizedRepositoryRows(env, args.repositories);
      return rankRepositories(rows, { text: args.query ?? "" })
        .slice(0, args.limit)
        .map((r) => ({
          name: r.repo,
          score: r.score,
          reason: r.reasons,
          metadata: rows
            .filter((x) => x.name === r.repo)
            .map((x) => ({
              description: x.description,
              projects: x.projects,
              services: x.services,
              default_branch: x.default_branch,
              allowed_actions: x.allowed_actions,
            }))[0],
          provenance: source(
            `repository:${r.repo}`,
            null,
            null,
            "shared",
            "ranked within authorized run repositories",
          ),
        }));
    }
    case "request_clarification":
      return {
        questions: await postClarification(env, args.questions),
        instruction: "STOP; end the turn. The existing workflow resumes after answers.",
      };
    default:
      throw new Error("Unsupported context tool");
  }
}
