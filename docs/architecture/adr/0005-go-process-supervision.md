# ADR 0005: Process supervision in Go (migration phase 3)

Status: accepted, behind `PROCESS_SUPERVISION_ENGINE=go` (default `typescript`) · Date: 2026-11-21

## Context

Provider CLIs (Codex, Cursor, Copilot, Antigravity) and verification commands are child processes of the platform.
Before this change each had its own lifecycle code:

| Path                        | Stop                                                                                             | Descendants that left the process group                                                 | Leftovers after a normal exit |
| --------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------- |
| Codex (`killTree`)          | immediate SIGKILL of the group, then of every descendant found by a **synchronous** `/proc` scan | found while their parent lives; a daemon that double-forked (reparented to init) is not | killed after `close`          |
| Cursor                      | immediate SIGKILL of the group                                                                   | survive                                                                                 | none killed                   |
| Copilot, Antigravity        | SIGTERM to the group, SIGKILL after 5 s                                                          | survive                                                                                 | none killed                   |
| Verification (`runCommand`) | SIGKILL of the group (plus Node's own SIGTERM on abort)                                          | survive unless bwrap's PID namespace is used                                            | none killed                   |

Measured with `npm run bench:process` (`docs/architecture/process-supervision.json`, 16 CPUs, WSL2 6.6, cgroup v2,
delegated systemd user scopes available): a stopped tree of 200 processes containing double-forked daemons left
**50 survivors**, and because they still held the stdout pipe the platform **never saw the process close** (the
caller waits until they exit — up to the command's whole lifetime). Agents, verification and builds had no memory or
process-count limit unless run through the Claude sandbox, and verification concurrency was bounded per platform
process only (`VERIFY_MAX_CONCURRENT`), not per host. Output was mostly bounded (16 KB stderr tails, a 512 KB
verification cap), except the Cursor text completion, which kept all of stdout and stderr.

We also found that `systemd-run` **expands `$VAR` and `$$` in the command line it runs**: the existing Claude sandbox
invocation passed its arguments through unescaped (fixed here for both paths: `systemdLiteral`).

## Decision

### A per-process launcher, not a supervisor service

`go/cmd/platform-supervise` (package `go/internal/supervise`) is started by the platform in front of each supervised
command — `platform-supervise [flags] -- command args` — and exits with it. There is no daemon, socket, HTTP API or
privilege: it runs as the platform user, on the host that owns the worktree, credentials and sandbox, and takes a
structured argv (never a shell). The command **inherits the launcher's stdin, stdout and stderr** directly: no copy,
no buffer (the pipe is the backpressure), so JSONL protocols, stdin semantics, resume, tool approvals and exit
statuses are byte-for-byte what they were. A long-lived supervisor would have needed a second process protocol for
streams and a new trust boundary for an "execute this" API; the launcher needs neither.

When a delegated cgroup is available the adapter runs the launcher inside `systemd-run --user --scope -p
Delegate=yes`. The launcher then:

1. verifies the scope holds only itself (it never touches the platform's own cgroup), moves itself to
   `<scope>/supervisor`, enables `memory pids cpu` and creates `<scope>/workload` with `memory.max`,
   `memory.swap.max=0`, `pids.max` and `cpu.max`;
2. starts the command directly in that leaf (`CLONE_INTO_CGROUP`), in its own process group, with rlimits
   (`RLIMIT_CPU`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`, no core dumps) and `PDEATHSIG`;
3. on cancel (SIGTERM from the platform, the platform dying — the launcher's own `PDEATHSIG` — or `--timeout`):
   SIGTERM to the group and to every workload process through pidfds re-checked for cgroup membership, waits the
   grace, then **`cgroup.kill`**: the kernel kills everything in the leaf — setsid sessions, double forks,
   reparented processes — and nothing outside it, so a reused PID can never be hit;
4. after the command exits by itself, kills whatever it left behind (orphans) the same way;
5. reaps every child (it is a child subreaper), reads `memory.peak`, `memory.events` (OOM kills, limit hits),
   `pids.events`, `cpu.stat` (usage, throttling) and the leaf's PSI stall totals, writes a JSON report (no argv, env
   or output) and ends **the way the command ended**: same exit code, or the same signal re-raised.

Without a delegated cgroup it falls back to the process tree: as a subreaper it sees every descendant (double forks
included), signals them through pidfds after re-checking their parent is inside the tree, and repeats the forced kill
until the tree is empty. With `isolation.mode = enforce` the cgroup is required: the adapter refuses to start the
command (fail closed), and the launcher itself refuses with `--cgroup=require` (exit 125, `isolation_unavailable`).

### Admission

`--slots N` per class (`agent`, `verification`): N lock files under `/tmp/ctp-admission-<uid>/<class>`, a launcher
holds one `flock` for its lifetime. The kernel releases it on exit, crash or kill, so slots cannot leak, and the bound
is per host across every platform instance of the account (the in-process verification slots stay as they are).
Before taking a slot the launcher defers while `/proc/pressure/memory` "some" avg10 is above `psiMemory` (40% by
default; CPU pressure gating is off by default), bounded by the admission timeout; a wait past it refuses the command
(`admission_timeout`) rather than running it. A launcher stopped while waiting ends without starting the command.
No adaptive scheduler, no host configuration changes.

Pressure wait past the deadline (amended with [ADR 0006](0006-go-code-search.md)): the first implementation of
`waitPressure()` gave up waiting and *admitted* the command when the deadline passed, contrary to the text above. It
now returns an error and the slot is released: a host whose pressure never drops runs nothing new (fail closed,
`TestPressureTimeoutRefusesTheCommand`).

Defaults (`config.supervision`, `supervisionBudget()` in `src/config.ts`; reviewed with ADR 0006 and again with
[ADR 0007](0007-go-knowledge-scan.md)): the services of the host keep their memory first — Node 1 GiB, platform-go
512 MiB, a local PostgreSQL 1 GiB, a local Ollama embedding model 2 GiB (each only when it runs on this host). Of the
rest, an agent may use at most `min(4 GiB, ⅓)` and a verification command `min(6 GiB, ⅓)`, and the slots are counted so
that the limits of every slot of both classes together never exceed it: verification `max(1, min(CPUs/4, rest /
2 × limit))`, agents `max(1, min(CPUs/2, (rest − verification slots × limit) / limit))`. On the 16-CPU / 15.5 GiB
development host (15,870 MiB) with a remote database and a local Ollama this is 2 agents and 1 verification command
at 4.0 GiB each (12,285 of 12,286 MiB), instead of 3 × 4 GiB + 2 × 6 GiB = 24 GiB before. `test/supervision-budget.test.ts` checks
the invariant across host sizes. Every value stays overridable in `config.supervision`. They only apply with the Go
engine; WSL2's VM otherwise lets one runaway build take half the host's memory. Code search and knowledge scans run
inside platform-go with their own bounds (4 searches × 4 subprocesses, 2 scans), not in these slots.

### TypeScript adapter

`src/agent/process/supervisor.ts` is now the only place that starts and stops these processes:
`superviseSpawn({command, args, cwd, env, class, graceMs, timeoutMs, limits, runId, attemptId})` returns the
`ChildProcess`, an idempotent `stop()` and a `done` report. Providers keep their protocols, watchdogs
(`superviseTurn`: wall-clock and idle limits stay in TypeScript, where activity is understood), failure classification
and their established stop policy (`graceMs`: 0 for Codex, Cursor and verification, 5 s for Copilot and Antigravity).
The typescript engine is the previous behaviour unified: detached spawn, SIGTERM-grace-SIGKILL of the group, descendant
scan with asynchronous `/proc` reads, orphans of the group killed on exit. The engine is chosen when a process
starts and recorded in its report; a command is never retried under the other engine. With the Go engine,
`supervisionNote` adds one line to the attempt log when the launcher OOM-killed, limited, refused or cleaned up after
a command, and verification output carries the same line.

The duplicated lifecycle code is gone: Codex `killTree`, `killCopilot`, `killAntigravity`, Cursor's two group kills,
`runCommand`'s group kill and the per-provider `childGroups` bookkeeping. The Cursor text completion now keeps the last
1 MiB of stdout and 8 KB of stderr instead of everything.

**Claude Agent SDK: unchanged.** With isolation enforced it already runs through `systemd-run --scope` (memory and
task limits) and bubblewrap with `--unshare-pid --die-with-parent`, so killing it kills its whole PID namespace;
without isolation the SDK owns its process, abort and stream handling. Putting the launcher under the SDK's
`spawnClaudeCodeProcess` would add a second cgroup layer and nothing it lacks; it can be done later through the same
adapter if limits are wanted for the unsandboxed path.

### Observability

The launcher exports one span per process (`process.supervise`, with `run.id` and `attempt.id` as span attributes for
correlation) and metrics with bounded attributes only (`class`, `outcome`, `isolation`): `process.start_latency`,
`process.admission_wait`, `process.duration`, `process.cleanup_duration`, `process.memory_peak`, `process.cpu_time`,
`process.cpu_throttled`, `process.io_pressure`, counters `process.runs`, `process.orphans`, `process.oom_kills`,
`process.limit_events` — through the existing platform-go OpenTelemetry setup, only when the platform has
`OTEL_EXPORTER_OTLP_ENDPOINT` (passed to the launcher as `CTP_SUPERVISE_*`, never to the command). The platform keeps
counters (`supervisionStats`: started per engine, active, outcomes, orphans killed, survivors, OOM kills, limit
events, admission wait, last report) and `GET /api/admin/isolation` now includes the supervision runtime: engine,
launcher, delegated cgroup (or why not), PSI, limits, slots, counters.

## Results

`npm run bench:process` (`docs/architecture/process-supervision.json`; legacy = the pre-migration Codex code path,
verbatim):

| Workload                                                               | legacy                                                    | typescript engine              | go engine                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------ | ---------------------------------- |
| stop a 200-process tree with setsid sessions and double-forked daemons | **50 survivors, never closes** (caller waits on the pipe) | **50 survivors, never closes** | **0 survivors, closed in 22.5 ms** |
| 8 agent-like JSONL streams (16,000 lines): wall / first output         | 297 ms / 46 ms                                            | 259 ms / 29 ms                 | 352 ms / **78 ms**                 |
| 200 MB stdout flood: wall / Node CPU                                   | 134 ms / 179 ms                                           | 102 ms / 94 ms                 | 134 ms / 86 ms                     |
| CPU build, 16 busy processes × 2 s: wall                               | 2,145 ms                                                  | 2,083 ms                       | 2,189 ms                           |
| mixed (agents + build + flood): Node event-loop p99 / Node CPU         | 10.1 ms / 239 ms                                          | 6.4 ms / 170 ms                | 7.3 ms / 336 ms                    |

Go-engine checks (from `go test ./internal/supervise` and the TypeScript suite): a 512 MB allocation under a 64 MB
limit is OOM-killed inside its leaf and reported as `oom`; a fork loop stops at `pids.max`; a busy loop under
`cpu-percent=20` is throttled; a 300 MB stream through a slow reader keeps the launcher under 40 MB RSS; five commands
behind 2 slots never run more than 2 at once.

**What the numbers say.** The Go engine's gain is correctness under adversarial process trees (no survivors, no hung
`close`, no PID confusion), limits and host-wide admission — not speed. It costs **30–50 ms per process start** (the
`systemd-run` scope), and Node CPU in the mixed run is higher (spawning `systemd-run` per process); streaming,
flooding and CPU-bound work are unchanged within noise, and the Node event loop is equally responsive. The unified
typescript engine is as fast as before and slightly cheaper for Node, but cannot reach double-forked daemons; that is
why the default stays `typescript` until the Go engine has been used daily, and why enforced isolation should use
`go`.

## Verification

- `go test -race ./internal/supervise` (Linux, mandatory in CI): streams, exit codes and signal pass-through (with and
  without a scope); background jobs, setsid sessions and double forks gone after exit; graceful SIGTERM, then forced
  kill of SIGTERM-ignoring trees; the platform killed with SIGKILL (parent-death cleanup); an unrelated process with
  the same name untouched and pids outside the cgroup never signaled (PID-reuse safety); memory/pids/CPU/file-size
  limits; fail closed without a cgroup; a 300 MB flood with a slow reader; host-wide admission and cancel before
  start; the command's environment free of launcher variables. Cgroup cases run when a delegated systemd user scope
  exists and are explicit skips otherwise; `CTP_REQUIRE_CGROUP=1` makes their absence a failure.
- `test/process-supervision.integration.ts` (both engines through the adapter): a JSONL protocol over stdin/stdout,
  exit codes, signals and `$` arguments identical; stop of SIGTERM-ignoring trees with detached descendants; orphan
  cleanup; environment isolation; OOM and pid limits reported; the verification bubblewrap sandbox still hides
  credentials and has only `lo` inside the launcher; fail closed for a missing launcher or a missing cgroup under
  enforced isolation (nothing ran); admission; per-process engine choice and diagnostics.
- The Codex, Antigravity, harness, engine, self-development, execution-contract and concurrent-subtask suites pass on
  both engines (`PROCESS_SUPERVISION_ENGINE=go PLATFORM_SUPERVISE_BIN=…`), including "server shutdown kills detached
  command process groups" (launchers are told to clean up; the test now matches the `bash` running the command
  instead of any process whose arguments contain its text).

## Rollout and rollback

`npm run build:go` builds `platform-go` and `platform-supervise` into `go/bin/`; `PLATFORM_SUPERVISE_BIN` points the
adapter at a prebuilt launcher, otherwise it is built next to platform-go under the data directory. Set
`PROCESS_SUPERVISION_ENGINE=go` to roll out; set it back to `typescript` (or remove it) and restart to roll back.
Each process keeps the engine it started with; nothing is restarted under the other engine. No schema or data change.

## Consequences and limitations

- Process start is 30–50 ms slower with the Go engine (systemd scope creation).
- Without a delegated cgroup (no systemd user manager, e.g. some CI runners and containers) the Go engine has no
  memory/pid/CPU limits and uses the process tree; enforced isolation refuses to run instead.
- A launcher killed with SIGKILL itself cannot clean up: its command gets `PDEATHSIG` SIGKILL, and with a cgroup the
  remaining processes stay in the scope until systemd collects it (the platform only ever sends SIGTERM).
- The TypeScript watchdog keeps the idle timeout (it is defined by provider activity, not output); the launcher's
  `--timeout` is a backstop one minute after the turn limit.
