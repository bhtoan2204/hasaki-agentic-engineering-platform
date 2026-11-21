# ADR 0006: Code search, dependency traversal and source retrieval in Go (code intelligence, completion)

Status: accepted, behind `CODE_SEARCH_ENGINE=go` (default `typescript`) · Date: 2026-11-21

> **Update 2026-11-21:** the TypeScript engine was removed; platform-go is the only engine (no flag, no fallback, no rollback switch).

## Context

ADR 0002 moved indexing to Go; searching the index stayed in `src/codeIntelligence/search.ts`. Every agent step,
chat turn and repository ranking calls it (`searchSymbols`, `findDefinitions`, `findDependencies`,
`findReferences`, `searchCodeExact`, `buildCodeContext`, `hybridRank`).

Profiled on this platform's own `src/` (≈360 TypeScript files per repository, local PostgreSQL, before any change;
`npm run bench:code-search`, `docs/architecture/code-search-engines.json`):

| TypeScript engine, 5 repositories | p50 | SQL statements | git subprocesses |
|---|---|---|---|
| `searchSymbols` (4 queries) | 1.5 s | 80 | 190 |
| `findDependencies` (depth 2) | 0.7 s | 41 | 96 |
| `buildCodeContext` (3 queries) | 15 s | 814 | 2,047 |

The causes, in order of cost:

1. **Freshness per repository per query, twice.** `fresh()` resolves `localScope` (registry, run row, workspaces,
   `rev-parse --git-common-dir`), the base commit (`rev-parse`), the worktree generation (`status`, `diff`,
   `ls-files`, reading and hashing every changed file) and the snapshot — before the query and again after it.
   3–5 git processes and 2–3 statements, ×2, ×repositories, ×queries.
2. **`buildCodeContext` is ~17 searches.** One `searchSymbols(25)`, then `findDependencies(out)` and
   `findDependencies(in)` per qualified hit (each calling `searchSymbols(60)` per frontier name), each with its own
   freshness checks; then one `git show` per hit.
3. **Sequential repositories.** Every loop awaited one repository at a time; `scopeRun` re-read the run's
   workspaces per repository.

## Decision

### Split: TypeScript keeps the trust boundary, Go does the work

| Stays in TypeScript | Moves to `go/internal/codeintelligence/search.go` |
|---|---|
| `authorize(scope)`, repository registration, read permission, run ownership, worktree identity (`localScope`), all resolved **once per call** (`src/codeIntelligence/goSearch.ts`, ≤4 in parallel, scope order kept) | freshness: base commit and worktree generation per repository, memoized for the request, re-checked after the queries |
| provisioning and the indexing queue (`enqueue` of what Go found unindexed) | snapshot resolution for every repository in one statement; symbol, import and relation lookups batched across snapshots (`LATERAL`, per-snapshot limits) |
| ranking contract (`byRank`), prompts, context budget (`contextTokens`), agent context policy, workflow decisions | dependency traversal (bounded depth/edges, deterministic), exact search (streamed ripgrep, early stop), source reads (one `git cat-file --batch` per checkout), secret redaction, the context body |

