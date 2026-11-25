import { agentProviderStatus } from "../../agent/providerStatus.ts";
import { positiveId as num } from "../../http/params.ts";
import { audit, requireAdmin, requireRun } from "../../authz/access.ts";
import { StaleWhileRevalidate, cacheSnapshot, singleflightInflight } from "../../cache/index.ts";
import { schedulerStatus } from "../../workflow/scheduler.ts";
import { runtimeMetricsSnapshot } from "../../runtimeMetrics.ts";
import { metricsSummary, poolGauges, runMetrics } from "../metrics.ts";
import { dependencyMetrics } from "../../git/nodeDependencies.ts";
import type { Route } from "./types.ts";
import { mine, support } from "./shared.ts";

const metricsSwr = new StaleWhileRevalidate<Awaited<ReturnType<typeof metricsSummary>>>(
  "metrics.summary",
  30_000,
  600_000,
);

export const metricsRoutes: Route[] = [
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
        pool: poolGauges(),
      };
    },
  ],
  // Runtime latency metrics (fixed names, no run/user/repository values): SQL, transactions, pool waits, queue wait,
  // provider-health reuse, replay decisions, checkpoint bytes, response sizes, event loop. Admin only.
  [
    "GET",
    /^\/api\/metrics\/runtime$/,
    (c) => {
      requireAdmin(c.actor);
      return runtimeMetricsSnapshot();
    },
  ],
  // Dependency readiness: validation/install timings, cache hit rate, full vs incremental, I/O and event loop lag. Admin only.
  [
    "GET",
    /^\/api\/metrics\/dependencies$/,
    (c) => {
      requireAdmin(c.actor);
      return dependencyMetrics();
    },
  ],
  [
    "GET",
    /^\/api\/metrics\/runs\/(\d+)$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), runMetrics(num(c.p[0]))),
  ],
];
