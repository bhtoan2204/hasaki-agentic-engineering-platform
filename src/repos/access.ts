/**
 * User-scoped repository authorization (migration 045). Deny by default.
 *
 * Effective permission of a user on a repository = intersection of
 *   1. platform grant   user_repository_access row, or the repository's explicit shared_access level;
 *   2. Bitbucket        the user's own permission, checked with the user's own credentials (never the shared service
 *                       account), cached in repository_bitbucket_permissions with a bounded TTL. Not applicable to
 *                       repositories without a Bitbucket remote (local checkouts, benchmark fixtures). Policy:
 *                       config.bitbucket.accessVerification ("strict" | "personal" | "trusted");
 *   3. repository       enabled and allowed_actions.
 * Levels are cumulative: read ⊂ write ⊂ pull_request.
 *
 * An admin role manages the registry and grants; it is not a grant. Admins receive access like any other user.
 *
 * Freshness: entry points that start work (run creation, step start, workspace preparation, push, PR, the
 * repository list) refresh expired Bitbucket checks; hot paths (each agent tool call) use the last known result, so
 * a check expiring mid-step does not stop an agent, while a platform revocation or a "denied" result does.
 */
import { config } from "../config.ts";
import { HttpError } from "../http/error.ts";
import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { CacheAside, singleflight } from "../cache/index.ts";
import { getUserSecret } from "../auth/secrets.ts";
import { repositories, projectScope, type RepositoryRow } from "./service.ts";
import { reposRepository, type GrantRow, type CheckRow } from "./repository.ts";
import { repositoryRemote, type CanonicalRemote } from "./remote.ts";
import { githubRepositoryAccess } from "../github.ts";
import { gitlabRepositoryAccess, gitlabSecretKey } from "../gitlab.ts";
import { gitHost, isGitHost } from "../git/hosts.ts";

export type RepoAction = "read" | "write" | "pull_request";
export type AccessLevel = "none" | RepoAction;
export const ACCESS_LEVELS: AccessLevel[] = ["none", "read", "write", "pull_request"];
const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, pull_request: 3 };
const allows = (level: AccessLevel, action: RepoAction) => RANK[level] >= RANK[action];

type Flags = { read: boolean; write: boolean; pull_request: boolean };
const flags = (level: AccessLevel): Flags => ({
  read: allows(level, "read"),
  write: allows(level, "write"),
  pull_request: allows(level, "pull_request"),
});
const levelOf = (f: Flags): AccessLevel =>
  f.pull_request ? "pull_request" : f.write ? "write" : f.read ? "read" : "none";

export type BitbucketState = "verified" | "denied" | "unknown" | "not_applicable" | "trusted";

export interface EffectivePermissions {
  repository: string;
  repository_id: number;
  /** Platform grant (or shared level) before the other two sources are applied. */
  platform: Flags & { level: AccessLevel; source: "grant" | "shared" | "benchmark" | null };
  bitbucket: {
    state: BitbucketState;
    read: boolean | null;
    write: boolean | null;
    reason: string;
    checked_at: string | null;
    stale: boolean;
  };
  repository_actions: Flags;
  effective: Flags;
  level: AccessLevel;
}

/** No read access: callers answer 404 so the repository's existence is not revealed. Read but not `action`: 403. */
export class RepositoryAccessError extends HttpError {
  constructor(status: 403 | 404, message: string) {
    super(status, message);
  }
}

/** Per-user grants and Bitbucket checks; cleared by any committed write to these tables (in every process). */
const userCache = new CacheAside<{ grants: GrantRow[]; checks: CheckRow[] }>(
  "repository_access",
  ["user_repository_access", "repository_bitbucket_permissions", "repositories"],
  60_000,
  200,
);
function loadUser(userId: number, db: Db, repo = reposRepository) {
  const load = () => repo.getUserGrantsAndChecks(userId, db);
  return db === pool ? userCache.get(String(userId), load) : load();
}

