# P1 architecture audit (main, Phase 1)

URL registry update (migration 028): see [repository architecture](repositories.md). Metadata ranking never provisions or schedules clones. Explicit exact-source search and scheduled indexing can prepare a worker-local source, with index jobs retaining their requesting principal.

The registry and explainable metadata ranking are in `src/repos/service.ts`. Local checkout overrides and origin validation live in `src/repos/paths.ts`; shared registry paths are layout hints, never machine authority. `src/git.ts` and `src/git/provider.ts` create isolated, instance-owned execution workspaces. Phase 1 adds instance fencing, owner-scoped execution, durable job leases, progressive knowledge/upstream context budgeting, provider-neutral prompts and verification. These boundaries must remain intact.

The DAG already has task analysis, `integration/repository_discovery`, repository approval, coding, command verification and resume. `src/workflow/scheduler.ts` claims PostgreSQL jobs with SKIP LOCKED and fences workflow attempts. Its worker loop can also service optional indexing work; a separate daemon or DAG engine is unnecessary. `src/workflow/background.ts` is only an in-process post-commit helper and is not restart-safe enough to own indexing jobs.

`src/db/pool.ts` provides transactions, deferred bulk writes and retry classification; migrations are append-only, checksummed SQL applied transactionally by `src/db/migrate.ts`. There is no down-migration runner. Migration 026 will add an isolated schema with no extension requirement or modification of existing data. Rollback is feature-disable followed by explicit schema removal after stopping workers.

No existing Tree-sitter, source symbol index or dependency graph was found. Existing `src/context/plan.ts` budgets knowledge and upstream outputs; file references and task memory already carry provenance. Existing agent search tools remain the fallback. Claude, Cursor and Codex share `src/agent/claude.ts` orchestration and prompt extras. The repository API/UI are `src/api/routes.ts` and `web/src/pages/Repositories.tsx`; admin-only registry mutations are the authorization precedent. Metrics are stored on workflow attempts, with structured diagnostics available through existing APIs.

Implementation points: dedicated codeIntelligence parser/snapshot/store/search modules; migration 026; optional local configuration; scheduler idle-work hook; discovery ranking; shared agent prompt extras and changed-worktree enqueue; repository status/reindex endpoints and a small repository detail card. Tests extend the existing isolated local PostgreSQL harness. Benchmarks use real timings and EXPLAIN, never estimates presented as measured performance.

Risks: mutable worktrees must never serve old base definitions, syntax matches cannot imply semantic resolution, machine paths must stay instance-scoped, indexing failures must not fail coding, and a parser/version change must invalidate cache identity. Index publication is atomic; immutable snapshots retain their last valid data after failed refresh. SQL coverage is explicitly grammar-dependent. Feature defaults off.

## Implemented architecture

Migration `026_code_intelligence.sql` adds six relational tables: `snapshots`, `files`, `extractions`, `symbols`, `relations`, and `runs`. Files map immutable snapshots to content-addressed extraction records. Repository ID and file path are joined at query time, so cache entries never contain repository/worktree/path identities. Shared canonical source identities are repository/commit/parser version; absolute local paths continue to come from the existing instance-scoped workspace registry and validated local configuration.

