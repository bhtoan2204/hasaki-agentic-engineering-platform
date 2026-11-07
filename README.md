# Workflow Platform (Claude Task Platform v2)

Workflow-driven AI engineering platform. Engineering requests (**work items**: manual, Hasaki Work, Jira) are executed
by reusable, versioned **workflows** made of typed steps (AI agent, coding agent, human input, approval, command,
condition, integration, pull request). Every step has durable state, attempt history, questions, checkpoints and
context snapshots in PostgreSQL. Claude Code (Agent SDK) is the executor for agent steps; Bitbucket is the Git provider.

Importing a task **never** executes anything. You pick a workflow and start a run (or set an explicit automation policy).

Architecture: [`docs/architecture/agent-architecture.md`](docs/architecture/agent-architecture.md) (single agent + skills + tools) ·
[`docs/architecture/performance.md`](docs/architecture/performance.md) (FAST / STANDARD / DEEP profiles, reuse, latency) ·
[`docs/architecture/current-state.md`](docs/architecture/current-state.md) ·
[`target-state.md`](docs/architecture/target-state.md) · [`migration-plan.md`](docs/architecture/migration-plan.md)

## Run

Run one instance per developer, or one centrally hosted backend and worker. Instances can share PostgreSQL repository metadata; each worker provisions its own checkouts from registered Bitbucket URLs. Local worktrees and agent sessions stay on the assigned instance.
`HOST=0.0.0.0` exposes that one installation. The default listen address stays loopback.

```bash
docker compose up -d                  # PostgreSQL 17 on 127.0.0.1:55432
npm install
cp config.example.json config.json    # database, dataDir; register remote URLs in Repositories
export BITBUCKET_USER=you@hasaki.vn BITBUCKET_TOKEN=...   # optional shared service account, not a personal token
# For a permitted shared account, also set bitbucket.allowSharedCredentials=true in config.json.
# Keep the existing AUTH_SECRET in the git-ignored .env; never regenerate it on restart.
# For a NEW install only, generate a cryptographically random secret and save it privately in .env.
# Localhost HTTP works automatically. Set COOKIE_SECURE=1 behind HTTPS.
npm run admin:bootstrap -- --username alice --claim-legacy
# Migrations run before bootstrap, even on an empty database.
# Enter the password twice at the hidden terminal prompt (10–200 characters).
# ADMIN_PASSWORD is also supported; no default password.
npm start                             # builds the UI, then http://localhost:4545 (migrations + seeds run on boot)
```

The login screens at `/` and `/classic` show CLI setup instructions when no active admin exists.
Bootstrap leaves an existing account’s password and role unchanged. Creation and legacy claiming commit together.

There is no public signup and no bootstrap HTTP route. `--claim-legacy` assigns existing ownerless private rows
(work items, runs, inbox, legacy tasks) to that admin in one transaction. Seeded skills, rules and workflow
templates stay shared (`owner_id` NULL). Unassigned private rows stay invisible until they are claimed.

## Access

| Resource | Member | Admin |
| --- | --- | --- |
| Seeded skills, rules, conventions, workflow templates, repository registry, shared integration settings | Read and use | Modify, publish, archive |
| Work items, inbox imports, private workflows, runs and everything under a run, private knowledge, task memory | Own rows only | Own rows by default. "View the whole team's resources" is explicit and audited |
| Clone a shared template | Yes, into a private workflow | Yes |
| Promote a private workflow or knowledge item to shared | No | Yes, after review |

A run started from a work item keeps that work item's owner. A shared template does not make its runs shared.
Applicability scopes such as GLOBAL and REPOSITORY are not visibility. Task memory extracted from a private run
stays private; approving it does not publish it. Child rows (questions, attempts, artifacts, snapshots, events)
are authorized through their run. Guessing another user's id returns 404.

Personal Hasaki Work, Bitbucket and Jira credentials belong to the user and are encrypted with `AUTH_SECRET`.
A missing personal account does not fall back to someone else's token. `BITBUCKET_*` / `JIRA_*` in the
environment are the explicit shared service account. The server does not open a Hasaki login window; paste a
token. Telegram's bot is admin-managed; private step notifications go only to that user's chat. Production-error
monitors stay shared, and a member who investigates gets their own work item. The shared error list does not
link to another member's task.