const ttlSeconds = () => Math.max(30, Number(config.bitbucket.permissionTtlSeconds ?? 900));
/** Hosted remotes whose permissions are checked with the user's own token. Local and benchmark rows are not. */
const onHosted = (r: RepositoryRow) => !!r.repository_url && isGitHost(r.provider);
const hostPolicy = (r: RepositoryRow) =>
  isGitHost(r.provider)
    ? gitHost(r.provider).policy()
    : (config.bitbucket.accessVerification ?? "strict");

function compute(
  userId: number,
  r: RepositoryRow,
  grants: Map<number, GrantRow>,
  checks: Map<number, CheckRow>,
  project?: string,
): EffectivePermissions {
  const id = Number(r.id);
  // 1. platform
  let platform: EffectivePermissions["platform"];
  if (r.provider === "benchmark") {
    // Synthetic evaluation fixtures (no private source): usable only by runs of their own __benchmark project.
    const ok = !!project && project.startsWith("__benchmark:") && r.projects.includes(project);
    platform = {
      ...flags(ok ? "pull_request" : "none"),
      level: ok ? "pull_request" : "none",
      source: ok ? "benchmark" : null,
    };
  } else {
    const g = grants.get(id);
    const granted: AccessLevel = g
      ? levelOf({ read: g.can_read, write: g.can_write, pull_request: g.can_create_pr })
      : "none";
    const shared: AccessLevel = r.shared_access ?? "none";
    const level = RANK[granted] >= RANK[shared] ? granted : shared;
    platform = {
      ...flags(level),
      level,
      source: level === "none" ? null : RANK[granted] >= RANK[shared] ? "grant" : "shared",
    };
  }
  // 2. Bitbucket
  let bitbucket: EffectivePermissions["bitbucket"];
  if (!onHosted(r))
    bitbucket = {
      state: "not_applicable",
      read: true,
      write: true,
      reason: "no hosted Git remote registered",
      checked_at: null,
      stale: false,
    };
  else if (hostPolicy(r) === "trusted")
    bitbucket = {
      state: "trusted",
      read: true,
      write: true,
      reason: "platform grants trusted by configuration",
      checked_at: null,
      stale: false,
    };
  else {
    const c = checks.get(id);
    if (!c)
      bitbucket = {
        state: "unknown",
        read: null,
        write: null,
        reason: "not verified yet",
        checked_at: null,
        stale: true,
      };
    else
      bitbucket = {
        state: c.state,
        read: c.can_read,
        write: c.can_write,
        reason: c.reason,
        checked_at: new Date(c.checked_at).toISOString(),
        stale: new Date(c.expires_at).getTime() <= Date.now(),
      };
  }
  const bbRead =
    bitbucket.state === "not_applicable" ||
    bitbucket.state === "trusted" ||
    (bitbucket.state === "verified" && bitbucket.read === true);
  const bbWrite =
    bitbucket.state === "not_applicable" ||
    bitbucket.state === "trusted" ||
    (bitbucket.state === "verified" &&
      (bitbucket.write === true || (bitbucket.write == null && hostPolicy(r) === "personal")));
  // 3. repository
  const repository_actions = {
    read: r.enabled && r.allowed_actions.includes("read"),
    write: r.enabled && r.allowed_actions.includes("write"),
    pull_request: r.enabled && r.allowed_actions.includes("pull_request"),
  };
  const read = platform.read && bbRead && repository_actions.read;
  const write = read && platform.write && bbWrite && repository_actions.write;
  const pull_request = write && platform.pull_request && repository_actions.pull_request;
  const effective = { read, write, pull_request };
  void userId;
  return {
    repository: r.name,
    repository_id: id,
    platform,
    bitbucket,
    repository_actions,
    effective,
    level: levelOf(effective),
  };
}

export interface ResolveOptions {
  db?: Db;
  /**
   * true: refresh missing/expired host checks first (entry points that start work). "listing": wait only for
   * repositories never checked; expired ones keep their last result now and are refreshed in the background.
   * Default false (last known result).
   */
  verify?: boolean | "listing";
  /** Run project (only to admit __benchmark fixtures). */
  project?: string;
}

