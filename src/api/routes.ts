import { loadKnowledgeAudit } from "../knowledge/auditLoader.ts";
import {
  createBinding,
  disconnect as disconnectTelegram,
  savePreferences,
} from "../telegram/store.ts";
import { evaluationAnalytics } from "../eval/analytics.ts";
import { createRecommendation } from "../eval/recommendations.ts";
import { saveOptimizationPolicy, optimizationPolicies } from "../eval/optimization.ts";
import {
  setRunBranches,
  requestProviderHandoff,
  resumeProviderHandoff,
  providerHandoffOptions,
} from "../workflow/engine.ts";
import { setStepAgent } from "../workflow/engine.ts";
import { attemptContext } from "./agentContext.ts";
import { engineeringAnalytics } from "./analytics/index.ts";
import { updateIncidentLifecycle } from "./analytics/health.ts";
import {
  publishBuiltinSuite,
  listSuites,
  createEvaluation,
  evaluationList,
  evaluationDetail,
  cancelEvaluation,
  createComparison,
  comparisonDetail,
} from "../eval/service.ts";
import {
  status as codeIndexStatus,
  enqueue as enqueueCodeIndex,
} from "../codeIntelligence/indexer.ts";
import { hybridRank } from "../codeIntelligence/search.ts";
import { config } from "../config.ts";
import { instanceHealth } from "../instances.ts";
import { resolveOutputLocale } from "../agent/language.ts";
import { resolveAgentProvider } from "../agent/provider.ts";
import { agentProviderStatus } from "../agent/providerStatus.ts";
import { pool, q, one } from "../db/pool.ts";
import {
  events as legacyEvents,
  inbox,
  prs as legacyPrs,
  questions as legacyQuestions,
  tasks as legacyTasks,
} from "../db.ts";
import { authStatus, closeLoginWindow, openLoginWindow, setToken } from "../hasakiAuth.ts";
import { fetchTaskList, importHasakiTask, pickTask } from "../work.ts";
import { importJiraIssue, importJiraPayload } from "../integrations/jira.ts";
import { argoStatus, clearArgoToken, setArgoToken } from "../integrations/argocd.ts";
import {
  clearSharedSplunkToken,
  clearSplunkCookie,
  setSharedSplunkToken,
  setSplunkCookie,
  setSplunkToken,
  splunkStatus,
  splunkTestConnection,
  submitManualResults,
} from "../integrations/splunk.ts";
import {
  investigationDetail,
  routeWorkflow,
  startFixFromInvestigation,
} from "../investigation/service.ts";
import { clearKafkaCookie, kafkaStatus, setKafkaCookie } from "../integrations/kafka.ts";
import { clearVaultToken, setVaultToken, vaultStatus } from "../integrations/vault.ts";
import {
  databasesForRun,
  deleteDatabase,
  publicDatabases,
  saveDatabase,
  testDatabase,
} from "../integrations/database.ts";
import {
  getIncidentDetail,
  groupsForWorkItem,
  investigate,
  linkWorkItem,
  listGroups,
  saveSettings as saveProdErrorSettings,
  setIgnored,
  startScan,
} from "../prodErrors/scan.ts";
import {
  adoptEnv,
  bitbucketStatus,
  clearBitbucket,
  clearGithub,
  clearTelegram,
  githubStatus,
  setBitbucket,
  setGithub,
  setTelegram,
  setTelegramMode,
  setTelegramDestination,
  telegramChats,
  telegramStatus,
  testTelegram,
} from "../integrations/accounts.ts";
import { HttpError } from "../http/error.ts";
import {
  assertQuestionsAccessible,
  audit,
  requireAdmin,
  requireArtifact,
  requireAttempt,
  requireOwner,
  requireRun,
  requireSnapshot,
  requireWorkItem,
  wantsSupport,
  type Actor,
} from "../authz/access.ts";
import { listUsers, createUser, setActive, setPassword } from "../auth/users.ts";
import { knowledge } from "../knowledge/service.ts";
import {
  knowledgeRestricted,
  readableRepositoryNames,
  visibleKnowledge,
} from "../knowledge/visibility.ts";
import { reviewMemory } from "../knowledge/memory.ts";
import {
  approveProposal,
  getProposal,
  listProposals,
  rejectProposal,
  reviewScope,
  rollbackProposal,
} from "../knowledge/proposals.ts";
import { detectKnowledgeChanges, proposeSkillUpdates } from "../knowledge/learning.ts";
import { background } from "../workflow/background.ts";
import { StaleWhileRevalidate, cacheSnapshot, singleflightInflight } from "../cache/index.ts";

const metricsSwr = new StaleWhileRevalidate<Awaited<ReturnType<typeof metricsSummary>>>(
  "metrics.summary",
  30_000,
  600_000,
);
import { summarizeEval } from "../eval/summary.ts";
import { importFromRepositories } from "../knowledge/importer.ts";
import { CATEGORIES, SCOPES, resolveKnowledge } from "../knowledge/resolve.ts";
import { repositoryRemote } from "../repos/remote.ts";
import {
  prepareRepository,
  workspaceStatus,
  testRepositoryConnection,
} from "../repos/workspaces.ts";
import {
  repositories,
  isAmbiguous,
  RepositoryInUseError,
  projectsOfRepositories,
} from "../repos/service.ts";
import {
  accessAudit,
  accessMatrix,
  allowedRepositoriesForRun,
  listAccessibleRepositories,
  requireRepositoryAccess,
  revalidateBitbucket,
  setRepositoryAccess,
  setRepositoryAccessMany,
  setSharedAccess,
  accessLevelFrom,
  type EffectivePermissions,
} from "../repos/access.ts";
import { definitions } from "../workflow/definitions.ts";
import { validateSpec } from "../workflow/graph.ts";
import { runEvents } from "../workflow/events.ts";
import {
  answeredQuestions,
  answerQuestions,
  approveStep,
  expandSubtasks,
  cancelRun,
  EngineError,
  listRuns,
  openQuestions,
  openApprovals,
  pauseRun,
  previewRun,
  rejectStep,
  reexecuteStep,
  resumeRun,
  runStepNow,
  stepDetail,
  stopStep,
  retryStep,
  runDetail,
  selectRepositories,
  sendFeedback,
  classifyRunFeedback,
  skipStep,
  startPendingRun,
  startRun,
} from "../workflow/engine.ts";
import { RUN_STATUSES, STEP_STATUSES, STEP_TYPES } from "../workflow/types.ts";
import { workItems } from "../workitems/service.ts";
import { getRunSummary } from "../report/runSummary.ts";
import { parseBudget, runCost, withCosts, workItemCost } from "../report/cost.ts";
import { recordRunOutcome, syncPullRequestStates } from "../learning/outcomes.ts";
import { providerPerformance } from "../learning/providerPerformance.ts";
import {
  proposeImprovements,
  proposeRegressionCase,
  qualityPatterns,
  regressionCases,
  reviewRegressionCase,
} from "../learning/patterns.ts";
import { runChanges } from "../git/changes.ts";
import { addEvidence, removeEvidence } from "../report/evidenceStore.ts";
import { schedulerStatus } from "../workflow/scheduler.ts";
import { metricsSummary, runMetrics } from "./metrics.ts";
import { describeTool, listTools } from "../agent/toolRegistry.ts";
import type { FeedbackMode } from "../workflow/replan.ts";

export { HttpError };

export type Ctx = { p: string[]; body: any; url: URL; actor: Actor };
export type Route = [method: string, pattern: RegExp, handler: (c: Ctx) => unknown];

