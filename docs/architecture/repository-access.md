# Repository access control

Every user sees and uses only the repositories they are authorized for. The shared registry (`repositories`) stays the
single source of metadata; who may use a repository is a separate, deny-by-default relationship. Enforcement is in the
backend only (`src/repos/access.ts`); the UI just reflects it.

## Gap analysis (before this change)

| Gap | Where | Effect |
| --- | --- | --- |
| No per-user permission at all | `repositories.allowedFor(project)` | Any member could run agents on, read, rank and prepare every enabled repository. |
| Fallback widened to every repository | `allowedFor` with an unmapped/empty project | A run without a mapped project could use the whole registry. |
| Registry API was global | `GET /api/repositories`, `/workspace`, `/test-connection`, `/prepare`, `/refresh`, `/index-status`, `/rank` | Members listed, ranked and checked out repositories they had no business seeing. |
| Shared credentials proved nothing | `resolveBitbucket()` fallback to the service account | A successful clone/push with the shared account looked like user authorization. |
| Run scope frozen at creation | `run.allowed_repositories` | Revoking a person's access had no effect on existing runs, retries or resume. |
| Repository knowledge was global | knowledge list/get/preview, agent context, learning | A `REPOSITORY`-scoped item, or a skill imported from a private repository, leaked to everyone and into any agent context. |
| Historical diffs | `GET /api/runs/:id/changes` | Live source diffs stayed readable after access was revoked, also through the admin support view. |
| Dependencies | repository metadata | A repository's `dependencies` disclosed names of repositories the viewer cannot access. |

## Model (migration 045)

- `user_repository_access(user_id, repository_id, can_read, can_write, can_create_pr, granted_by, created_at, updated_at)`,
  primary key `(user_id, repository_id)`, cascading foreign keys, index on `repository_id`; levels are cumulative
  (read ⊂ write ⊂ pull request), enforced by CHECK constraints.
- `repositories.shared_access` (`none` default, `read`, `write`, `pull_request`): an explicit admin opt-in to give every
  active user that level (e.g. a common library). Registering a repository never sets it.
- `repository_bitbucket_permissions(user_id, repository_id, state, can_read, can_write, reason, checked_at, expires_at)`:
  the last Bitbucket answer for that user, with a bounded TTL.

**Effective permission = platform grant ∩ the user's own Bitbucket permission ∩ repository allowed actions (and enabled).**

The admin role manages the registry and the grants. It is not a grant: an admin without a grant cannot read source,
prepare a workspace or run an agent against a repository. Admins grant themselves like anyone else.

Benchmark fixtures (`provider = 'benchmark'`) are synthetic evaluation repositories: never granted or listed, usable only
by runs of their own `__benchmark:<suite>` project.

### Migration behaviour

No grant is created for existing users and nothing is shared. After upgrading, members see no repositories until an
admin assigns access (Repositories → Access management). Registry metadata (description, projects, services, tags,
dependencies, URLs, allowed actions) is unchanged. Existing unfinished runs keep their recorded scope; their next step
re-checks the owner, so a run whose owner has no grant stops safely at the next step (see Revocation).

## Bitbucket verification

Checked with the user's **own** credentials (Integrations → Bitbucket), never the shared service account:

- `GET /2.0/repositories/{workspace}/{slug}` → 200 = read verified; 403/404 = **denied**; 401, network or other errors
  = **unknown**.
- Write: Bitbucket's repository-permission API is workspace-scoped and may require admin rights (the cross-workspace
  `/user/permissions/repositories` was removed, CHANGE-2770). `GET /2.0/user/workspaces/{ws}/permissions/repositories`
  is tried; when it does not answer, write stays undetermined.
- No personal credentials → **unknown**. Unknown is never treated as allowed.

Results are cached per (user, repository): `bitbucket.permissionTtlSeconds` (default 900 s), 120 s for unknown. Entry
points (repository list, run creation, step start, workspace preparation, push, PR) refresh expired checks; at most four
requests in parallel, once per user per TTL, never per UI request. Each agent tool call uses the last known result.
Saving or clearing Bitbucket credentials drops that user's checks. Explicit revalidation: a member re-checks their own
access (`POST /api/repository-access/revalidate`); an admin re-checks a repository, a user or everyone.

