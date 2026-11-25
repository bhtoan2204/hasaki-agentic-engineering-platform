import type pg from "pg";
import { pool, q, withTx } from "../db/pool.ts";
import {
  decryptDetailed,
  encryptSecret,
  keyRing,
  writeFormat,
  type CiphertextFormat,
} from "./crypto.ts";

/**
 * Re-encrypts stored credentials with the current key (docs/architecture/key-rotation.md). Safe to repeat: rows that
 * already carry the target format and key are skipped; each batch is one transaction; an undecryptable row is
 * reported and left untouched, never deleted.
 */
export const WORKSPACE_CHECKPOINT_KIND = "execution_checkpoint_workspace";
const MAX_REPORTED_FAILURES = 20;

interface SecretTable {
  name: string;
  /** Key columns in primary-key order, with a SQL cast for the keyset cursor. */
  keys: Array<{ column: string; cast: string; start: unknown }>;
}
const TABLES: SecretTable[] = [
  {
    name: "user_secrets",
    keys: [
      { column: "user_id", cast: "bigint", start: 0 },
      { column: "kind", cast: "text", start: "" },
    ],
  },
  { name: "shared_secrets", keys: [{ column: "kind", cast: "text", start: "" }] },
];

export interface TableReport {
  table: string;
  scanned: number;
  rewritten: number;
  alreadyCurrent: number;
  /** Rows changed by someone else between our read and our write; left as they now are, a rerun picks them up. */
  changedConcurrently: number;
  failed: number;
  failures: string[];
}

const label = (table: SecretTable, key: unknown[]) => `${table.name}(${key.join(",")})`;

function emptyReport(table: string): TableReport {
  return {
    table,
    scanned: 0,
    rewritten: 0,
    alreadyCurrent: 0,
    changedConcurrently: 0,
    failed: 0,
    failures: [],
  };
}

function fail(report: TableReport, id: string, error: unknown) {
  report.failed++;
  if (report.failures.length < MAX_REPORTED_FAILURES)
    report.failures.push(`${id}: ${(error as Error).message}`);
}

/** Next rows after `cursor` in primary-key order, locked for the transaction. */
async function nextBatch(
  c: pg.PoolClient,
  table: SecretTable,
  cursor: unknown[],
  size: number,
): Promise<Array<{ key: unknown[]; ciphertext: string }>> {
  const cols = table.keys.map((k) => k.column);
  const left = cols.length === 1 ? cols[0] : `(${cols.join(", ")})`;
  const right = table.keys.map((k, i) => `$${i + 1}::${k.cast}`).join(", ");
  const rows = await q<Record<string, unknown>>(
    c,
    `SELECT ${cols.join(", ")}, ciphertext FROM ${table.name}
      WHERE ${left} > ${cols.length === 1 ? right : `(${right})`}
      ORDER BY ${cols.join(", ")} LIMIT $${cols.length + 1} FOR UPDATE`,
    [...cursor, size],
  );
  return rows.map((r) => ({ key: cols.map((col) => r[col]), ciphertext: String(r.ciphertext) }));
}

/** Compare-and-swap: a concurrent putUserSecret/putSharedSecret is never overwritten with stale data. */
async function swap(
  c: pg.PoolClient,
  table: SecretTable,
  key: unknown[],
  oldValue: string,
  newValue: string,
): Promise<boolean> {
  const where = table.keys.map((k, i) => `${k.column} = $${i + 1}`).join(" AND ");
  const rows = await q(
    c,
    `UPDATE ${table.name} SET ciphertext = $${key.length + 1} WHERE ${where} AND ciphertext = $${key.length + 2} RETURNING 1 AS ok`,
    [...key, newValue, oldValue],
  );
  return rows.length === 1;
}

export interface RotateOptions {
  dryRun?: boolean;
  batchSize?: number;
  format?: CiphertextFormat;
}

