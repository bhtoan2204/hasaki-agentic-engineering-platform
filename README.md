# Workflow Platform (Claude Task Platform v2)

Workflow-driven AI engineering platform. Engineering requests (**work items**: manual, Hasaki Work) are executed
by reusable, versioned **workflows** made of typed steps (AI agent, coding agent, human input, approval, command,
condition, integration, pull request, task result report). Every step has durable state, attempt history, questions, checkpoints and
context snapshots in PostgreSQL. Five AI agent providers (Claude Code, Cursor CLI, OpenAI Codex CLI, Google Antigravity CLI, and GitHub Copilot CLI)
are orchestrated via a unified execution lifecycle. Bitbucket, GitHub, and GitLab (cloud and self-hosted) are the Git providers.

Importing a task **never** executes anything. You pick a workflow and start a run (or set an explicit automation policy).

### Architecture Documentation

**Current Architecture:**

- [`docs/architecture/architecture-governance.md`](docs/architecture/architecture-governance.md) — Module boundaries, responsibilities, and transactions
- [`docs/architecture/execution-lifecycle.md`](docs/architecture/execution-lifecycle.md) — Unified 9-stage agent harness lifecycle across all providers
- [`docs/architecture/workflow-engine-modularization.md`](docs/architecture/workflow-engine-modularization.md) — Modular engine, state machine, and scheduler
- [`docs/architecture/agent-architecture.md`](docs/architecture/agent-architecture.md) — Single agent + skills + tools model across providers
- [`docs/architecture/performance.md`](docs/architecture/performance.md) — Adaptive execution profiles (MICRO / FAST / STANDARD / DEEP), reuse, and latency
- [`docs/architecture/token-optimization.md`](docs/architecture/token-optimization.md) — Context delivery manifests, compaction, and delta updates
- [`docs/architecture/agent-isolation.md`](docs/architecture/agent-isolation.md) — Bubblewrap OS sandbox isolation and egress allowlists
- [`docs/architecture/repository-access.md`](docs/architecture/repository-access.md) — User-scoped repository permissions and remote identity
- [`docs/architecture/live-updates.md`](docs/architecture/live-updates.md) — PostgreSQL SSE live updates, replay, and fallback polling
- [`docs/architecture/interactive-agent-chat.md`](docs/architecture/interactive-agent-chat.md) — Interactive streaming agent chat and verified operations

**Historical Architecture Documents (distinguished from current behavior):**

- [`docs/architecture/current-state.md`](docs/architecture/current-state.md) — _Historical_: Audit of commit `8c23002` (pre-workflow v1 baseline)
- [`docs/architecture/target-state.md`](docs/architecture/target-state.md) — _Historical_: Initial Phase 1 target specification before multi-provider and GitLab additions
- [`docs/architecture/migration-plan.md`](docs/architecture/migration-plan.md) — _Historical_: Original v1-to-v2 migration roadmap and backfill strategy

## Run

Run one instance per developer, or one centrally hosted backend and worker. Instances can share PostgreSQL repository metadata; each worker provisions its own checkouts from registered Bitbucket, GitHub, or GitLab URLs. Local worktrees and agent sessions stay on the assigned instance.
`HOST=0.0.0.0` exposes that one installation. The default listen address stays loopback.

```bash
docker compose up -d                  # PostgreSQL 17 on 127.0.0.1:55432
npm install
cp .env.example .env                  # Set AUTH_SECRET (random string); configure optional secrets
# Configuration comes from .env and the Settings page only (config.json is not read)
# Git hosting (Bitbucket, GitHub, GitLab) credentials are personal: each user saves them in Integrations.
# Keep the existing AUTH_SECRET in the git-ignored .env; never regenerate it on restart.
# Localhost HTTP works automatically. Set COOKIE_SECURE=1 behind HTTPS.
npm run admin:bootstrap -- --username alice --claim-legacy
# Migrations run before bootstrap, even on an empty database.
# Enter the password twice at the hidden terminal prompt (10–200 characters).
# ADMIN_PASSWORD is also supported; no default password.
npm start                             # runs ensure-bwrap.sh, builds UI (vite build), runs migrations + seeds, then http://localhost:4545
```

The login screen at `/` shows CLI setup instructions when no active admin exists.
Bootstrap leaves an existing account’s password and role unchanged. Creation and legacy claiming commit together.

There is no public signup and no bootstrap HTTP route. `--claim-legacy` assigns existing ownerless private rows
(work items, runs, inbox) to that admin in one transaction. Seeded skills, rules and workflow
templates stay shared (`owner_id` NULL). Unassigned private rows stay invisible until they are claimed.

## Access

| Resource                                                                                                      | Member                                                                                                                    | Admin                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Seeded skills, rules, conventions, workflow templates, shared integration settings                            | Read and use                                                                                                              | Modify, publish, archive                                                               |
| Repositories (list, workspace, ranking, runs, agents, PRs, repository knowledge)                              | Only repositories granted to them (or explicitly shared), further limited by their own Bitbucket/GitHub/GitLab permission | Register, grant, share, revalidate, delete; source access only through their own grant |
| Work items, inbox imports, private workflows, runs and everything under a run, private knowledge, task memory | Own rows only                                                                                                             | Own rows by default. "View the whole team's resources" is explicit and audited         |
| Clone a shared template                                                                                       | Yes, into a private workflow                                                                                              | Yes                                                                                    |
| Promote a private workflow or knowledge item to shared                                                        | No                                                                                                                        | Yes, after review                                                                      |

A run started from a work item keeps that work item's owner. A shared template does not make its runs shared.
Applicability scopes such as GLOBAL and REPOSITORY are not visibility. Task memory extracted from a private run
stays private; approving it does not publish it. Child rows (questions, attempts, artifacts, snapshots, events)
are authorized through their run. Guessing another user's id returns 404.

Personal Hasaki Work, Bitbucket, GitHub and GitLab credentials belong to the user and are encrypted with `AUTH_SECRET`.
A missing personal account does not fall back to someone else's token; no Git credential is read from the environment.
The server does not open a Hasaki login window; paste a
token. Telegram's bot is admin-managed; private step notifications go only to that user's chat. Production-error
monitors stay shared, and a member who investigates gets their own work item. The shared error list does not
link to another member's task.