/** Effective permissions of `userId` on every registered repository, by name. */
export async function effectivePermissions(
  userId: number,
  opts: ResolveOptions = {},
): Promise<Map<string, EffectivePermissions>> {
  const db = opts.db ?? pool;
  const all = await repositories.list(db);
  if (opts.verify === "listing") await refreshForListing(userId, all);
  else if (opts.verify) await refreshBitbucket(userId, all, false);
  const { grants, checks } = await loadUser(userId, db);
  const g = new Map(grants.map((x) => [x.repository_id, x]));
  const c = new Map(checks.map((x) => [x.repository_id, x]));
  return new Map(all.map((r) => [r.name, compute(userId, r, g, c, opts.project)]));
}

export async function resolveEffectiveRepositoryPermissions(
  userId: number,
  repo: string | number,
  opts: ResolveOptions = {},
): Promise<EffectivePermissions | null> {
  const all = await repositories.list(opts.db ?? pool);
  const row = all.find((r) => (typeof repo === "number" ? Number(r.id) === repo : r.name === repo));
  if (!row) return null;
  if (opts.verify) await refreshBitbucket(userId, [row], false);
  const { grants, checks } = await loadUser(userId, opts.db ?? pool);
  return compute(
    userId,
    row,
    new Map(grants.map((x) => [x.repository_id, x])),
    new Map(checks.map((x) => [x.repository_id, x])),
    opts.project,
  );
}

/** Repositories the user may read (never benchmark fixtures), with their effective permissions. */
export async function listAccessibleRepositories(
  userId: number,
  opts: ResolveOptions = {},
): Promise<Array<{ repository: RepositoryRow; access: EffectivePermissions }>> {
  const all = await repositories.list(opts.db ?? pool);
  const perms = await effectivePermissions(userId, opts);
  return all
    .filter((r) => r.provider !== "benchmark" && perms.get(r.name)!.effective.read)
    .map((r) => ({ repository: r, access: perms.get(r.name)! }));
}

/** The repository row if `userId` may perform `action`; 404 without read (existence hidden), 403 otherwise. */
export async function requireRepositoryAccess(
  userId: number,
  repo: string | number,
  action: RepoAction = "read",
  opts: ResolveOptions = {},
) {
  const access = await resolveEffectiveRepositoryPermissions(userId, repo, opts);
  if (!access || !access.effective.read)
    throw new RepositoryAccessError(404, "Repository not found");
  if (!access.effective[action])
    throw new RepositoryAccessError(
      403,
      `Repository ${action.replace("_", " ")} permission required`,
    );
  return { repository: (await repositories.get(access.repository, opts.db ?? pool))!, access };
}

/**
 * Repositories a run owned by `userId` may use for `action`. A project mapped to repositories narrows the user's
 * set to those; a project without mappings (or no project) leaves the user's own set. Project mappings never add a
 * repository the user cannot access, and nothing widens to "every repository".
 */
export async function allowedRepositoriesForRun(
  userId: number,
  project: string,
  action: RepoAction = "read",
  opts: Omit<ResolveOptions, "project"> = {},
): Promise<string[]> {
  const db = opts.db ?? pool;
  const all = await repositories.list(db);
  const perms = await effectivePermissions(userId, { ...opts, project });
  const usable = all.filter((r) => perms.get(r.name)!.effective[action]);
  const scope = new Set(projectScope(project));
  const maps = (r: RepositoryRow) => r.projects.some((x) => scope.has(x.toLowerCase()));
  if (project.trim() && all.some(maps)) return usable.filter(maps).map((r) => r.name);
  return usable.filter((r) => r.provider !== "benchmark").map((r) => r.name);
}

// ------------------------------------------------------------------ runs

type RunScope = {
  id: number;
  owner_id?: number | null;
  allowed_repositories: string[];
  selected_repositories: string[];
  inputs?: Record<string, any> | null;
};
const runProject = (run: RunScope) => String(run.inputs?.project ?? "");

/**
 * Step start (also on retry, resume and re-execution).
 *  - Before any repository is selected, the scope follows the owner's CURRENT access for the run's project, exactly as
 *    computed at run creation: a grant given after the run was created is picked up by retrying the step, a
 *    revocation narrows it. Nothing has been read from a repository yet, so nothing is widened behind a selection.
 *  - Once repositories are selected the scope only narrows: repositories the owner can no longer read leave it, and a
 *    revoked selected repository is reported in `blocked`; the caller stops the step without retrying.
 * Changes are persisted with a timeline note, and the run object is updated in place (`changed`).
 */
