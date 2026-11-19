import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/pool.ts";
import {
  formatBytes,
  formatNumber,
  computeDeadTupleRatio,
  getStorageDiagnostics,
  formatDiagnosticsText,
  formatDiagnosticsJson,
  type StorageDiagnosticsReport,
} from "../src/db/storageDiagnostics.ts";
import { parseDiagnosticsArgs, runDiagnosticsCli } from "../src/cli/storage-diagnostics.ts";

describe("parseDiagnosticsArgs", () => {
  it("parses defaults when no arguments are provided", () => {
    const opts = parseDiagnosticsArgs([]);
    assert.deepEqual(opts, {
      json: false,
      limit: 10,
      all: false,
      schema: undefined,
      help: false,
    });
  });

  it("parses --json and -j flag", () => {
    assert.equal(parseDiagnosticsArgs(["--json"]).json, true);
    assert.equal(parseDiagnosticsArgs(["-j"]).json, true);
  });

  it("parses --limit and -n flag", () => {
    assert.equal(parseDiagnosticsArgs(["--limit", "25"]).limit, 25);
    assert.equal(parseDiagnosticsArgs(["-n", "5"]).limit, 5);
    assert.equal(parseDiagnosticsArgs(["--limit=0"]).limit, 0);
  });

  it("rejects non-integer or negative limit values", () => {
    assert.throws(() => parseDiagnosticsArgs(["--limit=-1"]), /invalid --limit/);
    assert.throws(() => parseDiagnosticsArgs(["--limit", "abc"]), /invalid --limit/);
    assert.throws(() => parseDiagnosticsArgs(["--limit=3.14"]), /invalid --limit/);
  });

  it("parses --all and -a flag", () => {
    assert.equal(parseDiagnosticsArgs(["--all"]).all, true);
    assert.equal(parseDiagnosticsArgs(["-a"]).all, true);
  });

  it("parses --schema and -s flag", () => {
    assert.equal(parseDiagnosticsArgs(["--schema", "public"]).schema, "public");
    assert.equal(parseDiagnosticsArgs(["-s", "custom_schema"]).schema, "custom_schema");
  });

  it("parses --help and -h flag", () => {
    assert.equal(parseDiagnosticsArgs(["--help"]).help, true);
    assert.equal(parseDiagnosticsArgs(["-h"]).help, true);
  });

  it("rejects unexpected options", () => {
    assert.throws(() => parseDiagnosticsArgs(["--unexpected"]));
  });
});

describe("formatBytes", () => {
  it("formats zero and negative bytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(-100), "0 B");
    assert.equal(formatBytes(NaN), "0 B");
  });

  it("formats bytes under 1 KB", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1023), "1023 B");
  });

  it("formats kilobytes", () => {
    assert.equal(formatBytes(1024), "1.00 KB");
    assert.equal(formatBytes(1536), "1.50 KB");
    assert.equal(formatBytes(102400), "100.0 KB");
  });

  it("formats megabytes, gigabytes, and terabytes", () => {
    assert.equal(formatBytes(1048576), "1.00 MB");
    assert.equal(formatBytes(1073741824), "1.00 GB");
    assert.equal(formatBytes(1099511627776), "1.00 TB");
  });
});

describe("formatNumber", () => {
  it("formats numbers with comma separators", () => {
    assert.equal(formatNumber(0), "0");
    assert.equal(formatNumber(42), "42");
    assert.equal(formatNumber(1234), "1,234");
    assert.equal(formatNumber(1234567), "1,234,567");
  });

  it("handles negative and non-finite values safely", () => {
    assert.equal(formatNumber(-5), "0");
    assert.equal(formatNumber(NaN), "0");
  });
});

describe("computeDeadTupleRatio", () => {
  it("computes ratio when live and dead tuples are present", () => {
    assert.equal(computeDeadTupleRatio(100, 25), 0.2);
    assert.equal(computeDeadTupleRatio(900, 100), 0.1);
  });

  it("returns 0 when there are no dead tuples", () => {
    assert.equal(computeDeadTupleRatio(1000, 0), 0);
  });

  it("returns 0 when both are zero", () => {
    assert.equal(computeDeadTupleRatio(0, 0), 0);
  });

  it("returns 1 when only dead tuples exist", () => {
    assert.equal(computeDeadTupleRatio(0, 50), 1);
  });
});