Claude, Cursor, Codex, Antigravity and Copilot credentials are the worker machine's admin-managed logins in this version. Personal agent
accounts per user are not included. Agents share one OS user. When Bubblewrap is installed and `isolation.mode: enforce` is set,
all agent steps execute inside a secure sandbox (private HOME/tmp, hidden credentials and other runs, network restricted to provider egress allowlist).
When `isolation.mode: off`, agents run with application tool policy only on a trusted workstation.

Development: `npm run dev` (backend with --watch) + `npm run dev:web` (Vite hot reload on http://localhost:5173,
proxying /api to :4545). `npm run typecheck` checks backend and UI (`tsc -p .` and `tsc -p web`). `npm test` runs the unit tests (`test/*.test.ts`) in seconds: no PostgreSQL, no real CLIs or agents. `npm run test:integration` runs `test/*.integration.ts` (PostgreSQL, real git/go/CLI processes) on one private PostgreSQL cluster (initdb, from `PATH`) started for the run, with a fresh `platform_test_<uuid>` database per test file; `npm run test:all` runs both, as CI does. A single integration file runs alone with `node --disable-warning=ExperimentalWarning --import ./test/setup.ts --test test/<name>.integration.ts`.

The PostgreSQL pool defaults to 10 connections and waits at most 15 seconds for a free client
(`database.poolMax` / `database.connectionTimeoutMillis` in config.json, or `DATABASE_POOL_MAX` / `DATABASE_CONNECTION_TIMEOUT_MS`).

## Self-development

The running installation can be a normal registered repository. An administrator registers its GitHub (or Bitbucket, or GitLab) URL, default branch and category, then grants access per user. Admin rights do not grant source access. The workflow `platform-self-development` is the built-in template: analyse, confirm repositories, plan, approve, implement in a worktree, targeted tests, independent review, full `npm test`, then a pull request. It uses the existing engine, checkpoints and UI.

The live checkout is never the worktree. Git operations refuse that directory, edits outside the run worktree are denied, and test commands for that repository do not receive `DATABASE_URL`, `AUTH_SECRET` or Git tokens. When `bwrap` is installed, those commands run with the live tree mounted read-only. Without it, set `platform.trustedOperatorIsolation` only on a single-operator workstation; Claude and Cursor coding stay policy-enforced and are refused until that flag is set. Codex coding uses its OS sandbox. The server is not restarted and nothing is merged automatically.

Details, the gap analysis and the limitations are in [`docs/architecture/self-development.md`](docs/architecture/self-development.md).

## Intelligent Feature Engineering

`intelligent-feature-engineering` is the built-in template for a complex feature or a cross-module change. It runs on the same engine: requirements, repository discovery, architecture, an approved plan, implementation in a worktree, targeted checks, an independent review with a bounded repair, regression, a human quality gate, then a pull request. Subtasks in the plan are not child runs. Completing the run proposes learning candidates through the existing post-run effect; it does not publish rules. See [`docs/architecture/intelligent-feature-engineering.md`](docs/architecture/intelligent-feature-engineering.md).

## Language

The React UI supports Vietnamese (`vi`, default) and English (`en`). The selector in the top bar is stored in
`localStorage` (`hasaki.uiLocale`) and does not change the page or form state. A new run stores `output_locale`
on the run (`vi` or `en`). It defaults to the UI language and can be overridden in the start form. Omitted API
values default to `vi`; any other value is rejected. Retries, resume, repair and verification read that column.
Runs created before the column existed have `output_locale` NULL: the UI shows “not recorded” and does not
rewrite saved text; new generation for those runs falls back to Vietnamese. Historical translation of stored agent output is not in this version.

## Agents (Claude Code, Cursor, OpenAI Codex, Google Antigravity, and GitHub Copilot)

A run stores default `agent_provider`: `claude` (default), `cursor`, `codex`, `antigravity` or `copilot`. It is chosen on the start form in the React app and on `POST /api/runs` as `agent_provider`. Omitted means the platform default (`agent.defaultProvider`, or `claude`). Retries,
resume, repair, and auxiliary AI calls (repository ranking, test-failure explanation, report reasoning) default to that provider.
Claude model ids are never sent to Cursor, Codex, Antigravity or Copilot.

### Step-Level Orchestration and Fallback

- **Step-level agent configuration:** While each run specifies a default provider, individual `agent` and `coding_agent` steps can configure their own provider, model, reasoning effort, execution profile, timeout, and tool allowlists via `step.config.agent` (see `src/agent/stepAgent.ts`).
- **Manual step overrides:** Operators can apply an `agent_override` on a step to change provider or model before execution or on re-execution.
- **Fallback policy:** Steps can declare `config.agent.fallback` (`mode: disabled | manual | automatic`, `providers: [...]`, `max_switches: 2`, `auto_health: true`). When a provider encounters rate limits (`RATE_LIMIT`), quota exhaustion (`QUOTA_EXHAUSTED`), or outage (`PROVIDER_UNAVAILABLE`), the system safely transitions to the next available healthy provider.
- **Provider handoff:** `src/agent/handoff.ts` snapshots workspace modifications, baseline evidence, and execution notes into an immutable checkpoint, allowing the next provider to resume work without losing progress.
- **Unified harness lifecycle:** Every agent attempt executes through a deterministic 9-stage lifecycle (`src/agent/harness/executor.ts`): `preflight` → `context` → `authorize` → `budget` → `checkpoint` → `execute` → `output` → `verify` → `finalize` (see [`docs/architecture/execution-lifecycle.md`](docs/architecture/execution-lifecycle.md)).
- **Provider probe:** `GET /api/agent-providers` checks CLI availability, required flags, logins, and model catalogs across all configured providers without calling a model or consuming quota.

### Cursor

Cursor uses the installed CLI (`agent`, or `agent.cursorBin` / `CURSOR_AGENT_BIN`), version **2026.11.05** or a build
that advertises `--print`, `--output-format stream-json`, `--resume`, `--mode`, `--sandbox`, `--trust`, `--approve-mcps`
and `--force`. Log in with `agent login`, or set `CURSOR_API_KEY` in the server environment (never in a run payload).

What this CLI can and cannot do:

