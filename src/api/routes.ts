import { status as codeIndexStatus, enqueue as enqueueCodeIndex } from "../codeIntelligence/indexer.ts";
import { hybridRank } from "../codeIntelligence/search.ts";
import { config } from "../config.ts";
import { instanceHealth } from "../instances.ts";
import { resolveOutputLocale } from "../agent/language.ts";
import { resolveAgentProvider } from "../agent/provider.ts";
import { agentProviderStatus } from "../agent/providerStatus.ts";
import { pool, q, one } from "../db/pool.ts";
import { events as legacyEvents, inbox, prs as legacyPrs, questions as legacyQuestions, tasks as legacyTasks } from "../db.ts";
import { authStatus, closeLoginWindow, openLoginWindow, setToken } from "../hasakiAuth.ts";
import { fetchTaskList, importHasakiTask, pickTask } from "../work.ts";
import { importJiraIssue, importJiraPayload } from "../integrations/jira.ts";
import { argoStatus, clearArgoToken, setArgoToken } from "../integrations/argocd.ts";
import { clearSplunkCookie, setSplunkCookie, splunkStatus } from "../integrations/splunk.ts";
import { clearKafkaCookie, kafkaStatus, setKafkaCookie } from "../integrations/kafka.ts";
import { clearVaultToken, setVaultToken, vaultStatus } from "../integrations/vault.ts";
import { groupsForWorkItem, investigate, linkWorkItem, listGroups, saveSettings as saveProdErrorSettings, setIgnored, startScan } from "../prodErrors/scan.ts";
import { adoptEnv, bitbucketStatus, clearBitbucket, clearTelegram, setBitbucket, setTelegram, setTelegramDestination, telegramChats, telegramStatus, testTelegram } from "../integrations/accounts.ts";
import { HttpError } from "../http/error.ts";
import { assertQuestionsAccessible, audit, requireAdmin, requireArtifact, requireAttempt, requireOwner, requireRun, requireSnapshot, requireWorkItem, wantsSupport, type Actor } from "../authz/access.ts";
import { listUsers, createUser, setActive, setPassword } from "../auth/users.ts";
import { knowledge } from "../knowledge/service.ts";
import { reviewMemory } from "../knowledge/memory.ts";
import { approveProposal, getProposal, listProposals, rejectProposal, reviewScope, rollbackProposal } from "../knowledge/proposals.ts";
import { detectKnowledgeChanges, proposeSkillUpdates } from "../knowledge/learning.ts";
import { background } from "../workflow/background.ts";
import { StaleWhileRevalidate } from "../cache/index.ts";

const metricsSwr = new StaleWhileRevalidate<Awaited<ReturnType<typeof metricsSummary>>>("metrics.summary", 30_000, 600_000);
import { summarizeEval } from "../eval/summary.ts";
import { importFromRepositories } from "../knowledge/importer.ts";
import { CATEGORIES, SCOPES, resolveKnowledge } from "../knowledge/resolve.ts";
import { rankRepositories, repositories, isAmbiguous } from "../repos/service.ts";
import { definitions } from "../workflow/definitions.ts";
import { validateSpec } from "../workflow/graph.ts";
import { runEvents } from "../workflow/events.ts";
import {
  answeredQuestions,
  answerQuestions,
  approveStep,
  cancelRun,
  EngineError,
  listRuns,
  openQuestions,
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
  skipStep,
  startPendingRun,
  startRun,
} from "../workflow/engine.ts";
import { RUN_STATUSES, STEP_STATUSES, STEP_TYPES } from "../workflow/types.ts";
import { workItems } from "../workitems/service.ts";
import { getRunSummary } from "../report/runSummary.ts";
import { runChanges } from "../git/changes.ts";
import { addEvidence, removeEvidence } from "../report/evidenceStore.ts";
import { schedulerStatus } from "../workflow/scheduler.ts";
import { metricsSummary, runMetrics } from "./metrics.ts";
import { describeTool, listTools } from "../agent/toolRegistry.ts";

export { HttpError };

export type Ctx = { p: string[]; body: any; url: URL; actor: Actor };
export type Route = [method: string, pattern: RegExp, handler: (c: Ctx) => unknown];

const support = (c: Ctx) => wantsSupport(c.actor, c.url.searchParams.get("scope"));
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
  return must((await definitions.get(key, pool, c.actor.id)) ?? (await definitions.get(key, pool, null)), "workflow");
}

