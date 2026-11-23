# Engineering intelligence: Proof-of-Fix, Radar, Impact, Routing, Causal Memory

Five capabilities built on the existing workflow engine, intake queue, chat runtime, code index, knowledge system and
telemetry. Nothing here adds a scheduler, workflow engine, agent runtime, database abstraction or knowledge store.
Each capability works on its own; together they form one lifecycle:

```
Radar finding ─► Intake candidate ─► investigation run ─► impact analysis ─► routing (at run start)
      ─► fix + independent review ─► Proof-of-Fix verdict ─► causal memory ─► knowledge proposal (review) ─► notifications
```

`test/engineering-intelligence.integration.ts` exercises that contract end to end, and checks that each part keeps
working when the others are disabled.

| Capability | Code | Data | Turn on |
|---|---|---|---|
| Proof-of-Fix | `src/agent/proofOfFix.ts`, `src/workflow/proofOfFixStep.ts`, `src/agent/rootCause.ts`, `src/agent/verify.ts` | `fix_proofs` (098) | Built into the `bug-investigation` and `incident-investigation` templates |
| Engineering Radar | `src/radar/detect.ts`, `src/radar/scan.ts` | `radar_findings`, `radar_scans`, `radar_series_state`, intake source `radar` (099) | On by default (`RADAR_ENABLED=0` turns it off). An intake policy for source `radar` feeds the queue |
| Cross-repository impact | `src/impact/contracts.ts`, `index.ts`, `analyze.ts`, `step.ts` | `impact_contracts`, `impact_index_state` (100) | Always available (chat tool, API, `impact` step) |
| Evaluation-driven routing | `src/routing/adaptive.ts`, hook in `src/eval/optimization.ts` | `adaptive_routing_preferences`; decisions in `agent_optimization_decisions` (101) | Opt-in per owner: `POST /api/routing/preference` |
| Causal memory | `src/memory/causal.ts` | `causal_memories`, `causal_memory_versions` (102) | Automatic after every `proof_of_fix` step of an owned run |

---

## Phase 1 — Proof-of-Fix

**What already existed:** the Root Cause First policy (`rootCauseDepth`, `symptomFixSignals`,
`normalizeRemediation`, `enforceRootCauseReview`), the platform-run before/after regression proof (`beforeAfterProof`),
claim provenance (`assessRootCause` caps; `VERIFIED_BY_PLATFORM`), independent review isolation, and Go-only
test-weakening detection.

**What was missing:**
- A run-level verdict and a persisted report.
- Detection of added retries and swallowed errors.
- Test-weakening detection outside Go.
- A measured false-positive and false-negative rate.