export async function enforceRunRepositoryAccess(
  run: RunScope,
  db: Db = pool,
): Promise<{ revoked: string[]; blocked: string[]; added: string[]; changed: boolean }> {
  if (run.owner_id == null)
    return {
      revoked: [...run.allowed_repositories],
      blocked: [...run.selected_repositories],
      added: [],
      changed: false,
    };
  const project = await runProjectOf(run, db);
  const { runEvents } = await import("../workflow/events.ts");
  if (!run.selected_repositories.length) {
    const current = await allowedRepositoriesForRun(Number(run.owner_id), project, "read", {
      db,
      verify: true,
    });
    const revoked = run.allowed_repositories.filter((r) => !current.includes(r));
    const added = current.filter((r) => !run.allowed_repositories.includes(r));
    if (!revoked.length && !added.length) return { revoked, blocked: [], added, changed: false };
    await q(
      db,
      "UPDATE workflow_runs SET allowed_repositories = $2, updated_at = now() WHERE id = $1",
      [run.id, current],
    );
    run.allowed_repositories = current;
    await runEvents.add(
      db,
      run.id,
      "system",
      `repository scope refreshed from the run owner's current access (no repository selected yet)${added.length ? `; added: ${added.join(", ")}` : ""}${revoked.length ? `; removed: ${revoked.join(", ")}` : ""}`,
    );
    return { revoked, blocked: [], added, changed: true };
  }
  const perms = await effectivePermissions(Number(run.owner_id), { db, verify: true, project });
  const revoked = run.allowed_repositories.filter((r) => !perms.get(r)?.effective.read);
  const blocked = run.selected_repositories.filter((r) => revoked.includes(r));
  if (!revoked.length) return { revoked, blocked, added: [], changed: false };
  // Unselected revoked repositories leave the scope. Selected ones stay recorded (selected ⊆ allowed, and the
  // selection is the run's history); every permission check refuses them and the caller stops the step.
  const removed = revoked.filter((r) => !blocked.includes(r));
  if (removed.length) {
    const keep = run.allowed_repositories.filter((r) => !removed.includes(r));
    await q(
      db,
      "UPDATE workflow_runs SET allowed_repositories = $2, updated_at = now() WHERE id = $1",
      [run.id, keep],
    );
    run.allowed_repositories = keep;
  }
  await runEvents.add(
    db,
    run.id,
    "system",
    `repository access revoked for the run owner: ${revoked.join(", ")}${removed.length ? `; removed from the run scope: ${removed.join(", ")}` : ""}${blocked.length ? `; selected and now blocked: ${blocked.join(", ")}` : ""}`,
  );
  return { revoked, blocked, added: [], changed: removed.length > 0 };
}

async function runProjectOf(run: RunScope, db: Db) {
  const fromInputs = runProject(run);
  if (fromInputs) return fromInputs;
  const r = await one<{ project: string | null }>(
    db,
    "SELECT w.project FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1",
    [run.id],
  );
  return r?.project ?? "";
}

/**
 * Before touching protected repository content for a run (workspace, push, PR): the repository must be in the run's
 * persisted scope AND the run owner must still hold `action` right now. Never another user's permission.
 */
export async function requireRunRepositoryAccess(
  runId: number,
  repo: string,
  action: RepoAction,
  db: Db = pool,
) {
  const run = await one<RunScope>(
    db,
    "SELECT id, owner_id, allowed_repositories, selected_repositories, inputs FROM workflow_runs WHERE id = $1",
    [runId],
  );
  if (!run || run.owner_id == null) throw new RepositoryAccessError(404, "Run not found");
  if (!run.allowed_repositories.includes(repo))
    throw new RepositoryAccessError(403, "Repository outside run scope");
  const access = await resolveEffectiveRepositoryPermissions(Number(run.owner_id), repo, {
    db,
    verify: true,
    project: await runProjectOf(run, db),
  });
  if (!access?.effective[action])
    throw new RepositoryAccessError(
      403,
      `Repository access revoked or insufficient for ${action.replace("_", " ")}: ${repo}`,
    );
  return access;
}

