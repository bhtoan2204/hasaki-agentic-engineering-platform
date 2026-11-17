# Architecture governance

The platform is a modular monolith. HTTP routes authorize requests and call module services or module-owned persistence operations for simple reads and writes. Services own workflow decisions and multi-write transactions. Repositories use the existing PostgreSQL pool and accept a caller's `Db` client where an operation participates in a transaction. They do not open transactions.

| Capability | Persistence boundary | Application responsibility |
| --- | --- | --- |
| Work items | `src/workitems/repository.ts` handles owner-scoped reads, imports, manual edits and history. | `service.ts` validates manual requests, locks imported items within its transaction, preserves manual descriptions and applies explicit automation policy. |
| Workflow definitions | `src/workflow/definitionRepository.ts` handles definitions, drafts, published versions and reference projections. | `definitions.ts` validates, hashes, publishes under the definition lock, merges template changes and manages the version cache. |
| Run and step read models | `src/workflow/runRepository.ts` loads run details, steps, attempts, questions, artifacts, checkpoints, jobs, sessions and handoff data. | `engine.ts` derives worker/recovery and approval presentation state. It still owns lifecycle transactions and state changes. Run and step details issue independent queries concurrently and can reflect different commit instants. |
| Context and knowledge | `src/context/repository.ts` inserts immutable snapshots and reads attempt context evidence. `src/knowledge/usageRepository.ts` reads historical uses. | The context resolver computes and hashes snapshots before storage. The knowledge service inspects current and draft specs for assignments. Routes authorize evidence reads through the owning run or attempt. |
| Evaluation and adjacent modules | `src/eval/resultsRepository.ts` reads scoped results. Recommendation, pull request, outcome and index queries use their existing modules. | Evaluation summaries, authorization, provider operations and indexing policies stay in their respective services. |

Other established persistence boundaries include the Git repository registry and access module (`src/repos`), credential stores (`src/auth` and `src/integrations`), and legacy read models/settings (`src/db.ts`). Migrations and pooling live in `src/db`. Scheduler claims, lease recovery, execution mutations, and lock-sensitive workflow operations keep their specialized SQL close to the state transitions they coordinate. See [Workflow engine modularization](workflow-engine-modularization.md) for the lifecycle lock order and transaction map. See [Durable execution checkpoints](execution-checkpoints.md) for recovery and retention.

`npm run arch:check` runs the static import-graph checks in CI and in `test/architecture.test.ts`.

| Rule | Enforcement |
| --- | --- |
| `no-circular` | Rejects new strongly connected components. A component contained in an existing baselined component is tolerated. |
| `no-provider-from-core` | Workflow and evaluation core cannot import the Claude module or a provider adapter. |
| `no-provider-internals` | Other modules can import a provider's `run.ts`, `capabilities.ts` or `index.ts` entry point. |
| `no-db-from-api` | API modules cannot import `pg` or raw database infrastructure. The stream listener owns its dedicated PostgreSQL connection and replay SQL. Metrics and the three existing analytics query modules own specialized read models and the incident override write. These exceptions are listed by file in `src/architecture/check.ts`. |
| `repository-dependencies` | Files named `repository.ts` or ending in `Repository.ts` can depend on the pool, the legacy persistence module, other repositories, and shared `types.ts` modules. |

The checks cover static, re-export and literal dynamic import edges. `architecture/baseline.json` records existing cycles and provider couplings. `npm run arch:baseline` can remove fixed violations or shrink an existing cycle. It fails when it finds any new violation.
