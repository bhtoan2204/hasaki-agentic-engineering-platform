# Chat performance, streaming reliability and frontend responsiveness (2026-11)

Scope: the existing TypeScript/React Chat (no module moved to Go). Every fix below comes from a measured root cause, has
a regression test and a before/after measurement (`docs/architecture/chat-performance.json`). Host: 16 CPUs / 15.5 GiB
WSL2, local PostgreSQL without injected latency (the benchmark proxy forwards at once since the hardening review),
stub providers.

## Root causes and fixes

| #   | Finding                                                                             | Root cause                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Measured (before → after)                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The Chat page reconnected its stream on every render                                | The SSE effect depended on the `useApi()` result, a new object on each render: every streamed delta and every keystroke closed the EventSource and opened another. The server starts a new stream at the latest event, so events between the two were lost (the 8 s poll hid it) | The effect depends only on the conversation id; handlers read the latest list reload and `t` through refs                                                                                                                                                                                                                                                                                                                                                                                                    | Stream connections for one streamed turn: **58 → 1** (200-message conversation: 22 → 1)                                                                                                                                                                                                                                                 |
| 2   | The open conversation was polled every 8 s although its stream was healthy          | A fixed `setInterval` beside the stream                                                                                                                                                                                                                                          | Polling is the recovery path only: while the stream is in error or the server reports its LISTEN down (`hello.live === false`). After an interruption, a replay reset or a turn that may have ended before the stream started, the detail is reloaded once. Bursts of terminal events (completed, partial, title) are coalesced into one detail and one list reload                                                                                                                                          | Detail requests in 20 idle seconds: **2 → 0**; per turn unchanged (2 detail, 2 list)                                                                                                                                                                                                                                                    |
| 3   | A late detail response could replace a newer one                                    | Concurrent `loadDetail` calls (send, event, poll) applied in arrival order                                                                                                                                                                                                       | Latest request wins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | correctness (switching and reconnect tests)                                                                                                                                                                                                                                                                                             |
| 4   | Each render re-parsed every message's markdown and re-rendered the whole transcript | `Markdown` ran `marked` + sanitize on every render; the transcript was inline in the page                                                                                                                                                                                        | `Markdown` is memoized on its text; the stored transcript is a memoized component with stable handlers, so deltas, status lines and keystrokes re-render only the live bubble and the composer                                                                                                                                                                                                                                                                                                               | 200-message conversation, typing: **14.2 → 0.7 ms** script per key (task 25.1 → 6.3 ms). Streaming 300 tokens: script **292 → 55 ms**, main-thread tasks 771 → 531 ms, layout 37 → 41 ms                                                                                                                                                |
| 5   | The first visible text waited for the 200 ms flush                                  | `TurnStream` scheduled the first batch at `flushMs`, like every later one                                                                                                                                                                                                        | Throttle on the leading edge: the first update after a quiet period is written on the next tick, later ones at most once per 200 ms (still never one row per token)                                                                                                                                                                                                                                                                                                                                          | First visible delta, one turn p50/p95: **225/271 → 25/42 ms**; 8 concurrent turns 245/276 → 37/57 ms                                                                                                                                                                                                                                    |
| 6   | Every chat admission spawned the provider readiness probe                           | `admitProvider` → `probeAgentHealth()` on every turn and every title; Claude's check is a `claude auth status` process (~0.3 s, ~150 MiB) with no cache, and eight turns starting together ran eight of them                                                                     | Readiness shared by concurrent admissions and reused 10 s (`sharedAgentHealth`); remembered quota applies on every read; invalidated when a call fails as unauthenticated/unavailable/startup timeout; a fresh status-page probe ("Refresh health") becomes the shared reading. Workflow steps share it too since Phase 4B (`phase4-performance.md`)                                                                                                                                                         | Probes for 8 new conversations: **16 → 1**                                                                                                                                                                                                                                                                                              |
| 7   | Titles of new conversations competed with their first answers                       | `postMessage` started the title (one more provider process, 3–4 s) next to the turn                                                                                                                                                                                              | The deterministic fallback title is stored with the first message (unchanged). The generated title waits until that first turn settles, runs in at most `CHAT_TITLE_CONCURRENCY` (2) slots and yields while any turn runs on the instance (bounded to 30 s). It reuses the provider that just answered (no admission); a failed first turn is admitted like a turn. Explicit regeneration skips both waits and is merged with a waiting job; a manual rename still wins (`title_source` check in the update) | 8 new conversations at once, last first delta p50/p95: **456/931 → 81/117 ms** (under load 382/415 → 111/161); last completion 737/1258 → 554/608 ms; event-loop p99 12.8 → 6.0 ms, max 49 → 24 ms; CPU pressure stall 5.2 s → 0.3 s; pool waiters max 6 → 0. Trade-off: the last of 8 titles appears after **14.6 s instead of 3.7 s** |
| 8   | "156 SQL statements per turn"                                                       | A benchmark artifact: the observer polling turn state every 5 ms went through the counting proxy (~80 of the 156)                                                                                                                                                                | The observer uses its own connection outside the proxy                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Real count: **78** statements per turn                                                                                                                                                                                                                                                                                                  |
| 9   | 78 statements per turn, 6 transactions                                              | The agent configuration was read 3–4 times per turn, each in BEGIN/SELECT/COMMIT (only the one-time legacy import needs the lock); each phase change was an UPDATE plus an event INSERT                                                                                          | Configuration read once per turn and passed to admission and completion; outside a transaction when the row exists; phase and its `phase.updated` event in one statement (data-modifying CTE, the insert trigger still NOTIFYs)                                                                                                                                                                                                                                                                              | **78 → 65** per turn (BEGIN/COMMIT 6 → 2); 8 concurrent turns 616 → 493; pool waiters max 6 → 0                                                                                                                                                                                                                                         |
| 10  | Test suites called the real model                                                   | Tests keep the developer's HOME, where the CLIs are logged in; chat integration suites posted first messages without a title seam, so every run generated titles on the developer's Claude account                                                                               | In tests (`PLATFORM_TEST=1`) a title without `setChatTitleComplete` keeps its fallback title; `CHAT_TITLE_REAL_IN_TESTS=1` opts in                                                                                                                                                                                                                                                                                                                                                                           | no model calls from `npm run test:integration`                                                                                                                                                                                                                                                                                          |

