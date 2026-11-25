import { attemptContext } from "../../context/repository.ts";
import { engineeringAnalytics } from "../analytics/index.ts";
import { updateIncidentLifecycle } from "../analytics/incidents.ts";
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { requireAttempt } from "../../authz/access.ts";
import { CATEGORIES, SCOPES } from "../../knowledge/resolve.ts";
import { RUN_STATUSES, STEP_STATUSES, STEP_TYPES } from "../../workflow/types.ts";
import type { Route } from "./types.ts";
import { support } from "./shared.ts";

export const metaRoutes: Route[] = [
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
    (c) => engineeringAnalytics(c.actor, c.url, c.p[0], c.signal),
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
    }),
  ],
];
