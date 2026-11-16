# Performance: in-process caches

Scope of this change: bounded cache management (phase 1). Frontend and database tuning were **not** changed: no
baseline measurements (p50/p95, request counts, render time) exist yet, so they are listed under follow-ups.

## Cache inventory

All caches live in `src/cache/index.ts` and are per process. Invalidation: a committed write in this process
(`onCommittedWrite`), `NOTIFY cache_invalidate` from other processes, bypass + flush while the listener is down,
flush on reconnect, and the TTL as a backstop.

| Cache (name) | Owner | Key | TTL | Max entries | Bound tables | Isolation |
| --- | --- | --- | --- | --- | --- | --- |
| `repository_access` | `src/repos/access.ts` | user id | 60 s | 200 | user_repository_access, repository_bitbucket_permissions, repositories | key = user id |
| `repositories` | `src/repos/service.ts` | constant (shared registry) | 60 s | 1 | repositories | no user data |
| `definitions.version` | `src/workflow/definitions.ts` | definition key, version, owner id | 300 s | 500 | workflow_definitions, workflow_definition_versions | key contains owner id |
| `knowledge.candidates` | `src/knowledge/service.ts` | owner id | 60 s | 200 | knowledge_items, knowledge_versions | key = owner id |
| `project_databases` | `src/integrations/database.ts` | constant | 60 s | 1 | project_databases | shared config |
| `agent.evaluation.analytics` | `src/eval/analytics.ts` | query params | see file | default 1000 | evaluation tables | check scope in key |
| `engineering.analytics` | `src/api/analytics/index.ts` | query params | see file | default 1000 | run/work item tables | check scope in key |
| `metrics.summary` (SWR) | `src/api/routes.ts` | days, owner id, all | fresh 30 s, stale ≤ 600 s | 500 | none (aggregates only) | key = days, owner, scope |
| `singleflight` | `src/http/app.ts` and others | request key incl. actor id | request lifetime | no storage | n/a | key includes actor |

Estimated memory: entries × value size; the largest values are analytics payloads (tens of KB), so the worst case
is on the order of tens of MB per process. Byte budgets were deliberately not added: entry caps suffice at this size
and approximating bytes would need serialization on every set. Re-evaluate if a profile shows large values.

## Policy changes

* `CacheAside`: eviction was FIFO (a hit did not refresh recency). It is now LRU using Map insertion order:
  a hit moves the entry to the end without changing its timestamp (TTL is not extended), eviction removes the first key
  (O(1)). Generation check, singleflight and `clear()` semantics are unchanged. LFU was rejected (not required, more
  bookkeeping, workloads are small and short-lived).
* `StaleWhileRevalidate`: now capped (default 500), LRU, expired-beyond-`maxStale` entries are dropped lazily on read
  and by a bounded sweep (≤ 8 per store). One refresh per key; a failed background refresh keeps the old value
  (while within `maxStale`), is counted and logged, and never causes an unhandled rejection.
* `singleflight`: entries are removed in `finally`, so resolved and rejected calls leave nothing behind.

## Metrics

`GET /api/metrics/cache` (admin only) returns, per cache, a fixed name and: `entries`, `max`, `inflight`, `hits`,
`misses`, `invalidations`, `evictions {capacity, expired, invalidated}`, `refreshFailures`, plus
`singleflightInflight` and the pg pool gauges (`total`, `idle`, `waiting`). Labels are cache names and fixed
eviction reasons only; no keys, user ids or repository names.

## Benchmark (`npm run bench:cache`, no database)

Zipf workload, 5000 keys, capacity 500, 200k operations (same sequence for both policies):

| Policy | Hit rate | Time |
| --- | --- | --- |
| FIFO (before) | 0.6038 | ~17 ms |
| LRU (after) | 0.6526 | ~18 ms |

LRU lifts the hit rate by about 5 points at the same cost. High-cardinality run (100k distinct keys): `CacheAside` peaked
at 1000/1000 and SWR at 500/500; heap delta with `--expose-gc` was ~0.3 MB. 1000 concurrent identical `singleflight`
calls executed the loader once and left no pending state. Numbers are from one local run and vary by machine.

## Tests

* `test/cache-bounds.test.ts`, `test/cache.test.ts`: LRU, TTL, bounds, SWR, singleflight, listener down/reconnect.
* `test/cache-writes.test.ts`: committed write clears bound caches, rollback and failed COMMIT do not, per-user key
  isolation, permission change reflected immediately. All use fake database handles.

## Remaining bottlenecks / follow-up (not measured, not changed)

* No baseline for UI journeys (cold load, Run Detail, DAG, transcripts) or API p50/p95; add measurement first.
* DB query time and pool wait histograms (only gauges exist); sequential queries over the remote RDS.
* `structuredClone` on every hit; keep until a profile shows it matters.
* Cache for `agent.evaluation.analytics` / `engineering.analytics` TTLs are as before.