const support = (c: Ctx) => wantsSupport(c.actor, c.url.searchParams.get("scope"));
const budgetOf = (body: any) => {
  try {
    return parseBudget(body?.budget_usd);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
};
const mine = (c: Ctx) => ({ ownerId: c.actor.id, all: support(c) });

const num = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `invalid id "${s}"`);
  return n;
};
const must = <T>(v: T | undefined | null, what: string): T => {
  if (v == null) throw new HttpError(404, `${what} not found`);
  return v;
};

async function workItemByCode(code: string, actor: Actor) {
  return must(await workItems.byCode(code, actor.id), "task");
}

async function readableWorkflow(c: Ctx, key: string) {
  const requested = c.url.searchParams.get("owner");
  if (requested) {
    const ownerId = Number(requested);
    if (!Number.isInteger(ownerId)) throw new HttpError(404, "not found");
    await requireOwner(c.actor, ownerId, support(c), "workflow", key);
    return must(await definitions.get(key, pool, ownerId), "workflow");
  }
  return must(
    (await definitions.get(key, pool, c.actor.id)) ?? (await definitions.get(key, pool, null)),
    "workflow",
  );
}

async function workflowOwner(c: Ctx, key: string): Promise<number | null> {
  const requested = c.url.searchParams.get("owner");
  const ownerId = requested ? Number(requested) : c.actor.id;
  const row =
    (await definitions.get(key, pool, ownerId)) ??
    (requested ? undefined : await definitions.get(key, pool, null));
  if (!row) throw new HttpError(404, "not found");
  if (row.owner_id == null) {
    requireAdmin(c.actor);
    return null;
  }
  await requireOwner(c.actor, Number(row.owner_id), support(c), "workflow", key);
  return Number(row.owner_id);
}

/** Read access: own proposals, shared ones (repository import), or any with admin support access. */
async function readableProposal(c: Ctx, id: number) {
  const p = must(await getProposal(id), "proposal");
  if (p.owner_id != null && Number(p.owner_id) !== c.actor.id)
    await requireOwner(c.actor, Number(p.owner_id), support(c), "knowledge_proposal", String(id));
  return p;
}

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
const evolveSkillsAfter = (row: any) => {
  if (!row.parent_id && config.learning.evolveSkills)
    background(`skill evolution for proposal ${row.id}`, () => proposeSkillUpdates(Number(row.id)));
};

async function readableKnowledge(c: Ctx, key: string) {
  const requested = c.url.searchParams.get("owner");
  if (requested) {
    const ownerId = Number(requested);
    if (!Number.isInteger(ownerId)) throw new HttpError(404, "not found");
    await requireOwner(c.actor, ownerId, support(c), "knowledge", key);
    return must(await knowledge.get(key, pool, ownerId), "knowledge item");
  }
  return hideRestrictedKnowledge(
    c.actor.id,
    must(
      (await knowledge.get(key, pool, c.actor.id)) ?? (await knowledge.get(key, pool, null)),
      "knowledge item",
    ),
  );
}

/** Knowledge derived from a repository the caller cannot read answers 404, like any unknown item. */
async function hideRestrictedKnowledge<
  T extends { scope_type?: string; scope_ref?: string; versions?: Array<{ metadata?: any }> },
>(userId: number, item: T): Promise<T> {
  if (knowledgeRestricted(item, await readableRepositoryNames(userId)))
    throw new HttpError(404, "knowledge item not found");
  return item;
}

function redactGroup(group: any, actor: Actor, showAll: boolean) {
  if (!group?.work_item_id) return group;
  const ownerId = group.work_item_owner_id == null ? null : Number(group.work_item_owner_id);
  if (ownerId === actor.id || (showAll && actor.role === "admin" && ownerId != null)) return group;
  const {
    work_item_id,
    work_item_code,
    work_item_title,
    work_item_status,
    work_item_owner_id,
    run_id,
    run_status,
    pull_requests,
    ...rest
  } = group;
  return { ...rest, work_item_id: null, run_id: null, pull_requests: [] };
}
const latestRun = (workItemId: number) =>
  one<{ id: number; status: string }>(
    pool,
    "SELECT id, status FROM workflow_runs WHERE work_item_id = $1 ORDER BY id DESC LIMIT 1",
    [workItemId],
  );

