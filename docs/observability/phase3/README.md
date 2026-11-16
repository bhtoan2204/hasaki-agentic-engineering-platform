# Platform-native agent context and tools

Phase 3 adds provider-neutral, durable context packs and a shared logical tool interface. It reuses the existing knowledge resolver, repository registry/ranking, code intelligence, task-memory freshness rules, workflow inputs/checkpoints, integration registry, MCP adapters, worker fencing, and Phase 1 metrics. It does not create a separate search index, model router, workflow executor, or dashboard.

## Execution path

Before Claude, Codex, Cursor or Antigravity launches an agent step, the shared executor validates its live owner/attempt binding and builds or reloads the attempt's context pack. Context retrieval runs outside the engine's run-lock transaction. Existing immutable `context_snapshots` remain the source of applicability, pinned upstream attempts, knowledge versions, and verification policy. Packs persist in PostgreSQL before provider execution.

The user prompt receives bounded request/evidence entries; curated rules remain in the system prompt. External task text, repository content, production signatures, checkpoints, and earlier agent claims are explicitly untrusted evidence. Existing validated `code_intelligence` snippet blocks and metrics are preserved: the pack calls the original `buildCodeContext` implementation, which checks source hashes and index/worktree generation. Resuming an attempt's conversation with a new durable attempt builds a fresh pack, so changed worktree snippets refresh.

The pack includes relevant:

- Run request, work item description (including legacy payload-note fallback), business requirements and acceptance criteria.
- Selected/authorized repository metadata, existing relevance ranking, applicable conventions, business rules and skills.
- Source symbols, validated snippets, dependency candidates and snapshot/commit references where code intelligence is available.
- Pinned ancestor outputs, explicit requirement/constraint fields, developer answers and reexecution instructions.
- Approved/verified fresh task memory selected by the existing resolver; stale and unknown memory are excluded or have their bodies withheld on retrieval.
- Related owned-task or unlinked shared-project production fingerprints. A source-code or agent success claim never establishes a production resolution.
- Verification requirements, prior structured continuity, saved progress notes, unfinished checkpoints and parent pack references.

A source has an ID, version when known, capture/effective timestamp when known, owner/shared visibility, relevance explanation and freshness/uncertainty label. Missing timestamps and unavailable capabilities stay explicit. Code syntax/confidence, keyword ranking and repository selection are evidence-selection heuristics, not claims of semantic correctness or measured context quality.

## Configuration and budget

The installation can configure:

```json
{
  "agent": {
    "contextTokens": 24000,
    "contextToolTimeoutMs": 10000
  }
}
```

A step may override the pack budget with `config.context_tokens` (integer 2,000–64,000). Tool read-response deadlines are clamped to 1–60 seconds. The pack's token measure is the existing character estimate (`ceil(characters/4)`), including its metadata; it is **not provider-reported token usage**. Serialized UTF-8 pack size and preparation time are recorded separately in attempt metrics.

Core request, verification requirements, explicit developer decisions, business rules, assigned/enforced knowledge, and explicit upstream requirements/constraints are retained without silent shortening. Optional supporting material is ranked, structurally summarized, marked `truncated`, or deferred to the existing tools. The omission index is bounded along with the pack. If required material cannot fit, preparation fails with `ContextBudgetError` before calling a provider. Increase the budget or explicitly narrow the request; a summary is not substituted for a mandatory constraint.

This budget applies to the retrieved context pack. Trusted runtime policy, workflow instructions/output contract, attachment paths, verification feedback, live worktree evidence, SDK overhead, and the provider's own conversation are outside that estimate. Required context is retained in immutable pack/snapshot references even when optional continuity summaries are shortened. A truncated curated rule must be fetched completely before acting; `read_knowledge` now supports bounded `offset` and `limit` pagination.

## Unified tools

Logical names use `platform.<suffix>`. MCP exposes the `platform` server with suffix tool names, e.g. `mcp__platform__search_code`. `call_tool` also accepts a logical `platform.*` name through the same dispatcher. There is one strict schema catalog shared by Claude's in-process MCP list and both CLI stdio bridges.

