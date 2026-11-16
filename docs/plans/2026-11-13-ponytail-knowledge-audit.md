# Ponytail integration & Knowledge/Skills consistency audit

## Requirements Document

### Summary
- **Request:** integrate Ponytail (DietrichGebert/ponytail, MIT, v5.3.3 @ `7801d06`) through the existing Knowledge & Skills registry for coding and review steps, audit all knowledge/skills for duplicates, conflicts, unreachable entries and context waste, fix what is verified, and prove the effect with a before/after benchmark on all four providers.
- **Background:** knowledge has grown to 332 items (~289k tokens shared) through repo import, external import (Superpowers, Trail of Bits, Anthropic), memory extraction and manual edits. Selection is opaque past "provided": nothing records whether a skill was actually used.
- **Expected outcome:** one consistent rule set with an explicit precedence order, Ponytail active on a controlled pilot, every skill traceable from selection to evidence of use, and a measured reduction in code volume and context tokens with no drop in verification pass rate.

### Current State (verified, file:line)
- **Registry:** `knowledge_items` / `knowledge_versions` / `knowledge_audit` (migrations/003:22-60). Evolution fields and `knowledge_proposals` with rollback come from migration 022. Tombstones live in `knowledge_deletions` (048). Ownership: `owner_id` NULL means shared (016:63-83). Visibility rules: src/knowledge/visibility.ts:22-33.
- **External packs:** `skills/external/manifest.json` with per-file sha256, `scanSkillText`, Markdown-only, GLOBAL scope (src/knowledge/externalImport.ts:32-130, external.ts:84-120). CLI: `npm run skills:import-external`, whose verify map is hardcoded to 4 repos (src/cli/import-external-skills.ts:25-30). Superpowers is bundled as adapted copies pinned at `22f0b46`.
- **Resolution:** `resolveKnowledge` (src/knowledge/resolve.ts:168-253). Skills are opt-in. Conflicts are resolved only within the same `conflict_key`: enforced first, then most specific scope, then priority (:157-166). Caller: `resolveContext` (src/workflow/context.ts:199-401). Snapshots are stored in `context_snapshots`.
- **Planning:** disclosure tiers inline / index (12) / search, with an inline budget of 8000 tokens (src/context/plan.ts:66-145, config.ts:454-457). Context pack budgets are 16k for review and 20k for coding (src/context/pack.ts:87-95). "Mandatory" is defined two different ways: plan.ts:77-81 vs pack.ts:376-381, where the pack version also counts every `business_rule`.
- **Injection:**
  - All four providers get `systemAppend` as prompt text plus `read_knowledge`/`search_knowledge` over MCP (claude.ts:845, 947-984).
  - Native skills/plugins are off: Claude runs with `settingSources: []`; Codex with `--ignore-user-config --ignore-rules` and plugins disabled.
  - The worktree's own `AGENTS.md` (Codex) and `.cursor/rules` (Cursor) are not suppressed.
