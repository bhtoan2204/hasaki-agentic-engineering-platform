/**
 * Import existing local evaluation reports into PostgreSQL: `npm run eval:import -- --owner USER [--share]
 * [--suite NAME] FILE...`. Autonomy (autonomy-*.json), performance, benchmark (report.json) and bench
 * (bench-results.json) reports are recognized; importing the same file again changes nothing.
 */
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.ts";
import { ownerByUsername, saveReport } from "../eval/reports.ts";

const args = process.argv.slice(2);
const value = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flags = new Set(["--owner", "--suite"]);
const files = args.filter((a, i) => !a.startsWith("--") && !flags.has(args[i - 1]));
let failed = 0;
try {
  const username = value("owner") ?? process.env.EVAL_OWNER;
  if (!username || !files.length)
    throw new Error("usage: eval:import --owner USER [--share] [--suite NAME] FILE...");
  const ownerId = await ownerByUsername(username);
  for (const file of files) {
    try {
      const saved = await saveReport(JSON.parse(readFileSync(file, "utf8")), {
        ownerId,
        visibility: args.includes("--share") ? "team" : "private",
        source: "import",
        suite: value("suite"),
      });
      console.log(
        `${file}: ${saved.created ? `imported as #${saved.id} (${saved.kind}, ${saved.rows} results)` : `already stored as #${saved.id}`}`,
      );
    } catch (e) {
      failed++;
      console.error(`${file}: ${(e as Error).message}`);
    }
  }
} catch (e) {
  console.error((e as Error).message);
  failed++;
} finally {
  await pool.end();
}
process.exit(failed ? 1 : 0);