| Logical tool | Existing service / source |
| --- | --- |
| `platform.search_code` | `searchSymbols`, exact source search, or `buildCodeContext`; no independent search system |
| `platform.get_symbol` | `findDefinitions`; returns candidate definitions and source provenance |
| `platform.find_dependencies` | `findDependencies`, max three hops; use the qualified name returned by `get_symbol` for precise navigation |
| `platform.search_knowledge` | Applicable immutable step snapshot, reranked with `scoreKnowledge`, with live registry visibility checked |
| `platform.get_business_rules` | Applicable business-rule subset with version/provenance |
| `platform.search_task_memory` | Existing approved/verified task-memory model plus `memoryFreshness` revalidation |
| `platform.get_work_item` | Current run's linked owned work item, selected requirement fields, no unrelated task access |
| `platform.get_step_output` | Completed ancestor output pinned in this attempt's input; independent-review sanitization is preserved |
| `platform.get_run_context` | Current pack, snapshot/hash references, capabilities and paginated context entries |
| `platform.get_production_errors` | Existing production groups for the linked owned task or unlinked configured project; no live scan or remote write |
| `platform.get_repository_metadata` | Authorized repository registry and original deterministic ranking |
| `platform.request_clarification` | Existing workflow questions, atomically authorized, idempotent while questions are open; stop and await answers |

Example arguments:

```json
{"query":"FulfillRefund","repositories":["payment-src"],"operation":"symbols","limit":8}
```

```json
{"section":"requirements","offset":0,"limit":8}
```

Search defaults to the run's selected repositories, otherwise its authorized repositories (bounded to 30). Explicit repositories cannot expand that scope. Code tools report `supported: false` when code intelligence is disabled; unavailable indexes/sources retain existing bounded fallback behavior. This interface does not provision/clone repositories or enqueue indexing as a side effect of its new read operations. Existing discovery/indexing lifecycle behavior is retained elsewhere.

All twelve logical tools are exposed to each supported provider. Existing capability checks still reject unsupported CLI flags, unavailable authentication and unenforceable delegation; there is no provider fallback. Codex retains its pre-execution hook requirement and coding-only commit adapter. Cursor uses the same authenticated broker transport without claiming to implement Codex hooks. These are explicit provider differences, not missing logical retrieval capabilities.

## Runtime authorization and boundaries

Every dispatched tool is checked against the database for:

- Authenticated execution principal when present and the immutable active run owner.
- Exact run, step and attempt IDs, current step attempt and matching generations.
- Current job/attempt fencing token, live job lease, assigned worker instance and non-replaced instance session.
- Workflow-authorized analysis/coding mode and repository sets that cannot broaden persisted scope.

Parameters never select an alternate run, owner, worker, attempt or arbitrary path. Repository reads require enabled registry rows and read authorization. Knowledge reads re-check source visibility and exact snapshot version/body; pinned reexecution versions now include owner filtering, closing a preexisting private-key lookup gap. Independent reviewers cannot use native or legacy step-history reads to recover deliberately withheld coding-agent claims.

Read-only retrieval is distinct from control writes. Clarification is the sole new write adapter, using a run lock, live attempt/generation/lease checks, a bounded SQL statement timeout, and the existing question lifecycle. Existing branch/commit/result actions retain their workflow permission gates. Pending clarification blocks subsequent mutating platform actions, and provider tool-policy paths prevent native edits while waiting. No logical tool starts another run or invokes an unrestricted workflow.

Native schemas are strict and bounded (query, repository count, result count, dependency depth, pagination, questions/options). Legacy exposed tools also receive runtime input validation. Native output is bounded to 24,000 characters in valid JSON with explicit truncation; legacy output has a 64,000-character ceiling. Redaction operates structurally **before** JSON serialization, preserving nested JSON and escape sequences. Knowledge content supports paging rather than unbounded full-text results. Native read responses have deadlines; at most four native reads remain in flight per attempt. A timed-out read may finish in the underlying existing service, but its late result is discarded and does not produce a second evidence record. Writes are not raced against detached background timeouts.

