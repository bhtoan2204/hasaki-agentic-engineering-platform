import {
  setRunBranches,
  requestProviderHandoff,
  resumeProviderHandoff,
  providerHandoffOptions,
  setStepAgent,
  approveStep,
  cancelRun,
  pauseRun,
  previewRun,
  previewReplay,
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
  startPendingRun,
} from "../../workflow/engine.ts";
import { handoffMetrics, setRunBudget } from "../../workflow/runRepository.ts";
import { submitManualResults } from "../../integrations/splunk.ts";
import { investigationDetail, startFixFromInvestigation } from "../../investigation/service.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num, queryInteger } from "../../http/params.ts";
import { audit, requireRun, requireWorkItem } from "../../authz/access.ts";
import { runEvents } from "../../workflow/events.ts";
import { buildTrace, isTraceLevel, searchLogs } from "../../workflow/trace.ts";
import { diagnoseTrace } from "../../workflow/traceDiagnosis.ts";
import { getRunSummary } from "../../report/runSummary.ts";
import { runCost } from "../../report/cost.ts";
import {
  recordRunOutcome,
  savedRunOutcome,
  syncPullRequestStates,
} from "../../learning/outcomes.ts";
import { proposeRegressionCase } from "../../learning/patterns.ts";
import { runChanges } from "../../git/changes.ts";
import type { FeedbackMode } from "../../workflow/replan.ts";
import type { Route } from "./types.ts";
import { budgetOf, support } from "./shared.ts";

function fail(msg: string): never {
  throw new HttpError(400, msg);
}

export const runRoutes: Route[] = [
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
        autonomy: body.autonomy,
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
      runEvents.list(num(c.p[0]), queryInteger(c.url.searchParams, "after") ?? 0)
    ),
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/trace$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), buildTrace(num(c.p[0]))),
  ],
  [
    "GET",
    /^\/api\/runs\/(\d+)\/logs$/,
    async (c) => {
      await requireRun(c.actor, num(c.p[0]), support(c));
      const sp = c.url.searchParams;
      const level = sp.get("level");
      if (level && !isTraceLevel(level)) throw new HttpError(400, "invalid level");
      for (const k of ["from", "to"])
        if (sp.get(k) && Number.isNaN(Date.parse(sp.get(k)!)))
          throw new HttpError(400, `invalid ${k}`);
      return searchLogs(num(c.p[0]), {
        stepId: queryInteger(sp, "step"),
        attemptId: queryInteger(sp, "attempt"),
        provider: sp.get("provider") ?? undefined,
        event: sp.get("event") ?? undefined,
        level: level && isTraceLevel(level) ? level : undefined,
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
        afterId: queryInteger(sp, "after"),
        limit: queryInteger(sp, "limit"),
      });
    },
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/diagnose$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      { findings: diagnoseTrace(await buildTrace(num(c.p[0]))) }
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
        (await savedRunOutcome(id)) ??
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
      await setRunBudget(num(c.p[0]), budgetOf(c.body));
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
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), handoffMetrics(num(c.p[0]))),
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
    "GET",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/replay-preview$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      previewReplay(num(c.p[0]), c.p[1], c.url.searchParams.get("force") === "1")
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
        force: c.body.force === true,
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
        subject: typeof c.body.subject === "string" ? c.body.subject : undefined,
      })
    ),
  ],
];
