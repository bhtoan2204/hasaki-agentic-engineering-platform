# ADR 0007: Knowledge import — publication path, and the repository scan in Go

Status: accepted · publication changes on both engines; Go scan behind `KNOWLEDGE_IMPORT_ENGINE=go` (default
`typescript`) · Date: 2026-11-21

## Context

`importFromRepositories` (`src/knowledge/importer.ts`; admin API `POST /api/knowledge/import-repos`, CLI
`npm run knowledge:import`) turns the knowledge kept in repositories — agent instructions, conventions, skills with their
supporting files, Cursor rules, wiki documents, user-level skills — into registry items, versioned, governed and
embedded for retrieval. It scans every enabled checkout, builds candidates, compares them with the registry and writes
only what changed; items whose source disappeared from a scanned repository are retired.

### Baseline (before any change)

`npm run bench:knowledge-import` builds 1–30 repositories (CLAUDE.md + identical AGENTS.md, conventions, six skills
with references and a script — two identical in every repository —, Cursor rules; every fifth a wiki of ~120 nested
documents; 1,668 documents at 30) plus a user skills directory, on the isolated local PostgreSQL. The pre-change code
was measured from a worktree of the previous commit (`docs/architecture/knowledge-import-baseline.json`):

| pre-change code, p50 (SQL statements) | 1 repository | 5 | 15 | 30 |
|---|---|---|---|---|
| cold import | 1.4 s (526) | 7.9 s (3,027) | 22.8 s (8,704) | 50.0 s (17,376) |
| unchanged re-import | 0.60 s (195) | 2.9 s (1,103) | 9.1 s (3,194) | 19.0 s (6,339) |
| 1% of documents modified | 0.59 s | 3.1 s | 9.3 s | 20.3 s |
| 10% modified | 0.71 s | 4.7 s | 13.5 s | 26.8 s |
| 100% modified | 1.9 s | 13.6 s | 42.7 s | 84.5 s |
| scan alone (no database) | 4 ms | 13 ms | 40 ms | 72 ms |

**Where the time goes.** Not the filesystem: scanning 1,668 documents took 94 ms (0.5% of an unchanged import). Not
CPU: Node spent 2.5 s of CPU in a 17 s unchanged import. The database: every candidate was compared through
`knowledge.get` — the item, **all** its versions, its last 100 audit rows, supersession both ways (4–5 statements and
every historical version's content per candidate) — and every write read the item back the same way. The retirement
pass loaded the content of every item. The scan itself is synchronous (`readdirSync`/`statSync`/`readFileSync`) on the
event loop, follows symlinks out of the repository, reads files of any size in full, and a broken symlink aborts the
whole import.

## Decision

### 1. Publication path (TypeScript, both engines) — where the latency was

- `knowledge.latestShared(keys)`: one statement returns every candidate's item and latest version, the content as its
  SHA-256 computed in PostgreSQL (`content_sha256`); importers compare hashes, so unchanged documents never travel
  back to Node. Replaces one `knowledge.get` per candidate (repository import and external skills).
- `knowledge.createWithoutReload` / `updateWithoutReload`: the same transactions (row lock, new version, audit,
  tombstone removal) without reading the item back (5 statements fewer per write). `create`/`update` keep their API.
- Retirement lists items without contents and reads contents only for the items it retires.
- Publications are serialized across instances with an advisory lock (`serializedImport`): candidates are compared once
  before writing, so two concurrent imports would otherwise both create the same key. A second import waits and finds
  the first one's items unchanged. Dry runs only read and take no lock. Nothing is retried after a partial write: each
  item is its own transaction, as before.
- Optimistic concurrency, version history, the registry-evolution conflict rule (`registry_newer` / `conflict` →
  UPDATE proposal), tombstones of deleted items, blocked third-party skills and the retirement rules are unchanged.
- Embeddings (`go/internal/retrieval`): unchanged documents create no version, so nothing is enqueued. A new version
  whose embedded text (title, description, content) is identical — e.g. a renamed source file — no longer re-embeds:
  the worker moves the source's state to the new version (`retag`) when the content hash matches.

### 2. Discovery / assembly split

`scanRepositories()` = **discovery** (an engine reads the files and builds every candidate) + **assembly**
(`assembleCandidates`, TypeScript only). Discovery attaches to each candidate a *target* —
`repository`, `repositories` (identical skill copies), `wiki_siblings`, `wiki_projects`, `user_skill` — and assembly
resolves it against the registry: scope, applicability (`scopeForRepositories`, `scopeForProjects`,
`scopeForUserSkill`) and the enable policy of unattended-unsafe user skills (`USER_SKILLS_DISABLED`). TypeScript also
chooses the repositories (enabled, checked out) and which one is this installation (`isSelfRepository`). Neither
engine can widen a scope from what a document says.

### 3. One set of scan rules for both engines (`SourceTree`, `go/internal/knowledge/tree.go`)

| Rule | Before | Now |
|---|---|---|
| symlink to a file or directory outside the root | followed and imported | skipped, reported (`symlink outside the repository`) |
| symlink inside the root | followed | followed |
| race: a path component swapped for a symlink after the check | — | caught: the opened descriptor's real path (`/proc/self/fd`) must be inside the root; final component opened with `O_NOFOLLOW`, FIFOs with `O_NONBLOCK` |
| file larger than 1 MiB | read whole, secret-scanned, truncated to 60,000 chars | skipped, reported (`larger than 1048576 bytes`) — never imported unscanned; read bounded before allocation |
| per-repository entries > 20,000, total bytes > 512 MiB, scan > 120 s | unbounded | the scan stops there; the repository is reported **incomplete** and nothing of it is retired |
| broken symlink, checkout gone mid-scan | import aborted | skipped / repository incomplete |
| wiki `docs/` test | on the absolute path: a checkout below any `…/docs/…` imported every Markdown file | on the path relative to the repository |
| a cut inside a surrogate pair (60,000-char truncation, 300/600-char descriptions) | lone surrogate: PostgreSQL stored U+FFFD for text, JSONB metadata refused the insert | U+FFFD at the cut (`sliceUnits` / `jsstr.SliceUTF16`) |

Secret detection, path exclusions, external manifest hash verification and blocked third-party skills are unchanged
(the external manifest import stays TypeScript: a handful of platform-owned files). A user skills directory
symlinked to elsewhere is now skipped and reported like any symlink out of its root; user-level items are never
retired, so nothing disappears from the registry.

### 4. The scan in Go (`KNOWLEDGE_IMPORT_ENGINE=go`)

`go/internal/knowledge` implements discovery with the importer's exact semantics — `slug`, `frontmatter` (folded and
literal block scalars), `firstHeading`, `firstParagraph`, the backtracking and negative look-ahead of the
`SECRET_ASSIGNMENT` regular expression (by hand: RE2 has neither), UTF-16 lengths and cuts, WHATWG UTF-8 decoding,
`String.prototype.trim`, readdir byte order and `Array#sort` UTF-16 order. JavaScript string helpers shared with code
intelligence moved to `go/internal/jsstr`. `go/internal/knowledge/testdata/text-golden.json` is generated by the
TypeScript functions (`test/fixtures/knowledgeTextGolden.ts`) and checked by `go test`.

