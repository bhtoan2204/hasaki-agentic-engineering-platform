import { linkWorkItem } from "../../prodErrors/scan.ts";
import {
  bugHuntDetail,
  bugHuntSummaries,
  createFixTask,
  listBugHunts,
  startBugHunt,
} from "../../bugHunt/service.ts";
import {
  getWorkbench,
  rcaVersion,
  startRuntime,
  startHunt,
  startBoth,
  createFix as createIncidentFix,
} from "../../incidents/unified.ts";
import { positiveId as num } from "../../http/params.ts";
import type { Route } from "./types.ts";
import { support } from "./shared.ts";

export const incidentsRoutes: Route[] = [
  // Production Bug Hunter: hunts are runs owned by the requester (their repository permissions and provider settings).
  [
    "GET",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/bug-hunts$/,
    (c) => listBugHunts(c.p[0], c.actor, support(c)),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/bug-hunts$/,
    (c) => startBugHunt(c.p[0], c.actor, c.body),
  ],
  [
    "GET",
    /^\/api\/bug-hunts\/summary$/,
    (c) =>
      bugHuntSummaries(
        (c.url.searchParams.get("fingerprints") ?? "").split(",").filter(Boolean),
        c.actor,
      ),
  ],
  ["GET", /^\/api\/bug-hunts\/(\d+)$/, (c) => bugHuntDetail(num(c.p[0]), c.actor, support(c))],
  [
    "POST",
    /^\/api\/bug-hunts\/(\d+)\/findings\/(\d+)\/fix-task$/,
    (c) => createFixTask(num(c.p[0]), num(c.p[1]), c.actor),
  ],
  // Unified Incident Workbench: the actor's (incident, owner) workspace; admins in support mode may read another owner's.
  [
    "GET",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/workbench$/,
    (c) => {
      const owner = c.url.searchParams.get("owner");
      return getWorkbench(c.p[0], c.actor, {
        support: support(c),
        ownerId: owner ? num(owner) : undefined,
      });
    },
  ],
  [
    "GET",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/workbench\/rca\/(\d+)$/,
    (c) => {
      const owner = c.url.searchParams.get("owner");
      return rcaVersion(c.p[0], c.actor, num(c.p[1]), {
        support: support(c),
        ownerId: owner ? num(owner) : undefined,
      });
    },
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/workbench\/runtime$/,
    (c) => startRuntime(c.p[0], c.actor, c.body),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/workbench\/bug-hunt$/,
    (c) => startHunt(c.p[0], c.actor, c.body),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/workbench\/both$/,
    (c) => startBoth(c.p[0], c.actor, c.body),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/workbench\/fix$/,
    (c) => createIncidentFix(c.p[0], c.actor, c.body),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/link$/,
    ({ p, body, actor }) => linkWorkItem(p[0], String(body.work_item ?? ""), actor.id),
  ],
];
