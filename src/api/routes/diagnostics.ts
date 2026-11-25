import { analyticsEngineStats } from "../analytics/engine.ts";
import { config } from "../../config.ts";
import { audit, requireAdmin } from "../../authz/access.ts";
import { isolationDiagnostics } from "../../agent/isolation.ts";
import { agentSessionStorageDiagnostics } from "../../agent/sessionDiagnostics.ts";
import { retrievalService, semanticFallbacks } from "../../retrieval/semantic.ts";
import { EngineError } from "../../workflow/engine.ts";
import type { Route } from "./types.ts";

export const diagnosticsRoutes: Route[] = [
  // Agent OS isolation: runtime probe and effective provider guarantees (admin diagnostics, no secrets or paths of runs).
  [
    "GET",
    /^\/api\/admin\/isolation$/,
    async (c) => (
      requireAdmin(c.actor),
      isolationDiagnostics(c.url.searchParams.get("refresh") === "1")
    ),
  ],
  // Agent session storage: disk usage, file age distribution and provider breakdown (read-only admin diagnostics, no contents or credentials).
  [
    "GET",
    /^\/api\/admin\/agent-session-storage$/,
    async (c) => (requireAdmin(c.actor), agentSessionStorageDiagnostics()),
  ],
  // Semantic retrieval (ADR 0001): fallback counters and the Go service status; reindex is proxied to the service.
  [
    "GET",
    /^\/api\/admin\/retrieval\/status$/,
    async (c) => {
      requireAdmin(c.actor);
      const res = config.retrieval.internalToken
        ? await retrievalService("/internal/v1/retrieval/status", undefined, 5000).catch(() => null)
        : null;
      return {
        enabled: config.retrieval.semantic.enabled,
        reachable: !!res?.ok,
        fallbacks: { ...semanticFallbacks },
        service: res?.ok ? await res.json().catch(() => null) : null,
      };
    },
  ],
  // Analytics (ADR 0003, platform-go): requests served, failures by reason, and platform-go's analytics pool.
  [
    "GET",
    /^\/api\/admin\/analytics\/engine$/,
    async (c) => {
      requireAdmin(c.actor);
      const res = config.retrieval.internalToken
        ? await retrievalService("/internal/v1/analytics/stats", undefined, 5000).catch(() => null)
        : null;
      return {
        engine: "go",
        served: analyticsEngineStats.go,
        failures: { ...analyticsEngineStats.failures },
        service: res?.ok ? await res.json().catch(() => null) : null,
      };
    },
  ],
  [
    "POST",
    /^\/api\/admin\/retrieval\/reindex$/,
    async (c) => {
      requireAdmin(c.actor);
      const ids = c.body.source_ids;
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length > 5000 ||
          !ids.every((id) => Number.isInteger(id) && id > 0))
      )
        throw new EngineError("source_ids must be at most 5000 positive integers", 400);
      if (!config.retrieval.internalToken)
        throw new EngineError("RETRIEVAL_INTERNAL_TOKEN is not set", 409);
      const res = await retrievalService(
        "/internal/v1/retrieval/reindex",
        { ...(ids ? { source_ids: ids } : {}), ...(c.body.all === true ? { all: true } : {}) },
        5000,
      ).catch(() => null);
      if (!res?.ok) throw new EngineError("retrieval service unavailable", 502);
      const out = await res.json();
      await audit(c.actor.id, "retrieval.reindex", "retrieval", "semantic", {
        all: c.body.all === true,
        source_ids: ids?.length ?? 0,
        enqueued: out?.enqueued,
      });
      return out;
    },
  ],
];
