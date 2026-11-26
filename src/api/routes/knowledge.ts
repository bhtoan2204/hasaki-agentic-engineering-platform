import { loadKnowledgeAudit } from "../../knowledge/auditLoader.ts";
import { config } from "../../config.ts";
import { knowledgeUsage } from "../../knowledge/usageRepository.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { requireAdmin, requireOwner, requireRun } from "../../authz/access.ts";
import { knowledge } from "../../knowledge/service.ts";
import {
  knowledgeRestricted,
  readableRepositoryNames,
  visibleKnowledge,
} from "../../knowledge/visibility.ts";
import { reviewMemory } from "../../knowledge/memory.ts";
import {
  agingForItems,
  type AgingInfo,
  isArchivedState,
  restoreMemory,
  unpinMemory,
} from "../../knowledge/aging.ts";
import {
  approveProposal,
  listProposals,
  rejectProposal,
  reviewScope,
  rollbackProposal,
} from "../../knowledge/proposals.ts";
import { detectKnowledgeChanges, proposeSkillUpdates } from "../../knowledge/learning.ts";
import { background } from "../../workflow/background.ts";
import { importFromRepositories } from "../../knowledge/importer.ts";
import { resolveKnowledge } from "../../knowledge/resolve.ts";
import { projectsOfRepositories } from "../../repos/service.ts";
import { syncPullRequestStates } from "../../learning/outcomes.ts";
import { providerPerformance } from "../../learning/providerPerformance.ts";
import {
  proposeImprovements,
  qualityPatterns,
  regressionCases,
  reviewRegressionCase,
} from "../../learning/patterns.ts";
import type { Ctx, Route } from "./types.ts";
import { mine, must, readableKnowledge, readableProposal, support } from "./shared.ts";

/**
 * Review rights follow knowledge edit rights: a change that writes shared knowledge (shared target, or CREATE as
 * shared) needs an admin; a change to the owner's private knowledge needs that owner (or admin support access).
 */
async function requireReviewer(c: Ctx, id: number, createsShared = false) {
  await readableProposal(c, id);
  const scope = must(await reviewScope(id), "proposal");
  if (scope.writesShared || createsShared || scope.proposalOwner == null) requireAdmin(c.actor);
  else
    await requireOwner(c.actor, scope.proposalOwner, support(c), "knowledge_proposal", String(id));
}

/** After a rule change is applied: draft updates for the skills it affects (background, each needs its own approval). */
const evolveSkillsAfter = (row: { id: number; parent_id: number | null }) => {
  if (!row.parent_id && config.learning.evolveSkills)
    background(`skill evolution for proposal ${row.id}`, () => proposeSkillUpdates(Number(row.id)));
};

