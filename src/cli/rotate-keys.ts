/**
 * Re-encrypts stored credentials with the current key. Repeatable; see docs/architecture/key-rotation.md.
 *
 *   npm run auth:rotate-keys -- --dry-run      count what would change, write nothing
 *   npm run auth:rotate-keys                   re-encrypt user_secrets and shared_secrets
 *   npm run auth:rotate-keys -- --verify       rows per key; exit 1 if any value cannot be decrypted
 *
 *   --batch-size N         rows per transaction (default 200)
 *   --format v2|legacy     target format (default: AUTH_CIPHERTEXT_FORMAT, which defaults to legacy)
 */
import { pool } from "../db/pool.ts";
import { keyRing, writeFormat, type CiphertextFormat } from "../auth/crypto.ts";
import { rotateSecrets, verifySecrets } from "../auth/rotation.ts";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

async function main(): Promise<number> {
  const ring = keyRing();
  const rawFormat = arg("--format") ?? writeFormat();
  if (rawFormat !== "v2" && rawFormat !== "legacy")
    throw new Error("--format must be v2 or legacy");
  const format: CiphertextFormat = rawFormat;
  const batchSize = Number(arg("--batch-size") ?? 200);
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("--batch-size must be a positive integer");
  console.log(
    `current key ${ring.current.kid}, ${ring.all.length - 1} previous, target format ${format}`,
  );

  if (flag("--verify")) {
    const report = await verifySecrets();
    let failed = report.checkpoints.failed;
    for (const t of report.tables) {
      console.log(`${t.table}: ${JSON.stringify(t.byKey)} undecryptable=${t.failed}`);
      for (const f of t.failures) console.log(`  ${f}`);
      failed += t.failed;
    }
    console.log(
      `workflow checkpoints (not re-encrypted): ${JSON.stringify(report.checkpoints.byKey)} undecryptable=${report.checkpoints.failed}`,
    );
    for (const f of report.checkpoints.failures) console.log(`  ${f}`);
    return failed ? 1 : 0;
  }

  const dryRun = flag("--dry-run");
  const reports = await rotateSecrets({ dryRun, batchSize, format });
  let failed = 0;
  for (const r of reports) {
    console.log(
      `${r.table}: scanned=${r.scanned} ${dryRun ? "would-rewrite" : "rewritten"}=${r.rewritten} already-current=${r.alreadyCurrent} changed-concurrently=${r.changedConcurrently} failed=${r.failed}`,
    );
    for (const f of r.failures) console.log(`  ${f}`);
    failed += r.failed;
  }
  if (dryRun) console.log("dry run: nothing was written");
  if (failed) console.error(`${failed} value(s) could not be decrypted and were left unchanged`);
  return failed ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
