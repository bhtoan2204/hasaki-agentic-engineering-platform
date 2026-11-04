# Agent Architecture: Single Agent + Skills + Tools

Deterministic orchestration (PostgreSQL workflow engine: DAG, durable steps, checkpoints, retries, approvals) stays
separate from LLM reasoning. Each AI step is **one** Claude Agent SDK session (`ClaudeAgentExecutor`); there are no
domain agents (OMS, Payment, ...). Capability comes from **skills** (knowledge registry) and **tools** (native Claude
Code tools + platform tools + a discoverable integration registry), disclosed progressively.

```
 engine (deterministic) ──► beginAttempt ──► ContextResolver ──► immutable context snapshot (incl. prompt_plan)
                                                   │
                       resolveKnowledge (scope/applicability/conflicts)
                       planKnowledge   (relevance → inline | index | search)
                       planUpstream    (token budget → full | structural summary)
                                                   │
                         ClaudeAgentExecutor (one session; resume when safe)
   system prompt: platform rules · step instructions · INLINE knowledge · INDEX lines · tool-discovery hint
   user prompt:   <untrusted_input> work item · upstream outputs (full or summarized) · answers · feedback
   native tools:  Read Grep Glob Bash TodoWrite Web* (+ Edit/Write for coding) (+ Task/Agent only if delegation)
   platform MCP:  ask_user post_update submit_result prepare_branch
                  read_knowledge search_knowledge read_step_output(attempt?)
                  list_tools describe_tool call_tool  ──► IntegrationTool registry (validated, permission-checked)
   policy:        PreToolUse hook + canUseTool (worktree-only edits, read-only primary checkouts, subagents read-only)
   metrics:       tokens, cost, turns, tool calls/errors, skills loaded, searches, integration calls, subagents, denials
```

## Audit (before this change) and what was added

| Requirement | Before | Now |
|---|---|---|
| Durable engine, single executor | ✅ | unchanged |
| Skill discovery / progressive disclosure | registry + `read_knowledge`, every applicable on-demand item listed; **Claude Code also auto-loaded `~/.claude` skills and plugins** (two mechanisms, duplicates) | relevance-ranked three-tier disclosure; `search_knowledge`; `settingSources: []` by default and `~/.claude/skills` imported once into the registry |
| Dynamic tools | fixed platform tools only | `src/agent/toolRegistry.ts`: discovery → description → call |
| Context management | each upstream output capped at 20k chars, no total budget | token budget with weighted fair share, deterministic structural summaries, `read_step_output(step, attempt?)`, `run.step_history` |
| Subagents | `Task` always available, unrestricted | off by default; per-step `delegation.enabled`; `explorer` / `reviewer` read-only |
| Snapshots | knowledge versions, upstream attempt ids | + `prompt_plan` (disclosure tier + score per item, upstream full/summary, budgets, setting sources, delegation) |
| Observability | transcript events | `workflow_step_attempts.metrics`, `/api/metrics/*`, Insights page, run/step metrics in the UI |

## Skills: one mechanism, three tiers

* Source of truth: `knowledge_items` / `knowledge_versions` (versioned, scoped, audited). Imported from repositories
  (`CLAUDE.md`, `.claude/skills`, `.agents/skills`, cursor rules, wiki docs) and from `~/.claude/skills`
  (`npm run knowledge:import`, or *⟳ Quét repository* in the UI). User-level skills identical to a repository copy widen
  that item to ORGANIZATION scope; interactive/autonomous ones (`execute`, `pr`, `address`, `define`, ...) are imported
  **disabled**.
* Claude Code does not load settings layers in agent steps (`config.agent.settingSources = []`), so no `Skill` tool, no
  user plugins, no user MCP servers inside unattended steps. Set it to `["user"]` to opt back in (then `Skill` returns).
* `planKnowledge` (pure): mandatory items (assigned to the step, enforced policies) are always inline; other inline-type
  items (repository conventions) fill `inlineKnowledgeTokens` by relevance and overflow to the index; on-demand items
  are ranked, the top `knowledgeIndexSize` become index lines, the rest are search-only.
