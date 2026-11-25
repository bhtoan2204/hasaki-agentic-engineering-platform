/**
 * `node scripts/coverage-check.ts [lcov-file]`: per-directory line and branch coverage floors from an lcov report
 * (npm run test:coverage), configured in scripts/coverage-thresholds.json. Node's own thresholds are global only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Counts {
  lines: [hit: number, found: number];
  branches: [hit: number, found: number];
}

/** Sums LH/LF/BRH/BRF over every file whose repo-relative path is under one of `dirs`. */
export function summarize(lcov: string, dirs: string[]): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const dir of dirs) out[dir] = { lines: [0, 0], branches: [0, 0] };
  let current = "";
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) current = line.slice(3).replaceAll("\\", "/");
    const [key, value] = line.split(":");
    const n = Number(value);
    for (const dir of dirs) {
      if (!current.includes(`/${dir}/`) && !current.startsWith(`${dir}/`)) continue;
      if (key === "LH") out[dir].lines[0] += n;
      else if (key === "LF") out[dir].lines[1] += n;
      else if (key === "BRH") out[dir].branches[0] += n;
      else if (key === "BRF") out[dir].branches[1] += n;
    }
  }
  return out;
}

const pct = ([hit, found]: [number, number]) => (found ? (100 * hit) / found : 0);

export function check(
  counts: Record<string, Counts>,
  floors: Record<string, { lines: number; branches: number }>,
) {
  const failures: string[] = [];
  for (const [dir, floor] of Object.entries(floors)) {
    const c = counts[dir];
    if (!c || c.lines[1] === 0) {
      failures.push(`${dir}: no coverage data`);
      continue;
    }
    const lines = pct(c.lines);
    const branches = pct(c.branches);
    if (lines < floor.lines) failures.push(`${dir}: lines ${lines.toFixed(2)}% < ${floor.lines}%`);
    if (branches < floor.branches)
      failures.push(`${dir}: branches ${branches.toFixed(2)}% < ${floor.branches}%`);
  }
  return failures;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const file = process.argv[2] ?? join(root, ".coverage", "lcov.info");
  const config = JSON.parse(
    readFileSync(join(import.meta.dirname, "coverage-thresholds.json"), "utf8"),
  );
  const counts = summarize(readFileSync(file, "utf8"), Object.keys(config.floors));
  for (const [dir, c] of Object.entries(counts))
    console.log(
      `${dir}: lines ${pct(c.lines).toFixed(2)}% branches ${pct(c.branches).toFixed(2)}%`,
    );
  const failures = check(counts, config.floors);
  if (failures.length) {
    console.error(`coverage below the floor:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}