export const routes: Route[] = [
  [
    "GET",
    /^\/api\/attempts\/(\d+)\/context$/,
    async (c) => {
      const id = num(c.p[0]);
      await requireAttempt(c.actor, id, support(c));
      const offset = Number(c.url.searchParams.get("offset") ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
        throw new HttpError(400, "Invalid context evidence offset");
      return attemptContext(id, offset);
    },
  ],
  [
    "GET",
    /^\/api\/analytics\/(health|health-service|usage|performance|workflows|options)$/,
    (c) => engineeringAnalytics(c.actor, c.url, c.p[0]),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/lifecycle$/,
    (c) => updateIncidentLifecycle(c.actor, c.p[0], c.body),
  ],
  // ------------------------------------------------------------ meta
  [
    "GET",
    /^\/api\/meta$/,
    () => ({
      stepTypes: STEP_TYPES,
      stepStatuses: STEP_STATUSES,
      runStatuses: RUN_STATUSES,
      knowledgeCategories: CATEGORIES,
      knowledgeScopes: SCOPES,
      baseBranch: config.baseBranch,
      organization: config.organization,
      jiraEnabled: !!(config.jira.baseUrl && config.jira.user && config.jira.token),
    }),
  ],

  // ------------------------------------------------------------ work items
  [
    "GET",
    /^\/api\/work-items$/,
    async (c) => {
      if (support(c)) await audit(c.actor.id, "support.list", "work_item", "*");
      return withCosts(
        await workItems.list({
          source: c.url.searchParams.get("source") ?? undefined,
          status: c.url.searchParams.get("status") ?? undefined,
          ...mine(c),
        }),
        "work_item",
      );
    },
  ],
  [
    "POST",
    /^\/api\/work-items$/,
    ({ body, actor }) =>
      workItems.createManual({
        title: body.title,
        description: body.description,
        project: body.project,
        code: body.code,
        ownerId: actor.id,
      }),
  ],
  [
    "POST",
    /^\/api\/work-items\/import$/,
    async ({ body, actor }) => {
      if (body.source === "jira")
        return body.key
          ? importJiraIssue(String(body.key), actor.id)
          : importJiraPayload(body.payload, actor.id);
      if (body.source === "hasaki_work")
        return body.work_id
          ? pickTask(Number(body.work_id), null, actor.id)
          : importHasakiTask(body.payload, null, actor.id);
      throw new HttpError(400, "source must be hasaki_work or jira");
    },
  ],
  [
    "GET",
    /^\/api\/work-items\/(\d+)$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      {
        ...must(await workItems.detail(num(c.p[0])), "work item"),
        prod_errors: await groupsForWorkItem(num(c.p[0])),
      }
    ),
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      must(await workItems.update(num(c.p[0]), c.body), "work item")
    ),
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/runs$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      startRun({
        definitionKey: String(c.body.workflow ?? ""),
        version: c.body.version,
        workItemId: num(c.p[0]),
        inputs: c.body.inputs,
        repositories: c.body.repositories,
        title: c.body.title,
        start: c.body.start,
        profile: c.body.profile,
        outputLocale: localeOf(c.body),
        agentProvider: providerOf(c.body),
        ownerId: c.actor.id,
      })
    ),
  ],
  [
    "GET",
    /^\/api\/work-items\/(\d+)\/cost$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      must(await workItemCost(num(c.p[0])), "work item")
    ),
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/budget$/,
    async (c) => {
      await requireWorkItem(c.actor, num(c.p[0]), support(c));
      await q(pool, "UPDATE work_items SET budget_usd = $2, updated_at = now() WHERE id = $1", [
        num(c.p[0]),
        budgetOf(c.body),
      ]);
      return must(await workItemCost(num(c.p[0])), "work item");
    },
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/analyze$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      startRun({
        definitionKey: "work-item-analysis",
        workItemId: num(c.p[0]),
        outputLocale: localeOf(c.body),
        agentProvider: providerOf(c.body),
        ownerId: c.actor.id,
      })
    ),
  ],

  // ------------------------------------------------------------ workflow definitions
  ["GET", /^\/api\/workflows$/, (c) => definitions.list(pool, mine(c))],
  [
    "POST",
    /^\/api\/workflows$/,
    ({ body, actor }) => {
      const shared = body.shared === true;
      if (shared) requireAdmin(actor);
      return definitions.create({
        key: String(body.key ?? ""),
        spec: body.spec,
        publish: body.publish,
        changeNote: body.change_note,
        ownerId: shared ? null : actor.id,
        isTemplate: shared && !!body.is_template,
      });
    },
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/clone$/,
    async ({ p, actor }) => {
      const src = await definitions.get(p[0], pool, null);
      if (!src) throw new HttpError(404, "not found");
      const spec = src.versions?.[0]?.spec ?? src.draft_spec;
      if (!spec) throw new HttpError(400, "workflow has no spec to clone");
      return definitions.create({
        key: p[0],
        spec,
        publish: true,
        changeNote: `cloned by ${actor.username}`,
        ownerId: actor.id,
      });
    },
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/promote$/,
    async ({ p, actor, url }) => {
      requireAdmin(actor);
      const ownerId = Number(url.searchParams.get("owner") ?? actor.id);
      const src = await definitions.get(p[0], pool, ownerId);
      if (!src || src.owner_id == null) throw new HttpError(404, "not found");
      if (await definitions.get(p[0], pool, null))
        throw new HttpError(409, "a shared workflow with this key already exists");
      const spec = src.versions?.[0]?.spec ?? src.draft_spec;
      await audit(actor.id, "promote", "workflow", p[0], { from: ownerId });
      return definitions.create({
        key: p[0],
        spec,
        publish: true,
        changeNote: `promoted by ${actor.username}`,
        ownerId: null,
      });
    },
  ],
  [
    "POST",
    /^\/api\/workflows\/validate$/,
    ({ body }) => {
      try {
        return { valid: true, spec: validateSpec(body.spec) };
      } catch (e) {
        return { valid: false, errors: (e as any).errors ?? [(e as Error).message] };
      }
    },
  ],
  // Intent routing: which workflow fits a free-text request (suggestion only; the user still chooses).
  [
    "POST",
    /^\/api\/workflows\/route$/,
    async (c) => routeWorkflow(String(c.body.text ?? ""), await definitions.list(pool, mine(c))),
  ],
  ["GET", /^\/api\/workflows\/([a-z0-9_-]+)$/, (c) => readableWorkflow(c, c.p[0])],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/draft$/,
    async (c) => definitions.saveDraft(c.p[0], c.body.spec, await workflowOwner(c, c.p[0])),
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/publish$/,
    async (c) =>
      definitions.publish(c.p[0], String(c.body.change_note ?? ""), await workflowOwner(c, c.p[0])),
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/archive$/,
    async (c) => (await definitions.archive(c.p[0], await workflowOwner(c, c.p[0])), { ok: true }),
  ],

  // ------------------------------------------------------------ runs
  ["GET", /^\/api\/scheduler$/, () => schedulerStatus()],
  [
    "GET",
    /^\/api\/agent-providers$/,
    (c) => agentProviderStatus(c.url.searchParams.get("refresh") === "1"),
  ],
  // Expensive 30-day aggregates: fresh for 30 s, then served stale (≤ 10 min) while one refresh runs in the background.
  [
    "GET",
    /^\/api\/metrics\/summary$/,
    async (c) => {
      const days = Math.max(
        1,
        Math.min(366, Math.floor(Number(c.url.searchParams.get("days") ?? 30)) || 30),
      );
      const scope = mine(c);
      if (scope.all) await audit(c.actor.id, "support.list", "metrics", "*", { days });
      return metricsSwr.get(`${days}|${scope.ownerId}|${scope.all}`, () =>
        metricsSummary(days, scope),
      );
    },
  ],
  // Cache + pool gauges (fixed cache names, no keys or user ids). Admin only: process-wide state.
  [
    "GET",
    /^\/api\/metrics\/cache$/,
    (c) => {
      requireAdmin(c.actor);
      return {
        caches: cacheSnapshot(),
        singleflightInflight: singleflightInflight(),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      };
    },
  ],
  [
    "GET",
    /^\/api\/metrics\/runs\/(\d+)$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runMetrics(num(c.p[0]))),
  ],
  [
    "GET",
    /^\/api\/tools$/,
    ({ url }) =>
      listTools(url.searchParams.get("q") ?? undefined, { mode: "coding" }).map((t) => ({
        ...t,
        ...describeTool(t.name),
      })),
  ],
  [
    "GET",
    /^\/api\/runs$/,
    async (c) => {
      if (support(c)) await audit(c.actor.id, "support.list", "run", "*");
      return withCosts(
        await listRuns({
          status: c.url.searchParams.get("status") ?? undefined,
          workItemId: c.url.searchParams.get("work_item_id")
            ? Number(c.url.searchParams.get("work_item_id"))
            : undefined,
          ...mine(c),
        }),
        "run",
      );
    },
  ],
  [
    "POST",
    /^\/api\/runs$/,
    async ({ body, actor }) => {
      if (body.work_item_id) await requireWorkItem(actor, Number(body.work_item_id), false);
      return startRun({
        definitionKey: String(body.workflow ?? ""),
        version: body.version,
        workItemId: body.work_item_id ?? null,
        inputs: body.inputs,
        repositories: body.repositories,
        title: body.title,
        start: body.start,
        profile: body.profile,
        outputLocale: localeOf(body),
        agentProvider: providerOf(body),
        ownerId: actor.id,
      });
    },
  ],
  // What would run: profile decision, graph changes and the resolved DAG (nothing is created).
  [
    "POST",
    /^\/api\/runs\/preview$/,
    async ({ body, actor }) => {
      if (body.work_item_id) await requireWorkItem(actor, Number(body.work_item_id), false);
      return previewRun({
        definitionKey: String(body.workflow ?? ""),
        version: body.version,
        workItemId: body.work_item_id ?? null,
        inputs: body.inputs,
        repositories: body.repositories?.length ? body.repositories : undefined,
        profile: body.profile,
        ownerId: actor.id,
      });
    },
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runDetail(num(c.p[0]))),
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/events$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      runEvents.list(num(c.p[0]), Number(c.url.searchParams.get("after") ?? 0))
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/start$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      startPendingRun(num(c.p[0]), c.body.repositories, !!c.body.step_mode)
    ),
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/changes$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      runChanges(num(c.p[0]), c.actor.id)
    ),
  ],
  // Cost: totals, tokens, by step / model, wasted cost and budget; budget_usd null clears the run's own budget.
  // Verified outcome ladder (proven states only) + deterministic failure categories; refresh=1 recomputes, sync_pr=1
  // first asks the git provider for the PR lifecycle state (read-only).
  [
    "GET",
    /^\/api\/runs\/(\d+)\/outcome$/,
    async (c) => {
      const id = num(c.p[0]);
      await requireRun(c.actor, id, support(c));
      if (c.url.searchParams.get("sync_pr") === "1") await syncPullRequestStates({ runId: id });
      if (c.url.searchParams.get("refresh") === "1" || c.url.searchParams.get("sync_pr") === "1")
        return (
          (await recordRunOutcome(id)) ?? { pending: true, reason: "the run has not finished" }
        );
      return (
        (await one(pool, "SELECT outcome FROM workflow_runs WHERE id = $1", [id]))?.outcome ??
        (await recordRunOutcome(id)) ?? { pending: true, reason: "the run has not finished" }
      );
    },
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/regression-case$/,
    async (c) => {
      await requireRun(c.actor, num(c.p[0]), support(c));
      return proposeRegressionCase(num(c.p[0]), c.actor.id);
    },
  ],
  // Production investigation: searches (audit + sanitized evidence), timeline, latency, report of one run.
  [
    "GET",
    /^\/api\/runs\/(\d+)\/investigation$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      investigationDetail(num(c.p[0]))
    ),
  ],
  // Hand the findings to the Bug Investigation workflow (fix behind its approval gates); the investigation stays read-only.
  [
    "POST",
    /^\/api\/runs\/(\d+)\/investigation\/fix$/,
    async (c) => {
      await requireRun(c.actor, num(c.p[0]), false);
      await audit(c.actor.id, "investigation.fix", "run", String(num(c.p[0])));
      return startFixFromInvestigation(num(c.p[0]));
    },
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/investigation\/manual-results$/,
    async (c) => {
      await requireRun(c.actor, num(c.p[0]), support(c));
      await audit(c.actor.id, "investigation.manual_results", "run", String(num(c.p[0])), {
        search_id: c.body.search_id ?? null,
      });
      return submitManualResults(num(c.p[0]), {
        search_id: c.body.search_id ? Number(c.body.search_id) : undefined,
        query: c.body.query,
        earliest: c.body.earliest,
        latest: c.body.latest,
        text: String(c.body.text ?? ""),
      });
    },
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/cost$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runCost(num(c.p[0]))),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/budget$/,
    async (c) => {
      await requireRun(c.actor, num(c.p[0]), support(c));
      await q(pool, "UPDATE workflow_runs SET budget_usd = $2, updated_at = now() WHERE id = $1", [
        num(c.p[0]),
        budgetOf(c.body),
      ]);
      return runCost(num(c.p[0]));
    },
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/summary$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      getRunSummary(num(c.p[0]), c.url.searchParams.get("refresh") === "1")
    ),
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      stepDetail(num(c.p[0]), c.p[1])
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/run$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      runStepNow(num(c.p[0]), c.p[1])
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/stop$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      stopStep(num(c.p[0]), c.p[1], c.body.reason || "stopped by user")
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/branches$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      setRunBranches(num(c.p[0]), c.body.branches, c.actor.username)
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/pause$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), pauseRun(num(c.p[0]))),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/resume$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), resumeRun(num(c.p[0]))),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/cancel$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      cancelRun(num(c.p[0]), c.body.reason || "canceled by user")
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/repositories$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      selectRepositories(num(c.p[0]), c.body.repositories ?? [])
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/feedback$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      sendFeedback(num(c.p[0]), String(c.body.message ?? "").trim() || fail("empty message"), {
        mode: (c.body.mode ?? "auto") as FeedbackMode,
        by: c.actor.username,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/feedback\/preview$/,
    async (c) => {
      await requireRun(c.actor, num(c.p[0]), support(c));
      const r = await classifyRunFeedback(
        num(c.p[0]),
        String(c.body.message ?? "").trim() || fail("empty message"),
        (c.body.mode ?? "auto") as FeedbackMode,
      );
      return { decision: r.decision, route: r.route, targets: r.targets };
    },
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/handoff-providers$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      providerHandoffOptions(num(c.p[0]), c.p[1])
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/handoff$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      requestProviderHandoff(num(c.p[0]), c.p[1], c.body, c.actor.id)
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/handoff-resume$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      resumeProviderHandoff(num(c.p[0]), c.p[1], c.body, c.actor.id)
    ),
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/handoffs$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      q(pool, "SELECT * FROM provider_handoff_metrics WHERE run_id=$1 ORDER BY id", [num(c.p[0])])
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/agent$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      setStepAgent(num(c.p[0]), c.p[1], c.body.agent, c.actor.id)
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/retry$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      retryStep(num(c.p[0]), c.p[1], c.body.input)
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/reexecute$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      reexecuteStep(num(c.p[0]), c.p[1], {
        feedback: c.body.feedback,
        input: c.body.input,
        skills: c.body.skills,
        by: c.actor.username,
        persist: c.body.persist !== false,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/approve$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      approveStep(num(c.p[0]), c.p[1], {
        comment: c.body.comment,
        by: c.actor.username,
        repositories: c.body.repositories,
        data: c.body.data,
      })
    ),
  ],
  // Expand the run DAG with a decomposition plan (subtasks become durable steps; idempotent, bounded, approval-gated).
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/expand$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      expandSubtasks(num(c.p[0]), c.p[1], c.body.plan, {
        by: c.actor.username,
        reason: String(c.body.reason ?? ""),
        kind: c.body.kind === "replan" ? "replan" : "decomposition",
      })
    ),
  ],
  // Evidence for the Task Result Report: a file (base64) or a note, optionally tied to one requirement id (e.g. "S1.R2").
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/evidence$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      addEvidence(num(c.p[0]), c.p[1], c.body)
    ),
  ],
  [
    "POST",
    /^\/api\/artifacts\/(\d+)\/delete-evidence$/,
    async (c) => (
      await requireArtifact(c.actor, num(c.p[0]), support(c)),
      removeEvidence(num(c.p[0]))
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/reject$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      rejectStep(num(c.p[0]), c.p[1], {
        comment: c.body.comment,
        by: c.actor.username,
        reexecute: c.body.reexecute,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/skip$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      skipStep(num(c.p[0]), c.p[1], c.body.reason || "skipped by user")
    ),
  ],
  [
    "GET",
    /^\/api\/attempts\/(\d+)\/transcript$/,
    async (c) => (
      await requireAttempt(c.actor, num(c.p[0]), support(c)),
      runEvents.transcript(num(c.p[0]), Number(c.url.searchParams.get("after") ?? 0))
    ),
  ],
  [
    "GET",
    /^\/api\/artifacts\/(\d+)$/,
    async (c) => (
      await requireArtifact(c.actor, num(c.p[0]), support(c)),
      must(
        await one(pool, "SELECT * FROM workflow_artifacts WHERE id = $1", [num(c.p[0])]),
        "artifact",
      )
    ),
  ],
  [
    "GET",
    /^\/api\/snapshots\/(\d+)$/,
    async (c) => (
      await requireSnapshot(c.actor, num(c.p[0]), support(c)),
      must(
        await one(pool, "SELECT * FROM context_snapshots WHERE id = $1", [num(c.p[0])]),
        "snapshot",
      )
    ),
  ],
  [
    "GET",
    /^\/api\/pull-requests$/,
    (c) =>
      q(
        pool,
        `SELECT p.*, w.code AS work_item_code FROM pull_requests p LEFT JOIN work_items w ON w.id = p.work_item_id LEFT JOIN workflow_runs r ON r.id = p.run_id WHERE ($1::bool OR COALESCE(r.owner_id, w.owner_id) = $2) AND COALESCE(r.owner_id, w.owner_id) IS NOT NULL ORDER BY p.updated_at DESC LIMIT 200`,
        [support(c), c.actor.id],
      ),
  ],

  // ------------------------------------------------------------ questions inbox
  ["GET", /^\/api\/questions$/, (c) => openQuestions(pool, mine(c))],
  // Approval steps waiting for a decision (the inbox lists them next to open questions).
  ["GET", /^\/api\/approvals$/, (c) => openApprovals(pool, mine(c))],
  ["GET", /^\/api\/questions\/history$/, (c) => answeredQuestions(100, pool, mine(c))],
  [
    "POST",
    /^\/api\/questions\/answers$/,
    async (c) => (
      await assertQuestionsAccessible(c.actor, support(c), c.body.answers ?? {}),
      answerQuestions(c.body.answers ?? {}, c.actor.username)
    ),
  ],

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
      return visibleKnowledge(
        c.actor.id,
        await knowledge.list({
          category: c.url.searchParams.get("category") ?? undefined,
          ...mine(c),
        }),
      );
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
        (await knowledge.candidates(pool, actor.id)).filter(
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
      const item = await readableKnowledge(c, c.p[0]);
      const used = await q(
        pool,
        `SELECT cs.run_id, s.key AS step_key, s.name AS step_name, r.title AS run_title, r.definition_key, cs.created_at,
                (SELECT (k->>'version')::int FROM jsonb_array_elements(cs.content->'knowledge') k WHERE k->>'key' = $1 LIMIT 1) AS version
           FROM context_snapshots cs JOIN workflow_steps s ON s.id = cs.step_id JOIN workflow_runs r ON r.id = cs.run_id
          WHERE cs.content->'knowledge' @> jsonb_build_array(jsonb_build_object('key', $1::text))
            AND ($2::bool OR r.owner_id = $3)
          ORDER BY cs.id DESC LIMIT 100`,
        [c.p[0], support(c), c.actor.id],
      );
      void item;
      const assigned: Array<{ workflow: string; version: number | string; step: string | null }> =
        [];
      for (const d of await q(
        pool,
        `SELECT d.key, d.draft_spec, v.version, v.spec FROM workflow_definitions d LEFT JOIN workflow_definition_versions v ON v.definition_id = d.id AND v.version = d.latest_version WHERE NOT d.archived AND (d.owner_id IS NULL OR $1::bool OR d.owner_id = $2)`,
        [support(c), c.actor.id],
      )) {
        for (const [spec, ver] of [
          [d.spec, d.version],
          [d.draft_spec, "draft"],
        ] as const) {
          if (!spec) continue;
          if ([...(spec.knowledge ?? []), ...(spec.skills ?? [])].includes(c.p[0]))
            assigned.push({ workflow: d.key, version: ver, step: null });
          for (const st of spec.steps ?? [])
            if ([...(st.config?.knowledge ?? []), ...(st.config?.skills ?? [])].includes(c.p[0]))
              assigned.push({ workflow: d.key, version: ver, step: st.key });
        }
      }
      return { used, assigned };
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
  ["GET", /^\/api\/benchmark-suites$/, () => listSuites()],
  [
    "POST",
    /^\/api\/benchmark-suites\/publish$/,
    async ({ actor }) => {
      requireAdmin(actor);
      if (!config.evaluation.enabled) throw new HttpError(409, "Evaluation framework disabled");
      const row = await publishBuiltinSuite();
      return { id: row.id, key: row.suite_key, version: row.version };
    },
  ],
  ["GET", /^\/api\/agent-evaluation$/, (c) => evaluationAnalytics(c.actor, c.url)],
  ["POST", /^\/api\/agent-recommendations$/, (c) => createRecommendation(c.actor, c.body)],
  [
    "GET",
    /^\/api\/agent-recommendations\/(\d+)$/,
    async (c) => {
      const row = await one(pool, "SELECT * FROM agent_recommendations WHERE id=$1", [num(c.p[0])]);
      if (!row) throw new HttpError(404, "Recommendation not found");
      await requireOwner(c.actor, row.owner_id, support(c), "agent_recommendation", String(row.id));
      return row;
    },
  ],
  [
    "GET",
    /^\/api\/agent-recommendations$/,
    (c) =>
      q(pool, "SELECT * FROM agent_recommendations WHERE owner_id=$1 ORDER BY id DESC LIMIT 50", [
        c.actor.id,
      ]),
  ],
  ["POST", /^\/api\/agent-optimization$/, (c) => saveOptimizationPolicy(c.actor.id, c.body)],
  ["GET", /^\/api\/agent-optimization$/, (c) => optimizationPolicies(c.actor.id)],
  [
    "GET",
    /^\/api\/evaluation-runs$/,
    async ({ actor }) => ({
      enabled: config.evaluation.enabled,
      runs: await evaluationList(actor.id),
    }),
  ],
  [
    "POST",
    /^\/api\/evaluation-runs$/,
    ({ actor, body }) => createEvaluation(actor.id, body, actor.role === "admin"),
  ],
  [
    "GET",
    /^\/api\/evaluation-runs\/(\d+)$/,
    ({ actor, p }) => evaluationDetail(num(p[0]), actor.id),
  ],
  [
    "POST",
    /^\/api\/evaluation-runs\/(\d+)\/start$/,
    async ({ actor, p }) => {
      if (!config.evaluation.enabled) throw new HttpError(409, "Evaluation framework disabled");
      const row = await evaluationDetail(num(p[0]), actor.id);
      return startPendingRun(row.workflow_run_id);
    },
  ],
  [
    "POST",
    /^\/api\/evaluation-runs\/(\d+)\/cancel$/,
    ({ actor, p }) => cancelEvaluation(num(p[0]), actor.id),
  ],
  [
    "POST",
    /^\/api\/evaluation-comparisons$/,
    ({ actor, body }) =>
      createComparison(
        actor.id,
        num(String(body.baseline_id)),
        num(String(body.candidate_id)),
        body.policy,
      ),
  ],
  [
    "GET",
    /^\/api\/evaluation-comparisons\/(\d+)$/,
    ({ actor, p }) => comparisonDetail(num(p[0]), actor.id),
  ],
  [
    "GET",
    /^\/api\/evals$/,
    async ({ url, actor }) => {
      const suite = url.searchParams.get("suite");
      const rows = await q(
        pool,
        `SELECT * FROM eval_results WHERE ($1::text IS NULL OR suite = $1) AND (owner_id IS NULL OR owner_id=$2) ORDER BY id DESC LIMIT 500`,
        [suite, actor.id],
      );
      return { rows, summary: summarizeEval(rows as any) };
    },
  ],
  // Delete for good (with the skill's supporting files). Shared items: admins only, and refused while a workflow still
  // assigns the key unless `force` — the tombstone keeps a snapshot and stops the importer re-creating it.
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/delete$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.owner_id == null) requireAdmin(c.actor);
      else await requireOwner(c.actor, Number(item.owner_id), support(c), "knowledge", c.p[0]);
      if (item.owner_id == null && c.body.force !== true) {
        const assigned = await knowledge.assignments(c.p[0]);
        if (assigned.length)
          throw new HttpError(
            409,
            `still assigned in ${assigned.map((a) => `${a.workflow}${a.step ? `/${a.step}` : ""} (${a.version})`).join(", ")} — remove it there first, or delete with force`,
          );
      }
      return knowledge.remove(c.p[0], {
        ownerId: item.owner_id ?? null,
        by: c.actor.username,
        reason: String(c.body.reason ?? ""),
      });
    },
  ],
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/revert$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.owner_id == null) requireAdmin(c.actor);
      else await requireOwner(c.actor, Number(item.owner_id), support(c), "knowledge", c.p[0]);
      const version = Number(c.body.version);
      if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "invalid version");
      return knowledge.revert(c.p[0], version, item.owner_id ?? null, c.actor.username);
    },
  ],
  ["GET", /^\/api\/knowledge\/([a-z0-9_.-]+)$/, (c) => readableKnowledge(c, c.p[0])],
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.owner_id == null) requireAdmin(c.actor);
      else await requireOwner(c.actor, Number(item.owner_id), support(c), "knowledge", c.p[0]);
      return knowledge.update(
        c.p[0],
        { ...c.body, created_by: c.actor.username },
        item.owner_id ?? null,
      );
    },
  ],

  [
    "GET",
    /^\/api\/runs\/(\d+)\/worker$/,
    async (c) => {
      const id = num(c.p[0]);
      await requireRun(c.actor, id, support(c));
      const run = await one(pool, "SELECT worker_instance FROM workflow_runs WHERE id = $1", [id]);
      const health = await instanceHealth(run?.worker_instance ?? null);
      return {
        ...health,
        local: run?.worker_instance === config.instanceId,
        available: health.health === "ONLINE",
      };
    },
  ],

  // ------------------------------------------------------------ repositories
  // Every member endpoint is scoped by the caller's effective permissions (repos/access.ts); an inaccessible repository
  // answers 404 like an unknown one. Admin-only endpoints manage the registry and grants; they never give the admin
  // access to source code by themselves.
  [
    "POST",
    /^\/api\/repositories\/validate-url$/,
    ({ body, actor }) => (requireAdmin(actor), repositoryRemote(body.repository_url)),
  ],
  [
    "GET",
    /^\/api\/repositories$/,
    async ({ actor, url }) => {
      if (url.searchParams.get("manage") === "1") {
        requireAdmin(actor);
        return (await repositories.list())
          .filter((r) => r.provider !== "benchmark")
          .map(publicRepository);
      }
      const mine = await listAccessibleRepositories(actor.id, { verify: true });
      const visible = new Set(mine.map((m) => m.repository.name));
      return mine.map((m) => memberRepository(m.repository, m.access, visible));
    },
  ],
  [
    "GET",
    /^\/api\/repositories\/index-status$/,
    async ({ actor, url }) => {
      if (!config.codeIntelligence.enabled) return { enabled: false, repositories: [] };
      const rows = await codeIndexStatus();
      if (url.searchParams.get("manage") === "1")
        return (requireAdmin(actor), { enabled: true, repositories: rows });
      const visible = new Set(
        (await listAccessibleRepositories(actor.id)).map((m) => m.repository.name),
      );
      return { enabled: true, repositories: rows.filter((r: any) => visible.has(r.name)) };
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/index-runs\/(\d+)\/cancel$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      await q(
        pool,
        "UPDATE code_intelligence.runs SET status='canceled', fencing_token=fencing_token+1,updated_at=now() WHERE id=$1 AND instance_id=$2 AND status IN ('queued','running')",
        [num(p[0]), config.instanceId],
      );
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/rank$/,
    async ({ body, actor }) => {
      // Ranking only ever sees the caller's own repositories (never another member's, never "all").
      const allowed = new Set(
        await allowedRepositoriesForRun(actor.id, String(body.project ?? ""), "read", {
          verify: true,
        }),
      );
      const ranked = await hybridRank(
        (await repositories.list()).filter((r) => allowed.has(r.name)),
        { text: String(body.text ?? ""), project: body.project },
      );
      return { ranked, ambiguous: isAmbiguous(ranked) };
    },
  ],
  // Access management (admin): matrix, grants, shared level, Bitbucket revalidation, audit.
  ["GET", /^\/api\/repository-access$/, ({ actor }) => (requireAdmin(actor), accessMatrix())],
  [
    "GET",
    /^\/api\/repository-access\/audit$/,
    ({ actor, url }) => (
      requireAdmin(actor),
      accessAudit(url.searchParams.get("repository") || undefined)
    ),
  ],
  [
    "POST",
    /^\/api\/repository-access\/revalidate$/,
    async ({ actor, body }) => {
      // A member may re-check their own Bitbucket access; an admin may re-check anyone's (or everyone's).
      const target = body.user_id == null ? actor.id : num(body.user_id);
      if (target !== actor.id || body.all) requireAdmin(actor);
      const r = await revalidateBitbucket(body.all ? {} : { userId: target });
      await audit(actor.id, "repository.access.revalidate", "repository", "", {
        user_id: body.all ? null : target,
      });
      return r;
    },
  ],
  // One user, many repositories (every repository when `repositories` is omitted): one transaction, one audit entry.
  [
    "POST",
    /^\/api\/repository-access\/bulk$/,
    async ({ body, actor }) => {
      requireAdmin(actor);
      const names =
        body.repositories == null
          ? undefined
          : Array.isArray(body.repositories)
            ? body.repositories.map(String)
            : (() => {
                throw new HttpError(400, "repositories must be a list");
              })();
      const r = await setRepositoryAccessMany(
        num(body.user_id),
        accessLevelFrom(body),
        actor.id,
        names,
      );
      await audit(actor.id, "repository.access.bulk", "repository", "", {
        user_id: r.user_id,
        after: r.level,
        repositories: r.repositories.length,
      });
      return r;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/access$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      const repo = must(await repositories.get(p[0]), "Repository");
      const userId = num(body.user_id);
      const change = await setRepositoryAccess(repo, userId, accessLevelFrom(body), actor.id);
      await audit(actor.id, "repository.access.grant", "repository", repo.name, {
        user_id: userId,
        ...change,
      });
      return change;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/shared$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      const repo = must(await repositories.get(p[0]), "Repository");
      const change = await setSharedAccess(repo, accessLevelFrom(body));
      await audit(actor.id, "repository.access.shared", "repository", repo.name, change);
      return change;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/revalidate$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      const repo = must(await repositories.get(p[0]), "Repository");
      const r = await revalidateBitbucket({ repository: repo });
      await audit(actor.id, "repository.access.revalidate", "repository", repo.name, r);
      return r;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/reindex$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      return { enabled: config.codeIntelligence.enabled, job: await enqueueCodeIndex(p[0]) };
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/delete$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      try {
        if (!(await repositories.remove(p[0], actor.id)))
          throw new HttpError(404, "Repository not found");
      } catch (e) {
        if (e instanceof RepositoryInUseError) throw new HttpError(409, e.message);
        throw e;
      }
      await audit(actor.id, "repository.delete", "repository", p[0]);
      return { ok: true };
    },
  ],
  [
    "GET",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/workspace$/,
    async ({ p, actor }) =>
      workspaceStatus((await requireRepositoryAccess(actor.id, p[0], "read")).repository),
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/(test-connection|prepare|refresh)$/,
    async ({ p, actor }) => {
      // Connection tests and checkouts run with the caller's credentials, and only for a repository they may read.
      const { repository } = await requireRepositoryAccess(actor.id, p[0], "read", {
        verify: true,
      });
      if (p[1] === "test-connection") return testRepositoryConnection(repository);
      await prepareRepository(repository, p[1] === "refresh");
      return workspaceStatus(repository);
    },
  ],
  [
    "GET",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)$/,
    async ({ p, actor, url }) => {
      if (url.searchParams.get("manage") === "1") {
        requireAdmin(actor);
        return publicRepository(must(await repositories.get(p[0]), "Repository"));
      }
      const { repository, access } = await requireRepositoryAccess(actor.id, p[0], "read", {
        verify: true,
      });
      const visible = new Set(
        (await listAccessibleRepositories(actor.id)).map((m) => m.repository.name),
      );
      return memberRepository(repository, access, visible);
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      if (!(await repositories.get(p[0]))) {
        const remote = repositoryRemote(body.repository_url);
        if (body.provider && body.provider !== remote.provider)
          throw new HttpError(400, `Provider must match the repository URL (${remote.provider})`);
      }
      // Registration never grants access; shared access is a separate, explicit admin action.
      const { shared_access: _ignored, ...patch } = body;
      return publicRepository(must(await repositories.upsert(p[0], patch), "Repository"));
    },
  ],

  // ------------------------------------------------------------ Hasaki Work (unchanged endpoints; pick = import only)
  ["GET", /^\/api\/work\/status$/, ({ actor }) => authStatus(actor.id)],
  [
    "POST",
    /^\/api\/work\/login-window$/,
    async ({ actor }) => openLoginWindow(actor.id, actor.username),
  ],
  [
    "POST",
    /^\/api\/work\/login-window\/close$/,
    async ({ actor }) => (await closeLoginWindow(actor.id), authStatus(actor.id)),
  ],
  [
    "POST",
    /^\/api\/work\/token$/,
    async ({ body, actor }) => (
      await setToken(String(body.token ?? ""), actor.id),
      authStatus(actor.id)
    ),
  ],
  [
    "POST",
    /^\/api\/work\/refresh$/,
    async ({ actor }) => ({
      count: (await fetchTaskList(actor.id)).length,
      inbox: await inbox.list(actor.id),
    }),
  ],
  ["GET", /^\/api\/work\/inbox$/, ({ actor }) => inbox.list(actor.id)],
  ["POST", /^\/api\/work\/pick\/(\d+)$/, ({ p, actor }) => pickTask(Number(p[0]), null, actor.id)],

  // ------------------------------------------------------------ Argo CD (QC logs): pasted token, read-only
  // Project QC databases (read-only for agents): admins manage connections; a member sees the ones their access permits.
  [
    "GET",
    /^\/api\/integrations\/databases$/,
    async ({ actor }) => {
      if (actor.role === "admin") return publicDatabases();
      const mine = (await listAccessibleRepositories(actor.id)).map((m) => m.repository.name);
      // Status without technical details (host, account, raw error): those stay with admins.
      return (await databasesForRun(mine)).map((d) => ({
        key: d.key,
        project: d.project,
        environment: d.environment,
        engine: d.engine,
        database_name: d.database_name,
        repositories: d.repositories,
        description: d.description,
        last_status: d.last_status ?? null,
        last_checked_at: d.last_checked_at ?? null,
        last_used_at: d.last_used_at ?? null,
        last_error_kind: d.last_error_kind ?? null,
        last_latency_ms: d.last_latency_ms ?? null,
      }));
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/databases$/,
    async ({ body, actor }) => {
      requireAdmin(actor);
      const r = await saveDatabase(body, actor.id);
      await audit(
        actor.id,
        r.created ? "database.create" : "database.update",
        "project_database",
        r.key,
        {
          project: r.project,
          host: r.host,
          database: r.database_name,
          password_changed: !!body.password,
        },
      );
      return r;
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/databases\/([a-z0-9_-]+)\/test$/,
    async ({ p, actor }) => (requireAdmin(actor), testDatabase(p[0])),
  ],
  [
    "POST",
    /^\/api\/integrations\/databases\/([a-z0-9_-]+)\/delete$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      if (!(await deleteDatabase(p[0]))) throw new HttpError(404, "database not found");
      await audit(actor.id, "database.delete", "project_database", p[0]);
      return { ok: true };
    },
  ],
  ["GET", /^\/api\/integrations\/argocd$/, () => argoStatus()],
  [
    "POST",
    /^\/api\/integrations\/argocd\/token$/,
    ({ body }) => setArgoToken(String(body.token ?? "")),
  ],
  ["POST", /^\/api\/integrations\/argocd\/logout$/, () => clearArgoToken()],
  // Splunk (production SIEM): pasted session cookie, read-only searches
  [
    "GET",
    /^\/api\/integrations\/splunk$/,
    ({ url }) => splunkStatus(url.searchParams.get("check") === "1"),
  ],
  [
    "POST",
    /^\/api\/integrations\/splunk\/cookie$/,
    ({ body }) => setSplunkCookie(String(body.cookie ?? "")),
  ],
  ["POST", /^\/api\/integrations\/splunk\/logout$/, () => clearSplunkCookie()],
  [
    "POST",
    /^\/api\/integrations\/splunk\/token$/,
    ({ body }) => setSplunkToken(String(body.token ?? "")),
  ],
  ["POST", /^\/api\/integrations\/splunk\/test$/, () => splunkTestConnection()],
  // Shared read-only service account: administrators only; members use it only when splunk.allowSharedToken is on.
  [
    "POST",
    /^\/api\/integrations\/splunk\/shared$/,
    async ({ body, actor }) => {
      requireAdmin(actor);
      await audit(actor.id, "integration.splunk.shared_token", "integration", "splunk");
      return setSharedSplunkToken(String(body.token ?? ""));
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/splunk\/shared\/clear$/,
    async ({ actor }) => {
      requireAdmin(actor);
      await audit(actor.id, "integration.splunk.shared_token_clear", "integration", "splunk");
      return clearSharedSplunkToken();
    },
  ],
  [
    "GET",
    /^\/api\/prod-errors$/,
    async (c) => {
      const data = await listGroups({
        day: c.url.searchParams.get("day") ?? undefined,
        all: c.url.searchParams.get("all") === "1",
      });
      return {
        ...data,
        groups: (data.groups ?? []).map((g: any) => redactGroup(g, c.actor, support(c))),
      };
    },
  ],
  [
    "GET",
    /^\/api\/prod-errors\/([0-9a-f]{20})$/,
    async (c) => {
      const data = await getIncidentDetail(c.p[0]);
      return { ...data, group: redactGroup(data.group, c.actor, support(c)) };
    },
  ],
  [
    "POST",
    /^\/api\/prod-errors\/scan$/,
    ({ actor, body }) => (
      requireAdmin(actor),
      startScan("manual", {
        namespaces: Array.isArray(body.namespaces) ? body.namespaces.map(String) : undefined,
        preset: body.preset ? (String(body.preset) as any) : undefined,
        from: body.from ? String(body.from) : undefined,
        to: body.to ? String(body.to) : undefined,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/settings$/,
    ({ body, actor }) => (requireAdmin(actor), saveProdErrorSettings(body)),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/ignore$/,
    ({ p, body, actor }) => (requireAdmin(actor), setIgnored(p[0], body.ignored !== false)),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/investigate$/,
    ({ p, actor }) => investigate(p[0], actor.id),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/link$/,
    ({ p, body, actor }) => linkWorkItem(p[0], String(body.work_item ?? ""), actor.id),
  ],
  // Telegram + Bitbucket credentials (saved in the platform instead of .env; secrets never returned)
  [
    "GET",
    /^\/api\/integrations\/telegram$/,
    ({ actor }) => telegramStatus(actor.id, actor.role === "admin"),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram$/,
    ({ body, actor }) => (requireAdmin(actor), setTelegram(body)),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/mode$/,
    ({ body, actor }) => (requireAdmin(actor), setTelegramMode(body.mode)),
  ],
  ["POST", /^\/api\/integrations\/telegram\/connect$/, ({ actor }) => createBinding(actor.id)],
  [
    "POST",
    /^\/api\/integrations\/telegram\/disconnect$/,
    ({ actor }) => disconnectTelegram(actor.id),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/preferences$/,
    ({ actor, body }) => savePreferences(actor.id, body),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/destination$/,
    ({ body, actor }) =>
      setTelegramDestination(actor.id, String(body.chatId ?? body.chat_id ?? "")),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/chats$/,
    ({ body, actor }) => (requireAdmin(actor), telegramChats(body)),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/test$/,
    ({ actor }) => testTelegram(actor.id, actor.role === "admin"),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/clear$/,
    ({ actor }) => (requireAdmin(actor), clearTelegram()),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/adopt-env$/,
    ({ actor }) => (requireAdmin(actor), adoptEnv("telegram")),
  ],
  ["GET", /^\/api\/integrations\/bitbucket$/, ({ actor }) => bitbucketStatus(actor.id)],
  ["POST", /^\/api\/integrations\/bitbucket$/, ({ body, actor }) => setBitbucket(body, actor.id)],
  ["POST", /^\/api\/integrations\/bitbucket\/clear$/, ({ actor }) => clearBitbucket(actor.id)],
  ["GET", /^\/api\/integrations\/github$/, ({ actor }) => githubStatus(actor.id)],
  ["POST", /^\/api\/integrations\/github$/, ({ body, actor }) => setGithub(body, actor.id)],
  ["POST", /^\/api\/integrations\/github\/clear$/, ({ actor }) => clearGithub(actor.id)],
  [
    "POST",
    /^\/api\/integrations\/bitbucket\/adopt-env$/,
    ({ actor }) => adoptEnv("bitbucket", actor.id),
  ],
  // Vault (QC): pasted token; agents see key names and presence, never values
  [
    "GET",
    /^\/api\/integrations\/vault$/,
    ({ url }) => vaultStatus(url.searchParams.get("check") === "1"),
  ],
  [
    "POST",
    /^\/api\/integrations\/vault\/token$/,
    ({ body }) => setVaultToken(String(body.token ?? "")),
  ],
  ["POST", /^\/api\/integrations\/vault\/logout$/, () => clearVaultToken()],
  // Kafka UI (QC): pasted session cookie, GET-only client
  [
    "GET",
    /^\/api\/integrations\/kafka$/,
    ({ url }) => kafkaStatus(url.searchParams.get("check") === "1"),
  ],
  [
    "POST",
    /^\/api\/integrations\/kafka\/cookie$/,
    ({ body }) => setKafkaCookie(String(body.cookie ?? "")),
  ],
  ["POST", /^\/api\/integrations\/kafka\/logout$/, () => clearKafkaCookie()],

  // ------------------------------------------------------------ legacy /api/tasks (backwards compatible)
  [
    "POST",
    /^\/api\/tasks$/,
    async ({ body, url, actor }) => {
      const { item, created } = await importHasakiTask(body, null, actor.id);
      const wf = url.searchParams.get("workflow");
      const run = wf
        ? await startRun({ definitionKey: wf, workItemId: item.id, ownerId: actor.id })
        : null;
      return {
        code: item.code,
        work_item_id: item.id,
        created,
        started: !!run,
        run_id: run?.id ?? null,
      };
    },
  ],
  [
    "GET",
    /^\/api\/tasks$/,
    async (c) =>
      (await workItems.list(mine(c))).map((w: any) => ({
        code: w.code,
        name: w.title,
        project: w.project,
        status: w.last_run_status ?? w.status,
        work_item_id: w.id,
        created_at: w.created_at,
        updated_at: w.updated_at,
      })),
  ],
  [
    "GET",
    /^\/api\/tasks\/([^/]+)$/,
    async ({ p, url, actor }) => {
      const wi = await workItemByCode(p[0], actor);
      const legacy = wi.legacy_task_code ? await legacyTasks.get(wi.legacy_task_code) : null;
      const run = await latestRun(wi.id);
      const wq = run
        ? await q(
            pool,
            "SELECT id, question, context, options, answer FROM workflow_questions WHERE run_id = $1 AND status <> 'dismissed' ORDER BY id",
            [run.id],
          )
        : [];
      return {
        code: wi.code,
        name: wi.title,
        project: wi.project,
        payload: wi.payload,
        status: run?.status ?? legacy?.status ?? wi.status,
        work_item_id: wi.id,
        run_id: run?.id ?? null,
        running: run?.status === "RUNNING",
        questions: [...(legacy ? await legacyQuestions.list(legacy.code) : []), ...wq],
        prs: [
          ...(legacy ? await legacyPrs.list(legacy.code) : []),
          ...(await q(
            pool,
            "SELECT * FROM pull_requests WHERE work_item_id = $1 AND run_id IS NOT NULL",
            [wi.id],
          )),
        ],
        events: legacy
          ? await legacyEvents.list(legacy.code, Number(url.searchParams.get("after") ?? 0))
          : run
            ? await runEvents.list(run.id)
            : [],
      };
    },
  ],
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/answers$/,
    async ({ p, body, actor }) => (
      await workItemByCode(p[0], actor),
      await assertQuestionsAccessible(actor, false, body.answers ?? {}),
      answerQuestions(body.answers ?? {}, actor.username)
    ),
  ],
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/messages$/,
    async ({ p, body, actor }) => {
      const wi = await workItemByCode(p[0], actor);
      const run = must(await latestRun(wi.id), "run for this task");
      await sendFeedback(run.id, String(body.message ?? "").trim() || fail("empty message"));
      return { ok: true, run_id: run.id };
    },
  ],
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/cancel$/,
    async ({ p, actor }) => {
      const wi = await workItemByCode(p[0], actor);
      const active = await q<{ id: number }>(
        pool,
        "SELECT id FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED', 'CANCELED')",
        [wi.id],
      );
      for (const r of active) await cancelRun(r.id);
      return { ok: true, canceled: active.map((r) => r.id) };
    },
  ],

  ["GET", /^\/api\/users$/, ({ actor }) => (requireAdmin(actor), listUsers())],
  [
    "POST",
    /^\/api\/users$/,
    async ({ body, actor }) => (
      requireAdmin(actor),
      createUser({
        username: String(body.username ?? ""),
        password: String(body.password ?? ""),
        role: body.role === "admin" ? "admin" : "member",
      })
    ),
  ],
  [
    "POST",
    /^\/api\/users\/(\d+)\/password$/,
    async ({ p, body, actor }) => (
      requireAdmin(actor),
      await setPassword(num(p[0]), String(body.password ?? "")),
      { ok: true }
    ),
  ],
  [
    "POST",
    /^\/api\/users\/(\d+)\/active$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      if (num(p[0]) === actor.id && body.active === false)
        throw new HttpError(400, "you cannot deactivate yourself");
      await setActive(num(p[0]), body.active !== false);
      return { ok: true };
    },
  ],
];