/** Hot path (each agent tool call): last known permissions; throws when any repository in scope is no longer readable. */
export async function assertRunScopeReadable(ownerId: number, repos: string[], project = "") {
  if (!repos.length) return;
  const perms = await effectivePermissions(ownerId, { project });
  const lost = repos.filter((r) => !perms.get(r)?.effective.read);
  if (lost.length)
    throw new RepositoryAccessError(403, `Repository access revoked: ${lost.join(", ")}`);
}

// ------------------------------------------------------------------ Bitbucket verification

const API = "https://api.bitbucket.org/2.0";
type Verdict = Pick<CheckRow, "state" | "can_read" | "can_write" | "reason">;

/** Test seam: replace how a user's permission is asked from Bitbucket. */
let checker: (
  creds: { user: string; token: string },
  ws: string,
  slug: string,
) => Promise<Verdict> = askBitbucket;
export function setBitbucketPermissionChecker(fn: typeof checker | null) {
  checker = fn ?? askBitbucket;
}

let githubChecker: (token: string, owner: string, repo: string) => Promise<Verdict> =
  githubRepositoryAccess;
export function setGithubPermissionChecker(fn: typeof githubChecker | null) {
  githubChecker = fn ?? githubRepositoryAccess;
}

let gitlabChecker: typeof gitlabRepositoryAccess = gitlabRepositoryAccess;
export function setGitlabPermissionChecker(fn: typeof gitlabChecker | null) {
  gitlabChecker = fn ?? gitlabRepositoryAccess;
}

const unknownVerdict = (reason: string): Verdict => ({
  state: "unknown",
  can_read: null,
  can_write: null,
  reason,
});

/**
 * Per-host permission check with the user's own credentials. `secret` reads one user secret (memoised per refresh).
 * A shared service account proves nothing about this user: without personal credentials the state is unknown.
 */
type HostVerifier = (
  secret: (kind: string) => Promise<string | null>,
  remote: CanonicalRemote,
) => Promise<Verdict>;
const verifiers: Record<CanonicalRemote["provider"], HostVerifier> = {
  async bitbucket(secret, remote) {
    const user = await secret("bitbucket_user");
    const token = await secret("bitbucket_token");
    if (!user || !token)
      return unknownVerdict("no personal Bitbucket credentials (Integrations → Bitbucket)");
    return checker({ user, token }, remote.workspace, remote.slug);
  },
  async github(secret, remote) {
    const token = await secret("github_token");
    if (!token) return unknownVerdict("no personal GitHub token (Integrations → GitHub)");
    return githubChecker(token, remote.workspace, remote.slug);
  },
  async gitlab(secret, remote) {
    const token = await secret(gitlabSecretKey(remote.host));
    if (!token)
      return unknownVerdict(`no personal GitLab token for ${remote.host} (Integrations → GitLab)`);
    return gitlabChecker(token, {
      host: remote.host,
      workspace: remote.workspace,
      slug: remote.slug,
    });
  },
};

