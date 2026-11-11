/**
 * `npm run skills:import-external [-- --dry-run] [--only=<name>] [--verify=<dir>]` — load the third-party skills in
 * skills/external (manifest.json) into the knowledge registry as `skill.ext.<name>`. `--verify` compares the manifest's
 * upstream hashes with clones in <dir> (obra-superpowers, trailofbits-skills, anthropics-skills, microsoft-playwright-cli).
 * Exits 1 when a skill is rejected (hash mismatch, security scan) or upstream verification fails.
 */
import { join, resolve } from "node:path";
import { migrate } from "../db/migrate.ts";
import { pool } from "../db/pool.ts";
import {
  applyExternalSkills,
  planExternalSkills,
  verifyUpstream,
} from "../knowledge/externalImport.ts";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined;
const dryRun = process.argv.includes("--dry-run");
const root = resolve(import.meta.dirname, "../../skills/external");
let failed = false;

const verify = arg("verify");
if (verify) {
  const base = resolve(verify);
  const clones = {
    "https://github.com/obra/superpowers": join(base, "obra-superpowers"),
    "https://github.com/trailofbits/skills": join(base, "trailofbits-skills"),
    "https://github.com/anthropics/skills": join(base, "anthropics-skills"),
    "https://github.com/microsoft/playwright-cli": join(base, "microsoft-playwright-cli"),
  };
  for (const r of verifyUpstream(root, clones)) {
    console.log(
      `${r.ok ? "upstream-ok " : "UPSTREAM-BAD"} ${r.key.padEnd(44)} ${r.file.padEnd(30)} ${r.detail}`,
    );
    failed ||= !r.ok;
  }
}

const plan = planExternalSkills(root, arg("only"));
for (const r of plan.rejected)
  console.log(`REJECTED  ${r.key.padEnd(44)} ${r.file.padEnd(30)} ${r.reason}`);
failed ||= plan.rejected.length > 0;
await migrate();
const report = await applyExternalSkills(plan, { dryRun });
for (const r of report.rows)
  console.log(`${r.action.padEnd(9)} ${r.key}${r.note ? `  — ${r.note}` : ""}`);
for (const s of report.superseded) console.log(`supersede ${s.key} → ${s.by}: ${s.action}`);
const n = (a: string) => report.rows.filter((r) => r.action === a).length;
console.log(
  `\n${dryRun ? "DRY RUN: " : ""}${n("create")} created, ${n("update")} updated, ${n("unchanged")} unchanged, ${n("skipped")} skipped, ${plan.rejected.length} rejected`,
);
await pool.end();
process.exit(failed ? 1 : 0);
