# Migrating filesystem repository registrations

Migration `028_repository_remote.sql` adds nullable `repository_url`, `default_branch` (empty retains the local default), a canonical URL constraint and a partial unique remote index. It also adds the index job's `requested_by` principal. It never changes repository IDs/names, project arrays, metadata, dependencies, permissions, enabled flags, knowledge, workflow references, benchmark data or old paths. Existing migration history is unchanged.

Only complete, validated HTTPS URLs already recorded in `remote_slug` are backfilled. Duplicate candidate URLs are left unresolved. Names and workspace/slug hints do not prove a remote and remain `repository_url IS NULL`. That state is displayed as requiring configuration when no compatible local checkout exists. No workspace name is assumed. The migration runner is forward-only, checksum-verified, transactional and idempotent.

Review local evidence before an explicit shared registry update:

```bash
npm run repositories:migrate                # dry-run; normal schema migrations run first
npm run repositories:migrate -- --apply    # apply unambiguous proposals in place
```

The report includes repository ID/name, existing local path, detected safe remote, proposed canonical URL, status and warnings. Keep it private: paths identify this installation. Tokens and malformed remote URLs are never printed. Missing and unsupported remotes remain unresolved. The exact `git@bitbucket.org:workspace/slug.git` legacy syntax can be translated to canonical HTTPS during this explicit migration. New registration accepts HTTPS only.

Apply is conditional on the current row still having no remote. Repeated apply skips configured rows; duplicate candidates and concurrent registration conflicts are reported without deleting or merging anything. The command reads Git configuration with includes disabled, never fetches or runs hooks, and never rewrites a checkout origin. Startup discovery does not update configured URLs. An administrator can instead set a reviewed URL on the existing repository detail page.

Local `repositories` overrides and `reposRoot`/`projects` remain supported for unresolved legacy entries. They are not required for new remote registrations. The command does not remove old checkouts or overrides. Persisted worktrees/session directories remain usable on their assigned worker, including after URL configuration; future runs use managed clones. Do not delete legacy sources until all resumable runs using them have finished. Do not reassign offline local files to another instance.

Validation uses a disposable local PostgreSQL database and mocked Bitbucket transport. Migration tests cover reliable versus unresolved candidates, duplicate detection, stable IDs/metadata, repeatable apply and preserved old checkout origins. The command is not automatically applied to a production database during development or CI.