async function workflowOwner(c: Ctx, key: string): Promise<number | null> {
  const requested = c.url.searchParams.get("owner");
  const ownerId = requested ? Number(requested) : c.actor.id;
  const row = (await definitions.get(key, pool, ownerId)) ?? (requested ? undefined : await definitions.get(key, pool, null));
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
  if (p.owner_id != null && Number(p.owner_id) !== c.actor.id) await requireOwner(c.actor, Number(p.owner_id), support(c), "knowledge_proposal", String(id));
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
  else await requireOwner(c.actor, scope.proposalOwner, support(c), "knowledge_proposal", String(id));
}

/** After a rule change is applied: draft updates for the skills it affects (background, each needs its own approval). */
const evolveSkillsAfter = (row: any) => {
  if (!row.parent_id && config.learning.evolveSkills) background(`skill evolution for proposal ${row.id}`, () => proposeSkillUpdates(Number(row.id)));
};

async function readableKnowledge(c: Ctx, key: string) {
  const requested = c.url.searchParams.get("owner");
  if (requested) {
    const ownerId = Number(requested);
    if (!Number.isInteger(ownerId)) throw new HttpError(404, "not found");
    await requireOwner(c.actor, ownerId, support(c), "knowledge", key);
    return must(await knowledge.get(key, pool, ownerId), "knowledge item");
  }
  return must((await knowledge.get(key, pool, c.actor.id)) ?? (await knowledge.get(key, pool, null)), "knowledge item");
}

function redactGroup(group: any, actor: Actor, showAll: boolean) {
  if (!group?.work_item_id) return group;
  const ownerId = group.work_item_owner_id == null ? null : Number(group.work_item_owner_id);
  if (ownerId === actor.id || (showAll && actor.role === "admin" && ownerId != null)) return group;
  const { work_item_id, work_item_code, work_item_title, work_item_status, work_item_owner_id, run_id, run_status, pull_requests, ...rest } = group;
  return { ...rest, work_item_id: null, run_id: null, pull_requests: [] };
}
const latestRun = (workItemId: number) => one<{ id: number; status: string }>(pool, "SELECT id, status FROM workflow_runs WHERE work_item_id = $1 ORDER BY id DESC LIMIT 1", [workItemId]);