Each public function keeps its signature and calls `goSearch(op, …)` first when the flag is `go`; `null` means "the
TypeScript engine answers", so the original code is the fallback path, unchanged. `POST
/internal/v1/code-intelligence/search` (contract `SearchRequest`/`SearchResponse` in
`go/contracts/code-intelligence-v1.schema.json`, validated on both sides) has four operations: `symbols`,
`dependencies`, `exact`, `context`. `findDefinitions`, `findReferences` and `hybridRank` are built on them.

### Go never chooses a path (defense in depth)

TypeScript sends only checkouts it authorized; platform-go re-validates every request (`ValidateSearch`): parser
version (409 otherwise), operation whitelist, ≤30 repositories, query bounds, fixed-string exact patterns (no newline
or NUL, ≤256 bytes), unique names, ref names (`^[A-Za-z0-9._/-]+$`, no `..`), and each root/primary must be absolute,
clean, inside an allowed root (`REPOS_ROOT`, `DATA_DIR`, real paths), equal to its own `EvalSymlinks` (no symlink
component), a directory, and hold `.git`. Files are read through the same symlink-safe reader as indexing; secret
files are never eligible and snippets/context lines go through the Go port of `redactSecrets`. Permission revocation
is enforced by TypeScript before the call (the revoked repository arrives as `unavailable`, never as a path). There is
no tenant or instance mixing: `instance_id` and run ids come from the authorized scope, and the snapshot lookup keys
on repository id + identity.

Amended by [ADR 0007](0007-go-knowledge-scan.md) §9: the allowed roots of a request must themselves lie inside
platform-go's **trusted roots** (`PLATFORM_TRUSTED_ROOTS`, set by the supervising server from its own `REPOS_ROOT`,
data directory and user skills directory), so a request can only narrow where platform-go reads; without trusted roots
the endpoint answers 503 and TypeScript searches. Exact search authorizes repositories **lazily**, four at a time in
scope order, and stops when the limit is filled; a repository the sequential loop would reach that fails
authorization raises its `localScope` error there (the first Go implementation authorized the whole scope up front
and silently skipped refused repositories).

### Freshness: never stale evidence

The semantics of `fresh()` are kept per repository: base identity `base:<commit>`, overlay identity
`overlay:<instance>:<run>:<base>:<generation>`; indexed rows are used only when the snapshot for the *current*
identity exists, otherwise the query falls back to live evidence and the repository is enqueued. After the queries
the identity is computed again; a repository whose identity changed during the call contributes no indexed rows
(fallback, as in TypeScript). The difference is *when*: single operations check before/after as before; composite
operations (`context`, multi-level `dependencies`) check each repository once before its first query and once after
the last query of the whole operation, and drop every row of a repository that changed in between. That is at least as
strict (a change anywhere in the window invalidates all of that repository's evidence) at a fraction of the cost.

### Determinism and parity

Ranking ties use `localeCompare` in TypeScript; Go uses `golang.org/x/text/collate` (root collation, tested against
Node's order) and stable sorts, then TypeScript re-applies `byRank`. Results are compared hit for hit with the
TypeScript engine (`test/code-search-go.integration.ts`). One intentional difference: TypeScript ran ripgrep with its
default parallel walker, so which files filled an exact-search `limit` depended on thread timing; Go passes
`--sort path`. Repository order and the limit are unchanged; within a repository the result is now deterministic.

### Resources

One bounded budget: platform-go answers at most 4 searches at once (`Searcher.Slots`), each running at most 4 git or
ripgrep processes at once; ripgrep output is streamed and capped (512 KiB per repository, `--max-count 5`,
`--max-filesize`), stopped at the limit; source reads are bounded by `context_chars`. Request deadline: the
TypeScript timeout (`config.codeIntelligence.timeoutMs`, capped at 60 s), carried in `X-Request-Timeout-Ms`; closing the request
cancels the queries and kills subprocesses. Search does not use the process-supervision slots (ADR 0005), whose
defaults were reviewed in the same change (memory-aware, fail closed; see ADR 0005 "Admission").

### Fallback

| Situation | Behaviour |
|---|---|
| flag `typescript`, no `RETRIEVAL_INTERNAL_TOKEN` | TypeScript engine |
| platform-go unreachable, timeout, 5xx, 409 (other parser version), invalid response | TypeScript engine, counted in `goSearchStats.fallbacks` |
| 400 (a scope or input TypeScript should never produce), 401/403 (refused credential, ADR 0007 §9) | error raised, no fallback |
| unauthorized repository | refused by `authorize` before either engine |

The fallback re-runs the TypeScript engine with its own freshness checks, so it can be slow but never stale and
never wider than the authorized scope.

## Results

`npm run bench:code-search` (`docs/architecture/code-search-engines.json`): this platform's `src/` copied into 1, 5,
15 and 30 repositories, indexed, base snapshots, local PostgreSQL 17, 16 CPUs / 15 GiB WSL2; cold call then 5 warm
calls; SQL statements counted by a wire proxy, git/rg processes by `PATH` wrappers. Retrieval quality: both engines
return identical results (deep equality) for every symbol, dependency and code-context query at 30 repositories.

Re-measured in the hardening review (5 and 30 repositories, 3 iterations) after fixing the benchmark harness, whose
PostgreSQL proxy added ~1 ms per packet even without injected latency; the first version of this table (1,509 → 626 ms
etc.) included that overhead. Exact search now also authorizes lazily (ADR 0007 §9).

| p50, TypeScript → Go (Δ) | 5 repositories | 30 repositories |
|---|---|---|
| `searchSymbols` (4 queries) | 1,041 → 488 ms (−53%) | 6,338 → 2,077 ms (−67%) |
| `findDependencies` (depth 2) | 488 → 141 (−71%) | 2,198 → 523 (−76%) |
| `findReferences` | 385 → 111 (−71%) | 363 → 216 (−41%) |
| `searchCodeExact` (limit 20) | 179 → 68 (−62%) | 178 → 61 (−66%) |
| `buildCodeContext` (3 queries) | 10,072 → 2,219 (−78%) | 37,181 → 5,252 (−86%) |

| per call at 30 repositories, TypeScript → Go (first measurement) | SQL statements | git processes | CPU (Node + Go) |
|---|---|---|---|
| `searchSymbols` | 480 → 16 | 1,140 → 930 | 2,276 → 929 ms |
| `findDependencies` | 213 → 6 | 488 → 180 | 929 → 229 ms |
| `buildCodeContext` | 3,025 → 54 | 7,892 → 966 | 15,719 → 1,111 ms |

Cold calls follow the same pattern (within 10% of p50 on both engines; the index is warm, only per-request state is
cold). The Node event loop p99 stays at 6–15 ms on both engines; platform-go peaked at 181 MB RSS.

With every PostgreSQL packet delayed 20 ms each way (`BENCH_DB_LATENCY_MS=20`, 1 and 5 repositories,
`docs/architecture/code-search-engines-latency20.json`; results again identical):

| p50, TypeScript → Go | 1 repository | 5 repositories |
|---|---|---|
| `searchSymbols` | 916 → 968 ms (**+6%**) | 5,146 → 1,250 (−76%) |
| `findDependencies` | 801 → 464 (−42%) | 2,566 → 399 (−84%) |
| `findReferences` | 412 → 265 (−36%) | 2,170 → 359 (−83%) |
| `searchCodeExact` | 108 → 58 (−46%) | 212 → 78 (−63%) |
| `buildCodeContext` | 10,895 → 4,235 (−61%) | 52,057 → 5,691 (−89%) |

Where the ≥30% target is **not** met, and why:

- `searchCodeExact` at 30 repositories (+7% in the first measurement): `goSearch` resolved the whole authorized
  scope before calling Go. Fixed in the hardening review by lazy, windowed authorization (four at a time, stop at the
  limit, same errors as the sequential loop): −66% at 30 repositories in the re-measurement.
- `searchSymbols` on one repository (−15% locally, +6% with 20 ms database latency): the same 16 statements on
  both engines, issued one after another (snapshot lookup, per-query rows, the after-check); freshness costs the same git commands on both engines (`localScope` validation
  in TypeScript, then base commit in Go); with one repository there is nothing to batch or parallelize. The
  remaining git processes per repository and query (≈8: two for `localScope` checkout validation in TypeScript,
  the rest Go's base-commit resolution before and after the query, up to three `rev-parse` candidates each) are the
  next cost to remove, e.g. one `rev-parse` with all candidates.

## Rollback

`CODE_SEARCH_ENGINE=typescript` (or unset) and restart; nothing is stored by the search path, so there is no data to
migrate. The flag is read per call, so it can also be flipped at runtime in tests. Stopping platform-go degrades to
the TypeScript engine automatically.

## Consequences and remaining limitations

- The TypeScript search engine stays as the fallback and the rollback until the roadmap's exit criteria are met.
- Composite freshness is checked once per operation (see above): a file changed and restored within one
  `buildCodeContext` call is not detected — the same window the per-query check had between its two calls.
- Exact-search ordering within a repository changed from timing-dependent to path order.
