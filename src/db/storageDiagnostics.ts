import type pg from "pg";
import { pool, type Db } from "./pool.ts";

export interface TableStorageStats {
  schema: string;
  table: string;
  tableSizeBytes: number;
  tableSizePretty: string;
  indexSizeBytes: number;
  indexSizePretty: string;
  toastSizeBytes: number;
  toastSizePretty: string;
  totalSizeBytes: number;
  totalSizePretty: string;
  estimatedRows: number;
  deadTuples: number;
  deadTupleRatio: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
}

export interface IndexStorageStats {
  schema: string;
  index: string;
  table: string;
  sizeBytes: number;
  sizePretty: string;
}

export interface DatabaseStorageStats {
  name: string;
  sizeBytes: number;
  sizePretty: string;
}

export interface StorageTotals {
  tableSizeBytes: number;
  tableSizePretty: string;
  indexSizeBytes: number;
  indexSizePretty: string;
  toastSizeBytes: number;
  toastSizePretty: string;
  totalSizeBytes: number;
  totalSizePretty: string;
  estimatedRowCount: number;
  deadTupleCount: number;
  deadTupleRatio: number;
  tableCount: number;
}

export interface StorageDiagnosticsReport {
  database: DatabaseStorageStats;
  totals: StorageTotals;
  tables: TableStorageStats[];
  largestTables: TableStorageStats[];
  largestIndexes: IndexStorageStats[];
  generatedAt: string;
}

export interface StorageDiagnosticsOptions {
  limit?: number;
  schema?: string;
}

/** Formats byte counts into human-readable binary units (B, KB, MB, GB, TB, PB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  if (i === 0) return `${Math.round(bytes)} B`;
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 ? val.toFixed(1) : val.toFixed(2)} ${units[i]}`;
}

/** Formats integer counts with commas for human readability. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return Math.round(n).toLocaleString("en-US");
}

/** Computes ratio of dead tuples to total tuples (live + dead), rounded to 4 decimals. */
export function computeDeadTupleRatio(estimatedRows: number, deadTuples: number): number {
  const total = estimatedRows + deadTuples;
  if (total <= 0 || deadTuples <= 0) return 0;
  return Number((deadTuples / total).toFixed(4));
}

interface RawDbRow {
  database_name: string;
  database_size_bytes: number | string;
}

interface RawTableRow {
  schemaname: string;
  tablename: string;
  total_size_bytes: number | string;
  table_size_bytes: number | string;
  index_size_bytes: number | string;
  toast_size_bytes: number | string;
  estimated_rows: number | string;
  dead_tuples: number | string;
  last_vacuum: Date | string | null;
  last_autovacuum: Date | string | null;
  last_analyze: Date | string | null;
  last_autoanalyze: Date | string | null;
}

interface RawIndexRow {
  schemaname: string;
  index_name: string;
  table_name: string;
  index_size_bytes: number | string;
}

function isPgPool(target: unknown): target is pg.Pool {
  return (
    typeof target === "object" &&
    target !== null &&
    "connect" in target &&
    typeof (target as { connect: unknown }).connect === "function"
  );
}

/**
 * Collects read-only PostgreSQL storage diagnostics without running COUNT(*) across tables.
 *
 * Reuses the existing PostgreSQL connection pool or provided Db client. Queries system catalogs
 * (pg_database, pg_class, pg_namespace, pg_index) and statistics views (pg_stat_user_tables).
 */