- Headless `--print` plus `stream-json` is how progress is recorded. Exit code 0 without a `result` event does not complete the step.
- Analysis steps use `--mode ask` and `--sandbox enabled` (read-only). Coding steps need `--force` or the CLI only proposes edits; the platform still writes `<workspace>/.cursor/cli.json` deny rules (no `git push`, no writes to the primary checkout) and kills the process if a streamed tool call violates the same policy as Claude. `--force` is not the policy.
- Implementation steps require `pre_tool_policy` and `hook_bypass_detection`; because Cursor cannot decide native tools before they execute, Cursor is restricted to analysis, verification, and read-only steps.
- Platform tools (`ask_user`, `submit_result`, `prepare_branch`, knowledge, integrations) are a per-run stdio MCP server. There is no open HTTP endpoint. The bridge file is deleted when the process exits.
- `--resume <session_id>` is used only for a Cursor session saved for that step. If resume fails, the step is rebuilt from the database and the current worktree. The worktree is not reset.
- Delegation (subagents) is refused: this CLI has no equivalent of the platform's read-only subagent hook.
- Cost and token totals are left null. The CLI's documented result event has duration, not usage.
- Other MCP servers in the operator's global Cursor config can still be approved because `--approve-mcps` is required for unattended runs.

If `agent` is missing or not logged in, the step fails with that reason. It does not switch to Claude unless a fallback policy is configured.

### OpenAI Codex

Codex runs through the official Codex CLI in non-interactive mode (`codex exec --json`, resumed with
`codex exec resume <thread_id>`). It is not the Responses API and not the Agents SDK.

**Install and log in on the worker** (the machine that runs `npm start`):

```bash
npm i -g @openai/codex          # or point agent.codex.bin / CODEX_BIN at an existing binary
codex login                     # e.g. "Sign in with ChatGPT"; no OPENAI_API_KEY is needed
codex login status              # must print "Logged in using ..."
codex debug models              # models and reasoning efforts this account can use
```

Tested with codex-cli 0.164. The probe (`GET /api/agent-providers`, also shown in the run forms when Codex is selected)
checks the version, the required `exec`/`exec resume` flags, `codex login status` and the model catalog. It never
calls a model and never reads `~/.codex/auth.json`.

**Whose account runs the work.** Every Codex step runs as the Codex login of the worker's OS user (for example the
operator's ChatGPT account). Run ownership on the platform does not create a Codex account per user, and all users
share that account's usage limits. When the limit is reached the step fails with a "usage limit" error and can fail over
if a fallback policy is configured. The platform never switches to an API key, another provider or another billing method:
`OPENAI_API_KEY` / `CODEX_API_KEY` are removed from the Codex environment.

**Configuration** (`config.json` → `agent.codex`, env overrides in brackets):

| key                                          | default                 |                                                                                         |
| -------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `bin` (`CODEX_BIN`)                          | `codex`                 | executable                                                                              |
| `timeoutMs` (`CODEX_TIMEOUT_MS`)             | 45 min                  | hard limit per Codex turn; the whole process tree is killed                             |
| `model` (`CODEX_MODEL`)                      | empty = account default | Codex model slug only                                                                   |
| `reasoningEffort` (`CODEX_REASONING_EFFORT`) | empty = model default   | `model_reasoning_effort`                                                                |
| `models`                                     | `{}`                    | routing like `agent.models` (`profile`/`*` → step type or `verifier`), Codex slugs only |

A step can override with `codex_model` / `codex_reasoning_effort` (or `step.config.agent.model`).

**How the platform policy is enforced** — per invocation, never by editing `~/.codex`:

- `--ignore-user-config --ignore-rules --strict-config`: only the platform's `-c` settings apply (no user MCP servers,
  hooks, plugins or rules); an unknown key is an error.
- OS sandbox: analysis/review steps run `read-only`. Coding steps run `danger-full-access` (no OS sandbox, network
  allowed) so a local PostgreSQL test cluster can bind a Unix socket. Tool policy still refuses `git push`, edits
  outside the run's worktrees, and reads of `.env`. `approval_policy = never`: a `PermissionRequest` is denied.
- A `PreToolUse` hook runs **before** every shell command, `apply_patch` edit and MCP tool and asks the worker, which
  applies the same `decide()` rules as Claude (no `git push`/`reset --hard`/branch changes, edits only inside the run's
  worktrees, read-only shell in analysis, no reading `.env`/Codex credentials). Unknown tools and subagents are denied;
  `PermissionRequest` is always denied. After `ask_user`, edits and state-changing commands are denied until answers arrive.
- Codex skips hooks it has not persisted trust for, so the platform passes `--dangerously-bypass-hook-trust`. This only
  lets the platform's own generated hooks run (user config is ignored); it does not bypass the sandbox or approvals.
  If no hook ran, platform tools are refused and a tool event without a hook stops the step.
- `.git` stays read-only in the sandbox, so Codex commits with the platform tool `commit_changes` (run worktree only,
  repository git hooks disabled).
- Platform tools reach the worker through a per-attempt Unix socket with a random token. The MCP bridge and hook get
  only the socket path and token; `DATABASE_URL`, `AUTH_SECRET` and other secrets are not in the Codex environment, and
  `PLATFORM_*` variables are excluded from the agent's shell.
- Multi-agent, apps, plugins, browser/computer use and web search are disabled. Steps with delegation fail before
  Codex starts (unsupported, no fallback).

**Results.** A step completes only when the turn reached `turn.completed`, the process exited 0, and `submit_result`
recorded an output with the step contract's top-level keys; then the usual verification and independent review run.
Process errors are not ignored because `submit_result` was called. Tokens come from `turn.completed.usage`; cost is
null (ChatGPT plans have no per-call price). The actual model comes from the hook payload (JSONL does not include it).
Resume always names the stored thread id (never `--last`). If a thread cannot be resumed, the step is rebuilt from the
persisted checkpoint (answers and progress notes) and the event is logged. Independent verification always starts a
new thread.

**Live smoke test (opt-in, uses quota):** `docker compose up -d postgres`, then
`CODEX_LIVE=1 CODEX_BIN=$(which codex) CODEX_REASONING_EFFORT=low npm run smoke:codex`. `npm test` never calls a model.

### Google Antigravity

