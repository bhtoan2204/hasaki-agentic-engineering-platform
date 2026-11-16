# Module-Based Repository Layer Architecture

## 1. Overview and Architectural Goals

The **Module-Based Repository Layer** in the Hasaki Agentic Engineering Platform establishes a clean, decoupled boundary between application/business logic and database persistence.

Prior to this architecture, raw SQL queries were scattered across HTTP controllers (`src/api/routes.ts`, `src/api/metrics.ts`) and application domain services (`src/workitems/service.ts`, `src/repos/service.ts`, `src/knowledge/service.ts`, `src/eval/service.ts`, `src/workflow/engine.ts`, `src/auth/users.ts`). This violated the **Single Responsibility Principle (SRP)** and **Dependency Inversion Principle (DIP)**, making unit testing difficult and creating tight coupling to PostgreSQL table schemas.

### Core Principles

- **Module-Scoped Persistence**: Each domain module maintains its own repository in `src/<module>/repository.ts` (e.g., `src/workitems/repository.ts`, `src/workflow/repository.ts`, `src/repos/repository.ts`, `src/knowledge/repository.ts`, `src/eval/repository.ts`, `src/agent/repository.ts`, `src/auth/repository.ts`).
- **No God Object**: Repositories are strictly decentralized across business boundaries. There is no centralized `src/repository/index.ts` or monolithic repository hub.
- **No Generic `BaseRepository<T>`**: In adherence to **KISS** and **YAGNI**, generic CRUD base classes and heavy ORM abstractions are deliberately prohibited. Database operations are explicitly typed and use-case driven.
- **Node 22 Native Compatibility**: Implemented in clean, typed functional modules without runtime decorators, code generators, or reflection containers, preserving instant startup under Node 22 native type-stripping.

---

## 2. Dependency Flow and Architecture Layering

The dependency hierarchy follows a strict unidirectional flow:

```
┌────────────────────────────────────────────────────────┐
│     API Controllers / HTTP Handlers (src/api/*)        │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│   Application & Domain Services (src/<module>/service) │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│    Module Repositories (src/<module>/repository.ts)    │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│     Database Infrastructure (src/db/pool.ts, pg)       │
└────────────────────────────────────────────────────────┘
```

1. **API Controllers** invoke domain services or query-oriented module repositories. Controllers never issue raw SQL queries.
2. **Application Services** contain validation, domain invariants, access control checks, and workflow coordination. Services consume module repositories.
3. **Module Repositories** encapsulate SQL queries, parameter binding, row mapping, and low-level relational operations.
4. **Database Infrastructure** (`src/db/pool.ts`) provides connection pooling, `q` and `one` query helpers with regex-based cache invalidation, transactional execution (`withTx`), and deferred batch inserts (`insertDeferred`).

---

## 3. Transaction Management & Concurrency Control

### Atomic Multi-Repository Transactions

To coordinate multiple repositories in an atomic business transaction without connection leaks or transaction splitting:

- Every repository function accepts an optional `db: Db = pool` as its final parameter (where `type Db = pg.Pool | pg.PoolClient`).
- When executing outside a transaction, functions default to `pool`.
- When coordinating within a transaction, services open a transaction via `withTx(async (c) => ...)` and pass the transactional client `c` to all repository calls.

```typescript
// Example: Atomic multi-repository coordination
await withTx(async (client) => {
  const item = await workItemsRepository.getWorkItemById(id, client);
  await workItemsRepository.updateWorkItem(id, { status: "ACTIVE" }, client);
  await workflowRepository.insertRun({ workItemId: id }, client);
});
```

### Critical Invariants

1. **Never Nest `withTx`**: Repositories must never initiate a transaction internally with `withTx`. Transactions are owned and delimited exclusively by the calling application service or orchestration layer.
2. **PostgreSQL Concurrency Primitives**:
   - `SELECT ... FOR UPDATE`: Row-level locking during sensitive updates.
   - `SELECT ... FOR UPDATE OF j2 SKIP LOCKED`: Zero-lock-contention worker job claiming in `workflowRepository.claimNextJob`.
   - `fencing_token = fencing_token + 1`: Fencing tokens prevent zombie or stalled worker processes from committing stale outputs.
   - `pg_advisory_xact_lock(...)`: Transaction-scoped advisory locks prevent race conditions during migration and suite publishing.