async function askBitbucket(
  creds: { user: string; token: string },
  ws: string,
  slug: string,
): Promise<Verdict> {
  const headers = {
    Authorization: "Basic " + Buffer.from(`${creds.user}:${creds.token}`).toString("base64"),
    Accept: "application/json",
  };
  const get = (path: string) => fetch(API + path, { headers, signal: AbortSignal.timeout(10_000) });
  let res: Response;
  try {
    res = await get(`/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}`);
  } catch {
    return { state: "unknown", can_read: null, can_write: null, reason: "Bitbucket unreachable" };
  }
  if (res.status === 401)
    return {
      state: "unknown",
      can_read: null,
      can_write: null,
      reason: "personal Bitbucket credentials rejected",
    };
  // Bitbucket answers 404 for a private repository the account cannot see.
  if (res.status === 403 || res.status === 404)
    return {
      state: "denied",
      can_read: false,
      can_write: false,
      reason: `Bitbucket ${res.status}: no access`,
    };
  if (!res.ok)
    return { state: "unknown", can_read: null, can_write: null, reason: `Bitbucket ${res.status}` };
  // Write: Bitbucket reports repository permissions through a workspace-scoped API that may require admin rights
  // (the cross-workspace /user/permissions endpoint was removed, CHANGE-2770). When it does not answer, write stays
  // undetermined (null), which is not "allowed" under the strict policy.
  let can_write: boolean | null = null;
  try {
    const q = encodeURIComponent(`repository.full_name="${ws}/${slug}"`);
    const p = await get(
      `/user/workspaces/${encodeURIComponent(ws)}/permissions/repositories?q=${q}`,
    );
    if (p.ok) {
      const perm = (await p.json().catch(() => ({})))?.values?.[0]?.permission;
      if (perm === "write" || perm === "admin") can_write = true;
      else if (perm === "read") can_write = false;
    }
  } catch {
    // undetermined
  }
  return {
    state: "verified",
    can_read: true,
    can_write,
    reason: can_write == null ? "read verified; write not reported by Bitbucket" : "verified",
  };
}

/** Refresh missing/expired checks of `userId` for `repos` (all of them with `force`). One flight per user at a time. */
/** Listings must not wait on the hosts: only never-checked repositories block; expired checks refresh behind. */
async function refreshForListing(userId: number, all: RepositoryRow[]) {
  const { checks } = await loadUser(userId, pool);
  const checked = new Set(checks.map((c) => c.repository_id));
  const never = all.filter((r) => !checked.has(Number(r.id)));
  if (never.length) await refreshBitbucket(userId, never, false);
  void refreshBitbucket(userId, all, false).catch(() => {});
}

/** Host permission checks run this many at a time (each is a network round trip to Bitbucket/GitHub/GitLab). */
const CHECK_CONCURRENCY = 10;
/** Network/host-side failures (not answers about the user): these never downgrade a recent definite verdict. */
const TRANSIENT_HOST_FAILURE = /^(Bitbucket|GitHub|GitLab) (unreachable|429|5\d\d)$/;
const KEEP_DEFINITE_ON_OUTAGE_MS = 24 * 3600_000;

export async function refreshBitbucket(userId: number, repos: RepositoryRow[], force: boolean) {
  const now = Date.now();
  const { checks } = await loadUser(userId, pool);
  const known = new Map(checks.map((c) => [c.repository_id, c]));
  const due = repos.filter(
    (r) =>
      onHosted(r) &&
      hostPolicy(r) !== "trusted" &&
      (force ||
        !known.has(Number(r.id)) ||
        new Date(known.get(Number(r.id))!.expires_at).getTime() <= now),
  );
  if (!due.length) return;
  await singleflight(
    `bitbucket-permissions:${userId}:${due.map((r) => r.id).join(",")}`,
    async () => {
      const memo = new Map<string, Promise<string | null>>();
      const secret = (kind: string) => {
        if (!memo.has(kind)) memo.set(kind, getUserSecret(userId, kind));
        return memo.get(kind)!;
      };
      const verdicts: Array<[RepositoryRow, Verdict]> = [];
      for (let i = 0; i < due.length; i += CHECK_CONCURRENCY)
        verdicts.push(
          ...(await Promise.all(
            due
              .slice(i, i + CHECK_CONCURRENCY)
              .map(async (r): Promise<[RepositoryRow, Verdict]> => {
                let remote: CanonicalRemote;
                try {
                  remote = repositoryRemote(r.repository_url!);
                } catch {
                  // e.g. a GitLab host removed from config.gitlab.instances: unknown, never an error for the listing.
                  return [
                    r,
                    unknownVerdict(
                      "repository URL is not accepted by this instance's configuration",
                    ),
                  ];
                }
                return [r, await verifiers[remote.provider](secret, remote)];
              }),
          )),
        );
      for (const [r, v] of verdicts) {
        // An unknown result is retried sooner than a definite one.
        const ttl = v.state === "unknown" ? Math.min(120, ttlSeconds()) : ttlSeconds();
        // A host outage must not erase a recent definite verdict (repositories would vanish from the user's list);
        // keep it and retry soon. Git operations still use the user's own token, so the host enforces revocations.
        const prev = known.get(Number(r.id));
        if (
          v.state === "unknown" &&
          TRANSIENT_HOST_FAILURE.test(v.reason) &&
          prev &&
          prev.state !== "unknown" &&
          now - new Date(prev.checked_at).getTime() < KEEP_DEFINITE_ON_OUTAGE_MS
        ) {
          await q(
            pool,
            "UPDATE repository_bitbucket_permissions SET expires_at = now() + make_interval(secs => $3) WHERE user_id = $1 AND repository_id = $2",
            [userId, r.id, ttl],
          );
          continue;
        }
        await q(
          pool,
          `INSERT INTO repository_bitbucket_permissions (user_id, repository_id, state, can_read, can_write, reason, checked_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now() + make_interval(secs => $7))
         ON CONFLICT (user_id, repository_id) DO UPDATE SET state = EXCLUDED.state, can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
           reason = EXCLUDED.reason, checked_at = EXCLUDED.checked_at, expires_at = EXCLUDED.expires_at`,
          [userId, r.id, v.state, v.can_read, v.can_write, v.reason.slice(0, 300), ttl],
        );
      }
    },
  );
}

