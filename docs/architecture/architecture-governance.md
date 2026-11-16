# Architecture governance (fitness check)

`npm run arch:check` runs a static import-graph analysis (`src/architecture/check.ts`, no extra dependency) in CI
(`architecture` job) and in the offline test `test/architecture.test.ts`. Rules:

| Rule | Meaning |
| --- | --- |
| `no-circular` | No new import cycle (strongly connected component). A cycle that stays inside a baselined cycle is tolerated. |
| `no-provider-from-core` | `src/workflow` and `src/eval` must not import `src/agent/claude.ts` or a provider adapter (`codex`, `cursor`, `antigravity`, `copilot`). |
| `no-provider-internals` | Outside `src/agent/<provider>/`, only that provider's `run.ts`, `capabilities.ts` or `index.ts` may be imported. |

`architecture/baseline.json` lists the pre-existing violations. It is a ratchet: new violations fail the check, and
`npm run arch:baseline` rewrites it after violations are fixed so it only shrinks. Never add entries by hand to
silence a new violation.

Before numbers (base commit): 257 source files, 1281 import edges, 5 cycles, 16 baselined violations
(including the `workflow/executors -> agent/claude.ts` and `eval/runner.ts -> agent/claude.ts` couplings that
the provider-agnostic runtime phase removes).
