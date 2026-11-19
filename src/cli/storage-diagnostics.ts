#!/usr/bin/env node
/**
 * Read-only PostgreSQL storage diagnostics CLI.
 *
 * Reports database size, table size, index size, toast size, estimated row counts,
 * dead tuples, and the largest tables without running COUNT(*) across tables or
 * modifying database state. Reuses the existing PostgreSQL connection pool.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.ts";
import {
  getStorageDiagnostics,
  formatDiagnosticsText,
  formatDiagnosticsJson,
  type StorageDiagnosticsReport,
} from "../db/storageDiagnostics.ts";

export const USAGE = `Usage: npm run db:diagnostics [options]
       node src/cli/storage-diagnostics.ts [options]

Read-only PostgreSQL storage diagnostics:
Reports database size, table size, index size, toast size, estimated row counts,
dead tuples, and largest tables without running COUNT(*) or modifying database state.

Options:
  -j, --json          Output report in JSON format
  -n, --limit <n>     Number of largest tables to display (default: 10)
  -a, --all           Display all tables in human-readable output
  -s, --schema <s>    Filter tables by schema (e.g. public)
  -h, --help          Show this help message
`;

export interface ParsedDiagnosticsArgs {
  json: boolean;
  limit: number;
  all: boolean;
  schema?: string;
  help: boolean;
}

export function parseDiagnosticsArgs(args: string[]): ParsedDiagnosticsArgs {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", short: "j" },
      limit: { type: "string", short: "n" },
      all: { type: "boolean", short: "a" },
      schema: { type: "string", short: "s" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.limit !== undefined) {
    const parsed = Number(values.limit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`invalid --limit: ${values.limit} (must be a non-negative integer)`);
    }
  }

  return {
    json: values.json ?? false,
    limit: values.limit !== undefined ? Number(values.limit) : 10,
    all: values.all ?? false,
    schema: values.schema,
    help: values.help ?? false,
  };
}

export async function runDiagnosticsCli(
  args: string[] = process.argv.slice(2),
  output: { log: (...msgs: unknown[]) => void; error: (...msgs: unknown[]) => void } = console,
): Promise<{ exitCode: number; report?: StorageDiagnosticsReport }> {
  let options: ParsedDiagnosticsArgs;
  try {
    options = parseDiagnosticsArgs(args);
  } catch (err) {
    output.error((err as Error).message);
    output.error(`\n${USAGE}`);
    return { exitCode: 2 };
  }

  if (options.help) {
    output.log(USAGE);
    return { exitCode: 0 };
  }

  try {
    const report = await getStorageDiagnostics(pool, {
      limit: options.limit,
      schema: options.schema,
    });

    if (options.json) {
      output.log(formatDiagnosticsJson(report));
    } else {
      output.log(formatDiagnosticsText(report, { all: options.all }));
    }
    return { exitCode: 0, report };
  } catch (err) {
    output.error("Storage diagnostics failed:", (err as Error).message);
    return { exitCode: 1 };
  } finally {
    await pool.end();
  }
}

const isDirectExecution =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].endsWith("storage-diagnostics.ts"));

if (isDirectExecution) {
  const result = await runDiagnosticsCli();
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
