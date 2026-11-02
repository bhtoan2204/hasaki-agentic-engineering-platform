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