Antigravity runs through the installed CLI (`agy`, or `agent.antigravity.bin` / `AGY_BIN` / `ANTIGRAVITY_BIN`) with
`--input-format stream-json --output-format stream-json`. Log in on the worker with `agy`. The probe
(`GET /api/agent-providers`, also shown when Antigravity is selected) checks the version, required flags, login and the
model catalog. It does not call a model.

Invocation analytics capture the reported model from Antigravity's `modelName` hook field, including a
`PreInvocation` hook for turns without tool calls. Explicit models in stream `init` events are also recorded.
Unknown historical models remain unknown unless a matching session log supplies evidence.

Every Antigravity step runs as the Google account logged in on the worker. Run ownership does not create an account per
user. Configuration lives in `config.json` → `agent.antigravity` (env overrides in brackets):

| key                                                                      | default               |                                                            |
| ------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------- |
| `bin` (`AGY_BIN` / `ANTIGRAVITY_BIN`)                                    | `agy`                 | executable                                                 |
| `timeoutMs` (`AGY_TIMEOUT_MS` / `ANTIGRAVITY_TIMEOUT_MS`)                | 45 min                | hard limit per Antigravity turn                            |
| `model` (`AGY_MODEL` / `ANTIGRAVITY_MODEL`)                              | empty = `agy` default | Antigravity model slug                                     |
| `effort` (`AGY_EFFORT` / `ANTIGRAVITY_EFFORT`)                           | empty = model default | reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`) |
| `maxConcurrent` (`AGY_MAX_CONCURRENT` / `ANTIGRAVITY_MAX_CONCURRENT`)    | 1                     | max concurrent turns on worker                             |
| `allowSubagents` (`AGY_ALLOW_SUBAGENTS` / `ANTIGRAVITY_ALLOW_SUBAGENTS`) | false                 | allow subagents                                            |
| `sandbox` (`AGY_SANDBOX` / `ANTIGRAVITY_SANDBOX`)                        | true                  | terminal restrictions / sandbox                            |
| `models`                                                                 | `{}`                  | routing like `agent.models`, Antigravity slugs only        |

Streaming and the review repair loop are in
[`docs/reliability/antigravity-streaming-and-review-repair.md`](docs/reliability/antigravity-streaming-and-review-repair.md).

### GitHub Copilot

Copilot runs through the official GitHub Copilot CLI in headless non-interactive mode (`copilot`, or `agent.copilot.bin` / `COPILOT_BIN`). Log in on the worker with `copilot login`, or provide an environment token (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`). The probe (`GET /api/agent-providers`, also shown when Copilot is selected) checks binary presence, required flags (`--output-format`, `--prompt`, `--model`, `--silent`, `--reasoning-effort`), authentication, and model availability.

Every Copilot step runs as the authenticated GitHub account on the worker. Run ownership does not create an account per user. Configuration lives in `config.json` → `agent.copilot` (env overrides in brackets):

| key                                          | default                   |                                                                                                                           |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `bin` (`COPILOT_BIN`)                        | `copilot`                 | executable                                                                                                                |
| `timeoutMs` (`COPILOT_TIMEOUT_MS`)           | 45 min                    | hard limit per Copilot turn                                                                                               |
| `model` (`COPILOT_MODEL`)                    | empty = `copilot` default | Copilot model slug (`auto`, `gpt-4o`, `gpt-4.1`, `o3`, `o4-mini`, `claude-sonnet-4`, `claude-3.5-sonnet`, `gpt-5.6-luna`) |
| `effort` (`COPILOT_EFFORT`)                  | empty = model default     | reasoning effort (`low`, `medium`, `high`, `xhigh`)                                                                       |
| `maxConcurrent` (`COPILOT_MAX_CONCURRENT`)   | 1                         | max concurrent turns on worker                                                                                            |
| `allowSubagents` (`COPILOT_ALLOW_SUBAGENTS`) | false                     | allow subagents                                                                                                           |
| `sandbox` (`COPILOT_SANDBOX`)                | true                      | terminal and execution restrictions                                                                                       |
| `models`                                     | `{}`                      | routing like `agent.models`, Copilot slugs only                                                                           |

Platform tools reach Copilot through a per-attempt stdio MCP bridge. PreToolUse hooks enforce tool policies (`decide()` rules: worktree-only edits, read-only shell in analysis, no reading credentials or `.env`, no unauthorized Git branches).

**Live smoke test (opt-in, uses quota):** `docker compose up -d postgres`, then
`COPILOT_LIVE=1 COPILOT_BIN=$(which copilot) COPILOT_EFFORT=low npm run smoke:copilot`. `npm test` never calls a model.

## UI (React + XYFlow, `web/`)

| Screen                                 | What you can do                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runs → run**                         | Live execution graph (SSE from PostgreSQL LISTEN/NOTIFY, polling fallback). Start / step mode / pause / resume / cancel. Click a node → inspector: config, resolved input, output (Markdown + JSON tree, copy), applied knowledge from context snapshot, agent session, Q&A, checkpoints, artifacts, attempt history, harness lifecycle evidence; retry, re-execute with instructions, skip, run this step (step mode). Blocked nodes pulse. |
| **Agent tab**                          | Execution viewer streamed while the step runs: prompts, agent messages, tool calls with full input/result, files read/modified, commands, errors, reasoning summaries, turn cost — filterable by type.                                                                                                                                                                                                                                       |
| **🔍 Changes**                         | Per workspace: commits ahead of `release/prod`, changed files, colored diff, uncommitted work, exact PR title/description the PR step will send, test/review results. Approve the PR step from there.                                                                                                                                                                                                                                        |
| **Trace Explorer**                     | Granular attempt execution trace with stage transitions, span tree, tool call timings, and diagnostic details.                                                                                                                                                                                                                                                                                                                               |
| **Workflows → editor**                 | Node canvas: add steps from palette, drag, connect (dependencies), delete; per-type forms (prompts, output contract, skills, rules, repo discovery, approval/reject routing, commands, conditions, PR mode, agent configuration); validate, save draft, publish version, load older versions, run (normal or step mode).                                                                                                                     |
| **Knowledge**                          | Business rules, architecture, conventions, repo instructions, skills; scope + applicability, version history, audit, where it is assigned and which executions received it. Review and approve rule change proposals.                                                                                                                                                                                                                        |
| **Work Items & Questions**             | Import (Hasaki task or list, JSON), manual requests, start runs; cross-run questions inbox; intake policies.                                                                                                                                                                                                                                                                                                                           |
| **Repositories**                       | Repository registry (Bitbucket, GitHub, GitLab), per-user access grants, remote URLs, code intelligence status/indexing, and ranking preview.                                                                                                                                                                                                                                                                                                |
| **Integrations**                       | Connection testing and credentials for Bitbucket, GitHub, GitLab, Hasaki Work (Chrome relay / token paste), Splunk, SigNoz, ArgoCD, Kafka UI, Vault, Telegram, and QC HTTP.                                                                                                                                                                                                                                                            |
| **Production Errors & Investigations** | Scheduled daily Splunk/SigNoz error scans across Kubernetes namespaces; triage into investigation runs with timeline correlation and latency analysis.                                                                                                                                                                                                                                                                                       |
| **Insights & Quality**                 | Execution metrics, health, usage, quality benchmark comparison (P1/P2 evaluation suites), autonomy insights, and continuous learning review.                                                                                                                                                                                                                                                                                                 |
| **Interactive Chat**                   | Real-time multi-turn conversational agent with SSE streaming, tool execution, operations verification, and task continuation.                                                                                                                                                                                                                                                                                                                |

