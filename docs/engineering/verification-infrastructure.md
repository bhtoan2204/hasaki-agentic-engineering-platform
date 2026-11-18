# Development and verification infrastructure: benchmark and changes

Measured on 2026-11-18 on one WSL2 host with 24 CPUs, Node 22, TypeScript 6.0.3. Wall times are single runs. Rerun them before relying on small differences.

## Bottlenecks found

| Command                      |                                                               Before | Cause                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`          |                                    14.1 s every run; 830 MB peak RSS | full rebuild of 1,116 files each time; the root project check takes 4.7 s of 6.0 s (`--extendedDiagnostics`: 291k instantiations, 703 MB) |
| `npm run lint`               |                                          7.5 s every run; 570–600 MB | no ESLint cache                                                                                                                           |
| `npm run build`              |                                                                0.6 s | not a bottleneck                                                                                                                          |
| `npm test` (unit, 717 tests) |                                                    10.3 s, 784 % CPU | already parallel                                                                                                                          |
| `npm run test:integration`   |                      separate from unit tests; CI shards both 3 ways | already separated                                                                                                                         |
| Agent verification           | each step reran the same tests; no limit on concurrent test commands | evidence lookup was per step; singleflight was per loop                                                                                   |

No expensive generic hot spot was found. The check time is spread across the 143k lines of TypeScript.

## Changes

- **Typecheck:** `tsc --incremental`, with build info under `node_modules/.cache/tsc/`. CI restores it per lockfile. Strictness and the file set are unchanged.
- **Lint:** `eslint --cache --cache-strategy content`, with the cache under `node_modules/.cache/eslint/`.
- **Verification evidence** (`src/agent/verifyEvidence.ts`):
  - Evidence is reused by any step of the same run when the full key matches. Before, only the same step could reuse it.
  - Identical concurrent verifications in one process run once, across steps.
  - Evidence older than `VERIFICATION_EVIDENCE_RETENTION_DAYS` (default 30) is purged on the scheduler's hourly retention pass.
- **Resource limit:** verification commands take one of `VERIFY_MAX_CONCURRENT` slots per process (default: a quarter of the CPUs, at least 1). The wait is abort-aware and does not count toward the command timeout. A wait over 1 s is written to the verification log.

## After

| Command             |   Cold | Warm (no change) | Warm (one source file edited) |
| ------------------- | -----: | ---------------: | ----------------------------: |
| `npm run typecheck` | 11.6 s |        1.7–2.5 s |                         6.4 s |
| `npm run lint`      |  7.6 s |            0.6 s |                             — |

### Verification evidence

The benchmark is `test/verification-evidence.bench.ts`. It uses a simulated 150 ms runner, so it measures the cache and not real test time.

| Scenario                                                                               | Runs without cache | Runs, cache before | Runs, cache after |
| -------------------------------------------------------------------------------------- | -----------------: | -----------------: | ----------------: |
| MULTI_SUBTASK                                                                          |                  6 |                  2 |                 2 |
| IMPLEMENT_REVIEW (implementation, then two downstream steps on an unchanged workspace) |                  4 |         4 (825 ms) |        2 (537 ms) |

Before this change the benchmark showed no reuse at all. Its simulated runner reported no executed tests, and that is never stored as evidence. The runner now reports one passing test.

## Evaluated, not adopted

- **TypeScript native compiler** (`@typescript/native-preview` 7.0.0-dev.20260707.2):
  - It checks both projects in 1.1 s cold (root 0.72 s with 660 MB, web 0.39 s), compared with 14 s for `tsc`.
  - On a probe file with assignment, unused-variable and generic-variance errors, it printed the same codes, positions and messages as `tsc` 6.0.3.
  - It is not adopted because it is still a dev preview. It is the strongest candidate once a stable 7.0 ships.
- **Running the two projects in parallel:** cold time fell to 6.6 s, but both checkers then sit in memory at once. Incremental builds already make warm runs about 2 s, so this was not adopted.
- **Project references:** the two projects share no sources, so references would add configuration without reducing work.

## Remaining limitations

- `npm run lint` already fails on `main`, with 1,545 errors in 242 files (mostly `no-explicit-any` and `no-empty`). The cache makes the run faster but does not fix this.
- The singleflight and slot limit apply within one process. Workers on other instances only share the stored evidence.
- The baseline run of the base branch (`goBaseline`) goes through the same limited runner, one slot at a time.
