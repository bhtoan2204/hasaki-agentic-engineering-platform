# ADR 0008: CodeAct — read-only programmatic tool calling in the OS sandbox

Status: accepted, behind `codeAct.enabled` (default off; `CODEACT_ENABLED=1`) · Date: 2026-11-21

## Context

Investigations chain several read-only lookups (traces → slow orders → logs → counts). Done one tool call per model
turn, every intermediate payload is sent to the model (capped, therefore also incomplete) and each deterministic step
costs a turn.

## Decision

One capability, `execute_code` (workflow context tool `platform.execute_code`) and `code.execute` (Chat,
INVESTIGATE mode): the agent submits the body of an async JavaScript function; it receives `platform.callTool(name,
args)` and `platform.listTools()` and returns a JSON value.

- **Isolation.** The program runs in `src/codeact/runner.mjs`, launched through the existing agent sandbox profile
  (`sandboxInvocation`: systemd user scope with MemoryMax/TasksMax, prlimit CPU/file size, bubblewrap
  `--unshare-all` with no egress proxy, HOME / repositories root / data directory / credential files masked,
  `isolatedEnvironment` allowlisted env) plus Node `--permission` (fs reads limited to the runner, no child processes,
  no workers). `node:vm` is only the API surface; tests escape it deliberately and still find no secret, no network,
  no writable file, no child process. Without a usable isolation runtime CodeAct is unavailable (typed
  `unsupported`); code never runs in the worker.
- **Broker.** Every nested call is a message to the parent (`src/codeact/execute.ts`): exact name match against the
  registry catalog, read-only tools only, budgets (calls 20, result bytes 2 MB, concurrency 4, 15 s per call, 20 s per
  program, 16 KB code, 16 KB returned value — truncated beyond), cancellation and SIGKILL of the process group.
- **Authorization.** The surface (`src/codeact/surfaces.ts`) re-applies, per nested call, what a direct read-only call
  gets: workflow — `validateToolBinding`, attempt `allowed_tools` and benchmark permissions as `integration:<name>`,
  the run's repository scope; chat — `assertBinding`, the conversation scope, `chat.integration.call` audit. The call
  itself is the registry's `callTool(..., {mode: "analysis"})`, which refuses non-read-only tools again.
- **Evidence.** `code_executions` / `code_execution_calls` (migration 089) keep identity, status, error category,
  durations, sha256 of inputs/outputs and the redacted, capped result of each nested call (`codeact:<exec>:<seq>`).
  The answer is marked `untrusted: true` and is never verified evidence by itself.
- **Disclosure.** When disabled the tool is not advertised (Claude MCP server, stdio bridge, Codex enabled tools) and
  the step prompt does not mention it.

## Measurements (`npm run bench:codeact`, fixture of 400 spans / 600 events, no model calls)

| | direct calls | CodeAct |
|---|---|---|
| tool calls | 2 | 2 |
| model turns needed | 3 | 2 |
| bytes returned to the model | 47,924 (workflow cap) / 12,000 (chat cap), raw 112,215 | 66 |
| program wall time (OS sandbox, dev host) | – | p50 109 ms, max 192 ms |

Bytes are measured; turns are structural for this plan. No provider token counts were measured (no paid model calls):
token savings on real tasks remain to be shown with evaluation runs.

## Consequences and limits

- Hosts without bubblewrap + user namespaces + a systemd user scope cannot enable CodeAct (CI runners included); the
  surface tests there use a test-only plain-process launcher, the sandbox suite skips with the probe's reason.
- Nested results reach the program in full (bounded by the byte budget); the program, not the platform, decides what
  it returns. Taint handling of derived values is ADR 0010 (P1-C).
- Integration budgets inside tools (Splunk/SigNoz per run/step) still apply per nested call.