Node ≥ 22.18 (runs `.ts` directly), the selected agent CLI logged in, Git, and personal Bitbucket, GitHub, or GitLab credentials saved in Integrations.

## Telegram notifications and interactive workflows (optional)

Telegram can now approve/reject workflow gates and answer questions from verified private accounts, using the existing workflow engine. Connect your own account in **Integrations → Telegram** through the short-lived bot link; manually entered chat IDs never authorize actions.

Configure the bot and the receiver mode (`polling` works locally/WSL without a public endpoint) on Integrations → Telegram; no `TELEGRAM_*` environment variable is read. The default `off` retains legacy one-way notifications. Existing shared scan summaries and private notification destinations remain supported.

See [Interactive Telegram setup, security and recovery](docs/integrations/interactive-telegram.md) for configuration, binding, transport exclusivity, message behavior and mocked tests. Do not run another `getUpdates` consumer against an active platform bot.

## Concepts

|                |                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work item      | The request. `REQ-n` (manual), Hasaki task code. The code is the branch name. Many runs per item.                                                                                                                                                                                                                                                                                  |
| Workflow       | Key + immutable published versions. Built-ins: `feature-implementation`, `bug-investigation`, `code-review`, `refactoring`, `work-item-analysis`, `platform-self-development`, `intelligent-feature-engineering`, `production-incident-investigation`, `incident-investigation` (read-only, evidence-verified; see docs/validation/codeact-m4-investigation-workflow.md), `micro-change`, and pilot `ponytail-nonproduction-pilot`. Edit in UI → draft → publish.                                               |
| Run            | One execution, pinned to a definition version, with its own resolved graph, allowed/selected repositories, execution profile and branch. Can exist without a work item.                                                                                                                                                                                                                      |
| Step / attempt | Status `PENDING READY RUNNING WAITING_INPUT WAITING_APPROVAL COMPLETED FAILED RETRYING CANCELED SKIPPED`; step types: `agent`, `coding_agent`, `human_input`, `human_approval`, `integration`, `command`, `condition`, `git_pull_request`, `task_result_report`. Every execution is an attempt with immutable input, output, context snapshot, agent session, metrics, and harness evidence. |

Human-in-the-loop: agents call `ask_user` → step `WAITING_INPUT` (no worker held) → answer in the run page or the
Questions inbox → the step resumes its provider session if safe, otherwise rebuilds context from persisted history.
Approvals: `human_approval` steps, or `requires_approval: true` on any step (PR mode `approval`).
Retry / re-execute from any step: downstream steps are invalidated (generation bump); upstream results are reused.

Scheduling is PostgreSQL-only: `workflow_jobs` claimed with `FOR UPDATE SKIP LOCKED`, leases + heartbeats + fencing
tokens; crashed workers' jobs are reaped and retried. Several processes may share the database.

**Adaptive Execution Profiles:**

- `MICRO`: Bounded, single-repository changes with 12k context token cap, 10-minute timeout cap, and folded analysis/planning/coding session.
- `FAST`: Small, well-scoped changes in one known repo: folds analysis into coding, drops plan approvals and post-coding AI review, uses deterministic discovery.
- `STANDARD`: Published workflow as defined.
- `DEEP`: High-risk or cross-repository changes: full workflow, AI-assisted discovery, strict independent verification, no auto-approvals.

**Context Optimization and Delta Delivery:**
`config.agent.deltaContext` (default `true`) tracks delivery manifests in `agent_context_deliveries` so resumed sessions receive only changed entries. When session context pressure exceeds thresholds, adaptive compaction (`config.agent.compaction`: `reconstruct` | `native` | `off`) reconstructs state cleanly without blowing the context window.

**Slop Detection:**
`config.slop.mode` (`disabled` | `advisory` | `enforcement`) runs deterministic checks against cyclomatic complexity, cognitive complexity, duplicate lines, and language-specific anti-patterns.

**PR Lifecycle Monitoring:**
`config.prLifecycle.mode` (`off` | `monitor` | `repair`) polls pull request CI checks and trusted reviewer feedback, triggering bounded automated repair loops for fixable issues.

**Continuous learning**: when a run completes, the human decisions in it are analysed: answers, approval comments,
re-run instructions and the BA ticket. Agent output is never analysed. Each detected rule change is stored as a
reviewable proposal (UPDATE / SUPERSEDE / DEPRECATE / CREATE) with verbatim evidence and its impact on skills,
repositories and workflows. Nothing changes until a reviewer approves it in Knowledge ▸ Change proposals.

Approval versions the rule. It can be scoped (e.g. one project) and effective from a date. The old rule is
superseded only where the new one applies, and its history stays readable. Affected skills get their own validated
update proposals, and every approved change can be rolled back. Later runs resolve only the rule in effect, and each
context snapshot records which version a run received. See
[docs/architecture/knowledge-evolution.md](docs/architecture/knowledge-evolution.md).