`POST /internal/v1/knowledge/scan` (contract `go/contracts/knowledge-v1.schema.json`, validated on both sides): the
request carries the rules version (`knowledge-scan-1`; another → 409), the repositories (name, root, self), the user
skills directory and the limits. platform-go refuses (400) roots that are not absolute and clean, not a checkout, or
whose real path lies outside its **trusted roots** — `PLATFORM_TRUSTED_ROOTS`, set by the supervising server from its
own `REPOS_ROOT`, data directory and user skills directory, resolved when checked — and limits beyond hard caps. It
only reads, two scans at a time, bounded by the scan deadline (incomplete, not an error) and the request (canceled →
nothing returned).

Fallback: the scan has no side effects, so an unreachable, slow, outdated or overloaded platform-go (network error,
timeout, 409, 5xx, malformed response, or a `scanned` list naming repositories that were not requested) is answered by
the TypeScript discovery. 400 and 401/403 are raised: falling back would hide a defect or a misconfiguration.

Persistent scan metadata and Git-based change detection were evaluated and **not** introduced: reading, hashing and
checking 1,668 documents costs 95 ms in Go; a `git ls-files`/`git status` pair per repository costs more
than it would save, and modification times are not a correctness signal. Unchanged documents already cost nothing
downstream (no version, no embedding).

### 5. Related hardening (code search, admission)

- Code search: request `allowed_roots` must lie inside the trusted roots (ADR 0006 amended); no trusted roots → 503 →
  TypeScript. 401/403 are raised instead of falling back. Exact search authorizes four repositories at a time, stops
  when the limit is filled and raises a refused repository's error exactly where the sequential loop would.
- Supervision budgets (ADR 0005 amended): host services keep their memory (Node, platform-go, a local PostgreSQL, a
  local Ollama); the limits of every agent and verification slot together never exceed the rest.

## Results

`npm run bench:knowledge-import` (`docs/architecture/knowledge-import-engines.json`; pre-change code:
`knowledge-import-baseline.json`), 16 CPUs / 15.5 GiB WSL2, local PostgreSQL 17, 5 iterations (cold: 3), p50.
Both engines produced **identical import reports** in every scenario and scale, locally and with latency; the parity
suite additionally compares the registry rows and the embedding eligibility.

**Publication path (TypeScript engine, before → after):**