Claude, Cursor and Codex credentials are the worker machine's admin-managed logins in this version. Personal agent
accounts per user are not included. Agents share one OS user, so this is application isolation for a trusted
team, not a sandbox: tools are checked against the run owner, but a process on the host can still read the disk.

Development: `npm run dev` (backend with --watch) + `npm run dev:web` (Vite hot reload on http://localhost:5173,
proxying /api to :4545). `npm run typecheck` checks backend and UI, `npm test` uses a throwaway `platform_test` database.

The PostgreSQL pool defaults to 10 connections and waits at most 5 seconds for a free client
(`database.poolMax` / `database.connectionTimeoutMillis` in config.json, or `DATABASE_POOL_MAX` / `DATABASE_CONNECTION_TIMEOUT_MS`).

## Language

The React UI supports Vietnamese (`vi`, default) and English (`en`). The selector in the top bar is stored in
`localStorage` (`hasaki.uiLocale`) and does not change the page or form state. A new run stores `output_locale`
on the run (`vi` or `en`). It defaults to the UI language and can be overridden in the start form. Omitted API
values default to `vi`; any other value is rejected. Retries, resume, repair and verification read that column.
Runs created before the column existed have `output_locale` NULL: the UI shows “not recorded” and does not
rewrite saved text; new generation for those runs falls back to Vietnamese. `/classic` uses the same
dictionary. Historical translation of stored agent output is not in this version.

## Agents (Claude Code, Cursor and OpenAI Codex)

A run stores `agent_provider`: `claude` (default), `cursor` or `codex`. It is chosen on the start form in the React app and
`/classic`, and on `POST /api/runs` as `agent_provider`. Omitted means Claude. Any other value is rejected. Retries,
resume, repair, re-execution and every auxiliary AI call of the run (repository ranking, test-failure explanation and
answer interpretation, report reasoning) stay on that provider. Claude model ids are not sent to Cursor or Codex.
AI calls that do not belong to a run keep the global default (Claude, `model`). Switching provider inside a run or
per step is not supported.

Cursor uses the installed CLI (`agent`, or `agent.cursorBin` / `CURSOR_AGENT_BIN`), version **2026.11.05** or a build
that advertises `--print`, `--output-format stream-json`, `--resume`, `--mode`, `--sandbox`, `--trust`, `--approve-mcps`
and `--force`. Log in with `agent login`, or set `CURSOR_API_KEY` in the server environment (never in a run payload).

What this CLI can and cannot do:

- Headless `--print` plus `stream-json` is how progress is recorded. Exit code 0 without a `result` event does not complete the step.
- Analysis steps use `--mode ask` and `--sandbox enabled` (read-only). Coding steps need `--force` or the CLI only proposes edits; the platform still writes `<workspace>/.cursor/cli.json` deny rules (no `git push`, no writes to the primary checkout) and kills the process if a streamed tool call violates the same policy as Claude. `--force` is not the policy.
- Platform tools (`ask_user`, `submit_result`, `prepare_branch`, knowledge, integrations) are a per-run stdio MCP server. There is no open HTTP endpoint. The bridge file is deleted when the process exits.
- `--resume <session_id>` is used only for a Cursor session saved for that step. If resume fails, the step is rebuilt from the database and the current worktree. The worktree is not reset.
- Delegation (subagents) is refused: this CLI has no equivalent of the platform's read-only subagent hook.
- Cost and token totals are left null. The CLI's documented result event has duration, not usage.
- Other MCP servers in the operator's global Cursor config can still be approved because `--approve-mcps` is required for unattended runs.

If `agent` is missing or not logged in, the step fails with that reason. It does not switch to Claude.

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
share that account's usage limits. When the limit is reached the step fails with a "usage limit" error and is not
retried automatically. The platform never switches to an API key, another provider or another billing method:
`OPENAI_API_KEY` / `CODEX_API_KEY` are removed from the Codex environment. Wait for the reset, or start a new run with
another provider.

**Configuration** (`config.json` → `agent.codex`, env overrides in brackets):

