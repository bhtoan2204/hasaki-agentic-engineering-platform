# Task memory aging

Status: **implemented** (approved plan, with the deviations listed in section 10).

Task memory (`category = 'task_memory'`) only grows today: nothing archives, merges or removes it, so stale items
accumulate and every step re-checks them. This document records how memory works now (with file:line references),
then proposes a deterministic, reversible aging job.

## 1. How it works today

### 1.1 Run memory (`src/knowledge/memory.ts`)

- `extractRunMemory(runId)` (`memory.ts:138`) runs after a COMPLETED, non-evaluation run with an owner. Per
  repository it builds two items with `buildMemoryItems` (`memory.ts:60`), keyed `memory.run-<id>.<repo>`
  (`memory.ts:83`):
  - `.facts` (`memory.ts:103`): platform-derived facts (changed files, commit, verification and test outcomes),
    `enabled: true`, `trust: "verified"` (`memory.ts:106-109`).
  - `.conclusions` (`memory.ts:120`): agent summaries and decisions, quoted, `enabled: false`,
    `trust: "unverified"` (`memory.ts:126-129`). Only `reviewMemory` (`memory.ts:227`), reached from
    `POST /api/knowledge/:key/approve|reject` (`src/api/routes/knowledge.ts:270-292`), sets `trust` to
    `approved` (and enables it) or `rejected` (and keeps it disabled).
- Items are created owner-private (`ownerId: run.owner_id`), scope `REPOSITORY`, `metadata.load = "on_demand"`,
  with provenance in `metadata.memory` (`MemoryMeta`, `memory.ts:44-58`): `run_id`, `repo`, `commit_sha`,
  `base_branch`, `files`, `trust`, `extracted_at`, `approved_by/at` (`memory.ts:207-219`). An existing key is never
  overwritten.

### 1.2 Freshness (`memoryFreshness`, `memory.ts:270-354`)

Returns `{ state, reason }` with a free-text reason:

