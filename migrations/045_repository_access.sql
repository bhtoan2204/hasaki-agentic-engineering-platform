-- User-scoped repository access. The registry (repositories) stays the shared source of metadata; who may use a
-- repository is a separate, deny-by-default relationship.
--
-- Effective permission for (user, repository, action) is the intersection of
--   1. the platform grant: a row here, or the repository's explicit shared_access level;
--   2. the user's own Bitbucket permission (repository_bitbucket_permissions, bounded TTL), unless the repository has
--      no Bitbucket remote or the installation explicitly trusts platform grants (bitbucket.accessVerification);
--   3. the repository's allowed_actions (and enabled).
-- Migration safety: no grant is created for existing users. Admins keep managing the registry and access by role, but
-- an admin role alone does not give access to source code: admins grant themselves like anyone else.

CREATE TABLE user_repository_access (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  can_read       BOOLEAN NOT NULL DEFAULT true,
  can_write      BOOLEAN NOT NULL DEFAULT false,
  can_create_pr  BOOLEAN NOT NULL DEFAULT false,
  granted_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repository_id),
  -- levels are cumulative: read ⊂ write ⊂ pull request; a row without read is meaningless (delete it instead)
  CHECK (can_read),
  CHECK (NOT can_write OR can_read),
  CHECK (NOT can_create_pr OR can_write)
);
CREATE INDEX user_repository_access_repository ON user_repository_access(repository_id);

-- Explicit opt-in shared access for every active user (e.g. a common library). 'none' (default) = grants only.
ALTER TABLE repositories ADD COLUMN shared_access TEXT NOT NULL DEFAULT 'none'
  CHECK (shared_access IN ('none', 'read', 'write', 'pull_request'));

-- Last known Bitbucket permission of a user on a repository, checked with that user's own credentials.
-- state: verified (Bitbucket answered: read and, when known, write), denied (Bitbucket says no access),
-- unknown (no personal credentials, revoked token, network/API failure). Unknown never counts as allowed.
CREATE TABLE repository_bitbucket_permissions (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  state          TEXT NOT NULL CHECK (state IN ('verified', 'denied', 'unknown')),
  can_read       BOOLEAN,            -- NULL = not determined
  can_write      BOOLEAN,            -- NULL = not determined (Bitbucket did not tell us)
  reason         TEXT NOT NULL DEFAULT '',
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, repository_id)
);

-- Committed writes clear in-process caches in every server (same mechanism as migration 024).
CREATE TRIGGER user_repository_access_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON user_repository_access
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER repository_bitbucket_permissions_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON repository_bitbucket_permissions
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