**What was built:**
- **`buildFixProof`** produces a deterministic verdict from recorded evidence only.
  - **VERIFIED** requires every one of:
    - a CONFIRMED root cause;
    - at least one platform-verified claim (agent-reported text never counts);
    - a ROOT_CAUSE_FIX remediation;
    - a platform-run regression proof on the tested commit;
    - passing tests;
    - an independent PASS (the step's `independent` flag comes from the workflow definition, not from an output);
    - no unjustified symptom signal.
  - **FAILED** covers failing or weakened tests, an invalid proof, or an independent FAIL.
  - **PARTIAL** and **INCONCLUSIVE** list exactly what is missing.
  - A human-accepted test failure is PARTIAL, and the decision is recorded as a residual risk.
- **Diagnosis mode** for read-only investigations combines the root cause with the evidence report.
- **New signals:**
  - `retry_added` and `error_swallowed` (empty or success-returning handlers, `except: pass`, Go `return nil` on `err`).
  - Test weakening for JS/TS (`.skip`, `.only`, `x*`, removed `it`/`test`), Python (pytest/unittest skips, removed
    `test_*`) and Java (`@Disabled`/`@Ignore`). The test-diff pathspec now covers those languages.
  - The validation-removal regex now matches `isValid…`/`hasValid…`.
- **The `proof_of_fix` builtin action** is append-only, with one row per attempt, so retries, resumes and re-executions
  keep history. FAILED blocks the step (and so the PR); `block_on` adds verdicts. Its structural context type keeps it
  out of the executor import cycle (`test/architecture.test.ts`).
- **Workflow and API:**
  - `bug-investigation`: `… review → proof → pr`.
  - `incident-investigation`: `report → proof` (never blocks).
  - `GET /api/runs/:id/proof-of-fix` (run authorization).

**Measured** (`test/proof-of-fix.test.ts`): symptom-fix signals on 14 labelled diffs (8 symptom fixes, 6 legitimate
fixes) score precision 1.00 and recall 1.00. Before the two detector fixes, recall was 0.75. Test weakening is checked
on 9 labelled diffs. `test/proof-of-fix.integration.ts` covers persistence across retries and FAILED blocking the PR.

**Limitations:**
- Reproduction is still proven after the fix (revert non-test files, run the named test). No separate
  "reproduce first" step runs before implementation; a stated limitation plus alternative evidence caps the verdict
  at PARTIAL.
- Symptom detectors are text heuristics: they flag, the reviewer decides.

## Phase 2 — Engineering Radar

**What already existed:**
- The prod-error scan (Splunk/SigNoz, run as a configured user), with per-scan `prod_error_observations`.
- The `×3 / ≥50` "up" rule.
- The intake queue: idempotent `ingest`, triage, SHADOW/AUTOPILOT, caps.
- Telegram dedupe.
- The reconcile tick.

**What was missing:**
- Robust baselines.
- Latency history.
- Deployment correlation.
- Detection of recurring incidents.
- Detection of workflow and CI failures.
- A correlation layer.
- An intake source for radar findings.

**What was built:**
- **Detection reads only the platform's own tables.** There are no new production queries. Every statement of a pass
  is counted (`radar_scans.queries`; 17 in the integration fixture with 3 series).
  - Input is the **hourly** series of each signature (`prod_error_observations.hourly`, merged across scans): scans
    with different presets or windows (scheduled "today" running totals, 1–72 h manual scans) stay comparable. Days a
    successful scan covered count as zero when they had no events.
  - Spikes and latency regressions: the hourly rate of the newest scan's window against the previous 7 days of hours,
    robust z-score `(x − median) / (1.4826·MAD + 1)` with z ≥ 4, ratio ≥ 2, at least 12 baseline hours and 20 events.
  - New signatures.
  - Retry storms.
  - Recurring incidents: quiet→active **episodes**, or a reopened incident. A steady error never counts as recurring.
  - Deploy correlation from image changes (`radar_series_state`).
  - Persistent workflow-step and CI failures: three or more distinct runs or PRs with the same normalized error.
- **Correlation and dedupe:** one finding per (service, environment, level, signature), with every kind merged in.
  Same-service findings are linked as related. A repeated pass over unchanged data changes nothing (restart-safe).
  Quiet findings resolve after 24 h; a recurrence reopens them.
- **Intake:** the new source `radar` is treated like production incidents (severity floor, read-only workflows only).
  Each finding gets a `RADAR-<fp>` work item with fingerprint, services, evidence references with timestamps,
  severity, confidence, proposed workflow and next action. The `incident_fingerprint` reuses the incident work item
  and investigation path.
- **Autonomy:**
  - No policy: observe only.
  - SHADOW: proposed work items.
  - AUTOPILOT: intake may start an allowlisted read-only investigation.
  - Implementation always needs a human (existing triage).
  - At most 5 ingestions per pass (`config.radar.maxIngestPerScan`).
- **Notifications:** new, reopened or escalated findings of medium severity or higher go through the Telegram
  aggregation buffer and the platform webhook.
- **Audit and APIs:**
  - Every finding change is audited (`radar.finding.*`).
  - Every pass is recorded in `radar_scans` (series, queries, counts, duration).
  - APIs (admin): `GET /api/radar/findings`, `POST /api/radar/findings/:id/status`, `POST /api/radar/scan`.

**Measured** (`test/radar.test.ts`):
- 80 seeded series: 40 stable at four volumes, 10 low-volume, 15 spikes, 5 latency, 5 new, 3 retry, 2 deploy.
- Precision 1.00, recall 1.00, 0/50 false positives on quiet series. Recurrence is included in this count.
- Detection latency: the first scan after onset. A plateau stops alerting once it becomes the baseline.
- `test/radar.integration.ts`: 17 measured statements and well under 100 ms per pass for 3 series; a 72-hour manual scan
  over an unchanged rate produces no finding and no notification.

**Limitations:**
- Signals are what the existing scans collect. Kafka lag, database performance and per-request error rate (no
  request-count denominator) are not collected.
- Deploy correlation needs the image field.
- The model-driven investigation itself is the existing incident workflow, started through intake.

## Phase 3 — Cross-repository impact

**What already existed:** a per-repository tree-sitter index (symbols and relations, proto RPCs, SQL references),
freshness checks, and single-repository impact (`microEvidence`).

**What was missing:** HTTP, Kafka, table and enum contracts, cross-repository links, and an impact API.

**Decision:** contracts are extracted with `git grep` pinned to each repository's base commit and cached per commit
(`impact_index_state`). Only repositories whose base commit or extractor version changed are re-extracted (at most 3
per request, one extraction per repository at a time, serialised across instances by an advisory lock; a failed
extraction backs off 10 minutes; the rest are reported as stale). Extending both the TypeScript and Go tree-sitter extractors would have
forced a full reindex and a rewrite of the parity tests. That is a sensible follow-up if the regex recognisers prove
too coarse.

**What was built:**
- **Recognisers:**
  - Kafka producers and consumers: kafkajs, Spring, segmentio Go structs (role taken from the surrounding struct),
    Python.
  - HTTP routes (express/gin/chi/mux/Spring/FastAPI) and clients (axios/fetch/Go `http.NewRequest`), with
    normalized paths.
  - gRPC services and generated clients. Clients are *inferred*.
  - Table owners (migrations) and readers/writers (SQL in string literals is *inferred*; `.sql` files are *static*).
  - Proto enums.
- **Breaking changes:** a removed provider contract; route method changes; removed or renumbered proto fields; removed
  enum values; dropped, renamed or retyped columns; NOT NULL without a default; removed serialized fields (inferred);
  edits to payment, order or shipment state transitions (inferred semantic risk).
- **`analyzeImpact`** returns:
  - the changed contracts and their counterparts in **readable** repositories, with `file:line@commit` evidence on
    both sides;
  - static or inferred confidence;
  - breaking changes, compatibility checks, candidate regression tests (test files that mention the key), and the
    repositories that need a coordinated update;
  - per-repository freshness and a `partial` flag;
  - related causal memories.
- **Exposed through:**
  - the chat tool `impact.analyze`;
  - the `impact_analysis` step, which runs before the independent review in `bug-investigation`;
  - `POST /api/impact/analyze`;
  - `GET /api/impact/contracts/:repo`.

**Measured:**
- `test/impact.test.ts`: extraction precision and recall 1.00 on 27 labelled lines; breaking-change detection
  precision and recall 1.00 on 14 labelled diffs, including 4 compatible ones.
- `test/impact.integration.ts`, five fixture repositories with a private one:
  - precision and recall 1.00 over 5 scenarios;
  - p50 latency about 50 ms;
  - the private repository is never mentioned;
  - only the stale repository is re-extracted;
  - missing checkouts are reported.

**Limitations:**
- Keys built at runtime (configuration, concatenation) are not guessed.
- Function-call dependencies across repositories exist only through explicit `symbols` (inferred identifier uses).
- The repository UI view is the API; no new page was added.

## Phase 4 — Evaluation-driven routing

**What already existed:** deterministic agent layering (`resolveStepAgent`), benchmark-only recommendations applied
by `applyOptimizationDefaults`, `guaranteeCheck`, health/handoff readiness, and telemetry (latency, tokens,
cost availability, retries, failure category).

**What was missing:** production-outcome ranking, sparse-data rules, preferences, routing decision records, and
replay evaluation.

**What was built:**
- **Data:** outcomes of the final attempt of each agent/coding step generation.
  - *Verified* means the platform's own verification passed (coding) or the step completed (analysis). It is never
    the agent's claim.
  - Plus: the run's independent review verdict, latency, tokens, known cost (unknown cost is not zero), retries,
    re-execution as human rework, and failure category.
  - Evaluation (benchmark) runs are excluded.
- **Eligibility comes first:** enabled providers, required guarantees under enforced isolation, the HIGH_RISK
  sensitive-provider policy, and blocked models. Health (handoff readiness) is checked before applying a choice.
- **Ranking:** by Wilson lower bound on the verified rate, adjusted by preference (`quality_first`, `balanced`,
  `cost_first`).
- **When it acts:** only when:
  - at least two configurations have at least `min_samples` samples; and
  - either verified quality is clearly better (the winner's lower bound exceeds the incumbent's rate), or quality is
    no worse and the winner is at least 20% cheaper (known cost) or faster.
  - Otherwise the defaults stay, with an explicit reason.
- **When decisions happen:** only at run start, through the existing hook. A running step's provider never changes.
- **Overrides respected:** an explicit run provider, a step agent/model, and an applied category recommendation are
  never overridden.
- **Records:** every decision is stored on the step (`routing_decision`) and in `agent_optimization_decisions`
  (`source = adaptive_routing`), including eligible and excluded providers with reasons, evidence, confidence and
  estimates.
- **Replay A/B** (`GET /api/routing/evaluation`, admin): the policy is learned only from outcomes before the cutoff and
  judged after it, against the default configuration. `IMPROVED_OBSERVED` is reported only when the Wilson intervals
  do not overlap — and it is an **observational association** (configurations were historically chosen per task; the
  output carries that caveat), not a controlled experiment.

**Measured:**
- `test/adaptive-routing.test.ts` (8 tests): sparse fallback, clear winner, quality guard, unknown cost, eligibility,
  negligible difference (no action), workflow-specific scope, and replay IMPROVED versus a drift case.
- `test/adaptive-routing.integration.ts`: real engine history; opt-in, explicit override, and the unhealthy-provider
  fallback.

**Limitations:**
- Off by default. It needs enough production history per step type before it acts.
- Chat AUTO admission keeps first-healthy ordering.
- Insights shows decisions through run and step details and the API; no new dashboard was added.
- No optimization is claimed until the replay reports IMPROVED on real data.

## Phase 5 — Causal memory

**What already existed:**
- Knowledge items and versions with owner scope.
- The proposal review pipeline (evidence, dedupe, owner/admin review, rollback).
- Lessons (including negative lessons and dispute marking).
- `memoryFreshness`.
- Lexical and semantic retrieval.
- Repository visibility.

**What was missing:** structured causal records, explicit evidence states, persisted invalidation, contradiction
handling, exact-match recall, and promotion through proposals.

**What was built:**
- **`causal_memories`:** owner-private, versioned in `causal_memory_versions`. Each record holds the incident,
  symptoms, root cause and its evidence references, fix approach, failed approaches, regression tests, verification,
  services, repositories, files, error signatures, PRs, commits and the validity boundary.
- **Status comes from the Proof-of-Fix verdict:**
  - VERIFIED → verified
  - PARTIAL → proposed
  - INCONCLUSIVE → hypothesis
  - FAILED → rejected, stored as a negative record (a caution)
  - Unjustified symptom-only changes are also stored as failed approaches.
- **Updates:**
  - Stronger evidence updates the record; weaker evidence only adds failed approaches.
  - A contradicting verified root cause demotes the record to *proposed* until a human decides.
  - Owner correction and rollback create new versions and are audited.
- **Invalidation:** on the reconcile tick, every 30 minutes and bounded. A record whose cited files changed on the
  base since the recorded commit becomes *outdated*, with the reason kept.
- **Recall:**
  - Exact channels: signature, file, symbol, service, repository.
  - Plus lexical overlap, plus semantic rank for records whose knowledge proposal was approved.
  - Relevance decides inclusion; evidence strength decides order.
  - Outdated records appear only on request, labelled.
  - Records about repositories the actor can no longer read are withheld.
  - Output is token-bounded.
- **Publication:** a verified record becomes a **private** knowledge proposal that the owner reviews. Nothing is
  published to the shared scope automatically.
- **Integration:**
  - Proof-of-Fix: earlier failed approaches become residual risks; the outcome is captured afterwards.
  - The impact analysis output.
  - The chat tool `memory.causal`.
  - The agent context tool `search_causal_memory`.
  - API: `GET /api/causal-memory`, `GET /api/causal-memory/:id`, `POST …/status`, `POST …/rollback`.

**Measured** (`test/causal-memory.integration.ts`):
- Precision@1 1.00 and MRR 1.00 on 8 seeded memories with 8 queries (file or text).
- Mean context about 56 tokens against a 400-token budget.
- Also covered: no cross-user leakage, withholding after access loss, contradiction, correction and rollback, and
  outdated records after a real git change.

**Limitations:**
- The vector channel applies only after a record's proposal is approved; unreviewed records use exact and lexical
  matching.
- Routing does not use causal memory yet.
- Symbols are only filled when a caller passes them.

---

## Operations

- **Migrations** 098–102 are additive. `099` re-creates the intake source CHECK constraints; `101` relaxes two NOT NULL
  columns, guarded by a new source CHECK.
- **Reconcile tick tasks:** `radarTick` (interval-gated, single-flight through an advisory lock) and causal invalidation
  (every 30 minutes).
- **Turning things off:**
  - `RADAR_ENABLED=0`.
  - Delete or disable the radar intake policy (detection continues, ingestion stops).
  - Routing: `{"enabled": false}`.
  - Proof-of-Fix and impact steps: remove them from a custom workflow definition.
- **Audit actions:** `radar.finding.*`, `routing.preference.save`, `causal_memory.status`, plus the existing knowledge
  proposal and run audits.

## Verification

```bash
npm run typecheck && npm run lint && npm test
node --disable-warning=ExperimentalWarning test/run-integration.ts \
  test/proof-of-fix.integration.ts test/radar.integration.ts test/impact.integration.ts \
  test/adaptive-routing.integration.ts test/causal-memory.integration.ts test/engineering-intelligence.integration.ts
```

## Pre-commit audit (2026-11-23): defects found and corrected

An independent review (four reviewers, code only) found the defects below; each was fixed at its root cause and has a
regression test. Benchmark figures in this document are **fixture-scoped** (synthetic or hand-built inputs in the named
test files), regression baselines — not production precision.

| Area | Defect | Correction |
|---|---|---|
| Proof-of-Fix | An implementer could submit its own `regression_proof`/`tested_heads`/`symptom_signals`/`verification`, reaching VERIFIED | The harness drops these platform-only keys from every implementer submission (`withoutPlatformEvidence`); a proof without repository/commit provenance never counts |
| Proof-of-Fix | Soft verification notes (assertions removed, skipped runner) were turned into FAILED | Only the structured hard weakening list fails; soft notes keep a fix below VERIFIED |
| Proof-of-Fix | Author's remediation kind and self-justifications were trusted | The reviewer's (never higher) kind and the reviewer's justifications are authoritative |
| Test weakening | Renames/moves, conditional skips, vendored and non-code "*.test.*" files were hard failures; diff against the moving base | Name-based across files (removed/renamed → soft), skipif/xfail → soft, vendor/node_modules/third_party and non-test files ignored, diff against the merge base |
| Symptom signals | `retryable` flags, `retries:` fields, specific `except X: pass` cleanup flagged | Retry needs a construct (call/decorator/library/loop); only bare/broad excepts are swallowing |
| Radar | Mixed scan windows (daily running totals vs 1–72 h manual scans) produced mass false spikes and webhook posts; steady errors looked recurring; source-wide policy disabled intake; query count hard-coded | Hourly series + covered days, notifications only to radar-policy owners through the Telegram buffer (≤ 10 per pass, no shared webhook), every owner-scoped policy ingested, measured statement count, batched writes, flap suppression |
| Impact | Quadratic regexes on user diffs (server stall), duplicate rows under concurrent indexing, run scope ignored, uncommitted changes missed, moved code reported as breaking, date-named paths dropped, runtime-built keys labelled static | Bounded linear recognisers + 4 KB line / 512 KB diff caps, advisory lock + single-flight, `allowedRepositories` from the run, merge-base-to-worktree diff incl. untracked files, whole-diff comparison, NUL-delimited grep, `${…}`/concatenation/format → inferred |
| Routing | With no measured default, the "best of the rest" could be chosen; outcome query kept the oldest rows inside the run-start transaction; verifier steps counted as outcomes; explicit step model/effort could be replaced; partial cost counted as known | Quality floor (pooled verified rate), newest-first cached read outside the transaction, verifiers excluded, explicit model/effort respected, only fully reported cost is known |
| Causal memory | Unmerged fix branches went outdated; invalidation starved; paraphrases demoted verified records and the next run silently undid it; first-capture race lost records; rollback incomplete | Validity pinned to the merge base, `checked_at` cursor, per-repository files, contradiction = different cause **and** no shared evidence location, unresolved until a human decides, `ON CONFLICT` first capture, rollback restores invalidation fields and is audited, pending proposals retracted when a record stops being authoritative |
| Telegram (a39ff4b) | Null global workflow list let owners allowlist any workflow; autonomous delegation checked only title/repositories; timeouts/budgets attached to runs the policy did not start; delivery cursor could skip a turn; proposals after the cursor; check-then-act limits; failed timeout pause never retried; forwarded commands executed | See telegram-agent-gateway.md: global ceiling, every delegation field must be owner-authored (otherwise a tap), attach only to started runs, deferred turns stop the pass, proposals before the cursor, per-owner serialised decisions counting reservations, timeout retry, forwarded commands refused |

Known, not changed here: general API request bodies are read without a size limit (pre-existing `readJson`); approved
knowledge items derived from a record that later becomes outdated are reported, not auto-deprecated; CI/workflow
failure findings triaged under AUTOPILOT can start the read-only incident investigation.