## Production incident investigation (Splunk & SigNoz, read-only)

Workflow `production-incident-investigation` (sidebar _Điều tra Production_): a Vietnamese or English request
("Kiểm tra log đơn hàng … lúc khoảng 08:48 …") → Splunk/SigNoz searches with guard rails → events correlated by identifiers
across services → timeline with the logged precision → latency between explicitly named event pairs → evidence-backed
summary and developer report. Agents only label stored, sanitized log events; timestamps and relationships come from
the evidence itself. Connect Splunk or SigNoz in Integrations; without a connection the workflow hands out the query SPL and accepts pasted
results. See [docs/integrations/production-investigation.md](docs/integrations/production-investigation.md).

## Safety & Isolation

- **Authentication & RBAC:** Session cookie-based authentication with Argon2id password hashing, CSRF token validation (`csrfOk`), user roles (`admin` and `member`), and encrypted user credentials using `AUTH_SECRET`. Binds to loopback (`127.0.0.1`) by default (`HOST=0.0.0.0` for shared instances).
- **Bubblewrap OS Isolation (`isolation.mode: enforce`):** Each agent step executes inside a sandboxed container (private HOME and `/tmp`, hidden credentials, tokens, and host secrets, network restricted to provider egress allowlist, and rlimit/cgroup boundaries). When `off`, agents run with application tool policy on trusted single-operator machines.
- **Worktree Isolation:** Code is edited strictly in dedicated worktrees under `dataDir/worktrees/<instance>/<run>/<repo>`; primary checkouts and `reposRoot` are never modified.
- **Tool Policies:** Strict pre-tool decisions (`src/agent/toolPolicy.ts`): analysis steps are read-only (shell allowlist); coding steps may edit only inside the run's worktrees; `git push`, `reset --hard`, `clean`, `rm -rf`, and checkout of `release/prod` are denied.
- **Repository Authorization:** Repositories outside a run's allowed set are rejected at selection, branch preparation, and PR time.
- **Untrusted Input Wrapping:** Task text and earlier agent output are wrapped as `<untrusted_input>`; platform rules and curated knowledge remain in the trusted system prompt.
- **PR Safety:** Pull requests are opened idempotently by `git_pull_request` (`auto | approval | draft | none`). Nothing is merged or deployed automatically.

## Main API