| key | default | |
|---|---|---|
| `bin` (`CODEX_BIN`) | `codex` | executable |
| `timeoutMs` (`CODEX_TIMEOUT_MS`) | 45 min | hard limit per Codex turn; the whole process tree is killed |
| `model` (`CODEX_MODEL`) | empty = account default | Codex model slug only |
| `reasoningEffort` (`CODEX_REASONING_EFFORT`) | empty = model default | `model_reasoning_effort` |
| `models` | `{}` | routing like `agent.models` (`profile`/`*` → step type or `verifier`), Codex slugs only |

A step can override with `codex_model` / `codex_reasoning_effort` (the Claude-only `model` key is ignored for Codex).

**How the platform policy is enforced** — per invocation, never by editing `~/.codex`:

- `--ignore-user-config --ignore-rules --strict-config`: only the platform's `-c` settings apply (no user MCP servers,
  hooks, plugins or rules); an unknown key is an error.
- OS sandbox: analysis/review steps run `read-only`; coding steps run `workspace-write` whose only writable roots are
  the run's task directory (its worktrees, including ones `prepare_branch` creates later) and a per-attempt temp dir.
  Network is off. `approval_policy = never`: nothing is escalated out of the sandbox.
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

## UI (React + XYFlow, `web/`)

| Screen | What you can do |
|---|---|
| **Runs → run** | Live execution graph (SSE from PostgreSQL LISTEN/NOTIFY, polling fallback). Start / step mode / pause / resume / cancel. Click a node → inspector: config, resolved input, output (Markdown + JSON tree, copy), applied knowledge from the context snapshot, Claude session, Q&A, checkpoints, artifacts, attempt history; retry, re-execute from here, skip, run this step (step mode). Questions and approvals are answered in the inspector; blocked nodes pulse. |
| **Claude tab** | Execution viewer streamed while the step runs: prompts, Claude messages, tool calls with full input/result, files read / modified, commands, errors, reasoning summaries, turn cost — filterable by type. |
| **🔍 Changes** | Per workspace: commits ahead of `release/prod`, changed files, colored diff, uncommitted work, the exact PR title/description the PR step will send, test/review results. Approve the PR step from there. |
| **Workflows → editor** | Node canvas: add steps from the palette, drag, connect (dependencies), delete; per-type forms (prompts, output contract, skills, business rules, repository discovery, approval/reject routing, commands, conditions, PR mode); validate, save draft, publish version, load older versions, run (normal or step mode). |
| **Knowledge** | Business rules, architecture, conventions, repo instructions, skills; scope + applicability, version history, audit, where it is assigned and which executions actually received it. |
| **Work Items / Questions / Repositories** | Import (Hasaki list or task id, Jira, JSON), manual requests, start runs; cross-run questions inbox; repository registry and ranking preview. |

The previous vanilla UI is still served at `/classic`.

Node ≥ 22.18 (runs `.ts` directly), the selected agent CLI logged in, Git, and personal Bitbucket credentials saved in Integrations.

## Telegram notifications (optional)

When a step starts waiting for you (WAITING_INPUT: questions, WAITING_APPROVAL: approval / report review / approval gate)
the platform sends one Telegram message with the task, run, step and reason, plus a link that opens the run with that
step selected (`#/runs/<id>/<step>`). One-way only: you answer/approve in the app.

1. Send any message (e.g. `/start`) to your bot, then get your chat id:
   `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'`
2. `cp .env.example .env` and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (`.env` is git-ignored;
   `npm start`, `npm run dev` and `npm run serve` load it with `node --env-file-if-exists=.env`).
   Exported shell variables work too.
3. Restart. Without both variables nothing is sent. Links use `publicUrl`: an `https://` publicUrl becomes a
   "Mở bước cần xử lý" button; a local URL (default `http://localhost:4545`) is sent as a text link.

Sending is fire-and-forget with a 5 s timeout (Telegram and the webhook POST). Failures are logged without the token
and never affect the workflow. Run-level "WAITING" goes to the webhook only, so Telegram gets one message per waiting step.

## Concepts

