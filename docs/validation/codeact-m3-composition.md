# CodeAct M3 — Unified Read-only Tool Composition

Branch `feat/codeact-evidence-eval-composition` (after M2 `fcf4a49`), 2026-11-22, WSL2 Linux 6.6.114.1, Node v22.23.5,
private PostgreSQL cluster, platform-go started by the test fixture, real TypeScript language server, real bubblewrap
sandbox for the runtime test.

## Design

One program may now call, besides read-only integration tools, an **explicit allowlist** of platform reads:

| Surface  | Name in a program                                                                                          | Family                              | Executed by (the direct path, unchanged) |
| -------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| Workflow | `platform.search_code`, `platform.get_symbol`, `platform.find_dependencies`                                | code_intelligence                   | `dispatchPlatformTool`                   |
| Workflow | `platform.navigate_code`                                                                                   | lsp                                 | `dispatchPlatformTool`                   |
| Workflow | `platform.search_knowledge`, `platform.get_business_rules`                                                 | knowledge                           | `dispatchPlatformTool`                   |
| Workflow | `platform.search_task_memory`                                                                              | memory                              | `dispatchPlatformTool`                   |
| Workflow | `platform.get_run_context`                                                                                 | run_context                         | `dispatchPlatformTool`                   |
| Chat     | `platform.code.search` / `platform.code.navigate` / `platform.knowledge.search` / `platform.knowledge.get` | code_intelligence / lsp / knowledge | `executeChatTool`                        |

- **No second registry or policy engine.** The adapter (`CodeActCapability` in `src/codeact/surfaces.ts`) is a name, a
  family and a `call` that _is_ the surface's own dispatcher. The workflow dispatcher is handed to `execute_code`
  only (`PlatformToolEnv.dispatch`), so a nested read re-runs binding validation, frozen benchmark permissions,
  attempt `allowed_tools` (`platform.<name>`), the loop detector, repository scope, the per-attempt concurrency limit,
  the deadline, redaction and the `agent_context_tool_calls` journal — exactly as a direct call.
- **Shared budgets.** Platform reads are nested calls of the same broker: the same call/byte/concurrency budgets,
  per-call deadline, cancellation and M1 evidence recording (`code_execution_calls`, `codeact:<id>:<seq>`).
- **Excluded by construction.** Not in the allowlist, hence `unknown tool`: `execute_code` / `code.execute`
  (recursion), `request_clarification`, `submit_result`, `ask_user`, `post_update`, step outputs, work items,
  operations, delegation, imports, database queries. Mutating integration tools stay refused (`read-only`). Integration
  tools named `platform.*` are never listed (no shadowing). `navigate_code` is composable only when LSP is enabled,
  like the direct tool.
- **Provenance and freshness.** Each call in the answer carries `source: {family, trust}`; `sources` summarizes calls
  per family with a caveat (indexed syntax ≠ semantic resolution; memory only when `freshness.state` is FRESH; LSP
  `unavailable`/`stale` is not evidence of absence); `missing_sources` names families with no successful call. The
  tools' own provenance (snapshot commit, index fallback warning, memory freshness, LSP status) is in the recorded
  result and reaches the program unchanged. Errors keep categories (`unauthorized`, `invalid_input`, `timeout`, …).

## Verification

| Level         | Command                                                                                                                                                                | Exit | Result                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------- |
| 2 Integration | `node test/run-integration.ts test/codeact-composition.integration.ts`                                                                                                 | 0    | 14/14                              |
| 3 Runtime     | same file, "runtime: the real OS sandbox composes …"                                                                                                                   | 0    | pass                               |
| Regression    | `node test/run-integration.ts --test-concurrency=6 test/codeact-*.integration.ts test/context-native.integration.ts test/lsp.integration.ts test/chat*.integration.ts` | 0    | 116/116                            |
| Regression    | `npm test`                                                                                                                                                             | 0    | 1128/1128                          |
| Static        | `tsc` (root, web), `npm run lint`, `npm run arch:check`                                                                                                                | 0    | 5 cycles / 6 violations (baseline) |

Tests: integration + code intelligence (journaled like direct calls, resolvable evidence); integration + knowledge +
memory with another owner's private memory forged into the snapshot (dropped); integration + LSP + code intelligence

- knowledge combined; uncommitted-worktree navigation; stale code index (fallback labelled candidates); missing
  language server (`unavailable`, other sources still answer); LSP disabled (not composable); unauthorized repository
  (`outside authorized run scope`, category `unauthorized`), mutation, recursion, clarification and submit attempts
  (refused, no question created); partial integration failure (`missing_sources: ["integration"]`); shared call budget;
  cancellation (no nested read after abort); stale memory (`STALE`, body withheld); Chat composition through
  `executeChatTool` (recursion refused).

**Mutation check.** With the workflow capability list emptied, 11 of the (then 13) tests fail.

**Test isolation fix.** `test/codeact-sandbox.integration.ts` searched the whole host for `runner.mjs` processes, so
it failed whenever another test file ran a CodeAct program concurrently (seen with the new files). It now names each
execution's systemd scope and checks only that cgroup, and asserts the detector sees a running program first.

### Runtime evidence (fixture database, real OS sandbox)

```
M3-SANDBOX {"run_id":13,"value":{"events":1,"code_hits":1,"nav":"ok","rules":1},
  "evidence":["codeact:13:1","codeact:13:2","codeact:13:3","codeact:13:4"],
  "sources":{"integration":{"calls":1,"ok":1},"code_intelligence":{"calls":1,"ok":1},"lsp":{"calls":1,"ok":1},
             "knowledge":{"calls":1,"ok":1}},
  "stats":{"duration_ms":852,"calls":4,"result_bytes":1466}}
```

All four references were resolved as the owner in the test.

## Limitations

- The per-attempt context-read concurrency limit (4, including the running `execute_code`) applies to nested reads:
  at most 3 platform reads run at once inside a program; a fourth gets a `budget_exceeded` error.
- Chat composition covers code search, LSP and knowledge; Chat has no task-memory or run-context tool to compose.
- A nested platform read cannot be interrupted mid-flight (the direct dispatcher takes no signal); its late result is
  discarded and nothing runs after cancellation.
- Live-provider use of composition is NOT VERIFIED (no model calls were made).
