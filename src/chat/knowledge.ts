import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { knowledge } from "../knowledge/service.ts";
import { visibleKnowledge } from "../knowledge/visibility.ts";
import {
  applicabilityMatches,
  resolveKnowledge,
  scopeMatches,
  type KnowledgeCandidate,
  type ResolutionContext,
} from "../knowledge/resolve.ts";
import {
  fusedSearchOrder,
  planKnowledge,
  scoreKnowledge,
  type DisclosureEntry,
} from "../context/plan.ts";
import { semanticRanksByKey } from "../retrieval/semantic.ts";
import { externalNotice, isExternal } from "../knowledge/external.ts";
import { projectsOfRepositories } from "../repos/service.ts";

/**
 * Chat on the shared Knowledge & Skills registry — the same pipeline a workflow step uses, no second registry:
 *   knowledge.candidates (owner-visible, version in effect now) → visibleKnowledge (repository permissions)
 *   → resolveKnowledge (scope, applicability, expiry, supersession, conflict precedence) → scoreKnowledge/planKnowledge
 *   (relevance and progressive disclosure: relevant business rules inline, other relevant items as an index line).
 * Skills keep the registry's opt-in rule for automatic use; in chat they are also discoverable by search and become
 * active when read. Task memory is excluded (chat memory has its own recall; run memory needs repository provenance).
 * Knowledge is guidance: it can never grant a tool, an operation or a permission.
 */
export interface ChatKnowledgeScope {
  ownerId: number;
  repositories: string[];
  text: string;
}
export type ResolvedChatItem = KnowledgeCandidate & { reason: string };

const READ_PAGE = 18_000;
const INLINE_TOKENS = 2_000;
const INDEX_SIZE = 8;

async function context(
  scope: ChatKnowledgeScope,
  explicit: string[] = [],
): Promise<ResolutionContext> {
  return {
    organization: config.organization,
    project: "",
    repositories: scope.repositories,
    repositoryProjects: await projectsOfRepositories(scope.repositories),
    workflowKey: "chat",
    stepKey: "chat",
    stepType: "agent",
    text: scope.text,
    explicit,
  };
}

const visibleCandidates = async (ownerId: number) =>
  (await visibleKnowledge(ownerId, await knowledge.candidates(pool, ownerId, new Date()))).filter(
    (k) => k.category !== "task_memory",
  );

/**
 * What can be found from this conversation: everything that resolves here, plus skills whose scope and applicability
 * match (discoverable even when not auto-applied). Superseded and expired items never appear.
 */
async function discoverable(scope: ChatKnowledgeScope) {
  const candidates = await visibleCandidates(scope.ownerId);
  const ctx = await context(scope);
  const res = resolveKnowledge(candidates, ctx);
  const applied = new Set(res.applied.map((k) => k.key));
  const gone = new Set(res.overridden.map((o) => o.key));
  const skills = resolveKnowledge(candidates, {
    ...ctx,
    explicit: candidates
      .filter(
        (k) =>
          k.category === "agent_skill" &&
          !applied.has(k.key) &&
          !gone.has(k.key) &&
          scopeMatches(k, ctx) &&
          applicabilityMatches(k.applicability, ctx),
      )
      .map((k) => k.key),
  }).applied.filter((k) => !applied.has(k.key) && k.category === "agent_skill");
  return {
    items: [...res.applied, ...skills.map((k) => ({ ...k, reason: "skill available on request" }))],
    overridden: res.overridden,
  };
}

export interface KnowledgeRef {
  key: string;
  version: number;
  title: string;
  category: string;
  owner: "shared" | "own";
  reason: string;
  disclosure?: DisclosureEntry["disclosure"] | "read";
  sources?: string[];
}

const sourcesOf = (k: KnowledgeCandidate) =>
  (Array.isArray(k.metadata?.source)
    ? (k.metadata.source as Array<{ repo?: string; path?: string }>)
    : []
  )
    .map((s) => [s.repo, s.path].filter(Boolean).join(":"))
    .filter(Boolean)
    .slice(0, 5);

export const refOf = (
  k: ResolvedChatItem,
  disclosure?: KnowledgeRef["disclosure"],
): KnowledgeRef => ({
  key: k.key,
  version: k.version,
  title: k.title,
  category: k.category,
  owner: k.owner_id == null ? "shared" : "own",
  reason: k.reason,
  ...(disclosure ? { disclosure } : {}),
  ...(sourcesOf(k).length ? { sources: sourcesOf(k) } : {}),
});

