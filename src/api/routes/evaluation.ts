import {
  getReport,
  listReports,
  saveReport,
  setEvaluationVisibility,
  setReportVisibility,
} from "../../eval/reports.ts";
import { evaluationAnalytics } from "../../eval/analytics.ts";
import {
  createRecommendation,
  findRecommendation,
  listRecommendations,
} from "../../eval/recommendations.ts";
import { saveOptimizationPolicy, optimizationPolicies } from "../../eval/optimization.ts";
import {
  publishBuiltinSuite,
  listSuites,
  createEvaluation,
  evaluationList,
  evaluationDetail,
  cancelEvaluation,
  createComparison,
  comparisonDetail,
} from "../../eval/service.ts";
import { config } from "../../config.ts";
import { listEvalResults } from "../../eval/resultsRepository.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { requireAdmin, requireOwner } from "../../authz/access.ts";
import { summarizeEval } from "../../eval/summary.ts";
import { startPendingRun } from "../../workflow/engine.ts";
import type { Route } from "./types.ts";
import { support } from "./shared.ts";

export const evaluationRoutes: Route[] = [
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
      const row = await findRecommendation(num(c.p[0]));
      if (!row) throw new HttpError(404, "Recommendation not found");
      await requireOwner(c.actor, row.owner_id, support(c), "agent_recommendation", String(row.id));
      return row;
    },
  ],
  ["GET", /^\/api\/agent-recommendations$/, (c) => listRecommendations(c.actor.id)],
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
      const row = await evaluationDetail(num(p[0]), actor.id, { write: true });
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
    /^\/api\/evaluation-runs\/(\d+)\/visibility$/,
    ({ actor, p, body }) => setEvaluationVisibility(actor, num(p[0]), body.visibility),
  ],
  // Central evaluation reports (autonomy, performance, bench, benchmark exports): list, read, import, share.
  [
    "GET",
    /^\/api\/evaluation-reports$/,
    (c) => listReports(c.actor, { kind: c.url.searchParams.get("kind"), all: support(c) }),
  ],
  ["GET", /^\/api\/evaluation-reports\/(\d+)$/, (c) => getReport(c.actor, num(c.p[0]), support(c))],
  [
    "POST",
    /^\/api\/evaluation-reports$/,
    (c) =>
      saveReport(c.body.report, {
        ownerId: c.actor.id,
        visibility: c.body.visibility === "team" ? "team" : "private",
        source: "api",
        suite: typeof c.body.suite === "string" ? c.body.suite : undefined,
      }),
  ],
  [
    "POST",
    /^\/api\/evaluation-reports\/(\d+)\/visibility$/,
    (c) => setReportVisibility(c.actor, num(c.p[0]), c.body.visibility),
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
      const rows = await listEvalResults(actor.id, suite);
      return { rows, summary: summarizeEval(rows) };
    },
  ],
];
