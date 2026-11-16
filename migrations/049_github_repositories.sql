-- GitHub remotes use the same registry, grants and worktree layout as Bitbucket.
-- Category is an optional label (for example "Platform / Internal Tooling"); it is not an authorization grant.
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_remote_canonical;
ALTER TABLE repositories ADD CONSTRAINT repositories_remote_canonical CHECK (
  repository_url IS NULL OR (
    repository_url NOT LIKE '%..%' AND (
      (provider = 'bitbucket' AND repository_url ~ '^https://bitbucket[.]org/[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9._-]*[.]git$')
      OR
      (provider = 'github' AND repository_url ~ '^https://github[.]com/[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]*[.]git$' AND repository_url !~ '^https://github[.]com/[a-z0-9-]*-/')
    )
  )
);
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
COMMENT ON COLUMN repositories.category IS 'Operator label such as Platform / Internal Tooling. Not used for authorization.';