Chat completion latency is provider-bound (the stub streams for ~450 ms): 494 → 487 ms p50 for one turn, 519 → 504 ms
for 8 concurrent turns. Event loop p99 stays at 6 ms; peak RSS 175–196 MiB in both.

### Measurements

`npm run bench:runtime` (`BENCH_N=8 BENCH_SCENARIOS=chat_turn,chat_concurrent,chat_new_titles BENCH_LOAD_WORKFLOW=1`);
before = the same benchmark files on commit e1efb08. "Under load": a knowledge import of 5 repositories, exact and
symbol code searches over 3 checkouts and a 12-step workflow run, in a loop in the same process.

| p50 / p95                                         | before       | after         |
| ------------------------------------------------- | ------------ | ------------- |
| one turn: first visible delta                     | 225 / 271 ms | 25 / 42 ms    |
| one turn under load                               | 223 / 274 ms | 26 / 65 ms    |
| 8 concurrent turns: last first delta              | 245 / 276 ms | 37 / 57 ms    |
| 8 concurrent turns under load                     | 263 / 273 ms | 52 / 69 ms    |
| 8 new conversations with titles: last first delta | 456 / 931 ms | 81 / 117 ms   |
| the same under load                               | 382 / 415 ms | 111 / 161 ms  |
| 8 new conversations: all titles settled           | 3.7 / 3.9 s  | 14.6 / 14.7 s |
| SQL statements per turn (platform only)           | 78           | 65            |

In `chat_new_titles` every admission pays a real readiness probe, and a title costs what a real one does (a Claude CLI
start plus 3.5 s, the measured wall time of a real title) without calling a model; `BENCH_REAL_TITLES=1` uses the real
SDK. Node CPU per operation of that scenario rises (531 → 811 ms) only because the samplers run over a 4× longer window
(measured: 400 ms of sampler CPU in 11 s). With real titles (the developer account, before this was made opt-in) the
last first delta was 413 → 81 ms p50.

Frontend: `npm run build && npm run smoke:chat` (production bundle, real server and LISTEN/NOTIFY, Chromium; React
commits through a devtools hook, main-thread time from the CDP Performance domain). `CHAT_BENCH_OUT=<file>` writes the
numbers.

|                                                                | before            | after            |
| -------------------------------------------------------------- | ----------------- | ---------------- |
| stream connections, one streamed turn after typing             | 58                | 1                |
| stream connections, one turn in a 200-message conversation     | 22                | 1                |
| detail requests, 20 s idle with a healthy stream               | 2                 | 0                |
| detail / list requests per turn                                | 2 / 2             | 2 / 2            |
| 200 messages, typing: script / task per key                    | 14.2 / 25.1 ms    | 0.7 / 6.3 ms     |
| 200 messages, 300-token stream: React commits / script / tasks | 20 / 292 / 771 ms | 24 / 55 / 531 ms |

