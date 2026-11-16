/** `npm run arch:check` fails on violations missing from architecture/baseline.json; `--write-baseline` rewrites it. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, type Baseline } from "../src/architecture/check.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "architecture", "baseline.json");
const write = process.argv.includes("--write-baseline");

let baseline: Baseline = { violations: [] };
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
} catch {
  if (!write) {
    console.error("architecture/baseline.json is missing; run `npm run arch:baseline`");
    process.exit(2);
  }
}

const result = runCheck(root, baseline);
console.log(`architecture metrics: ${JSON.stringify(result.metrics)}`);

if (write) {
  writeFileSync(baselinePath, `${JSON.stringify({ violations: result.violations.map((v) => v.key) }, null, 2)}\n`);
  console.log(`baseline written with ${result.violations.length} entries`);
  process.exit(0);
}
for (const v of result.newViolations) console.error(`NEW ${v.rule}: ${v.detail}`);
if (result.staleBaseline.length) {
  console.warn(`${result.staleBaseline.length} baseline entries no longer occur; run \`npm run arch:baseline\` to shrink it`);
}
process.exit(result.newViolations.length ? 1 : 0);
