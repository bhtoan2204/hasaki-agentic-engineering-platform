import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  getStorageDiagnostics,
  formatDiagnosticsText,
  formatDiagnosticsJson,
} from "../src/db/storageDiagnostics.ts";

before(async () => {
  await migrate();
});

after(async () => {
  await pool.end();
});

describe("PostgreSQL storage diagnostics integration", () => {
  it("collects diagnostics from migrated test database", async () => {
    const report = await getStorageDiagnostics(pool, { limit: 5 });

    // Database diagnostics
    assert.ok(report.database.name.startsWith("platform_test_"));
    assert.ok(report.database.sizeBytes > 0, "Database size should be greater than 0");
    assert.ok(typeof report.database.sizePretty === "string");

    // Table diagnostics
    assert.ok(report.tables.length > 0, "Should detect migrated platform tables");
    assert.ok(report.totals.tableCount > 0);
    assert.equal(report.totals.tableCount, report.tables.length);

    // Verify key platform tables exist
    const tableNames = new Set(report.tables.map((t) => t.table));
    assert.ok(tableNames.has("workflow_runs"), "workflow_runs table should exist");
    assert.ok(tableNames.has("schema_migrations"), "schema_migrations table should exist");

    // Verify properties for each table
    for (const t of report.tables) {
      assert.ok(typeof t.schema === "string" && t.schema.length > 0);
      assert.ok(["public", "code_intelligence"].includes(t.schema));
      assert.ok(t.totalSizeBytes >= 0);
      assert.ok(t.tableSizeBytes >= 0);
      assert.ok(t.indexSizeBytes >= 0);
      assert.ok(t.toastSizeBytes >= 0);
      assert.ok(t.estimatedRows >= 0);
      assert.ok(t.deadTuples >= 0);
      assert.ok(t.deadTupleRatio >= 0 && t.deadTupleRatio <= 1);
    }

    // Verify largest tables ranking
    assert.ok(report.largestTables.length <= 5);
    for (let i = 1; i < report.largestTables.length; i++) {
      assert.ok(
        report.largestTables[i - 1].totalSizeBytes >= report.largestTables[i].totalSizeBytes,
        "largestTables must be sorted in descending order of totalSizeBytes",
      );
    }

    // Verify largest indexes
    assert.ok(report.largestIndexes.length > 0);
    assert.ok(report.largestIndexes.length <= 5);
    for (const idx of report.largestIndexes) {
      assert.ok(idx.sizeBytes >= 0);
      assert.ok(typeof idx.index === "string");
      assert.ok(typeof idx.table === "string");
    }

    // Verify totals
    const sumTableSize = report.tables.reduce((acc, t) => acc + t.tableSizeBytes, 0);
    const sumIndexSize = report.tables.reduce((acc, t) => acc + t.indexSizeBytes, 0);
    const sumTotalSize = report.tables.reduce((acc, t) => acc + t.totalSizeBytes, 0);
    assert.equal(report.totals.tableSizeBytes, sumTableSize);
    assert.equal(report.totals.indexSizeBytes, sumIndexSize);
    assert.equal(report.totals.totalSizeBytes, sumTotalSize);
  });

  it("applies limit option to largest tables and indexes", async () => {
    const report = await getStorageDiagnostics(pool, { limit: 2 });
    assert.equal(report.largestTables.length, 2);
    assert.equal(report.largestIndexes.length, 2);
  });

  it("applies schema filter option", async () => {
    const publicReport = await getStorageDiagnostics(pool, { schema: "public" });
    assert.ok(publicReport.tables.length > 0);
    for (const t of publicReport.tables) {
      assert.equal(t.schema, "public");
    }

    const nonexistentReport = await getStorageDiagnostics(pool, {
      schema: "nonexistent_schema_xyz",
    });
    assert.equal(nonexistentReport.tables.length, 0);
    assert.equal(nonexistentReport.totals.tableCount, 0);
  });

  it("formats valid text and JSON output", async () => {
    const report = await getStorageDiagnostics(pool, { limit: 5 });

    const text = formatDiagnosticsText(report);
    assert.ok(text.includes(report.database.name));
    assert.ok(text.includes("PostgreSQL Storage Diagnostics"));
    assert.ok(text.includes("Storage Totals"));
    assert.ok(text.includes("Largest Tables"));
    assert.ok(text.includes("Largest Indexes"));

    const json = formatDiagnosticsJson(report);
    const parsed = JSON.parse(json);
    assert.equal(parsed.database.name, report.database.name);
    assert.equal(parsed.database.sizeBytes, report.database.sizeBytes);
    assert.equal(parsed.totals.tableCount, report.totals.tableCount);
    assert.equal(parsed.tables.length, report.tables.length);
  });

  it("reports only the TOAST relation as toast storage", async () => {
    await pool.query("DROP TABLE IF EXISTS storage_diag_toast, storage_diag_plain");
    try {
      await pool.query("CREATE TABLE storage_diag_toast (id int PRIMARY KEY, body text)");
      await pool.query("ALTER TABLE storage_diag_toast ALTER COLUMN body SET STORAGE EXTERNAL");
      await pool.query(
        "INSERT INTO storage_diag_toast SELECT g, repeat(md5(g::text), 400) FROM generate_series(1, 50) g",
      );
      // No toastable column: its free space and visibility maps must not be reported as TOAST.
      await pool.query("CREATE TABLE storage_diag_plain (id int)");
      await pool.query("INSERT INTO storage_diag_plain SELECT generate_series(1, 5000)");
      await pool.query("VACUUM storage_diag_toast");
      await pool.query("VACUUM storage_diag_plain");

      const report = await getStorageDiagnostics(pool, { schema: "public" });
      const toasted = report.tables.find((t) => t.table === "storage_diag_toast");
      assert.ok(toasted);
      assert.ok(toasted.toastSizeBytes > 0);
      assert.equal(
        toasted.tableSizeBytes + toasted.indexSizeBytes + toasted.toastSizeBytes,
        toasted.totalSizeBytes,
      );
      const plain = report.tables.find((t) => t.table === "storage_diag_plain");
      assert.ok(plain);
      assert.equal(plain.toastSizeBytes, 0);
      assert.equal(plain.tableSizeBytes, plain.totalSizeBytes);
    } finally {
      await pool.query("DROP TABLE IF EXISTS storage_diag_toast, storage_diag_plain");
    }
  });

  it("leaves database contents unmodified (read-only verification)", async () => {
    const countBefore = (await pool.query("SELECT count(*)::int AS n FROM schema_migrations"))
      .rows[0].n;

    // Run diagnostics multiple times
    await getStorageDiagnostics(pool);
    await getStorageDiagnostics(pool, { schema: "public", limit: 3 });

    const countAfter = (await pool.query("SELECT count(*)::int AS n FROM schema_migrations"))
      .rows[0].n;
    assert.equal(countBefore, countAfter, "Database contents must not be modified by diagnostics");
  });
});