| | |
|---|---|
| Work item | The request. `REQ-n` (manual), Hasaki task code, Jira key. The code is the branch name. Many runs per item. |
| Workflow | Key + immutable published versions. Built-ins: Feature Implementation, Bug Investigation, Code Review, Refactoring, Work Item Analysis. Edit in the UI → draft → publish. |
| Run | One execution, pinned to a definition version, with its own resolved graph, allowed/selected repositories and branch. Can exist without a work item. |
| Step / attempt | Status `PENDING READY RUNNING WAITING_INPUT WAITING_APPROVAL COMPLETED FAILED RETRYING CANCELED SKIPPED`; every execution is an attempt with input, output, context snapshot, Claude session, error. |

Human-in-the-loop: agents call `ask_user` → step `WAITING_INPUT` (no worker held) → answer in the run page or the
Questions inbox → the step resumes its Claude session if safe, otherwise rebuilds context from persisted history.
Approvals: `human_approval` steps, or `requires_approval: true` on any step (PR mode `approval`).
Retry / re-execute from any step: downstream steps are invalidated (generation bump); upstream results are reused.

Scheduling is PostgreSQL-only: `workflow_jobs` claimed with `FOR UPDATE SKIP LOCKED`, leases + heartbeats + fencing
tokens; crashed workers' jobs are reaped and retried. Several processes may share the database.

**Continuous learning**: when a run completes, the human decisions in it are analysed: answers, approval comments,
re-run instructions and the BA ticket. Agent output is never analysed. Each detected rule change is stored as a
reviewable proposal (UPDATE / SUPERSEDE / DEPRECATE / CREATE) with verbatim evidence and its impact on skills,
repositories and workflows. Nothing changes until a reviewer approves it in Knowledge ▸ Change proposals.

Approval versions the rule. It can be scoped (e.g. one project) and effective from a date. The old rule is
superseded only where the new one applies, and its history stays readable. Affected skills get their own validated
update proposals, and every approved change can be rolled back. Later runs resolve only the rule in effect, and each
context snapshot records which version a run received. See
[docs/architecture/knowledge-evolution.md](docs/architecture/knowledge-evolution.md).

## Safety

- No `bypassPermissions`. Each agent step gets an explicit tool list and a PreToolUse/`canUseTool` policy
  (`src/agent/toolPolicy.ts`): analysis steps are read-only (shell allowlist); coding steps may edit only inside the
  run's worktrees; `git push`, `reset --hard`, `clean`, `rm -rf`, checking out `release/prod` are always denied.
- Code is edited only in worktrees under `~/.claude-task-platform/worktrees/<branch>/<repo>`; the primary checkout is never used.
- Repositories outside a run's allowed set (project mapping in the registry) are rejected at selection, at `prepare_branch` and at PR time.
  The allowed set is the work item's project plus the projects linked with it in `config.relatedProjects`
  (both directions, one hop): `{ "OMS": ["Payment"] }` lets an OMS run use Payment repos and vice versa.
- Task text and earlier agent output are passed as `<untrusted_input>`; platform rules and curated knowledge go in the system prompt.
- PRs are opened by the `git_pull_request` step (`auto | approval | draft | none`), idempotent per repo/branch. Nothing is merged or deployed.
- The API has no auth — it listens on loopback only.

## Main API

| | |
|---|---|
| `GET/POST /api/work-items`, `POST /api/work-items/import`, `GET/POST /api/work-items/:id` | work items (POST creates a manual request; import = Hasaki/Jira, no execution) |
| `POST /api/work-items/:id/runs` `{workflow, repositories?, inputs?, start?}` · `POST /api/work-items/:id/analyze` | start a run / read-only analysis |
| `GET/POST /api/workflows`, `POST /api/workflows/:key/draft`, `/publish`, `/validate` | workflow library |
| `GET/POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/{start,pause,resume,cancel,repositories,feedback}` | runs |
| `POST /api/runs/:id/steps/:key/{retry,reexecute,approve,reject,skip}` | step controls |
| `GET /api/questions`, `POST /api/questions/answers` `{answers:{id:text}}` | questions inbox |
| `GET/POST /api/knowledge`, `POST /api/knowledge/preview`, `GET/POST /api/repositories`, `POST /api/repositories/rank` | knowledge, repository registry |
| `/api/tasks*`, `/api/work/*` | legacy endpoints, kept compatible (`POST /api/tasks?workflow=<key>` imports and starts) |

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
`hasakiWork.chromiumPath` is deprecated and not used. Bundled Chromium is never selected.
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