export const knowledgeRoutes: Route[] = [
  [
    "GET",
    /^\/api\/knowledge\/audit$/,
    async (c) => {
      requireAdmin(c.actor);
      return loadKnowledgeAudit({
        userId: c.actor.id,
        windowDays: Math.min(90, Number(c.url.searchParams.get("days") ?? 7)),
      });
    },
  ],
  // ------------------------------------------------------------ knowledge
  [
    "GET",
    /^\/api\/knowledge$/,
    async (c) => {
      const sp = c.url.searchParams;
      const category = sp.get("category") || undefined;
      const paged = sp.has("page");
      const listed = await visibleKnowledge(
        c.actor.id,
        paged
          ? knowledge.listPageSummaries({
              scope: sp.get("scope") || undefined,
              search: sp.get("q")?.trim() || undefined,
              updatedAtOrder: sp.get("sort") === "oldest" ? "oldest" : "newest",
              ...mine(c),
            })
          : knowledge.list({ category, summary: true, ...mine(c) }),
      );
      // Archived task memory (aging, docs/architecture/memory-aging.md): shown with its reason; the paged list hides it
      // unless ?archived=1 asks for exactly that.
      type Listed = { id: number; category: string; aging?: AgingInfo } & Record<string, unknown>;
      const items = listed as Listed[];
      const aged = await agingForItems(
        items.filter((k) => k.category === "task_memory").map((k) => Number(k.id)),
      );
      const withAging = items.map((k) =>
        aged.has(Number(k.id)) ? { ...k, aging: aged.get(Number(k.id)) } : k,
      );
      if (!paged) return withAging;
      const onlyArchived = sp.get("archived") === "1";
      const rows = withAging.filter((k) => isArchivedState(k.aging?.state) === onlyArchived);
      const counts: Record<string, number> = { "": rows.length };
      for (const k of rows) counts[k.category] = (counts[k.category] ?? 0) + 1;
      const matched = category ? rows.filter((k) => k.category === category) : rows;
      const size = Math.min(200, Math.max(1, Number(sp.get("page_size")) || 50));
      const page = Math.max(1, Number(sp.get("page")) || 1);
      return {
        items: matched.slice((page - 1) * size, page * size),
        total: matched.length,
        counts,
      };
    },
  ],
  [
    "POST",
    /^\/api\/knowledge$/,
    ({ body, actor }) => {
      const shared = body.shared === true;
      if (shared) requireAdmin(actor);
      return knowledge.create({
        ...body,
        ownerId: shared ? null : actor.id,
        created_by: actor.username,
      });
    },
  ],
  // Knowledge evolution: change proposals (detected from runs, skill updates, repository conflicts) and their review.
  // Continuous quality loop: patterns (own runs; support scope = all), reviewed proposals, regression candidates.
  [
    "GET",
    /^\/api\/quality\/patterns$/,
    (c) =>
      qualityPatterns({
        days: Number(c.url.searchParams.get("days") ?? 30),
        ownerId: support(c) ? null : c.actor.id,
      }),
  ],
  [
    "GET",
    /^\/api\/quality\/providers$/,
    (c) =>
      providerPerformance({
        days: Number(c.url.searchParams.get("days") ?? 30),
        ownerId: support(c) ? null : c.actor.id,
      }),
  ],
  [
    "POST",
    /^\/api\/quality\/proposals$/,
    (c) => (
      requireAdmin(c.actor),
      proposeImprovements({
        days: Number(c.body.days ?? 30),
        minRuns: c.body.min_runs,
        minTasks: c.body.min_tasks,
        ownerId: null,
        by: c.actor.username,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/quality\/sync-pull-requests$/,
    (c) => (requireAdmin(c.actor), syncPullRequestStates({ limit: Number(c.body.limit ?? 50) })),
  ],
  ["GET", /^\/api\/regression-cases$/, (c) => regressionCases(support(c) ? null : c.actor.id)],
  [
    "POST",
    /^\/api\/regression-cases\/(\d+)\/(accept|reject)$/,
    async (c) => {
      requireAdmin(c.actor);
      try {
        return await reviewRegressionCase(
          num(c.p[0]),
          c.p[1] === "accept" ? "accepted" : "rejected",
          c.actor.username,
          c.body,
        );
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
  ],
  [
    "GET",
    /^\/api\/knowledge-proposals$/,
    (c) =>
      listProposals({
        ownerId: c.actor.id,
        all: support(c),
        status: c.url.searchParams.get("status") || undefined,
        runId: c.url.searchParams.get("run") ? num(c.url.searchParams.get("run")!) : undefined,
        targetKey: c.url.searchParams.get("target") || undefined,
      }),
  ],
  ["GET", /^\/api\/knowledge-proposals\/(\d+)$/, (c) => readableProposal(c, num(c.p[0]))],
  [
    "POST",
    /^\/api\/knowledge-proposals\/(\d+)\/approve$/,
    async (c) => {
      const id = num(c.p[0]);
      await requireReviewer(c, id, c.body.shared === true);
      return approveProposal(
        id,
        {
          by: c.actor.username,
          comment: c.body.comment,
          edits: c.body.edits,
          acceptCurrentVersion: c.body.accept_current_version === true,
          overrideValidation: c.body.override_validation === true,
          shared: c.body.shared === true,
        },
        evolveSkillsAfter,
      );
    },
  ],
  [
    "POST",
    /^\/api\/knowledge-proposals\/(\d+)\/reject$/,
    async (c) => (
      await requireReviewer(c, num(c.p[0])),
      rejectProposal(num(c.p[0]), { by: c.actor.username, comment: c.body.comment })
    ),
  ],
  [
    "POST",
    /^\/api\/knowledge-proposals\/(\d+)\/rollback$/,
    async (c) => (
      await requireReviewer(c, num(c.p[0])),
      rollbackProposal(num(c.p[0]), { by: c.actor.username, comment: c.body.comment })
    ),
  ],
  // Re-run change detection for one run (e.g. after answering more questions, or for a run that did not complete).
  [
    "POST",
    /^\/api\/runs\/(\d+)\/learn$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      detectKnowledgeChanges(num(c.p[0]), { force: c.body.force === true })
    ),
  ],
  [
    "POST",
    /^\/api\/knowledge\/import-repos$/,
    ({ body, actor }) => (requireAdmin(actor), importFromRepositories({ dryRun: !!body.dry_run })),
  ],
  [
    "POST",
    /^\/api\/knowledge\/preview$/,
    async ({ body, actor }) => {
      const visible = await readableRepositoryNames(actor.id);
      const repositories: string[] = (Array.isArray(body.repositories) ? body.repositories : [])
        .map(String)
        .filter((r: string) => visible.has(r.toLowerCase()));
      return resolveKnowledge(
        (await knowledge.candidates(undefined, actor.id)).filter(
          (k) => !knowledgeRestricted(k, visible),
        ),
        {
          organization: config.organization,
          project: String(body.project ?? ""),
          repositories,
          repositoryProjects: await projectsOfRepositories(repositories),
          workflowKey: String(body.workflow ?? ""),
          stepKey: String(body.step ?? ""),
          stepType: String(body.step_type ?? ""),
          text: String(body.text ?? ""),
          explicit: body.explicit ?? [],
        },
      );
    },
  ],
  // Executions that actually received this item (from immutable context snapshots) + explicit assignments in workflows.
  [
    "GET",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/usage$/,
    async (c) => {
      await readableKnowledge(c, c.p[0]);
      const scope = { ownerId: c.actor.id, all: support(c) };
      const used = await knowledgeUsage(c.p[0], scope.ownerId, scope.all);
      const assigned = await knowledge.assignments(c.p[0], undefined, scope);
      return { used, assigned };
    },
  ],
  // Task memory aging: bring an archived or replaced item back (pinned, so automatic aging leaves it alone), or unpin it.
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/restore$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.category !== "task_memory") throw new HttpError(400, "only task memory is archived");
      if (item.owner_id == null) requireAdmin(c.actor);
      return restoreMemory(item.key, item.owner_id ?? null, c.actor.username);
    },
  ],
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/unpin$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.category !== "task_memory") throw new HttpError(400, "only task memory is archived");
      if (item.owner_id == null) requireAdmin(c.actor);
      return unpinMemory(item.key, item.owner_id ?? null, c.actor.username);
    },
  ],
  // Cross-task memory: a human promotes (or rejects) agent conclusions; nothing else makes them trusted.
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/approve$/,
    async (c) =>
      reviewMemory(
        c.p[0],
        "approve",
        c.actor.username,
        (await readableKnowledge(c, c.p[0])).owner_id ?? null,
      ),
  ],
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/reject$/,
    async (c) =>
      reviewMemory(
        c.p[0],
        "reject",
        c.actor.username,
        (await readableKnowledge(c, c.p[0])).owner_id ?? null,
      ),
  ],
];