describe("getStorageDiagnostics with mock Db", () => {
  it("executes read-only queries without running COUNT(*) across all tables", async () => {
    const executedQueries: string[] = [];

    const mockDb = {
      query: async (sql: string, _params?: unknown[]) => {
        executedQueries.push(sql);

        if (sql.includes("current_database()")) {
          return {
            rows: [{ database_name: "test_db", database_size_bytes: 52428800 }], // 50 MB
          };
        }

        if (sql.includes("pg_class c") && sql.includes("c.relkind IN ('r', 'm')")) {
          return {
            rows: [
              {
                schemaname: "public",
                tablename: "workflow_runs",
                total_size_bytes: 20971520, // 20 MB
                table_size_bytes: 10485760, // 10 MB
                index_size_bytes: 8388608, // 8 MB
                toast_size_bytes: 2097152, // 2 MB
                estimated_rows: 50000,
                dead_tuples: 2500,
                last_vacuum: null,
                last_autovacuum: "2026-11-20T01:00:00.000Z",
                last_analyze: null,
                last_autoanalyze: "2026-11-20T01:30:00.000Z",
              },
              {
                schemaname: "public",
                tablename: "work_items",
                total_size_bytes: 10485760, // 10 MB
                table_size_bytes: 6291456, // 6 MB
                index_size_bytes: 4194304, // 4 MB
                toast_size_bytes: 0,
                estimated_rows: 10000,
                dead_tuples: 100,
                last_vacuum: null,
                last_autovacuum: null,
                last_analyze: null,
                last_autoanalyze: null,
              },
            ],
          };
        }

        if (sql.includes("pg_class c") && sql.includes("c.relkind = 'i'")) {
          return {
            rows: [
              {
                schemaname: "public",
                index_name: "workflow_runs_pkey",
                table_name: "workflow_runs",
                index_size_bytes: 4194304,
              },
              {
                schemaname: "public",
                index_name: "work_items_pkey",
                table_name: "work_items",
                index_size_bytes: 2097152,
              },
            ],
          };
        }

        return { rows: [] };
      },
    };

    const report = await getStorageDiagnostics(mockDb as unknown as Db, { limit: 5 });

    // Assert NO COUNT(*) is used in any query
    for (const q of executedQueries) {
      assert.equal(/count\s*\(\s*\*\s*\)/i.test(q), false, `Query must not contain COUNT(*): ${q}`);
      assert.equal(
        /\b(insert|update|delete|drop|truncate|alter|create|vacuum|analyze)\b/i.test(q),
        false,
        `Query must be strictly read-only: ${q}`,
      );
    }

    // Assert database stats
    assert.equal(report.database.name, "test_db");
    assert.equal(report.database.sizeBytes, 52428800);
    assert.equal(report.database.sizePretty, "50.00 MB");

    // Assert table stats
    assert.equal(report.tables.length, 2);
    const runs = report.tables[0];
    assert.equal(runs.table, "workflow_runs");
    assert.equal(runs.totalSizeBytes, 20971520);
    assert.equal(runs.totalSizePretty, "20.00 MB");
    assert.equal(runs.tableSizeBytes, 10485760);
    assert.equal(runs.tableSizePretty, "10.00 MB");
    assert.equal(runs.indexSizeBytes, 8388608);
    assert.equal(runs.indexSizePretty, "8.00 MB");
    assert.equal(runs.toastSizeBytes, 2097152);
    assert.equal(runs.toastSizePretty, "2.00 MB");
    assert.equal(runs.estimatedRows, 50000);
    assert.equal(runs.deadTuples, 2500);
    assert.equal(runs.deadTupleRatio, 0.0476);

    // Assert totals
    assert.equal(report.totals.tableSizeBytes, 16777216); // 16 MB
    assert.equal(report.totals.indexSizeBytes, 12582912); // 12 MB
    assert.equal(report.totals.toastSizeBytes, 2097152); // 2 MB
    assert.equal(report.totals.totalSizeBytes, 31457280); // 30 MB
    assert.equal(report.totals.estimatedRowCount, 60000);
    assert.equal(report.totals.deadTupleCount, 2600);
    assert.equal(report.totals.tableCount, 2);

    // Assert largest indexes
    assert.equal(report.largestIndexes.length, 2);
    assert.equal(report.largestIndexes[0].index, "workflow_runs_pkey");
  });

  it("applies schema filter to SQL query", async () => {
    let capturedTableParams: unknown[] = [];
    let capturedIndexParams: unknown[] = [];

    const mockDb = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("current_database()")) {
          return { rows: [{ database_name: "test_db", database_size_bytes: 1024 }] };
        }
        if (sql.includes("pg_class c") && sql.includes("c.relkind IN ('r', 'm')")) {
          capturedTableParams = params ?? [];
          return { rows: [] };
        }
        if (sql.includes("pg_class c") && sql.includes("c.relkind = 'i'")) {
          capturedIndexParams = params ?? [];
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    await getStorageDiagnostics(mockDb as unknown as Db, { schema: "audit_schema" });
    assert.ok(capturedTableParams.includes("audit_schema"));
    assert.ok(capturedIndexParams.includes("audit_schema"));
  });
});