- **Telemetry:** `metrics.skills_provided` (key:tier) and `skills_loaded`, which is counted only from `read_knowledge` (claude.ts:1222-1227, platformTools.ts:497). There is no activation evidence. Only 92/1165 attempts have `skills_provided`, because data starts 2026-11-06.
- **Code intelligence:** a symbol index already exists (src/codeIntelligence/{indexer,search,store}.ts, `searchSymbols`, `findDefinitions`).
- **Evaluation:** a versioned eval framework exists (src/eval/*, `npm run bench`). The live provider phase is deliberately blocked: "No verified live provider benchmark connector" (src/eval/providerPhase.ts:54).
- **Provider CLIs present on the dev machine:** `claude`, `codex`, `cursor-agent`, `agy`.

### Audit findings so far (input to FR-2; re-verified by the audit tool)
| # | Finding | Status |
|---|---|---|
| A1 | id 5 `inside-product-worker-usa.claude` has content byte-identical to id 8 `oms-background.claude` (8035 chars), so the import was probably mis-mapped. Also: id 100 = 102 and id 104 = 106 (shared memory). | verified (md5) |
| A2 | TDD and verification-before-completion target step_keys `test`/`regression_test`/`fix_test`, which are `type: command` steps, so they never reach an agent. `targeted_test` is not covered. | verified |
| A3 | Two different definitions of "mandatory" (plan.ts vs pack.ts). | verified |
| A4 | Ids 143 and 306 are exactly 60000 chars, so they were probably truncated at the import cap. | suspected |
| A5 | 52 shared, enabled items were never selected, provided or loaded (7-day window). | verified for the window; reachability not yet proven |
| A6 | Semantic overlaps: debugging (86 `investigate` vs 283 `systematic-debugging`), review (3 `security-review` vs 290 `differential-review`), commit (1/79/7), codebase map (46/60), Fiserv/Stripe doc clusters. | suspected; needs review |
| A7 | Carrier skills (ghtk/spx/ghn, 9–10k tokens each) were truncated in packs 200+ times, which costs context with low yield. | verified |
| A8 | skills/external/NOTICE.md omits brainstorming and receiving-code-review. | verified |
| A9 | The worktree's AGENTS.md and `.cursor/rules` are not reconciled for Codex/Cursor, so content can arrive twice or contradict the registry. | suspected |
| A10 | Private: 13 md5-duplicate groups (34 rows) and 4 duplicate-title pairs. | verified; counts only |

### Decisions (user, 2026-11-13)
- **D1 Integration form:** Ponytail **skills plus a codebase map**. No hooks, no band and no webhook. The map is generated by platform code from `src/codeIntelligence`; Ponytail's `ponytail-map.js` is not executed.
- **D2 Test/comment conflict:** **adapt** the Ponytail copy. Remove its test-sufficiency rules ("one small test", "trivial changes need none") and the `shortcut:` comment requirement, and record both removals in NOTICE.md. TDD and verification keep authority over tests.
- **D3 Remediation:** **auto-apply verified fixes, including in the DB.**
  - Reconciled with the request's constraint "never auto-change shared rules/skills that conflict or have high impact", as follows.
  - Auto-apply is allowed only for changes that are verified, reversible and low-impact, and it goes through the proposal mechanism: proposals are created and auto-approved by the system actor, which keeps the audit trail and rollback.
  - Conflicts, high-impact shared changes, enforced items and security policies always stay as **pending** proposals for an admin.
  - No hard deletes. Private items are never changed by the audit.
- **D4 Benchmark:** a live A/B on **all 4 providers** (Claude, Codex, Cursor, Antigravity). This first requires a live connector that satisfies the existing P2 isolation and cost gates.
- **D5:** unblock live evaluation by implementing the connector (FR-6.1). Do not just delete the guard: deleting it would silently fall back to fixtures, because no live path exists.
- **D6:** benchmark repos = all registered repos except this platform repo.

### Functional Requirements
**FR-1 Ponytail integration** (mandatory)
- FR-1.1: Add `ponytail` (core) and `ponytail-review` as adapted Markdown copies in `skills/external/`, pinned to `7801d06` with sha256 entries in the manifest. Update NOTICE.md (MIT notice, adaptations made). The other skills (`audit`, `debt`, `gain`, `help`), hooks, band, scripts and the per-provider rule copies are excluded.
- FR-1.2: Adaptation, per D2:
  - Keep: the 6-step ladder, "never cut" list, reuse-first, minimal diff, comment-only-why, and the skipped/risk summary.
  - Remove: test-sufficiency rules, the `shortcut:` comment requirement, mode levels (lite/full/ultra/off), and any instructions that reference hooks or slash commands.
  - Add one line stating that tests and verification are governed by the TDD and verification skills.
- FR-1.3: Applicability:
  - `ponytail` applies to implement / fix / refactor agent steps.
  - `ponytail-review` applies to review steps.
  - Use `conflict_key`s so that the reuse/minimal-diff guidance does not duplicate `reuse-first-development` (consolidate per FR-3.3, not stack).
- FR-1.4: Controlled rollout:
  - Imported **disabled by default for production workflows**. It is enabled only through an explicit assignment on a pilot workflow or step (graph-level `skills`) or through a config flag (`knowledge.ponytail.enabled`, default off).
  - Rollback means flipping the flag or removing the assignment. No data migration is needed.
- FR-1.5: Codebase map:
  - A bounded summary (≤2000 chars, configurable) of top-level exported symbols for the repositories the step touches, generated from the `src/codeIntelligence` index.
  - It is added as a context-pack entry only for steps where Ponytail is applied, and it counts against the role budget.
  - If the index is stale or unavailable, the map is omitted, never generated from a live scan inside the prompt path.
  - It reuses or replaces the existing codebase-map knowledge items (46/60) rather than adding a third source (see A6).
- FR-1.6: Provider coverage: all four providers receive semantically equivalent instructions through the existing `systemAppend` + `read_knowledge` path. Provider-native plugin installs are not used.

**FR-2 Knowledge & Skills audit** (mandatory)
- FR-2.1: A read-only audit (`npm run knowledge:audit`, and `GET /api/knowledge/audit` for admins) over built-in seeds, `skills/external`, shared and private DB items. It detects:
  - exact duplicates (content hash);
  - near-duplicates (normalized-text similarity above a threshold, e.g. shingled Jaccard ≥ 0.8);
  - overlapping responsibilities (same step_keys/category with high description similarity);
  - conflicts (a curated set of contradiction rules, e.g. test-first vs test-after, comment policy; plus items sharing `conflict_key`);
  - outdated items (superseded/expired still enabled, truncated at the import cap, referencing missing repos/paths);
  - unreachable items: applicability targets no agent step in any template/workflow, step_keys of `type: command`, a skill unavailable on every provider, or GLOBAL without restricting applicability;
  - excessive context: inline/mandatory items over N tokens, items truncated repeatedly in packs, and token footprint per step role.
- FR-2.2: Usage evidence comes from `context_snapshots`, `agent_context_packs` and `metrics.skills_loaded` over a configurable window.
- FR-2.3: The report classifies each finding as **verified / suspected / needs human approval**. It contains counts per category, scope and ownership, and a proposed action per finding. It is written to `docs/audits/<date>-knowledge-audit.md` and is available as JSON.
- FR-2.4: Private items appear only as aggregate counts for anyone other than the owner, and never with content in shared reports. Visibility uses the existing `visibility.ts` rules.

**FR-3 Conflict resolution & consolidation** (mandatory)
- FR-3.1: Precedence, applied in resolution and stated once in the rendered prompt:
  1. security/business invariants (enforced, `security_policy`, `business_rule`)
  2. mandatory engineering rules
  3. task requirements
  4. applicable skills
  5. optional guidance
  
  Implement by extending the existing ordering in resolve.ts:157-166. Do not add a new resolver.
- FR-3.2: A single definition of "mandatory", shared by plan.ts and pack.ts (fixes A3).
- FR-3.3: Remediation per D3:
  - **Auto-apply** (system-actor proposals, auto-approved, rollback-able):
    - disable exact shared duplicates, keeping the older/canonical item; the duplicate gets `superseded_by` and is not deleted;
    - fix A2 step_keys in the code-owned manifest;
    - NOTICE fixes (A8).
  - **Pending proposals** (admin review): near-duplicate consolidation (A6), conflicts, truncated items (A4), items never used (A5), carrier-skill splitting (A7), and anything that is enforced, a security policy or high-impact (used in more than X% of packs).
- FR-3.4: Keep version history, ownership, scope and audit rows for every change. Add a direct "revert to version N" action for non-proposal edits (gap: the UI only views versions), implemented as a new version, never as an overwrite.

**FR-4 Skill activation tracing** (mandatory)
- FR-4.1: Record per attempt and per skill the states `selected` (resolved), `injected` (tier inline/index/pack plus token count), `loaded` (read_knowledge) and `activated`. `activated` requires evidence:
  - a `read_knowledge` of the body for index/search tiers, plus
  - a parsed "skills applied" declaration in the structured result (the existing stepPrompt.ts:116 ask, now captured in `submit_result`), plus
  - optional skill-specific checks (e.g. TDD: a test file changed before or with the source; ponytail-review: a review output section present).
  
  Injected is never treated as activated.
- FR-4.2: Flag `loaded_unused` (loaded or inline but no evidence) and `provider_limited` (`skillAvailability` false, or the provider lacks a capability).
- FR-4.3: Expose this in the existing metrics API/UI (api/metrics.ts) and per attempt.
- FR-4.4: Provider-native files: detect a worktree `AGENTS.md` / `.cursor/rules` and record them in the snapshot. When the registry already holds the same content (imported by importer.ts), mark it as a duplicate source in the audit (A9). Suppression is a proposal item, not an automatic change.

**FR-5 Quality guardrails** (mandatory)
- Ponytail never replaces gates: the verification loop, the eslint new-errors gate, TDD, independent review, and test-weakening detection are unchanged.
- Benchmark acceptance fails if verification pass rate or test coverage signals regress, regardless of token or LOC gains.

**FR-6 Benchmark** (mandatory)
- FR-6.1: Unblock live evaluation (D5). Facts behind the "lock":
  - It is not a toggle. No live execution path exists. `executeProviderPhase` only runs the deterministic `provider_fixture` (src/eval/providerPhase.ts:50-58).
  - `createEvaluation` hard-sets `blocked` for every `mode: "live"` (src/eval/service.ts:115-117).
  - The CLI refuses live mode (src/cli/evaluate.ts:14-17).
  - The schema caps runs at 30 s / 20k tokens / $2 per case (src/eval/configuration.ts:28-31, config.ts:327-335). Those caps are too small for a real coding task.
  - The guard was added in 27dd2fe (2026-11-08, docs/evaluation/phase6/README.md:9) because no connector enforced hard token/cost budgets and outbound isolation.

  Required work:
  - (a) A live branch in `executeProviderPhase` that reuses the normal agent executor (the same `runAgent` path and provider runners as production steps) inside the eval worktree. Do not write a new provider client.
  - (b) Hard budgets: abort the provider process when cumulative `metrics.tokens` or `cost_usd` exceeds the case cap, using the existing stream token accounting (all 4 providers report tokens; Antigravity reports no cost, so its cost is estimated from tokens × configured price, or it is token-capped only). Wall-clock is enforced through the existing case deadline.
  - (c) Isolation: secret-stripped env (as in verification), the provider sandbox flags already used (`agy --sandbox`, codex sandbox, Claude tool policy), no platform DB credentials in the agent env, and an eval-only throwaway DB.
  - (d) Raise the schema and config limits to realistic, still-bounded defaults (proposed: 1800 s per case, 3M tokens per case, $10 per case, $300 per suite). Keep them admin-configurable, and keep `paid_approval` + admin required.
  - (e) Remove the unconditional `blocked` in service.ts and the CLI refusal. Replace them with a check that the connector prerequisites (a)–(c) hold, and still block with a reason when they don't.

  Covered by tests: budget abort, blocked when a prerequisite is missing, admin and paid approval required.
- FR-6.2: Suite `knowledge-ponytail-v1`: 6–8 representative tasks, covering a Go backend bugfix, a Go feature, a TS feature, a refactor, and a review task. A/B: baseline vs Ponytail pilot config. 4 providers × 2 repetitions.
- FR-6.3: Metrics:
  - context tokens (pack + systemAppend), total tokens and cost, latency;
  - diff size (added/removed LOC, files);
  - duplication (new clones vs base using a token-based clone detector on changed files);
  - verification pass rate, repairs used, regressions (targeted + regression command), and activation evidence (FR-4).
- FR-6.4: Report `docs/evaluation/<date>-ponytail-ab.md`, with per-provider results and statistical caveats for n=2.

### Non-Functional Requirements
- **Security:**
  - No Ponytail hooks or scripts run.
  - Imported text goes through the existing hash and `scanSkillText` checks.
  - No webhook or network egress.
  - The audit never exposes private content across users.
  - Benchmark runs use isolated DBs and no real secrets.
- **Performance:**
  - The audit runs offline (CLI or admin API) and stays out of the hot path.
  - Codebase map generation is ≤50 ms from the index, or skipped.
  - The per-step context token footprint for pilot steps must not grow by more than the map budget (2000 chars ≈ 500 tokens) minus the savings from consolidation.
- **Maintainability:** reuse the existing registry, resolver, proposals, importer, metrics and eval. No new skill engine, workflow engine or parallel registry.
- **Reliability:** checkpoint/resume, re-execution version pinning, and snapshot immutability are unchanged.

### Technical Specifications
- **Touch points:**
  - `skills/external/{manifest.json,NOTICE.md,ponytail*.md}`
  - `src/knowledge/{resolve.ts,proposals.ts,service.ts}`
  - `src/context/{plan.ts,pack.ts}`
  - `src/workflow/context.ts`
  - `src/agent/{claude.ts,stepPrompt.ts,platformTools.ts,telemetry.ts}`
  - `src/api/{routes.ts,metrics.ts}`
  - `web/src/pages/Knowledge*.tsx` (audit tab, revert)
  - `src/cli/` (audit command)
  - `src/eval/*` (connector + suite)
  - new migration only if FR-4 needs a column or table
- **Activation storage:** prefer extending `workflow_step_attempts.metrics` (JSON) with a `skills` array of `{key, version, tier, tokens, state, evidence[]}`. Add a table only if analytics queries need an index.
- **Audit implementation:** one pure module `src/knowledge/audit.ts` (detectors as pure functions over loaded rows plus template step metadata) and a thin loader. The auto-apply path reuses `proposals.ts` create/approve with actor `system:knowledge-audit`.
- **Feature flag:** `config.knowledge.ponytail` = `{ enabled: false, mapChars: 2000 }`. Assignment on pilot workflows goes through templates/graph `skills`.

### Constraints
- Reuse-first and minimal diffs. Do not reimplement existing mechanisms (proposals, rollback, visibility, scanSkillText, codeIntelligence, the eval framework).
- Preserve Superpowers content, the workflow lifecycle, checkpoint/resume, user isolation, and quality gates.
- Ponytail stays off for production workflows until the benchmark passes the acceptance criteria and an admin enables it.
- The live benchmark costs provider quota on four accounts. Abort if cost caps are exceeded.

### Test Requirements
- **Unit (pure):**
  - each audit detector, with fixtures for duplicate, near-duplicate, conflict, unreachable (command step_key), excessive and truncated items;
  - the precedence order;
  - the single mandatory definition;
  - Ponytail applicability (implement/fix/refactor yes; analyze/command no);
  - flag-off means not resolved;
  - map budget and omission when the index is stale;
  - activation state derivation (injected but not activated; loaded without evidence gives `loaded_unused`).
- **Integration (test DB):**
  - external import of the Ponytail entries (hash, scan, NOTICE);
  - auto-apply via system proposals, plus rollback restoring the previous state;
  - pending proposals for conflicts and enforced items;
  - private items untouched and not visible to other users in the audit API;
  - revert-to-version creates a new version;
  - re-execution pinning unaffected.
- **Provider compatibility:** the rendered systemAppend and pack for each of the 4 providers contain the same skill set and precedence statement (snapshot test on `buildSystemAppend` per provider).
- **E2E:** a representative workflow run with a stub/fake provider showing selected → injected → loaded → activated states recorded. Plus one live smoke per provider in the benchmark.
- **Acceptance:**
  - No unresolved verified conflicts remain; all are fixed or have pending proposals.
  - Every finding is classified.
  - The Ponytail pilot shows reduced added LOC and/or context tokens with verification pass rate ≥ baseline and no new regressions.
  - typecheck, build, `npm test` and lint pass.

### Outstanding Issues
- O1: Auto-apply thresholds: what counts as "high-impact" (proposed: used in >10% of packs in the window, or enforced/security/business_rule). Confirm during review of the first audit report.
- O2 (resolved, D5): the user asked to unblock live evaluation. Budgets use the defaults proposed in FR-6.1(d) unless changed.
- O3 (resolved, D6): benchmark tasks may use **every registered repository except this platform repo** (`hasaki-agentic-engineering-platform` / claude-task-platform). Tasks are pinned to a base commit and run in eval worktrees. They never push and never open a PR. Repos holding `.env` or credentials files must have them excluded from the worktree or the agent env (FR-6.1(c)).
- O4 (resolved, verified 2026-11-13):
  - `agy` 1.5.7 runs non-interactively (`-p --output-format stream-json --sandbox --print-timeout`).
  - It reports `usage` {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens} per step and in the final `result`. src/agent/antigravity/stream.ts:176-195 already parses these fields.
  - No `cost_usd` is reported.
  - Overhead is about 10.7k input tokens for a trivial prompt, because of its built-in tool definitions. Count this as a fixed per-session overhead when comparing providers.

## Task Breakdown

### Dependency graph
```
T1 audit core ──► T2 audit CLI/API/report ──► T6 remediation (auto + proposals)
T3 precedence + mandatory unify ─────────────┘
T4 Ponytail import (flag off) ─► T5 codebase map ─► T8 pilot assignment
T7 activation tracing ─────────────────────────────► T9 live connector ─► T10 benchmark ─► T11 rollout decision
```

### Phases
**Phase 1: Audit (read-only)**
- T1 `src/knowledge/audit.ts` + unit tests: pure detectors (FR-2.1), step metadata from templates (agent vs command), usage join (FR-2.2).
- T2 CLI `src/cli/knowledge-audit.ts` (npm script), admin `GET /api/knowledge/audit`, Markdown/JSON report writer (FR-2.3/2.4). Run it and commit the first report under `docs/audits/`.

**Phase 2: Consistency**
- T3 resolve.ts precedence tiers (FR-3.1), a shared `isMandatory` used by plan.ts and pack.ts (FR-3.2), tests.
- T6 remediation (FR-3.3):
  - system-actor auto-approved proposals for verified low-impact fixes (A1 duplicates, A2 step_keys in manifest incl. `targeted_test`, A8 NOTICE);
  - pending proposals for the rest;
  - revert-to-version API + UI button (FR-3.4).

**Phase 3: Ponytail**
- T4 adapted `skills/external/ponytail.md` and `ponytail-review.md`, manifest (sha256, pin `7801d06`, applicability, conflict_key), NOTICE; config flag default off; import tests.
- T5 codebase map from codeIntelligence as a pack entry for Ponytail steps (FR-1.5); consolidate with items 46/60 via proposal.
- T8 pilot: explicit assignment on one non-production pilot workflow/template variant.

**Phase 4: Tracing**
- T7 activation states + evidence (FR-4.1/4.2):
  - `submit_result` skills-applied field;
  - metrics `skills[]`;
  - metrics API/UI;
  - native-file detection (FR-4.4).

**Phase 5: Benchmark & rollout**
- T9 unblock live eval (FR-6.1 a–e):
  - files: src/eval/{providerPhase.ts,service.ts,configuration.ts,runner.ts}, src/cli/evaluate.ts, src/config.ts, docs/evaluation/phase6/README.md;
  - suite cases built from registered repos except this platform repo (D6).
- T10 suite `knowledge-ponytail-v1`, 4 providers × 2 reps, report (FR-6.2–6.4).
- T11 rollout recommendation (enable flag on chosen workflows) for admin decision. Rollback = flag off.

### Execute handoff
- **Decisions:** D1–D4 above. Ponytail is skills-only and adapted, with a platform-generated map. Auto-apply goes only through system proposals. A live benchmark runs on 4 providers after the connector gates.
- **References:**
  - Ponytail clone (read-only, untrusted): `/tmp/claude-1000/ponytail-research/repo` (tag v5.3.3), with skills at `skills/ponytail/SKILL.md` and `skills/ponytail-review/SKILL.md`.
  - Existing patterns: Superpowers adaptations in `skills/external/`; tests in test/external-skills.test.ts, test/knowledge-evolution.test.ts, test/pure.test.ts:117-202, test/context-native.test.ts, test/agent-arch.test.ts.
- **Constraints:**
  - Never run Ponytail scripts.
  - Never hard-delete knowledge.
  - Never change private items.
  - Never enable Ponytail on production workflows.
  - Keep each phase a separate, reviewable commit series. Commits need a `func:` code from the user (TECH-HD-001).
