# Copilot instructions

## Project shape

This is a Node.js 22.18+ ESM TypeScript application. The backend runs directly from `src/` with Node's TypeScript
support; the React/Vite frontend lives in `web/` and is built into `web/dist/`, which the backend serves. The
legacy vanilla UI remains under `public/` at `/classic`.

The main runtime path is `src/server.ts`: it validates configuration, applies PostgreSQL migrations, seeds workflow
definitions and knowledge, loads integrations, registers executors, starts SSE/cache services, binds HTTP, and only
then starts scheduler/background workers. `src/http/app.ts` serves static assets, authentication, CSRF checks, SSE,
artifact downloads, and API dispatch; domain handlers are registered in `src/api/routes.ts`.

Workflow execution is the core domain. Published immutable workflow definitions are resolved into a run graph by
`src/workflow/engine.ts`; runs, steps, attempts, questions, checkpoints, events, artifacts, leases, and fencing
state are persisted in PostgreSQL. The scheduler claims durable jobs with leases, and executors in
`src/workflow/executors/` invoke typed step implementations. Agent-specific execution is behind the provider layer
in `src/agent/` (Claude, Cursor, Codex, Copilot, and Antigravity); provider choice and output locale are pinned to a
run. The React UI consumes the API and live event stream, while `src/api/stream.ts` provides replay/polling fallback.

Repositories are registered centrally but accessed with user-scoped permissions. Coding work happens only in
run-specific worktrees, never the live checkout; agent/tool policy enforcement is in `src/agent/toolPolicy.ts` and
related workspace/git modules. Do not weaken these checks or pass secrets into repository test/agent processes.

## Commands

Install dependencies and start local PostgreSQL:

```sh
docker compose up -d
npm install
```

Run the backend and frontend during development:

```sh
npm run dev       # backend on the configured port, normally :4545
npm run dev:web   # Vite UI on :5173, proxies /api to :4545
```

Build and run the production-shaped server:

```sh
npm run build
npm start         # builds first, then runs migrations/seeding and serves the UI
```

Validation and formatting:

```sh
npm run typecheck
npm run lint
npm run lint:fix
npm run format:check
npm run arch:check
```

Unit tests do not require PostgreSQL or real agent CLIs. The preload in `test/env.ts` must run before platform
modules are imported:

```sh
npm test
node --disable-warning=ExperimentalWarning --import ./test/env.ts --test test/<name>.test.ts
```

Integration tests use PostgreSQL, migrations, and real subprocesses. `test/run-integration.ts` starts one private
cluster and gives each test file a fresh `platform_test_<uuid>` database:

```sh
npm run test:integration
node --disable-warning=ExperimentalWarning test/run-integration.ts --test-concurrency=1 test/<name>.integration.ts
npm run test:all
```

The integration harness needs `initdb`, `pg_ctl`, and `bubblewrap` available. CI also installs PostgreSQL 17 and
`rg`; code-intelligence workers require both `git` and `rg`.

## Repository conventions

- **Migrations are append-only.** Add a new numbered SQL migration in `migrations/`; never edit an applied
  migration. Startup verifies stored checksums and serializes migration with a PostgreSQL advisory lock.
- **Preserve durable execution invariants.** Lifecycle mutations lock the run first; job/attempt/step completion
  uses fencing tokens and step generations; status transitions go through the workflow state machine. Reuse the
  engine and repositories rather than writing direct status updates in API handlers.
- **Keep authorization at the domain boundary.** Use the access helpers in `src/authz/access.ts` and repository
  access services before loading or mutating user-owned work items, runs, child rows, knowledge, or repositories.
  Child resources inherit authorization from their run/work item. Mutating HTTP requests require the session CSRF
  token, and create operations may require idempotency handling.
- **Treat imported task text and agent output as untrusted input.** Curated knowledge and platform policy belong in
  the protected agent context; do not promote agent output directly into rules or shared knowledge. Learning changes
  are reviewable proposals and require approval.
- **Keep provider behavior consistent across a run.** Retries, resume, repair, verification, repository ranking,
  failure interpretation, and auxiliary AI calls must honor the run's pinned provider and locale. Do not silently
  fall back to another provider when a selected CLI is unavailable.
- **Use the existing test isolation.** Unit tests rely on `test/env.ts`; integration tests rely on `test/setup.ts`
  and the private cluster/database lifecycle. Avoid importing configuration or database modules before the preload
  establishes test environment variables.
- **Keep frontend and backend types strict.** Both `tsconfig.json` files enable strict checking plus
  `noUnusedLocals` and `noUnusedParameters`. Frontend source is under `web/src`; use the existing i18n dictionaries
  for user-visible text and preserve Vietnamese (`vi`) as the default locale.
- **Follow the existing formatting/tooling setup.** ESLint is configured in `eslint.config.mjs`, Prettier in
  `.prettierrc.json`, and TypeScript files use explicit `.ts`/`.tsx` import extensions.
- **Keep safety-sensitive operations explicit.** Never add automatic merge/deploy/push behavior, use the primary
  checkout for coding, expose the unauthenticated API beyond loopback, or read `.env`/agent credential files from
  tests or agent workspaces.

## MCP

For browser-oriented UI work, a Playwright MCP server is the relevant integration. Run it against the local Vite
development server (`npm run dev` plus `npm run dev:web`) and use the existing browser smoke tests as the behavioral
reference. Keep browser sessions pointed at local/test data and do not place MCP tokens, account credentials, or
machine-specific paths in the repository.