/** Forget cached Bitbucket checks (credentials changed, explicit revalidation). */
export async function forgetBitbucketChecks(
  filter: { userId?: number; repositoryId?: number },
  repo = reposRepository,
) {
  await repo.deleteBitbucketChecks(filter, pool);
}

/** Explicit revalidation: drop the cached checks and ask Bitbucket again now. */
export async function revalidateBitbucket(
  filter: { userId?: number; repository?: RepositoryRow },
  repo = reposRepository,
) {
  await forgetBitbucketChecks(
    {
      userId: filter.userId,
      repositoryId: filter.repository ? Number(filter.repository.id) : undefined,
    },
    repo,
  );
  const users =
    filter.userId != null ? [filter.userId] : await repo.listUsersWithGrants(filter.repository?.id);
  const repos = filter.repository ? [filter.repository] : await repositories.list();
  for (const u of users) await refreshBitbucket(u, repos, true);
  return { users: users.length };
}

// ------------------------------------------------------------------ administration

/**
 * Access from an API body: a level, or independent checkboxes { read, write, pull_request }. Permissions imply each
 * other the way Git hosting does (a pull request needs a pushed branch, a push needs read), so the highest ticked one
 * wins: { pull_request: true } alone is full access, { write: true } is read + write.
 */
export function accessLevelFrom(body: {
  level?: unknown;
  read?: unknown;
  write?: unknown;
  pull_request?: unknown;
}): AccessLevel {
  if (body.level !== undefined) {
    const level = String(body.level) as AccessLevel;
    if (!ACCESS_LEVELS.includes(level))
      throw new HttpError(400, `invalid access level "${String(body.level)}"`);
    return level;
  }
  for (const k of ["read", "write", "pull_request"] as const)
    if (body[k] !== undefined && typeof body[k] !== "boolean")
      throw new HttpError(400, `${k} must be true or false`);
  return body.pull_request === true
    ? "pull_request"
    : body.write === true
      ? "write"
      : body.read === true
        ? "read"
        : "none";
}

/** The same level for one user on many repositories (all non-benchmark ones when `names` is omitted), in one transaction. */
export async function setRepositoryAccessMany(
  userId: number,
  level: AccessLevel,
  grantedBy: number | null,
  names?: string[],
  repo = reposRepository,
) {
  if (!ACCESS_LEVELS.includes(level)) throw new HttpError(400, `invalid access level "${level}"`);
  const u = await one<{ id: number }>(pool, "SELECT id FROM users WHERE id = $1", [userId]);
  if (!u) throw new RepositoryAccessError(404, "User not found");
  const all = (await repositories.list()).filter((r) => r.provider !== "benchmark");
  const targets = names ? all.filter((r) => names.includes(r.name)) : all;
  const unknown = names?.filter((n) => !all.some((r) => r.name === n)) ?? [];
  if (unknown.length)
    throw new RepositoryAccessError(404, `Repository not found: ${unknown.join(", ")}`);
  const f = flags(level);
  await withTx(async (c) => {
    const ids = targets.map((r) => Number(r.id));
    if (level === "none") await repo.deleteGrantMany(userId, ids, c);
    else await repo.upsertGrantMany(userId, ids, f, grantedBy, c);
  });
  return { user_id: userId, level, repositories: targets.map((r) => r.name) };
}

