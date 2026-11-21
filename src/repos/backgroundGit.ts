import { one, pool, q } from "../db/pool.ts";
import { audit } from "../authz/access.ts";
import { deleteUserSecret, putUserSecret } from "../auth/secrets.ts";
import { listAccessibleRepositories, resolveEffectiveRepositoryPermissions } from "./access.ts";
import { workspaceStatus } from "./workspaces.ts";
import { config } from "../config.ts";
import { repositoryRemote } from "./remote.ts";
import type { RepositoryRow } from "./service.ts";

/**
 * Background Git access by consent. Work nobody asked for in person (startup and idle indexing, search-triggered
 * refreshes) has no user, so it has no Git credentials: a personal token is never borrowed silently. A user may opt in
 * on the Integrations page ("background sync"): such work then runs as that user, with that user's own saved token, only
 * for repositories that user can read right now. The consent is per user and stored with the user's secrets (no
 * environment variable, no shared token); revoking it, losing read access or removing the token stops the next job.
 */
const CONSENT = "git_background_sync";

/** The user_secrets kind holding the token a repository's host needs. */
function tokenKinds(repo: Pick<RepositoryRow, "provider" | "repository_url">): string[] {
  if (!repo.repository_url) return [];
  const remote = repositoryRemote(repo.repository_url);
  if (remote.provider === "bitbucket") return ["bitbucket_user", "bitbucket_token"];
  if (remote.provider === "github") return ["github_token"];
  return [`gitlab_token:${remote.host}`];
}

export async function backgroundGitStatus(userId: number) {
  const rows = await q<{ kind: string }>(
    pool,
    "SELECT kind FROM user_secrets WHERE user_id = $1 AND (kind = $2 OR kind ~ '^(bitbucket_token|github_token|gitlab_token)')",
    [userId, CONSENT],
  );
  const kinds = rows.map((r) => r.kind);
  return {
    enabled: kinds.includes(CONSENT),
    hosts: [
      ...(kinds.includes("bitbucket_token") ? ["bitbucket.org"] : []),
      ...(kinds.includes("github_token") ? ["github.com"] : []),
      ...kinds
        .filter((k) => k.startsWith("gitlab_token:"))
        .map((k) => k.slice("gitlab_token:".length)),
    ],
  };
}

export async function setBackgroundGit(userId: number, enabled: boolean) {
  if (enabled) await putUserSecret(userId, CONSENT, "1");
  else await deleteUserSecret(userId, CONSENT);
  await audit(
    userId,
    enabled ? "git.background.enable" : "git.background.disable",
    "user",
    String(userId),
  );
  return backgroundGitStatus(userId);
}

/** Has this user consented, still active, with a token for the repository's host and read access to it now? */
export async function canSyncFor(userId: number, repo: RepositoryRow) {
  const kinds = tokenKinds(repo);
  if (!kinds.length) return false;
  const ok = await one<{ ok: boolean }>(
    pool,
    `SELECT (u.active AND (SELECT count(DISTINCT kind) FROM user_secrets s
                            WHERE s.user_id = u.id AND s.kind = ANY($2::text[])) = $3) AS ok
       FROM users u
      WHERE u.id = $1 AND EXISTS (SELECT 1 FROM user_secrets c WHERE c.user_id = u.id AND c.kind = $4)`,
    [userId, kinds, kinds.length, CONSENT],
  );
  if (!ok?.ok) return false;
  return !!(await resolveEffectiveRepositoryPermissions(userId, repo.name))?.effective.read;
}

/** A consenting user who may sync this repository now (lowest id first, so the choice is stable), or null. */
export async function backgroundDelegate(repo: RepositoryRow): Promise<number | null> {
  const candidates = await q<{ user_id: number }>(
    pool,
    "SELECT user_id FROM user_secrets WHERE kind = $1 ORDER BY user_id",
    [CONSENT],
  );
  for (const c of candidates)
    if (await canSyncFor(Number(c.user_id), repo)) return Number(c.user_id);
  return null;
}

/** Readable repositories with their platform-workspace checkout state and latest index on this instance. */
export async function workspaceRepositories(userId: number) {
  const repos = (await listAccessibleRepositories(userId)).map((r) => r.repository);
  const runs = await q<{
    repository_id: number;
    status: string;
    error: string | null;
    updated_at: string;
    delegated: boolean;
    requested_by: string | null;
  }>(
    pool,
    `SELECT DISTINCT ON (r.repository_id) r.repository_id, r.status, r.error, r.updated_at, r.delegated, u.username AS requested_by
       FROM code_intelligence.runs r LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.instance_id = $1 AND r.scope_key = 'base' ORDER BY r.repository_id, r.id DESC`,
    [config.instanceId],
  );
  const byRepo = new Map(runs.map((r) => [Number(r.repository_id), r]));
  return {
    instance_id: config.instanceId,
    background: await backgroundGitStatus(userId),
    repositories: await Promise.all(
      repos.map(async (r) => ({
        name: r.name,
        provider: r.provider,
        remote: !!r.repository_url,
        workspace: (await workspaceStatus(r)).status,
        index: byRepo.get(Number(r.id)) ?? null,
      })),
    ),
  };
}
