# P1 — CodeAct, LSP semantic navigation, runtime taint enforcement (design)

Status: approved scope (P1 request, 2026-11-21); implementation proceeds milestone by milestone (A → B → C).
Branch: `feat/p1-codeact-lsp-taint` from `9fc70a2`.

## Intent

Agents investigating incidents and code spend LLM turns on deterministic work (filter, join, count) and see raw
tool payloads; they navigate code by syntax only; and nothing at runtime ties a mutating action's arguments to where
those values came from. P1 adds, behind capability gates and disabled by default:

- **A. CodeAct** — one read-only `execute_code` tool: a short JavaScript program, run in an OS sandbox, calls
  authorized read-only registry tools through the trusted parent and returns a bounded result plus evidence refs.
- **B. LSP** — semantic definition / references / document symbols / diagnostics for Go (gopls) and TS/JS, scoped to
  an authorized checkout or the step's own worktree, with typed fallback to the existing index.
- **C. Taint** — provenance of mutating-operation arguments computed by the platform from its own journals; values
  traceable only to untrusted observations can never ride a no-confirmation path, and every decision is audited.

Non-goals: a second agent framework, tool registry, policy engine or index; Go migration of the Harness; LSP for
languages other than Go/TS/JS; claiming universal taint tracking through LLM text.
Anti-goals: any path where generated code or tool output gains a capability the caller did not already have.

## Audit summary (facts the design rests on)

- Registry `src/agent/toolRegistry.ts`: `IntegrationTool.readOnly`, `confirm`, `preauthorized`, `preflight`;
  `callTool(name,args,ctx)` refuses non-read-only tools in `mode:"analysis"` and `confirm` tools without a
  confirmed operation. Only two mutating integrations exist: `kafka.publish`, `qc_http.request` (both `confirm`).
- Chat: `tools.call` audits and calls read-only tools in analysis mode; mutations go to
  `proposeOperation`/`decideOperation` (`src/chat/operations.ts`); a `preauthorized` match auto-confirms.
- Workflow: `dispatchPlatformTool` is the single entry for platform tools of every provider (binding validation,
  allowed tools, concurrency, timeout, redaction, `journalToolCall` → `agent_context_tool_calls`).
  New native logical tools are `CONTEXT_TOOLS` entries handled in `executeContextTool`.
- Isolation: `sandboxInvocation` (systemd scope → prlimit → bwrap `--unshare-all`, masked HOME/repos/data/credentials,
  no network without an egress proxy) and `isolatedEnvironment`; probe `probeIsolation()`. Available on the dev host;
  not guaranteed on CI.
- Code intelligence: `localScope(repo, runId, workspacePath)` authorizes and resolves checkout/worktree roots;
  `readSource`/`safePath` refuse symlinks. gopls 0.24 is installed; no LSP client library and no
  typescript-language-server are present; `typescript` 6 is a dependency of the repo.
- Provenance today is claim provenance (`src/agent/provenance.ts`), not data flow.

## Approaches considered

**A. CodeAct runtime**
1. *Node `vm` / isolated context in the worker* — rejected: not a security boundary; shares the worker's memory,
   credentials and DB pool.
2. *Child Node process under the existing OS sandbox (`sandboxInvocation`), Node `--permission`, JSON-lines RPC to the
   parent broker* — **chosen**: reuses the hardened bwrap profile (no network, masked secrets, rlimits, cgroup
   memory/pids), the parent holds every credential and the registry; fail closed when the probe is unavailable.
3. *Go-hosted interpreter (goja) in platform-go* — rejected: new runtime, the registry and authorization live in TS.

**B. LSP transport**
1. *Add `vscode-jsonrpc`/`typescript-language-server` dependencies* — not available locally and new dependency
   installs were refused earlier; deferred.
2. *Small Content-Length JSON-RPC client in TS (the MCP bridge already frames this way) driving gopls; TS/JS served by
   a child process using the TypeScript LanguageService API behind the same LSP-shaped request contract* —
   **chosen**: no new dependency, no project plugins executed, both under `superviseSpawn`-style lifecycle.
3. *Extend platform-go* — rejected: LSP sessions are per worktree and authorization lives in TS.

**C. Taint**
1. *String labels on every value through LLM text* — rejected: not enforceable through model reasoning.
2. *Boundary provenance: at a mutating sink the platform classifies each sensitive argument by searching its own
   trusted records (user messages of the conversation, configured allowlists) and untrusted records (tool results of
   the conversation / CodeAct outputs); untrusted-only or unknown-origin values remove auto-execution and are audited*
   — **chosen**: deterministic, uses existing journals, honest about its boundary.