## Claude Agent SDK and `process.report.getReport()`

Confirmed against the installed `@anthropic-ai/claude-agent-sdk` 0.3.316: `query()` calls
`process.report.getReport()` once (musl detection, to pick the bundled native CLI package) **only when
`pathToClaudeCodeExecutable` is not set**. Measured: 1 call per query (3.7 ms) by default, 0 with the option set;
`getReport()` takes 1.6 ms with no open sockets, 2.8 ms with 50 and 5.8 ms (max 7.9 ms) with 200, all of it blocking
the event loop; `process.report.excludeNetwork` lowers the 200-socket case to 3.2 ms.

Supported mitigation, without patching the SDK: set `CLAUDE_CODE_EXECUTABLE` (or `agent.claudeBin`) — the platform
already passes it as `pathToClaudeCodeExecutable` to every `query()` (completion, agent steps, provider discovery).
Pointing it at the SDK's own bundled binary (`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, or the
`-musl` package on Alpine) keeps the exact CLI version the SDK would have chosen. Not done in code: replicating the
SDK's package resolution would break silently when it changes, and `excludeNetwork` is a process-wide diagnostics
setting. Worth an upstream issue: the detection result cannot change during a process and could be cached.

## Not changed (no measured benefit or out of scope)

- List virtualization: the API returns at most 200 messages; after #4 typing in a 200-message conversation costs
  0.7 ms of script per key and a streamed answer re-renders only the live bubble.
- Each NOTIFY of a chat event is followed by one `SELECT` of the row per subscribed instance (the trigger sends only
  ids): ~20 events per turn. Carrying the row in the payload needs a migration and the 8 kB NOTIFY limit; not a
  measured bottleneck.
- Each running turn checks its own status once a second (cross-instance cancel): 1 statement/s per running turn.

## Regression tests

- `test/chat.browser.ts` (`npm run smoke:chat`): one stream per open conversation across typing and a streamed turn;
  no detail polling while idle; switching conversations mid-stream (only the new conversation's stream is open, the
  old partial answer is not shown there, the answer appears once on return); a dropped stream (server-side
  disconnect) reconnects with Last-Event-ID and the stored answer is complete, in order and shown once; long transcript
  under a high-frequency stream. Against the previous frontend, the first, second and fifth fail (57 connections,
  2 polls, 22 connections).
- `test/chat-title.integration.ts`: 8 new conversations (fallback titles immediately; generated titles only after the
  last first turn, never while a turn runs, at most 2 at a time, each with its update event; one shared probe);
  manual rename during generation wins; explicit regeneration runs during a running turn and is not duplicated; a
  failed first turn still gets a title through admission, and its failure makes the next admission probe again.
- `test/chat-streaming.integration.ts`: the first delta is stored < 150 ms after the provider's first text (was the
  200 ms flush), later deltas stay throttled.
- `test/chat-scheduling.test.ts`: turn-activity waits (settle, idle, deadline); shared health (one probe for 8
  concurrent readers, reuse, remembered quota, invalidation, priming, failed probes not reused).
- Existing chat suites (authorization, idempotent client message ids, cancel/retry, provider fallback, tool audit,
  checkpoints, repository revocation) pass unchanged.

## Remaining limitations

1. Titles now trail the answers: with 8 new conversations the last generated title appears ~15 s after the turns (the
   fallback title is visible at once), and under sustained chat traffic each title waits up to 30 s for a moment
   without running turns before it runs anyway. `CHAT_TITLE_CONCURRENCY` trades this against contention.
2. Title scheduling is per instance and in memory: a restart drops pending titles (the fallback stays; "Regenerate
   title" works), and turns running on another instance do not delay this instance's titles.
3. Shared readiness can be up to 10 s stale: a provider logged out in that window fails its call and falls back (AUTO)
   or reports the failure (manual without fallback), and the failure invalidates the reading.
4. A turn that ends between the detail request and the stream's first `hello` is recovered by one detail reload on
   `hello` while a turn is active; an idle conversation does not reload.
5. The SDK `getReport()` cost remains unless `CLAUDE_CODE_EXECUTABLE` is configured.
6. The browser suites need Chromium and its system libraries; CI does not run them.
