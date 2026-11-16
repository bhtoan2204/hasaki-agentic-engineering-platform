# Knowledge evolution: continuous learning with reviewed rule changes

Goal: when a business rule changes during a workflow (a BA answers "refund uses `platform_price`, not `line_amount`
any more"), later workflows follow the new rule, and nobody has to rewrite the registry by hand. The registry must
never contain two contradictory active rules, and every past run must stay auditable.

The design extends the existing knowledge registry. There is no second memory system, no vector store and no new
orchestration layer.

```
 run COMPLETED ──background──► detectKnowledgeChanges(run)                       knowledge/learning.ts
                                 sources: answers · approval comments · re-run instructions · work item (BA ticket)
                                 gate: no human input and no change wording in the ticket → skipped (no tokens)
                                 1 tool-less completion (run's provider): candidates as JSON
                                 deterministic checks: verbatim quote · listed target · scope · not enforced · no secrets
                                 impacts: skills teaching the dropped terms · repositories · workflows · competing rules
                                 ──► knowledge_proposals (pending, deduplicated)                knowledge/proposals.ts
 reviewer (Knowledge ▸ Change proposals) ──approve──► registry write in ONE transaction:
     UPDATE     new version of the item (optional effective_from)
     SUPERSEDE  new item for a narrower scope + target.superseded_by
     DEPRECATE  disabled now, or expires_at = effective date
     CREATE     new item
   ──after commit──► proposeSkillUpdates: draft + validate each affected skill → child proposals (own approval)
 later runs ──► knowledge.candidates(at)  version in effect at `at`
              ──► resolveKnowledge          superseded/expired items dropped where the successor applies
              ──► context snapshot          key + version + content + resolved_at (+ why others were dropped)
 approved ──rollback──► new version restoring the old text / supersession link removed / derived skills rolled back
```

## What existed and was reused

| Need | Existing piece (reused) |
|---|---|
| Versioned, audited knowledge | `knowledge_items` + `knowledge_versions` (append-only) + `knowledge_audit` |
| Deterministic precedence and conflicts | `resolveKnowledge` (scope, `conflict_key`, enforced security policies) |
| What each execution was given | immutable `context_snapshots` (key, version and content of every item) and the item "Usage" tab |
| Verified vs agent memory | `knowledge/memory.ts`: facts trusted, agent conclusions disabled until a human approves them |
| Model calls inside a run | `completeForRun` (the run's provider: Claude, Codex, Cursor or Antigravity) |
| Non-blocking side effects | `background()` after commit (failures are logged and never fail the workflow) |
| Ownership and authorization | knowledge edit rights: shared knowledge needs an admin, private knowledge needs its owner |
| Repository knowledge | `importFromRepositories` (CLAUDE.md, SKILL.md, wiki docs), keyed by file sha |

## What was added

* **Migration `022_knowledge_evolution.sql`** (additive only):
  * `knowledge_versions.effective_from`.
  * `knowledge_items.superseded_by`, `superseded_at` and `expires_at`.
  * a new `knowledge_proposals` table.
  * `workflow_runs.learning`: the per-run detection record.
* **`knowledge/proposals.ts`**: the deterministic lifecycle (create with dedupe, approve, reject, rollback, review
  rights), plus the line diff and rule-term helpers.
* **`knowledge/learning.ts`**: source collection, the analyzer contract and its validation, impact analysis, skill
  drafting and skill validation.
* **`agent/learningModel.ts`**: the model-backed analyzer and drafter. They are registered by the worker
  (`registerDefaultExecutors`); tests inject fakes.
* **Resolver changes**:
  * version selection by effective date (`knowledge.candidates(db, owner, at)`).
  * supersession and expiry (`resolveKnowledge`).
  * the snapshot records `resolved_at` and each dropped item with a reason: `conflict`, `superseded` or `expired`.
* **Prompt**: an evolved rule's header names what it supersedes and when it takes effect. The agent then knows that
  existing code may still implement the old rule.
* **Importer**: a registry item evolved through an approved proposal is never overwritten by a repository file.
  There are two cases (see "Repository files" below).
* **API**:
  * `GET /api/knowledge-proposals?status=&run=&target=`
  * `GET /api/knowledge-proposals/:id` (diff, terms, children, target state)
  * `POST /api/knowledge-proposals/:id/approve|reject|rollback`
  * `POST /api/runs/:id/learn` (re-run detection; `force` re-analyses unchanged inputs)
* **UI**:
  * Knowledge ▸ **Change proposals** (pending count on the button): old vs new, diff, evidence with links to the run
    and step, impacts, validation, child skill updates, approve (with edits to wording, scope and effective date),
    reject, roll back.
  * Item page: superseded-by / replaces, a version waiting for its effective date, expiry, related proposals.
  * Step inspector: why an item was dropped (superseded, expired, conflict).

## Lifecycle

| Status | Meaning |
|---|---|
| `pending` | Stored. It has no effect on any run. |
| `approved` | Applied. `applied` records what was written, which is what rollback uses. |
| `rejected` | Nothing changed. Pending skill updates derived from it become `obsolete`. |
| `rolled_back` | Undone with new writes. History is kept. |
| `obsolete` | A skill update whose parent rule change was rejected or rolled back. |

**Change types**

* **UPDATE**: same item, same scope. The new version applies everywhere the item applies.
  * If `effective_from` is in the future, the previous version keeps being served until then. `knowledge.get` shows
    both `current_version` (newest approved) and `effective_version` (in effect now).
* **SUPERSEDE**: a new item, usually for a narrower scope (one project, repository, market or provider).
  * The new item inherits the target's `conflict_key` and priority, and the target gets `superseded_by`.
  * The resolver drops the target only where the successor is itself applicable (its scope, applicability and
    effective date). Outside that scope the old rule still applies.
  * Enforced items are never dropped by supersession.
* **DEPRECATE**: the target is disabled now, or stops applying at `expires_at`.
* **CREATE**: a new item. It is private to the proposal owner unless an admin approves it as shared.

**Approval rules (deterministic)**

* Review rights follow knowledge edit rights. A change that writes shared knowledge needs an admin; a change to
  private knowledge needs its owner (or an admin with support access).
* Enforced items and `security_policy` items can never be targeted, and no proposal may create a security policy.
* A proposal is made against a target version. If the target changed before review, approval needs
  `accept_current_version`: the reviewer read the newer text first.
* A skill update whose automatic validation failed needs `override_validation`.
* Approve, reject and rollback lock the proposal row and the target rows. Two concurrent approvals apply the change
  once, and both callers get the approved proposal back.
* The reviewer can edit the wording, scope (SUPERSEDE and CREATE) and effective date before approving. The proposal
  stores what was actually applied.

**Rollback**

* UPDATE: a new version restoring the previous text, applicability and metadata.
* SUPERSEDE and CREATE: the created item is disabled and the supersession link removed.
* DEPRECATE: the previous enabled / expiry state is restored.
* Approved skill updates derived from the change are rolled back with it. Otherwise skills would keep teaching the
  rule that was just undone.
* A rollback is refused while a later approved change to the same item is active. Roll that one back first.

## Detection: what counts as a source

Only these inputs are analysed:

| Source | Trust | Where |
|---|---|---|
| Answer to an agent question | human (answered_by) | `workflow_questions` |
| Approval / rejection comment | human (approval.by) | `workflow_steps.approval` |
| Re-execution instructions | human (requested_by) | `workflow_step_attempts.input.pending.reexecute` |
| Work item title and description | requirement | `work_items` |

**What never counts as a source:** agent output, repository text and tool results. The analyzer never sees them, so
an agent's conclusion cannot become a rule. Agent conclusions remain cross-task memory, which stays disabled until a
human approves it.

**Checks on each candidate**

1. Every evidence quote must appear verbatim (after whitespace and case normalisation) in the source it cites.
   A candidate with no matching quote is dropped.
2. UPDATE, SUPERSEDE and DEPRECATE must name a rule that was listed to the analyzer. Security policies are never
   listed.
3. An UPDATE whose scope differs from the rule's own scope becomes a SUPERSEDE. The old rule keeps applying elsewhere.
4. A candidate supported only by the work item text has its confidence capped at 0.6 and is marked for the reviewer
   to confirm with the BA.
5. A candidate is dropped when its text looks like it contains a credential, when the analyzer reply is malformed, or
   when the scope is unknown.

**Cost and idempotence**

* A run with no human input and no change wording in its ticket (`CHANGE_SIGNAL`) is skipped with no model call.
* Otherwise there is one tool-less completion per run, with bounded input: at most `learning.maxRulesInPrompt` rules
  and `learning.maxSourceChars` characters of human input.
* `workflow_runs.learning` stores the input hash. Unchanged inputs are not analysed twice, unless the API is called
  with `force`.

**Dedupe**

* `dedupe_key` is built from: target, scope, effective date, and the substance of the change. The substance is the
  set of identifiers the change introduces (`platform_price`), or the normalised text when there are none.
* A repeat of an open proposal adds its evidence to it instead of creating a new one.
* A repeat of an approved change, or of a change the target already says, creates nothing.

## Skill evolution

After a rule change is approved, `proposeSkillUpdates` runs for each affected skill. Affected skills are the ones
whose text contains a term the change dropped, or that mention the rule, or that the analyzer named. For each one:

1. A drafter (one completion) rewrites only what the rule change requires.
2. `validateSkillUpdate` checks the draft deterministically:
   * it actually changed;
   * it states the new terms;
   * no line still prescribes a dropped term (lines marked as history, such as "previously …", are fine);
   * its size is sane;
   * it contains no credentials.
3. It is stored as a child proposal with the validation result and a diff.
4. Approving it creates a new skill version. Repository `SKILL.md` files are never written.

**Repository files.** Each version records where it came from: the approved version stores
`metadata.evolution.base_source`, the repository file sha it was evolved from. On re-import:

* File unchanged since then: the registry version is kept (`registry_newer`).
* File changed too: a pending `repository_import` UPDATE proposal is opened with the file's text, and the registry is
  not touched (`conflict`).

To make a change permanent in a repository, port the approved text with a normal PR. After that, re-import as usual.

## Retrieval guarantees

* Only enabled items, at the version in effect at the resolution instant. A future-dated version is not served before
  its date; an item whose only version is future-dated is not served at all.
* Superseded items are dropped wherever their successor applies. Expired items are dropped. Enforced security
  policies keep precedence. Existing `conflict_key` precedence is unchanged.
* `read_knowledge` and `search_knowledge` only see the resolved set, so a superseded rule cannot be loaded on demand
  either.
* Each context snapshot stores, for every item, the key, version, content and `effective_from`, plus `resolved_at`
  and the dropped items with their reason. Historical runs remain reproducible: the item "Usage" tab lists the version
  each run received.

## Configuration (`config.json`)

```json
"learning": { "detectChanges": true, "maxRulesInPrompt": 20, "maxSourceChars": 6000, "evolveSkills": true }
```

## Limitations

* Detection runs when a run completes, or on demand with `POST /api/runs/:id/learn`. A decision made in a run that
  fails or is cancelled is only analysed on demand.
* Semantic recall depends on one model call. The model can miss a change (a false negative). It cannot add a
  fabricated change: quotes are verified and nothing applies without approval.
* Effective dates select which rule version a workflow receives. They do not reason about the business date of the
  data being processed, for example refunding an order placed before the change. When that matters, say so in the
  rule text.
* Impact analysis is lexical: identifier overlap and the analyzer's list. A skill that paraphrases the old rule
  without its identifiers may not be flagged.
* `superseded_by` holds one successor. A rule split into several scoped rules (one SUPERSEDE per scope) keeps the
  latest link. The others are still kept apart because SUPERSEDE puts old and new rules in one conflict group: it
  assigns `rule.<key>` when the rule had none, and the more specific scope wins. Rollback leaves that conflict key in
  place, which is harmless.
* Rollback of a change made before later changes to the same item must follow reverse order.
* Proposals made by repository import have no owner (shared). Only admins can review them.