3. **Cache Invalidation Integration**: Repository methods use `q()` and `one()` from `src/db/pool.ts`. These utilities execute SQL and invoke `onCommittedWrite()` via `WRITE_RE` regex triggers upon successful transaction commit, invalidating `CacheAside` entries (e.g. for repositories, users, permissions, knowledge rules).

---

## 4. Naming Conventions

Repository functions follow clear, domain-specific semantic prefixes:

| Method Prefix        | Purpose                                     | Return Type                     | Example                                 |
| -------------------- | ------------------------------------------- | ------------------------------- | --------------------------------------- |
| `get...` / `find...` | Single record lookup by identifier or query | `Promise<T \| undefined>`       | `getWorkItemById(id: number)`           |
| `list...`            | Multi-record query, filtering, or search    | `Promise<T[]>`                  | `listAllUsers(filter?: UserListFilter)` |
| `insert...`          | Record creation                             | `Promise<T>` or `Promise<void>` | `insertSession(session: SessionData)`   |
| `update...`          | Updating existing record(s)                 | `Promise<void>`                 | `updateWorkItemBudget(id, budget)`      |
| `delete...`          | Removing record(s)                          | `Promise<void>`                 | `deleteExclusion(name: string)`         |
| `claim...`           | Atomic locking & state transition           | `Promise<JobRow \| undefined>`  | `claimNextJob(workerId, leaseSecs)`     |

---

## 5. Dependency Injection & Unit Testability

To achieve testability without introducing heavyweight DI frameworks, services utilize **Default Parameter Injection**:

```typescript
// src/workitems/service.ts
export async function getWorkItemDetail(id: number, db: Db = pool, repo = workItemsRepository) {
  const item = await repo.getWorkItemById(id, db);
  if (!item) throw new HttpError(404, "Work item not found");
  const prs = await repo.listPullRequests(id, db);
  return { ...item, pull_requests: prs };
}
```

### Testing Pattern (Isolated Unit Tests)

Unit tests can pass an in-memory double or mock repository directly without needing PostgreSQL, Docker, or remote infrastructure:

```typescript
test("getWorkItemDetail returns item with PRs using fake repository", async () => {
  const fakeRepo = {
    getWorkItemById: async () => ({ id: 42, code: "TSK-42", title: "Test" }),
    listPullRequests: async () => [{ id: 101, pr_number: 1 }],
  } as unknown as typeof workItemsRepository;

  const result = await getWorkItemDetail(42, fakeDb(), fakeRepo);
  assert.equal(result.id, 42);
  assert.equal(result.pull_requests.length, 1);
});
```

---

## 6. Summary of Module Repositories

| Module              | Location                      | Primary Responsibilities                                                                                    |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Work Items**      | `src/workitems/repository.ts` | Work items CRUD, external Jira/Hasaki task imports, pull request links, task events.                        |
| **Workflow**        | `src/workflow/repository.ts`  | Job claiming with `SKIP LOCKED`, leases, heartbeat, run detail queries, execution metrics, questions count. |
| **Repositories**    | `src/repos/repository.ts`     | Repository catalog, Bitbucket permission caches, user grants, exclusion lists, audit logs.                  |
| **Knowledge**       | `src/knowledge/repository.ts` | Knowledge rules, versioned history, audit trail, proposals, scope-based rule conflict queries.              |
| **Evaluation**      | `src/eval/repository.ts`      | Benchmark suites, synthetic test cases, eval runs, comparison reports.                                      |
| **Agent Execution** | `src/agent/repository.ts`     | Context snapshots, agent context packs, sessions, recommendations, provider handoff metrics.                |
| **User & Auth**     | `src/auth/repository.ts`      | Users, sessions, password hashes, login attempts, access tokens.                                            |
