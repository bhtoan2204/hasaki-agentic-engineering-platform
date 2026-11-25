import { resolveOutputLocale } from "../../agent/language.ts";
import { resolveAgentProvider } from "../../agent/provider.ts";
import { HttpError } from "../../http/error.ts";
import { requireOwner, wantsSupport } from "../../authz/access.ts";
import { knowledge } from "../../knowledge/service.ts";
import { knowledgeRestricted, readableRepositoryNames } from "../../knowledge/visibility.ts";
import { getProposal } from "../../knowledge/proposals.ts";
import { repositoryRemote } from "../../repos/remote.ts";
import { parseBudget } from "../../report/cost.ts";
import type { Ctx } from "./types.ts";

export const support = (c: Ctx) => wantsSupport(c.actor, c.url.searchParams.get("scope"));

export const budgetOf = (body: { budget_usd?: unknown } | null | undefined) => {
  try {
    return parseBudget(body?.budget_usd);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
};

export const mine = (c: Ctx) => ({ ownerId: c.actor.id, all: support(c) });

export const must = <T>(v: T | undefined | null, what: string): T => {
  if (v == null) throw new HttpError(404, `${what} not found`);
  return v;
};

/** Read access: own proposals, shared ones (repository import), or any with admin support access. */
export async function readableProposal(c: Ctx, id: number) {
  const p = must(await getProposal(id), "proposal");
  if (p.owner_id != null && Number(p.owner_id) !== c.actor.id)
    await requireOwner(c.actor, Number(p.owner_id), support(c), "knowledge_proposal", String(id));
  return p;
}

export async function readableKnowledge(c: Ctx, key: string) {
  const requested = c.url.searchParams.get("owner");
  if (requested) {
    const ownerId = Number(requested);
    if (!Number.isInteger(ownerId)) throw new HttpError(404, "not found");
    await requireOwner(c.actor, ownerId, support(c), "knowledge", key);
    return must(await knowledge.get(key, undefined, ownerId), "knowledge item");
  }
  return hideRestrictedKnowledge(
    c.actor.id,
    must(
      (await knowledge.get(key, undefined, c.actor.id)) ??
        (await knowledge.get(key, undefined, null)),
      "knowledge item",
    ),
  );
}

/** Knowledge derived from a repository the caller cannot read answers 404, like any unknown item. */
export async function hideRestrictedKnowledge<
  T extends {
    scope_type?: string;
    scope_ref?: string;
    versions?: Array<{ metadata?: Record<string, unknown> | null }>;
  },
>(userId: number, item: T): Promise<T> {
  if (knowledgeRestricted(item, await readableRepositoryNames(userId)))
    throw new HttpError(404, "knowledge item not found");
  return item;
}

export type IncidentGroupLinks = {
  work_item_id?: unknown;
  work_item_code?: unknown;
  work_item_title?: unknown;
  work_item_status?: unknown;
  work_item_owner_id?: unknown;
  run_id?: unknown;
  run_status?: unknown;
  pull_requests?: unknown;
};

export function localeOf(body: { output_locale?: unknown }) {
  try {
    return resolveOutputLocale(body?.output_locale);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export function providerOf(body: { agent_provider?: unknown }) {
  try {
    return resolveAgentProvider(body?.agent_provider);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Legacy rows may contain another developer's absolute layout; never return it to members. */
export function publicRepository(repo: import("../../repos/service.ts").RepositoryRow) {
  const path = /^(?:[\\/]|[A-Za-z]:|~)/.test(repo.path) ? "" : repo.path;
  let remote_slug = repo.remote_slug;
  // GitLab references keep their nested namespace ("group/sub/project").
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,20}$/.test(remote_slug)) {
    try {
      const remote = repositoryRemote(remote_slug);
      remote_slug = `${remote.workspace}/${remote.slug}`;
    } catch {
      remote_slug = "";
    }
  }
  return { ...repo, path, remote_slug };
}
