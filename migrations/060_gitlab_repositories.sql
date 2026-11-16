-- GitLab remotes (gitlab.com and allow-listed self-hosted instances, nested groups) use the same registry, grants and
-- worktree layout as Bitbucket and GitHub. The bitbucket and github clauses are unchanged from 049; existing rows
-- keep satisfying the constraint. Which hosts are accepted is decided by config.gitlab.instances in the application.
-- Upgrade every instance sharing this database before registering a GitLab repository: older instances do not
-- recognise the provider.
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_remote_canonical;
ALTER TABLE repositories ADD CONSTRAINT repositories_remote_canonical CHECK (
  repository_url IS NULL OR (
    repository_url NOT LIKE '%..%' AND (
      (provider = 'bitbucket' AND repository_url ~ '^https://bitbucket[.]org/[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9._-]*[.]git$')
      OR
      (provider = 'github' AND repository_url ~ '^https://github[.]com/[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]*[.]git$' AND repository_url !~ '^https://github[.]com/[a-z0-9-]*-/')
      OR
      (provider = 'gitlab' AND repository_url ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?/([a-z0-9][a-z0-9._-]*/){1,20}[a-z0-9][a-z0-9._-]*[.]git$')
    )
  )
);
-- GitLab "delete source branch" on merge. Default off; only a human-triggered merge reads it.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS delete_source_branch BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN repositories.delete_source_branch IS 'Remove the source branch when a human merges the pull/merge request through the platform.';
