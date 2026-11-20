# PostgreSQL Storage Diagnostics CLI

A safe, read-only diagnostic tool that reports PostgreSQL storage consumption, table and index sizing, estimated row counts, dead tuple metrics, and largest tables across the database.

## Key Features & Safety Guarantees

- **Strictly Read-Only**: Queries PostgreSQL system catalogs (`pg_database`, `pg_class`, `pg_namespace`, `pg_index`) and statistics views (`pg_stat_user_tables`). Never executes DDL, writes, or modifies any database state.
- **Zero Sequential Table Scans**: Does **not** run `COUNT(*)` across tables. Row counts and dead tuples are estimated directly from catalog metadata (`pg_class.reltuples`) and background statistics (`pg_stat_user_tables.n_live_tup`, `n_dead_tup`), ensuring zero impact on active production workloads.
- **Connection Pool Reuse**: Reuses the platform's existing PostgreSQL connection pool (`pool` from `src/db/pool.ts`) issuing each query through the pool or a caller-supplied client.
- **Zero New Dependencies**: Implemented using standard Node.js utilities (`node:util` `parseArgs`) and existing database utilities.
- **Dual Output Formats**: Supports clean, aligned human-readable terminal tables as well as structured JSON output for automated telemetry and alerting.

---

## Metrics Reported

| Metric                  | Source                                                 | Description                                                                           |
| :---------------------- | :----------------------------------------------------- | :------------------------------------------------------------------------------------ |
| **Database Size**       | `pg_database_size(current_database())`                 | Total disk space used by the database on disk                                         |
| **Table Size**          | `pg_table_size(oid) - toast`                           | Heap files including free space and visibility maps (excluding toast and indexes)     |
| **Index Size**          | `pg_indexes_size(oid)` / `pg_relation_size(index_oid)` | Disk space used by indexes on a table, plus a breakdown of largest individual indexes |
| **Toast Size**          | `pg_total_relation_size(reltoastrelid)`                | Out-of-line storage for oversized column values (JSON blobs, large text, artifacts)   |
| **Total Relation Size** | `pg_total_relation_size(oid)`                          | Complete on-disk footprint of a table including heap, toast, and all indexes          |
| **Estimated Rows**      | `COALESCE(n_live_tup, reltuples)` (a zero stays zero)  | Planner/statistics row estimate without scanning table rows                           |
| **Dead Tuples**         | `pg_stat_user_tables.n_dead_tup`                       | Estimated dead tuples waiting to be vacuumed                                          |
| **Dead Tuple Ratio**    | Calculated: `dead / (live + dead)`                     | Dead tuple percentage indicating vacuum efficiency                                    |
| **Largest Tables**      | Ranked by `total_size_bytes DESC`                      | Top tables consuming the most storage on disk                                         |

---

## CLI Usage

### Basic Human-Readable Report

Run diagnostics on the connected database with default options (top 10 largest tables):

```bash
npm run db:diagnostics
# or alias:
npm run db:storage
# or direct node execution:
node src/cli/storage-diagnostics.ts
```

Example output:

