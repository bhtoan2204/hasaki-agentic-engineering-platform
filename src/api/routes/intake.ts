import { positiveId as num } from "../../http/params.ts";
import { audit, requireAdmin } from "../../authz/access.ts";
import {
  INTAKE_MODES,
  INTAKE_SOURCES,
  listIntakeItems,
  loadIntakePolicies,
  retriageItem,
  saveIntakePolicy,
} from "../../workitems/intake.ts";
import { EngineError } from "../../workflow/engine.ts";
import type { Route } from "./types.ts";

export const intakeRoutes: Route[] = [
  // Intake: admins own the per-source policies; owners see and re-triage their own queue items (admins: all).
  [
    "GET",
    /^\/api\/intake\/policies$/,
    async (c) => (
      requireAdmin(c.actor),
      { policies: await loadIntakePolicies(), modes: INTAKE_MODES, sources: INTAKE_SOURCES }
    ),
  ],
  [
    "POST",
    /^\/api\/intake\/policies$/,
    async (c) => {
      requireAdmin(c.actor);
      const saved = await saveIntakePolicy(c.body, c.actor.username);
      await audit(c.actor.id, "intake.policy.save", "intake_policy", String(saved.id), {
        source: saved.source,
        owner_id: saved.owner_id,
        mode: saved.mode,
        paused: saved.paused,
        revision: saved.revision,
      });
      return saved;
    },
  ],
  [
    "GET",
    /^\/api\/intake\/items$/,
    async (c) =>
      listIntakeItems({
        ownerId: c.actor.id,
        all: c.actor.role === "admin" && c.url.searchParams.get("all") === "1",
        state: c.url.searchParams.get("state") || undefined,
        source: c.url.searchParams.get("source") || undefined,
      }),
  ],
  [
    "POST",
    /^\/api\/intake\/items\/(\d+)\/retriage$/,
    async (c) => {
      const ok = await retriageItem(num(c.p[0]), c.actor.role === "admin" ? null : c.actor.id);
      if (!ok) throw new EngineError("item not found, not yours, or not waiting", 404);
      await audit(c.actor.id, "intake.retriage", "intake_item", c.p[0]);
      return { ok };
    },
  ],
];