/** Grant (or with "none" remove) a user's platform access to a repository. Audited by the caller. */
export async function setRepositoryAccess(
  repository: RepositoryRow,
  userId: number,
  level: AccessLevel,
  grantedBy: number,
  repo = reposRepository,
) {
  if (!ACCESS_LEVELS.includes(level)) throw new Error(`invalid access level "${level}"`);
  if (repository.provider === "benchmark")
    throw new Error("Benchmark fixtures are not granted to users");
  const u = await one<{ id: number }>(pool, "SELECT id FROM users WHERE id = $1", [userId]);
  if (!u) throw new RepositoryAccessError(404, "User not found");
  return withTx(async (c) => {
    const before = await repo.findGrant(userId, repository.id, c);
    if (level === "none") await repo.deleteGrant(userId, repository.id, c);
    else {
      const f = flags(level);
      await repo.upsertGrant(userId, repository.id, f, grantedBy, c);
    }
    return {
      before: before
        ? levelOf({
            read: before.can_read,
            write: before.can_write,
            pull_request: before.can_create_pr,
          })
        : "none",
      after: level,
    };
  });
}

export async function setSharedAccess(
  repository: RepositoryRow,
  level: AccessLevel,
  repo = reposRepository,
) {
  if (!ACCESS_LEVELS.includes(level)) throw new Error(`invalid access level "${level}"`);
  if (repository.provider === "benchmark") throw new Error("Benchmark fixtures are not shared");
  const before: AccessLevel = repository.shared_access ?? "none";
  await repo.updateSharedAccess(repository.id, level, pool);
  return { before, after: level };
}

/** Admin view: every registry repository × every user, with grants, shared level and last Bitbucket checks. */
export async function accessMatrix(repo = reposRepository) {
  const repos = (await repositories.list()).filter((r) => r.provider !== "benchmark");
  const { users, grants, checks } = await repo.getAccessMatrixData(pool);
  return {
    policy: config.bitbucket.accessVerification ?? "strict",
    repositories: repos.map((r) => ({
      id: Number(r.id),
      name: r.name,
      provider: r.provider,
      projects: r.projects,
      enabled: r.enabled,
      allowed_actions: r.allowed_actions,
      shared_access: r.shared_access ?? "none",
      bitbucket: onHosted(r),
      host_policy: hostPolicy(r),
    })),
    users: users.map((u) => ({ ...u, id: Number(u.id) })),
    grants: grants.map((g) => ({
      user_id: Number(g.user_id),
      repository_id: Number(g.repository_id),
      level: levelOf({ read: g.can_read, write: g.can_write, pull_request: g.can_create_pr }),
      granted_by: g.granted_by,
      updated_at: g.updated_at,
    })),
    checks: checks.map((c) => ({
      user_id: Number(c.user_id),
      repository_id: Number(c.repository_id),
      state: c.state,
      can_read: c.can_read,
      can_write: c.can_write,
      reason: c.reason,
      checked_at: c.checked_at,
      expired: new Date(c.expires_at).getTime() <= Date.now(),
    })),
  };
}

/** Access changes of one repository (or all), newest first. */
export function accessAudit(repositoryName?: string, limit = 200) {
  return q(
    pool,
    `SELECT a.id, a.action, a.resource_id AS repository, a.detail, a.created_at, u.username AS actor
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.resource_type = 'repository' AND a.action LIKE 'repository.%' AND ($1::text IS NULL OR a.resource_id = $1)
      ORDER BY a.id DESC LIMIT $2`,
    [repositoryName ?? null, limit],
  );
}
