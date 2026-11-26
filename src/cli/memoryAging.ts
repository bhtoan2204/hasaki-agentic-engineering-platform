import { pool } from "../db/pool.ts";
import { runMemoryAging, type AgingAction } from "../knowledge/aging.ts";

/**
 * npm run memory:aging -- [--dry-run] [--owner ID] [--repo NAME] [--batch N] [--budget SECONDS] [--json]
 *
 * One aging pass over task memory (docs/architecture/memory-aging.md), run by hand: every item is examined
 * regardless of when it was last checked. --dry-run prints what each policy would do and why and changes nothing.
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
  const dryRun = flag("dry-run");
  const ownerId = number("owner");
  const repo = value("repo");
  const report = await runMemoryAging({
    dryRun,
    ownerId,
    repo,
    intervalMs: 0,
    batchSize: number("batch") ?? 100_000,
    budgetMs: (number("budget") ?? 600) * 1000,
  });
  if (flag("json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `${dryRun ? "DRY RUN (nothing changed)" : "applied"}: ${report.examined} item(s) examined, ${report.freshnessChecked} freshness check(s), ${report.ms} ms`,
    );
    const byPolicy = new Map<string, AgingAction[]>();
    for (const a of report.actions) byPolicy.set(a.policy, [...(byPolicy.get(a.policy) ?? []), a]);
    for (const [policy, actions] of byPolicy) {
      console.log(`\n${policy} (${actions.length})`);
      for (const a of actions)
        console.log(
          `  ${a.action.padEnd(9)} ${a.key}  owner=${a.ownerId ?? "shared"}${a.repo ? ` repo=${a.repo}` : ""}${dryRun || a.applied ? "" : "  [skipped: changed meanwhile]"}\n             ${a.reason}${a.replacedBy ? ` -> ${a.replacedBy}` : ""}`,
        );
    }
    if (!report.actions.length) console.log("nothing to do");
    if (report.unknownTracked)
      console.log(
        `\n${report.unknownTracked} item(s) newly seen with a reason that cannot recover; archived once it lasts long enough`,
      );
    if (report.stoppedByBudget) console.log("\nstopped by the time budget; run again to continue");
    if (report.contended) console.log("\nanother pass held the claim lock for part of this one");
  }
} finally {
  await pool.end();
}