## Design

### A. CodeAct
- Config `codeAct: { enabled: false, timeoutMs, maxCodeBytes, maxOutputBytes, maxCalls, maxResultBytes,
  maxConcurrency, callTimeoutMs, memoryMb }`. Tool unavailable (typed reason) unless enabled **and**
  `probeIsolation().available`.
- Module `src/codeact/`: `runner.mjs` (sandbox side: reads `{code}` from stdin, exposes `platform.callTool`,
  `platform.listTools`, serializes calls as JSON lines on stdout, receives results on stdin, returns the program's
  value), `execute.ts` (parent: limits, sandbox launch via `sandboxInvocation`, broker loop, cancellation via
  AbortSignal → kill, cleanup), `broker` logic inside `execute.ts` taking a surface-supplied `call(name,args)`.
- Broker rules (independent of the program): tool must be in `integrationTools()` and `readOnly`; executed through
  `callTool(..., {mode:"analysis"})` with the caller's run/repositories (registry re-validates schema, availability,
  read-only); per-call timeout; counts/bytes budgets; concurrency cap; names resolved exactly (no aliases).
- Surfaces: workflow `CONTEXT_TOOLS` entry `execute_code` (read-only) → `executeContextTool`; chat tool
  `code.execute` (group `observability`, INVESTIGATE mode) → same core with chat's audit.
- Persistence: migration `code_executions` (id, owner, run/attempt or conversation/turn, status, code hash, durations,
  counts, error category) and `code_execution_calls` (execution id, seq, tool, read_only, status, duration, input/
  output sha256, redacted capped result, error category). Evidence refs `codeact:<exec>:<seq>`.
- Result to the model: `{ok, value (≤ maxOutputBytes, else truncated with note), calls:[{seq,tool,status,ref}],
  provenance:[refs], stats}`; the value is labelled `untrusted` — never verified evidence.

### B. LSP
- Config `lsp: { enabled: false, maxSessions, idleMs, requestTimeoutMs, maxResults, gopls?: path }`.
- `src/codeIntelligence/lsp/`: `client.ts` (framing, request/cancel, crash detection), `sessions.ts` (pool keyed by
  language + realpath root + owner scope; idle eviction; restart on crash; bounded), `tsServer.mjs` (TypeScript
  LanguageService behind LSP-shaped methods), `navigate.ts` (authorization via `localScope`, path validation, open
  file from disk at request time, provenance `{repository, root_kind, head, file_sha256}`, staleness recheck).
- Servers run under the OS sandbox when available (read-only bind of the root, no network, GOPROXY=off,
  GOFLAGS=-mod=mod disabled, GOTOOLCHAIN=local, CGO_ENABLED=0); otherwise under process supervision with the same env
  and the typed status `unsandboxed` reported (disabled by default, operator opt-in).
- Contract result: `{status: ok|unsupported|unavailable|timeout|not_found|stale|unauthorized|invalid,
  locations:[{repository,path,line,character,end_line}], more?, provenance}`.
- Surfaces: workflow context tool `navigate_code`; chat `code.navigate`. Unsupported → caller uses `search_code`.

### C. Taint
- Sinks: registry tools with `readOnly:false` (today `kafka.publish`, `qc_http.request`); target fields declared per
  tool (`kafka: topic, cluster, key`; `qc: url, method, auth`), payload fields (`value`, `body`, `headers`).
- `src/agent/taint.ts`: `classifyArguments({tool, args, trusted, untrusted})` → per field
  `trusted | untrusted | unknown` with matching record refs (no raw values stored); trusted = appears in the owner's
  messages of the conversation or equals a configured allowlist/preauthorized entry; untrusted = appears in a tool
  result / CodeAct output of the conversation.
- Enforcement in `proposeOperation`: arguments carrying provenance/approval fields are rejected by strict schemas;
  any target field not `trusted` → auto-confirmation disabled (explicit owner confirmation required), and the
  confirmation record stores the provenance summary; audit `chat.operation.taint` with refs and decision.
- CodeAct: mutating tools unreachable (broker), outputs carry refs; generated code cannot declare trust.
- Workflow: agents cannot call mutating integrations (unchanged); native shell/network rely on the existing policy and
  OS sandbox — documented as the uninstrumented boundary.

## What is left to the builder
Exact limits defaults, metric names, migration number, test fixture shapes.