Policy, `config.json` → `bitbucket.accessVerification`:

| Value | Read | Write / PR |
| --- | --- | --- |
| `strict` (default) | verified by Bitbucket | verified by Bitbucket |
| `personal` | verified by Bitbucket | allowed when Bitbucket does not report it, because pushes and PRs then run with that same personal token and Bitbucket enforces them |
| `trusted` | not checked | not checked |

`trusted` is the documented explicit trust policy for a team that works through the shared service account: the admin
vouches that platform grants mirror Bitbucket. Effective access is then the platform grant ∩ repository policy.
Repositories without a Bitbucket remote (legacy local checkouts) are `not_applicable`: platform grant ∩ repository policy.

## Enforcement points

| Entry point | Check |
| --- | --- |
| `GET /api/repositories` (My repositories), `GET /api/repositories/:name`, `/workspace`, `/test-connection`, `/prepare`, `/refresh` | `requireRepositoryAccess` read; inaccessible = 404 (same as unknown) |
| `GET /api/repositories/index-status` | filtered to readable repositories (`?manage=1`: admin) |
| `POST /api/repositories/rank` | `allowedRepositoriesForRun(caller)` |
| Registry and access management (`?manage=1`, `POST /api/repositories/:name`, `/access`, `/shared`, `/revalidate`, `/delete`, `/reindex`, `validate-url`, `/api/repository-access*`) | admin; every change audited (`audit_log`, `repository.*`) |
| Run creation and preview | `allowedRepositoriesForRun(owner, project)`; every requested name (body or `inputs.repositories`) must be in it, else 403 without listing others |
| Repository selection (user, approval, agent output) | inside the persisted scope **and** still readable by the owner |
| Step start (scheduler, covers retry, resume, re-execution) | `enforceRunRepositoryAccess`: revoked unselected repositories leave the scope; a revoked selected repository stops the step, not retried |
| Every agent tool call (`validateToolBinding`) | `assertRunScopeReadable` on the attempt's scope |
| Worktree preparation | `requireRunRepositoryAccess(run, repo, "write")` |
| Push | `requireRunRepositoryAccess(run, repo, "write")` |
| Pull request | `requireRunRepositoryAccess(run, repo, "pull_request")` |
| `GET /api/runs/:id/changes` | per workspace: the **viewer's** read access; otherwise `restricted`, no code |
| Knowledge list/get/preview, agent context, learning | `REPOSITORY`-scoped items and items imported from repository files follow repository read access |

Project mappings only narrow a user's set; they never add a repository. Without a mapped project a run gets the user's
own accessible set, never the whole registry.

## Revocation

Grant changes invalidate the in-process caches of every server (table triggers on `cache_invalidate`, migration 045).
A running agent fails its next tool call; the next step of any run drops unselected revoked repositories from the
scope, with a timeline note, and stops (`repository_access_revoked`, not retried) when a selected repository was revoked.
Pushes and PRs re-check right before writing. The selection stays recorded for history; restoring access and retrying
the step continues the run. One user's access is never used for another user's run.

## Limitations

- A long shell command step is not interrupted mid-command by a revocation; the check happens at the next step, tool
  call, push or PR.
- Stored artifacts, transcripts and reports of a user's own past runs remain visible to that user after revocation;
  only live diffs (`/changes`) are withheld. They are owner-scoped as before.
- Analytics show repository names of the viewer's own runs (or, in the audited admin support view, of all runs).
- Repository knowledge import (`POST /api/knowledge/import-repos`, admin) scans the whole registry; the imported items
  are then filtered per viewer as above.
- Bitbucket write verification depends on the workspace permission API answering for the user; with `strict` and a
  non-admin Bitbucket account, write/PR may stay undetermined (choose `personal` to rely on Bitbucket enforcing pushes).
