import { ignoreError } from "../ignoreError.ts";
import type { RankedRepository, RepositoryRow } from "../repos/service.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import { completeForRun } from "./complete.ts";
import { languagePolicy, outputLocale } from "./language.ts";

/** AI-assisted repository ranking across any configured provider: may only reorder/explain candidates from the deterministic list. */
export async function rankRepositories(
  ctx: ExecutionContext,
  ranked: RankedRepository[],
  repos: RepositoryRow[],
): Promise<RankedRepository[]> {
  const meta = repos.map((r) => ({
    name: r.name,
    description: r.description,
    services: r.services,
    tags: r.tags,
    projects: r.projects,
    dependencies: r.dependencies,
  }));
  const project = ctx.context?.project || ctx.input.work_item?.project || "";
  const prompt = [
    languagePolicy(outputLocale(ctx.run)),
    "",
    "Rank these repositories by how likely they must change for the engineering request. Use ONLY the listed repository names.",
    ...(project
      ? [
          `The request belongs to project "${project}"; repositories of related projects are listed too because those projects integrate with it.`,
        ]
      : []),
    'Consider the whole flow across project boundaries: when the request names a system (e.g. "phía OMS") or the defect sits in a call between systems ' +
      "(duplicate or missing calls, retries, wrong payloads), rank the caller/producer side as well as the callee — the fix is often on the side that initiates the call.",
    'Reply with JSON only: [{"repo": "...", "score": 0-10, "reasons": ["why this repo is relevant"]}]. Each reason is natural language and follows the output language above.',
    "",
    "Repositories:",
    JSON.stringify(meta, null, 2),
    "",
    "Deterministic keyword ranking (for reference):",
    JSON.stringify(ranked.slice(0, 10)),
    "",
    '<untrusted_input source="work_item">',
    `${ctx.input.work_item?.title ?? ctx.run.title}\n${ctx.input.work_item?.description ?? ""}`,
    JSON.stringify(
      Object.fromEntries(Object.entries(ctx.input.upstream).map(([k, u]) => [k, u.output])),
    ).slice(0, 8000),
    "</untrusted_input>",
  ].join("\n");
  const done = await completeForRun(ctx.run, prompt, ctx.signal);
  await ctx.recordMetrics({ ranking: done.metrics }).catch(ignoreError("agent.record_metrics"));
  const out = done.text;
  const json = out.match(/\[[\s\S]*\]/)?.[0];
  if (!json) throw new Error("no JSON in ranking reply");
  const allowed = new Set(repos.map((r) => r.name));
  return (JSON.parse(json) as RankedRepository[])
    .filter((r) => allowed.has(r.repo))
    .map((r) => ({
      repo: r.repo,
      score: Number(r.score) || 0,
      reasons: (r.reasons ?? []).map(String),
    }))
    .sort((a, b) => b.score - a.score);
}

/** Compatibility alias for tests and existing callers. */
export const rankRepositoriesWithClaude = rankRepositories;
