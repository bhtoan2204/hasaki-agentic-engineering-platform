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

One centrally hosted backend and worker, used from browsers. Sharing the PostgreSQL database does **not** make
local repositories, worktrees or Claude/Cursor sessions portable: those live on the machine that runs the worker.
`HOST=0.0.0.0` exposes that one installation. The default listen address stays loopback.

```bash
docker compose up -d                  # PostgreSQL 17 on 127.0.0.1:55432
npm install
cp config.example.json config.json    # reposRoot, projects, bitbucket, ...
export BITBUCKET_USER=you@hasaki.vn BITBUCKET_TOKEN=...   # optional shared service account, not a personal token
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

Claude and Cursor credentials are the worker machine's admin-managed logins in this version. Personal agent
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

## Agents (Claude Code and Cursor)

A run stores `agent_provider`: `claude` (default) or `cursor`. It is chosen on the start form in the React app and
`/classic`, and on `POST /api/runs` as `agent_provider`. Omitted means Claude. Any other value is rejected. Retries,
resume, repair and repository ranking stay on that provider. Claude model ids are not sent to Cursor.

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

Node ≥ 22.18 (runs `.ts` directly), `claude` logged in, SSH key that can push to Bitbucket.

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

## Safety

- No `bypassPermissions`. Each agent step gets an explicit tool list and a PreToolUse/`canUseTool` policy
  (`src/agent/toolPolicy.ts`): analysis steps are read-only (shell allowlist); coding steps may edit only inside the
  run's worktrees; `git push`, `reset --hard`, `clean`, `rm -rf`, checking out `release/prod` are always denied.
- Code is edited only in worktrees under `~/.claude-task-platform/worktrees/<branch>/<repo>`; the primary checkout is never used.
- Repositories outside a run's allowed set (project mapping in the registry) are rejected at selection, at `prepare_branch` and at PR time.
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