/**
 * Knowledge for a turn, before any tool runs: relevant applicable items through the workflow disclosure planner.
 * Enforced policies and relevant business rules are inline (mandatory), other relevant items are an index line.
 */
export async function knowledgeForTurn(scope: ChatKnowledgeScope) {
  const { items } = await discoverable(scope);
  const auto = items.filter(
    (k) => k.category !== "agent_skill" || k.reason !== "skill available on request",
  );
  const semantic = await semanticRanksByKey(scope.ownerId, scope.text, auto);
  const relevant = auto.filter(
    (k) =>
      k.enforced ||
      k.category === "security_policy" ||
      semantic?.has(k.key) ||
      scoreKnowledge(k, scope.text, "agent").score > 0,
  );
  const plan = planKnowledge(relevant, {
    requestText: scope.text,
    stepType: "agent",
    inlineTokens: INLINE_TOKENS,
    indexSize: INDEX_SIZE,
    semantic: semantic && new Map([...semantic].map(([key, h]) => [key, h.rank])),
  }).filter((d) => d.disclosure !== "search");
  const byKey = new Map(relevant.map((k) => [k.key, k]));
  return plan.map((d) => ({ item: byKey.get(d.key)!, disclosure: d.disclosure }));
}

/** knowledge.search: ranked with the shared scorer (bilingual business terms), optional category filter. */
export async function searchKnowledge(
  scope: ChatKnowledgeScope,
  query: string,
  category?: string,
  limit = 8,
) {
  const { items } = await discoverable(scope);
  const candidates = items
    .filter((k) => !category || k.category === category)
    .filter((k) => !k.metadata?.parent_skill);
  const scored = candidates.map((k) => ({ k, ...scoreKnowledge(k, query, "agent") }));
  let ranked = scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.k.key.localeCompare(b.k.key));
  const semantic = await semanticRanksByKey(scope.ownerId, query, candidates);
  if (semantic) ranked = fusedSearchOrder(scored, ranked, semantic);
  return ranked.slice(0, limit).map(({ k, score, why }) => ({
    ...refOf(k),
    description: String(k.metadata?.description ?? "").slice(0, 300),
    score,
    ...(semantic?.has(k.key) ? { semantic_similarity: semantic.get(k.key)!.similarity } : {}),
    why,
  }));
}

/**
 * knowledge.get: the full served version, paged. Reading a skill activates it: its supporting documents are listed and
 * readable with the same tool. An item outside this conversation's scope can still be read when visible, marked so.
 */
export async function readKnowledge(scope: ChatKnowledgeScope, key: string, offset = 0) {
  const candidates = await visibleCandidates(scope.ownerId);
  const own = candidates.find((k) => k.key === key && k.owner_id != null);
  const item = own ?? candidates.find((k) => k.key === key);
  if (!item) return null;
  const ctx = await context(scope, [key]);
  const applies = resolveKnowledge(candidates, { ...ctx, explicit: [] }).applied.some(
    (k) => k.key === key,
  );
  const resolved = resolveKnowledge([item], ctx).applied[0];
  if (!resolved) return { key, expired: true, message: `${key} is no longer in effect` };
  const successor =
    item.superseded_by && candidates.some((k) => k.key === item.superseded_by)
      ? item.superseded_by
      : null;
  const body = item.content.slice(offset, offset + READ_PAGE);
  const companions =
    item.category === "agent_skill"
      ? candidates
          .filter((k) => k.metadata?.parent_skill === key)
          .map((k) => ({ key: k.key, title: k.title, version: k.version }))
      : [];
  return {
    ...refOf(
      {
        ...resolved,
        reason: applies ? resolved.reason : "read on request (outside this conversation's scope)",
      },
      "read",
    ),
    effective_from: item.effective_from ?? null,
    ...(successor
      ? {
          superseded_by: successor,
          notice: `Superseded by ${successor}: read that one for the current rule.`,
        }
      : {}),
    ...(isExternal(item.metadata) && offset === 0
      ? { external_notice: externalNotice(item.metadata) }
      : {}),
    ...(companions.length ? { activated_skill: true, supporting_documents: companions } : {}),
    content: body,
    offset,
    total_chars: item.content.length,
    ...(offset + READ_PAGE < item.content.length ? { next_offset: offset + READ_PAGE } : {}),
  };
}