export async function rotateSecrets(options: RotateOptions = {}): Promise<TableReport[]> {
  const format = options.format ?? writeFormat();
  const size = Math.max(1, Math.floor(options.batchSize ?? 200));
  const { current } = keyRing();
  const reports: TableReport[] = [];
  for (const table of TABLES) {
    const report = emptyReport(table.name);
    reports.push(report);
    let cursor = table.keys.map((k) => k.start);
    for (;;) {
      const last = await withTx(async (c) => {
        const rows = await nextBatch(c, table, cursor, size);
        for (const row of rows) {
          report.scanned++;
          const id = label(table, row.key);
          let found;
          try {
            found = decryptDetailed(row.ciphertext);
          } catch (error) {
            fail(report, id, error);
            continue;
          }
          if (found.kid === current.kid && found.format === format) {
            report.alreadyCurrent++;
            continue;
          }
          if (options.dryRun) {
            report.rewritten++;
            continue;
          }
          const next = encryptSecret(found.plain, format);
          // Never write a value that does not read back as the same plaintext under the current configuration.
          if (decryptDetailed(next).plain !== found.plain)
            throw new Error(`re-encryption check failed for ${id}; nothing was written for it`);
          if (await swap(c, table, row.key, row.ciphertext, next)) report.rewritten++;
          else report.changedConcurrently++;
        }
        return rows.at(-1)?.key;
      });
      if (!last) break;
      cursor = last;
    }
  }
  return reports;
}

export interface VerifyReport {
  tables: Array<{
    table: string;
    byKey: Record<string, number>;
    failed: number;
    failures: string[];
  }>;
  /** Execution workspace checkpoints are not re-encrypted (key-rotation.md 4.4): this says which key they need. */
  checkpoints: { byKey: Record<string, number>; failed: number; failures: string[] };
  currentKid: string;
  format: CiphertextFormat;
}

const bump = (map: Record<string, number>, name: string) => (map[name] = (map[name] ?? 0) + 1);

/** Read-only: how many stored values sit under which key, and which cannot be decrypted at all. */
export async function verifySecrets(): Promise<VerifyReport> {
  const ring = keyRing();
  const tables: VerifyReport["tables"] = [];
  for (const table of TABLES) {
    const entry = {
      table: table.name,
      byKey: {} as Record<string, number>,
      failed: 0,
      failures: [] as string[],
    };
    let cursor = table.keys.map((k) => k.start);
    for (;;) {
      const rows = await withTx(async (c) => nextBatch(c, table, cursor, 500));
      for (const row of rows) {
        try {
          const found = decryptDetailed(row.ciphertext);
          bump(entry.byKey, `${found.format}:${found.kid}`);
        } catch (error) {
          entry.failed++;
          if (entry.failures.length < MAX_REPORTED_FAILURES)
            entry.failures.push(`${label(table, row.key)}: ${(error as Error).message}`);
        }
      }
      const last = rows.at(-1);
      if (!last) break;
      cursor = last.key;
    }
    tables.push(entry);
  }
  const checkpoints = { byKey: {} as Record<string, number>, failed: 0, failures: [] as string[] };
  let after = 0;
  for (;;) {
    const rows = await q<{ id: string; v2: boolean; body: string }>(
      pool,
      `SELECT id, left(content, 3) = 'v2:' AS v2,
              CASE WHEN left(content, 3) = 'v2:' THEN split_part(content, ':', 2) ELSE content END AS body
         FROM workflow_artifacts WHERE kind = $1 AND id > $2 ORDER BY id LIMIT 50`,
      [WORKSPACE_CHECKPOINT_KIND, after],
    );
    if (!rows.length) break;
    for (const row of rows) {
      after = Number(row.id);
      if (row.v2) {
        if (ring.all.some((k) => k.kid === row.body)) bump(checkpoints.byKey, `v2:${row.body}`);
        else {
          checkpoints.failed++;
          if (checkpoints.failures.length < MAX_REPORTED_FAILURES)
            checkpoints.failures.push(
              `workflow_artifacts(${row.id}): key ${row.body} is not configured`,
            );
        }
        continue;
      }
      try {
        const found = decryptDetailed(row.body);
        bump(checkpoints.byKey, `legacy:${found.kid}`);
      } catch (error) {
        checkpoints.failed++;
        if (checkpoints.failures.length < MAX_REPORTED_FAILURES)
          checkpoints.failures.push(`workflow_artifacts(${row.id}): ${(error as Error).message}`);
      }
    }
  }
  return { tables, checkpoints, currentKid: ring.current.kid, format: writeFormat() };
}
