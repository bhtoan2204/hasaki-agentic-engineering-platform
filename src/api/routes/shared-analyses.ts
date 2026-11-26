import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { readSharedAnalysis, sharedForError, sharedForRepositories } from "../../sharing/read.ts";
import type { Route } from "./types.ts";
import { support } from "./shared.ts";

/** Shared results (docs/shared-results/PLAN.md, step 7): read-only; starting and force re-runs use the existing routes. */
export const sharedAnalysesRoutes: Route[] = [
  [
    "GET",
    /^\/api\/shared-analyses\/(\d+)$/,
    async (c) => {
      const v = await readSharedAnalysis(num(c.p[0], "id"), c.actor, support(c));
      if (!v) throw new HttpError(404, "shared analysis not found");
      return v;
    },
  ],
  ["GET", /^\/api\/prod-errors\/([0-9a-f]{20})\/shared$/, (c) => sharedForError(c.p[0], c.actor)],
  [
    "GET",
    /^\/api\/code-scans\/shared$/,
    async (c) => {
      const repos = (c.url.searchParams.get("repositories") ?? "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      if (repos.length > 30) throw new HttpError(400, "repositories: at most 30");
      const focus = (c.url.searchParams.get("focus") ?? "").slice(0, 500);
      return { shared: await sharedForRepositories(repos, focus, c.actor) };
    },
  ],
];