* Relevance (`scoreKnowledge`) is deterministic word overlap with the request (work item + step instructions + upstream
  keywords) over title/key, description and content, with small priors; the reason is recorded.

## Tools: discovery → description → call

`IntegrationTool { name, summary, description, input (zod), readOnly, available(), handler }`. Built-ins (all
read-only): `hasaki_work.get_task`, `hasaki_work.my_tasks`, `jira.get_issue`, `bitbucket.list_pull_requests`,
`repositories.search`, `run.changes`, `run.step_history`. `call_tool` validates arguments, refuses tools that change
state in read-only steps and for subagents, checks availability (credentials) and the run's allowed repositories, and
records `{name, ok, ms}`. Adding an integration = one `registerIntegrationTool` call; nothing in the prompt changes.

## Context budget

`planUpstream` gives every completed ancestor a share of `upstreamTokens` (direct dependencies weight 2); outputs that fit
stay verbatim, the leftover is redistributed, the rest get `summarizeValue` — keys and shape preserved, long strings and
arrays shortened, at the most detailed level that fits. The prompt says which outputs were summarized and how to read the
full value. Per-step overrides: `config.upstream_tokens`, `config.knowledge_index_size`.

## Delegation

Step config `delegation: { enabled: true, agents: ["explorer", "reviewer"] }` adds `Task`/`Agent` and the subagent
definitions. Every subagent tool call reaches the same PreToolUse hook with `agent_id`; the policy then applies the
read-only analysis rules, allows only read-only platform tools, refuses `prepare_branch` / `submit_result` / `ask_user`,
state-changing integrations and nested delegation. `SubagentStart/Stop` are logged and counted.

## Reproducibility

The context snapshot (immutable, hashed) stores resolved knowledge with versions and full text, overridden items, the
prompt plan, upstream attempt ids and the input hash. Transcript events store the exact system prompt, every prompt,
message, tool call/result and turn summary. Attempt metrics store usage and tool activity. Together they reproduce what
the agent was shown and what it did.

## Configuration (`config.json` → `agent`)

| Key | Default | |
|---|---|---|
| `settingSources` | `[]` | Claude Code settings layers for agent steps |
| `inlineKnowledgeTokens` | 8000 | budget for inline knowledge |
| `knowledgeIndexSize` | 12 | on-demand items listed in the prompt |
| `upstreamTokens` | 12000 | budget for upstream outputs |

## Task Result Report (optional final step)

Driven by Hasaki Work `task_ai.ai_suggest`. Code: `src/report/` (parser, evidence, build, executor, evidence store),
`withReportStep` in `src/workflow/engine.ts`, UI `web/src/pages/Report.tsx`.

* **When.** `startRun` parses the work item payload (`parseAiSuggest`). If `report` has at least one section with a
  non-blank item, a `task_result_report` step (type of the same name, migration 008) is appended to the run's **resolved
  graph** — never to the published definition — depending on every terminal step, so it runs after implementation,
  tests, review and PR. Idempotent: not added when the graph already has a report step (custom workflows may declare
  one explicitly; it then reads `ai_suggest` from the work item at run time). `task_readiness` is ignored; `reasoning`
  is context only. JSONB does not preserve object key order, so sections keep their names but not necessarily the
  original order.
* **Evidence (deterministic).** `collectEvidence` builds a catalogue with stable ids from PostgreSQL: implementation
  summaries, analysis and review outputs, command/test results (baseline-aware), logs, commits and changed files of the
  run's worktrees, PRs, human answers, evidence uploaded to the report step, and task attachments (flagged pre-fix).
* **Reasoning (main Claude agent, no tools).** Proposes per requirement `VERIFIED | PARTIAL | MISSING`, cited evidence
  ids and an explanation, plus a summary — in Vietnamese when the suggestion is Vietnamese.
* **Validation (rules cap the proposal).** Unknown/irrelevant ids are dropped; failed tests, stale uploads and pre-fix
  attachments never verify; a screenshot-only requirement is VERIFIED only by an image the user attached to that
  requirement, PARTIAL if an unattached image is cited, otherwise MISSING; an outcome requirement backed only by code
  stays PARTIAL; without the reasoner nothing is auto-verified except human evidence.
