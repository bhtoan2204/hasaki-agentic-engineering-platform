import { pool } from "../db/pool.ts";
import { backfillSharedResults } from "../sharing/backfill.ts";

/**
 * npm run shared:backfill -- [--apply] [--batch N] [--max-batches N] [--restart] [--json]
 *
 * Publishes existing completed runs as shared results (src/sharing/backfill.ts) for the kinds whose flag is on. Dry-run
 * unless --apply. Safe to run again and to stop at any time: an applied run resumes after the last batch it finished.
 */
const flag = (name: string) => process.argv.includes(`--${name}`);
const value = (name: string) => {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return process.argv[i].includes("=")
    ? process.argv[i].split("=").slice(1).join("=")
    : process.argv[i + 1];
};
const number = (name: string) => {
  const v = value(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a positive integer`);
  return n;
};

try {
  const report = await backfillSharedResults({
    apply: flag("apply"),
    batchSize: number("batch"),
    maxBatches: number("max-batches"),
    restart: flag("restart"),
  });
  if (flag("json")) console.log(JSON.stringify(report, null, 2));
  else if (!report.kinds.length)
    console.log(
      "no shared-result flag is on (SHARED_RESULTS_CODE_ASSESSMENT, SHARED_RESULTS_PROD_ERRORS): nothing to do",
    );
  else {
    console.log(
      `${report.apply ? "applied" : "DRY RUN (nothing written)"}: ${report.scanned} run(s) scanned, ${report.inserted} ${report.apply ? "published" : "would be published"} (${report.kinds.join(", ")})`,
    );
    for (const [reason, n] of Object.entries(report.skipped))
      console.log(`  skipped ${reason}: ${n}`);
    console.log(
      report.done
        ? "done"
        : `stopped after run ${report.cursor}; run again to continue${report.apply ? "" : " (dry-run keeps no cursor)"}`,
    );
  }
} finally {
  await pool.end();
}
