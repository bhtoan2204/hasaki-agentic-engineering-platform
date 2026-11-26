# CodeAct M1 — Evidence Integrity

Branch `feat/codeact-evidence-eval-composition`, based on main `f666c65`. Verified 2026-11-22 (Asia/Ho_Chi_Minh) on
WSL2 Linux 6.6.114.1, Node v22.23.5, private PostgreSQL test cluster (`test/run-integration.ts`; no shared RDS).
Feature flags in tests: `codeAct.enabled = true` per test, `codeAct.persistTimeoutMs` 10 000 (200 in the timeout case).

## Problem (confirmed on `f666c65`)

`src/codeact/execute.ts` recorded each nested call with
`Promise.resolve(deps.record(rec, result, error)).catch(() => {})`, and `src/codeact/surfaces.ts` emitted
`codeact:<execution>:<seq>` for every call with `status === "ok"`. A failed (or hung) INSERT was invisible: the
answer cited a row that did not exist, and a hung INSERT hung the execution. Nothing resolved references at all.

## Fix

| Piece                    | Behavior                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executor (`execute.ts`)  | Each recording's outcome is kept on its `CallRecord`: `persisted: true`, or `false` with `persist_error` (rejection, synchronous throw, or `persistTimeoutMs` exceeded). No recorder → `undefined` (unknown, never claimed). The result still waits for every in-flight recording.                        |
| Surfaces (`surfaces.ts`) | A ref is emitted only when the call succeeded, its row was persisted, **and** this surface finalized the execution (`running → ok/error`). Otherwise the answer keeps the program value and reports `evidence_status` (`complete`/`partial`/`none`), `recorded: false` on the call and a `warnings` line. |
| Resolver                 | `resolveCodeActEvidence(actor, ref, {support})`: successful call of a finalized execution, owner only; admin only in support mode (audited `support.access`); malformed/foreign/unknown → `null`.                                                                                                         |
| Duplicates               | `UNIQUE (execution_id, seq)` (migration 089) refuses a second row; a refused write is an unpersisted call.                                                                                                                                                                                                |

**Degraded, not failed (option B).** The platform never treats a CodeAct value as evidence (`untrusted: true`); what is
evidence is the cited rows. So a recording failure removes the citation and says so, rather than discarding a value
the model may still use as an untrusted observation. No workflow step currently declares "durable evidence required";
the M4 verification gate rejects any cited ref that does not resolve.

## Verification

| Level         | Command                                                                                                                                      | Exit | Result                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------- |
| 1 Unit        | `node --import ./test/env.ts --test test/codeact-evidence.test.ts`                                                                           | 0    | 8/8                                       |
| 2 Integration | `node test/run-integration.ts test/codeact-evidence.integration.ts`                                                                          | 0    | 11/11 (0 skipped)                         |
| 3 Runtime     | same file, test "runtime: through the real OS sandbox…" (bubblewrap launcher)                                                                | 0    | pass                                      |
| Regression    | `npm test`                                                                                                                                   | 0    | 1128/1128                                 |
| Regression    | `node test/run-integration.ts test/codeact-surfaces.integration.ts test/codeact-sandbox.integration.ts test/codeact-evidence.integration.ts` | 0    | 27/27 (before the sandbox test was added) |
| Static        | `npx tsc --noEmit -p .`, `-p web`, `npm run lint`, `npm run arch:check`                                                                      | 0    | 5 cycles / 6 violations (baseline)        |

Failure injection is done in PostgreSQL (triggers on the private cluster): `RAISE EXCEPTION` for tool
`evi.unrecordable`, `pg_sleep(0.8)` for `evi.slowrecord`, and a flag-guarded `RAISE` on finalizing `code_executions`.

Tests in `test/codeact-evidence.integration.ts`: success + resolution; insert failure; all recordings fail; recording
timeout; cancellation during a write; finalize failure; duplicate `(execution, seq)`; interrupted-execution recovery;
cross-owner / admin support isolation and malformed refs; Chat surface; real OS sandbox.

**Mutation check.** Replacing the citing rule with the old behavior (`recorded = () => true`) makes 5 of these tests
fail (insert failure, all-fail, timeout, finalize failure, chat).

### Evidence identifiers (fixture database, controlled run)

```
M1-EVIDENCE {"execution_id":1,"refs":["codeact:1:1","codeact:1:2"],
  "rows":[{"seq":1,"tool":"evi.orders","status":"ok","result":{"result":{"order":"ORD-1","status":"timeout"}}},
          {"seq":2,"tool":"evi.orders","status":"ok","result":{"result":{"order":"ORD-2","status":"timeout"}}}]}
M1-FAILURE-INJECTION {"execution_id":2,"emitted":["codeact:2:1","codeact:2:3"],
  "warnings":["call 2 (evi.unrecordable) was not recorded: injected insert failure; its result is not citable evidence"]}
M1-SANDBOX {"refs":["codeact:13:1","codeact:13:2","codeact:13:3"],"stats":{"duration_ms":78,"calls":3,"result_bytes":108}}
```

Every ref in `M1-EVIDENCE` and `M1-SANDBOX` was resolved with `resolveCodeActEvidence` as the owner in the test;
`codeact:2:2` (the injected failure) has no row and resolves to `null`.

## Limitations

- A row that lands after `persistTimeoutMs` exists but is never cited (by design; it may still be read by the resolver).
- No HTTP route exposes the resolver yet; it is used in-process (and by the M4 verification gate).
- Level 4/5 do not apply to M1.