function fail(msg: string): never {
  throw new HttpError(400, msg);
}

function localeOf(body: { output_locale?: unknown }) {
  try {
    return resolveOutputLocale(body?.output_locale);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}
function providerOf(body: { agent_provider?: unknown }) {
  try {
    return resolveAgentProvider(body?.agent_provider);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export function errorStatus(e: unknown) {
  if (e instanceof HttpError || e instanceof EngineError) return e.status;
  const code = (e as any)?.code;
  if (code === "23505") return 409; // unique violation
  if (code === "23503" || code === "23514" || code === "22P02") return 400;
  return 400;
}

/**
 * A repository as one member sees it: their effective permission level and its sources, and no names of
 * repositories they cannot access (dependencies are filtered so a relationship does not disclose them).
 */
function memberRepository(
  repo: import("../repos/service.ts").RepositoryRow,
  access: EffectivePermissions,
  visible: Set<string>,
) {
  const { shared_access: _shared, ...rest } = publicRepository(repo);
  return {
    ...rest,
    dependencies: repo.dependencies.filter((d) => visible.has(d)),
    access: {
      level: access.level,
      effective: access.effective,
      source: access.platform.source,
      bitbucket: access.bitbucket,
    },
  };
}

/** Legacy rows may contain another developer's absolute layout; never return it to members. */
function publicRepository(repo: import("../repos/service.ts").RepositoryRow) {
  const path = /^(?:[\\/]|[A-Za-z]:|~)/.test(repo.path) ? "" : repo.path;
  let remote_slug = repo.remote_slug;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(remote_slug)) {
    try {
      const remote = repositoryRemote(remote_slug);
      remote_slug = `${remote.workspace}/${remote.slug}`;
    } catch {
      remote_slug = "";
    }
  }
  return { ...repo, path, remote_slug };
}