The runtime is `web-tree-sitter` 0.27.1 with pinned `tree-sitter-wasm` 2.0.4 grammar binaries. The package records upstream grammar revisions. [Tree-sitter's WASM binding](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) and the [grammar distribution](https://github.com/Crysthamus/tree-sitter-wasm) describe the loader/runtime contract. Runtime initialization and grammar loading are lazy. Cache identity includes language, runtime/grammar/extractor version, SHA-256 content, SQL dialect, symbol cap, generated/dependency policy and exclusions. Bump `INDEX_VERSION` when changing extraction rules or pinned parser packages.

| Language | Extracted syntax |
| --- | --- |
| Go | Package, imports, named functions, receiver-qualified methods, interface method declarations, structs, interfaces, aliases/types, call candidates |
| TypeScript / TSX | Imports/reexports, exported declaration references, functions/arrow assignments, named classes/methods, interfaces, aliases, explicit implements clauses, call candidates |
| Proto | Package, imports, nested messages/enums, services, RPCs, request/response candidates |
| SQL | CREATE TABLE/VIEW/INDEX/FUNCTION, columns, object/foreign-key reference candidates |

The SQL grammar is PostgreSQL-oriented. `sqlDialect` accepts `postgresql` or `generic` and identifies cache provenance; both intentionally use the same grammar. This is syntax recognition of the grammar's supported subset, not validation or dialect translation. MySQL DELIMITER, T-SQL GO and other unsupported fragments produce skipped error subtrees; valid surrounding statements can still index. Anonymous declarations and compiler-level type/value/overload resolution are outside this extractor.

`DEFINES` and directly exported declarations are structurally resolved. Calls, implements clauses, SQL references, RPC message references and cross-file/cross-repository target discovery retain candidate/unresolved status. Matching a target name never upgrades an edge to resolved. Literal gRPC wire paths passed as call arguments (for example `/pay.Payment/Charge`) create candidate references to the RPC qualified name. Generated files are excluded by default; `includeGenerated` enables inspecting such clients. No generated-language client/server typechecker is implemented.

## Snapshot and overlay behavior

The baseline commit comes from local `origin/HEAD`, then `origin/<baseBranch>`, then the configured local base branch. It never assumes a literal `main`, never fetches or mutates source during indexing, and uses a commit SHA in the immutable identity. A new base enumerates Git objects, reuses unchanged blob/language mappings, reads missing blobs in batches and performs one extraction-cache lookup per bounded batch. Symbol/relation writes use the existing deferred bulk-insert transaction helper.

A worktree overlay belongs to repository + existing workflow run + instance + base snapshot + generation. Generation covers HEAD, worktree `.git` marker identity and exact hashes/masks of changed tracked/untracked files. `git diff <actual-base-sha>` compares the base with the working tree (including staged/unstaged and committed branch differences); `git ls-files --others --exclude-standard` adds untracked files. Rename detection is intentionally disabled: old-path deletion plus new-path insertion has exact replacement semantics. An oversize, binary, deleted or symlink-replaced base file is masked even when no symbols can be parsed.

Effective queries union overlay files with base files **only when the overlay has no row for that base path**. Thus an overriding file with zero symbols still masks every old symbol/relation. Primary-checkout navigation without a workspace explicitly addresses the immutable default-branch snapshot and reads snippets from that commit. With a workspace, navigation validates the current generation before and after index lookup. Context additionally verifies source content hashes before inclusion. Missing/stale/unavailable indexes queue refresh and use bounded live `rg` where possible; original metadata ranking and native agent search remain available.

Publication locks the registry row only during persistence, checks the job fencing token/lease and instance session, validates the worktree generation again, and commits the complete manifest atomically. A replaced/expired/canceled worker cannot publish through a stale fence. Duplicate base creation is prevented by the repository/identity/version constraint and publication lock. Failed refreshes leave prior published snapshots intact.

## Operations, security and workflow

The existing scheduler's general worker lanes service the durable indexing queue when workflow work is absent. Light workflow lanes stay available for approvals and short steps. Queue rows are pinned to the local instance, claimed with `FOR UPDATE SKIP LOCKED`, heartbeated, fenced and recovered after lease expiry. Attempts are bounded at three. Cancellation fences the running job; requests arriving during indexing remain queued for another pass. Progress/diagnostics live in `runs`; final indexing metrics include duration, files, skipped files, parse errors and cache hits. Completed-run overlays expire after `retentionDays`; live-run overlays and reusable base snapshots remain available.

On startup, enabled registered readable repositories are queued. Existing repository discovery and the repository search tool combine deterministic metadata ranking with exact/qualified symbols, paths, import/RPC dependency candidates, registry dependencies, and live text evidence on fallback. Each signal contributes once; default code bonuses are capped at 3 points, the existing weight of a single name/service match. Exact and qualified signals are 2, paths/dependencies 0.5, text 0.25. Tests cover the cap, duplicates, ties and disabled-feature equivalence. Defaults prioritize reliable declarations over text without allowing repeated low-confidence hits to accumulate arbitrary weight.

The shared provider executor builds prompt extras on fresh execution and resume, skips independent review (to preserve its evidence boundary), and queues changed-worktree indexing after a turn. Workspace creation queues its overlay immediately. Context prefers definitions, then direct dependency definition candidates and bounded caller locations, deduplicates overlapping ranges and caps each snippet to 19 lines. `contextTokens` uses the existing platform convention of approximately four characters per token; it is an estimate, not a model-specific tokenizer guarantee. Paths, commit SHA, worktree run and generation accompany snippets. Source is marked untrusted and passed through existing secret redaction. Search/context/ranking metrics use existing attempt metrics.

Repository read permissions and run allowed sets are enforced before navigation. Worktrees are checked against the registered primary Git common directory and assigned instance. File access refuses traversal and symlink components, uses `O_NOFOLLOW`, checks the opened descriptor on Linux, and bounds bytes before parsing. Git diff disables external diff/textconv; fsmonitor hooks are disabled for indexer Git commands. Source is not executed. Exact search uses argument arrays, fixed strings, an empty ripgrep config, Git ignore rules, a 3-second process bound, a 512 KiB output cap and supported source extensions. Command failures are categorized before persistence so stderr/source/credentials are not copied into indexing errors.

API additions follow existing authentication/CSRF middleware: `GET /api/repositories/index-status`, administrator `POST /api/repositories/:name/reindex`, and administrator `POST /api/repositories/index-runs/:id/cancel`. The existing repository detail page adds a status card, progress and controls. Source search is exposed through the existing run-scoped integration tool registry, not an unscoped public source endpoint.

## Migration and rollback

The normal server migration runner applies 026 transactionally and preserves all existing rows. No `pg_trgm` or other extension is required. The project uses forward-only checksummed migrations and has no down runner. Operational rollback is to disable the feature, stop/drain indexing workers, then (only if index data is intentionally disposable) drop the dedicated `code_intelligence` schema and remove migration version 26 from `schema_migrations` in one administrative transaction. The existing platform tables are unaffected; keeping the disabled schema avoids any destructive action. No production database was migrated during this implementation; migrations were exercised in the isolated local test database.

## Limits and remaining improvements

- This is syntax-assisted navigation, not compiler/language-server semantic analysis. Cross-repo edges and generated RPC references remain candidates.
- Query and context limits intentionally truncate results; this is a bounded retrieval API, not a full-index export/pagination API.
- Requests validate Git state and may invoke bounded live search; very large dirty worktrees can hit scan/time limits and fall back to existing discovery/tools. Idle indexing can wait behind sustained workflow load.
- Base snapshots and unused extraction artifacts do not yet have automatic garbage collection. Only completed-run overlays have retention. Administrative retention for historical bases/cache is a future improvement.
- There is no filesystem watcher or continuous fetch. New local base commits are discovered at startup, explicit reindexing, or index-dependent queries. Remote advancement becomes visible after the platform's existing Git fetch lifecycle updates local refs.
- Benchmarks use a deterministic synthetic fixture on local PostgreSQL. Production-scale repositories, remote PostgreSQL latency, sustained queue load and actual paid provider runs have not been benchmarked here. Existing provider regression tests use fixtures; no live Claude/Codex account was invoked.

## Verification and measured results

The full regression run passed **344 tests**, including migration upgrade/idempotence, Phase 1 instance ownership, authorization, workflow recovery and provider fixture tests. After the final dependency/live-search freshness checks, the **16 focused P1 tests** passed again. TypeScript backend/frontend checks, the production Vite build and `git diff --check` passed. On this workstation the test command used `TMPDIR=/var/tmp npm test`: `/tmp` has read-only Git marker directories that conflict with the pre-existing instance-identity guard. No application guard or test expectation was weakened to get the suite passing.

The final benchmark is recorded verbatim in `code-intelligence-benchmark.json` and can be reproduced with `TMPDIR=/var/tmp npm run bench:code-intelligence` in this environment. It indexes 400 generated source fixtures across Go, TypeScript, Proto and SQL (42,945 source bytes) on Node v22.23.2 and the existing local PostgreSQL test service.

| Measurement | Result |
| --- | ---: |
| Initial index | 327.45 ms |
| One-file incremental commit | 62.80 ms |
| Unchanged files reused | 399 / 400 |
| Snapshot-validated symbol lookup, 20 samples | p50 50.20 ms; p95 71.06 ms |
| Existing metadata ranking | 0.40 ms |
| Hybrid ranking | 52.94 ms |
| PostgreSQL tables plus indexes, including two base manifests | 1,589,248 bytes |
| Retrieved source context | 215 characters; approximately 54 tokens |

`EXPLAIN ANALYZE` used `ci_symbol_name` for the primitive exact-symbol lookup (0.035 ms execution). The combined symbol/path retrieval plan used snapshot file indexes plus a symbol sequential scan/hash join (2.701 ms execution on this fixture). The latter is recorded explicitly rather than implying every hybrid predicate uses the exact-name index. Larger production data may justify splitting exact and path query plans. End-to-end timings above include Git/authorization/freshness overhead; SQL execution time alone is not presented as API latency.

The previous implementation supplied no code-intelligence snippet block, so this feature adds the measured 215 characters for this request. The fixture's 42,945 bytes are a reference size, **not** a measured old prompt or evidence of a claimed token reduction. Full provider prompt/context comparisons on real engineering tasks and production repository/remote-database benchmarks remain unmeasured because this verification deliberately uses isolated fixtures and no paid model execution.

## Exact file inventory

New files:

- `migrations/026_code_intelligence.sql`
- `src/codeIntelligence/git.ts`
- `src/codeIntelligence/parser.ts`
- `src/codeIntelligence/store.ts`
- `src/codeIntelligence/indexer.ts`
- `src/codeIntelligence/search.ts`
- `test/code-intelligence-parser.test.ts`
- `test/code-intelligence.test.ts`
- `test/code-intelligence.bench.ts`
- `docs/architecture/code-intelligence.md`
- `docs/architecture/code-intelligence-benchmark.json`

Modified existing files:

- `src/config.ts`
- `config.example.json`
- `package.json`
- `package-lock.json`
- `src/server.ts`
- `src/workflow/scheduler.ts`
- `src/workflow/executors/builtin.ts`
- `src/git/provider.ts`
- `src/agent/claude.ts`
- `src/agent/toolRegistry.ts`
- `src/api/routes.ts`
- `web/src/pages/Repositories.tsx`
- `README.md`