* **Human review.** The draft (JSON + Markdown artifacts, also in the attempt output) waits in `WAITING_APPROVAL`
  without holding a worker. Users attach files/notes per requirement (`POST /api/runs/:id/steps/task_result_report/evidence`,
  stored as `evidence` artifacts on the step), regenerate (re-execute → new attempt, previous drafts kept), edit the
  Markdown and approve. Approval finalizes from the persisted draft of the current generation (no new LLM call) and
  records the approver and every unverified requirement as a limitation.
* **Lifecycle.** The run is not COMPLETED until the report is approved. Re-executing any upstream step invalidates the
  report (generation bump) and the next draft uses the latest evidence. Crash/restart: leases are reaped and the step
  retried; drafts and uploads live in PostgreSQL. Nothing is posted to Hasaki Work, no task is closed, nothing merged.

## Re-execute with instructions

`POST /api/runs/:id/steps/:key/reexecute` accepts `{ feedback?, skills?: [knowledge keys], by? }` (both optional — an
empty body is the previous plain re-execute). Skills are pinned to their current version and, together with the
instructions, stored in the step's `pending_input.reexecute` inside the same transaction that bumps the generation and
invalidates dependants — before any job is enqueued — so a worker restart or a job retry uses the same input. The
context resolver injects pinned skills at that exact version (inline, reason "selected for this re-execution") and
records `prompt_plan.reexecute` in the immutable snapshot. The prompt of the new attempt contains the instructions, the
selected skills and the previous attempt's output; a coding step also gets the current worktree state (status, commits,
diff stat) and is told to continue from it — `git restore/stash/checkout --` are denied by the tool policy, so nothing is
discarded automatically. Upstream results and old attempts are kept; dependants are invalidated by the existing
mechanism and approval gates ask again for the new generation. Templates and default prompts are never modified.

Skill **Latency & Service Boundaries** (`latency-service-boundaries`, seeded, opt-in) can be selected at re-execution
or assigned to analysis/coding steps in the workflow editor.

## Harness: verification-and-repair loop (coding steps)

`src/agent/verify.ts`, wired at the end of `claudeExecutor` for `coding_agent` steps.

1. The agent works and calls `submit_result` as before.
2. The platform runs the step's verification in every worktree of the run (`config.verify.command`, default: the
   template's affected-scope `TEST_COMMAND` — `go build ./...` + `go test` of changed packages). Tests already known to
   fail on the same base commit are skipped (`GO_TEST_SKIP`), remaining failures are compared with `origin/<base>`
   (`goBaseline` / `classify`): only new failures count. Removing `func Test…` or adding `t.Skip` versus the base branch
   counts as a failure (verification weakening) unless `verify.allow_test_weakening: true`.
3. Failures become structured diagnostics (packages, tests, compile errors, a bounded output excerpt wrapped in
   `<untrusted_input source="verification:<repo>">`) sent to the **same Claude session** (resume; rebuilt from durable
   inputs if the session is gone). Same tool policy and hooks as the main turn.
4. Bounded: at most `verify.max_repairs` (default 2, max 5) repairs; two consecutive rounds with the same failure
   signature stop early (`no_progress`). The step **fails (not retryable)** unless verification passed — the agent's own
   claim never counts. Human gates are untouched; a question asked during a repair pauses the step and the rounds so far
   are stored in the checkpoint, so the budget survives resume. Cancellation kills the verification process group.
5. Recorded: `output.verification` (summary), attempt `metrics.verification` (outcome, rounds, repairs, duration,
   failure signatures), one log artifact per repo and round, and the gate (`command_sha256`, `max_repairs`, …) in the
   context snapshot's `prompt_plan.verification`. The system prompt announces the gate up front.

Disable per step with `config.verify: false`. The later `test` step of the templates still runs unchanged.

Evaluation (separate from execution status): `GET /api/metrics/summary` → `evaluation` (verification pass rate,
first-try pass rate, repairs, budget-exhausted / no-progress stops, repeated failure signatures, human-intervention
rate) shown on Insights; `npm run bench -- --live` adds hidden acceptance tests per scenario (`correct`), verification
outcome, repairs and human gates per run.