export async function getStorageDiagnostics(
  db: Db = pool,
  options: StorageDiagnosticsOptions = {},
): Promise<StorageDiagnosticsReport> {
  const limit = options.limit !== undefined && options.limit >= 0 ? options.limit : 10;
  const generatedAt = new Date().toISOString();

  // If db is a pool, checkout a single client for all queries and release in finally.
  let poolClient: pg.PoolClient | undefined;
  let client: Db = db;
  if (isPgPool(db)) {
    poolClient = await db.connect();
    client = poolClient;
  }

  try {
    // 1. Database size and name
    const dbRes = await client.query<RawDbRow>(`
      SELECT
        current_database() AS database_name,
        pg_database_size(current_database()) AS database_size_bytes
    `);
    const dbRow = dbRes.rows[0] ?? { database_name: "unknown", database_size_bytes: 0 };
    const dbSizeBytes = Number(dbRow.database_size_bytes ?? 0);
    const database: DatabaseStorageStats = {
      name: String(dbRow.database_name),
      sizeBytes: dbSizeBytes,
      sizePretty: formatBytes(dbSizeBytes),
    };

    // 2. Table storage details, estimated row counts and dead tuples (NO COUNT(*))
    const tableParams: unknown[] = [];
    let tableQuery = `
      SELECT
        n.nspname AS schemaname,
        c.relname AS tablename,
        pg_total_relation_size(c.oid) AS total_size_bytes,
        pg_relation_size(c.oid) AS table_size_bytes,
        pg_indexes_size(c.oid) AS index_size_bytes,
        GREATEST(0::bigint, (pg_total_relation_size(c.oid) - pg_indexes_size(c.oid) - pg_relation_size(c.oid))) AS toast_size_bytes,
        GREATEST(0::bigint, COALESCE(NULLIF(s.n_live_tup, 0), NULLIF(ROUND(c.reltuples)::bigint, -1), 0)) AS estimated_rows,
        GREATEST(0::bigint, COALESCE(s.n_dead_tup, 0)) AS dead_tuples,
        s.last_vacuum,
        s.last_autovacuum,
        s.last_analyze,
        s.last_autoanalyze
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind IN ('r', 'm')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast'
    `;

    if (options.schema) {
      tableParams.push(options.schema);
      tableQuery += ` AND n.nspname = $${tableParams.length}`;
    }

    tableQuery += ` ORDER BY pg_total_relation_size(c.oid) DESC`;

    const tableRes = await client.query<RawTableRow>(tableQuery, tableParams);

    const tables: TableStorageStats[] = tableRes.rows.map((r) => {
      const totalSizeBytes = Number(r.total_size_bytes ?? 0);
      const tableSizeBytes = Number(r.table_size_bytes ?? 0);
      const indexSizeBytes = Number(r.index_size_bytes ?? 0);
      const toastSizeBytes = Number(r.toast_size_bytes ?? 0);
      const estimatedRows = Math.max(0, Number(r.estimated_rows ?? 0));
      const deadTuples = Math.max(0, Number(r.dead_tuples ?? 0));
      return {
        schema: String(r.schemaname),
        table: String(r.tablename),
        tableSizeBytes,
        tableSizePretty: formatBytes(tableSizeBytes),
        indexSizeBytes,
        indexSizePretty: formatBytes(indexSizeBytes),
        toastSizeBytes,
        toastSizePretty: formatBytes(toastSizeBytes),
        totalSizeBytes,
        totalSizePretty: formatBytes(totalSizeBytes),
        estimatedRows,
        deadTuples,
        deadTupleRatio: computeDeadTupleRatio(estimatedRows, deadTuples),
        lastVacuum: r.last_vacuum ? new Date(r.last_vacuum).toISOString() : null,
        lastAutovacuum: r.last_autovacuum ? new Date(r.last_autovacuum).toISOString() : null,
        lastAnalyze: r.last_analyze ? new Date(r.last_analyze).toISOString() : null,
        lastAutoanalyze: r.last_autoanalyze ? new Date(r.last_autoanalyze).toISOString() : null,
      };
    });

    // 3. Largest individual indexes
    const indexParams: unknown[] = [];
    let indexQuery = `
      SELECT
        n.nspname AS schemaname,
        c.relname AS index_name,
        t.relname AS table_name,
        pg_relation_size(c.oid) AS index_size_bytes
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'i'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast'
    `;

    if (options.schema) {
      indexParams.push(options.schema);
      indexQuery += ` AND n.nspname = $${indexParams.length}`;
    }

    indexParams.push(limit);
    indexQuery += ` ORDER BY pg_relation_size(c.oid) DESC LIMIT $${indexParams.length}`;

    const indexRes = await client.query<RawIndexRow>(indexQuery, indexParams);
    const largestIndexes: IndexStorageStats[] = indexRes.rows.map((r) => {
      const sizeBytes = Number(r.index_size_bytes ?? 0);
      return {
        schema: String(r.schemaname),
        index: String(r.index_name),
        table: String(r.table_name),
        sizeBytes,
        sizePretty: formatBytes(sizeBytes),
      };
    });

    // Compute totals
    const tableSizeBytes = tables.reduce((acc, t) => acc + t.tableSizeBytes, 0);
    const indexSizeBytes = tables.reduce((acc, t) => acc + t.indexSizeBytes, 0);
    const toastSizeBytes = tables.reduce((acc, t) => acc + t.toastSizeBytes, 0);
    const totalRelationSizeBytes = tables.reduce((acc, t) => acc + t.totalSizeBytes, 0);
    const estimatedRowCount = tables.reduce((acc, t) => acc + t.estimatedRows, 0);
    const deadTupleCount = tables.reduce((acc, t) => acc + t.deadTuples, 0);

    const totals: StorageTotals = {
      tableSizeBytes,
      tableSizePretty: formatBytes(tableSizeBytes),
      indexSizeBytes,
      indexSizePretty: formatBytes(indexSizeBytes),
      toastSizeBytes,
      toastSizePretty: formatBytes(toastSizeBytes),
      totalSizeBytes: totalRelationSizeBytes,
      totalSizePretty: formatBytes(totalRelationSizeBytes),
      estimatedRowCount,
      deadTupleCount,
      deadTupleRatio: computeDeadTupleRatio(estimatedRowCount, deadTupleCount),
      tableCount: tables.length,
    };

    const largestTables = tables.slice(0, limit);

    return {
      database,
      totals,
      tables,
      largestTables,
      largestIndexes,
      generatedAt,
    };
  } finally {
    poolClient?.release();
  }
}

