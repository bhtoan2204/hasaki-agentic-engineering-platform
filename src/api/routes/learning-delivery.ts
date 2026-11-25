import { positiveId as num } from "../../http/params.ts";
import { audit, requireRun } from "../../authz/access.ts";
import { setLifecyclePausedAction } from "../../git/pullRequests.ts";
import { runDelivery } from "../../workflow/prLifecycle.ts";
import { observeManual } from "../../learning/observations.ts";
import { extractLessons, learningOverview } from "../../learning/lessons.ts";
import { outcomeRecommendations } from "../../learning/providerPerformance.ts";
import { computeAutonomyMetrics, episodesFromTelemetry } from "../../eval/autonomy.ts";
import { EngineError } from "../../workflow/engine.ts";
import type { Route } from "./types.ts";
import { support } from "./shared.ts";

export const learningDeliveryRoutes: Route[] = [
  // Autonomy evaluation from canonical production records (read-only, owner-scoped; admins may see all).
  [
    "GET",
    /^\/api\/eval\/autonomy$/,
    async (c) => {
      const owner =
        c.actor.role === "admin" && c.url.searchParams.get("all") === "1" ? null : c.actor.id;
      const days = Number(c.url.searchParams.get("days") ?? 30);
      const episodes = await episodesFromTelemetry({ ownerId: owner, days });
      return {
        days,
        metrics: computeAutonomyMetrics(episodes),
        episodes: episodes.slice(-200).map(({ usage, ...e }) => ({ ...e, usage })),
      };
    },
  ],
  // Outcome learning: overview (own lessons/observations; admins may see all) and human outcome reports per run.
  [
    "GET",
    /^\/api\/learning\/overview$/,
    async (c) => {
      const owner =
        c.actor.role === "admin" && c.url.searchParams.get("all") === "1" ? null : c.actor.id;
      return {
        ...(await learningOverview(owner)),
        routing: await outcomeRecommendations({ ownerId: owner }),
      };
    },
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/observations$/,
    async (c) => {
      const runId = num(c.p[0]);
      await requireRun(c.actor, runId, false);
      const kind = String(c.body.kind);
      if (!["regression_reported", "rollback_reported", "human_feedback"].includes(kind))
        throw new EngineError(
          "kind must be regression_reported, rollback_reported or human_feedback",
          400,
        );
      const id = await observeManual({
        runId,
        kind: kind as "human_feedback",
        note: String(c.body.note ?? ""),
        by: c.actor.username,
        ref: c.body.ref,
      });
      await audit(c.actor.id, "learning.observation", "run", String(runId), {
        kind,
        observation_id: id,
      });
      const learned = await extractLessons(runId);
      return {
        observation_id: id,
        duplicate: id == null,
        learned: { stored: learned.stored, quarantined: learned.quarantined.length },
      };
    },
  ],
  // PR delivery lifecycle: per-run view (run access) and owner pause/resume (owner + repository permission).
  [
    "GET",
    /^\/api\/runs\/(\d+)\/delivery$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runDelivery(num(c.p[0]))),
  ],
  [
    "POST",
    /^\/api\/pull-requests\/(\d+)\/lifecycle$/,
    async (c) => {
      const r = await setLifecyclePausedAction(c.actor.id, num(c.p[0]), c.body.paused === true);
      await audit(
        c.actor.id,
        r.paused ? "pr.lifecycle.pause" : "pr.lifecycle.resume",
        "pull_request",
        c.p[0],
      );
      return r;
    },
  ],
];
