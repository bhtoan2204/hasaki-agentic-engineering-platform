import {
  status as codeIndexStatus,
  enqueue as enqueueCodeIndex,
  cancelLocalIndexRun,
} from "../../codeIntelligence/indexer.ts";
import { hybridRank } from "../../codeIntelligence/search.ts";
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { audit, requireAdmin } from "../../authz/access.ts";
import { isSelfRepository } from "../../platform/selfDevelopment.ts";
import { repositoryRemote } from "../../repos/remote.ts";
import {
  prepareRepository,
  workspaceStatus,
  testRepositoryConnection,
} from "../../repos/workspaces.ts";
import { repositories, isAmbiguous, RepositoryInUseError } from "../../repos/service.ts";
import {
  accessAudit,
  accessMatrix,
  allowedRepositoriesForRun,
  listAccessibleRepositories,
  requireRepositoryAccess,
  revalidateBitbucket,
  setRepositoryAccess,
  setRepositoryAccessMany,
  setSharedAccess,
  accessLevelFrom,
  type EffectivePermissions,
} from "../../repos/access.ts";
import type { Route } from "./types.ts";
import { must, publicRepository } from "./shared.ts";

/**
 * A repository as one member sees it: their effective permission level and its sources, and no names of
 * repositories they cannot access (dependencies are filtered so a relationship does not disclose them).
 */
function memberRepository(
  repo: import("../../repos/service.ts").RepositoryRow,
  access: EffectivePermissions,
  visible: Set<string>,
) {
  const { shared_access: _shared, ...rest } = publicRepository(repo);
  return {
    ...rest,
    dependencies: repo.dependencies.filter((d) => visible.has(d)),
    access: {
      level: access.level,
      effective: access.effective,
      source: access.platform.source,
      bitbucket: access.bitbucket,
    },
  };
}