Codex and Cursor stdio helpers receive only an ephemeral Unix-socket path, attempt-scoped random capability and mode. The reused broker uses a 0700 directory, 0600 socket and constant-time token comparison. Cursor's old MCP config no longer receives `DATABASE_URL`, platform config paths or run-selected database credentials. Stdio schemas import no database/config service modules. Agent child environments remove platform, database and unrelated integration credentials; explicitly configured Claude/Cursor authentication remains only with its own provider. Codex still receives no API key that would silently change its billing mode. These tool boundaries do not claim to provide complete OS isolation from arbitrary code running as the worker account; existing native-tool/sandbox policies remain in force.

## Persistence, continuity and inspection

Migration `031_platform_native_context.sql` adds:

- **`agent_context_packs`**: unique per attempt, immutable, owner/run/step/snapshot references, content hash and bounded context body.
- **`agent_context_tool_calls`**: attempt-bound tool status, read/write classification, duration, input hash, redacted bounded returned evidence and worker/pack references. Calls made while building a pack can have a null pack ID; they remain associated with that same attempt and snapshot through the attempt record.
- **`agent_context_continuity`**: idempotently captured final structured explanation referencing the immutable pack and parents.

Continuity records describe the request/rule/decision source references, retrieved evidence IDs, bounded observed changed files/commits, remaining questions/checkpoint, execution outcome and actual verification metrics. Agent output is stored only as an explicitly unverified summary. On restart, the environment is reconstructed from persisted attempt input and context snapshot; no provider chat transcript or process-local cache is required to retrieve context. Singleflight is owner/run/step/attempt/fence/snapshot scoped **after authorization** and is only an in-flight optimization, not cross-user storage.

After a hard process kill, a final continuity capture may be absent. Already persisted pack, tool evidence, questions and progress checkpoints survive; the normal recovery path supplies checkpoint references and inspects the live worktree. Missing file/verification observations are not invented. A new attempt gets a new pack; an active attempt reuses its immutable pack with a reuse metric. Pack schema has no provider dependency, so supported adapters can consume the same authorized historical evidence. This does not change the existing policy that a run's provider is selected and pinned by normal run creation.

The authenticated endpoint `GET /api/attempts/:id/context?offset=0` returns pack, continuity and 25 ordered evidence records, with total count. It uses existing `requireAttempt` owner checks and the explicit audited admin `scope=all` path. Ownerless/foreign attempts remain hidden. There is no new dashboard or unrestricted evidence endpoint.

## Measurement

Attempt metrics retain Phase 1 usage/cost/token/verification attribution. Phase 3 adds:

- `context_pack`: pack/snapshot IDs, estimated tokens, serialized size, preparation time, logical retrieval calls/failures and reuse flag.
- `context_tools`: durable-call counts, failures, retrieval counts/failures and summed observed call duration, recomputed from the evidence ledger rather than incremented by replayed metric writes.
- Existing `code_intelligence` metrics from `buildCodeContext`.
- Structured verification outcomes in continuity, copied from the harness/reviewer metrics rather than inferred from completion.

Logical retrieval counts do not claim to count every internal SQL/filesystem operation. Character estimates never replace missing provider tokens or price. No context-quality, repository-accuracy or productivity improvement claim is introduced without labeled evidence.

## Audit and rollout

The implementation inspected and reused `platformTools.ts`, `toolRegistry.ts`, `mcpBridge.ts`, `stepPrompt.ts`, `workflow/context.ts`, knowledge/task memory, repository/code intelligence, and all three provider adapters. Public legacy tool names and the existing dynamic integration registry remain usable. The existing code-intelligence workflow and provider process tests validate compatibility, including resumed worktree refresh.

Apply migration 031 with the normal application migration runner before starting workers with this code. Existing migrations and the PostgreSQL execution/observability model remain unchanged. The only new indexes serve run-to-pack and attempt-to-evidence lookups. Run `npm run typecheck`, `npm run build`, and `npm test`; focused tests are in `test/context-native.test.ts`. See [validation results](validation.md).
