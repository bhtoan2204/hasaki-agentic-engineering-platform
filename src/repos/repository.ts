import { pool, q, one, type Db } from "../db/pool.ts";

export interface RepositoryRow {
  id: number;
  name: string;
  path: string;
  provider: string;
  remote_slug: string;
  repository_url?: string | null;
  default_branch?: string;
  description: string;
  projects: string[];
  services: string[];
  owners: string[];
  tags: string[];
  dependencies: string[];
  architecture: string;
  category?: string;
  delete_source_branch?: boolean;
  allowed_actions: string[];
  enabled: boolean;
  shared_access?: "none" | "read" | "write" | "pull_request";
}

export interface GrantRow {
  repository_id: number;
  can_read: boolean;
  can_write: boolean;
  can_create_pr: boolean;
}

export interface CheckRow {
  repository_id: number;
  state: "verified" | "denied" | "unknown";
  can_read: boolean | null;
  can_write: boolean | null;
  reason: string;
  checked_at: Date;
  expires_at: Date;
}

export interface MatrixGrantRow {
  user_id: number;
  repository_id: number;
  can_read: boolean;
  can_write: boolean;
  can_create_pr: boolean;
  granted_by: string | null;
  updated_at: Date;
}

export const reposRepository = {
  findAllRepositories(db: Db = pool): Promise<RepositoryRow[]> {
    return q<RepositoryRow>(db, "SELECT * FROM repositories ORDER BY name");
  },

  findRepositoryByName(name: string, db: Db = pool): Promise<RepositoryRow | undefined> {
    return one<RepositoryRow>(db, "SELECT * FROM repositories WHERE name = $1", [name]);
  },

  findRepositoryForUpdate(name: string, db: Db = pool): Promise<{ id: number } | undefined> {
    return one<{ id: number }>(db, "SELECT id FROM repositories WHERE name = $1 FOR UPDATE", [
      name,
    ]);
  },

  findActiveRunsUsingRepo(name: string, db: Db = pool): Promise<{ id: number } | undefined> {
    return one<{ id: number }>(
      db,
      "SELECT id FROM workflow_runs WHERE $1=ANY(allowed_repositories) AND status NOT IN ('COMPLETED','FAILED','CANCELED') LIMIT 1",
      [name],
    );
  },

  async deleteExclusion(name: string, db: Db = pool): Promise<void> {
    await q(db, "DELETE FROM repository_exclusions WHERE name = $1", [name]);
  },

  async insertRepository(
    name: string,
    cols: string[],
    values: unknown[],
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      `INSERT INTO repositories (name${cols.length ? ", " + cols.join(", ") : ""}) VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join("")}) ON CONFLICT (name) DO NOTHING`,
      [name, ...values],
    );
  },

  async updateRepository(
    name: string,
    cols: string[],
    values: unknown[],
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      `UPDATE repositories SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE name = $1`,
      [name, ...values],
    );
  },

  async deleteRepository(name: string, db: Db = pool): Promise<void> {
    await q(db, "DELETE FROM repositories WHERE name = $1", [name]);
  },

  async insertExclusion(
    name: string,
    deletedBy: number | null = null,
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      "INSERT INTO repository_exclusions (name, deleted_by) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET deleted_by = EXCLUDED.deleted_by, deleted_at = now()",
      [name, deletedBy],
    );
  },

  findProjectsByRepoNames(names: string[], db: Db = pool): Promise<Array<{ projects: string[] }>> {
    return q<{ projects: string[] }>(
      db,
      "SELECT projects FROM repositories WHERE lower(name) = ANY($1)",
      [names.map((n) => n.toLowerCase())],
    );
  },

  listExclusionNames(db: Db = pool): Promise<Array<{ name: string }>> {
    return q<{ name: string }>(db, "SELECT name FROM repository_exclusions");
  },

  findDefaultBranchByWorkspacePath(
    path: string,
    db: Db = pool,
  ): Promise<{ default_branch: string | null } | undefined> {
    return one<{ default_branch: string | null }>(
      db,
      "SELECT r.default_branch FROM repositories r JOIN execution_workspaces w ON r.name=w.repo WHERE w.path=$1 LIMIT 1",
      [path],
    );
  },

  async getUserGrantsAndChecks(
    userId: number,
    db: Db = pool,
  ): Promise<{ grants: GrantRow[]; checks: CheckRow[] }> {
    const [grants, checks] = await Promise.all([
      q<GrantRow>(
        db,
        "SELECT repository_id, can_read, can_write, can_create_pr FROM user_repository_access WHERE user_id = $1",
        [userId],
      ),
      q<CheckRow>(
        db,
        "SELECT repository_id, state, can_read, can_write, reason, checked_at, expires_at FROM repository_bitbucket_permissions WHERE user_id = $1",
        [userId],
      ),
    ]);
    return {
      grants: grants.map((g) => ({ ...g, repository_id: Number(g.repository_id) })),
      checks: checks.map((c) => ({ ...c, repository_id: Number(c.repository_id) })),
    };
  },

  async deleteBitbucketChecks(
    filter: { userId?: number; repositoryId?: number },
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      "DELETE FROM repository_bitbucket_permissions WHERE ($1::bigint IS NULL OR user_id = $1) AND ($2::bigint IS NULL OR repository_id = $2)",
      [filter.userId ?? null, filter.repositoryId ?? null],
    );
  },

  async listUsersWithGrants(repositoryId?: number, db: Db = pool): Promise<number[]> {
    const rows = await q<{ user_id: number }>(
      db,
      "SELECT DISTINCT user_id FROM user_repository_access WHERE ($1::bigint IS NULL OR repository_id = $1)",
      [repositoryId ?? null],
    );
    return rows.map((u) => Number(u.user_id));
  },

  async deleteGrantMany(userId: number, repositoryIds: number[], db: Db = pool): Promise<void> {
    await q(
      db,
      "DELETE FROM user_repository_access WHERE user_id = $1 AND repository_id = ANY($2::bigint[])",
      [userId, repositoryIds],
    );
  },

  async upsertGrantMany(
    userId: number,
    repositoryIds: number[],
    f: { read: boolean; write: boolean; pull_request: boolean },
    grantedBy: number | null,
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      `INSERT INTO user_repository_access (user_id, repository_id, can_read, can_write, can_create_pr, granted_by)
       SELECT $1, id, $3, $4, $5, $6 FROM unnest($2::bigint[]) AS id
       ON CONFLICT (user_id, repository_id) DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
         can_create_pr = EXCLUDED.can_create_pr, granted_by = EXCLUDED.granted_by, updated_at = now()`,
      [userId, repositoryIds, f.read, f.write, f.pull_request, grantedBy],
    );
  },

  findGrant(userId: number, repositoryId: number, db: Db = pool): Promise<GrantRow | undefined> {
    return one<GrantRow>(
      db,
      "SELECT repository_id, can_read, can_write, can_create_pr FROM user_repository_access WHERE user_id = $1 AND repository_id = $2",
      [userId, repositoryId],
    );
  },

  async deleteGrant(userId: number, repositoryId: number, db: Db = pool): Promise<void> {
    await q(db, "DELETE FROM user_repository_access WHERE user_id = $1 AND repository_id = $2", [
      userId,
      repositoryId,
    ]);
  },

  async upsertGrant(
    userId: number,
    repositoryId: number,
    f: { read: boolean; write: boolean; pull_request: boolean },
    grantedBy: number,
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      `INSERT INTO user_repository_access (user_id, repository_id, can_read, can_write, can_create_pr, granted_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, repository_id) DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
         can_create_pr = EXCLUDED.can_create_pr, granted_by = EXCLUDED.granted_by, updated_at = now()`,
      [userId, repositoryId, f.read, f.write, f.pull_request, grantedBy],
    );
  },

  async updateSharedAccess(repositoryId: number, level: string, db: Db = pool): Promise<void> {
    await q(db, "UPDATE repositories SET shared_access = $2, updated_at = now() WHERE id = $1", [
      repositoryId,
      level,
    ]);
  },

  async getAccessMatrixData(db: Db = pool) {
    const [users, grants, checks] = await Promise.all([
      q<{ id: number; username: string; role: string; active: boolean }>(
        db,
        "SELECT id, username, role, active FROM users ORDER BY username",
      ),
      q<MatrixGrantRow>(
        db,
        "SELECT a.user_id, a.repository_id, a.can_read, a.can_write, a.can_create_pr, g.username AS granted_by, a.updated_at FROM user_repository_access a LEFT JOIN users g ON g.id = a.granted_by",
      ),
      q<CheckRow & { user_id: number }>(
        db,
        "SELECT user_id, repository_id, state, can_read, can_write, reason, checked_at, expires_at FROM repository_bitbucket_permissions",
      ),
    ]);
    return { users, grants, checks };
  },

  listAccessAudit(repositoryName?: string, limit = 200, db: Db = pool) {
    return q(
      db,
      `SELECT a.id, a.action, a.resource_id AS repository, a.detail, a.created_at, u.username AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.resource_type = 'repository' AND a.action LIKE 'repository.%' AND ($1::text IS NULL OR a.resource_id = $1)
        ORDER BY a.id DESC LIMIT $2`,
      [repositoryName ?? null, limit],
    );
  },
};