| p50 | 1 repository | 5 | 15 | 30 |
|---|---|---|---|---|
| unchanged re-import | 601 → 114 ms (−81%) | 2,884 → 152 (−95%) | 9,101 → 283 (−97%) | 19,028 → 487 (−97%) |
| 1% modified | 594 → 113 (−81%) | 3,135 → 210 (−93%) | 9,282 → 440 (−95%) | 20,319 → 886 (−96%) |
| 10% modified | 710 → 199 (−72%) | 4,656 → 908 (−80%) | 13,480 → 2,445 (−82%) | 26,839 → 4,222 (−84%) |
| 100% modified | 1,916 → 972 (−49%) | 13,597 → 6,096 (−55%) | 42,697 → 17,477 (−59%) | 84,519 → 34,191 (−60%) |
| cold import | 1,379 → 927 (−33%) | 7,891 → 4,651 (−41%) | 22,758 → 13,299 (−42%) | 50,001 → 26,674 (−47%) |
| SQL statements, unchanged | 195 → 9 | 1,103 → 10 | 3,194 → 13 | 6,339 → 17 |
| Node CPU, unchanged | 126 → 32 ms | 456 → 45 | 1,680 → 153 | 3,436 → 250 |

With 20 ms of latency on every database packet (1 repository, `knowledge-import-baseline-latency20.json` vs
`knowledge-import-engines-latency20.json`): unchanged 7.4 s → 0.26 s (−96%), 1% 7.6 s → 0.31 s (−96%), 10% 9.4 s →
1.5 s (−84%), 100% 25.5 s → 11.9 s (−54%), cold 20.1 s → 11.3 s (−44%). At 5 repositories the new code takes 0.38 s
unchanged and 0.97–1.26 s at 1% (the pre-change code was not run at 5 repositories with latency: 1,103 statements × a
40 ms round trip is ≥ 44 s).

New versions = embedding queue entries in every run: unchanged documents enqueue nothing (as before). The remaining
cost of modified documents is the per-item write transaction (≈ 7 statements), kept for its row lock, audit and
version semantics.

**Go scan vs. TypeScript scan (same publication path):**

| p50 | 5 repositories | 15 | 30 |
|---|---|---|---|
| scan alone | 24 → 21 ms | 70 → 48 ms (−31%) | 140 → 95 ms (−32%) |
| Node CPU of the scan | 29 → 6 ms | 78 → 16 ms | 157 → 34 ms |
| unchanged import | 152 → 171 ms | 283 → 302 ms | 487 → 396 ms (−19%) |
| Node CPU, unchanged import | 45 → 48 ms | 153 → 103 ms | 250 → 156 ms |
| event-loop p99, unchanged import | 26 → 13 ms | 82 → 18 ms | 25 → 24 ms |
| 1% / 10% / 100% modified, cold | within ±10% | within ±10% | within ±10% |

The scan got slower than before (30 repositories: 72 → 140 ms in TypeScript) because every file is now resolved,
opened without following symlinks and re-checked through `/proc`: the price of the rules in §3, paid by both engines.
platform-go's peak RSS stayed at 46 MiB. The concurrent pool probe's p95 (a `SELECT 1` every 25 ms during the import)
stayed at 3–15 ms on every engine. Node's peak RSS is reported per process and both engines shared one process, so it
does not separate them (pre-change 252 MiB, after 370 MiB at 30 repositories, not investigated further).

Conclusion: the ≥ 30% target is met by the publication path for every expensive workload (unchanged and incremental
imports −72% to −97%, full re-imports −49% to −60%, cold imports −33% to −47%), on both engines. The Go scan meets it
for the scan itself (−31/−32% at 15/30 repositories) and takes 75–80% of the scan's CPU off the Node event loop, but
does not change import latency measurably below 30 repositories: it stays opt-in (`typescript` default).

## Rollback

`KNOWLEDGE_IMPORT_ENGINE=typescript` (or unset) and restart: the TypeScript discovery scans; nothing is stored by the
scan. The publication changes have no flag: they write the same items and versions as before (checked by
`test/repos-sync.integration.ts`, `test/external-skills.integration.ts`, `test/knowledge-evolution.integration.ts`); to
undo them, revert the commit — there is no data migration either way. Stopping platform-go degrades to the TypeScript
discovery automatically.

## Consequences and remaining limitations

- The Go scan's advantage is CPU and event-loop time on the Node process, not import latency; it stays opt-in.
- Files above 1 MiB are no longer imported (previously truncated); they are reported in `skipped`.
- Local imports (`npm run knowledge:import -- --local-dir=… | --skill-dir=… --repo=…`) use the same safe reader but stay in TypeScript: they
  read one directory the administrator names on the command line, outside the trusted roots by design.
- The TypeScript scan remains synchronous; with the Go engine it runs only as the fallback.