Set `codeIntelligence.enabled` to `true` in the **local** `PLATFORM_CONFIG` (defaults and limits are in `config.example.json`). The existing PostgreSQL migrations create the additive `code_intelligence` schema. No extra service or database extension is required. `git` and `rg` must be installed on the worker; Tree-sitter runtime/grammars are pinned npm dependencies.

Existing scheduler workers index registered repositories while idle. The repository detail page shows status, commit, counts, progress and sanitized errors; administrators can queue reindexing or cancel it. Discovery and Claude/Cursor/Codex prompts use validated snapshots with metadata/direct-search fallback. The read-only `code_intelligence.search` integration tool exposes symbols, definitions, references, bounded dependencies and exact search within the run's allowed repositories.

See [architecture, extraction coverage and operational limits](docs/architecture/code-intelligence.md) and [measured fixture benchmark](docs/architecture/code-intelligence-benchmark.json). To reproduce on an isolated **local test database**, run `npm run bench:code-intelligence`; it uses the existing test database setup, which recreates `platform_test`. Use `TEST_DATABASE_ADMIN_URL` for a different local test PostgreSQL. The benchmark never accepts a remote database.

Development finalization results, real-repository measurements, startup verification, and remaining limits: [P1 validation report](docs/validation/p1-finalization.md). Re-run the authorized development check with `npm run validate:code-intelligence -- <development-database-name>`; it indexes the three registered OMS checkouts and removes its disposable worktrees.

### Optional benchmark evaluations (P2)

Set `evaluation.enabled: true` in the **local** `PLATFORM_CONFIG`; production defaults remain disabled. Migration `027_benchmark_framework` extends the existing evaluation tables and workflow scheduler. In **Insights → Quality**, an administrator publishes the immutable suite; users can launch bounded fixture runs, inspect evidence and compare paired results. Existing workflow questions, approvals, cancellation and artifacts remain the execution controls.

To reproduce the synthetic P1 OFF/ON controls with no paid model calls:

```sh
EVAL_REPORT=/tmp/p2-report.json npm run bench -- --suite=backend-v1 --repetitions=2
```

The CLI accepts only local PostgreSQL, creates or reuses `platform_bench` without dropping its results, and keeps synthetic Git repositories under `${TMPDIR:-/tmp}/hasaki-p2-benchmark`. It uses the existing local container runtime/image, never pulls an image, and blocks if network, resource and lifetime isolation cannot be verified. The current adapter requires Linux/Nix and Podman-compatible `docker --timeout`; see the [P2 architecture and operating limits](docs/architecture/p2-evaluation.md). Human answers in this CLI are explicitly scripted fixture controls; use `--answer-fixtures=false` to pause for manual handling. Live model execution is blocked until a connector can enforce isolation and hard spending limits.

See the [P2 validation report](docs/validation/p2-finalization.md), [measured paired results](docs/validation/p2-benchmark.json), and [dashboard evidence](docs/validation/p2-dashboard.png). Fixture scores do not establish live-agent quality or token savings.

## URL-based repository registry

Administrators add `https://bitbucket.org/<workspace>/<repository>.git` and a default branch on **Repositories**, preserving project mappings and repository permissions. Members use that shared registration with their own Bitbucket credentials. Each assigned instance automatically clones into its dataDir, then creates an isolated run worktree for Claude/Codex/Cursor. No source-path mapping is needed for new repositories. Connection testing, preparation, refresh and workspace status are available on the repository detail page.

Existing paths remain deprecated legacy hints; IDs, knowledge, dependencies and historical runs are preserved by migration 028. Review legacy evidence with `npm run repositories:migrate`; use `-- --apply` only after reviewing the report. Missing or ambiguous remotes remain unresolved rather than being guessed from repository names.

Read the [repository architecture](docs/architecture/repositories.md), [migration guide](docs/architecture/repository-migration.md), [multi-instance development guide](docs/architecture/multi-instance-development.md) and [Bitbucket credential guide](docs/architecture/bitbucket-credentials.md). Separate directories preserve application ownership; workers sharing an OS account do not provide OS security isolation.