| Endpoint                                                                                                                  | Responsibility                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET/POST /api/work-items`, `POST /api/work-items/import`, `GET/POST /api/work-items/:id`                                 | Work items (POST creates manual request; import = Hasaki Work, no execution)     |
| `POST /api/work-items/:id/runs` `{workflow, repositories?, inputs?, start?}` · `POST /api/work-items/:id/analyze`         | Start a run / read-only analysis                                                        |
| `GET/POST /api/workflows`, `POST /api/workflows/:key/draft`, `/publish`, `/validate`                                      | Workflow library & visual definition lifecycle                                          |
| `GET/POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/{start,pause,resume,cancel,repositories,feedback}`         | Run lifecycle controls                                                                  |
| `POST /api/runs/:id/steps/:key/{retry,reexecute,approve,reject,skip}`                                                     | Step-level controls & re-execution with instructions                                    |
| `GET /api/questions`, `POST /api/questions/answers` `{answers:{id:text}}`                                                 | Cross-run questions inbox                                                               |
| `GET/POST /api/knowledge`, `POST /api/knowledge/preview`                                                                  | Knowledge registry, versioning & change proposals                                       |
| `GET/POST /api/repositories`, `POST /api/repositories/rank`, `GET /api/repositories/:id/workspace`                        | Repository registry, access grants & workspace status                                   |
| `GET /api/agent-providers`, `GET/POST /api/settings/agent`                                                                | Agent provider status probes & configuration                                            |
| `GET/POST /api/chat/conversations`, `GET /api/chat/conversations/:id/stream`, `POST /api/chat/conversations/:id/messages` | Real-time interactive agent chat & streaming SSE                                        |
| `POST /api/code-intelligence/search`                                                                                      | Symbol search, definitions, references, and dependencies                                |
| `GET /api/runs/:id/changes`, `POST /api/runs/:id/pr/sync`                                                                 | Workspace diffs, PR preview and PR state synchronization                                |
| `/api/work/*`                                                                                                             | Hasaki Work login, inbox, task pick                                                     |

### Connect Hasaki Work using Google Chrome (local worker)

Set `HASAKI_WORK_BROWSER_MODE=local` in the git-ignored `.env`, then restart with `npm start`.
Keep `HOST=127.0.0.1` (or leave it unset). The default mode is hosted: only personal token paste is available.
Never enable local mode on a shared deployment. Chrome opens on the backend machine.

The Work Items panel offers **Connect with Chrome**. The platform opens Work and clicks its official Hasaki SSO button, so Work generates a fresh PKCE/state flow in the same profile. It never replays a copied identity-provider URL. Complete sign-in/MFA yourself in the separate Chrome window.
A persistent dedicated profile is reused per installation and platform user under
`dataDir/work-chrome/<installation-id>/<user>/profile` (Windows: `%LOCALAPPDATA%/HasakiWorkChrome/<installation-id>/<user>/profile`).
Sign in once in this profile; subsequent connections retain its browser session. Personal Chrome profiles are never used or copied.
Earlier temporary session profiles are left untouched. A profile lock prevents concurrent workers from attaching to or closing another session.
After a worker crash, stop all workers and close that dedicated Work window before removing only its empty `.platform-connection-lock` directory.
Do not remove the profile itself or its Chrome lock files.
Existing profiles are preserved. The session expires after five minutes; Cancel closes only this session's Chrome.
The platform observes Bearer headers sent to the configured Work API, verifies a candidate with the configured read-only
list endpoint, and encrypts it for the initiating user. Passwords/MFA and API payloads are not logged.
There is no confirmed official OAuth callback integration in this repository; no cookie or storage keys are assumed.

Chrome is detected on Linux/macOS/Windows, including Windows Chrome under WSL. Optionally set
`HASAKI_WORK_CHROME_PATH` to the official Chrome executable; a missing explicit path never falls back.
Old config files may still contain `hasakiWork.chromiumPath`; it is ignored and has been removed from the configuration type and defaults. Use `HASAKI_WORK_CHROME_PATH` with explicit local mode. Bundled Chromium is never selected.
On WSL, a Windows PowerShell stdio bridge connects Windows Chrome loopback to a temporary WSL loopback listener.
Mirrored networking is not required. Chrome opens the login URL immediately. Both endpoints stay on 127.0.0.1;
no DevTools port is exposed to the LAN. The bridge is closed with its connection session. If company policy blocks debugging or SSO rejects connected Chrome, use personal token paste.
Chrome detection/DevTools connectivity does not prove that SSO accepts the browser.

#### Use your existing personal Chrome profile (Windows + WSL, Chrome 144+)

Set `HASAKI_WORK_BROWSER_MODE=local`, `HASAKI_WORK_CHROME_PROFILE=existing`, and
`HASAKI_WORK_EXISTING_CHROME_USER=toan` in `.env`, then restart the worker.
The username is checked against the authenticated server actor; client-supplied user IDs are ignored.
Only this local account may attach to the personal browser. This mode is not for shared hosting.

In your existing Chrome, enable Remote debugging at `chrome://inspect/#remote-debugging`.
Keep exactly one `work.hasaki.vn` tab open in your intended Chrome profile. Click Connect in the platform,
then select **Allow** when Chrome asks. This uses Chrome's 144+ consent feature, not the launch flags that
are ignored for the default data directory. Debugging permission applies to the browser, and Chrome shows a control banner.
The application reads only the chosen Work tab's API authorization header; it does not read cookies or copy profiles.
Cancel, timeout and successful connection detach the relay without closing personal Chrome or its tabs.
If you reject permission or debugging is disabled, the UI explains how to retry; no new profile is silently launched.
The platform reloads the chosen Work tab to capture a fresh authenticated request and follows its official SSO flow if needed.
To return to a dedicated profile, set `HASAKI_WORK_CHROME_PROFILE=dedicated`.
Reference: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session

### Optional cross-repository code intelligence (P1)

Set `codeIntelligence.enabled` to `true` in the **local** `PLATFORM_CONFIG` (defaults and limits are in `config.json` / `src/config.ts`). The existing PostgreSQL migrations create the additive `code_intelligence` schema. No extra service or database extension is required. `git` and `rg` must be installed on the worker; Tree-sitter runtime/grammars are pinned npm dependencies.

Existing scheduler workers index registered repositories while idle. The repository detail page shows status, commit, counts, progress and sanitized errors; administrators can queue reindexing or cancel it. Discovery and agent prompts (Claude, Cursor, Codex, Antigravity, Copilot) use validated snapshots with metadata/direct-search fallback. The read-only `code_intelligence.search` integration tool exposes symbols, definitions, references, bounded dependencies and exact search within the run's allowed repositories.

See [architecture, extraction coverage and operational limits](docs/architecture/code-intelligence.md) and [measured fixture benchmark](docs/architecture/code-intelligence-benchmark.json). To reproduce on an isolated **local test database**, run `npm run bench:code-intelligence`; it uses the existing test database setup, which creates a unique `platform_test_<uuid>` database without resetting an existing one. Use `TEST_DATABASE_ADMIN_URL` for a different local test PostgreSQL. The benchmark never accepts a remote database.

Development finalization results, real-repository measurements, startup verification, and remaining limits: [P1 validation report](docs/validation/p1-finalization.md). Re-run the authorized development check with `npm run validate:code-intelligence -- <development-database-name>`; it indexes the three registered OMS checkouts and removes its disposable worktrees.

### Optional semantic retrieval

Knowledge ranking is lexical by default. To re-rank it semantically with the Go retrieval service ([ADR 0001](docs/architecture/adr/0001-go-backend-semantic-retrieval.md)), set `RETRIEVAL_SEMANTIC_ENABLED=true` and `RETRIEVAL_INTERNAL_TOKEN` (≥ 32 characters) in `.env` and run `docker compose up -d ollama ollama-init` (local `bge-m3`). `npm start` then builds and supervises `platform-go` on `RETRIEVAL_SEMANTIC_URL` (default `http://127.0.0.1:4646`; needs Go on `PATH`). If it is down, ranking stays lexical.

The same service is the only engine for the engineering analytics dashboards ([ADR 0003](docs/architecture/adr/0003-go-analytics.md)), code intelligence indexing and code search ([ADR 0002](docs/architecture/adr/0002-go-code-intelligence-indexing.md), [ADR 0006](docs/architecture/adr/0006-go-code-search.md)), the repository knowledge scan ([ADR 0007](docs/architecture/adr/0007-go-knowledge-scan.md)) and production error scans ([ADR 0004](docs/architecture/adr/0004-go-background-workers.md)); `npm start` always starts it. TypeScript keeps authorization, scope, governance, publication and every provider credential (Splunk and SigNoz are read through this server's internal gateway, as the requesting user). When platform-go is unavailable these features answer "unavailable, retry shortly"; there is no TypeScript fallback. `npm run build:go` + `PLATFORM_GO_BIN=go/bin/platform-go` runs a prebuilt binary instead of compiling at startup.

Provider CLIs (Codex, Cursor, Copilot, Antigravity) and verification commands start and stop through one adapter (`src/agent/process/supervisor.ts`). With `PROCESS_SUPERVISION_ENGINE=go` each runs under `platform-supervise` in its own delegated cgroup (`systemd-run --user --scope -p Delegate=yes`; on WSL enable systemd in `/etc/wsl.conf`): memory/process limits, `cgroup.kill` cleanup of every descendant, host-wide admission (`config.supervision`). `GET /api/admin/isolation` shows the runtime and counters ([ADR 0005](docs/architecture/adr/0005-go-process-supervision.md)).

Semantic search only re-orders items the existing resolution and authorization already selected (Reciprocal Rank Fusion with the lexical order, k = 60); mandatory, enforced and assigned items are unaffected. A disabled, unreachable, slow or failing service falls back to lexical ranking and never fails a step. Admins see fallback counters and the service status at `GET /api/admin/retrieval/status` and can queue re-indexing with `POST /api/admin/retrieval/reindex` (`{ "all": true }` or `{ "source_ids": [...] }`). `npm run eval:retrieval` reports Recall@5/10, MRR and inline tokens for lexical and hybrid ranking over the seeded knowledge.

### Optional benchmark evaluations (P2)

Set `evaluation.enabled: true` in the **local** `PLATFORM_CONFIG`; production defaults remain disabled. Migration `027_benchmark_framework` extends the existing evaluation tables and workflow scheduler. In **Insights → Quality**, an administrator publishes the immutable suite; users can launch bounded fixture runs, inspect evidence and compare paired results. Existing workflow questions, approvals, cancellation and artifacts remain the execution controls.

To reproduce the synthetic P1 OFF/ON controls with no paid model calls:

```sh
EVAL_REPORT=/tmp/p2-report.json npm run bench -- --suite=backend-v1 --repetitions=2
```

The CLI accepts only local PostgreSQL, creates or reuses `platform_bench` without dropping its results, and keeps synthetic Git repositories under `${TMPDIR:-/tmp}/hasaki-p2-benchmark`. It uses the existing local container runtime/image, never pulls an image, and blocks if network, resource and lifetime isolation cannot be verified. The current adapter requires Linux/Nix and Podman-compatible `docker --timeout`; see the [P2 architecture and operating limits](docs/architecture/p2-evaluation.md). Human answers in this CLI are explicitly scripted fixture controls; use `--answer-fixtures=false` to pause for manual handling. Live model execution is blocked until a connector can enforce isolation and hard spending limits.

See the [P2 validation report](docs/validation/p2-finalization.md), [measured paired results](docs/validation/p2-benchmark.json), and [dashboard evidence](docs/validation/p2-dashboard.png). Fixture scores do not establish live-agent quality or token savings.

## URL-based repository registry

Administrators add `https://bitbucket.org/<workspace>/<repository>.git`, `https://github.com/<owner>/<repository>.git`, or `https://<gitlab-host>/<group>/<project>.git` and a default branch on **Repositories**, preserving project mappings and repository permissions. Members use that shared registration with their own provider credentials. Each assigned instance automatically clones into its dataDir, then creates an isolated run worktree for Claude, Cursor, Codex, Antigravity, or Copilot. No source-path mapping is needed for new repositories. Connection testing, preparation, refresh and workspace status are available on the repository detail page.

Existing paths remain deprecated legacy hints; IDs, knowledge, dependencies and historical runs are preserved by migration 028. Review legacy evidence with `npm run repositories:migrate`; use `-- --apply` only after reviewing the report. Missing or ambiguous remotes remain unresolved rather than being guessed from repository names.

GitHub (`https://github.com/<owner>/<repository>.git`) and GitLab (`https://<instance>/<group>[/<subgroup>...]/<project>.git`, gitlab.com and the self-hosted instances listed in `config.gitlab.instances`, e.g. gitlab.hasaki.work) work the same way with each member's own token. GitLab setup, minimum token scopes, internal CA and merge policy are in the [GitLab guide](docs/architecture/gitlab.md).

Read the [repository architecture](docs/architecture/repositories.md), [migration guide](docs/architecture/repository-migration.md), [multi-instance development guide](docs/architecture/multi-instance-development.md) and [Bitbucket credential guide](docs/architecture/bitbucket-credentials.md). Separate directories preserve application ownership; workers sharing an OS account do not provide OS security isolation.

## CLI Commands and Scripts

| Command                                                       | Purpose                                                                                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`                                                   | Builds UI (`npm run build`), ensures `bwrap`, runs database migrations and seeds, and starts the server on port 4545                                                   |
| `npm run dev`                                                 | Runs backend in watch mode (`--watch`) with `.env` loaded                                                                                                              |
| `npm run dev:web`                                             | Runs Vite dev server with hot reload on `http://localhost:5173` proxying `/api` to `:4545`                                                                             |
| `npm run build`                                               | Builds the frontend web UI using Vite (`vite build`)                                                                                                                   |
| `npm run typecheck`                                           | Typechecks backend (`tsconfig.json`) and frontend (`web/tsconfig.json`)                                                                                                |
| `npm test`                                                    | Runs fast in-memory unit tests (`test/*.test.ts`)                                                                                                                      |
| `npm run test:integration`                                    | Runs integration tests with PostgreSQL against ephemeral test databases                                                                                                |
| `npm run test:all`                                            | Runs unit tests followed by integration tests                                                                                                                          |
| `npm run admin:bootstrap -- --username <user> --claim-legacy` | Bootstraps initial administrator and claims ownerless legacy records                                                                                                   |
| `npm run smoke:codex`                                         | Opt-in live smoke test for OpenAI Codex CLI                                                                                                                            |
| `npm run smoke:copilot`                                       | Opt-in live smoke test for GitHub Copilot CLI                                                                                                                          |
| `npm run eval:autonomy`                                       | Evaluates autonomous recovery and execution policies                                                                                                                   |
| `npm run bench:tokens`                                        | Benchmarks prompt and token optimization across providers                                                                                                              |
| `npm run bench:code-intelligence`                             | Runs code intelligence benchmark on local test database                                                                                                                |
| `npm run validate:code-intelligence`                          | Validates code intelligence indexing on a specified database                                                                                                           |
| `npm run db:diagnostics` / `npm run db:storage`               | Collects read-only PostgreSQL storage diagnostics (sizes, estimated rows, dead tuples, largest tables; see [docs](docs/observability/postgres-storage-diagnostics.md)) |
| `npm run repositories:migrate`                                | Generates report for migrating legacy path repositories to canonical URLs                                                                                              |
| `npm run knowledge:import`                                    | Imports skills and conventions from repositories and `~/.claude/skills`                                                                                                |
| `npm run knowledge:audit`                                     | Audits knowledge items against active rules and scope conflicts                                                                                                        |
| `npm run lint` / `npm run lint:fix`                           | Runs ESLint / applies automatic fixes                                                                                                                                  |
| `npm run format` / `npm run format:check`                     | Runs Prettier / checks formatting                                                                                                                                      |

Cleanup and compatibility decisions, baseline/final validation and query-count evidence are recorded in the [production cleanup report](docs/validation/production-cleanup.md). Typechecking now rejects unused local declarations and parameters in the backend, frontend and tests. All historical SQL migrations and validation reports remain unchanged.
