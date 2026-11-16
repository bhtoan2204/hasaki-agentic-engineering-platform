/**
 * `npm run knowledge:import [-- --dry-run] [--only=<key prefix>]` — import repo CLAUDE.md / skills / rules / wiki docs into the registry.
 * `npm run knowledge:import -- --skill-dir=<path/to/skill> --repo=<repository> [--dry-run]` — import one skill directory
 * from a local path (e.g. not merged yet, so absent from the platform-managed checkout), attributed to that repository.
 */
import { resolve } from "node:path";
import { migrate } from "../db/migrate.ts";
import { pool } from "../db/pool.ts";
import { syncRepositoriesFromConfig } from "../repos/service.ts";
import { importFromRepositories, importSkillDirectory } from "../knowledge/importer.ts";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined;
const dryRun = process.argv.includes("--dry-run");
const skillDir = arg("skill-dir");
if (skillDir && !arg("repo")) throw new Error("--skill-dir needs --repo=<repository name>");
await migrate();
await syncRepositoriesFromConfig();
const only = arg("only");
const r = skillDir
  ? await importSkillDirectory({ dir: resolve(skillDir), repo: arg("repo")!, dryRun })
  : await importFromRepositories({ dryRun, only });
for (const c of r.candidates)
  console.log(
    `${c.action.padEnd(9)} ${c.key.padEnd(58)} ${c.category.padEnd(22)} ${c.scope.padEnd(30)} ${String(c.chars).padStart(6)}c  ${c.repos.join(",")}`,
  );
for (const s of r.skipped) console.log(`skipped   ${s.path}  — ${s.reason}`);
console.log(
  `\n${dryRun ? "DRY RUN: " : ""}${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.retired} retired, ${r.skipped.length} skipped/notes`,
);
await pool.end();
