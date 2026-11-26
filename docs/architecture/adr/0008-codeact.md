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
- **Evidence integrity.** A reference is a claim that a durable row exists, so it is emitted only for a successful
  nested call whose row was written (the broker tracks each recorder outcome as `persisted`, bounded by
  `codeAct.persistTimeoutMs`, default 10 s, and never swallows a failure) _and_ whose execution was finalized by this
  surface. Otherwise the answer keeps the program's value but reports `evidence_status: "partial" | "none"`, the call
  as `recorded: false` without `ref`, and a `warnings` line — a degraded answer rather than a failed one, because the
  value itself is never evidence (it is `untrusted`) and Chat/workflow evidence is what the refs cite. A row that lands
  after its timeout is not retroactively cited. `resolveCodeActEvidence(actor, ref)` resolves a reference to its
  recorded (redacted) result only for a successful call of a finalized execution and only for the execution owner
  (an admin in support mode is audited as `support.access`); anything else is null, so existence is not revealed.
  Failure-injection tests (database triggers): `test/codeact-evidence.integration.ts`, `test/codeact-evidence.test.ts`.
- **Composition (M3).** Besides integration tools, a program may call an explicit allowlist of read-only platform
  reads (`platform.search_code`, `get_symbol`, `find_dependencies`, `navigate_code`, `search_knowledge`,
  `get_business_rules`, `search_task_memory`, `get_run_context`; Chat: `platform.code.search`, `code.navigate`,
  `knowledge.search`, `knowledge.get`). Each goes through the surface's own dispatcher (`dispatchPlatformTool` /
  `executeChatTool`), so authorization, scope, freshness, journal and budgets are the direct path's. Answers carry
  per-call `source` (family, trust), `sources` caveats and `missing_sources`. See
  `docs/validation/codeact-m3-composition.md`.
- **Investigation workflow (M4).** `incident-investigation` template; claim provenance verifies `codeact:` refs
  (this run's recorded, finalized calls only) and `observed` assertions against recorded results; the
  `evidence_report` step re-verifies and reports. Provider bridges (Codex, Cursor) get `CODEACT_ENABLED` /
  `LSP_ENABLED` from the worker so they offer what the worker enabled. See
  `docs/validation/codeact-m4-investigation-workflow.md`.
- **Disclosure.** When disabled the tool is not advertised (Claude MCP server, stdio bridge, Codex enabled tools) and
  the step prompt does not mention it.

## Measurements (`npm run bench:codeact`, fixture of 400 spans / 600 events, no model calls)

|                                          | direct calls                                           | CodeAct                |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------- |
| tool calls                               | 2                                                      | 2                      |
| model turns needed                       | 3                                                      | 2                      |
| bytes returned to the model              | 47,924 (workflow cap) / 12,000 (chat cap), raw 112,215 | 66                     |
| program wall time (OS sandbox, dev host) | –                                                      | p50 109 ms, max 192 ms |

Bytes are measured; turns are structural for this plan. No provider token counts were measured (no paid model calls):
token savings on real tasks remain to be shown with evaluation runs.

## Consequences and limits

- Hosts without bubblewrap + user namespaces + a systemd user scope cannot enable CodeAct (CI runners included); the
  surface tests there use a test-only plain-process launcher, the sandbox suite skips with the probe's reason.
- Nested results reach the program in full (bounded by the byte budget); the program, not the platform, decides what
  it returns. Taint handling of derived values is ADR 0010 (P1-C).
- Integration budgets inside tools (Splunk/SigNoz per run/step) still apply per nested call.

## Hardening (2026-11-22)

**Cancellation.** The workflow surface now passes the attempt's execution signal (`PlatformToolEnv.signal` =
the scheduler's `ctx.signal`: run cancellation, lease loss, attempt timeout); Chat already passed its turn signal.
`executeCode` honours it before and during the sandbox launch (nothing is spawned), while the program runs (the
process group is killed) and for nested calls: running calls get an aborted signal, queued calls are dropped, late
results are discarded and never recorded, and the result keeps the cancellation reason (`category: "canceled"`,
distinct from `timeout` and `internal`). `ToolCallContext.signal` carries the nested call's signal into `callTool`,
which never starts a handler after the abort and never reports a result that arrived after it.

_Limitation:_ no integration handler forwards `ctx.signal` to its HTTP client yet, so an in-flight Splunk/SigNoz/…
request runs to completion (bounded by its own timeout) after a cancellation; its result is discarded. Handlers can
adopt it individually.

**Scheduling.** At most `maxConcurrency` (4) nested calls run, up to `maxQueuedCalls` (16) wait FIFO, more are refused
at once (`budget_exceeded`). A call's deadline (`callTimeoutMs`) starts when the program issues it, waiting included;
a call never starts at or after its deadline. Ending an execution resolves every waiter (no dangling promises).

**IPC and memory.** Program → parent lines: at most 2 × `maxOutputBytes` + 64 KiB each and `maxProtocolMessages`
(1000) in all, malformed lines included; request ids must be fresh positive integers (a duplicate or invalid id ends
the execution as `invalid_input`); `listTools` is id-matched and limited to `maxListTools` (10). A nested result is
serialized once; above `maxCallResultBytes` (1 MB) it is refused, and the delivered total never exceeds
`maxResultBytes` (2 MB) — concurrent large results are refused rather than forwarded. stderr keeps a 2 KB tail.

**Structured overflow.** A result above `maxOutputBytes` comes back as `truncated: true`, `original_bytes`, a `note`
on how to narrow it, and `value` = a valid JSON preview built by the runner (strings cut, arrays and objects shortened
with markers, small fields kept); the parent re-checks the preview's size and refuses a forged one. Cyclic and
non-serializable results fail as `internal`. Program output stays `untrusted`; the dispatcher still redacts it.

**Persistence.** The terminal transition only updates a `running` row (a status is never rewritten); nested-call rows
in flight are written before the execution is finalized; rows left `running` by a dead worker (older than
`timeoutMs` + 120 s) are reconciled as `error/internal` before each new execution (index: migration 091).

**Measured** (`npm run bench:codeact`, OS sandbox, 10 runs each, same script on both versions): program p50
114 ms before → 113–126 ms after (noise); 20 nested calls at 5 ms each p50 134 → 138–144 ms (+3–7 %: a timer and an
AbortSignal per call); peak in-flight 4 → 4; cancellation 0.2 ms → 0.2 ms; parent RSS delta 3.3 → 3.4 MB; bytes
returned to the model 66 → 66.
