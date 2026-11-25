import { config } from "../../config.ts";
import { workItemRepository } from "../../workitems/repository.ts";
import { importHasakiTask, pickTask } from "../../work.ts";
import { groupsForWorkItem } from "../../prodErrors/scan.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { audit, requireOwner, requireWorkItem } from "../../authz/access.ts";
import { startRun } from "../../workflow/engine.ts";
import { workItems } from "../../workitems/service.ts";
import { withCosts, workItemCost } from "../../report/cost.ts";
import type { Ctx, Route } from "./types.ts";
import { budgetOf, localeOf, mine, must, providerOf, support } from "./shared.ts";

async function workItemWithAttachments(c: Ctx, id: number) {
  const w = await workItems.detail(id, (item) =>
    requireOwner(c.actor, item.owner_id, support(c), "work_item", String(id)),
  );
  if (!w) throw new HttpError(404, "not found");
  const files =
    w.payload && typeof w.payload === "object" && "note_files" in w.payload
      ? w.payload.note_files
      : undefined;
  const base = config.fileBaseUrl.replace(/\/$/, "");
  const attachments =
    base && Array.isArray(files)
      ? files
          .filter((f): f is string => typeof f === "string" && !!f)
          .map((f) => ({ name: f.split("/").pop()!, url: `${base}/${f.replace(/^\//, "")}` }))
      : [];
  return { ...w, attachments };
}

export const workItemRoutes: Route[] = [
  // ------------------------------------------------------------ work items
  [
    "GET",
    /^\/api\/work-items$/,
    async (c) => {
      if (support(c)) await audit(c.actor.id, "support.list", "work_item", "*");
      return withCosts(
        await workItems.list({
          source: c.url.searchParams.get("source") ?? undefined,
          status: c.url.searchParams.get("status") ?? undefined,
          ...mine(c),
        }),
        "work_item",
      );
    },
  ],
  [
    "POST",
    /^\/api\/work-items$/,
    ({ body, actor }) =>
      workItems.createManual({
        title: body.title,
        description: body.description,
        project: body.project,
        code: body.code,
        ownerId: actor.id,
      }),
  ],
  [
    "POST",
    /^\/api\/work-items\/import$/,
    async ({ body, actor }) => {
      if (body.source === "hasaki_work")
        return body.work_id
          ? pickTask(Number(body.work_id), null, actor.id)
          : importHasakiTask(body.payload, null, actor.id);
      throw new HttpError(400, "source must be hasaki_work");
    },
  ],
  [
    "GET",
    /^\/api\/work-items\/(\d+)$/,
    async (c) => {
      const id = num(c.p[0]);
      const item = await workItemWithAttachments(c, id);
      return { ...item, prod_errors: await groupsForWorkItem(id) };
    },
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      must(await workItems.update(num(c.p[0]), c.body), "work item")
    ),
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/runs$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      startRun({
        definitionKey: String(c.body.workflow ?? ""),
        version: c.body.version,
        workItemId: num(c.p[0]),
        inputs: c.body.inputs,
        repositories: c.body.repositories,
        title: c.body.title,
        start: c.body.start,
        profile: c.body.profile,
        outputLocale: localeOf(c.body),
        agentProvider: providerOf(c.body),
        ownerId: c.actor.id,
        autonomy: c.body.autonomy,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/(?:bug-)?followups$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      workItems.followUp({
        kind: c.body.kind ?? "bug",
        parentId: num(c.p[0]),
        title: c.body.title,
        description: String(c.body.description ?? ""),
        version: c.body.version,
        start: c.body.start,
        profile: c.body.profile,
        outputLocale: localeOf(c.body),
        agentProvider: providerOf(c.body),
        ownerId: c.actor.id,
        autonomy: c.body.autonomy,
      })
    ),
  ],
  [
    "GET",
    /^\/api\/work-items\/(\d+)\/cost$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      must(await workItemCost(num(c.p[0])), "work item")
    ),
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/budget$/,
    async (c) => {
      await requireWorkItem(c.actor, num(c.p[0]), support(c));
      await workItemRepository.setBudget(num(c.p[0]), budgetOf(c.body));
      return must(await workItemCost(num(c.p[0])), "work item");
    },
  ],
  [
    "POST",
    /^\/api\/work-items\/(\d+)\/analyze$/,
    async (c) => (
      await requireWorkItem(c.actor, num(c.p[0]), support(c)),
      startRun({
        definitionKey: "work-item-analysis",
        workItemId: num(c.p[0]),
        outputLocale: localeOf(c.body),
        agentProvider: providerOf(c.body),
        ownerId: c.actor.id,
      })
    ),
  ],
];