describe("formatDiagnosticsText", () => {
  it("formats human-readable storage diagnostics report", () => {
    const sampleReport: StorageDiagnosticsReport = {
      database: {
        name: "production_db",
        sizeBytes: 104857600,
        sizePretty: "100.0 MB",
      },
      totals: {
        tableSizeBytes: 52428800,
        tableSizePretty: "50.0 MB",
        indexSizeBytes: 41943040,
        indexSizePretty: "40.0 MB",
        toastSizeBytes: 2097152,
        toastSizePretty: "2.00 MB",
        totalSizeBytes: 96468992,
        totalSizePretty: "92.0 MB",
        estimatedRowCount: 125000,
        deadTupleCount: 3125,
        deadTupleRatio: 0.0244,
        tableCount: 1,
      },
      tables: [
        {
          schema: "public",
          table: "events",
          tableSizeBytes: 52428800,
          tableSizePretty: "50.0 MB",
          indexSizeBytes: 41943040,
          indexSizePretty: "40.0 MB",
          toastSizeBytes: 2097152,
          toastSizePretty: "2.00 MB",
          totalSizeBytes: 96468992,
          totalSizePretty: "92.0 MB",
          estimatedRows: 125000,
          deadTuples: 3125,
          deadTupleRatio: 0.0244,
          lastVacuum: null,
          lastAutovacuum: null,
          lastAnalyze: null,
          lastAutoanalyze: null,
        },
      ],
      largestTables: [
        {
          schema: "public",
          table: "events",
          tableSizeBytes: 52428800,
          tableSizePretty: "50.0 MB",
          indexSizeBytes: 41943040,
          indexSizePretty: "40.0 MB",
          toastSizeBytes: 2097152,
          toastSizePretty: "2.00 MB",
          totalSizeBytes: 96468992,
          totalSizePretty: "92.0 MB",
          estimatedRows: 125000,
          deadTuples: 3125,
          deadTupleRatio: 0.0244,
          lastVacuum: null,
          lastAutovacuum: null,
          lastAnalyze: null,
          lastAutoanalyze: null,
        },
      ],
      largestIndexes: [
        {
          schema: "public",
          index: "events_pkey",
          table: "events",
          sizeBytes: 20971520,
          sizePretty: "20.0 MB",
        },
      ],
      generatedAt: "2026-11-20T03:00:00.000Z",
    };

    const text = formatDiagnosticsText(sampleReport);

    assert.ok(text.includes("PostgreSQL Storage Diagnostics"));
    assert.ok(text.includes("production_db"));
    assert.ok(text.includes("100.0 MB"));
    assert.ok(text.includes("Storage Totals"));
    assert.ok(text.includes("50.0 MB"));
    assert.ok(text.includes("40.0 MB"));
    assert.ok(text.includes("events"));
    assert.ok(text.includes("125,000"));
    assert.ok(text.includes("3,125"));
    assert.ok(text.includes("2.44%"));
    assert.ok(text.includes("events_pkey"));
  });

  it("handles report with zero tables gracefully", () => {
    const emptyReport: StorageDiagnosticsReport = {
      database: { name: "empty_db", sizeBytes: 8192000, sizePretty: "7.81 MB" },
      totals: {
        tableSizeBytes: 0,
        tableSizePretty: "0 B",
        indexSizeBytes: 0,
        indexSizePretty: "0 B",
        toastSizeBytes: 0,
        toastSizePretty: "0 B",
        totalSizeBytes: 0,
        totalSizePretty: "0 B",
        estimatedRowCount: 0,
        deadTupleCount: 0,
        deadTupleRatio: 0,
        tableCount: 0,
      },
      tables: [],
      largestTables: [],
      largestIndexes: [],
      generatedAt: "2026-11-20T03:00:00.000Z",
    };

    const text = formatDiagnosticsText(emptyReport);
    assert.ok(text.includes("No user tables found matching the criteria."));
  });
});

describe("formatDiagnosticsJson", () => {
  it("outputs valid JSON containing all diagnostics fields", () => {
    const sampleReport: StorageDiagnosticsReport = {
      database: { name: "db1", sizeBytes: 1000, sizePretty: "1000 B" },
      totals: {
        tableSizeBytes: 500,
        tableSizePretty: "500 B",
        indexSizeBytes: 400,
        indexSizePretty: "400 B",
        toastSizeBytes: 100,
        toastSizePretty: "100 B",
        totalSizeBytes: 1000,
        totalSizePretty: "1000 B",
        estimatedRowCount: 10,
        deadTupleCount: 1,
        deadTupleRatio: 0.0909,
        tableCount: 1,
      },
      tables: [],
      largestTables: [],
      largestIndexes: [],
      generatedAt: "2026-11-20T03:00:00.000Z",
    };

    const json = formatDiagnosticsJson(sampleReport);
    const parsed = JSON.parse(json);
    assert.equal(parsed.database.name, "db1");
    assert.equal(parsed.totals.tableSizeBytes, 500);
    assert.equal(parsed.totals.deadTupleRatio, 0.0909);
    assert.deepEqual(parsed.tables, []);
  });
});

describe("runDiagnosticsCli", () => {
  it("prints help and exits 0 when --help is passed", async () => {
    const logs: string[] = [];
    const res = await runDiagnosticsCli(["--help"], {
      log: (msg) => logs.push(String(msg)),
      error: () => {},
    });
    assert.equal(res.exitCode, 0);
    assert.ok(logs.some((l) => l.includes("Usage: npm run db:diagnostics")));
  });

  it("handles invalid CLI arguments with exitCode 2", async () => {
    const errors: string[] = [];
    const res = await runDiagnosticsCli(["--limit", "invalid"], {
      log: () => {},
      error: (msg) => errors.push(String(msg)),
    });
    assert.equal(res.exitCode, 2);
    assert.ok(errors.some((e) => e.includes("invalid --limit")));
  });
});