export const repositoriesRoutes: Route[] = [
  // ------------------------------------------------------------ repositories
  // Every member endpoint is scoped by the caller's effective permissions (repos/access.ts); an inaccessible repository
  // answers 404 like an unknown one. Admin-only endpoints manage the registry and grants; they never give the admin
  // access to source code by themselves.
  [
    "POST",
    /^\/api\/repositories\/validate-url$/,
    ({ body, actor }) => (requireAdmin(actor), repositoryRemote(body.repository_url)),
  ],
  [
    "GET",
    /^\/api\/repositories$/,
    async ({ actor, url }) => {
      if (url.searchParams.get("manage") === "1") {
        requireAdmin(actor);
        const rows = (await repositories.list()).filter((r) => r.provider !== "benchmark");
        return Promise.all(
          rows.map(async (r) => ({ ...publicRepository(r), self: await isSelfRepository(r) })),
        );
      }
      const mine = await listAccessibleRepositories(actor.id, { verify: "listing" });
      const visible = new Set(mine.map((m) => m.repository.name));
      return Promise.all(
        mine.map(async (m) => ({
          ...memberRepository(m.repository, m.access, visible),
          self: await isSelfRepository(m.repository),
        })),
      );
    },
  ],
  [
    "GET",
    /^\/api\/repositories\/index-status$/,
    async ({ actor, url }) => {
      if (!config.codeIntelligence.enabled) return { enabled: false, repositories: [] };
      const rows = await codeIndexStatus();
      if (url.searchParams.get("manage") === "1")
        return (requireAdmin(actor), { enabled: true, repositories: rows });
      const visible = new Set(
        (await listAccessibleRepositories(actor.id)).map((m) => m.repository.name),
      );
      return { enabled: true, repositories: rows.filter((r) => visible.has(r.name)) };
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/index-runs\/(\d+)\/cancel$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      await cancelLocalIndexRun(num(p[0]));
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/rank$/,
    async ({ body, actor }) => {
      // Ranking only ever sees the caller's own repositories (never another member's, never "all").
      const allowed = new Set(
        await allowedRepositoriesForRun(actor.id, String(body.project ?? ""), "read", {
          verify: true,
        }),
      );
      const ranked = await hybridRank(
        (await repositories.list()).filter((r) => allowed.has(r.name)),
        { text: String(body.text ?? ""), project: body.project },
      );
      return { ranked, ambiguous: isAmbiguous(ranked) };
    },
  ],
  // Access management (admin): matrix, grants, shared level, Bitbucket revalidation, audit.
  ["GET", /^\/api\/repository-access$/, ({ actor }) => (requireAdmin(actor), accessMatrix())],
  [
    "GET",
    /^\/api\/repository-access\/audit$/,
    ({ actor, url }) => (
      requireAdmin(actor),
      accessAudit(url.searchParams.get("repository") || undefined)
    ),
  ],
  [
    "POST",
    /^\/api\/repository-access\/revalidate$/,
    async ({ actor, body }) => {
      // A member may re-check their own Bitbucket access; an admin may re-check anyone's (or everyone's).
      const target = body.user_id == null ? actor.id : num(body.user_id);
      if (target !== actor.id || body.all) requireAdmin(actor);
      const r = await revalidateBitbucket(body.all ? {} : { userId: target });
      await audit(actor.id, "repository.access.revalidate", "repository", "", {
        user_id: body.all ? null : target,
      });
      return r;
    },
  ],
  // One user, many repositories (every repository when `repositories` is omitted): one transaction, one audit entry.
  [
    "POST",
    /^\/api\/repository-access\/bulk$/,
    async ({ body, actor }) => {
      requireAdmin(actor);
      const names =
        body.repositories == null
          ? undefined
          : Array.isArray(body.repositories)
            ? body.repositories.map(String)
            : (() => {
                throw new HttpError(400, "repositories must be a list");
              })();
      const r = await setRepositoryAccessMany(
        num(body.user_id),
        accessLevelFrom(body),
        actor.id,
        names,
      );
      await audit(actor.id, "repository.access.bulk", "repository", "", {
        user_id: r.user_id,
        after: r.level,
        repositories: r.repositories.length,
      });
      return r;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/access$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      const repo = must(await repositories.get(p[0]), "Repository");
      const userId = num(body.user_id);
      const change = await setRepositoryAccess(repo, userId, accessLevelFrom(body), actor.id);
      await audit(actor.id, "repository.access.grant", "repository", repo.name, {
        user_id: userId,
        ...change,
      });
      return change;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/shared$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      const repo = must(await repositories.get(p[0]), "Repository");
      const change = await setSharedAccess(repo, accessLevelFrom(body));
      await audit(actor.id, "repository.access.shared", "repository", repo.name, change);
      return change;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/revalidate$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      const repo = must(await repositories.get(p[0]), "Repository");
      const r = await revalidateBitbucket({ repository: repo });
      await audit(actor.id, "repository.access.revalidate", "repository", repo.name, r);
      return r;
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/reindex$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      return { enabled: config.codeIntelligence.enabled, job: await enqueueCodeIndex(p[0]) };
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/delete$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      try {
        if (!(await repositories.remove(p[0], actor.id)))
          throw new HttpError(404, "Repository not found");
      } catch (e) {
        if (e instanceof RepositoryInUseError) throw new HttpError(409, e.message);
        throw e;
      }
      await audit(actor.id, "repository.delete", "repository", p[0]);
      return { ok: true };
    },
  ],
  [
    "GET",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/workspace$/,
    async ({ p, actor }) =>
      workspaceStatus((await requireRepositoryAccess(actor.id, p[0], "read")).repository),
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)\/(test-connection|prepare|refresh)$/,
    async ({ p, actor }) => {
      // Connection tests and checkouts run with the caller's credentials, and only for a repository they may read.
      const { repository } = await requireRepositoryAccess(actor.id, p[0], "read", {
        verify: true,
      });
      if (p[1] === "test-connection") return testRepositoryConnection(repository);
      await prepareRepository(repository, p[1] === "refresh");
      // A fresh checkout is indexed next, as the caller (their account, their access).
      await enqueueCodeIndex(repository.name).catch(() => null);
      return workspaceStatus(repository);
    },
  ],
  [
    "GET",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)$/,
    async ({ p, actor, url }) => {
      if (url.searchParams.get("manage") === "1") {
        requireAdmin(actor);
        return publicRepository(must(await repositories.get(p[0]), "Repository"));
      }
      const { repository, access } = await requireRepositoryAccess(actor.id, p[0], "read", {
        verify: true,
      });
      const visible = new Set(
        (await listAccessibleRepositories(actor.id)).map((m) => m.repository.name),
      );
      return memberRepository(repository, access, visible);
    },
  ],
  [
    "POST",
    /^\/api\/repositories\/([A-Za-z0-9._-]+)$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      if (!(await repositories.get(p[0]))) {
        const remote = repositoryRemote(body.repository_url);
        if (body.provider && body.provider !== remote.provider)
          throw new HttpError(400, `Provider must match the repository URL (${remote.provider})`);
      }
      // Registration never grants access; shared access is a separate, explicit admin action.
      const { shared_access: _ignored, ...patch } = body;
      return publicRepository(must(await repositories.upsert(p[0], patch), "Repository"));
    },
  ],
];