export const routes: Route[] = [
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
  ["GET", /^\/api\/work-items$/, async (c) => {
    if (support(c)) await audit(c.actor.id, "support.list", "work_item", "*");
    return workItems.list({ source: c.url.searchParams.get("source") ?? undefined, status: c.url.searchParams.get("status") ?? undefined, ...mine(c) });
  }],
  ["POST", /^\/api\/work-items$/, ({ body, actor }) => workItems.createManual({ title: body.title, description: body.description, project: body.project, code: body.code, ownerId: actor.id })],
  [
    "POST",
    /^\/api\/work-items\/import$/,
    async ({ body, actor }) => {
      if (body.source === "jira") return body.key ? importJiraIssue(String(body.key), actor.id) : importJiraPayload(body.payload, actor.id);
      if (body.source === "hasaki_work") return body.work_id ? pickTask(Number(body.work_id), null, actor.id) : importHasakiTask(body.payload, null, actor.id);
      throw new HttpError(400, "source must be hasaki_work or jira");
    },
  ],
  ["GET", /^\/api\/work-items\/(\d+)$/, async (c) => (await requireWorkItem(c.actor, num(c.p[0]), support(c)), { ...must(await workItems.detail(num(c.p[0])), "work item"), prod_errors: await groupsForWorkItem(num(c.p[0])) })],
  ["POST", /^\/api\/work-items\/(\d+)$/, async (c) => (await requireWorkItem(c.actor, num(c.p[0]), support(c)), must(await workItems.update(num(c.p[0]), c.body), "work item"))],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/runs$/,
    async (c) => (await requireWorkItem(c.actor, num(c.p[0]), support(c)), startRun({ definitionKey: String(c.body.workflow ?? ""), version: c.body.version, workItemId: num(c.p[0]), inputs: c.body.inputs, repositories: c.body.repositories, title: c.body.title, start: c.body.start, profile: c.body.profile, outputLocale: localeOf(c.body), agentProvider: providerOf(c.body), ownerId: c.actor.id })),
  ],
  ["POST", /^\/api\/work-items\/(\d+)\/analyze$/, async (c) => (await requireWorkItem(c.actor, num(c.p[0]), support(c)), startRun({ definitionKey: "work-item-analysis", workItemId: num(c.p[0]), outputLocale: localeOf(c.body), agentProvider: providerOf(c.body), ownerId: c.actor.id }))],

  // ------------------------------------------------------------ workflow definitions
  ["GET", /^\/api\/workflows$/, (c) => definitions.list(pool, mine(c))],
  ["POST", /^\/api\/workflows$/, ({ body, actor }) => {
    const shared = body.shared === true;
    if (shared) requireAdmin(actor);
    return definitions.create({ key: String(body.key ?? ""), spec: body.spec, publish: body.publish, changeNote: body.change_note, ownerId: shared ? null : actor.id, isTemplate: shared && !!body.is_template });
  }],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/clone$/, async ({ p, actor }) => {
    const src = await definitions.get(p[0], pool, null);
    if (!src) throw new HttpError(404, "not found");
    const spec = src.versions?.[0]?.spec ?? src.draft_spec;
    if (!spec) throw new HttpError(400, "workflow has no spec to clone");
    return definitions.create({ key: p[0], spec, publish: true, changeNote: `cloned by ${actor.username}`, ownerId: actor.id });
  }],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/promote$/, async ({ p, actor, url }) => {
    requireAdmin(actor);
    const ownerId = Number(url.searchParams.get("owner") ?? actor.id);
    const src = await definitions.get(p[0], pool, ownerId);
    if (!src || src.owner_id == null) throw new HttpError(404, "not found");
    if (await definitions.get(p[0], pool, null)) throw new HttpError(409, "a shared workflow with this key already exists");
    const spec = src.versions?.[0]?.spec ?? src.draft_spec;
    await audit(actor.id, "promote", "workflow", p[0], { from: ownerId });
    return definitions.create({ key: p[0], spec, publish: true, changeNote: `promoted by ${actor.username}`, ownerId: null });
  }],
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
  ["GET", /^\/api\/workflows\/([a-z0-9_-]+)$/, (c) => readableWorkflow(c, c.p[0])],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/draft$/, async (c) => definitions.saveDraft(c.p[0], c.body.spec, await workflowOwner(c, c.p[0]))],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/publish$/, async (c) => definitions.publish(c.p[0], String(c.body.change_note ?? ""), await workflowOwner(c, c.p[0]))],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/archive$/, async (c) => (await definitions.archive(c.p[0], await workflowOwner(c, c.p[0])), { ok: true })],

  // ------------------------------------------------------------ runs
  ["GET", /^\/api\/scheduler$/, () => schedulerStatus()],
  ["GET", /^\/api\/agent-providers$/, (c) => agentProviderStatus(c.url.searchParams.get("refresh") === "1")],
  // Expensive 30-day aggregates: fresh for 30 s, then served stale (≤ 10 min) while one refresh runs in the background.
  ["GET", /^\/api\/metrics\/summary$/, (c) => {
    const days = Number(c.url.searchParams.get("days") ?? 30);
    const scope = mine(c);
    return metricsSwr.get(`${days}|${scope.ownerId}|${scope.all}`, () => metricsSummary(days, scope));
  }],
  ["GET", /^\/api\/metrics\/runs\/(\d+)$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runMetrics(num(c.p[0])))],
  ["GET", /^\/api\/tools$/, ({ url }) => listTools(url.searchParams.get("q") ?? undefined, { mode: "coding" }).map((t) => ({ ...t, ...describeTool(t.name) }))],
  ["GET", /^\/api\/runs$/, async (c) => {
    if (support(c)) await audit(c.actor.id, "support.list", "run", "*");
    return listRuns({ status: c.url.searchParams.get("status") ?? undefined, workItemId: c.url.searchParams.get("work_item_id") ? Number(c.url.searchParams.get("work_item_id")) : undefined, ...mine(c) });
  }],
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
      return previewRun({ definitionKey: String(body.workflow ?? ""), version: body.version, workItemId: body.work_item_id ?? null, inputs: body.inputs, repositories: body.repositories?.length ? body.repositories : undefined, profile: body.profile, ownerId: actor.id });
    },
  ],
  ["GET", /^\/api\/runs\/(\d+)$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runDetail(num(c.p[0])))],
  ["GET", /^\/api\/runs\/(\d+)\/events$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runEvents.list(num(c.p[0]), Number(c.url.searchParams.get("after") ?? 0)))],
  ["POST", /^\/api\/runs\/(\d+)\/start$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), startPendingRun(num(c.p[0]), c.body.repositories, !!c.body.step_mode))],
  ["GET", /^\/api\/runs\/(\d+)\/changes$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runChanges(num(c.p[0])))],
  ["GET", /^\/api\/runs\/(\d+)\/summary$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), getRunSummary(num(c.p[0]), c.url.searchParams.get("refresh") === "1"))],
  ["GET", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), stepDetail(num(c.p[0]), c.p[1]))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/run$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runStepNow(num(c.p[0]), c.p[1]))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/stop$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), stopStep(num(c.p[0]), c.p[1], c.body.reason || "stopped by user"))],
  ["POST", /^\/api\/runs\/(\d+)\/pause$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), pauseRun(num(c.p[0])))],
  ["POST", /^\/api\/runs\/(\d+)\/resume$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), resumeRun(num(c.p[0])))],
  ["POST", /^\/api\/runs\/(\d+)\/cancel$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), cancelRun(num(c.p[0]), c.body.reason || "canceled by user"))],
  ["POST", /^\/api\/runs\/(\d+)\/repositories$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), selectRepositories(num(c.p[0]), c.body.repositories ?? []))],
  ["POST", /^\/api\/runs\/(\d+)\/feedback$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), sendFeedback(num(c.p[0]), String(c.body.message ?? "").trim() || fail("empty message")))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/retry$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), retryStep(num(c.p[0]), c.p[1], c.body.input))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/reexecute$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), reexecuteStep(num(c.p[0]), c.p[1], { feedback: c.body.feedback, input: c.body.input, skills: c.body.skills, by: c.actor.username }))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/approve$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), approveStep(num(c.p[0]), c.p[1], { comment: c.body.comment, by: c.actor.username, repositories: c.body.repositories, data: c.body.data }))],
  // Evidence for the Task Result Report: a file (base64) or a note, optionally tied to one requirement id (e.g. "S1.R2").
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/evidence$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), addEvidence(num(c.p[0]), c.p[1], c.body))],
  ["POST", /^\/api\/artifacts\/(\d+)\/delete-evidence$/, async (c) => (await requireArtifact(c.actor, num(c.p[0]), support(c)), removeEvidence(num(c.p[0])))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/reject$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), rejectStep(num(c.p[0]), c.p[1], { comment: c.body.comment, by: c.actor.username, reexecute: c.body.reexecute }))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/skip$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), skipStep(num(c.p[0]), c.p[1], c.body.reason || "skipped by user"))],
  ["GET", /^\/api\/attempts\/(\d+)\/transcript$/, async (c) => (await requireAttempt(c.actor, num(c.p[0]), support(c)), runEvents.transcript(num(c.p[0]), Number(c.url.searchParams.get("after") ?? 0)))],
  ["GET", /^\/api\/artifacts\/(\d+)$/, async (c) => (await requireArtifact(c.actor, num(c.p[0]), support(c)), must(await one(pool, "SELECT * FROM workflow_artifacts WHERE id = $1", [num(c.p[0])]), "artifact"))],
  ["GET", /^\/api\/snapshots\/(\d+)$/, async (c) => (await requireSnapshot(c.actor, num(c.p[0]), support(c)), must(await one(pool, "SELECT * FROM context_snapshots WHERE id = $1", [num(c.p[0])]), "snapshot"))],
  ["GET", /^\/api\/pull-requests$/, (c) => q(pool, `SELECT p.*, w.code AS work_item_code FROM pull_requests p LEFT JOIN work_items w ON w.id = p.work_item_id LEFT JOIN workflow_runs r ON r.id = p.run_id WHERE ($1::bool OR COALESCE(r.owner_id, w.owner_id) = $2) AND COALESCE(r.owner_id, w.owner_id) IS NOT NULL ORDER BY p.updated_at DESC LIMIT 200`, [support(c), c.actor.id])],

  // ------------------------------------------------------------ questions inbox
  ["GET", /^\/api\/questions$/, (c) => openQuestions(pool, mine(c))],
  ["GET", /^\/api\/questions\/history$/, (c) => answeredQuestions(100, pool, mine(c))],
  ["POST", /^\/api\/questions\/answers$/, async (c) => (await assertQuestionsAccessible(c.actor, support(c), c.body.answers ?? {}), answerQuestions(c.body.answers ?? {}, c.actor.username))],

  // ------------------------------------------------------------ knowledge
  ["GET", /^\/api\/knowledge$/, (c) => knowledge.list({ category: c.url.searchParams.get("category") ?? undefined, ...mine(c) })],
  ["POST", /^\/api\/knowledge$/, ({ body, actor }) => {
    const shared = body.shared === true;
    if (shared) requireAdmin(actor);
    return knowledge.create({ ...body, ownerId: shared ? null : actor.id, created_by: actor.username });
  }],
  // Knowledge evolution: change proposals (detected from runs, skill updates, repository conflicts) and their review.
  ["GET", /^\/api\/knowledge-proposals$/, (c) =>
    listProposals({
      ownerId: c.actor.id,
      all: support(c),
      status: c.url.searchParams.get("status") || undefined,
      runId: c.url.searchParams.get("run") ? num(c.url.searchParams.get("run")!) : undefined,
      targetKey: c.url.searchParams.get("target") || undefined,
    })],
  ["GET", /^\/api\/knowledge-proposals\/(\d+)$/, (c) => readableProposal(c, num(c.p[0]))],
  ["POST", /^\/api\/knowledge-proposals\/(\d+)\/approve$/, async (c) => {
    const id = num(c.p[0]);
    await requireReviewer(c, id, c.body.shared === true);
    return approveProposal(id, { by: c.actor.username, comment: c.body.comment, edits: c.body.edits, acceptCurrentVersion: c.body.accept_current_version === true, overrideValidation: c.body.override_validation === true, shared: c.body.shared === true }, evolveSkillsAfter);
  }],
  ["POST", /^\/api\/knowledge-proposals\/(\d+)\/reject$/, async (c) => (await requireReviewer(c, num(c.p[0])), rejectProposal(num(c.p[0]), { by: c.actor.username, comment: c.body.comment }))],
  ["POST", /^\/api\/knowledge-proposals\/(\d+)\/rollback$/, async (c) => (await requireReviewer(c, num(c.p[0])), rollbackProposal(num(c.p[0]), { by: c.actor.username, comment: c.body.comment }))],
  // Re-run change detection for one run (e.g. after answering more questions, or for a run that did not complete).
  ["POST", /^\/api\/runs\/(\d+)\/learn$/, async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), detectKnowledgeChanges(num(c.p[0]), { force: c.body.force === true }))],
  ["POST", /^\/api\/knowledge\/import-repos$/, ({ body, actor }) => (requireAdmin(actor), importFromRepositories({ dryRun: !!body.dry_run }))],
  [
    "POST",
    /^\/api\/knowledge\/preview$/,
    async ({ body, actor }) =>
      resolveKnowledge(await knowledge.candidates(pool, actor.id), {
        organization: config.organization,
        project: String(body.project ?? ""),
        repositories: body.repositories ?? [],
        workflowKey: String(body.workflow ?? ""),
        stepKey: String(body.step ?? ""),
        stepType: String(body.step_type ?? ""),
        text: String(body.text ?? ""),
        explicit: body.explicit ?? [],
      }),
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
      const assigned: Array<{ workflow: string; version: number | string; step: string | null }> = [];
      for (const d of await q(pool, `SELECT d.key, d.draft_spec, v.version, v.spec FROM workflow_definitions d LEFT JOIN workflow_definition_versions v ON v.definition_id = d.id AND v.version = d.latest_version WHERE NOT d.archived AND (d.owner_id IS NULL OR $1::bool OR d.owner_id = $2)`, [support(c), c.actor.id])) {
        for (const [spec, ver] of [[d.spec, d.version], [d.draft_spec, "draft"]] as const) {
          if (!spec) continue;
          if ([...(spec.knowledge ?? []), ...(spec.skills ?? [])].includes(c.p[0])) assigned.push({ workflow: d.key, version: ver, step: null });
          for (const st of spec.steps ?? []) if ([...(st.config?.knowledge ?? []), ...(st.config?.skills ?? [])].includes(c.p[0])) assigned.push({ workflow: d.key, version: ver, step: st.key });
        }
      }
      return { used, assigned };
    },
  ],
  // Cross-task memory: a human promotes (or rejects) agent conclusions; nothing else makes them trusted.
  ["POST", /^\/api\/knowledge\/([a-z0-9_.-]+)\/approve$/, async (c) => reviewMemory(c.p[0], "approve", c.actor.username, (await readableKnowledge(c, c.p[0])).owner_id ?? null)],
  ["POST", /^\/api\/knowledge\/([a-z0-9_.-]+)\/reject$/, async (c) => reviewMemory(c.p[0], "reject", c.actor.username, (await readableKnowledge(c, c.p[0])).owner_id ?? null)],
  ["GET", /^\/api\/evals$/, async ({ url }) => {
    const suite = url.searchParams.get("suite");
    const rows = await q(pool, `SELECT * FROM eval_results WHERE ($1::text IS NULL OR suite = $1) ORDER BY id DESC LIMIT 500`, [suite]);
    return { rows, summary: summarizeEval(rows as any) };
  }],
  ["GET", /^\/api\/knowledge\/([a-z0-9_.-]+)$/, (c) => readableKnowledge(c, c.p[0])],
  ["POST", /^\/api\/knowledge\/([a-z0-9_.-]+)$/, async (c) => {
    const item = await readableKnowledge(c, c.p[0]);
    if (item.owner_id == null) requireAdmin(c.actor);
    else await requireOwner(c.actor, Number(item.owner_id), support(c), "knowledge", c.p[0]);
    return knowledge.update(c.p[0], { ...c.body, created_by: c.actor.username }, item.owner_id ?? null);
  }],

  ["GET", /^\/api\/runs\/(\d+)\/worker$/, async (c) => {
    const id = num(c.p[0]);
    await requireRun(c.actor, id, support(c));
    const run = await one(pool, "SELECT worker_instance FROM workflow_runs WHERE id = $1", [id]);
    const health = await instanceHealth(run?.worker_instance ?? null);
    return { ...health, local: run?.worker_instance === config.instanceId, available: health.health === "ONLINE" };
  }],

  // ------------------------------------------------------------ repositories
  ["GET", /^\/api\/repositories\/index-status$/, async () => ({ enabled: config.codeIntelligence.enabled, repositories: config.codeIntelligence.enabled ? await codeIndexStatus() : [] })],
  ["POST", /^\/api\/repositories\/([A-Za-z0-9._-]+)\/reindex$/, async ({ p, actor }) => { requireAdmin(actor); return { enabled: config.codeIntelligence.enabled, job: await enqueueCodeIndex(p[0]) }; }],
  ["POST", /^\/api\/repositories\/index-runs\/(\d+)\/cancel$/, async ({ p, actor }) => { requireAdmin(actor); await q(pool, "UPDATE code_intelligence.runs SET status='canceled', fencing_token=fencing_token+1,updated_at=now() WHERE id=$1 AND instance_id=$2 AND status IN ('queued','running')", [num(p[0]), config.instanceId]); return { ok: true }; }],
  ["GET", /^\/api\/repositories$/, () => repositories.list()],
  [
    "POST",
    /^\/api\/repositories\/rank$/,
    async ({ body }) => {
      const allowed = new Set(await repositories.allowedFor(String(body.project ?? "")));
      const ranked = await hybridRank((await repositories.list()).filter((r) => allowed.has(r.name)), { text: String(body.text ?? ""), project: body.project });
      return { ranked, ambiguous: isAmbiguous(ranked) };
    },
  ],
  ["POST", /^\/api\/repositories\/([A-Za-z0-9._-]+)$/, ({ p, body, actor }) => (requireAdmin(actor), repositories.upsert(p[0], body))],

  // ------------------------------------------------------------ Hasaki Work (unchanged endpoints; pick = import only)
  ["GET", /^\/api\/work\/status$/, ({ actor }) => authStatus(actor.id)],
  ["POST", /^\/api\/work\/login-window$/, async ({ actor }) => openLoginWindow(actor.id, actor.username)],
  ["POST", /^\/api\/work\/login-window\/close$/, async ({ actor }) => (await closeLoginWindow(actor.id), authStatus(actor.id))],
  ["POST", /^\/api\/work\/token$/, async ({ body, actor }) => (await setToken(String(body.token ?? ""), actor.id), authStatus(actor.id))],
  ["POST", /^\/api\/work\/refresh$/, async ({ actor }) => ({ count: (await fetchTaskList(actor.id)).length, inbox: await inbox.list(actor.id) })],
  ["GET", /^\/api\/work\/inbox$/, ({ actor }) => inbox.list(actor.id)],
  ["POST", /^\/api\/work\/pick\/(\d+)$/, ({ p, actor }) => pickTask(Number(p[0]), null, actor.id)],

  // ------------------------------------------------------------ Argo CD (QC logs): pasted token, read-only
  ["GET", /^\/api\/integrations\/argocd$/, () => argoStatus()],
  ["POST", /^\/api\/integrations\/argocd\/token$/, ({ body }) => setArgoToken(String(body.token ?? ""))],
  ["POST", /^\/api\/integrations\/argocd\/logout$/, () => clearArgoToken()],
  // Splunk (production SIEM): pasted session cookie, read-only searches
  ["GET", /^\/api\/integrations\/splunk$/, ({ url }) => splunkStatus(url.searchParams.get("check") === "1")],
  ["POST", /^\/api\/integrations\/splunk\/cookie$/, ({ body }) => setSplunkCookie(String(body.cookie ?? ""))],
  ["POST", /^\/api\/integrations\/splunk\/logout$/, () => clearSplunkCookie()],
  ["GET", /^\/api\/prod-errors$/, async (c) => {
    const data = await listGroups({ day: c.url.searchParams.get("day") ?? undefined, all: c.url.searchParams.get("all") === "1" });
    return { ...data, groups: (data.groups ?? []).map((g: any) => redactGroup(g, c.actor, support(c))) };
  }],
  ["POST", /^\/api\/prod-errors\/scan$/, ({ actor, body }) => (
    requireAdmin(actor),
    startScan("manual", {
      namespaces: Array.isArray(body.namespaces) ? body.namespaces.map(String) : undefined,
      preset: body.preset ? String(body.preset) as any : undefined,
      from: body.from ? String(body.from) : undefined,
      to: body.to ? String(body.to) : undefined,
    })
  )],
  ["POST", /^\/api\/prod-errors\/settings$/, ({ body, actor }) => (requireAdmin(actor), saveProdErrorSettings(body))],
  ["POST", /^\/api\/prod-errors\/([0-9a-f]{20})\/ignore$/, ({ p, body, actor }) => (requireAdmin(actor), setIgnored(p[0], body.ignored !== false))],
  ["POST", /^\/api\/prod-errors\/([0-9a-f]{20})\/investigate$/, ({ p, actor }) => investigate(p[0], actor.id)],
  ["POST", /^\/api\/prod-errors\/([0-9a-f]{20})\/link$/, ({ p, body, actor }) => linkWorkItem(p[0], String(body.work_item ?? ""), actor.id)],
  // Telegram + Bitbucket credentials (saved in the platform instead of .env; secrets never returned)
  ["GET", /^\/api\/integrations\/telegram$/, ({ actor }) => telegramStatus(actor.id)],
  ["POST", /^\/api\/integrations\/telegram$/, ({ body, actor }) => (requireAdmin(actor), setTelegram(body))],
  ["POST", /^\/api\/integrations\/telegram\/destination$/, ({ body, actor }) => setTelegramDestination(actor.id, String(body.chatId ?? body.chat_id ?? ""))],
  ["POST", /^\/api\/integrations\/telegram\/chats$/, ({ body, actor }) => (requireAdmin(actor), telegramChats(body))],
  ["POST", /^\/api\/integrations\/telegram\/test$/, ({ actor }) => testTelegram(actor.id, actor.role === "admin")],
  ["POST", /^\/api\/integrations\/telegram\/clear$/, ({ actor }) => (requireAdmin(actor), clearTelegram())],
  ["POST", /^\/api\/integrations\/telegram\/adopt-env$/, ({ actor }) => (requireAdmin(actor), adoptEnv("telegram"))],
  ["GET", /^\/api\/integrations\/bitbucket$/, ({ actor }) => bitbucketStatus(actor.id)],
  ["POST", /^\/api\/integrations\/bitbucket$/, ({ body, actor }) => setBitbucket(body, actor.id)],
  ["POST", /^\/api\/integrations\/bitbucket\/clear$/, ({ actor }) => clearBitbucket(actor.id)],
  ["POST", /^\/api\/integrations\/bitbucket\/adopt-env$/, ({ actor }) => adoptEnv("bitbucket", actor.id)],
  // Vault (QC): pasted token; agents see key names and presence, never values
  ["GET", /^\/api\/integrations\/vault$/, ({ url }) => vaultStatus(url.searchParams.get("check") === "1")],
  ["POST", /^\/api\/integrations\/vault\/token$/, ({ body }) => setVaultToken(String(body.token ?? ""))],
  ["POST", /^\/api\/integrations\/vault\/logout$/, () => clearVaultToken()],
  // Kafka UI (QC): pasted session cookie, GET-only client
  ["GET", /^\/api\/integrations\/kafka$/, ({ url }) => kafkaStatus(url.searchParams.get("check") === "1")],
  ["POST", /^\/api\/integrations\/kafka\/cookie$/, ({ body }) => setKafkaCookie(String(body.cookie ?? ""))],
  ["POST", /^\/api\/integrations\/kafka\/logout$/, () => clearKafkaCookie()],

  // ------------------------------------------------------------ legacy /api/tasks (backwards compatible)
  [
    "POST",
    /^\/api\/tasks$/,
    async ({ body, url, actor }) => {
      const { item, created } = await importHasakiTask(body, null, actor.id);
      const wf = url.searchParams.get("workflow");
      const run = wf ? await startRun({ definitionKey: wf, workItemId: item.id, ownerId: actor.id }) : null;
      return { code: item.code, work_item_id: item.id, created, started: !!run, run_id: run?.id ?? null };
    },
  ],
  [
    "GET",
    /^\/api\/tasks$/,
    async (c) =>
      (await workItems.list(mine(c))).map((w: any) => ({ code: w.code, name: w.title, project: w.project, status: w.last_run_status ?? w.status, work_item_id: w.id, created_at: w.created_at, updated_at: w.updated_at })),
  ],
  [
    "GET",
    /^\/api\/tasks\/([^/]+)$/,
    async ({ p, url, actor }) => {
      const wi = await workItemByCode(p[0], actor);
      const legacy = wi.legacy_task_code ? await legacyTasks.get(wi.legacy_task_code) : null;
      const run = await latestRun(wi.id);
      const wq = run ? await q(pool, "SELECT id, question, context, options, answer FROM workflow_questions WHERE run_id = $1 AND status <> 'dismissed' ORDER BY id", [run.id]) : [];
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
        prs: [...(legacy ? await legacyPrs.list(legacy.code) : []), ...(await q(pool, "SELECT * FROM pull_requests WHERE work_item_id = $1 AND run_id IS NOT NULL", [wi.id]))],
        events: legacy ? await legacyEvents.list(legacy.code, Number(url.searchParams.get("after") ?? 0)) : run ? await runEvents.list(run.id) : [],
      };
    },
  ],
  ["POST", /^\/api\/tasks\/([^/]+)\/answers$/, async ({ p, body, actor }) => (await workItemByCode(p[0], actor), await assertQuestionsAccessible(actor, false, body.answers ?? {}), answerQuestions(body.answers ?? {}, actor.username))],
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
      const active = await q<{ id: number }>(pool, "SELECT id FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED', 'CANCELED')", [wi.id]);
      for (const r of active) await cancelRun(r.id);
      return { ok: true, canceled: active.map((r) => r.id) };
    },
  ],

  ["GET", /^\/api\/users$/, ({ actor }) => (requireAdmin(actor), listUsers())],
  ["POST", /^\/api\/users$/, async ({ body, actor }) => (requireAdmin(actor), createUser({ username: String(body.username ?? ""), password: String(body.password ?? ""), role: body.role === "admin" ? "admin" : "member" }))],
  ["POST", /^\/api\/users\/(\d+)\/password$/, async ({ p, body, actor }) => (requireAdmin(actor), await setPassword(num(p[0]), String(body.password ?? "")), { ok: true })],
  ["POST", /^\/api\/users\/(\d+)\/active$/, async ({ p, body, actor }) => {
    requireAdmin(actor);
    if (num(p[0]) === actor.id && body.active === false) throw new HttpError(400, "you cannot deactivate yourself");
    await setActive(num(p[0]), body.active !== false);
    return { ok: true };
  }],
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
