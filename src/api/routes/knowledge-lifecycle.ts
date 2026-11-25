import { config } from "../../config.ts";
import { instanceHealth } from "../../instances.ts";
import { runAssignment } from "../../workflow/runRepository.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { requireAdmin, requireOwner, requireRun } from "../../authz/access.ts";
import { knowledge } from "../../knowledge/service.ts";
import type { Route } from "./types.ts";
import { readableKnowledge, support } from "./shared.ts";

export const knowledgeLifecycleRoutes: Route[] = [
  // Delete for good (with the skill's supporting files). Shared items: admins only, and refused while a workflow still
  // assigns the key unless `force` — the tombstone keeps a snapshot and stops the importer re-creating it.
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/delete$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.owner_id == null) requireAdmin(c.actor);
      else await requireOwner(c.actor, Number(item.owner_id), support(c), "knowledge", c.p[0]);
      if (item.owner_id == null && c.body.force !== true) {
        const assigned = await knowledge.assignments(c.p[0]);
        if (assigned.length)
          throw new HttpError(
            409,
            `still assigned in ${assigned.map((a) => `${a.workflow}${a.step ? `/${a.step}` : ""} (${a.version})`).join(", ")} — remove it there first, or delete with force`,
          );
      }
      return knowledge.remove(c.p[0], {
        ownerId: item.owner_id ?? null,
        by: c.actor.username,
        reason: String(c.body.reason ?? ""),
      });
    },
  ],
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)\/revert$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.owner_id == null) requireAdmin(c.actor);
      else await requireOwner(c.actor, Number(item.owner_id), support(c), "knowledge", c.p[0]);
      const version = Number(c.body.version);
      if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "invalid version");
      return knowledge.revert(c.p[0], version, item.owner_id ?? null, c.actor.username);
    },
  ],
  ["GET", /^\/api\/knowledge\/([a-z0-9_.-]+)$/, (c) => readableKnowledge(c, c.p[0])],
  [
    "POST",
    /^\/api\/knowledge\/([a-z0-9_.-]+)$/,
    async (c) => {
      const item = await readableKnowledge(c, c.p[0]);
      if (item.owner_id == null) requireAdmin(c.actor);
      else await requireOwner(c.actor, Number(item.owner_id), support(c), "knowledge", c.p[0]);
      return knowledge.update(
        c.p[0],
        { ...c.body, created_by: c.actor.username },
        item.owner_id ?? null,
      );
    },
  ],

  [
    "GET",
    /^\/api\/runs\/(\d+)\/worker$/,
    async (c) => {
      const id = num(c.p[0]);
      await requireRun(c.actor, id, support(c));
      const run = await runAssignment(id);
      const health = await instanceHealth(run?.worker_instance ?? null);
      return {
        ...health,
        local: run?.worker_instance === config.instanceId,
        available: health.health === "ONLINE",
      };
    },
  ],
];
