-- Additive upgrade: IDs, names, paths and every referencing row remain unchanged.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS repository_url TEXT;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS default_branch TEXT NOT NULL DEFAULT '';
-- Only a complete, unambiguous HTTPS URL is reliable. A slug/name is NOT evidence of a workspace.
-- Duplicate candidates remain unresolved for explicit administrator review.
WITH candidates AS (
 SELECT id, lower(regexp_replace(regexp_replace(remote_slug, '/$', ''), '(\.git)?$', '.git')) AS url
 FROM repositories
 WHERE repository_url IS NULL AND provider='bitbucket'
 AND remote_slug ~* '^https://bitbucket[.]org/[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9._-]*(\.git)?/?$'
 AND remote_slug NOT LIKE '%..%'
), unique_candidates AS (
 SELECT url FROM candidates GROUP BY url HAVING count(*)=1
)
UPDATE repositories r SET repository_url=c.url FROM candidates c JOIN unique_candidates u USING(url)
WHERE r.id=c.id AND NOT EXISTS (SELECT 1 FROM repositories other WHERE other.repository_url=c.url);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_remote_identity ON repositories(repository_url) WHERE repository_url IS NOT NULL;
ALTER TABLE repositories ADD CONSTRAINT repositories_remote_canonical CHECK (
 repository_url IS NULL OR (provider='bitbucket' AND repository_url ~ '^https://bitbucket[.]org/[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9._-]*[.]git$' AND repository_url NOT LIKE '%..%')
);
COMMENT ON COLUMN repositories.path IS 'Deprecated layout hint; only local configuration may contain absolute paths';
COMMENT ON COLUMN repositories.repository_url IS 'Canonical remote identity; NULL means legacy configuration required (except explicit benchmark/local fixtures)';

-- Scheduled indexing retains the requesting principal; personal credentials are never selected by repository owner.
ALTER TABLE code_intelligence.runs ADD COLUMN IF NOT EXISTS requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
