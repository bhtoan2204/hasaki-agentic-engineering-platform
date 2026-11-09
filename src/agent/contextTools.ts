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
  if (names.some((name) => !env.allowed.includes(name))) throw new Error("Repository outside authorized run scope");
  const rows = (await repositories.list()).filter((r) => names.includes(r.name));
  if (rows.length !== new Set(names).size || rows.some((r) => !r.enabled || !r.allowed_actions.includes("read")))
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
  const namespaces = config.prodErrors.namespaces.filter((n) => n.project === run.project).map((n) => n.namespace);
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
    [env.ownerId, env.knowledge.map((k) => k.key), [...new Set(env.knowledge.map((k) => k.version))]],
  );
  return env.knowledge.filter((k) =>
    rows.some(
      (r) => (k.id == null ? r.key === k.key : r.id === k.id) && r.version === k.version && r.content === k.content,
    ),
  );
}
export async function executeContextTool(name: string, args: any, env: PlatformToolEnv): Promise<unknown> {
  switch (name) {
    case "search_code":
    case "get_symbol":
    case "find_dependencies": {
      const rows = await authorizedRepositoryRows(env, args.repositories);
      if (!codeIntelligenceEnabled())
        return { supported: false, reason: "Code intelligence disabled on this worker", hits: [] };
      const scope = { repositories: rows.map((r) => r.name), allowed: env.allowed, runId: env.runId, provision: false };
      if (name === "search_code" && args.operation === "context") {
        const context = await buildCodeContext(args.query, scope);
        await env.recordMetrics?.({ code_intelligence: context.metrics });
        return context;
      }
      if (name === "get_symbol")
        return {
          definitions: (await findDefinitions(args.symbol, scope)).hits.slice(0, args.limit),
          uncertainty: "syntax candidates; check live files and snapshot freshness",
        };
      if (name === "find_dependencies")
        return {
          dependencies: await findDependencies(args.symbol, scope, args.depth),
          uncertainty: "candidate edges are not semantic resolution",
        };
      if (args.operation === "exact")
        return {
          hits: (await searchCodeExact(args.query, scope)).slice(0, args.limit),
          uncertainty: "text matches are not semantic proof",
        };
      return searchSymbols(args.query, scope, args.limit);
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
          ...scoreKnowledge({ ...k, reason: "resolved step knowledge" }, args.query ?? "", env.stepType),
        }))
        .filter((x) => !args.query || x.score > 0)
        .sort((a, b) => b.score - a.score || a.k.key.localeCompare(b.k.key))
        .slice(0, args.limit);
      const hits = [];
      for (const { k, score, why } of ranked) {
        let freshness: { state: string; reason: string } = { state: "SNAPSHOT", reason: "pinned applicable version" };
        if (k.category === "task_memory") {
          const memory = k.metadata?.memory;
          const repo = memory?.repo && env.allowed.includes(memory.repo) ? await repositories.get(memory.repo) : null;
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
          provenance: source(`work_item:${row.id}`, null, row.updated_at, "owner", "current run's work item"),
        }
        : { available: false, reason: "Run has no accessible linked work item" };
    }
    case "get_step_output": {
      const u = env.upstream[args.step_key];
      if (!u || u.status !== "COMPLETED") throw new Error("Only pinned completed ancestor outputs are available");
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
      const entries = pack.content.entries.filter((e: any) => args.section === "all" || e.section === args.section);
      return {
        pack_id: pack.id,
        snapshot_id: pack.snapshot_id,
        content_hash: pack.content_hash,
        created_at: pack.created_at,
        estimated_tokens: pack.content.estimated_tokens,
        budget_tokens: pack.content.budget_tokens,
        entries: entries.slice(args.offset, args.offset + args.limit),
        total: entries.length,
        omitted: pack.content.omitted,
        provider_handoff: args.section === "all" || args.section === "continuity" ? await (async () => {
          const h = await one(pool, "SELECT id,source_attempt_id,package FROM provider_handoffs WHERE target_attempt_id=$1 AND run_id=$2 AND step_id=$3 AND status='RESUMED'", [env.attemptId, env.runId, env.stepId]);
          if (!h) return null;
          const details = args.handoff_workspace && h.package?.workspace_artifact_id ? await one(pool, "SELECT content FROM workflow_artifacts WHERE id=$1 AND run_id=$2 AND kind='provider_handoff'", [h.package.workspace_artifact_id, env.runId]) : null;
          const original = args.handoff_source_pack ? await one(pool, "SELECT content FROM agent_context_packs WHERE attempt_id=$1 AND run_id=$2 AND step_id=$3 AND owner_id=$4", [h.source_attempt_id, env.runId, env.stepId, env.ownerId]) : null;
          const text = original ? JSON.stringify(original.content) : details?.content ?? JSON.stringify(h.package), offset = args.handoff_offset ?? 0, limit = args.handoff_limit ?? 6000;
          return { id: h.id, content: text.slice(offset, offset + limit), total_chars: text.length, next_offset: offset + limit < text.length ? offset + limit : null };
        })() : null,
        capabilities: CONTEXT_TOOLS.map((t) => ({
          name: t.logicalName,
          read_only: t.readOnly,
          supported: !["search_code", "get_symbol", "find_dependencies"].includes(t.name) || codeIntelligenceEnabled(),
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
          provenance: source(`repository:${r.repo}`, null, null, "shared", "ranked within authorized run repositories"),
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
