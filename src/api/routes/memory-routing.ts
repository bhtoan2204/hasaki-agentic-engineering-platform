import {
  causalHistory,
  recallCausal,
  rollbackCausal,
  setCausalStatus,
} from "../../memory/causal.ts";
import {
  eligibility,
  loadOutcomes,
  replayEvaluation,
  routingPreference,
  saveRoutingPreference,
} from "../../routing/adaptive.ts";
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { requireAdmin } from "../../authz/access.ts";
import type { Route } from "./types.ts";

export const memoryRoutingRoutes: Route[] = [
  // Causal engineering memory (src/memory/causal.ts): the caller's own records only.
  [
    "GET",
    /^\/api\/causal-memory$/,
    (c) =>
      recallCausal(c.actor.id, {
        text: c.url.searchParams.get("q") ?? undefined,
        repositories: c.url.searchParams.getAll("repository"),
        files: c.url.searchParams.getAll("file"),
        errorSignatures: c.url.searchParams.getAll("signature"),
        services: c.url.searchParams.getAll("service"),
        includeOutdated: c.url.searchParams.get("outdated") === "1",
        limit: Number(c.url.searchParams.get("limit") ?? 5),
      }),
  ],
  ["GET", /^\/api\/causal-memory\/(\d+)$/, (c) => causalHistory(c.actor.id, num(c.p[0]))],
  [
    "POST",
    /^\/api\/causal-memory\/(\d+)\/status$/,
    (c) =>
      setCausalStatus(
        c.actor.id,
        num(c.p[0]),
        String(c.body.status ?? "") as "verified",
        String(c.body.reason ?? ""),
      ),
  ],
  [
    "POST",
    /^\/api\/causal-memory\/(\d+)\/rollback$/,
    (c) => rollbackCausal(c.actor.id, num(c.p[0]), Number(c.body.version)),
  ],
  // Evaluation-driven routing (src/routing): the owner's opt-in preference; replay evaluation for administrators.
  [
    "GET",
    /^\/api\/routing\/preference$/,
    async (c) =>
      (await routingPreference(c.actor.id)) ?? {
        enabled: false,
        preference: "balanced",
        min_samples: 10,
      },
  ],
  ["POST", /^\/api\/routing\/preference$/, (c) => saveRoutingPreference(c.actor.id, c.body)],
  [
    "GET",
    /^\/api\/routing\/evaluation$/,
    async (c) => {
      requireAdmin(c.actor);
      const days = Math.min(90, Math.max(1, Number(c.url.searchParams.get("test_days") ?? 14)));
      const preference = String(c.url.searchParams.get("preference") ?? "balanced");
      if (!["quality_first", "balanced", "cost_first"].includes(preference))
        throw new HttpError(400, "invalid preference");
      const samples = await loadOutcomes({});
      const { eligible } = eligibility({
        stepType: "agent",
        complexity: null,
        isolation: {
          enforce: config.isolation.mode === "enforce",
          runtimeAvailable: config.isolation.mode === "enforce",
        },
      });
      return replayEvaluation({
        samples,
        cutoff: new Date(Date.now() - days * 86_400_000),
        defaults: await import("../../agent/configurationStore.ts").then(async (m) => {
          const d = (await m.loadAgentConfiguration()).default_provider;
          return { agent: d, coding_agent: d };
        }),
        eligible,
        preference: preference as "balanced",
        minSamples: Math.max(3, Number(c.url.searchParams.get("min_samples") ?? 10)),
      });
    },
  ],
];
