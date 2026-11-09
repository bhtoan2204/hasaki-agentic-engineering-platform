# Repository URL migration validation

Baseline: fetched `main` and verified the requested GitHub repository at `216b35cd98230ce47a6ee881f1776e9b53c0a0ee`. The working branch was already at that commit with a clean working tree. The local directory and origin retain the repository's former name; the requested repository URL resolves to the same main commit.

## Architecture and database

Canonical Bitbucket HTTPS identity is separate from deprecated legacy layout hints. PostgreSQL migration 028 adds `repository_url`, `default_branch`, canonical validation/uniqueness and the indexing request principal. No repository rows, names, IDs or references are deleted. Unique full legacy URLs can be backfilled; unknown and duplicate candidates remain unresolved. The existing migration runner remains transactional, checksummed and forward-only.

Worker-managed clones resolve by instance/repository IDs; writable worktrees and agent directories resolve by instance/run IDs. PostgreSQL session locks serialize preparation. Existing worktree/session paths are recovered in place only by their assigned instance. Registry metadata/ranking never require provisioning. Explicit source search and requested/scheduled indexing can prepare sources.

Backend changes cover registry validation, API/RBAC, connection testing, clone/fetch/refresh, credential resolution, secure Git transport, branch/worktree preparation, publication, code indexing/search, agent working directories, test baselines, review evidence, task memory and summaries. The existing Repositories page now edits URL/provider/default branch and exposes instance-local connection/preparation/status controls in Vietnamese and English.

## Legacy scan

A read-only scan of the configured existing registry found **26 repositories: 21 proposed, 3 unresolved and 2 ambiguous**. The detailed report is private at `/tmp/repository-legacy-dry-run.json`, mode 0600, because it contains local paths. No shared registry metadata or production schema was changed by this scan. Apply mode was tested on disposable PostgreSQL fixtures, not executed against the shared database. Review unresolved/duplicate entries before an explicit apply.

## Validation results

- `npm run typecheck`: passed (backend and frontend).
- `npm run build`: passed.
- `npm test`: **385 passed, 0 failed, 0 skipped** (249.3 seconds).
- Focused registry/authentication/RBAC/publication regression run: 34 passed, 0 failed.
- Final native Codex commit guard / integration credentials / repository regression check: **43 passed, 0 failed**.
- Chromium repository UI smoke: passed against the real HTTP server and built UI, with synthetic users. Covers URL validation/normalization, creation, workspace controls, missing-credential guidance and status refresh. Screenshot: `/tmp/repository-ui-smoke.png`.
- `git diff --check`: passed.

Tests use the existing local PostgreSQL infrastructure and real local Git repositories with mocked Bitbucket network transport. No live Bitbucket credential or paid agent call was required. The full suite includes the existing provider execution, resume, code-intelligence workflow and objective benchmark fixtures. New regression tests cover canonical/malicious URLs, uniqueness, schema/data preservation, personal/shared credentials, missing/revoked credentials, authenticated clone reuse, cleanup, origin mismatch, clone races/retries, instance/run isolation, legacy worktree recovery, ranking without clones, source indexing/search, queued principal isolation, authenticated push and canonical-workspace PR creation.

## Security and remaining limits

Tokens remain in the existing encrypted user store; temporary Git credentials are supplied only to a child environment. No token is inserted into a URL, argv, Git configuration, prompt or frontend response. Helpers are private and removed in finally blocks. URL hosts/protocols, TLS, redirects, local Git configuration, origins, root containment and platform-native Git hooks are checked or constrained. Write/publication permissions and run/worker fencing are retained and rechecked around preparation. The commit tool also protects managed primary checkouts.

Only Bitbucket Cloud HTTPS is supported for new registrations. Real Bitbucket token scopes, organization network policies, macOS and Windows deployment smoke tests remain environment validation tasks; automated transport/worktree tests ran on Linux. Git refuses two simultaneous worktrees of the same branch rather than sharing an active writable tree. Local activity/error observations are process-local and reconstructed from disk after restart. Directory isolation does not provide OS security separation when workers/agents share an OS account.

## Exact files changed

- `README.md`
- `config.example.json`
- `docs/architecture/bitbucket-credentials.md`
- `docs/architecture/code-intelligence.md`
- `docs/architecture/multi-instance-development.md`
- `docs/architecture/repositories.md`
- `docs/architecture/repository-migration.md`
- `docs/validation/repository-url-migration.md`
- `migrations/028_repository_remote.sql`
- `package.json`
- `src/agent/attachments.ts`
- `src/agent/claude.ts`
- `src/agent/independentReview.ts`
- `src/agent/openCodeReview.ts`
- `src/agent/platformTools.ts`
- `src/agent/stepPrompt.ts`
- `src/agent/toolRegistry.ts`
- `src/api/routes.ts`
- `src/bitbucket.ts`
- `src/cli/migrate-repositories.ts`
- `src/codeIntelligence/git.ts`
- `src/codeIntelligence/indexer.ts`
- `src/codeIntelligence/search.ts`
- `src/config.ts`
- `src/git.ts`
- `src/git/changes.ts`
- `src/git/provider.ts`
- `src/integrations/accounts.ts`
- `src/knowledge/memory.ts`
- `src/prompt.ts`
- `src/report/runSummary.ts`
- `src/repos/git.ts`
- `src/repos/legacy.ts`
- `src/repos/paths.ts`
- `src/repos/remote.ts`
- `src/repos/service.ts`
- `src/repos/workspaces.ts`
- `src/startupValidation.ts`
- `src/workflow/context.ts`
- `src/workflow/executors/baseline.ts`
- `src/workflow/executors/builtin.ts`
- `test/authz.test.ts`
- `test/repositories.browser.ts`
- `test/repository-remotes.test.ts`
- `web/src/i18n/catalog.ts`
- `web/src/pages/Repositories.tsx`
