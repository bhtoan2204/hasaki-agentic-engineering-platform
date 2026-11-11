# Self-development

The platform can be the target of its own engineering workflows. This is the existing Work Item → Run → step engine, pointed at a registered checkout of this repository. It is not a second scheduler, a coding CLI, or a hardcoded repository id.

## What already existed

Workflow definitions are versioned in PostgreSQL and seeded from `src/workflow/templates.ts`. A run copies one published graph and then advances it with the same jobs, leases, fencing tokens, checkpoints and recovery used for every other repository. `feature-implementation` already analyses, confirms repositories, plans, waits for approval, implements in a worktree, runs a command, reviews and opens a pull request.

Repository access is deny-by-default. An admin manages the registry and grants; the admin role is not itself a grant. Worktrees live under `dataDir` and are recorded in `execution_workspaces`. Tool policy allows edits only inside those worktrees. Push and pull-request creation are platform steps, not agent tools. Resume reuses the saved worktree and does not invent a second branch. The pull-request step updates an open request for the same source and target instead of creating another.

## What was missing

- Public registration accepted only Bitbucket URLs. Clone, fetch, push and pull requests were Bitbucket operations. GitHub now uses the same `GitProvider` seam (`src/github.ts`, `src/git/provider.ts`).
- Nothing identified “this process’s own source”. Detection is the configured `platform.repositoryUrl`, or the live checkout’s `origin` when that is empty.
- The live checkout was not a protected root, so a coding shell could write it when the path was outside `reposRoot`. It is now always a protected root. `prepareBranch` refuses to run Git against that tree or to place a worktree inside it.
- Workflow test commands inherited the worker environment, including `DATABASE_URL`. Commands whose origin is this installation get a scrubbed environment and a local admin URL that is not the application database.
- Node tests were an all-or-nothing `npm test`. The self-development template runs typecheck, lint and tests for the changed modules first, then `npm test` once before the pull request.

## How to run it

1. Register `https://github.com/<owner>/<repository>.git` (or the Bitbucket URL of a fork) on Repositories. Set the default branch and a category such as `Platform / Internal Tooling`. Registration does not grant anyone access.
2. Grant the user read, write and pull request. Save that user’s GitHub token under Integrations. A fine-grained token with Contents and Pull requests on this repository is enough. `github.allowSharedCredentials` stays false unless an operator explicitly opts in, and a shared token is never treated as that user’s permission.
3. Create a Work Item, choose **Platform Self-Development**, and pick Claude, Codex or Cursor.
4. Approve the plan and, later, the pull request. The run’s branch and worktree are stable across pause, retry and worker restart. Recovery asks a person to continue a coding or test step; it does not replay it blindly and it does not delete the worktree.

Codex coding is allowed because its sandbox writes only the agent directory and a scratch directory under `dataDir`. Claude, Cursor and Antigravity coding, and test commands without `bwrap`, require `platform.trustedOperatorIsolation` (or `PLATFORM_TRUSTED_OPERATOR_ISOLATION=1`). Leave that off when users are not trusted. Installing `bwrap` sandboxes test commands without the flag; it does not wrap the Claude or Cursor CLIs.

`dataDir` must stay outside the live checkout. The server already refuses to start when it does not.

## Isolation invariants

| Rule | Where it is enforced |
| --- | --- |
| Modifications happen in a worktree | `prepareBranch`, `execution_workspaces` |
| The live checkout is not a worktree and is not fetched, reset, cleaned or checked out by the workflow | `prepareBranch`, `prepareRepository` |
| Agents cannot edit or write secrets in the live tree | `protectedRoots` plus `decide` / `decideBash` |
| The server is not restarted, deployed or merged | no such step exists; the pull request waits for a person |
| Tests do not receive the application database or runtime secrets | `commandProcessEnv` |
| Newly generated code is not loaded into this process | tests and agents are child processes in the worktree |
| A different workflow cannot skip the guards | the guards key off the repository URL, not the template name |
| A resumed step rechecks repository permission | existing `enforceRunRepositoryAccess` |

## Limitations

- Without bubblewrap, a test or agent process still runs as the worker’s OS user. It can read files that user can read. Tool policy and a scrubbed environment are not a container. Do not enable `trustedOperatorIsolation` for untrusted users.
- Claude and Cursor coding are not inside bubblewrap. Cursor’s sandbox is disabled for coding so the CLI can edit; the platform kills the process after a denied tool call, which is not a prior OS boundary. Use Codex, or the trusted-operator flag on a machine you control.
- `test/setup.ts` in the repository under test creates a database from `TEST_DATABASE_ADMIN_URL`. That URL is local and is not the application database, but a superuser role could still affect other local databases. Prefer a role that can `CREATE DATABASE` and cannot connect to the application database, and set `platform.testDatabaseAdminUrl`.
- Those `platform_test_*` databases are kept, the same way ordinary `npm test` keeps them.
- The full regression is one `npm test` before the pull request, not after every edit inside the coding step. Targeted typecheck, lint and matching test files run first.
- GitHub permission checks use the same cache table as Bitbucket. A missing `permissions` object does not count as write under the strict policy.
- Reading the live tree with ripgrep can still see a non-ignored secret if a tool does not honor `.gitignore`. Direct reads of `.env`, `config.json` and key files under a protected root are denied.
