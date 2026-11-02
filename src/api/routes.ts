import { config } from "../config.ts";
import { pool, q, one } from "../db/pool.ts";
import { events as legacyEvents, inbox, prs as legacyPrs, questions as legacyQuestions, tasks as legacyTasks } from "../db.ts";
import { authStatus, closeLoginWindow, openLoginWindow, setToken } from "../hasakiAuth.ts";
import { fetchTaskList, importHasakiTask, pickTask } from "../work.ts";
import { importJiraIssue, importJiraPayload } from "../integrations/jira.ts";
import { knowledge } from "../knowledge/service.ts";
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
import { runChanges } from "../git/changes.ts";
import { addEvidence, removeEvidence } from "../report/evidenceStore.ts";
import { schedulerStatus } from "../workflow/scheduler.ts";
import { metricsSummary, runMetrics } from "./metrics.ts";
import { describeTool, listTools } from "../agent/toolRegistry.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Ctx = { p: string[]; body: any; url: URL };
export type Route = [method: string, pattern: RegExp, handler: (c: Ctx) => unknown];

const num = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `invalid id "${s}"`);
  return n;
};
const must = <T>(v: T | undefined | null, what: string): T => {
  if (v == null) throw new HttpError(404, `${what} not found`);
  return v;
};

async function workItemByCode(code: string) {
  return must(await workItems.byCode(code), "task");
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
  ["GET", /^\/api\/work-items$/, ({ url }) => workItems.list({ source: url.searchParams.get("source") ?? undefined, status: url.searchParams.get("status") ?? undefined })],
  ["POST", /^\/api\/work-items$/, ({ body }) => workItems.createManual(body)],
  [
    "POST",
    /^\/api\/work-items\/import$/,
    async ({ body }) => {
      if (body.source === "jira") return body.key ? importJiraIssue(String(body.key)) : importJiraPayload(body.payload);
      if (body.source === "hasaki_work") return body.work_id ? pickTask(Number(body.work_id)) : importHasakiTask(body.payload);
      throw new HttpError(400, "source must be hasaki_work or jira");
    },
  ],
  ["GET", /^\/api\/work-items\/(\d+)$/, async ({ p }) => must(await workItems.detail(num(p[0])), "work item")],
  ["POST", /^\/api\/work-items\/(\d+)$/, async ({ p, body }) => must(await workItems.update(num(p[0]), body), "work item")],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/runs$/,
    ({ p, body }) =>
      startRun({ definitionKey: String(body.workflow ?? ""), version: body.version, workItemId: num(p[0]), inputs: body.inputs, repositories: body.repositories, title: body.title, start: body.start, profile: body.profile }),
  ],
  // "Analyze Work Item": a read-only workflow (analysis + repository recommendation), no code changes.
  ["POST", /^\/api\/work-items\/(\d+)\/analyze$/, ({ p }) => startRun({ definitionKey: "work-item-analysis", workItemId: num(p[0]) })],

  // ------------------------------------------------------------ workflow definitions
  ["GET", /^\/api\/workflows$/, () => definitions.list()],
  ["POST", /^\/api\/workflows$/, ({ body }) => definitions.create({ key: String(body.key ?? ""), spec: body.spec, publish: body.publish, changeNote: body.change_note })],
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
  ["GET", /^\/api\/workflows\/([a-z0-9_-]+)$/, async ({ p }) => must(await definitions.get(p[0]), "workflow")],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/draft$/, ({ p, body }) => definitions.saveDraft(p[0], body.spec)],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/publish$/, ({ p, body }) => definitions.publish(p[0], String(body.change_note ?? ""))],
  ["POST", /^\/api\/workflows\/([a-z0-9_-]+)\/archive$/, async ({ p }) => (await definitions.archive(p[0]), { ok: true })],

  // ------------------------------------------------------------ runs
  ["GET", /^\/api\/scheduler$/, () => schedulerStatus()],
  ["GET", /^\/api\/metrics\/summary$/, ({ url }) => metricsSummary(Number(url.searchParams.get("days") ?? 30))],
  ["GET", /^\/api\/metrics\/runs\/(\d+)$/, ({ p }) => runMetrics(num(p[0]))],
  ["GET", /^\/api\/tools$/, ({ url }) => listTools(url.searchParams.get("q") ?? undefined, { mode: "coding" }).map((t) => ({ ...t, ...describeTool(t.name) }))],
  ["GET", /^\/api\/runs$/, ({ url }) => listRuns({ status: url.searchParams.get("status") ?? undefined, workItemId: url.searchParams.get("work_item_id") ? Number(url.searchParams.get("work_item_id")) : undefined })],
  [
    "POST",
    /^\/api\/runs$/,
    ({ body }) =>
      startRun({
        definitionKey: String(body.workflow ?? ""),
        version: body.version,
        workItemId: body.work_item_id ?? null,
        inputs: body.inputs,
        repositories: body.repositories,
        title: body.title,
        start: body.start,
        profile: body.profile,
      }),
  ],
  // What would run: profile decision, graph changes and the resolved DAG (nothing is created).
  [
    "POST",
    /^\/api\/runs\/preview$/,
    ({ body }) =>
      previewRun({ definitionKey: String(body.workflow ?? ""), version: body.version, workItemId: body.work_item_id ?? null, inputs: body.inputs, repositories: body.repositories?.length ? body.repositories : undefined, profile: body.profile }),
  ],
  ["GET", /^\/api\/runs\/(\d+)$/, ({ p }) => runDetail(num(p[0]))],
  ["GET", /^\/api\/runs\/(\d+)\/events$/, ({ p, url }) => runEvents.list(num(p[0]), Number(url.searchParams.get("after") ?? 0))],
  ["POST", /^\/api\/runs\/(\d+)\/start$/, ({ p, body }) => startPendingRun(num(p[0]), body.repositories, !!body.step_mode)],
  ["GET", /^\/api\/runs\/(\d+)\/changes$/, ({ p }) => runChanges(num(p[0]))],
  ["GET", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)$/, ({ p }) => stepDetail(num(p[0]), p[1])],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/run$/, ({ p }) => runStepNow(num(p[0]), p[1])],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/stop$/, ({ p, body }) => stopStep(num(p[0]), p[1], body.reason || "stopped by user")],
  ["POST", /^\/api\/runs\/(\d+)\/pause$/, ({ p }) => pauseRun(num(p[0]))],
  ["POST", /^\/api\/runs\/(\d+)\/resume$/, ({ p }) => resumeRun(num(p[0]))],
  ["POST", /^\/api\/runs\/(\d+)\/cancel$/, ({ p, body }) => cancelRun(num(p[0]), body.reason || "canceled by user")],
  ["POST", /^\/api\/runs\/(\d+)\/repositories$/, ({ p, body }) => selectRepositories(num(p[0]), body.repositories ?? [])],
  ["POST", /^\/api\/runs\/(\d+)\/feedback$/, ({ p, body }) => sendFeedback(num(p[0]), String(body.message ?? "").trim() || fail("empty message"))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/retry$/, ({ p, body }) => retryStep(num(p[0]), p[1], body.input)],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/reexecute$/, ({ p, body }) => reexecuteStep(num(p[0]), p[1], { feedback: body.feedback, input: body.input })],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/approve$/, ({ p, body }) => approveStep(num(p[0]), p[1], { comment: body.comment, by: body.by, repositories: body.repositories, data: body.data })],
  // Evidence for the Task Result Report: a file (base64) or a note, optionally tied to one requirement id (e.g. "S1.R2").
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/evidence$/, ({ p, body }) => addEvidence(num(p[0]), p[1], body)],
  ["POST", /^\/api\/artifacts\/(\d+)\/delete-evidence$/, ({ p }) => removeEvidence(num(p[0]))],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/reject$/, ({ p, body }) => rejectStep(num(p[0]), p[1], { comment: body.comment, by: body.by, reexecute: body.reexecute })],
  ["POST", /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/skip$/, ({ p, body }) => skipStep(num(p[0]), p[1], body.reason || "skipped by user")],
  ["GET", /^\/api\/attempts\/(\d+)\/transcript$/, ({ p, url }) => runEvents.transcript(num(p[0]), Number(url.searchParams.get("after") ?? 0))],
  ["GET", /^\/api\/artifacts\/(\d+)$/, async ({ p }) => must(await one(pool, "SELECT * FROM workflow_artifacts WHERE id = $1", [num(p[0])]), "artifact")],
  ["GET", /^\/api\/snapshots\/(\d+)$/, async ({ p }) => must(await one(pool, "SELECT * FROM context_snapshots WHERE id = $1", [num(p[0])]), "snapshot")],
  ["GET", /^\/api\/pull-requests$/, () => q(pool, "SELECT p.*, w.code AS work_item_code FROM pull_requests p LEFT JOIN work_items w ON w.id = p.work_item_id ORDER BY p.updated_at DESC LIMIT 200")],

  // ------------------------------------------------------------ questions inbox
  ["GET", /^\/api\/questions$/, () => openQuestions()],
  ["GET", /^\/api\/questions\/history$/, () => answeredQuestions()],
  ["POST", /^\/api\/questions\/answers$/, ({ body }) => answerQuestions(body.answers ?? {}, String(body.by ?? ""))],

  // ------------------------------------------------------------ knowledge
  ["GET", /^\/api\/knowledge$/, ({ url }) => knowledge.list({ category: url.searchParams.get("category") ?? undefined })],
  ["POST", /^\/api\/knowledge$/, ({ body }) => knowledge.create(body)],
  // Scan the registered repositories (CLAUDE.md, skills, cursor rules, wiki docs) and import them; dry_run previews.
  ["POST", /^\/api\/knowledge\/import-repos$/, ({ body }) => importFromRepositories({ dryRun: !!body.dry_run })],
  [
    "POST",
    /^\/api\/knowledge\/preview$/,
    async ({ body }) =>
      resolveKnowledge(await knowledge.candidates(), {
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
    async ({ p }) => {
      const used = await q(
        pool,
        `SELECT cs.run_id, s.key AS step_key, s.name AS step_name, r.title AS run_title, r.definition_key, cs.created_at,
                (SELECT (k->>'version')::int FROM jsonb_array_elements(cs.content->'knowledge') k WHERE k->>'key' = $1 LIMIT 1) AS version
           FROM context_snapshots cs JOIN workflow_steps s ON s.id = cs.step_id JOIN workflow_runs r ON r.id = cs.run_id
          WHERE cs.content->'knowledge' @> jsonb_build_array(jsonb_build_object('key', $1::text))
          ORDER BY cs.id DESC LIMIT 100`,
        [p[0]],
      );
      const assigned: Array<{ workflow: string; version: number | string; step: string | null }> = [];
      for (const d of await q(pool, `SELECT d.key, d.draft_spec, v.version, v.spec FROM workflow_definitions d LEFT JOIN workflow_definition_versions v ON v.definition_id = d.id AND v.version = d.latest_version WHERE NOT d.archived`)) {
        for (const [spec, ver] of [[d.spec, d.version], [d.draft_spec, "draft"]] as const) {
          if (!spec) continue;
          if ([...(spec.knowledge ?? []), ...(spec.skills ?? [])].includes(p[0])) assigned.push({ workflow: d.key, version: ver, step: null });
          for (const st of spec.steps ?? []) if ([...(st.config?.knowledge ?? []), ...(st.config?.skills ?? [])].includes(p[0])) assigned.push({ workflow: d.key, version: ver, step: st.key });
        }
      }
      return { used, assigned };
    },
  ],
  ["GET", /^\/api\/knowledge\/([a-z0-9_.-]+)$/, async ({ p }) => must(await knowledge.get(p[0]), "knowledge item")],
  ["POST", /^\/api\/knowledge\/([a-z0-9_.-]+)$/, ({ p, body }) => knowledge.update(p[0], body)],

  // ------------------------------------------------------------ repositories
  ["GET", /^\/api\/repositories$/, () => repositories.list()],
  [
    "POST",
    /^\/api\/repositories\/rank$/,
    async ({ body }) => {
      const allowed = new Set(await repositories.allowedFor(String(body.project ?? "")));
      const ranked = rankRepositories((await repositories.list()).filter((r) => allowed.has(r.name)), { text: String(body.text ?? ""), project: body.project });
      return { ranked, ambiguous: isAmbiguous(ranked) };
    },
  ],
  ["POST", /^\/api\/repositories\/([A-Za-z0-9._-]+)$/, ({ p, body }) => repositories.upsert(p[0], body)],

  // ------------------------------------------------------------ Hasaki Work (unchanged endpoints; pick = import only)
  ["GET", /^\/api\/work\/status$/, () => authStatus()],
  ["POST", /^\/api\/work\/login-window$/, async () => (await openLoginWindow(), authStatus())],
  ["POST", /^\/api\/work\/login-window\/close$/, async () => (await closeLoginWindow(), authStatus())],
  ["POST", /^\/api\/work\/token$/, async ({ body }) => (await setToken(String(body.token ?? "")), authStatus())],
  ["POST", /^\/api\/work\/refresh$/, async () => ({ count: (await fetchTaskList()).length, inbox: await inbox.list() })],
  ["GET", /^\/api\/work\/inbox$/, () => inbox.list()],
  ["POST", /^\/api\/work\/pick\/(\d+)$/, ({ p }) => pickTask(Number(p[0]))],

  // ------------------------------------------------------------ legacy /api/tasks (backwards compatible)
  [
    "POST",
    /^\/api\/tasks$/,
    async ({ body, url }) => {
      const { item, created } = await importHasakiTask(body);
      const wf = url.searchParams.get("workflow");
      const run = wf ? await startRun({ definitionKey: wf, workItemId: item.id }) : null;
      return { code: item.code, work_item_id: item.id, created, started: !!run, run_id: run?.id ?? null };
    },
  ],
  [
    "GET",
    /^\/api\/tasks$/,
    async () =>
      (await workItems.list()).map((w: any) => ({ code: w.code, name: w.title, project: w.project, status: w.last_run_status ?? w.status, work_item_id: w.id, created_at: w.created_at, updated_at: w.updated_at })),
  ],
  [
    "GET",
    /^\/api\/tasks\/([^/]+)$/,
    async ({ p, url }) => {
      const wi = await workItemByCode(p[0]);
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
  ["POST", /^\/api\/tasks\/([^/]+)\/answers$/, async ({ p, body }) => (await workItemByCode(p[0]), answerQuestions(body.answers ?? {}))],
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/messages$/,
    async ({ p, body }) => {
      const wi = await workItemByCode(p[0]);
      const run = must(await latestRun(wi.id), "run for this task");
      await sendFeedback(run.id, String(body.message ?? "").trim() || fail("empty message"));
      return { ok: true, run_id: run.id };
    },
  ],
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/cancel$/,
    async ({ p }) => {
      const wi = await workItemByCode(p[0]);
      const active = await q<{ id: number }>(pool, "SELECT id FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED', 'CANCELED')", [wi.id]);
      for (const r of active) await cancelRun(r.id);
      return { ok: true, canceled: active.map((r) => r.id) };
    },
  ],
];

function fail(msg: string): never {
  throw new HttpError(400, msg);
}

export function errorStatus(e: unknown) {
  if (e instanceof HttpError || e instanceof EngineError) return e.status;
  const code = (e as any)?.code;
  if (code === "23505") return 409; // unique violation
  if (code === "23503" || code === "23514" || code === "22P02") return 400;
  return 400;
}