| State         | When                                                                               | Reason text (line)                        | Recoverable?                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| UNKNOWN       | no `metadata.memory`                                                               | "no provenance" (275)                     | no                                                                                                                            |
| UNKNOWN       | no or malformed `commit_sha`                                                       | "no commit recorded" (277)                | no                                                                                                                            |
| UNKNOWN       | `files` missing                                                                    | "no file list recorded" (278)             | no                                                                                                                            |
| UNKNOWN       | no `repoDir` or it does not exist                                                  | "repository not available locally" (280)  | depends: the caller passes `null` when the repository is **not registered**, a path when it is registered but not cloned here |
| UNKNOWN       | `origin/<base>` ref missing                                                        | "… not available" (289)                   | transient                                                                                                                     |
| UNKNOWN       | last fetch older than 24 h (`MEMORY_REF_MAX_AGE_MS`, 258)                          | "… fetched too long ago …" (303-306)      | transient                                                                                                                     |
| UNKNOWN       | commit not in this clone                                                           | "commit … is not in this clone" (311-315) | permanent **if** the clone was fetched recently (history rewritten, branch deleted and gc'd)                                  |
| FRESH         | no files                                                                           | "no files to go stale" (317)              | —                                                                                                                             |
| STALE / FRESH | files changed on the base since the merge-base **and** differ from the task commit | (321-350)                                 | STALE is proof                                                                                                                |
| UNKNOWN       | git error                                                                          | "git error: …" (352)                      | transient                                                                                                                     |

`freshCache` (`memory.ts:260`) is a module-level `Map` with no bound, keyed
`repoDir|commit|baseSha|files` (`memory.ts:318-319`). The base SHA changes on every fetch, so the map grows for the
life of the process (only FRESH/STALE results are cached, `memory.ts:343`).

Callers:

- `buildStepInput` (`src/workflow/context.ts:393-426`): every `task_memory` item the resolver applied is checked;
  only `verified`/`approved` and FRESH items stay in `res.applied`. Excluded keys and every state are recorded in
  the snapshot's `prompt_plan.memory_excluded` / `memory_freshness` (`context.ts:558-559`). This runs inside the step
  transaction `c` while git is spawned (bounded by `GIT_TIMEOUT_MS`, `memory.ts:25`).
- `search_task_memory` (`src/agent/contextTools.ts:417-469`): each hit is checked (`contextTools.ts:448`); content is
  returned only for FRESH task memory.

### 1.3 Lessons (`src/learning/lessons.ts`)

- `extractLessons(runId)` (`lessons.ts:302`) derives deterministic candidates (`lessonsFromRun`, `lessons.ts:88`):
  _negative_ (independent review FAIL findings, weakened tests, later `regression_reported` / `rollback_reported`,
  `pr_closed`) and _procedural_ (required tests that passed). Key
  `memory.lesson.<purpose>.<repo>.<claimHash>`; `claimHash` covers purpose + repo + subject (`lessons.ts:38`).
- Same key again from another work item → corroboration (`corroborated_by`, `confidence`) (`lessons.ts:328-376`).
- A lesson with the same `subject` and the opposite purpose → both become `status: "disputed"`,
  `trust: "unverified"` (`lessons.ts:378-449`), which removes them from prompt loading and from embedding.
- Loading: `context.ts:429-450` keeps only `status = active` lessons of the same task class, sorted by
  corroboration then recency, at most `config.learning.maxLessons`.
- Nothing ever disables or removes a lesson.
- Observation kinds, checked in the code: `regression_reported`, `rollback_reported` and `tests_failed` all exist
  (`OBSERVATION_KINDS`, `src/learning/observations.ts:14-31`; CHECK constraint in
  `migrations/076_outcome_observations.sql:6-10`). They are not equivalent evidence:
  - `regression_reported` / `rollback_reported` are **manual** reports posted for a run through
    `src/api/routes/learning-delivery.ts:50-52`. They are a later statement about that run's change.
  - `tests_failed` is **platform-derived at run completion** from the run's own ladder rung `not_reached`
    (`observations.ts:164-183`) and is superseded by a later `tests_passed` of the same subject. It describes the run
    that produced the lesson at the time it finished, not a later contradiction, so it is **not** used by 6a.

### 1.4 Chat memory (`src/chat/memory.ts`)

- Key `memory.chat.<sha256(normalized claim)>` (`memory.ts:46-47`), owner-private, scope GLOBAL, `load: on_demand`.
- `remember` (`chat/memory.ts:73`) stores `preference` / `correction` (user-typed statements, `trust: "human"`) and
  `procedure` (`trust: "verified"`, from a succeeded `chat_operations` row via `learnProcedure`,
  `chat/memory.ts:178`, with `operation_id` in metadata). The same claim again bumps `count` and `last_seen_at`.
- `recallMemories` (`chat/memory.ts:233`) loads enabled memories of the owner (lexical + semantic, top 5).
- No contradiction handling: "always X" and "never X" both stay.

### 1.5 Registry columns

- `knowledge_items.enabled` (`003_knowledge_repositories.sql:35`): disabled items are excluded by `candidates`
  (`src/knowledge/service.ts:478-505`) and by `retrieval.eligible_sources`.
- `superseded_by` / `superseded_at` / `expires_at` (`022_knowledge_evolution.sql:11-15`). The resolver joins the
  successor only **while it is enabled** (`service.ts:501`): if a successor is later disabled, the superseded item
  applies again.
- `knowledge_audit` (`003_knowledge_repositories.sql:53-59`): `item_id ... ON DELETE CASCADE`. Toggling `enabled` writes
  `enabled`/`disabled` rows (`service.ts:358-368`).
- `knowledge_versions` (`003_knowledge_repositories.sql:40-51`): metadata lives on the version; changing metadata
  creates a new version.
- `knowledge.remove` (`service.ts:377-421`) deletes the item. Versions **and audit rows go with it** (cascade). Only
  shared items leave a tombstone in `knowledge_deletions` (`048_knowledge_deletions.sql`); private items — all task
  memory — leave nothing.

### 1.6 Usage tracking

- `knowledgeUsage(key)` (`src/knowledge/usageRepository.ts:3-22`) finds snapshots whose `content.knowledge` contains
  the key. It is a JSONB containment scan over `context_snapshots` with no supporting index, limited to 100 rows:
  fine for one item's detail page, not for a job that ages thousands of items.
- `context_snapshots.content.knowledge` lists every applied item **after** the freshness filter
  (`context.ts:567-580`), and `prompt_plan.knowledge` says whether each was disclosed inline or in the index. So a
  snapshot does tell when an item was offered to a prompt; counting requires the same scan.
- Tool reads (`search_task_memory`) are recorded in `agent_context_tool_calls` (`031_platform_native_context.sql:18-33`,
  written by `src/agent/toolRuntime.ts:150`) with evidence refs, also unindexed by item.
- Chat recall leaves no usage record at all.

**Conclusion:** we can reconstruct "last loaded / how often", but not cheaply. Aging needs a dedicated usage table
(section 3.2).

### 1.7 Semantic retrieval (`migrations/084_semantic_retrieval.sql`)

- `retrieval.eligible_sources` (`084:16-37`) excludes items that are disabled, superseded, expired, or task memory
  without `trust` in (`verified`, `approved`) (chat memory is always eligible while enabled).
- Every INSERT/UPDATE of `knowledge_items` and every new version enqueues the item (`084:85-99`). The Go worker
  removes the rows of ineligible sources (`go/internal/retrieval/worker.go:23`, `store.go:110-120`), and
  `enqueueMissing` sweeps sources that became ineligible without a write (`store.go:194-205`, expiry).
- `retrieval.sources`, `retrieval.chunks`, `retrieval.queue` reference `knowledge_items(id) ON DELETE CASCADE`.

**Conclusion:** archiving (`enabled = false` or `superseded_by`) already removes the embeddings, restoring re-enables
and re-enqueues, and hard deletion cascades. No retrieval change is needed.

### 1.8 Existing retention jobs

- `purgeDebugEventsThrottled` (`src/workflow/scheduler.ts:84-97`): at most once an hour per process, called from the
  scheduler's reconcile tick (`scheduler.ts:686`); one `DELETE … WHERE created_at < now() - days` each for DEBUG
  traces and verification evidence (`src/agent/verifyEvidence.ts:360-367`). Days from config
  (`TRACE_DEBUG_RETENTION_DAYS`, `VERIFICATION_EVIDENCE_RETENTION_DAYS`, `.env.example:100-101`).
- Code-intelligence overlays (`src/codeIntelligence/indexer.ts:281-287`): `DELETE` of completed overlays older than
  `config.codeIntelligence.retentionDays`, guarded by "no live run references it".
- `registerReconcileTask(name, task)` (`scheduler.ts:103-115`) runs extra periodic work on the same tick, single-flight
  per process.
- None of them is multi-instance coordinated (they are idempotent single statements). Retention settings live in env
  only; the Settings page (`src/platform/operatorSettings.ts`) has none.

### 1.9 Audit trail of past runs

`context_snapshots` (`002_workflow_core.sql:101-113`) are immutable (update trigger) and store, per applied item,
`id, owner_id, key, version, category, scope, title, reason, **content**, **metadata**` (`context.ts:567-580`).
`agent_context_packs` (`031:2-12`) are immutable too. Neither references `knowledge_items` by foreign key.

**Conclusion:** deleting an item does not break the audit trail of past runs: what each step was given is in its
snapshot. What _is_ lost today on deletion is the item's own history (versions and `knowledge_audit` cascade), which
section 3.1 fixes.

## 2. Scope and principles

- Only `category = 'task_memory'` is aged: run memory (`memory.run-*`), lessons (`memory.lesson.*`), chat memory
  (`memory.chat.*`). Curated categories are never touched; the job's queries filter on the category.
- Deterministic: SQL and git only, no model calls.
- Reversible: archiving sets `enabled = false` (plus `superseded_by` for replacement) and records the reason. Hard
  deletion is a second, later step.
- Ownership and visibility never change: the job never writes `owner_id`, scope or applicability.

## 3. Data model (migration `111_task_memory_aging.sql`)

### 3.1 Aging state and durable audit

```sql
CREATE TABLE knowledge_aging (
  item_id        BIGINT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
  state          TEXT NOT NULL CHECK (state IN ('dormant', 'archived', 'superseded', 'restored')),
  policy         TEXT NOT NULL,   -- replacement | stale | unknown | unapproved | disuse | lesson_contradicted |
                                  -- lesson_disputed | chat_contradicted | procedure_failed | cap | manual
  reason         TEXT NOT NULL,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  pinned         BOOLEAN NOT NULL DEFAULT false,  -- restored by a person: never aged automatically again
  unknown_since  TIMESTAMPTZ,                     -- first time a permanent UNKNOWN reason was observed
  unknown_code   TEXT,
  checked_at     TIMESTAMPTZ                      -- last freshness check by the job (spreads the work)
);
CREATE INDEX knowledge_aging_archived ON knowledge_aging (at) WHERE state IN ('archived', 'superseded');

-- Audit survives deletion: keep the row, remember which item it was.
ALTER TABLE knowledge_audit ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE knowledge_audit ADD COLUMN item_key TEXT;
ALTER TABLE knowledge_audit ADD COLUMN owner_id BIGINT;
ALTER TABLE knowledge_audit DROP CONSTRAINT knowledge_audit_item_id_fkey,
  ADD CONSTRAINT knowledge_audit_item_id_fkey FOREIGN KEY (item_id) REFERENCES knowledge_items(id) ON DELETE SET NULL;
UPDATE knowledge_audit a SET item_key = i.key, owner_id = i.owner_id FROM knowledge_items i WHERE i.id = a.item_id;
```

Why a table instead of item metadata: metadata lives on `knowledge_versions`, so writing aging state there would
create a content version per decision and re-embed the item. A side table keeps aging out of content history.

Why change `knowledge_audit`: the requirement "every delete writes an audit row" is impossible while audit rows
cascade with the item. `SET NULL` + `item_key`/`owner_id` keeps them, and also keeps the audit of items deleted by
hand through `knowledge.remove` (today it is lost). Audit rows hold attribute changes, never content.

Audit actions written by aging: `archived`, `superseded`, `dormant`, `restored`, `purged`, each with
`detail = { state, reason, at, policy, by }`.

### 3.2 Usage

```sql
CREATE TABLE knowledge_usage (
  item_id        BIGINT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
  last_loaded_at TIMESTAMPTZ NOT NULL,
  loads          BIGINT NOT NULL DEFAULT 0
);
```

Usage is **best-effort and never written inside the step transaction.** `beginAttempt` builds the context inside
`withTx` (`attempts.ts:129`, `buildStepInput`/`resolveContext` at 192-194) while `memoryFreshness` may be spawning git, so a
write there would make two runs of one owner that load the same memory item queue on one row until the first
commits.

- `resolveContext` only _collects_ the keys of the applied `task_memory` items in its result. `beginAttempt` registers
  the write with the `afterCommit` hook that `withTx` already provides (`db/pool.ts:203-253`: runs after a successful COMMIT,
  after the client is released, and a callback error is logged but never fails or rolls back the caller), and the hook
  hands the work to `background()` (`src/workflow/background.ts:11`). A failure is swallowed with `ignoreError`; losing a
  usage tick is acceptable.
- One statement per snapshot, ids sorted so concurrent writers lock rows in the same order:
  `INSERT INTO knowledge_usage … SELECT unnest($1::bigint[]) … ON CONFLICT (item_id) DO UPDATE SET last_loaded_at = now(),
loads = knowledge_usage.loads + 1 WHERE knowledge_usage.last_loaded_at < now() - interval '5 minutes'`. The `WHERE` makes
  a hot item cost at most one row update every five minutes; `loads` therefore counts "distinct five-minute windows", which
  is all the aging policies need.
- The same helper is called, also in the background and after the tool has answered, by `search_task_memory` for hits that
  returned content (`contextTools.ts:448-469`) and by `recallMemories` for chat recall (`chat/memory.ts:233`).
- Backfill: the aging job fills `knowledge_usage` from `context_snapshots` in id-cursor batches (bounded, resumable),
  not inside the migration. Until an item has a usage row, its `created_at` stands in for "last loaded".

## 4. Policies and defaults

All thresholds come from `config.memoryAging` (section 6). "Archive" means: `enabled = false`, a
`knowledge_aging` row (`state = 'archived'`), and an audit row, in one short transaction.

| #   | Policy              | Applies to                                                        | Rule                                                                                                                                                                                                                                        | Default |
| --- | ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Replacement         | `.facts` items; separately `.conclusions` with `trust = approved` | A newer item of the same owner and repo, same kind, enabled, whose `files` ⊇ the older item's `files` (older `files` non-empty) supersedes the older one: `superseded_by`, `superseded_at`, **and** `enabled = false` (state `superseded`). | on      |
| 2   | Confirmed stale     | enabled run memory (`verified`/`approved`)                        | The job's own freshness check returns STALE → archive with the reason (the changed files).                                                                                                                                                  | on      |
| 3   | Permanently unknown | enabled run memory                                                | A **permanent** reason code observed continuously for N days (see the notes below). Transient codes clear `unknown_since`.                                                                                                                  | 14 days |

| 4 | Never approved | `.conclusions` with `trust` unverified or rejected | Not approved within N days of `extracted_at` → archive (state `archived`, policy `unapproved`); then the purge rule. | 30 days |
| 5 | Disuse | enabled `task_memory` except user-stated chat memory | No load for N₁ days → `dormant` (ranked last); no load for N₂ days → archive. Approved run memory uses the longer pair. | verified: 60 / 120 days; approved: 120 / 240 days; lessons: 90 / 180 days |
| 6a | Lesson contradicted | `procedural` lessons | A `regression_reported` or `rollback_reported` observation whose `run_id` is **the lesson's own evidence run** (`metadata.memory.evidence.run_id`), observed after the lesson was extracted → archive. A report on a _different_ run that touched one of the lesson's files, same repo, observed after extraction → `dormant` only, never archive. | on |

| 6b | Lesson disputed | lessons with `status = disputed` | Still disputed after N days (no new corroboration) → archive. | 30 days |
| 7a | Chat contradiction | `preference`/`correction` | A newer statement supersedes an older one only when, after normalization, the remaining subject text is **exactly equal** and the two polarity markers are an explicit opposite pair (see the notes below). Anything else is left alone. No time-based expiry. | on |

| 7b | Procedure failed | `procedure` chat memory | The most recent finished `chat_operations` row with the same owner, `tool` and `target` as the memory's `operation_id` is `failed` and finished after the memory's `last_seen_at` → archive (policy `procedure_failed`). When the same procedure succeeds again (`learnProcedure` → `remember` finds the key) it is **restored automatically and not pinned**. | on |

| 8 | Cap | enabled `.facts` + approved `.conclusions` per owner and repo | Beyond N, archive the least recently loaded first (ties: oldest `created_at`). | 50 |
| — | Purge | items in `archived`/`superseded` state, not pinned | Archived for N days → hard delete (`knowledge.remove`), audit row `purged` kept. | 90 days |

Notes on the changes from the original brief:

- **Replacement also disables the older item.** The resolver ignores `superseded_by` once the successor is disabled
  (`service.ts:501`). Without `enabled = false` the older item would come back when the newer one is archived later.
- **Replacement does not cross kinds.** Newer verified facts never supersede approved conclusions: they describe
  different things.
- **Permanent UNKNOWN needs a reason code**, not text matching: `memoryFreshness` gains a `code` field
  (`no_provenance`, `no_commit`, `no_files`, `repo_unregistered`, `repo_missing`, `base_missing`,
  `fetch_old`, `commit_missing`, `git_error`) with the same states and reasons as today. The job separates
  "repository not registered" from "registered but not cloned on this instance", which today share one reason.
  - **Permanent, on any instance** (the data is in the shared database): `no_provenance`, `no_commit`, `no_files`,
    `repo_unregistered`.
  - **`commit_missing` is permanent only when the checking instance is the run's worker instance**
    (`workflow_runs.worker_instance`, migration 018; `config.instanceId`, the same comparison `recovery.ts:82` makes)
    and the fetch is recent. The run id comes from `metadata.memory.run_id` (lessons: `evidence.run_id`). On any other
    instance the task's worktree and branch exist only elsewhere, so the commit is "not in this clone" while the item
    is still valid on its origin: that is **transient** there. A run without a `worker_instance` (legacy rows) is
    never judged permanent through `commit_missing`.
  - **Transient, never counted:** `repo_missing`, `base_missing`, `fetch_old`, `git_error`, and `commit_missing` on a
    non-origin instance. Each clears `unknown_since`.
- **Never-approved conclusions are archived, then purged** by the normal purge window rather than deleted at once,
  so even this deletion is reversible for 90 days.
- **"Lose priority" is a state, not the `priority` column**: dormant items are ranked after active ones in the
  on-demand index (`src/context/plan.ts`) and the lesson top-N (`context.ts:441-450`). They remain findable through
  `search_task_memory`, and any load clears `dormant`.
- **User-stated chat memory never ages by time** (preferences and corrections are excluded from disuse); only 7a
  supersedes them.
- **A person's Restore pins the item**, otherwise the next pass could archive a restored STALE item again. A pinned item
  is exempt from automatic aging until someone unpins it. **Automatic restoration never pins** (7b): a procedure that
  succeeds and then fails again simply cycles between active and archived, and must stay eligible for aging.
- **7a is deliberately narrow.** This is text the user wrote, so a wrong match silently loses it.
  - Polarity pairs are an explicit closed list: affirmative (`always`, `from now on`, `luôn`, `luôn luôn`) against
    negative (`never`, `do not`, `don't`, `đừng`, `không bao giờ`). Only the leading marker (the one `PREFERENCE` matches
    at the start of the sentence, `chat/memory.ts:32-33`) counts.
  - The _subject_ is the claim after that marker, normalized with the existing `norm` (case, NFKC, whitespace, trailing
    punctuation). Supersede only when the subjects are **identical strings** and the markers are an opposite pair.
  - A sentence with more than one marker, a negation inside the subject, or a marker outside the list is never matched.
  - Not matching is the safe default: both statements stay active. Superseding is reversible and visible: the older
    memory stays in the owner's chat-memory list (`chatMemories` returns disabled items too) marked as replaced, with the
    claim that replaced it, and the owner can restore it.

## 5. Job design

- Registered with `registerReconcileTask("memory_aging", …)` (`scheduler.ts:103`) and self-throttled to once per
  `intervalMinutes` (default 60) per process, like `purgeDebugEventsThrottled`. It never runs on a worker lane, so it
  cannot delay workflow steps.
- **It does not block the other reconcile tasks.** `reconcile()` (`scheduler.ts:685`) starts every registered task with
  `for (const task of reconcileTasks) void task();`. None is awaited, so a slow pass delays nothing else on the tick.
  `registerReconcileTask` keeps each task single-flight (`running`), so passes never overlap in one process, and a
  failure is logged by `logError`. All git work is asynchronous (`execFile`), so the event loop is not blocked either.
  A test will assert that another reconcile task registered on the same tick starts while a slow aging pass is in flight.
- **Multi-instance:** each claim is a short transaction that takes `pg_try_advisory_xact_lock(<aging key>, <phase>)` and
  marks the batch (`UPDATE knowledge_aging … SET checked_at = now() … FOR UPDATE SKIP LOCKED`). Another instance finds
  the lock taken or the rows claimed and skips.
- **No git inside a transaction, and a bounded pool footprint:** the pass holds at most one connection at a time and
  never while git runs. Phase 1 reads provenance and commits, phase 2 runs git with no connection held, phase 3 applies
  each decision in its own short transaction, guarded by `WHERE enabled AND current_version = $seen AND NOT pinned`, so a
  concurrent approval, restore or new version wins.

### 5.1 Git cost, concurrency and time budget

Today one `memoryFreshness` call spawns up to six git processes (`rev-parse` of the base ref, `rev-parse --git-common-dir`,
`cat-file`, `merge-base`, two `diff`), so 200 items would be about 1,200 spawns. The job is shaped to avoid that:

- **Once per repository and pass:** `memoryFreshness` is split (same results, same reasons) into
  `repoFreshnessContext(repoDir, base)`, which resolves the base SHA, the git common dir and the age of the last fetch
  once, and `memoryFreshnessIn(context, meta)`, which does the per-item work (`cat-file`, `merge-base`, two `diff`: four
  spawns). The existing callers keep calling `memoryFreshness`, which composes the two, so prompt loading is unchanged.
  Items are grouped by (repo, base branch), so each context is computed once.
- **Concurrency limit:** at most `MEMORY_AGING_CONCURRENCY` (default 4) freshness checks run at the same time across all
  repositories. Each spawn already has `GIT_TIMEOUT_MS` (30 s, `memory.ts:25`).
- **Time budget:** a pass stops claiming new work after `MEMORY_AGING_BUDGET_SECONDS` (default 60). Work is claimed in
  small sub-batches of `4 × concurrency` items (16), not the whole 200 at once, so nothing is claimed-but-unchecked when
  the budget runs out, and the worst overrun is one sub-batch (bounded by the git timeout). Oldest `checked_at` first,
  so an interrupted pass resumes where it stopped and every item is eventually visited.
- `batchSize` (default 200) caps items per pass, and the budget caps wall time per pass.
- The set-based SQL policies (4, 5, 6, 7, 8, purge) are single statements with `LIMIT` and cost no git.

### 5.2 Idempotency, restore, UI

- **Idempotent:** every decision is "set state if not already set"; running a pass twice changes nothing.
- **Restore (a person):** `POST /api/knowledge/:key/restore`, allowed for admins and for the owner of a private item, with
  the same visibility checks as approve/reject (`readableKnowledge`). It sets `enabled = true`, clears `superseded_by`
  when aging set it, sets `state = 'restored', pinned = true` and writes the audit row. The retrieval trigger re-enqueues
  the item, so it is embedded again. Unpin: `POST /api/knowledge/:key/unpin`.
- **Automatic restore (7b only):** `state = 'restored', pinned = false`, audit row with
  `by = 'auto: procedure succeeded again'`; it applies only to items archived by `procedure_failed`, never to other
  policies.
- **UI:** the knowledge detail page shows the aging state and reason with Restore / Unpin; the knowledge list gets an
  "Archived" filter (to be confirmed, see the open questions).

## 6. Configuration

`config.memoryAging` in `src/config.ts`, env overrides documented in `.env.example`. Retention settings live in env
today, and the Settings page has none, so this stays env-only.

| Env                                                                        | Default                        |
| -------------------------------------------------------------------------- | ------------------------------ |
| `MEMORY_AGING_ENABLED`                                                     | `true`                         |
| `MEMORY_AGING_INTERVAL_MINUTES`                                            | `60`                           |
| `MEMORY_AGING_BATCH_SIZE`                                                  | `200`                          |
| `MEMORY_AGING_CONCURRENCY`                                                 | `4`                            |
| `MEMORY_AGING_BUDGET_SECONDS`                                              | `60`                           |
| `MEMORY_AGING_UNKNOWN_DAYS`                                                | `14`                           |
| `MEMORY_AGING_UNAPPROVED_DAYS`                                             | `30`                           |
| `MEMORY_AGING_DORMANT_DAYS` / `MEMORY_AGING_DISUSE_DAYS`                   | `60` / `120`                   |
| `MEMORY_AGING_APPROVED_DORMANT_DAYS` / `MEMORY_AGING_APPROVED_DISUSE_DAYS` | `120` / `240`                  |
| `MEMORY_AGING_LESSON_DORMANT_DAYS` / `MEMORY_AGING_LESSON_DISUSE_DAYS`     | `90` / `180`                   |
| `MEMORY_AGING_DISPUTED_DAYS`                                               | `30`                           |
| `MEMORY_AGING_CAP_PER_REPO`                                                | `50`                           |
| `MEMORY_AGING_PURGE_DAYS`                                                  | `90` (`0` = never hard-delete) |

## 7. Also: bounded `freshCache`

Replace the `Map` at `memory.ts:260` with a small LRU (insertion-ordered `Map`: on hit delete and re-insert; on
insert evict the oldest beyond `MEMORY_FRESHNESS_CACHE_MAX`, default 2000). Its keys and semantics stay as they are.

## 8. Tests (planned)

- Unit: policy decisions as pure functions (replacement coverage, permanent vs transient codes, chat polarity, cap
  ordering, LRU eviction).
- Unit, specific to the review points: the usage write is registered through `afterCommit` and absent inside the
  transaction (a failing write does not fail `beginAttempt`); `commit_missing` is permanent only on the run's worker
  instance and transient elsewhere or when `worker_instance` is null; 6a archives only for the lesson's own run and goes
  `dormant` for the same-file case; 7a matches only identical subjects with an opposite listed pair; 7b automatic
  restore leaves `pinned = false` while a person's restore sets it.
- Integration (real PostgreSQL, git fixtures): per-repo context computed once per pass (git spawn count), concurrency
  never above the limit, a pass stops when the budget is exhausted without leaving claimed rows, another reconcile
  task starts while a slow pass runs; each policy archives exactly what it should, with audit rows;
  restore re-enables, pins and re-enqueues retrieval; purge keeps the `purged` audit row and past snapshots; a pinned
  or concurrently approved item is untouched; two concurrent passes never double-apply; curated categories never
  change; git runs with no transaction open.

## 9. Out of scope (observed)

- `buildStepInput` checks freshness inside the step transaction while git runs (`context.ts:418`); that is bounded by
  `GIT_TIMEOUT_MS` but still holds a connection. Aging does not make it worse. Moving it out of the transaction is a
  separate change.

## 10. Implementation notes and deviations

Code: `src/knowledge/agingPolicy.ts` (pure policies), `src/knowledge/aging.ts` (load, claim, apply, restore, job),
`src/knowledge/agingUsage.ts` (usage and dormant lookups; a leaf module), `src/cli/memoryAging.ts`
(`npm run memory:aging -- [--dry-run] [--owner ID] [--repo NAME] [--batch N] [--budget SECONDS] [--json]`),
`migrations/111_task_memory_aging.sql`. API: `POST /api/knowledge/:key/restore` and `/unpin`, `?archived=1` on the
paged list, `aging` on list rows and on the item. Metrics: `memory_aging` in `GET /api/metrics/runtime`.

Where the implementation differs from the plan above, and why:

- **Claiming.** The claim is one short transaction: `pg_try_advisory_xact_lock`, select the least recently examined run
  memory (`checked_at`), mark it, commit. It does not use `FOR UPDATE SKIP LOCKED` on `knowledge_aging`, because most items
  have no row there yet. An instance that cannot take the lock skips that sub-batch; items marked within the interval
  are not claimed again. The git-free policies (replacement, unapproved, disuse, lessons, chat, cap, purge) run on the
  instance that wins one upsert of `settings.memory_aging.pure_pass` per interval, so N instances do not each scan every
  item. Every apply is guarded regardless: it locks the item row, then reads its aging row in a _second statement_ (a join
  would show the state from before the lock wait and let two passes archive the same item twice; an integration test
  covers this).
- **Dormant ranking** applies to the lesson top-N in `buildStepInput` and to `search_task_memory`. It does not reorder the
  generic on-demand disclosure index in `context/plan.ts`; task memory is not inlined there, and touching the planner
  would have changed curated knowledge ranking.
- **Restore never enables unverified agent conclusions.** Restoring a `conclusions` item whose trust is not `approved`
  records the restore (and pins it against re-archiving) but leaves it disabled; approval stays the only way in.
- **Replacement** also needs the successor to be enabled at apply time (the resolver ignores `superseded_by` when the
  successor is disabled); otherwise the decision is refused and the next pass decides again.
- **Metrics.** `memory_aging.active_task_memory.per_owner` is the one owner-keyed metric. It is bounded to the 50 largest
  owners (the rest summed into `other`) and only on the admin endpoint.
- **Audit.** A `BEFORE INSERT` trigger on `knowledge_audit` fills `item_key` and `owner_id`, so every existing writer is
  covered without changing its INSERT.
- **Not changed, on purpose:** how memory is created, the freshness rules (`memoryFreshness` was split into
  `repoFreshnessContext` + `memoryFreshnessIn` and returns an extra `code`; states and reasons are unchanged), curated
  knowledge, and the freshness call in `buildStepInput` (still inside the step transaction; separate task).