```text
================================================================================
PostgreSQL Storage Diagnostics
================================================================================
Database:     platform_production
Size:         1.42 GB (1,524,622,336 bytes)
Generated At: 2026-11-20T03:00:00.000Z

--------------------------------------------------------------------------------
Storage Totals
--------------------------------------------------------------------------------
Total Database Size:            1.42 GB
Total Table Size:             650.00 MB
Total Index Size:             520.00 MB
Total Toast Size:             180.00 MB
Total Relations Size:           1.32 GB
User Tables Count:                   95
Total Estimated Rows:         1,450,200
Total Dead Tuples:               25,300 (1.72% dead)

--------------------------------------------------------------------------------
Largest Tables (Top 10 by Total Size)
--------------------------------------------------------------------------------
Schema  Table                 Total Size  Table Size  Index Size  Toast Size  Est. Rows  Dead Tuples   Dead %
------  --------------------  ----------  ----------  ----------  ----------  ---------  -----------  -------
public  workflow_events        450.00 MB   210.00 MB   190.00 MB    50.00 MB    820,000       12,000    1.44%
public  workflow_runs          280.00 MB   120.00 MB   140.00 MB    20.00 MB    150,000        5,200    3.35%
public  workflow_checkpoints   180.00 MB    40.00 MB    60.00 MB    80.00 MB     45,000        1,100    2.39%
public  work_items             120.00 MB    60.00 MB    55.00 MB     5.00 MB     80,000        2,000    2.44%
public  eval_results            95.00 MB    45.00 MB    40.00 MB    10.00 MB     50,000          900    1.77%
...

--------------------------------------------------------------------------------
Largest Indexes (Top 10 by Size)
--------------------------------------------------------------------------------
Schema  Index Name                 Table Name         Index Size
------  -------------------------  -----------------  ----------
public  workflow_events_pkey       workflow_events      85.00 MB
public  workflow_events_run_idx    workflow_events      65.00 MB
public  workflow_runs_pkey         workflow_runs        50.00 MB
...
```

---

### JSON Output

Generate machine-readable JSON output for automated monitoring, CI checks, or piping into `jq`:

```bash
npm run db:diagnostics -- --json
```

Filter with `jq`:

```bash
# Print storage totals
npm run db:diagnostics -- --json | jq .totals

# Find tables with more than 5% dead tuples
npm run db:diagnostics -- --json | jq '.tables[] | select(.deadTupleRatio > 0.05) | {table, estimatedRows, deadTuples, deadTupleRatio}'
```

---

### CLI Options

| Flag           | Short    | Description                                             | Default          |
| :------------- | :------- | :------------------------------------------------------ | :--------------- |
| `--json`       | `-j`     | Format output as JSON                                   | `false`          |
| `--limit <n>`  | `-n <n>` | Limit number of largest tables and indexes displayed    | `10`             |
| `--all`        | `-a`     | Display all user tables in human-readable output        | `false`          |
| `--schema <s>` | `-s <s>` | Filter diagnostics to a specific schema (e.g. `public`) | All user schemas |
| `--help`       | `-h`     | Display usage and help message                          | `false`          |

#### Examples

```bash
# View top 5 largest tables
npm run db:diagnostics -- --limit=5

# View all user tables
npm run db:diagnostics -- --all

# Inspect a specific schema
npm run db:diagnostics -- --schema=code_intelligence
```

---

## Programmatic API

The storage diagnostics module can be imported and consumed directly by backend services or custom tooling:

```typescript
import { pool } from "./db/pool.ts";
import {
  getStorageDiagnostics,
  formatDiagnosticsText,
  formatDiagnosticsJson,
  type StorageDiagnosticsReport,
} from "./db/storageDiagnostics.ts";

// Collect report
const report: StorageDiagnosticsReport = await getStorageDiagnostics(pool, {
  limit: 10,
  schema: "public",
});

console.log(`Database Size: ${report.database.sizePretty}`);
console.log(`Total Tables: ${report.totals.tableCount}`);
console.log(`Dead Tuple Count: ${report.totals.deadTupleCount}`);

// Convert to formatted string or JSON
const textOutput = formatDiagnosticsText(report);
const jsonOutput = formatDiagnosticsJson(report);
```

---

## Interpreting Results & Operational Guidance

1. **Dead Tuple Ratio (`Dead %`)**:
   - `< 5%`: Normal for healthy transactional workloads.
   - `> 10%`: Tables may be experiencing delayed autovacuum or high churn from rapid `UPDATE`/`DELETE` cycles. Consider triggering manual `VACUUM ANALYZE` or tuning autovacuum settings (`autovacuum_vacuum_scale_factor`).
2. **Toast Size**:
   - A high toast size relative to table size indicates large columns (e.g. execution logs, serialized JSON checkpoints, or prompt payloads). Check if data retention or compression policies are needed.
3. **Index Size vs. Table Size**:
   - When total index size significantly exceeds base table size, review table indexes to verify they are all actively used and remove redundant or duplicate indexes.
