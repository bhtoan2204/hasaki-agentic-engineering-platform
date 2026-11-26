# ADR 0009: Semantic code navigation through language servers

Status: accepted, behind `lsp.enabled` (default off; `LSP_ENABLED=1`) · Date: 2026-11-21

## Context

Code intelligence (ADR 0002, 0006) is syntax based: name-matched definitions and call candidates. Same-name functions,
import aliases, inferred types and interface methods make those candidates ambiguous; refactors need resolved
references.

## Decision

An additional, optional layer — the syntax index stays the discovery tool:

- `navigate(req, scope)` (`src/codeIntelligence/lsp/navigate.ts`): `definition`, `references`, `document_symbols`,
  `diagnostics`, `incoming_calls`, by 1-based line/character or a declaration name (`ambiguous` with candidates when
  the name is not unique; never a guess). Surfaces: workflow context tool `platform.navigate_code`, Chat
  `code.navigate`.
- **Servers.** Go: `gopls` (host binary, `lsp.gopls` override). TS/JS: `tsServer.mjs`, the TypeScript LanguageService
  API behind the same LSP subset — project plugins are never loaded and file reads are confined to the root and the
  TypeScript library. Client: a small Content-Length JSON-RPC client (no LSP library is a dependency; installing one
  was not possible here) with deadlines and `$/cancelRequest`.
- **Isolation.** Servers run in the agent sandbox profile (root bound read-only, no network, masked HOME / data /
  credentials, allowlisted env, cgroup and rlimits). Go also gets `GOPROXY=off`, `-mod=readonly`, `GOTOOLCHAIN=local`,
  `CGO_ENABLED=0`, `GOWORK=off`, `GOTELEMETRY=off`. Without the sandbox a server starts only with the operator opt-in
  `lsp.allowUnsandboxed`; otherwise `unavailable`.
- **Authorization and paths.** Repository in the caller's allowed set and `localScope` (registry enabled + readable;
  the run's own worktree on this worker when the run has one for the repository, else the base checkout); file via
  `readSource` (relative, no symlink component, not secret, bounded).
- **Freshness.** Sessions are keyed by (language, root, workspace fingerprint = HEAD + changed files' path/size/mtime);
  the server receives the live file text; after the answer the file hash and fingerprint are re-checked and a change
  yields `stale` with no locations. Provenance: repository, checkout|worktree, HEAD, file sha256, fingerprint, server.
- **Lifecycle.** At most `lsp.maxSessions` (4) sessions, LRU eviction, idle close (5 min), a dead session is replaced
  on the next request, `closeAllSessions()` leaves no process.
- **Bounds.** `lsp.maxResults` (50) with `more`; locations outside the root are counted as `external` only.

## Measurements (`npm run bench:lsp`, dev host, sandboxed gopls 0.24)

Fixture: two Go functions named `Process` (packages `payment`, `refund`), `payment` imported as `pay`; query
`pay.Process`.

|            | syntax (Tree-sitter extractor)  | LSP (gopls)                                        |
| ---------- | ------------------------------- | -------------------------------------------------- |
| definition | 2 candidates, 1 false positive  | 1 result, correct                                  |
| references | 7 candidates, 4 false positives | 3 results, all correct                             |
| latency    | 24–29 ms to extract all files   | 429–472 ms cold (start + first answer), ~1 ms warm |
| memory     | –                               | ~72 MB RSS (server tree)                           |

## Limits

- Only Go and TS/JS; other languages answer `unsupported` (use `search_code`).
- gopls inside the sandbox cannot see the host module cache (masked HOME): modules with external dependencies
  resolve only what is vendored or in the repository; such lookups come back `not_found` / external, never invented.
- Workspace fingerprinting runs `git status` per request (bounded to 2000 changed paths).
