import { HttpError } from "../http/error.ts";
import { buildRouteIndex } from "./routeIndex.ts";
import type { Ctx, Route } from "./routes/types.ts";
import { metaRoutes } from "./routes/meta.ts";
import { workItemRoutes } from "./routes/work-items.ts";
import { workflowRoutes } from "./routes/workflows.ts";
import { metricsRoutes } from "./routes/metrics.ts";
import { memoryRoutingRoutes } from "./routes/memory-routing.ts";
import { impactRadarRoutes } from "./routes/impact-radar.ts";
import { codeFindingsRoutes } from "./routes/code-findings.ts";
import { sharedAnalysesRoutes } from "./routes/shared-analyses.ts";
import { runRoutes } from "./routes/runs.ts";
import { learningDeliveryRoutes } from "./routes/learning-delivery.ts";
import { intakeRoutes } from "./routes/intake.ts";
import { diagnosticsRoutes } from "./routes/diagnostics.ts";
import { runControlsRoutes } from "./routes/run-controls.ts";
import { questionsRoutes } from "./routes/questions.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { evaluationRoutes } from "./routes/evaluation.ts";
import { knowledgeLifecycleRoutes } from "./routes/knowledge-lifecycle.ts";
import { repositoriesRoutes } from "./routes/repositories.ts";
import { hasakiWorkRoutes } from "./routes/hasaki-work.ts";
import { observabilityRoutes } from "./routes/observability.ts";
import { incidentsRoutes } from "./routes/incidents.ts";
import { integrationsRoutes } from "./routes/integrations.ts";
import { adminRoutes } from "./routes/admin.ts";
import { chatRoutes } from "./routes/chat.ts";

export { HttpError };
export type { Ctx, Route };

/** Match order is the order of this list: the first route whose method and pattern match handles the request. */
export const routes: Route[] = [
  ...metaRoutes,
  ...workItemRoutes,
  ...workflowRoutes,
  ...metricsRoutes,
  ...memoryRoutingRoutes,
  ...impactRadarRoutes,
  ...sharedAnalysesRoutes,
  ...codeFindingsRoutes,
  ...runRoutes,
  ...learningDeliveryRoutes,
  ...intakeRoutes,
  ...diagnosticsRoutes,
  ...runControlsRoutes,
  ...questionsRoutes,
  ...knowledgeRoutes,
  ...evaluationRoutes,
  ...knowledgeLifecycleRoutes,
  ...repositoriesRoutes,
  ...hasakiWorkRoutes,
  ...observabilityRoutes,
  ...incidentsRoutes,
  ...integrationsRoutes,
  ...adminRoutes,
  ...chatRoutes,
];

const candidates = buildRouteIndex(routes);

/** The routes worth trying for this request, in match order (same winner as scanning `routes` in full). */
export const routesFor = (method: string, pathname: string): Route[] =>
  candidates(method, pathname);