/** Formats storage report into human-readable text output. */
export function formatDiagnosticsText(
  report: StorageDiagnosticsReport,
  options: { all?: boolean } = {},
): string {
  const lines: string[] = [];
  const divider = "=".repeat(80);
  const subDivider = "-".repeat(80);

  lines.push(divider);
  lines.push("PostgreSQL Storage Diagnostics");
  lines.push(divider);
  lines.push(`Database:     ${report.database.name}`);
  lines.push(
    `Size:         ${report.database.sizePretty} (${formatNumber(report.database.sizeBytes)} bytes)`,
  );
  lines.push(`Generated At: ${report.generatedAt}`);
  lines.push("");

  lines.push(subDivider);
  lines.push("Storage Totals");
  lines.push(subDivider);
  lines.push(`Total Database Size:       ${report.database.sizePretty.padStart(12)}`);
  lines.push(`Total Table Size:          ${report.totals.tableSizePretty.padStart(12)}`);
  lines.push(`Total Index Size:          ${report.totals.indexSizePretty.padStart(12)}`);
  lines.push(`Total Toast Size:          ${report.totals.toastSizePretty.padStart(12)}`);
  lines.push(`Total Relations Size:      ${report.totals.totalSizePretty.padStart(12)}`);
  lines.push(`User Tables Count:         ${formatNumber(report.totals.tableCount).padStart(12)}`);
  lines.push(
    `Total Estimated Rows:      ${formatNumber(report.totals.estimatedRowCount).padStart(12)}`,
  );
  const deadPct = (report.totals.deadTupleRatio * 100).toFixed(2);
  lines.push(
    `Total Dead Tuples:         ${formatNumber(report.totals.deadTupleCount).padStart(12)} (${deadPct}% dead)`,
  );
  lines.push("");

  const tablesToShow = options.all ? report.tables : report.largestTables;
  const sectionTitle = options.all
    ? `All User Tables (${report.tables.length})`
    : `Largest Tables (Top ${tablesToShow.length} by Total Size)`;

  lines.push(subDivider);
  lines.push(sectionTitle);
  lines.push(subDivider);

  if (tablesToShow.length === 0) {
    lines.push("No user tables found matching the criteria.");
    lines.push("");
  } else {
    const colSchema = Math.max(6, ...tablesToShow.map((t) => t.schema.length));
    const colTable = Math.max(5, ...tablesToShow.map((t) => t.table.length));
    const colTotal = Math.max(10, ...tablesToShow.map((t) => t.totalSizePretty.length));
    const colTbl = Math.max(10, ...tablesToShow.map((t) => t.tableSizePretty.length));
    const colIdx = Math.max(10, ...tablesToShow.map((t) => t.indexSizePretty.length));
    const colToast = Math.max(10, ...tablesToShow.map((t) => t.toastSizePretty.length));
    const colRows = Math.max(9, ...tablesToShow.map((t) => formatNumber(t.estimatedRows).length));
    const colDead = Math.max(11, ...tablesToShow.map((t) => formatNumber(t.deadTuples).length));
    const colDeadPct = 7;

    const header = [
      "Schema".padEnd(colSchema),
      "Table".padEnd(colTable),
      "Total Size".padStart(colTotal),
      "Table Size".padStart(colTbl),
      "Index Size".padStart(colIdx),
      "Toast Size".padStart(colToast),
      "Est. Rows".padStart(colRows),
      "Dead Tuples".padStart(colDead),
      "Dead %".padStart(colDeadPct),
    ].join("  ");

    const underline = [
      "-".repeat(colSchema),
      "-".repeat(colTable),
      "-".repeat(colTotal),
      "-".repeat(colTbl),
      "-".repeat(colIdx),
      "-".repeat(colToast),
      "-".repeat(colRows),
      "-".repeat(colDead),
      "-".repeat(colDeadPct),
    ].join("  ");

    lines.push(header);
    lines.push(underline);

    for (const t of tablesToShow) {
      const deadRatioStr = `${(t.deadTupleRatio * 100).toFixed(2)}%`;
      const row = [
        t.schema.padEnd(colSchema),
        t.table.padEnd(colTable),
        t.totalSizePretty.padStart(colTotal),
        t.tableSizePretty.padStart(colTbl),
        t.indexSizePretty.padStart(colIdx),
        t.toastSizePretty.padStart(colToast),
        formatNumber(t.estimatedRows).padStart(colRows),
        formatNumber(t.deadTuples).padStart(colDead),
        deadRatioStr.padStart(colDeadPct),
      ].join("  ");
      lines.push(row);
    }
    lines.push("");
  }

  if (report.largestIndexes.length > 0) {
    lines.push(subDivider);
    lines.push(`Largest Indexes (Top ${report.largestIndexes.length} by Size)`);
    lines.push(subDivider);

    const colIdxSchema = Math.max(6, ...report.largestIndexes.map((i) => i.schema.length));
    const colIdxName = Math.max(10, ...report.largestIndexes.map((i) => i.index.length));
    const colIdxTable = Math.max(10, ...report.largestIndexes.map((i) => i.table.length));
    const colIdxSize = Math.max(10, ...report.largestIndexes.map((i) => i.sizePretty.length));

    const idxHeader = [
      "Schema".padEnd(colIdxSchema),
      "Index Name".padEnd(colIdxName),
      "Table Name".padEnd(colIdxTable),
      "Index Size".padStart(colIdxSize),
    ].join("  ");

    const idxUnderline = [
      "-".repeat(colIdxSchema),
      "-".repeat(colIdxName),
      "-".repeat(colIdxTable),
      "-".repeat(colIdxSize),
    ].join("  ");

    lines.push(idxHeader);
    lines.push(idxUnderline);

    for (const i of report.largestIndexes) {
      const row = [
        i.schema.padEnd(colIdxSchema),
        i.index.padEnd(colIdxName),
        i.table.padEnd(colIdxTable),
        i.sizePretty.padStart(colIdxSize),
      ].join("  ");
      lines.push(row);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Formats storage report into formatted JSON output. */
export function formatDiagnosticsJson(report: StorageDiagnosticsReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
