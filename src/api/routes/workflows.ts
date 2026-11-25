import { routeWorkflow } from "../../investigation/service.ts";
import { HttpError } from "../../http/error.ts";
import { audit, requireAdmin, requireOwner } from "../../authz/access.ts";
import { definitions } from "../../workflow/definitions.ts";
import { validateSpec } from "../../workflow/graph.ts";
import { parseBody } from "../../http/validate.ts";
import { CreateWorkflowBody, PublishWorkflowBody } from "../../http/schemas.ts";
import type { Ctx, Route } from "./types.ts";
import { mine, must, support } from "./shared.ts";

async function readableWorkflow(c: Ctx, key: string) {
  const requested = c.url.searchParams.get("owner");
  if (requested) {
    const ownerId = Number(requested);
    if (!Number.isInteger(ownerId)) throw new HttpError(404, "not found");
    await requireOwner(c.actor, ownerId, support(c), "workflow", key);
    return must(await definitions.get(key, undefined, ownerId), "workflow");
  }
  return must(
    (await definitions.get(key, undefined, c.actor.id)) ??
      (await definitions.get(key, undefined, null)),
    "workflow",
  );
}

async function workflowOwner(c: Ctx, key: string): Promise<number | null> {
  const requested = c.url.searchParams.get("owner");
  const ownerId = requested ? Number(requested) : c.actor.id;
  const row =
    (await definitions.get(key, undefined, ownerId)) ??
    (requested ? undefined : await definitions.get(key, undefined, null));
  if (!row) throw new HttpError(404, "not found");
  if (row.owner_id == null) {
    requireAdmin(c.actor);
    return null;
  }
  await requireOwner(c.actor, Number(row.owner_id), support(c), "workflow", key);
  return Number(row.owner_id);
}

export const workflowRoutes: Route[] = [
  // ------------------------------------------------------------ workflow definitions
  ["GET", /^\/api\/workflows$/, (c) => definitions.list(undefined, mine(c))],
  [
    "POST",
    /^\/api\/workflows$/,
    ({ body: raw, actor }) => {
      const body = parseBody(CreateWorkflowBody, raw);
      const shared = body.shared === true;
      if (shared) requireAdmin(actor);
      return definitions.create({
        key: body.key,
        spec: body.spec,
        publish: body.publish,
        changeNote: body.change_note,
        ownerId: shared ? null : actor.id,
        isTemplate: shared && !!body.is_template,
      });
    },
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/clone$/,
    async ({ p, actor }) => {
      const src = await definitions.get(p[0], undefined, null);
      if (!src) throw new HttpError(404, "not found");
      const spec = src.versions?.[0]?.spec ?? src.draft_spec;
      if (!spec) throw new HttpError(400, "workflow has no spec to clone");
      return definitions.create({
        key: p[0],
        spec,
        publish: true,
        changeNote: `cloned by ${actor.username}`,
        ownerId: actor.id,
      });
    },
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/promote$/,
    async ({ p, actor, url }) => {
      requireAdmin(actor);
      const ownerId = Number(url.searchParams.get("owner") ?? actor.id);
      const src = await definitions.get(p[0], undefined, ownerId);
      if (!src || src.owner_id == null) throw new HttpError(404, "not found");
      if (await definitions.get(p[0], undefined, null))
        throw new HttpError(409, "a shared workflow with this key already exists");
      const spec = src.versions?.[0]?.spec ?? src.draft_spec;
      await audit(actor.id, "promote", "workflow", p[0], { from: ownerId });
      return definitions.create({
        key: p[0],
        spec,
        publish: true,
        changeNote: `promoted by ${actor.username}`,
        ownerId: null,
      });
    },
  ],
  [
    "POST",
    /^\/api\/workflows\/validate$/,
    ({ body }) => {
      try {
        return { valid: true, spec: validateSpec(body.spec) };
      } catch (e) {
        return {
          valid: false,
          errors: (e as { errors?: unknown }).errors ?? [(e as Error).message],
        };
      }
    },
  ],
  // Intent routing: which workflow fits a free-text request (suggestion only; the user still chooses).
  [
    "POST",
    /^\/api\/workflows\/route$/,
    async (c) =>
      routeWorkflow(String(c.body.text ?? ""), await definitions.list(undefined, mine(c))),
  ],
  ["GET", /^\/api\/workflows\/([a-z0-9_-]+)$/, (c) => readableWorkflow(c, c.p[0])],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/draft$/,
    async (c) => definitions.saveDraft(c.p[0], c.body.spec, await workflowOwner(c, c.p[0])),
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/publish$/,
    async (c) =>
      definitions.publish(
        c.p[0],
        parseBody(PublishWorkflowBody, c.body).change_note,
        await workflowOwner(c, c.p[0]),
      ),
  ],
  [
    "POST",
    /^\/api\/workflows\/([a-z0-9_-]+)\/archive$/,
    async (c) => (await definitions.archive(c.p[0], await workflowOwner(c, c.p[0])), { ok: true }),
  ],
];
